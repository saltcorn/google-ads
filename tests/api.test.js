const test = require("node:test");
const assert = require("node:assert");
// required as a namespace, not destructured, so the token source can be
// substituted here without touching Google
const oauth = require("../lib/oauth");
const api = require("../lib/api");

const CFG = {
  customer_id: "1234567890",
  oauth: { access_token: "tok", expires_at: Date.now() + 3.6e6 },
};

/** Replace token fetching for the duration of one test. */
const withStubbedToken = async (fn) => {
  const real = oauth.getAccessToken;
  oauth.getAccessToken = async () => "tok";
  try {
    return await fn();
  } finally {
    oauth.getAccessToken = real;
  }
};

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => (body === undefined ? "" : JSON.stringify(body)),
});

/** A fetch stand-in replaying a queue, with a log of url/method/body. */
const fakeFetch = (replies) => {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({
      url,
      method: opts.method,
      headers: opts.headers,
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return replies.shift() || reply(200, {});
  };
  impl.calls = calls;
  return impl;
};

const adsError = (code, message, over = {}) => ({
  error: {
    code,
    message: "Request contains an invalid argument.",
    status: "INVALID_ARGUMENT",
    details: [
      {
        errors: [
          {
            errorCode: over.errorCode || { queryError: code },
            message,
            ...(over.field ? { location: { fieldPathElements: [{ fieldName: over.field }] } } : {}),
          },
        ],
      },
    ],
  },
});

test("adsErrors reads details[].errors[], where Ads puts the substance", () => {
  // the other Google APIs use error.errors[]; the kit's generic reading
  // would find nothing here
  const got = api.adsErrors(
    adsError("UNRECOGNIZED_FIELD", "Unrecognized field in the query.", { field: "query" }),
  );
  assert.deepEqual(got, [
    "Unrecognized field in the query. at query (UNRECOGNIZED_FIELD)",
  ]);
});

test("adsErrors on a body with no details yields nothing", () => {
  assert.deepEqual(api.adsErrors({}), []);
  assert.deepEqual(api.adsErrors({ error: { message: "x" } }), []);
  assert.deepEqual(api.adsErrors(null), []);
});

test("a query error explains GAQL's actual limits", () => {
  const msg = api.describeError(
    400,
    adsError("QUERY_ERROR", "Error in query: unexpected end of script."),
    "/v26/customers/1/googleAds:search",
  );
  assert.match(msg, /unexpected end of script/);
  assert.match(msg, /snake_case and dotted/);
  assert.match(msg, /no OR and no parentheses/);
});

test("an access-level error names the levels and the Explorer cap", () => {
  const msg = api.describeError(
    403,
    adsError("DEVELOPER_TOKEN_NOT_APPROVED", "The developer token is not approved."),
    "/v26/customers/1/googleAds:search",
  );
  assert.match(msg, /access level/);
  assert.match(msg, /Test access reaches test accounts only/);
  assert.match(msg, /2,880/);
});

test("a permission error points at the manager-account setting", () => {
  const msg = api.describeError(
    403,
    adsError("USER_PERMISSION_DENIED", "User doesn't have permission to access customer."),
    "/v26/customers/1/googleAds:search",
  );
  assert.match(msg, /Manager account ID/);
});

// Google lists CUSTOMER_NOT_ENABLED next to USER_PERMISSION_DENIED, but the
// fixes are unrelated: one is the account's own state in the Ads UI, the other
// is a request header. Sending the first to the manager-ID setting sends the
// reader to a field that provably cannot fix it.
test("a not-enabled account is not blamed on the manager-account setting", () => {
  const msg = api.describeError(
    403,
    adsError(
      "CUSTOMER_NOT_ENABLED",
      "The customer account can't be accessed because it is not yet enabled or has been deactivated.",
    ),
    "/v26/customers/8684215862/googleAds:search",
  );
  assert.match(msg, /signup was never finished/);
  assert.match(msg, /status is Active/);
  // a test account is reached through its test manager, so the message must
  // not claim that no setting can ever help - but it must not claim this code
  // is what a test account returns either: that is undocumented
  assert.match(msg, /API test account/);
  assert.match(msg, /Manager account ID/);
  assert.doesNotMatch(msg, /reports this too/);
});

// It arrives as INVALID_ARGUMENT, so without its own branch it fell through
// to the GAQL advice - which sends the reader to inspect a query that is
// perfectly correct. The query is fine; the account is wrong.
test("metrics on a manager are blamed on the account, not the query", () => {
  const msg = api.describeError(
    400,
    adsError(
      "REQUESTED_METRICS_FOR_MANAGER",
      "Metrics cannot be requested for a manager account.",
    ),
    "/v26/customers/1660977688/googleAds:search",
  );
  assert.match(msg, /1660977688 is a manager account/);
  assert.match(msg, /Customer ID/);
  assert.match(msg, /Manager account ID/);
  assert.doesNotMatch(msg, /snake_case/);
});

test("the account ID comes from the path, which always carries it", () => {
  // it used to be read off body.customer_id, a field Google never sends, so
  // every one of these messages read "cannot reach account this one"
  for (const code of ["CUSTOMER_NOT_ENABLED", "USER_PERMISSION_DENIED", "MISSING_TOS"]) {
    const msg = api.describeError(
      403,
      adsError(code, "nope"),
      "/v26/customers/8684215862/googleAds:search",
    );
    assert.match(msg, /8684215862/, `${code} should name the account`);
    assert.doesNotMatch(msg, /account this one/, `${code} should not say "this one"`);
  }
});

test("no Ads account at all is not a permissions problem", () => {
  const msg = api.describeError(
    403,
    adsError("NOT_ADS_USER", "User in the cookie is not a valid Ads user."),
    "/v26/customers/1/googleAds:search",
  );
  assert.match(msg, /no Google Ads account at all/);
  assert.doesNotMatch(msg, /Manager account ID/);
});

test("a Test-access project reaching production names the access level", () => {
  // the documented code for this, which used to fall through to the generic
  // 403 branch and say only "(forbidden)"
  const msg = api.describeError(
    403,
    adsError(
      "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
      "The Cloud project is not approved for production access.",
    ),
    "/v26/customers/1/googleAds:search",
  );
  assert.match(msg, /access level/);
  assert.match(msg, /Test access reaches test accounts only/);
});

test("a rate-limit error says to sync rather than read live", () => {
  const msg = api.describeError(
    429,
    adsError("RESOURCE_EXHAUSTED", "Too many requests."),
    "/v26/customers/1/googleAds:search",
  );
  assert.match(msg, /daily operation limit/);
  assert.match(msg, /schedule a sync/);
});

test("a 404 on a versioned path suggests the version has been sunset", () => {
  // the failure mode this plugin is most likely to meet a year from now
  const msg = api.describeError(404, {}, "/v20/customers/1/googleAds:search");
  assert.match(msg, /version has been sunset/);
  assert.match(msg, /set a current one/);
});

test("the version is in the path, so changing it needs no reload", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([reply(200, { results: [] })]);
    await api.search("SELECT campaign.id FROM campaign", { cfg: CFG, fetchImpl: f });
    assert.match(f.calls[0].url, /\/v26\/customers\/1234567890\/googleAds:search$/);

    const f2 = fakeFetch([reply(200, { results: [] })]);
    await api.search("SELECT campaign.id FROM campaign", {
      cfg: { ...CFG, api_version: "v27" },
      fetchImpl: f2,
    });
    assert.match(f2.calls[0].url, /\/v27\//);
  });
});

