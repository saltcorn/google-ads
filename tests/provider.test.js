const test = require("node:test");
const assert = require("node:assert");
// required as a namespace so the search call can be substituted here
const api = require("../lib/api");
const provider = require("../lib/provider");

const CFG = { customer_id: "1234567890", oauth: { refresh_token: "rt" } };

/** Replace api.search for one test, capturing the queries it was given. */
const withSearch = async (results, fn) => {
  const real = api.search;
  const calls = [];
  api.search = async (query, opts) => {
    calls.push({ query, opts });
    return typeof results === "function" ? results(query, calls.length) : results;
  };
  try {
    return await fn(calls);
  } finally {
    api.search = real;
  }
};

const campaignResult = (id, over = {}) => ({
  campaign: {
    resourceName: `customers/1234567890/campaigns/${id}`,
    id: String(id),
    name: `Campaign ${id}`,
    status: "ENABLED",
    ...over.campaign,
  },
  campaignBudget: { amountMicros: "5000000" },
  metrics: { clicks: String(over.clicks ?? 10), costMicros: String((over.cost ?? 1) * 1e6) },
  ...(over.date ? { segments: { date: over.date } } : {}),
});

const report = (cfgTable) => provider["Google Ads"].get_table(cfgTable);

test("an unconfigured table does not crash - provider_cfg is null, not undefined", () => {
  // Table.find builds every provider table before anyone has configured one
  const norm = provider.normaliseCfg(null);
  assert.equal(norm.resource, "Campaigns");
  assert.deepEqual(norm.metrics, []);
  assert.deepEqual(norm.segments, []);
  assert.equal(norm.days, provider.DEFAULT_DAYS);
  assert.ok(report(null));
  assert.ok(provider["Google Ads"].fields(null).length);
});

test("metrics and segments are gathered from the per-option checkboxes", () => {
  const norm = provider.normaliseCfg({
    resource: "Keywords",
    m_clicks: true,
    m_cost: true,
    m_impressions: false,
    seg_date: true,
    seg_device: false,
  });
  assert.deepEqual(norm.metrics, ["clicks", "cost"]);
  assert.deepEqual(norm.segments, ["date"]);
  assert.equal(norm.resource, "Keywords");
});

test("an unknown resource falls back rather than building a broken query", () => {
  assert.equal(provider.normaliseCfg({ resource: "Nonsense" }).resource, "Campaigns");
});

test("the day window is positive and whole, whatever was stored", () => {
  assert.equal(provider.normaliseCfg({ days: "7" }).days, 7);
  assert.equal(provider.normaliseCfg({ days: 7.9 }).days, 7);
  assert.equal(provider.normaliseCfg({ days: 0 }).days, provider.DEFAULT_DAYS);
  assert.equal(provider.normaliseCfg({ days: -5 }).days, provider.DEFAULT_DAYS);
  assert.equal(provider.normaliseCfg({ days: "rubbish" }).days, provider.DEFAULT_DAYS);
});

test("the provider table is read-only - Ads writes need a mutate, not a row", () => {
  const t = report({ resource: "Campaigns" });
  assert.equal(t.disableFiltering, true);
  assert.equal(typeof t.getRows, "function");
  assert.equal(typeof t.countRows, "function");
  assert.equal(typeof t.distinctValues, "function");
  assert.equal(t.insertRow, undefined);
  assert.equal(t.updateRow, undefined);
  assert.equal(t.deleteRows, undefined);
});

test("a report selects its columns and its resource name", async () => {
  await withSearch([campaignResult(1)], async (calls) => {
    await report({ resource: "Campaigns", m_clicks: true }).getRows({}, {}, { cfg: CFG });
    const q = calls[0].query;
    assert.match(q, /^SELECT /);
    assert.match(q, /FROM campaign\b/);
    assert.match(q, /campaign\.id/);
    assert.match(q, /metrics\.clicks/);
    assert.match(q, /campaign_budget\.amount_micros/);
    // the resource name is always selected: the row key is built from it
    assert.match(q, /campaign\.resource_name/);
    // and only once, though it is also an exposed column
    assert.equal((q.match(/campaign\.resource_name/g) || []).length, 1);
  });
});

test("a metric not asked for is not selected", async () => {
  await withSearch([campaignResult(1)], async (calls) => {
    await report({ resource: "Campaigns", m_clicks: true }).getRows({}, {}, { cfg: CFG });
    assert.ok(!calls[0].query.includes("metrics.conversions"));
  });
});

