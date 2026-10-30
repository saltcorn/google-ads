const {
  API_HOST,
  liveCfg,
  versioned,
  customerId,
  headers,
  digits,
} = require("./config");
const oauth = require("./oauth");

/** Status codes worth trying again. 403 is handled separately - see below. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

/**
 * Per-minute quota exhaustion. Ads reports it as a RESOURCE_EXHAUSTED status
 * rather than the `errors[].reason` the older Google APIs use. A plain 403
 * means the access level does not cover the account, which retrying will
 * never fix.
 */
const isRateLimit403 = (body) => {
  const errs = (body && body.error && body.error.errors) || [];
  if (
    errs.some((e) =>
      ["rateLimitExceeded", "userRateLimitExceeded"].includes(e.reason),
    )
  )
    return true;
  return (body && body.error && body.error.status) === "RESOURCE_EXHAUSTED";
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter, honouring Retry-After when Google sets it. */
const backoffMs = (attempt, res) => {
  const header = res && res.headers && res.headers.get("retry-after");
  if (header) {
    const secs = parseInt(header, 10);
    if (!isNaN(secs)) return secs * 1000;
  }
  return Math.min(2 ** attempt * 500, 8000) + Math.floor(Math.random() * 250);
};

/**
 * Google Ads reports failures as `error.details[].errors[]` rather than the
 * `error.errors[]` the other Google APIs use, so the kit's generic reading
 * misses the part that says which field was wrong.
 *
 * @param {object} body - the parsed error body
 * @returns {string[]} the individual failure messages
 */
const adsErrors = (body) => {
  const details = (body && body.error && body.error.details) || [];
  const out = [];
  for (const d of details)
    for (const e of d.errors || []) {
      const where = (e.location && e.location.fieldPathElements) || [];
      const path = where.map((p) => p.fieldName).filter(Boolean).join(".");
      const code = Object.values(e.errorCode || {})[0];
      out.push(
        [e.message, path && `at ${path}`, code && `(${code})`]
          .filter(Boolean)
          .join(" "),
      );
    }
  return out;
};

/** The customer ID out of a request path, which always carries it. */
const pathCustomer = (path) => {
  const m = /\/customers\/(\d+)/.exec(String(path || ""));
  return m ? m[1] : "this one";
};

/** Turn a Google Ads error body into a message that says what to fix. */
const describeError = (status, body, path) => {
  const err = (body && body.error) || {};
  const reason = (err.errors && err.errors[0] && err.errors[0].reason) || "";
  const top = err.message || `HTTP ${status}`;
  const subs = (err.errors || [])
    .map((e) => e.message || e.reason)
    .filter((m) => m && !top.includes(m));
  const detail = subs.length ? `${top}: ${subs.join("; ")}` : top;
  const own = adsErrors(body);
  const full = own.length ? `${detail}: ${own.join("; ")}` : detail;
  const text = `${full} ${JSON.stringify(body && body.error ? body.error : {})}`;

  if (
    /DEVELOPER_TOKEN_(NOT_APPROVED|PROHIBITED)|CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION|developer token/i.test(
      text,
    )
  )
    return (
      `${full} (${path}). The Cloud project's Google Ads API access level does ` +
      `not cover this account. Test access reaches test accounts only; ` +
      `Explorer reaches production accounts but caps them at 2,880 ` +
      `operations a day. Raise the access level in the Google Cloud console.`
    );
  // These three arrive together in the docs but have nothing to do with each
  // other: one is the account's own state, one is the manager hop, one is the
  // Google identity. Sending all three to the manager-ID setting sent two of
  // them to a field that cannot fix them.
  if (/CUSTOMER_NOT_ENABLED|INCOMPLETE_SIGNUP/i.test(text))
    return (
      `${full} (${path}). Account ${pathCustomer(path)} exists and the ` +
      `connection can see it, but Google Ads has not enabled it: either its ` +
      `signup was never finished - a new account stays unusable until the ` +
      `first campaign and billing are set up - or it has been cancelled. ` +
      `Open it in the Google Ads UI and check that its status is Active. ` +
      `If instead this is an API test account, it is reached through its ` +
      `test manager: set "Manager account ID" to that manager's customer ID.`
    );
  if (/USER_PERMISSION_DENIED/i.test(text))
    return (
      `${full} (${path}). The connected Google account does not have direct ` +
      `access to account ${pathCustomer(path)}. If it reaches that account ` +
      `through a manager, set "Manager account ID" in the plugin ` +
      `configuration to that manager's customer ID.`
    );
  if (/NOT_ADS_USER/i.test(text))
    return (
      `${full} (${path}). The connected Google account has no Google Ads ` +
      `account at all. Reconnect on the plugin configuration page as the ` +
      `Google account that signs in to Google Ads.`
    );
  if (/MISSING_TOS/i.test(text))
    return (
      `${full} (${path}). Account ${pathCustomer(path)} has not accepted the ` +
      `Google Ads terms of service. Sign in to it once in the Google Ads UI ` +
      `and accept them.`
    );
  // Not a query error, though it arrives as one: the query is fine and the
  // account is wrong. Sending it to the GAQL advice below would be useless.
  if (/REQUESTED_METRICS_FOR_MANAGER/i.test(text))
    return (
      `${full} (${path}). Account ${pathCustomer(path)} is a manager ` +
      `account. A manager holds no campaigns of its own and reports no ` +
      `metrics. Set "Customer ID" to an account held under it, and put ` +
      `this ID in "Manager account ID" instead.`
    );
  if (/QUERY_ERROR|BAD_RESOURCE|UNRECOGNIZED_FIELD|unrecognized field/i.test(text))
    return (
      `${full} (${path}). The GAQL query was rejected. Field names are ` +
      `snake_case and dotted, such as campaign.id or metrics.cost_micros, ` +
      `and GAQL has no OR and no parentheses in WHERE.`
    );
  if (/RESOURCE_EXHAUSTED|RATE_EXCEEDED/i.test(text))
    return (
      `${full} (${path}). The account's daily operation limit is spent. ` +
      `Explorer access allows 2,880 production operations a day; schedule a ` +
      `sync into a local table instead of reading this provider live.`
    );
  if (status === 404 && /\/v\d+\//.test(path))
    return (
      `${full} (${path}). If this names the API version, that version has ` +
      `been sunset - set a current one in the plugin configuration.`
    );
  if (status === 403 && reason === "insufficientPermissions")
    return (
      `${full} The Google connection does not grant this. Reconnect the ` +
      `Google account from the plugin configuration.`
    );
  if (status === 403 && /has not been used|is disabled/i.test(detail))
    return (
      `${full} Enable the Google Ads API for the Google Cloud project that ` +
      `owns the OAuth client.`
    );
  if (status === 403) return `${full} (${reason || "forbidden"}) calling ${path}`;
  if (status === 404)
    return (
      `${full} (${path}). It no longer exists, or the connected Google ` +
      `account cannot see it.`
    );
  return `${full} (HTTP ${status}) calling ${path}`;
};

/**
 * One authenticated Google Ads API call, with token refresh and retries.
 *
 * @param {string} path - path below the host, carrying the API version
 * @param {object} [opts]
 * @param {string} [opts.method] - HTTP method, default GET
 * @param {object} [opts.query] - query parameters; undefined values are dropped
 * @param {object} [opts.body] - JSON request body
 * @param {object} [opts.cfg] - plugin configuration override, for tests
 * @param {Function} [opts.fetchImpl] - fetch override, for tests
 * @returns {Promise<object>} the parsed response, or {} for 204
 */
const apiFetch = async (path, opts = {}) => {
  const {
    method = "GET",
    query = {},
    body,
    cfg = liveCfg(),
    fetchImpl = fetch,
  } = opts;

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== null && v !== "") params.append(k, String(v));
  const qs = params.toString();
  const url = `${API_HOST}${path}${qs ? `?${qs}` : ""}`;

  let forceRefresh = false;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const token = await oauth.getAccessToken(cfg, forceRefresh);
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...headers(cfg),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 204) return {};
    const text = await res.text();
    let json = {};
    if (text)
      try {
        json = JSON.parse(text);
      } catch (e) {
        json = {};
      }

    if (res.ok) return json;

    // A token that the stored expiry said was still good. Refresh and retry
    // once; if it fails again the credentials are genuinely bad.
    if (res.status === 401 && !forceRefresh) {
      forceRefresh = true;
      continue;
    }

    const retryable = RETRY_STATUS.has(res.status) || isRateLimit403(json);
    lastErr = new Error(describeError(res.status, json, path));
    // callers branch on these rather than matching on the message text
    lastErr.status = res.status;
    lastErr.body = json;
    if (!retryable || attempt === MAX_ATTEMPTS - 1) throw lastErr;
    await sleep(backoffMs(attempt, res));
  }
  throw lastErr;
};