test("search posts the query and sends no pageSize", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([reply(200, { results: [{ campaign: { id: "1" } }] })]);
    const out = await api.search("SELECT campaign.id FROM campaign", {
      cfg: CFG,
      fetchImpl: f,
    });
    assert.equal(f.calls[0].method, "POST");
    assert.equal(f.calls[0].body.query, "SELECT campaign.id FROM campaign");
    // Ads fixes the page size at 10,000 and errors if the field is sent
    assert.ok(!("pageSize" in f.calls[0].body));
    assert.ok(!("page_size" in f.calls[0].body));
    assert.deepEqual(out, [{ campaign: { id: "1" } }]);
  });
});

test("the first page carries no pageToken at all", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([reply(200, { results: [] })]);
    await api.search("SELECT a.b FROM c", { cfg: CFG, fetchImpl: f });
    assert.ok(!("pageToken" in f.calls[0].body));
  });
});

test("search walks pages until the token runs out", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([
      reply(200, { results: [{ n: 1 }], nextPageToken: "p2" }),
      reply(200, { results: [{ n: 2 }], nextPageToken: "p3" }),
      reply(200, { results: [{ n: 3 }] }),
    ]);
    const out = await api.search("SELECT a.b FROM c", { cfg: CFG, fetchImpl: f });
    assert.deepEqual(out, [{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.equal(f.calls[1].body.pageToken, "p2");
    assert.equal(f.calls[2].body.pageToken, "p3");
  });
});

test("maxPages stops a walk that would never end", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch(
      Array.from({ length: 10 }, (_, i) => reply(200, { results: [{ n: i }], nextPageToken: "more" })),
    );
    const out = await api.search("SELECT a.b FROM c", { cfg: CFG, fetchImpl: f, maxPages: 3 });
    assert.equal(out.length, 3);
    assert.equal(f.calls.length, 3);
  });
});

test("onPage can stop the walk early", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([
      reply(200, { results: [{ n: 1 }], nextPageToken: "p2" }),
      reply(200, { results: [{ n: 2 }], nextPageToken: "p3" }),
    ]);
    const out = await api.search("SELECT a.b FROM c", {
      cfg: CFG,
      fetchImpl: f,
      onPage: (page, raw, all) => all.length < 1,
    });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(out, [{ n: 1 }]);
  });
});

