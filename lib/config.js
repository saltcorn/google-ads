const { getState } = require("@saltcorn/data/db/state");

const PLUGIN_NAME = "google-ads";
const NPM_NAME = "@saltcorn/google-ads";

/** The one place the callback path is spelled. Routes and the setup
 *  instructions both derive from it, so they cannot drift apart. */
const CALLBACK_PATH = "/google-ads/oauth2/callback";

/** Google's OAuth2 endpoints. */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Google Ads has one scope; there is no read-only variant. */
const SCOPE = "https://www.googleapis.com/auth/adwords";

const API_HOST = "https://googleads.googleapis.com";

/**
 * The API version this plugin talks by default.
 *
 * Google ships a major version roughly quarterly and sunsets each about a year
 * after release, so this is the one constant here that genuinely expires. It
 * is settable on the configuration page precisely so a sunset does not need a
 * new release of the plugin.
 */
const DEFAULT_API_VERSION = "v26";

/**
 * The plugin configuration as it stands *now*.
 *
 * `table_providers` and `actions` are evaluated once, when the plugin is
 * registered, so anything closing over that `cfg` holds a snapshot taken at
 * load time. The access token is refreshed and rewritten behind that
 * snapshot's back, so every call needing credentials reads through here
 * instead of trusting what it captured.
 *
 * @param {object} [fallback] - used when there is no state (unit tests)
 * @returns {object} the live plugin configuration
 */
const liveCfg = (fallback = {}) => {
  const state = getState();
  if (!state || !state.plugin_cfgs) return fallback;
  const cfgs = state.plugin_cfgs;
  if (cfgs[NPM_NAME]) return cfgs[NPM_NAME];
  if (cfgs[PLUGIN_NAME]) return cfgs[PLUGIN_NAME];
  // installed from a local directory or a fork, under some other key
  const key = Object.keys(cfgs).find((k) => k.endsWith(PLUGIN_NAME));
  return key ? cfgs[key] : fallback;
};

const apiVersion = (cfg) =>
  String((cfg && cfg.api_version) || DEFAULT_API_VERSION).trim();

/**
 * A path below the API host, carrying the configured version.
 *
 * The version is part of the path rather than the client's base URL so that
 * changing it on the configuration page takes effect without reloading the
 * plugin.
 *
 * @param {object} cfg - plugin configuration
 * @param {string} rest - the path below the version, starting with "/"
 * @returns {string} e.g. "/v26/customers/1234567890/googleAds:search"
 */
const versioned = (cfg, rest) => `/${apiVersion(cfg)}${rest}`;

/** Customer IDs are written 123-456-7890 but sent as ten bare digits. */
const digits = (v) => String(v ?? "").replace(/\D/g, "");

/**
 * The customer ID every query is scoped to.
 *
 * @param {object} cfg - plugin configuration
 * @returns {string} ten digits
 */
const customerId = (cfg) => {
  const id = digits(cfg && cfg.customer_id);
  if (!id)
    throw new Error(
      "google-ads: no Google Ads account selected. Open the plugin " +
        "configuration and choose one on the Account step.",
    );
  return id;
};

/**
 * Headers beyond the bearer token.
 *
 * `developer-token` is sent only when one is configured. Google's access-levels
 * page says developer tokens were sunset on 9 September 2026 and that access
 * now belongs to the Cloud project, while the call-structure page still lists
 * the header as required and the official REST examples omit it. Sending it
 * when present and omitting it when not is correct under either reading.
 *
 * `login-customer-id` is required when the account is reached through a
 * manager account, and must be the manager's ID.
 */
const headers = (cfg) => {
  const h = {};
  const dev = (cfg && cfg.developer_token) || "";
  if (dev) h["developer-token"] = dev.trim();
  const login = digits(cfg && cfg.login_customer_id);
  if (login) h["login-customer-id"] = login;
  return h;
};

module.exports = {
  PLUGIN_NAME,
  NPM_NAME,
  CALLBACK_PATH,
  AUTH_URL,
  TOKEN_URL,
  REVOKE_URL,
  SCOPE,
  API_HOST,
  DEFAULT_API_VERSION,
  liveCfg,
  apiVersion,
  versioned,
  digits,
  customerId,
  headers,
  redirectUri: (cfg) => {
    const base = (cfg.base_url || "").replace(/\/+$/, "");
    if (!base)
      throw new Error(
        "google-ads: no base URL configured. Set it on the plugin " +
          "configuration page so Google knows where to send the browser " +
          "back to.",
      );
    return `${base}${CALLBACK_PATH}`;
  },
  scopes: () => [SCOPE],
};