/** The page guard: 10,000 rows a page, so this is ten million rows. */
const MAX_PAGES = 20;

/**
 * Run a GAQL query, walking pages.
 *
 * `search` takes no page size - it is fixed at 10,000 and sending `pageSize`
 * is an error - so the only lever on how much is fetched is the query's own
 * LIMIT, which is why the provider pushes one down wherever it can.
 *
 * @param {string} query - the GAQL query
 * @param {object} [opts] - { cfg, fetchImpl, maxPages, onPage }
 * @returns {Promise<object[]>} the raw result objects, nested as Google sends them
 */
const search = async (query, opts = {}) => {
  const cfg = opts.cfg || liveCfg();
  const path = versioned(cfg, `/customers/${customerId(cfg)}/googleAds:search`);
  const maxPages = opts.maxPages || MAX_PAGES;
  const out = [];
  let pageToken;
  let pages = 0;
  do {
    const res = await apiFetch(path, {
      ...opts,
      cfg,
      method: "POST",
      body: { query, ...(pageToken ? { pageToken } : {}) },
    });
    pages += 1;
    const results = res.results || [];
    out.push(...results);
    if (opts.onPage && opts.onPage(results, res, out) === false) return out;
    pageToken = res.nextPageToken;
  } while (pageToken && pages < maxPages);
  return out;
};

