const db = require("@saltcorn/data/db");
const Plugin = require("@saltcorn/data/models/plugin");
const { getState } = require("@saltcorn/data/db/state");
const {
  PLUGIN_NAME,
  NPM_NAME,
  AUTH_URL,
  TOKEN_URL,
  REVOKE_URL,
  liveCfg,
  redirectUri,
  scopes,
} = require("./config");

/**
 * Refresh the access token a little before it actually expires, so a request
 * that is already in flight when the clock runs out does not 401.
 */
const EXPIRY_SKEW_MS = 60 * 1000;

/** One in-flight refresh per process. See getAccessToken. */
let refreshing = null;

/**
 * The plugin row backing this plugin, whatever name it was installed under.
 *
 * @returns {Promise<object>} the Plugin model instance
 */
const findPluginRow = async () => {
  for (const name of [NPM_NAME, PLUGIN_NAME]) {
    const p = await Plugin.findOne({ name });
    if (p) return p;
  }
  const all = await Plugin.find({});
  const p = all.find(
    (pl) =>
      (pl.location || "").endsWith(PLUGIN_NAME) ||
      (pl.name || "").endsWith(PLUGIN_NAME),
  );
  if (!p)
    throw new Error(
      "google-ads: cannot find the installed plugin row, so the Google " +
        "token cannot be saved. Is the plugin installed?",
    );
  return p;
};

/**
 * Merge `patch` into the stored plugin configuration and make every worker
 * see it. Mirrors what POST /plugins/configure/:name does after a workflow.
 *
 * @param {object} patch - configuration keys to add or overwrite
 * @returns {Promise<object>} the configuration as saved
 */
const savePluginCfg = async (patch) => {
  const plugin = await findPluginRow();
  plugin.configuration = { ...(plugin.configuration || {}), ...patch };
  await plugin.upsert();
  await Plugin.loadPlugin(plugin);
  getState().processSend({
    refresh_plugin_cfg: plugin.name,
    tenant: db.getTenantSchema(),
  });
  return plugin.configuration;
};

/**
 * Indirection over savePluginCfg so tests can capture what would be written
 * without a database behind them, in the same spirit as the connection module
 * in mssql-tables.
 */
const store = { save: savePluginCfg };

/**
 * Where the browser is sent to start the consent flow.
 *
 * `access_type=offline` plus `prompt=consent` is what makes Google return a
 * refresh token. Without both, a second authorisation of an already-consented
 * client returns an access token only, and the connection silently stops
 * working an hour later.
 *
 * @param {object} cfg - plugin configuration
 * @param {string} state - opaque CSRF value, checked on the way back
 * @returns {string} the URL to redirect to
 */
const authorizeUrl = (cfg, state) => {
  if (!cfg.client_id)
    throw new Error(
      "google-ads: no OAuth client ID configured. Create an OAuth " +
        "client in the Google Cloud console and paste its ID and secret into " +
        "the plugin configuration.",
    );
  const params = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: redirectUri(cfg),
    response_type: "code",
    scope: scopes(cfg).join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
};

/**
 * POST to Google's token endpoint and normalise the reply.
 *
 * @param {object} body - form fields for the grant
 * @returns {Promise<object>} { access_token, refresh_token?, expires_at, scope }
 */
