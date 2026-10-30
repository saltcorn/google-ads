const test = require("node:test");
const assert = require("node:assert");
const g = require("../lib/gaql");

const COLS = {
  campaign_id: { gaql: "campaign.id", type: "int" },
  campaign_name: { gaql: "campaign.name", type: "string" },
  status: { gaql: "campaign.status", type: "enum" },
  cost: { gaql: "metrics.cost_micros", type: "micros" },
  clicks: { gaql: "metrics.clicks", type: "int" },
  ctr: { gaql: "metrics.ctr", type: "float" },
  date: { gaql: "segments.date", type: "date" },
  manager: { gaql: "customer.manager", type: "bool" },
  final_urls: { gaql: "ad.final_urls", type: "string", filterable: false },
};

test("quote escapes backslashes before quotes, not after", () => {
  assert.equal(g.quote("plain"), "'plain'");
  assert.equal(g.quote("O'Brien"), "'O\\'Brien'");
  assert.equal(g.quote("a\\b"), "'a\\\\b'");
  // a backslash followed by a quote must not become an escaped quote
  assert.equal(g.quote("a\\'b"), "'a\\\\\\'b'");
});

test("literal renders each type the way GAQL wants it", () => {
  assert.equal(g.literal("ENABLED", "enum"), "'ENABLED'");
  assert.equal(g.literal(55, "int"), "55");
  assert.equal(g.literal("55", "int"), "55");
  assert.equal(g.literal(0.05, "float"), "0.05");
  assert.equal(g.literal(true, "bool"), "TRUE");
  assert.equal(g.literal(false, "bool"), "FALSE");
  assert.equal(g.literal("2026-03-01", "date"), "'2026-03-01'");
  assert.equal(g.literal(null, "int"), null);
  assert.equal(g.literal("not a number", "int"), null);
});

test("a money literal is converted to micros", () => {
  // the column is currency, the field is micros; 12.5 must not be sent as 12.5
  assert.equal(g.literal(12.5, "micros"), "12500000");
  assert.equal(g.literal(0, "micros"), "0");
  assert.equal(g.literal(0.000001, "micros"), "1");
  // rounded, not truncated: a half-micro cannot be sent
  assert.equal(g.literal(1.0000005, "micros"), "1000001");
});

test("toDateOnly keeps a date string and reads a Date in local terms", () => {
  assert.equal(g.toDateOnly("2026-03-01"), "2026-03-01");
  assert.equal(g.toDateOnly(new Date(2026, 2, 1, 23, 30)), "2026-03-01");
  assert.equal(g.toDateOnly(new Date(2026, 2, 1, 0, 15)), "2026-03-01");
  assert.equal(g.toDateOnly(""), null);
  assert.equal(g.toDateOnly("rubbish"), null);
});

test("a scalar equality pushes down", () => {
  const { conditions, residual } = g.pushdown({ status: "ENABLED" }, COLS);
  assert.deepEqual(conditions, ["campaign.status = 'ENABLED'"]);
  assert.deepEqual(residual, {});
});

test("in becomes IN, and an empty one is left to the local pass", () => {
  assert.deepEqual(
    g.pushdown({ status: { in: ["ENABLED", "PAUSED"] } }, COLS).conditions,
    ["campaign.status IN ('ENABLED', 'PAUSED')"],
  );
  const empty = g.pushdown({ status: { in: [] } }, COLS);
  assert.deepEqual(empty.conditions, []);
  assert.deepEqual(empty.residual, { status: { in: [] } });
});

test("an IN with an unexpressible member is not narrowed", () => {
  // pushing IN (55) while the filter also allows "abc" would lose rows
  const r = g.pushdown({ campaign_id: { in: [55, "abc"] } }, COLS);
  assert.deepEqual(r.conditions, []);
  assert.ok("campaign_id" in r.residual);
});

test("ranges push down, with equal choosing the inclusive operator", () => {
  assert.deepEqual(g.pushdown({ clicks: { gt: 10 } }, COLS).conditions, [
    "metrics.clicks > 10",
  ]);
  assert.deepEqual(g.pushdown({ clicks: { gt: 10, equal: true } }, COLS).conditions, [
    "metrics.clicks >= 10",
  ]);
  assert.deepEqual(g.pushdown({ clicks: { lt: 99 } }, COLS).conditions, [
    "metrics.clicks < 99",
  ]);
  assert.deepEqual(g.pushdown({ clicks: { lt: 99, equal: true } }, COLS).conditions, [
    "metrics.clicks <= 99",
  ]);
});

test("both bounds in one object become two conditions", () => {
  const { conditions, residual } = g.pushdown({ clicks: { gt: 1, lt: 9 } }, COLS);
  assert.deepEqual(conditions, ["metrics.clicks < 9", "metrics.clicks > 1"]);
  assert.deepEqual(residual, {});
});

test("a money range is converted, so the comparison is in the right unit", () => {
  assert.deepEqual(g.pushdown({ cost: { gt: 12.5 } }, COLS).conditions, [
    "metrics.cost_micros > 12500000",
  ]);
});

test("an array of bounds - what a filter view sends - pushes each", () => {
  const { conditions, residual } = g.pushdown(
    { date: [{ gt: "2026-01-01", equal: true }, { lt: "2026-02-01" }] },
    COLS,
  );
  assert.deepEqual(conditions, [
    "segments.date >= '2026-01-01'",
    "segments.date < '2026-02-01'",
  ]);
  assert.deepEqual(residual, {});
});

test("null becomes IS NULL", () => {
  assert.deepEqual(g.pushdown({ campaign_name: null }, COLS).conditions, [
    "campaign.name IS NULL",
  ]);
});

