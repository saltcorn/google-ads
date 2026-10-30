/**
 * Turning a Google Ads result object into a flat Saltcorn row.
 *
 * Two things make this more than a property copy. GAQL names fields in
 * snake_case (`metrics.cost_micros`) while the JSON reply uses lowerCamelCase
 * (`metrics.costMicros`), so every path has to be converted. And proto3 JSON
 * sends 64-bit integers as *strings*, so an unconverted `impressions` sorts
 * and sums as text.
 */

const crypto = require("crypto");
const { SEGMENTS } = require("./resources");

/** snake_case to lowerCamelCase, for one path segment. */
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** The JSON path for a GAQL field name. */
const jsonPath = (gaql) => String(gaql).split(".").map(camel);

/** Read a dotted path, yielding undefined rather than throwing. */
const at = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * A floating YYYY-MM-DD, with an optional HH:mm:ss, as a *local* Date.
 *
 * Local, not UTC: segments.date is a date in the account's time zone with no
 * instant behind it, and parsing it as UTC puts it on the wrong day for
 * anyone west of Greenwich.
 *
 * The time half is for campaign.start_date_time and its end counterpart,
 * which replaced campaign.start_date and campaign.end_date in API v23 and
 * arrive as "2026-10-30 00:00:00" - the same wall-clock reading in the
 * account's zone, with a time Google sets to midnight except on the campaign
 * types that support finer granularity.
 */
const fromDateOnly = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    String(ymd),
  );
  if (!m) return null;
  return new Date(
    +m[1],
    +m[2] - 1,
    +m[3],
    +(m[4] || 0),
    +(m[5] || 0),
    +(m[6] || 0),
  );
};

/**
 * One raw API value as the column's type.
 *
 * @param {*} v - the value from the reply
 * @param {object} col - the column definition
 * @returns {*} the Saltcorn cell value
 */
const convert = (v, col) => {
  if (v === undefined || v === null) return null;
  if (col.repeated)
    return (Array.isArray(v) ? v : [v]).map(String).join(", ") || null;
  switch (col.type) {
    case "int": {
      // int64 arrives as a string
      const n = Number(v);
      return isNaN(n) ? null : Math.trunc(n);
    }
    case "float": {
      const n = Number(v);
      return isNaN(n) ? null : n;
    }
    case "micros": {
      const n = Number(v);
      return isNaN(n) ? null : n / 1e6;
    }
    case "bool":
      return !!v;
    case "date":
    case "datetime":
      return fromDateOnly(v);
    default:
      return typeof v === "object" ? JSON.stringify(v) : v;
  }
};

/**
 * The synthesised primary key for a row.
 *
 * The resource name alone is not unique once a query segments by date or
 * device, because the same resource then yields one row per segment value.
 * Appending the segment values is what makes the key stable across two runs
 * of a sync, which is all `sync_table_from_external` needs of it.
 *
 * @param {object} result - one raw API result
 * @param {object} res - the resource definition
 * @param {string[]} segments - the segment column names in use
 * @returns {string} the key
 */
const rowKey = (result, res, segments = []) => {
  const base =
    at(result, jsonPath(res.resourceNameField)) ||
    // A query with no resource name selected still needs a key; the segment
    // values alone identify the row in that case.
    "row";
  const parts = segments
    .map((s) => SEGMENTS[s])
    .filter(Boolean)
    .map((c) => {
      const v = at(result, jsonPath(c.gaql));
      return v === undefined || v === null ? "" : String(v);
    });
  return [base, ...parts].join("|");
};

/**
 * Flatten one API result into a row.
 *
 * @param {object} result - one entry of the `results` array
 * @param {object[]} columns - column definitions from columnsFor
 * @param {object} res - the resource definition
 * @param {string[]} [segments] - the segment column names in use
 * @returns {object} a flat row
 */
const toRow = (result, columns, res, segments = []) => {
  const row = {};
  for (const col of columns) {
    if (col.synthetic) continue;
    row[col.col] = convert(at(result, jsonPath(col.gaql)), col);
  }
  row.row_key = rowKey(result, res, segments);
  return row;
};

/**
 * Column definitions for a hand-written query, typed from field metadata.
 *
 * GoogleAdsField reports a `dataType` such as INT64 or ENUM; anything not
 * recognised is exposed as a string, which always renders.
 *
 * @param {string[]} names - the GAQL field names the query selects
 * @param {object[]} [meta] - GoogleAdsField rows, when they could be fetched
 * @returns {object[]} column definitions
 */
const columnsForQuery = (names, meta = []) => {
  const byName = {};
  for (const m of meta) if (m && m.name) byName[m.name] = m;
  const KIND = {
    INT32: "int",
    INT64: "int",
    UINT64: "int",
    DOUBLE: "float",
    FLOAT: "float",
    BOOLEAN: "bool",
    DATE: "date",
    DATE_TIME: "datetime",
    ENUM: "enum",
    STRING: "string",
    RESOURCE_NAME: "string",
    MESSAGE: "string",
  };
  return names.map((name) => {
    const m = byName[name] || {};
    // A money field is an int64 in micros; its name is the only thing that
    // says so, which is also how Google's own report UIs decide.
    const micros = /_micros$/.test(name);
    const type = micros ? "micros" : KIND[m.dataType] || "string";
    return {
      col: name.replace(/\./g, "_"),
      gaql: name,
      type,
      label: name,
      ...(m.isRepeated ? { repeated: true, filterable: false, sortable: false } : {}),
      ...(m.filterable === false ? { filterable: false } : {}),
      ...(m.sortable === false ? { sortable: false } : {}),
    };
  });
};

/**
 * A key for a row whose resource name was not selected.
 *
 * A hand-written query need not select a resource name at all, which leaves
 * nothing to identify the row by. Hashing the row's own values gives a key
 * that is at least stable across runs for as long as the values are, which is
 * the most that can be said for an arbitrary projection.
 *
 * @param {object} result - one raw API result
 * @returns {string} a short stable key
 */
const syntheticKey = (result) =>
  crypto
    .createHash("sha1")
    .update(JSON.stringify(result ?? null))
    .digest("hex")
    .slice(0, 16);

module.exports = {
  syntheticKey,
  camel,
  jsonPath,
  at,
  fromDateOnly,
  convert,
  rowKey,
  toRow,
  columnsForQuery,
};
