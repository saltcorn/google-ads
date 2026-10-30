const test = require("node:test");
const assert = require("node:assert");
const fl = require("../lib/fields");
const { RESOURCES, columnsFor } = require("../lib/resources");

test("jsonPath converts GAQL snake_case to the reply's camelCase", () => {
  assert.deepEqual(fl.jsonPath("campaign.id"), ["campaign", "id"]);
  assert.deepEqual(fl.jsonPath("metrics.cost_micros"), ["metrics", "costMicros"]);
  assert.deepEqual(fl.jsonPath("ad_group_ad.ad.final_urls"), [
    "adGroupAd",
    "ad",
    "finalUrls",
  ]);
  assert.deepEqual(fl.jsonPath("ad_group_criterion.quality_info.quality_score"), [
    "adGroupCriterion",
    "qualityInfo",
    "qualityScore",
  ]);
});

test("at reads a path and yields undefined rather than throwing", () => {
  assert.equal(fl.at({ a: { b: 1 } }, ["a", "b"]), 1);
  assert.equal(fl.at({ a: null }, ["a", "b"]), undefined);
  assert.equal(fl.at({}, ["a", "b", "c"]), undefined);
  assert.equal(fl.at(null, ["a"]), undefined);
});

test("an int64 arrives as a string and must become a number", () => {
  // the whole reason this conversion exists: "130" sorts as text
  assert.equal(fl.convert("130", { type: "int" }), 130);
  assert.strictEqual(typeof fl.convert("130", { type: "int" }), "number");
  assert.equal(fl.convert(7, { type: "int" }), 7);
  assert.equal(fl.convert("7.9", { type: "int" }), 7);
  assert.equal(fl.convert("nonsense", { type: "int" }), null);
});

test("micros become the account's currency", () => {
  assert.equal(fl.convert("1234560", { type: "micros" }), 1.23456);
  assert.equal(fl.convert("0", { type: "micros" }), 0);
  assert.equal(fl.convert("5000000", { type: "micros" }), 5);
});

test("a rate is left exactly as Google reports it", () => {
  // ctr is a fraction, and silently scaling it would make a 5% CTR read 500%
  assert.equal(fl.convert(0.0512, { type: "float" }), 0.0512);
});

test("a date becomes a Date at local midnight", () => {
  const d = fl.convert("2026-10-02", { type: "date" });
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 2);
  assert.equal(d.getHours(), 0);
  assert.equal(fl.convert("not a date", { type: "date" }), null);
});

test("bools and strings pass through, objects are stringified", () => {
  assert.equal(fl.convert(true, { type: "bool" }), true);
  assert.equal(fl.convert(false, { type: "bool" }), false);
  assert.equal(fl.convert("ENABLED", { type: "enum" }), "ENABLED");
  assert.equal(fl.convert({ a: 1 }, { type: "string" }), '{"a":1}');
});

test("a repeated field is joined, and an empty one is null", () => {
  assert.equal(
    fl.convert(["https://a.test", "https://b.test"], { type: "string", repeated: true }),
    "https://a.test, https://b.test",
  );
  assert.equal(fl.convert([], { type: "string", repeated: true }), null);
  assert.equal(fl.convert("one", { type: "string", repeated: true }), "one");
});

test("a missing value is null, not undefined", () => {
  // undefined cells would vanish from a row rather than render as blank
  assert.strictEqual(fl.convert(undefined, { type: "int" }), null);
  assert.strictEqual(fl.convert(null, { type: "string" }), null);
});

const RESULT = {
  campaign: {
    resourceName: "customers/1234567890/campaigns/55",
    id: "55",
    name: "Promo",
    status: "ENABLED",
    startDate: "2026-01-05",
  },
  campaignBudget: {
    resourceName: "customers/1234567890/campaignBudgets/9",
    amountMicros: "5000000",
  },
  metrics: { clicks: "130", impressions: "4021", costMicros: "1234560" },
  segments: { date: "2026-10-02" },
};

test("toRow flattens a nested result into the configured columns", () => {
  const cols = columnsFor({
    resource: "Campaigns",
    metrics: ["clicks", "impressions", "cost"],
    segments: ["date"],
  });
  const row = fl.toRow(RESULT, cols, RESOURCES.Campaigns, ["date"]);
  assert.equal(row.campaign_id, 55);
  assert.equal(row.campaign_name, "Promo");
  assert.equal(row.status, "ENABLED");
  assert.equal(row.clicks, 130);
  assert.equal(row.impressions, 4021);
  assert.equal(row.cost, 1.23456);
  assert.equal(row.budget, 5);
  assert.equal(row.resource_name, "customers/1234567890/campaigns/55");
  assert.ok(row.date instanceof Date);
  // a column with nothing behind it is still present
  assert.strictEqual(row.channel_type, null);
});

test("every configured column appears in the row, and nothing else", () => {
  const cols = columnsFor({ resource: "Accounts", metrics: [], segments: [] });
  const row = fl.toRow({ customer: { id: "1", manager: false } }, cols, RESOURCES.Accounts);
  assert.deepEqual(Object.keys(row).sort(), cols.map((c) => c.col).sort());
});

test("the row key is the resource name when nothing is segmented", () => {
  const cols = columnsFor({ resource: "Campaigns" });
  const row = fl.toRow(RESULT, cols, RESOURCES.Campaigns, []);
  assert.equal(row.row_key, "customers/1234567890/campaigns/55");
});