test("or is never pushed down - GAQL has no OR", () => {
  const where = { or: [{ status: "ENABLED" }, { status: "PAUSED" }] };
  const r = g.pushdown(where, COLS);
  assert.deepEqual(r.conditions, []);
  assert.deepEqual(r.residual, where);
});

test("a top-level conjunct beside an or still pushes down", () => {
  // A AND (B OR C): A is safe to send, the disjunction is not
  const r = g.pushdown(
    { clicks: { gt: 5 }, or: [{ status: "ENABLED" }, { status: "PAUSED" }] },
    COLS,
  );
  assert.deepEqual(r.conditions, ["metrics.clicks > 5"]);
  assert.deepEqual(Object.keys(r.residual), ["or"]);
});

test("ilike is not pushed down, because GAQL's LIKE is case-sensitive", () => {
  // Sending LIKE would drop rows the local case-insensitive check matches,
  // which is a narrowing and breaks the widen-only contract.
  const r = g.pushdown({ campaign_name: { ilike: "promo" } }, COLS);
  assert.deepEqual(r.conditions, []);
  assert.deepEqual(r.residual, { campaign_name: { ilike: "promo" } });
});

test("not, _fts and unknown columns go to the residual", () => {
  const where = {
    not: { status: "REMOVED" },
    _fts: { searchTerm: "x" },
    nonsense: 1,
  };
  const r = g.pushdown(where, COLS);
  assert.deepEqual(r.conditions, []);
  assert.deepEqual(r.residual, where);
});

test("a column marked unfilterable is left alone", () => {
  const r = g.pushdown({ final_urls: "x" }, COLS);
  assert.deepEqual(r.conditions, []);
  assert.deepEqual(r.residual, { final_urls: "x" });
});

test("a pushed condition is dropped from the residual, an unpushed one is not", () => {
  const r = g.pushdown({ status: "ENABLED", campaign_name: { ilike: "a" } }, COLS);
  assert.deepEqual(r.conditions, ["campaign.status = 'ENABLED'"]);
  assert.deepEqual(Object.keys(r.residual), ["campaign_name"]);
});

test("a Date value on a date column is rendered as a floating date", () => {
  assert.deepEqual(g.pushdown({ date: new Date(2026, 9, 2, 23, 0) }, COLS).conditions, [
    "segments.date = '2026-10-02'",
  ]);
});

test("buildQuery assembles the clauses in order", () => {
  assert.equal(
    g.buildQuery({
      select: ["campaign.id", "metrics.clicks"],
      from: "campaign",
      where: ["campaign.status = 'ENABLED'", "metrics.clicks > 5"],
      orderBy: "metrics.clicks",
      orderDesc: true,
      limit: 25,
    }),
    "SELECT campaign.id, metrics.clicks FROM campaign WHERE " +
      "campaign.status = 'ENABLED' AND metrics.clicks > 5 " +
      "ORDER BY metrics.clicks DESC LIMIT 25",
  );
});

test("buildQuery omits the clauses it was given nothing for", () => {
  assert.equal(
    g.buildQuery({ select: ["campaign.id"], from: "campaign" }),
    "SELECT campaign.id FROM campaign",
  );
  assert.match(
    g.buildQuery({ select: ["a.b"], from: "c", orderBy: "a.b" }),
    /ORDER BY a\.b ASC$/,
  );
});

test("buildQuery refuses a query that cannot run", () => {
  assert.throws(() => g.buildQuery({ select: [], from: "campaign" }), /at least one field/);
  assert.throws(() => g.buildQuery({ select: ["a.b"] }), /FROM resource/);
});

test("a fractional limit is floored, not interpolated raw", () => {
  assert.match(g.buildQuery({ select: ["a.b"], from: "c", limit: 10.7 }), /LIMIT 10$/);
});

test("dateWindow is inclusive at both ends, and empty when unusable", () => {
  assert.deepEqual(g.dateWindow("2026-01-01", "2026-01-31"), [
    "segments.date BETWEEN '2026-01-01' AND '2026-01-31'",
  ]);
  assert.deepEqual(g.dateWindow("rubbish", "2026-01-31"), []);
  assert.deepEqual(g.dateWindow(null, null), []);
});

test("relativeWindow ends today and spans the days asked for", () => {
  const { from, to } = g.relativeWindow(7);
  assert.match(from, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(to, g.toDateOnly(new Date()));
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  assert.equal(days, 7);
  // a negative count is read as a magnitude, never a window into the future
  assert.equal(g.relativeWindow(-7).from, from);
});

test("selectedFields reads the SELECT list and ignores anything odd", () => {
  assert.deepEqual(
    g.selectedFields(
      "SELECT campaign.id,  metrics.cost_micros ,\n segments.date FROM campaign WHERE x = 1",
    ),
    ["campaign.id", "metrics.cost_micros", "segments.date"],
  );
  // a bare word is not a field name, and neither is an expression
  assert.deepEqual(g.selectedFields("SELECT campaign, 1+1 FROM campaign"), []);
  assert.deepEqual(g.selectedFields("not a query"), []);
  assert.deepEqual(g.selectedFields(""), []);
  assert.deepEqual(g.selectedFields(null), []);
});

test("selectedFrom and hasLimit read the other clauses", () => {
  assert.equal(g.selectedFrom("select a.b from ad_group_ad where x"), "ad_group_ad");
  assert.equal(g.selectedFrom("SELECT a.b FROM campaign"), "campaign");
  assert.equal(g.selectedFrom("SELECT campaign.id"), null);
  assert.equal(g.selectedFrom(""), null);
  assert.ok(g.hasLimit("SELECT a.b FROM c LIMIT 10"));
  assert.ok(g.hasLimit("select a.b from c limit 1"));
  assert.ok(!g.hasLimit("SELECT a.b FROM c"));
});
