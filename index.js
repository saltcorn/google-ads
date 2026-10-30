const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const { getState } = require("@saltcorn/data/db/state");
const {
  a,
  div,
  p,
  code,
  form,
  button,
  ol,
  li,
  span,
  strong,
} = require("@saltcorn/markup/tags");

const provider = require("./lib/provider");
const actions = require("./lib/actions");
const routes = require("./lib/routes");
const oauth = require("./lib/oauth");
const { CALLBACK_PATH, digits, DEFAULT_API_VERSION } = require("./lib/config");
// Namespace, not destructured, so a test can substitute fetchAccount.
const api = require("./lib/api");

/** Saltcorn's own base URL, so the redirect URI does not have to be retyped. */
const defaultBaseUrl = () => {
  try {
    return getState().getConfig("base_url", "") || "";
  } catch (e) {
    return "";
  }
};

const CONSOLE_URL =
  "https://console.cloud.google.com/apis/library/googleads.googleapis.com";
const ACCESS_LEVELS_URL =
  "https://developers.google.com/google-ads/api/docs/access-levels";
const VERSIONING_URL =
  "https://developers.google.com/google-ads/api/docs/concepts/versioning";
const PLACEHOLDER_HOST = "https://your-saltcorn-host";
const ADS_UI_URL = "https://ads.google.com";

/**
 * Whether the redirect URI on screen is the real one.
 *
 * Without a base URL the shown URI carries PLACEHOLDER_HOST, and calling that
 * "exact" tells people to register a value that cannot work.
 */
const haveBaseUrl = (context) => !!(context.base_url || defaultBaseUrl());

/** The redirect URI for a base URL, or a placeholder showing its shape. */
const uriFor = (baseUrl) => {
  const base = (baseUrl || "").replace(/\/+$/, "");
  return `${base || PLACEHOLDER_HOST}${CALLBACK_PATH}`;
};

/**
 * Keep the shown redirect URI in step with the base URL field as it is typed.
 *
 * Without this the URI only appears once the base URL has been saved, which
 * means leaving the step and coming back. Most people don't, and meet
 * `Error 400: redirect_uri_mismatch` instead.
 *
 * Written without a regex literal: this is a template literal, so a `\/`
 * inside it would be unescaped to `/` before the browser ever saw it.
 */
const liveUriScript = () =>
  `<script>
(function () {
  var inp = document.getElementById("inputbase_url");
  var out = document.getElementById("gads-redirect-uri");
  var exact = document.getElementById("gads-uri-exact");
  var provisional = document.getElementById("gads-uri-provisional");
  if (!inp || !out) return;
  function update() {
    var b = inp.value || "";
    while (b.charAt(b.length - 1) === "/") b = b.slice(0, -1);
    out.textContent = (b || "${PLACEHOLDER_HOST}") + "${CALLBACK_PATH}";
    if (!exact || !provisional) return;
    exact.classList.toggle("d-none", !b);
    provisional.classList.toggle("d-none", !!b);
  }
  inp.addEventListener("input", update);
  update();
})();
</script>`;

/**
 * The Google Cloud side of the setup. Shown in full on the first step, so
 * nothing here depends on having saved anything yet.
 *
 * Returned as an array: Form renders an array blurb verbatim, where a single
 * string is wrapped in a <p>.
 */
const setupBlurb = (context) => [
  div(
    { class: "mb-3" },
    p(
      "In the ",
      a({ href: CONSOLE_URL, target: "_blank" }, "Google Cloud console"),
      ":",
    ),
    ol(
      li(
        "Enable the ",
        strong("Google Ads API"),
        " for your project. Nothing below works until this is on.",
      ),
      li(
        "Under ",
        strong("APIs & Services → Credentials"),
        ", create an ",
        strong("OAuth 2.0 Client ID"),
        " of type ",
        strong("Web application"),
        ".",
      ),
      li(
        "Add this URI under ",
        strong("Authorised redirect URIs"),
        ":",
        div(
          { class: "my-2" },
          code(
            { id: "gads-redirect-uri", class: "user-select-all" },
            uriFor(context.base_url || defaultBaseUrl()),
          ),
        ),
        span(
          {
            id: "gads-uri-exact",
            class: `text-muted${haveBaseUrl(context) ? "" : " d-none"}`,
          },
          "Register it exactly as shown - character for character, including " +
            "scheme and port.",
        ),
        span(
          {
            id: "gads-uri-provisional",
            class: `text-muted${haveBaseUrl(context) ? " d-none" : ""}`,
          },
          "The host shown is a placeholder. Fill in the base URL below and " +
            "this becomes the exact URI to register.",
        ),
      ),
      li(
        "Check the project's ",
        a({ href: ACCESS_LEVELS_URL, target: "_blank" }, "API access level"),
        ". Enabling the API grants ",
        strong("Test"),
        " access, which reaches test accounts only - a production account " +
          "needs ",
        strong("Explorer"),
        " or above.",
      ),
      li("Paste the client ID and secret below."),
    ),
  ),
  liveUriScript(),
];

