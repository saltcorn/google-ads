const test = require("node:test");
const assert = require("node:assert");
const plugin = require("../index.js");
const routes = require("../lib/routes");
// namespace, so fetchAccount can be substituted
const api = require("../lib/api");
const { CALLBACK_PATH, redirectUri, DEFAULT_API_VERSION } = require("../lib/config");

const blurbOf = async (stepIx, context) => {
  const step = plugin.configuration_workflow().steps[stepIx];
  const form = await step.form(context);
  return Array.isArray(form.blurb) ? form.blurb.join("") : String(form.blurb || "");
};
const fieldsOf = async (stepIx, context) =>
  (await plugin.configuration_workflow().steps[stepIx].form(context)).fields;

test("the advertised redirect URI and the registered route cannot drift", () => {
  // These are what a redirect_uri_mismatch is: the URI we tell people to
  // register, and the path we actually listen on, disagreeing.
  const registered = routes.map((r) => r.url);
  assert.ok(
    registered.includes(CALLBACK_PATH),
    `no route serves ${CALLBACK_PATH}; registered: ${registered.join(", ")}`,
  );
  assert.equal(
    redirectUri({ base_url: "https://example.com" }),
    `https://example.com${CALLBACK_PATH}`,
  );
});

test("the plugin registers providers, actions and routes as functions", () => {
  // With a configuration_workflow, State.registerPlugin calls every key - a
  // plain object or array here would be invoked and throw.
  for (const key of ["table_providers", "actions", "routes"])
    assert.equal(typeof plugin[key], "function", key);
  assert.deepEqual(Object.keys(plugin.table_providers()), ["Google Ads"]);
  // Named, not counted: an action nobody can tell the purpose of is worse
  // than no action, and listing accounts was one - no configuration, no
  // visible result, and the Account step already shows the same list.
  assert.deepEqual(Object.keys(plugin.actions()), [
    "google_ads_run_query",
    "google_ads_set_campaign_status",
    "google_ads_set_ad_group_status",
    "google_ads_set_campaign_budget",
  ]);
  assert.equal(plugin.routes().length, 3);
  assert.equal(plugin.sc_plugin_api_version, 1);
  assert.equal(plugin.plugin_name, "google-ads");
});

test("every registered action really is one", () => {
  for (const [name, action] of Object.entries(plugin.actions())) {
    assert.ok(action, name);
    assert.equal(typeof action.run, "function", name);
    assert.equal(action.namespace, "Google Ads", name);
  }
});

test("step 1 says to enable the Ads API and links the right console page", async () => {
  const b = await blurbOf(0, {});
  assert.match(b, /Enable the <strong>Google Ads API<\/strong>/);
  assert.match(b, /googleads\.googleapis\.com/);
});

test("step 1 explains the access level, which is the real gate", async () => {
  const b = await blurbOf(0, {});
  assert.match(b, /access level/i);
  assert.match(b, /<strong>Test<\/strong>/);
  assert.match(b, /test accounts only/);
  assert.match(b, /<strong>Explorer<\/strong>/);
});

test("the redirect URI is on step 1, before anyone can leave it", async () => {
  const b = await blurbOf(0, {});
  assert.match(b, /Authorised redirect URIs/);
  assert.match(b, /gads-redirect-uri/);
  assert.match(b, /your-saltcorn-host\/google-ads\/oauth2\/callback/);
});

test("with no base URL the URI is not called exact", async () => {
  const b = await blurbOf(0, {});
  const exact = /id="gads-uri-exact" class="([^"]*)"/.exec(b);
  assert.ok(exact, "the exactness note is rendered");
  assert.match(exact[1], /\bd-none\b/, "and hidden while the host is a placeholder");
  assert.match(b, /The host shown is a placeholder/);
});

test("with a base URL it is, and shows the real URI", async () => {
  const b = await blurbOf(0, { base_url: "https://ads.example.com" });
  const exact = /id="gads-uri-exact" class="([^"]*)"/.exec(b);
  assert.ok(!/\bd-none\b/.test(exact[1]));
  assert.match(b, />https:\/\/ads\.example\.com\/google-ads\/oauth2\/callback</);
});

test("step 1 asks for the client, the optional token and the version", async () => {
  const fields = await fieldsOf(0, {});
  const names = fields.map((f) => f.name);
  assert.deepEqual(names, [
    "base_url",
    "client_id",
    "client_secret",
    "developer_token",
    "api_version",
  ]);
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.client_secret.input_type, "password");
  assert.equal(byName.developer_token.input_type, "password");
  // optional, because Google's own pages disagree about whether it is needed
  assert.ok(!byName.developer_token.required);
  assert.equal(byName.api_version.default, DEFAULT_API_VERSION);
  assert.ok(byName.api_version.required);
});