test("rows come back flattened, keyed and converted", async () => {
  await withSearch([campaignResult(55, { clicks: 130, cost: 1.5 })], async () => {
    const rows = await report({ resource: "Campaigns", m_clicks: true, m_cost: true }).getRows(
      {},
      {},
      { cfg: CFG },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].campaign_id, 55);
    assert.equal(rows[0].clicks, 130);
    assert.equal(rows[0].cost, 1.5);
    assert.equal(rows[0].row_key, "customers/1234567890/campaigns/55");
  });
});

test("a filter GAQL can express is pushed into WHERE", async () => {
  await withSearch([], async (calls) => {
    await report({ resource: "Campaigns" }).getRows(
      { status: "ENABLED", campaign_id: { gt: 10 } },
      {},
      { cfg: CFG },
    );
    assert.match(calls[0].query, /WHERE /);
    assert.match(calls[0].query, /campaign\.status = 'ENABLED'/);
    assert.match(calls[0].query, /campaign\.id > 10/);
  });
});

test("a filter GAQL cannot express is applied locally instead", async () => {
  const rows = [campaignResult(1, { campaign: { name: "PROMO summer" } }), campaignResult(2, { campaign: { name: "brand" } })];
  await withSearch(rows, async (calls) => {
    const out = await report({ resource: "Campaigns" }).getRows(
      { campaign_name: { ilike: "promo" } },
      {},
      { cfg: CFG },
    );
    // nothing sent: GAQL's LIKE is case-sensitive, so pushing it would lose rows
    assert.ok(!calls[0].query.includes("WHERE"));
    assert.equal(out.length, 1);
    assert.equal(out[0].campaign_name, "PROMO summer");
  });
});

test("an or is evaluated locally over the wider set the API returned", async () => {
  const rows = [
    campaignResult(1, { campaign: { status: "ENABLED" } }),
    campaignResult(2, { campaign: { status: "PAUSED" } }),
    campaignResult(3, { campaign: { status: "REMOVED" } }),
  ];
  await withSearch(rows, async (calls) => {
    const out = await report({ resource: "Campaigns" }).getRows(
      { or: [{ status: "ENABLED" }, { status: "PAUSED" }] },
      {},
      { cfg: CFG },
    );
    assert.ok(!calls[0].query.includes("WHERE"));
    assert.deepEqual(out.map((r) => r.status).sort(), ["ENABLED", "PAUSED"]);
  });
});

test("segmenting by date applies a default window, so history is not walked", async () => {
  await withSearch([], async (calls) => {
    await report({ resource: "Campaigns", seg_date: true, days: 7 }).getRows({}, {}, { cfg: CFG });
    assert.match(calls[0].query, /segments\.date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'/);
    assert.match(calls[0].query, /segments\.date/);
  });
});

test("a view's own date filter replaces the default window", async () => {
  await withSearch([], async (calls) => {
    await report({ resource: "Campaigns", seg_date: true, days: 7 }).getRows(
      { date: [{ gt: "2026-01-01", equal: true }, { lt: "2026-02-01" }] },
      {},
      { cfg: CFG },
    );
    const q = calls[0].query;
    assert.match(q, /segments\.date >= '2026-01-01'/);
    assert.match(q, /segments\.date < '2026-02-01'/);
    // the default must not be ANDed on top, which would intersect the two
    assert.ok(!q.includes("BETWEEN"));
  });
});

test("no date segment means no window - a total is not a time series", async () => {
  await withSearch([], async (calls) => {
    await report({ resource: "Campaigns" }).getRows({}, {}, { cfg: CFG });
    assert.ok(!calls[0].query.includes("segments.date"));
  });
});

test("ordering is pushed down when the column allows it", async () => {
  await withSearch([], async (calls) => {
    await report({ resource: "Campaigns", m_clicks: true }).getRows(
      {},
      { orderBy: "clicks", orderDesc: true },
      { cfg: CFG },
    );
    assert.match(calls[0].query, /ORDER BY metrics\.clicks DESC/);
  });
});

test("ordering on an unsortable column is done locally", async () => {
  const rows = [campaignResult(2), campaignResult(1)];
  await withSearch(rows, async (calls) => {
    const out = await report({ resource: "Campaigns" }).getRows(
      {},
      { orderBy: "resource_name" },
      { cfg: CFG },
    );
    assert.ok(!calls[0].query.includes("ORDER BY"));
    assert.deepEqual(out.map((r) => r.campaign_id), [1, 2]);
  });
});

test("ordering on the synthesised key is local - it is not a GAQL field", async () => {
  await withSearch([campaignResult(1)], async (calls) => {
    await report({ resource: "Campaigns" }).getRows({}, { orderBy: "row_key" }, { cfg: CFG });
    assert.ok(!calls[0].query.includes("ORDER BY"));
  });
});

test("a limit is pushed down, and the offset is folded into it", async () => {
  await withSearch([], async (calls) => {
    await report({ resource: "Campaigns", m_clicks: true }).getRows(
      {},
      { orderBy: "clicks", limit: 10, offset: 20 },
      { cfg: CFG },
    );
    // GAQL has no OFFSET, so 30 rows are fetched and 20 dropped locally
    assert.match(calls[0].query, /LIMIT 30$/);
  });
});

test("the pushed limit still yields exactly the page asked for", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => campaignResult(i + 1));
  await withSearch(rows, async () => {
    const out = await report({ resource: "Campaigns", m_clicks: true }).getRows(
      {},
      { orderBy: "clicks", limit: 10, offset: 20 },
      { cfg: CFG },
    );
    assert.equal(out.length, 10);
    assert.equal(out[0].campaign_id, 21);
  });
});