/** Shown on the Connect step, where the base URL is already saved. */
const connectBlurb = (context) => {
  const connected = oauth.isConnected(context);
  const uri = uriFor(context.base_url || defaultBaseUrl());
  // A stored refresh token Google has rejected still looks like a connection.
  // Saying "Connected" over the top of that is the least useful thing the page
  // could do, so the failure is reported instead.
  const failure = context.oauth_error;

  return [
    div(
      { class: "mb-3" },
      failure
        ? div(
            { class: "alert alert-warning" },
            p(
              { class: "mb-1" },
              strong("The Google connection is no longer valid."),
              failure.at
                ? ` Rejected on ${new Date(failure.at).toLocaleString()}.`
                : "",
            ),
            p({ class: "mb-0" }, failure.message || ""),
          )
        : "",
      p(
        failure
          ? "Reconnect to carry on."
          : connected
            ? `Connected${
                context.connected_at
                  ? ` since ${new Date(context.connected_at).toLocaleString()}`
                  : ""
              }.`
            : "Not connected yet.",
      ),
      p(
        { class: "text-muted mb-1" },
        haveBaseUrl(context)
          ? "The redirect URI registered with Google must be exactly:"
          : "No base URL is set, so this is not the URI to register - the " +
              "host is a placeholder. Set the base URL on the previous step:",
      ),
      p(code({ class: "user-select-all" }, uri)),
      p(
        { class: "text-muted" },
        "If Google reports ",
        code("access_denied"),
        " and mentions approved testers, add your Google account under ",
        strong("Audience → Test users"),
        ". Note that a Testing-status app with an external user type gets a " +
          "refresh token that expires after 7 days; publish the app, or use " +
          "an Internal user type, to avoid reconnecting weekly.",
      ),
      p(
        { class: "text-muted" },
        "Connecting asks for the ",
        code("adwords"),
        " scope, which is read and write. Google Ads has no read-only " +
          "variant, so the tables are exposed read-only by this plugin " +
          "rather than by the grant: only the actions write, and each can be " +
          "run as a dry run.",
      ),
      a(
        {
          href: "/google-ads/oauth2/authorize",
          class: `btn btn-${connected ? "outline-primary" : "primary"}`,
        },
        connected ? "Reconnect Google account" : "Connect Google account",
      ),
      connected
        ? form(
            {
              action: "/google-ads/oauth2/disconnect",
              method: "post",
              class: "d-inline ms-2",
            },
            // Saltcorn rejects a POST without this, and a blurb is rendered
            // without the `req` that req.csrfToken() needs - so it is filled
            // in from the token the page wrapper puts on every page.
            `<input type="hidden" name="_csrf" id="gads-csrf" value="">`,
            button(
              { type: "submit", class: "btn btn-outline-danger" },
              "Disconnect",
            ),
          ) +
          `<script>
(function () {
  var t = document.getElementById("gads-csrf");
  if (t && typeof _sc_globalCsrf !== "undefined") t.value = _sc_globalCsrf;
})();
</script>`
        : "",
    ),
  ];
};

/** A connected account's reachable customer IDs, hyphenated for reading. */
const hyphenate = (id) => {
  const d = digits(id);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
};

/**
 * The Account step's picker options.
 *
 * The list is cached at connect time, because this form is rendered on every
 * visit to the configuration page and listing accounts costs an API call that
 * fails in its own interesting ways. A refresh is a reconnect.
 */
const accountOptions = (context) => {
  const cached = context.accessible_customers;
  return Array.isArray(cached) ? cached.map(hyphenate) : [];
};

/**
 * The accounts this connection reaches, as buttons that fill the ID field.
 *
 * Deliberately not the field's `attributes.options`: a String field carrying
 * options renders a <select>, and listAccessibleCustomers returns only
 * directly owned accounts - never one held under a manager, which is the
 * account most setups actually query. As a dropdown it made the common case
 * unreachable while the blurb beside it told people to type an ID they had
 * no box to type into.
 */