/**
 * The configured account's own time zone, as an IANA name.
 *
 * Every date in a report - segments.date, and the window the provider counts
 * back from - is a calendar date in this zone, not in the server's. It is set
 * when the Google Ads account is created and cannot be changed afterwards.
 *
 * @param {object} [opts] - { cfg, fetchImpl }
 * @returns {Promise<string|null>} e.g. "Africa/Kigali", or null if absent
 */
const fetchAccount = async (opts = {}) => {
  const rows = await search(
    "SELECT customer.id, customer.descriptive_name, customer.time_zone, " +
      "customer.manager, customer.test_account FROM customer LIMIT 1",
    { ...opts, maxPages: 1 },
  );
  const c = rows[0] && rows[0].customer;
  if (!c) return null;
  return {
    id: c.id || null,
    name: c.descriptiveName || null,
    timeZone: c.timeZone || null,
    manager: !!c.manager,
    testAccount: !!c.testAccount,
  };
};

/**
 * The Ads accounts the connected Google login can reach directly.
 *
 * Accounts under a manager are not listed here - only the manager is - which
 * is why the configuration page lets the ID be typed as well as picked.
 *
 * @param {object} [cfg] - configuration override, for tests
 * @param {object} [opts] - { fetchImpl }
 * @returns {Promise<string[]>} ten-digit customer IDs
 */
const listAccessibleCustomers = async (cfg0, opts = {}) => {
  const cfg = cfg0 || liveCfg();
  const res = await apiFetch(versioned(cfg, "/customers:listAccessibleCustomers"), {
    ...opts,
    cfg,
  });
  return (res.resourceNames || []).map((n) => digits(n.split("/").pop()));
};

/**
 * Apply mutate operations to one resource collection.
 *
 * @param {string} collection - the REST collection, e.g. "campaigns"
 * @param {object[]} operations - mutate operations
 * @param {object} [opts] - { cfg, fetchImpl, validateOnly, partialFailure }
 * @returns {Promise<object>} the mutate response
 */
const mutate = async (collection, operations, opts = {}) => {
  const cfg = opts.cfg || liveCfg();
  return await apiFetch(
    versioned(cfg, `/customers/${customerId(cfg)}/${collection}:mutate`),
    {
      ...opts,
      cfg,
      method: "POST",
      body: {
        operations,
        ...(opts.validateOnly ? { validateOnly: true } : {}),
        ...(opts.partialFailure ? { partialFailure: true } : {}),
      },
    },
  );
};

/**
 * Look up field metadata, so a hand-written query's columns can be typed.
 *
 * @param {string[]} names - GAQL field names, e.g. ["campaign.id"]
 * @param {object} [opts] - { cfg, fetchImpl }
 * @returns {Promise<object[]>} GoogleAdsField rows
 */
const describeFields = async (names, opts = {}) => {
  if (!names.length) return [];
  const cfg = opts.cfg || liveCfg();
  const list = names.map((n) => `'${n.replace(/'/g, "")}'`).join(", ");
  const res = await apiFetch(versioned(cfg, "/googleAdsFields:search"), {
    ...opts,
    cfg,
    method: "POST",
    body: {
      query:
        "SELECT name, data_type, selectable, filterable, sortable, " +
        `is_repeated WHERE name IN (${list})`,
    },
  });
  return res.results || [];
};

module.exports = {
  apiFetch,
  search,
  listAccessibleCustomers,
  fetchAccount,
  mutate,
  describeFields,
  describeError,
  adsErrors,
  isRateLimit403,
  MAX_PAGES,
};