test("no limit is pushed while a local filter still has to run", async () => {
  // the rows GAQL would keep are not the rows that survive the local pass
  await withSearch([], async (calls) => {
    await report({ resource: "Campaigns" }).getRows(
      { campaign_name: { ilike: "x" } },
      { limit: 10 },
      { cfg: CFG },
    );
    assert.ok(!calls[0].query.includes("LIMIT"));
  });
});

test("no limit is pushed when the sort is local, or every row is needed first", async () => {
  await withSearch([], async (calls) => {
    await report({ resource: "Campaigns" }).getRows(
      {},
      { orderBy: "resource_name", limit: 5 },
      { cfg: CFG },
    );
    assert.ok(!calls[0].query.includes("LIMIT"));
  });
});

test("a local limit still pages correctly", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => campaignResult(i + 1));
  await withSearch(rows, async () => {
    const out = await report({ resource: "Campaigns" }).getRows(
      {},
      { orderBy: "resource_name", limit: 3, offset: 2 },
      { cfg: CFG },
    );
    assert.equal(out.length, 3);
  });
});

test("countRows counts what matches, filter and all", async () => {
  const rows = [
    campaignResult(1, { campaign: { name: "promo a" } }),
    campaignResult(2, { campaign: { name: "brand" } }),
    campaignResult(3, { campaign: { name: "promo b" } }),
  ];
  await withSearch(rows, async () => {
    const t = report({ resource: "Campaigns" });
    assert.equal(await t.countRows({}), 3);
    assert.equal(await t.countRows({ campaign_name: { ilike: "promo" } }), 2);
  });
});

test("distinctValues reports each value once", async () => {
  const rows = [
    campaignResult(1, { campaign: { status: "ENABLED" } }),
    campaignResult(2, { campaign: { status: "PAUSED" } }),
    campaignResult(3, { campaign: { status: "ENABLED" } }),
  ];
  await withSearch(rows, async () => {
    const got = await report({ resource: "Campaigns" }).distinctValues("status");
    assert.deepEqual(got.sort(), ["ENABLED", "PAUSED"]);
  });
});

test("each resource queries its own GAQL resource", async () => {
  const expected = {
    Campaigns: "campaign",
    "Ad groups": "ad_group",
    Ads: "ad_group_ad",
    Keywords: "keyword_view",
    "Search terms": "search_term_view",
    Accounts: "customer",
  };
  for (const [resource, from] of Object.entries(expected))
    await withSearch([], async (calls) => {
      await report({ resource }).getRows({}, {}, { cfg: CFG });
      assert.match(calls[0].query, new RegExp(`FROM ${from}\\b`), resource);
    });
});

test("every resource's fields include a primary key", () => {
  for (const resource of Object.keys({
    Campaigns: 1,
    "Ad groups": 1,
    Ads: 1,
    Keywords: 1,
    "Search terms": 1,
    Accounts: 1,
  })) {
    const fields = provider["Google Ads"].fields({ resource });
    const pks = fields.filter((f) => f.primary_key);
    assert.equal(pks.length, 1, resource);
    assert.equal(pks[0].name, "row_key");
  }
});