const accountPicker = (options) =>
  options.length
    ? div(
        { class: "mb-3" },
        div({ class: "text-muted mb-1" }, "This connection reaches directly:"),
        ...options.map((o) =>
          div(
            { class: "mb-1" },
            code({ class: "me-2" }, o),
            // Two buttons, not one: what a connection reaches directly is
            // very often the manager, which belongs in the other field. A
            // picker that could only fill Customer ID put it in the wrong
            // box for exactly the setup this plugin is usually used for.
            ...["customer_id", "login_customer_id"].map((target) =>
              button(
                {
                  type: "button",
                  class: "btn btn-sm btn-outline-secondary me-1 gads-fill",
                  "data-cid": o,
                  "data-target": target,
                },
                target === "customer_id"
                  ? "use as Customer ID"
                  : "use as Manager ID",
              ),
            ),
          ),
        ),
        `<script>
(function () {
  document.querySelectorAll("button.gads-fill").forEach(function (b) {
    b.addEventListener("click", function () {
      var inp = document.getElementById("input" + b.getAttribute("data-target"));
      if (!inp) return;
      inp.value = b.getAttribute("data-cid");
      inp.focus();
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
})();
</script>`,
      )
    : "";

/**
 * Where the two IDs are actually shown.
 *
 * Both are ten digits in the same 123-456-7890 shape, so "ten digits" alone
 * tells nobody which is which, and a manager's ID in the Customer ID box
 * yields tables that are empty rather than broken - no error to go on.
 */
const idHelp = () =>
  div(
    { class: "card bg-light mb-3" },
    div(
      { class: "card-body py-2 px-3" },
      p(
        { class: "mb-1" },
        strong("Where to find these"),
        " in ",
        a({ href: ADS_UI_URL, target: "_blank" }, "Google Ads"),
        ":",
      ),
      ol(
        { class: "mb-0 ps-3 text-muted" },
        li(
          strong("Manager account ID"),
          " - open the manager account and read the ten digits at the top " +
            "right, beside its name. On its Accounts page the Direct " +
            "manager column shows the same number against every account it " +
            "holds. Leave this empty when there is no manager: setting one " +
            "that does not manage the account gives USER_PERMISSION_DENIED.",
        ),
        li(
          strong("Customer ID"),
          " - open the account itself and read the ten digits at the top " +
            "right, beside the account name. It is the account the data " +
            "comes from: the client account, not the manager.",
        ),
      ),
    ),
  );

/**
 * Catch the two mistakes that cost a round trip through a failing table.
 *
 * Written without regex escapes: this is a template literal, so a `\d` here
 * would reach the browser as a bare `d`. See liveUriScript above.
 */