test("a page with no results does not break the walk", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([reply(200, {})]);
    assert.deepEqual(await api.search("SELECT a.b FROM c", { cfg: CFG, fetchImpl: f }), []);
  });
});

test("search refuses to run without an account chosen", async () => {
  await withStubbedToken(async () => {
    await assert.rejects(
      () => api.search("SELECT a.b FROM c", { cfg: { oauth: CFG.oauth }, fetchImpl: fakeFetch([]) }),
      /no Google Ads account selected/,
    );
  });
});

test("the developer token is sent when set and omitted when not", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([reply(200, { results: [] })]);
    await api.search("SELECT a.b FROM c", {
      cfg: { ...CFG, developer_token: "dev-123" },
      fetchImpl: f,
    });
    assert.equal(f.calls[0].headers["developer-token"], "dev-123");

    const f2 = fakeFetch([reply(200, { results: [] })]);
    await api.search("SELECT a.b FROM c", { cfg: CFG, fetchImpl: f2 });
    assert.ok(!("developer-token" in f2.calls[0].headers));
  });
});

test("the manager account is sent as login-customer-id, without hyphens", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([reply(200, { results: [] })]);
    await api.search("SELECT a.b FROM c", {
      cfg: { ...CFG, login_customer_id: "111-222-3333" },
      fetchImpl: f,
    });
    assert.equal(f.calls[0].headers["login-customer-id"], "1112223333");
  });
});

test("listAccessibleCustomers returns bare ten-digit ids", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([
      reply(200, {
        resourceNames: ["customers/1234567890", "customers/9876543210"],
      }),
    ]);
    const ids = await api.listAccessibleCustomers(CFG, { fetchImpl: f });
    assert.deepEqual(ids, ["1234567890", "9876543210"]);
    assert.match(f.calls[0].url, /\/v26\/customers:listAccessibleCustomers$/);
    // this endpoint is not scoped to a customer, so it is a plain GET
    assert.equal(f.calls[0].method, "GET");
    assert.equal(f.calls[0].body, undefined);
  });
});

test("listAccessibleCustomers on an empty reply yields an empty list", async () => {
  await withStubbedToken(async () => {
    const ids = await api.listAccessibleCustomers(CFG, { fetchImpl: fakeFetch([reply(200, {})]) });
    assert.deepEqual(ids, []);
  });
});

test("mutate posts its operations to the resource collection", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([reply(200, { results: [{ resourceName: "customers/1/campaigns/5" }] })]);
    const ops = [{ update: { resourceName: "customers/1/campaigns/5", status: "PAUSED" }, updateMask: "status" }];
    const res = await api.mutate("campaigns", ops, { cfg: CFG, fetchImpl: f });
    assert.match(f.calls[0].url, /\/v26\/customers\/1234567890\/campaigns:mutate$/);
    assert.equal(f.calls[0].method, "POST");
    assert.deepEqual(f.calls[0].body.operations, ops);
    assert.ok(!("validateOnly" in f.calls[0].body));
    assert.deepEqual(res.results, [{ resourceName: "customers/1/campaigns/5" }]);
  });
});

test("a dry run sets validateOnly", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([reply(200, {})]);
    await api.mutate("campaigns", [], { cfg: CFG, fetchImpl: f, validateOnly: true });
    assert.equal(f.calls[0].body.validateOnly, true);
  });
});

test("describeFields asks the catalogue for just the names given", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([reply(200, { results: [{ name: "campaign.id", dataType: "INT64" }] })]);
    const out = await api.describeFields(["campaign.id", "campaign.name"], {
      cfg: CFG,
      fetchImpl: f,
    });
    assert.match(f.calls[0].url, /\/v26\/googleAdsFields:search$/);
    assert.match(f.calls[0].body.query, /WHERE name IN \('campaign\.id', 'campaign\.name'\)/);
    assert.match(f.calls[0].body.query, /SELECT name, data_type/);
    assert.deepEqual(out, [{ name: "campaign.id", dataType: "INT64" }]);
  });
});

test("describeFields with no names makes no call", async () => {
  const f = fakeFetch([]);
  assert.deepEqual(await api.describeFields([], { cfg: CFG, fetchImpl: f }), []);
  assert.equal(f.calls.length, 0);
});

test("a quoted field name cannot break out of the catalogue query", async () => {
  await withStubbedToken(async () => {
    const f = fakeFetch([reply(200, {})]);
    await api.describeFields(["campaign.id') OR x--"], { cfg: CFG, fetchImpl: f });
    assert.ok(!f.calls[0].body.query.includes("'campaign.id')"));
    assert.match(f.calls[0].body.query, /IN \('campaign\.id\) OR x--'\)/);
  });
});