test("a custom query runs as written, with nothing appended", async () => {
  const q = "SELECT campaign.id, campaign.name FROM campaign WHERE campaign.id = 5 LIMIT 3";
  await withSearch([campaignResult(5)], async (calls) => {
    await report({
      mode: provider.CUSTOM,
      query: q,
      query_columns: JSON.stringify([
        { col: "campaign_id", gaql: "campaign.id", type: "int" },
        { col: "campaign_name", gaql: "campaign.name", type: "string" },
      ]),
    }).getRows({ status: "ENABLED" }, { limit: 1 }, { cfg: CFG });
    // appending to a query that already has WHERE, ORDER BY or LIMIT cannot be
    // done safely by text, so the filter is local and the query is untouched
    assert.equal(calls[0].query, q);
  });
});

test("a custom query's filter and paging are applied locally", async () => {
  const rows = [
    campaignResult(1, { campaign: { name: "a" } }),
    campaignResult(2, { campaign: { name: "b" } }),
  ];
  const cols = JSON.stringify([
    { col: "campaign_id", gaql: "campaign.id", type: "int" },
    { col: "campaign_name", gaql: "campaign.name", type: "string" },
  ]);
  await withSearch(rows, async () => {
    const t = report({ mode: provider.CUSTOM, query: "SELECT campaign.id FROM campaign", query_columns: cols });
    const out = await t.getRows({ campaign_name: "b" }, {}, { cfg: CFG });
    assert.equal(out.length, 1);
    assert.equal(out[0].campaign_id, 2);
  });
});

test("a custom query with no resource name selected still gets distinct keys", async () => {
  const cols = JSON.stringify([{ col: "metrics_clicks", gaql: "metrics.clicks", type: "int" }]);
  await withSearch(
    [{ metrics: { clicks: "1" } }, { metrics: { clicks: "2" } }],
    async () => {
      const out = await report({
        mode: provider.CUSTOM,
        query: "SELECT metrics.clicks FROM campaign",
        query_columns: cols,
      }).getRows({}, {}, { cfg: CFG });
      assert.equal(out.length, 2);
      assert.notEqual(out[0].row_key, out[1].row_key);
      assert.match(out[0].row_key, /^[0-9a-f]{16}$/);
    },
  );
});

test("a custom table with no query yields nothing rather than failing", async () => {
  const out = await report({ mode: provider.CUSTOM }).getRows({}, {}, { cfg: CFG });
  assert.deepEqual(out, []);
});

test("stored columns are used, and re-derived if they are unusable", () => {
  const good = JSON.stringify([{ col: "a_b", gaql: "a.b", type: "int" }]);
  assert.equal(provider.storedQueryColumns({ query_columns: good })[0].type, "int");
  // corrupt or missing: the SELECT list alone still gives a table
  const fallback = provider.storedQueryColumns({
    query_columns: "{not json",
    query: "SELECT campaign.id, campaign.name FROM campaign",
  });
  assert.deepEqual(fallback.map((c) => c.col), ["campaign_id", "campaign_name"]);
  assert.deepEqual(
    provider.storedQueryColumns({ query: "SELECT campaign.id FROM campaign" }).map((c) => c.col),
    ["campaign_id"],
  );
});

test("resolveQuery types a query's columns from the catalogue", async () => {
  const real = api.describeFields;
  api.describeFields = async () => [
    { name: "campaign.id", dataType: "INT64" },
    { name: "campaign.name", dataType: "STRING" },
  ];
  try {
    const r = await provider.resolveQuery(
      "SELECT campaign.id, campaign.name FROM campaign",
      { cfg: CFG },
    );
    assert.equal(r.error, null);
    assert.equal(r.from, "campaign");
    assert.deepEqual(r.columns.map((c) => c.type), ["int", "string"]);
  } finally {
    api.describeFields = real;
  }
});

test("resolveQuery reports a catalogue failure but still returns columns", async () => {
  const real = api.describeFields;
  api.describeFields = async () => {
    throw new Error("PERMISSION_DENIED");
  };
  try {
    const r = await provider.resolveQuery("SELECT campaign.id FROM campaign", { cfg: CFG });
    assert.match(r.error, /Could not read field types.*PERMISSION_DENIED/);
    assert.deepEqual(r.columns.map((c) => c.col), ["campaign_id"]);
  } finally {
    api.describeFields = real;
  }
});