const idCheckScript = () =>
  `<script>
(function () {
  var cid = document.getElementById("inputcustomer_id");
  var mgr = document.getElementById("inputlogin_customer_id");
  var note = document.getElementById("gads-id-note");
  if (!cid || !note) return;
  function onlyDigits(v) {
    return String(v || "").replace(/[^0-9]/g, "");
  }
  function check() {
    var c = onlyDigits(cid.value);
    var m = mgr ? onlyDigits(mgr.value) : "";
    var msg = "";
    if (c && m && c === m)
      msg =
        "Both fields name the same account. Customer ID is the client " +
        "account the data comes from; only the manager's own ID belongs " +
        "in the field below it.";
    else if (c && c.length !== 10)
      msg = "A customer ID is ten digits - this one has " + c.length + ".";
    else if (m && m.length !== 10)
      msg =
        "A manager account ID is ten digits - this one has " + m.length + ".";
    note.textContent = msg;
    note.classList.toggle("d-none", !msg);
  }
  cid.addEventListener("input", check);
  if (mgr) mgr.addEventListener("input", check);
  check();
})();
</script>`;

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Google OAuth client",
        form: async (context) =>
          new Form({
            blurb: setupBlurb(context),
            fields: [
              {
                name: "base_url",
                label: "Base URL",
                sublabel:
                  "This Saltcorn instance's public URL. Defaults to the one " +
                  "in the site settings.",
                type: "String",
                required: true,
                default: defaultBaseUrl(),
              },
              {
                name: "client_id",
                label: "Client ID",
                type: "String",
                required: true,
              },
              {
                name: "client_secret",
                label: "Client secret",
                type: "String",
                required: true,
                input_type: "password",
              },
              {
                name: "developer_token",
                label: "Developer token",
                sublabel:
                  "Optional. Google's access-levels page says developer " +
                  "tokens were sunset on 9 September 2026 and that access " +
                  "now belongs to the Cloud project, while its call-structure " +
                  "page still lists the header as required. Paste one if you " +
                  "have it; it is sent only when set.",
                type: "String",
                input_type: "password",
              },
              {
                name: "api_version",
                label: "API version",
                sublabel:
                  "Google ships a major version about quarterly and sunsets " +
                  "each roughly a year later, so this will need raising. See " +
                  `the <a href="${VERSIONING_URL}" target="_blank">versioning ` +
                  "notes</a>.",
                type: "String",
                required: true,
                default: DEFAULT_API_VERSION,
              },
            ],
          }),
      },
      {
        name: "Connect",
        form: async (context) =>
          new Form({ blurb: connectBlurb(context), fields: [] }),
      },
      {
        name: "Account",
        form: async (context) => {
          const options = accountOptions(context);
          const connected = oauth.isConnected(context);
          return new Form({
            blurb: [
              connected
                ? p(
                    { class: "text-muted" },
                    options.length
                      ? "Set the manager first, then the account held " +
                        "under it. An account held under a manager is not " +
                        "listed here, so its ID has to be typed. A manager " +
                        "is rarely the right answer for Customer ID " +
                        "itself: it holds no campaigns."
                      : "No accounts were listed for this connection. " +
                        "Reconnect on the previous step to refresh the " +
                        "list, or type the customer ID.",
                  )
                : p(
                    { class: "alert alert-warning" },
                    "Connect the Google account on the previous step first.",
                  ),
              connected ? accountPicker(options) : "",
              idHelp(),
              div({ id: "gads-id-note", class: "alert alert-warning py-2 px-3 d-none" }, ""),
              idCheckScript(),
            ],
            // The manager comes first because that is the order the
            // accounts are reached in: you pick a manager, then an account
            // held under it. Asking for the client account first invites
            // the manager's own ID into the box, which reads as empty
            // tables rather than as an error.
            fields: [
              {
                name: "login_customer_id",
                label: "Manager account ID",
                sublabel:
                  "Only when the account below is reached through a manager " +
                  "(MCC) account - then the manager's own ten-digit ID. " +
                  "Leave empty if there is no manager. Sent as the " +
                  "login-customer-id header.",
                type: "String",
              },
              {
                name: "customer_id",
                label: "Customer ID",
                sublabel:
                  "The account the tables and actions read and write - the " +
                  "client account held under the manager above, not the " +
                  "manager itself. Ten digits, with or without hyphens.",
                type: "String",
                required: true,
              },
            ],
          });
        },
      },
      {
        name: "Confirm account",
        form: async (context) => {
          // Asked after the Account step because it needs the customer ID the
          // previous step collects. One read, here rather than on every table
          // read: none of what it returns changes for the life of the
          // account.
          let acct = null;
          let lookupError = null;
          // digits(), not customerId(): customerId throws when nothing is
          // selected yet, which is the normal state on a first run through.
          if (digits(context.customer_id))
            try {
              acct = await api.fetchAccount({ cfg: context });
            } catch (e) {
              lookupError = e.message;
            }
          const found = acct && acct.timeZone;
          const named =
            hyphenate(digits(context.customer_id)) +
            (acct && acct.name ? ` (${acct.name})` : "");
          return new Form({
            blurb: [
              // Caught here rather than on the first table read, where it
              // arrives as REQUESTED_METRICS_FOR_MANAGER from Google and the
              // settings page has nothing to show for it but a row count.
              acct && acct.manager
                ? p(
                    { class: "alert alert-danger" },
                    `${named} is a manager account. A manager holds no ` +
                      "campaigns of its own, and Google rejects any request " +
                      "for metrics against one " +
                      "(REQUESTED_METRICS_FOR_MANAGER), so every table " +
                      "built on it fails. Go back and set Customer ID to an " +
                      "account held under this one, putting this ID in " +
                      "Manager account ID instead.",
                  )
                : "",
              acct && acct.testAccount
                ? p(
                    { class: "text-muted" },
                    `${named} is an API test account. It never serves, so ` +
                      "structure reads normally and every metric is zero.",
                  )
                : "",
              lookupError
                ? p(
                    { class: "alert alert-warning" },
                    "Could not read the account's time zone: " +
                      lookupError +
                      " Set it by hand below, or leave it empty to use this " +
                      "server's time zone.",
                  )
                : p(
                    { class: "text-muted" },
                    "Report dates are calendar dates in the Google Ads " +
                      "account's own time zone, which is fixed when the " +
                      "account is created. If this is left empty the " +
                      "server's time zone is used instead, which shifts the " +
                      "default report window by a day for part of every day " +
                      "whenever the two differ.",
                  ),
            ],
            fields: [
              {
                name: "account_time_zone",
                label: "Account time zone",
                sublabel:
                  "IANA name, such as Africa/Kigali or America/New_York." +
                  (found ? " Read from the account." : ""),
                type: "String",
                default: context.account_time_zone || found || "",
              },
            ],
          });
        },
      },
    ],
  });

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "google-ads",
  configuration_workflow,
  // Every one of these is a function of the plugin config, not a plain value.
  // State.registerPlugin calls each key when the plugin has a
  // configuration_workflow, so an object or array here is invoked and throws.
  table_providers: () => ({ "Google Ads": provider["Google Ads"] }),
  actions: () => ({
    google_ads_run_query: actions.google_ads_run_query,
    google_ads_set_campaign_status: actions.google_ads_set_campaign_status,
    google_ads_set_ad_group_status: actions.google_ads_set_ad_group_status,
    google_ads_set_campaign_budget: actions.google_ads_set_campaign_budget,
  }),
  routes: () => routes,
};