const postToken = async (body) => {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `google-ads: Google's token endpoint returned ${res.status} and ` +
        `a body that is not JSON: ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok) {
    const detail = json.error_description || json.error || text.slice(0, 200);
    const e = new Error(
      `google-ads: token request failed (${res.status}): ${detail}`,
    );
    // callers branch on these rather than matching on the message text
    e.oauthError = json.error;
    e.oauthDetail = detail;
    e.status = res.status;
    throw e;
  }
  return {
    access_token: json.access_token,
    // A refresh grant does not return a new refresh token; keep the old one.
    refresh_token: json.refresh_token,
    scope: json.scope,
    token_type: json.token_type,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
  };
};

/**
 * Trade the authorisation code from the callback for a token pair and store it.
 *
 * @param {object} cfg - plugin configuration
 * @param {string} code - the `code` query parameter Google sent back
 * @returns {Promise<object>} the stored token object
 */
const exchangeCode = async (cfg, code) => {
  const tokens = await postToken({
    code,
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    redirect_uri: redirectUri(cfg),
    grant_type: "authorization_code",
  });
  if (!tokens.refresh_token)
    throw new Error(
      "google-ads: Google did not return a refresh token. Remove this " +
        "app at myaccount.google.com/permissions and connect again.",
    );
  await store.save({
    oauth: tokens,
    connected_at: new Date().toISOString(),
    // a fresh consent clears whatever the previous connection died of
    oauth_error: null,
    // The consent may be for a different Google login, which can reach an
    // entirely different set of Ads accounts.
    accessible_customers: null,
  });
  return tokens;
};

/**
 * Exchange the stored refresh token for a fresh access token and persist it.
 *
 * @param {object} cfg - plugin configuration holding `oauth.refresh_token`
 * @returns {Promise<object>} the refreshed token object
 */
const refreshTokens = async (cfg) => {
  const stored = cfg.oauth || {};
  if (!stored.refresh_token)
    throw new Error(
      "google-ads: not connected to Google. Open the plugin " +
        "configuration and use Connect Google account.",
    );
  let fresh;
  try {
    fresh = await postToken({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: stored.refresh_token,
      grant_type: "refresh_token",
    });
  } catch (e) {
    if (e.oauthError !== "invalid_grant") throw e;

    // invalid_grant on a refresh means the token is gone for good, not that
    // the request was malformed. Google says nothing about why, so name the
    // two causes that actually account for it.
    const message =
      "google-ads: Google has rejected the stored refresh token " +
      `(invalid_grant${e.oauthDetail ? `: ${e.oauthDetail}` : ""}). The ` +
      "connection must be re-authorised: open the plugin configuration and " +
      "use Connect Google account. If this recurs about every 7 days, the " +
      "OAuth app is still in Testing with an external user type, which " +
      "expires refresh tokens after a week - publish the app, or switch to " +
      "an Internal user type. Otherwise the access was revoked at " +
      "myaccount.google.com/permissions.";

    // Recorded so the configuration page can say the connection is dead
    // instead of showing it as connected. Never at the cost of the real error.
    try {
      await store.save({
        oauth_error: {
          at: new Date().toISOString(),
          code: "invalid_grant",
          message,
        },
      });
    } catch (saveErr) {}

    const err = new Error(message);
    err.oauthError = "invalid_grant";
    throw err;
  }
  // A refresh grant returns neither a refresh token nor, usually, a scope.
  // Spreading `fresh` over `stored` would blank both.
  const merged = {
    ...stored,
    ...fresh,
    refresh_token: stored.refresh_token,
    scope: fresh.scope || stored.scope,
  };
  // clear a recorded failure if this one worked after all
  await store.save({
    oauth: merged,
    ...(cfg.oauth_error ? { oauth_error: null } : {}),
  });
  return merged;
};

/**
 * A usable access token, refreshing first if the stored one is spent.
 *
 * Concurrent callers share one refresh: without this, a page rendering six
 * views against the same account fires six refresh grants at once, and
 * Google invalidates all but the last.
 *
 * @param {object} [cfg0] - configuration override, for tests
 * @param {boolean} [force] - refresh even if the stored token looks valid
 * @returns {Promise<string>} a bearer token
 */
const getAccessToken = async (cfg0, force = false) => {
  const cfg = cfg0 || liveCfg();
  const stored = cfg.oauth || {};
  if (
    !force &&
    stored.access_token &&
    stored.expires_at &&
    stored.expires_at - EXPIRY_SKEW_MS > Date.now()
  )
    return stored.access_token;

  if (!refreshing)
    refreshing = refreshTokens(cfg).finally(() => {
      refreshing = null;
    });
  const fresh = await refreshing;
  return fresh.access_token;
};

/** True when there is a refresh token to work with. */
const isConnected = (cfg) => !!(cfg && cfg.oauth && cfg.oauth.refresh_token);

/**
 * Revoke the tokens at Google and drop them from the configuration.
 *
 * @param {object} cfg - plugin configuration
 * @returns {Promise<void>}
 */
const disconnect = async (cfg) => {
  const token = (cfg.oauth || {}).refresh_token;
  if (token)
    try {
      await fetch(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
    } catch (e) {
      // Already revoked, or Google is unreachable. Drop it locally regardless:
      // leaving a dead token in the config only blocks reconnecting.
    }
  await store.save({
    oauth: null,
    connected_at: null,
    oauth_error: null,
    accessible_customers: null,
  });
};

module.exports = {
  authorizeUrl,
  exchangeCode,
  refreshTokens,
  getAccessToken,
  isConnected,
  disconnect,
  savePluginCfg,
  store,
  postToken,
};