test("segmenting appends the segment values, so rows stay distinct", () => {
  // the same campaign on two days must not collide, or a sync overwrites one
  const cols = columnsFor({ resource: "Campaigns", segments: ["date"] });
  const a = fl.toRow(RESULT, cols, RESOURCES.Campaigns, ["date"]);
  const b = fl.toRow(
    { ...RESULT, segments: { date: "2026-10-03" } },
    cols,
    RESOURCES.Campaigns,
    ["date"],
  );
  assert.equal(a.row_key, "customers/1234567890/campaigns/55|2026-10-02");
  assert.notEqual(a.row_key, b.row_key);
});

test("two segments both contribute to the key", () => {
  const cols = columnsFor({ resource: "Campaigns", segments: ["date", "device"] });
  const row = fl.toRow(
    { ...RESULT, segments: { date: "2026-10-02", device: "MOBILE" } },
    cols,
    RESOURCES.Campaigns,
    ["date", "device"],
  );
  assert.equal(row.row_key, "customers/1234567890/campaigns/55|2026-10-02|MOBILE");
});

test("a missing segment value still yields a key of the right shape", () => {
  const cols = columnsFor({ resource: "Campaigns", segments: ["date"] });
  const row = fl.toRow({ campaign: { resourceName: "x" } }, cols, RESOURCES.Campaigns, ["date"]);
  assert.equal(row.row_key, "x|");
});

test("syntheticKey is stable for equal results and differs for unequal ones", () => {
  const a = fl.syntheticKey({ x: 1, y: [2, 3] });
  assert.equal(a, fl.syntheticKey({ x: 1, y: [2, 3] }));
  assert.notEqual(a, fl.syntheticKey({ x: 1, y: [2, 4] }));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(typeof fl.syntheticKey(undefined), "string");
});

test("columnsForQuery types columns from the field catalogue", () => {
  const cols = fl.columnsForQuery(
    ["campaign.id", "campaign.name", "segments.date", "customer.manager"],
    [
      { name: "campaign.id", dataType: "INT64" },
      { name: "campaign.name", dataType: "STRING" },
      { name: "segments.date", dataType: "DATE" },
      { name: "customer.manager", dataType: "BOOLEAN" },
    ],
  );
  assert.deepEqual(cols.map((c) => c.type), ["int", "string", "date", "bool"]);
  assert.deepEqual(cols.map((c) => c.col), [
    "campaign_id",
    "campaign_name",
    "segments_date",
    "customer_manager",
  ]);
});

test("a money field is recognised by its name, not the catalogue", () => {
  // the catalogue calls it INT64; only the _micros suffix says it is money
  const [col] = fl.columnsForQuery(
    ["metrics.cost_micros"],
    [{ name: "metrics.cost_micros", dataType: "INT64" }],
  );
  assert.equal(col.type, "micros");
});

test("without a catalogue every column is a string, which always renders", () => {
  const cols = fl.columnsForQuery(["campaign.id", "campaign.name"]);
  assert.deepEqual(cols.map((c) => c.type), ["string", "string"]);
});

test("catalogue flags that restrict a column are carried over", () => {
  const [rep, unfilt] = fl.columnsForQuery(
    ["ad.final_urls", "x.y"],
    [
      { name: "ad.final_urls", dataType: "STRING", isRepeated: true },
      { name: "x.y", dataType: "STRING", filterable: false, sortable: false },
    ],
  );
  assert.equal(rep.repeated, true);
  assert.equal(rep.filterable, false);
  assert.equal(unfilt.filterable, false);
  assert.equal(unfilt.sortable, false);
});

test("an unrecognised data type falls back to a string", () => {
  const [col] = fl.columnsForQuery(["a.b"], [{ name: "a.b", dataType: "SOMETHING_NEW" }]);
  assert.equal(col.type, "string");
});

// campaign.start_date and campaign.end_date were removed in Google Ads API
// v23 and replaced by start_date_time / end_date_time. Selecting the old
// names fails the whole query with UNRECOGNIZED_FIELD, so every Campaigns
// table was unusable while the Accounts table worked.
test("the campaign date columns use the fields that still exist", () => {
  const cols = columnsFor({ resource: "Campaigns", metrics: [], segments: [] });
  const byCol = Object.fromEntries(cols.map((c) => [c.col, c]));
  assert.equal(byCol.start_date.gaql, "campaign.start_date_time");
  assert.equal(byCol.end_date.gaql, "campaign.end_date_time");

  const sent = cols.map((c) => c.gaql);
  assert.ok(!sent.includes("campaign.start_date"));
  assert.ok(!sent.includes("campaign.end_date"));

  // the column names are what a table's fields are built from, so they stay
  // put: renaming them would orphan the fields on tables already created
  assert.equal(byCol.start_date.label, "Start date");
  assert.equal(byCol.end_date.label, "End date");
});

test("a date-time value keeps its time instead of parsing to null", () => {
  // the strict date-only parser returned null for "2026-10-30 00:00:00",
  // which would have emptied the column rather than failing loudly
  const d = fl.fromDateOnly("2026-10-30 00:00:00");
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 30);
  assert.equal(d.getHours(), 0);

  const t = fl.fromDateOnly("2026-10-30 14:35:09");
  assert.equal(t.getHours(), 14);
  assert.equal(t.getMinutes(), 35);
  assert.equal(t.getSeconds(), 9);

  // the plain date form still works, and still at local midnight
  const p = fl.fromDateOnly("2026-10-30");
  assert.equal(p.getHours(), 0);
  assert.equal(p.getDate(), 30);

  assert.equal(fl.fromDateOnly("not a date"), null);
});