test("the developer-token field states the contradiction rather than picking a side", async () => {
  const fields = await fieldsOf(0, {});
  const dev = fields.find((f) => f.name === "developer_token");
  assert.match(dev.sublabel, /sunset on 9 September 2026/);
  assert.match(dev.sublabel, /still lists the header as required/);
});

test("the version field warns that it expires", async () => {
  const fields = await fieldsOf(0, {});
  const v = fields.find((f) => f.name === "api_version");
  assert.match(v.sublabel, /quarterly/);
  assert.match(v.sublabel, /sunsets/);
  assert.match(v.sublabel, /versioning/);
});

test("the Connect step offers Connect and says what the scope grants", async () => {
  const b = await blurbOf(1, { base_url: "https://ads.example.com" });
  assert.match(b, /Not connected yet/);
  assert.match(b, /href="\/google-ads\/oauth2\/authorize"/);
  assert.match(b, /adwords/);
  assert.match(b, /read and write/);
  assert.match(b, /only the actions write/);
});

test("the Connect step reports a dead token instead of showing it connected", async () => {
  const b = await blurbOf(1, {
    base_url: "https://ads.example.com",
    oauth: { refresh_token: "dead" },
    oauth_error: { at: "2026-10-20T07:00:00Z", code: "invalid_grant", message: "Re-authorise." },
  });
  assert.match(b, /no longer valid/);
  assert.match(b, /Re-authorise\./);
  assert.ok(!b.includes("Connected since"));
});

test("the Account step insists on connecting first", async () => {
  const b = await blurbOf(2, {});
  assert.match(b, /Connect the Google account on the previous step first/);
});

// listAccessibleCustomers returns only directly owned accounts, never one
// held under a manager - which is the account most setups query. Offered as
// a dropdown, those were the only IDs selectable, and the blurb beside it
// told people to type an ID they had no box to type into.
test("the Account step keeps the ID typable, with the cached accounts as fills", async () => {
  const context = {
    oauth: { refresh_token: "rt" },
    accessible_customers: ["1234567890", "9876543210"],
  };
  const fields = await fieldsOf(2, context);
  const cid = fields.find((f) => f.name === "customer_id");
  assert.ok(!cid.attributes || !cid.attributes.options, "not a dropdown");
  assert.ok(cid.required);

  const b = await blurbOf(2, context);
  assert.match(b, /data-cid="123-456-7890"/);
  assert.match(b, /data-cid="987-654-3210"/);
  assert.match(b, /getElementById\("inputcustomer_id"\)/);
});

test("with no cached accounts the ID can still be typed", async () => {
  const fields = await fieldsOf(2, { oauth: { refresh_token: "rt" } });
  const cid = fields.find((f) => f.name === "customer_id");
  assert.ok(!cid.attributes || !cid.attributes.options);
  const b = await blurbOf(2, { oauth: { refresh_token: "rt" } });
  assert.match(b, /No accounts were listed/);
});

test("the Account step explains why a managed account is not listed", async () => {
  const b = await blurbOf(2, {
    oauth: { refresh_token: "rt" },
    accessible_customers: ["1234567890"],
  });
  assert.match(b, /held under a manager is not/);
  const fields = await fieldsOf(2, { oauth: { refresh_token: "rt" } });
  const mgr = fields.find((f) => f.name === "login_customer_id");
  assert.match(mgr.sublabel, /login-customer-id/);
  assert.ok(!mgr.required);
});