test("resolveQuery explains a query with no fields rather than guessing", async () => {
  const r = await provider.resolveQuery("this is not a query", { cfg: CFG });
  assert.deepEqual(r.columns, []);
  assert.match(r.error, /No field names were found/);
});

test("an unsupported operator names itself and says what to do", async () => {
  await withSearch([campaignResult(1)], async () => {
    await assert.rejects(
      () => report({ resource: "Campaigns" }).getRows({ status: { inSelect: {} } }, {}, { cfg: CFG }),
      (e) => {
        assert.match(e.message, /inSelect/);
        assert.match(e.message, /no OR and no parentheses/);
        return true;
      },
    );
  });
});

test("the configuration workflow shows the steps each mode needs", async () => {
  const steps = provider["Google Ads"].configuration_workflow().steps;
  assert.deepEqual(steps.map((s) => s.name), ["Table", "Columns", "Query", "Resolve"]);
  const forReport = steps.filter((s) => !s.onlyWhen || s.onlyWhen({ mode: "Report" }));
  assert.deepEqual(forReport.map((s) => s.name), ["Table", "Columns"]);
  const forCustom = steps.filter((s) => !s.onlyWhen || s.onlyWhen({ mode: provider.CUSTOM }));
  assert.deepEqual(forCustom.map((s) => s.name), ["Table", "Query", "Resolve"]);
});

test("the Columns step offers every metric and segment", async () => {
  const steps = provider["Google Ads"].configuration_workflow().steps;
  const form = await steps[1].form({ resource: "Campaigns" });
  const names = form.fields.map((f) => f.name);
  assert.ok(names.includes("m_clicks"));
  assert.ok(names.includes("m_cost"));
  assert.ok(names.includes("seg_date"));
  assert.ok(names.includes("seg_device"));
  assert.ok(names.includes("days"));
});

test("the Columns step offers exactly the options normaliseCfg reads back", async () => {
  // The coupling that matters: a metric offered under a name the normaliser
  // does not look for would silently never apply.
  const { METRIC_COLS, SEGMENT_COLS } = require("../lib/resources");
  const steps = provider["Google Ads"].configuration_workflow().steps;
  const form = await steps[1].form({ resource: "Campaigns" });
  const names = form.fields.map((f) => f.name);
  assert.deepEqual(
    names.filter((n) => n.startsWith("m_")).sort(),
    METRIC_COLS.map((m) => `m_${m}`).sort(),
  );
  assert.deepEqual(
    names.filter((n) => n.startsWith("seg_")).sort(),
    SEGMENT_COLS.map((s) => `seg_${s}`).sort(),
  );
  const ticked = Object.fromEntries(names.map((n) => [n, true]));
  const norm = provider.normaliseCfg({ resource: "Campaigns", ...ticked });
  assert.deepEqual(norm.metrics, METRIC_COLS);
  assert.deepEqual(norm.segments, SEGMENT_COLS);
});

// The Campaigns table sent two fields Google removed in v23, which fails the
// whole query - every column, not just those two. A reply that comes back
// mapped is not evidence the SELECT was accepted, so assert on what is sent.
test("the campaigns query sends no field that v23 removed", async () => {
  await withSearch([campaignResult(1)], async (calls) => {
    await report({ resource: "Campaigns" }).getRows({}, {}, { cfg: CFG });
    const q = calls[0].query;
    assert.match(q, /campaign\.start_date_time/);
    assert.match(q, /campaign\.end_date_time/);
    assert.doesNotMatch(q, /campaign\.start_date\b(?!_)/);
    assert.doesNotMatch(q, /campaign\.end_date\b(?!_)/);
  });
});

test("a filter on a campaign date stays out of the query", async () => {
  // How GAQL compares a 'YYYY-MM-DD' literal against a
  // "YYYY-MM-DD HH:mm:ss" field is unverified against a live account, so the
  // condition is applied locally rather than pushed down and hoped for.
  await withSearch([campaignResult(1), campaignResult(2)], async (calls) => {
    await report({ resource: "Campaigns" }).getRows(
      { start_date: new Date(2026, 0, 1) },
      {},
      { cfg: CFG },
    );
    assert.doesNotMatch(calls[0].query, /WHERE/);
  });
});
