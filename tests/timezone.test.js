const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * Zones chosen to straddle UTC midnight in both directions: New York is behind
 * it, Kiritimati is 14 hours ahead, Kolkata is offset by half an hour, and
 * Santiago changes offset over the year.
 */
const ZONES = [
  "UTC",
  "America/New_York",
  "Asia/Kolkata",
  "Pacific/Kiritimati",
  "America/Santiago",
];

const LIB = (name) => JSON.stringify(path.join(__dirname, "..", "lib", name));

/** Run a snippet in a child process under a given TZ and parse its JSON. */
const underTZ = (tz, snippet) => {
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      `const gaql=require(${LIB("gaql.js")});const fields=require(${LIB("fields.js")});${snippet}`,
    ],
    { env: { ...process.env, TZ: tz }, encoding: "utf8" },
  );
  return JSON.parse(out);
};

test("a segments.date read from Google survives the round trip in any zone", () => {
  for (const tz of ZONES) {
    const got = underTZ(
      tz,
      `const d = fields.convert("2026-12-25", {type:"date"});
       console.log(JSON.stringify({back: gaql.toDateOnly(d), day: d.getDate(), month: d.getMonth()+1}));`,
    );
    assert.equal(got.back, "2026-12-25", `round trip drifted in ${tz}`);
    assert.equal(got.day, 25, `day drifted in ${tz}`);
    assert.equal(got.month, 12, `month drifted in ${tz}`);
  }
});

test("a late-evening local time keeps its own calendar day in a filter", () => {
  // The bug this guards: deriving the date with toISOString() pushed an
  // evening in a behind-UTC zone onto the next day, so a filter asked Google
  // for the wrong day's metrics.
  for (const tz of ZONES) {
    const got = underTZ(
      tz,
      `console.log(JSON.stringify({d: gaql.toDateOnly(new Date(2026,8,28,23,30))}));`,
    );
    assert.equal(got.d, "2026-09-28", `evening drifted in ${tz}`);
  }
});

test("an early-morning local time keeps its own calendar day", () => {
  // The mirror image, which bit ahead-of-UTC zones.
  for (const tz of ZONES) {
    const got = underTZ(
      tz,
      `console.log(JSON.stringify({d: gaql.toDateOnly(new Date(2026,8,28,0,15))}));`,
    );
    assert.equal(got.d, "2026-09-28", `morning drifted in ${tz}`);
  }
});

test("a pushed date filter names the same day in every zone", () => {
  const seen = new Set();
  for (const tz of ZONES) {
    const got = underTZ(
      tz,
      `const cols={date:{gaql:"segments.date",type:"date"}};
       const r = gaql.pushdown({date:new Date(2026,11,31,22,0)}, cols);
       console.log(JSON.stringify({c: r.conditions}));`,
    );
    seen.add(got.c.join("|"));
  }
  assert.deepEqual([...seen], ["segments.date = '2026-12-31'"]);
});

test("a year-end window does not roll over in an ahead-of-UTC zone", () => {
  for (const tz of ZONES) {
    const got = underTZ(
      tz,
      `console.log(JSON.stringify({w: gaql.dateWindow(new Date(2026,11,31,20,0), new Date(2026,11,31,23,0))}));`,
    );
    assert.deepEqual(
      got.w,
      ["segments.date BETWEEN '2026-12-31' AND '2026-12-31'"],
      `window drifted in ${tz}`,
    );
  }
});

test("the row key for a segmented row is the same date in every zone", () => {
  const seen = new Set();
  for (const tz of ZONES) {
    const got = underTZ(
      tz,
      `const {RESOURCES, columnsFor} = require(${LIB("resources.js")});
       const cols = columnsFor({resource:"Campaigns", segments:["date"]});
       const row = fields.toRow({campaign:{resourceName:"customers/1/campaigns/5"},segments:{date:"2026-12-25"}}, cols, RESOURCES.Campaigns, ["date"]);
       console.log(JSON.stringify({k: row.row_key}));`,
    );
    seen.add(got.k);
  }
  // A key that varied by viewer zone would make a sync insert duplicates.
  assert.deepEqual([...seen], ["customers/1/campaigns/5|2026-12-25"]);
});

/**
 * The account's zone, not the server's.
 *
 * segments.date is a calendar date in the Google Ads account's own time zone,
 * which is fixed at account creation. Saltcorn usually runs elsewhere, so for
 * part of every day the two disagree about what "today" is.
 */
test("the report window follows the account's zone, not the server's", () => {
  // 23:30 UTC: already tomorrow in Kigali (+02:00), still today in New York
  const at = '"2026-10-28T23:30:00Z"';
  const run = (tz, acct) =>
    underTZ(tz, `console.log(JSON.stringify(
      gaql.relativeWindow(7, ${acct}, new Date(${at}))))`);

  const serverUTC = run("UTC", "null");
  assert.deepStrictEqual(serverUTC, { from: "2026-10-21", to: "2026-10-28" });

  // same instant, same server, but the account is two hours ahead
  const kigali = run("UTC", '"Africa/Kigali"');
  assert.deepStrictEqual(kigali, { from: "2026-10-22", to: "2026-10-29" });

  // and the account's own date is reported whatever the server is set to
  for (const tz of ZONES)
    assert.deepStrictEqual(
      run(tz, '"Africa/Kigali"'),
      { from: "2026-10-22", to: "2026-10-29" },
      `server in ${tz} must not change the account's window`,
    );
});

test("a zone behind the server is also respected", () => {
  const at = '"2026-10-29T01:30:00Z"'; // 29th in UTC, still the 28th in NY
  for (const tz of ZONES)
    assert.deepStrictEqual(
      underTZ(tz, `console.log(JSON.stringify(
        gaql.relativeWindow(3, "America/New_York", new Date(${at}))))`),
      { from: "2026-10-25", to: "2026-10-28" },
      `server in ${tz}`,
    );
});

test("an unusable zone falls back instead of taking the table down", () => {
  // a misspelled zone must not throw out of a provider read
  for (const bad of ['"Not/AZone"', '""', "null", "undefined"]) {
    const got = underTZ("UTC", `console.log(JSON.stringify(
      gaql.relativeWindow(7, ${bad}, new Date("2026-10-28T23:30:00Z"))))`);
    assert.deepStrictEqual(got, { from: "2026-10-21", to: "2026-10-28" }, bad);
  }
});

test("the window is whole calendar days, across a DST transition", () => {
  // Santiago shifts offset in the window; the span must stay exactly 7 days
  const got = underTZ("America/Santiago", `console.log(JSON.stringify(
    gaql.relativeWindow(7, "America/Santiago", new Date("2026-09-10T12:00:00Z"))))`);
  const days =
    (Date.parse(got.to + "T00:00:00Z") - Date.parse(got.from + "T00:00:00Z")) /
    86400000;
  assert.strictEqual(days, 7);
});

test("shiftDateOnly is pure calendar arithmetic in every server zone", () => {
  for (const tz of ZONES) {
    assert.strictEqual(
      underTZ(tz, `console.log(JSON.stringify(gaql.shiftDateOnly("2026-03-01", -1)))`),
      "2026-02-28",
      `server in ${tz}`,
    );
    assert.strictEqual(
      underTZ(tz, `console.log(JSON.stringify(gaql.shiftDateOnly("2024-03-01", -1)))`),
      "2024-02-29", // leap year
      `server in ${tz}`,
    );
  }
});