// Both IDs are ten digits in the same shape, so the step has to say which
// account each one names - a manager's ID in Customer ID yields empty
// tables, not an error, which is the hardest kind of mistake to find.
test("the Account step says where to find both IDs", async () => {
  const b = await blurbOf(2, { oauth: { refresh_token: "rt" } });
  assert.match(b, /Where to find these/);
  assert.match(b, /top right, beside the account name/);
  assert.match(b, /Direct manager/);
  assert.match(b, /USER_PERMISSION_DENIED/);

  const fields = await fieldsOf(2, { oauth: { refresh_token: "rt" } });
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.match(byName.customer_id.sublabel, /not the manager itself/);
  assert.match(byName.login_customer_id.sublabel, /manager's own ten-digit ID/);

  // Manager first: it is the order the accounts are reached in, and asking
  // for the client account first invites the manager's ID into that box.
  assert.deepEqual(
    fields.map((f) => f.name),
    ["login_customer_id", "customer_id"],
  );
});

test("either ID can be filled from a reachable account", async () => {
  // What a connection reaches directly is usually the manager, so a picker
  // that only filled Customer ID aimed at the wrong box.
  const b = await blurbOf(2, {
    oauth: { refresh_token: "rt" },
    accessible_customers: ["1234567890"],
  });
  assert.match(b, /data-cid="123-456-7890" data-target="customer_id"/);
  assert.match(b, /data-cid="123-456-7890" data-target="login_customer_id"/);
  assert.match(b, /use as Customer ID/);
  assert.match(b, /use as Manager ID/);
});

test("the disconnect form carries a CSRF token", async () => {
  // A blurb has no `req`, so req.csrfToken() is out of reach and the POST
  // was rejected with "invalid csrf token". The page wrapper defines
  // _sc_globalCsrf on every page; the field is filled from that.
  const b = await blurbOf(1, {
    base_url: "https://ads.example.com",
    oauth: { refresh_token: "rt" },
  });
  assert.match(b, /action="\/google-ads\/oauth2\/disconnect"/);
  assert.match(b, /name="_csrf" id="gads-csrf"/);
  assert.match(b, /_sc_globalCsrf/);
});

test("the Account step checks the IDs in the browser", async () => {
  const b = await blurbOf(2, { oauth: { refresh_token: "rt" } });
  assert.match(b, /id="gads-id-note"/);
  assert.match(b, /getElementById\("inputlogin_customer_id"\)/);
  assert.match(b, /Both fields name the same account/);
  assert.match(b, /ten digits - this one has/);
  // a template literal, so a regex escape would be eaten before the browser
  // ever saw it - see liveUriScript
  assert.doesNotMatch(b, /\\d/);
});

// Shown whether or not the connection worked: the IDs are what someone is
// hunting for while the Connect step is still failing.
test("the ID help survives a missing connection", async () => {
  const b = await blurbOf(2, {});
  assert.match(b, /Connect the Google account on the previous step first/);
  assert.match(b, /Where to find these/);
});

// Each step needs what the one before it collects: Connect needs the client
// credentials, Account needs the connection to list the reachable accounts,
// and Time zone needs the customer ID to look the zone up on.
test("the workflow has the four steps, in the order they depend on", async () => {
  const steps = plugin.configuration_workflow().steps;
  assert.deepEqual(steps.map((s) => s.name), [
    "Google OAuth client",
    "Connect",
    "Account",
    "Confirm account",
  ]);
});

const confirmStep = () =>
  plugin.configuration_workflow().steps.find((s) => s.name === "Confirm account");

const withAccount = async (impl, context) => {
  const orig = api.fetchAccount;
  try {
    api.fetchAccount = impl;
    return await confirmStep().form(context);
  } finally {
    api.fetchAccount = orig;
  }
};

const joined = (form) =>
  Array.isArray(form.blurb) ? form.blurb.join("") : String(form.blurb || "");

test("the confirm step offers the account's zone and survives a failed lookup", async () => {
  // the account this plugin was first pointed at was not enabled, so the
  // lookup throws - configuration must still be completable by hand
  const form = await withAccount(async () => {
    throw new Error("CUSTOMER_NOT_ENABLED");
  }, { customer_id: "8684215862" });
  const fld = form.fields.find((f) => f.name === "account_time_zone");
  assert.ok(fld, "the field is still offered");
  assert.strictEqual(fld.default, "");
  assert.match(joined(form), /Could not read the account's time zone/);
  assert.match(joined(form), /CUSTOMER_NOT_ENABLED/);

  const ok = await withAccount(
    async () => ({ timeZone: "Africa/Kigali", manager: false }),
    { customer_id: "8684215862" },
  );
  assert.strictEqual(
    ok.fields.find((f) => f.name === "account_time_zone").default,
    "Africa/Kigali",
  );

  // an already-set value is not overwritten by the lookup
  const kept = await withAccount(
    async () => ({ timeZone: "Africa/Kigali", manager: false }),
    { customer_id: "8684215862", account_time_zone: "America/New_York" },
  );
  assert.strictEqual(
    kept.fields.find((f) => f.name === "account_time_zone").default,
    "America/New_York",
  );
});

// A manager in Customer ID is not an error until the first table read, and
// then it is REQUESTED_METRICS_FOR_MANAGER from Google with nothing on the
// settings page but a row count to show for it.
test("the confirm step refuses to let a manager pass quietly", async () => {
  const form = await withAccount(
    async () => ({ timeZone: "Africa/Kigali", manager: true, name: "sc-ads-manager" }),
    { customer_id: "1660977688" },
  );
  const b = joined(form);
  assert.match(b, /alert-danger/);
  assert.match(b, /166-097-7688 \(sc-ads-manager\) is a manager account/);
  assert.match(b, /REQUESTED_METRICS_FOR_MANAGER/);
  assert.match(b, /Manager account ID instead/);
});

test("the confirm step says when the account is a test account", async () => {
  const b = joined(
    await withAccount(
      async () => ({ timeZone: "Africa/Kigali", manager: false, testAccount: true, name: "sc-camp" }),
      { customer_id: "4754394299" },
    ),
  );
  assert.match(b, /is an API test account/);
  assert.match(b, /every metric is zero/);
  assert.doesNotMatch(b, /alert-danger/);
});

test("no customer id means no lookup is attempted", async () => {
  let called = false;
  await withAccount(async () => {
    called = true;
    return { timeZone: "Africa/Kigali", manager: false };
  }, {});
  assert.strictEqual(called, false);
});
