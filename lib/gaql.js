/**
 * Building GAQL, and translating a Saltcorn `where` into its WHERE clause.
 *
 * GAQL is SQL-shaped, so far more of a Saltcorn filter pushes down here than
 * against a REST API - but it is not SQL, and three limits drive this module:
 *
 *   - WHERE is a conjunction only. There is no OR and no parenthesis, so an
 *     `or` cannot be expressed at all and has to be checked locally.
 *   - There is no OFFSET. Paging is by opaque page token, so an offset is
 *     folded into the LIMIT and the head is dropped locally.
 *   - Money is in micros. A filter written against the currency column has to
 *     be converted before it is sent, or it compares 12.5 against 12500000.
 *
 * The contract for pushdown, as elsewhere: conditions sent to Google must only
 * ever *widen* the result set. Everything is re-checked locally, so a superset
 * is safe and a subset silently loses rows.
 */

/** A GAQL string literal. Single-quoted, with backslashes and quotes escaped. */
const quote = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** A date as GAQL writes one: a floating YYYY-MM-DD in the account's zone. */
const toDateOnly = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  // Local, not UTC: a Date holding local wall-clock midnight would otherwise
  // land on the previous day for anyone west of Greenwich.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * A Saltcorn cell value as the GAQL literal for a column of that type.
 *
 * @param {*} v - the value from the where-clause
 * @param {string} type - the column's conversion kind
 * @returns {string|null} a GAQL literal, or null when it cannot be expressed
 */
const literal = (v, type) => {
  if (v === null || v === undefined) return null;
  switch (type) {
    case "date":
      {
        const d = toDateOnly(v);
        return d === null ? null : quote(d);
      }
    case "micros":
      {
        // the column is currency; the field is micros
        const n = Number(v);
        return isNaN(n) ? null : String(Math.round(n * 1e6));
      }
    case "int":
    case "float":
      {
        const n = Number(v);
        return isNaN(n) ? null : String(n);
      }
    case "bool":
      return v ? "TRUE" : "FALSE";
    default:
      return quote(v);
  }
};

/** Is this a plain scalar, rather than an operator object? */
const isScalar = (v) =>
  v === null ||
  v instanceof Date ||
  ["string", "number", "boolean"].includes(typeof v);

/**
 * Translate one `key: value` condition into GAQL conditions.
 *
 * @param {object} col - the column definition { gaql, type, filterable }
 * @param {*} val - the where-clause value for it
 * @returns {object} { conditions, complete } - complete is false when some of
 *   the condition could not be expressed and must still be checked locally
 */
const conditionsFor = (col, val) => {
  const f = col.gaql;
  const out = [];
  let complete = true;
  const lit = (v) => literal(v, col.type);

  const one = (v) => {
    if (v === null) {
      out.push(`${f} IS NULL`);
      return;
    }
    if (isScalar(v)) {
      const l = lit(v);
      if (l === null) complete = false;
      else out.push(`${f} = ${l}`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(one);
      return;
    }
    if (v && typeof v === "object") {
      if ("in" in v) {
        const vals = (v.in || []).map(lit);
        // An empty IN () is a syntax error, and an unexpressible member would
        // narrow the set - either way, leave it to the local check.
        if (!vals.length || vals.some((x) => x === null)) complete = false;
        else out.push(`${f} IN (${vals.join(", ")})`);
        return;
      }
      if ("lt" in v || "gt" in v) {
        if ("lt" in v) {
          const l = lit(v.lt);
          if (l === null) complete = false;
          else out.push(`${f} ${v.equal ? "<=" : "<"} ${l}`);
        }
        if ("gt" in v) {
          const l = lit(v.gt);
          if (l === null) complete = false;
          else out.push(`${f} ${v.equal ? ">=" : ">"} ${l}`);
        }
        return;
      }
      // ilike is deliberately not pushed: GAQL's LIKE is case-sensitive, so
      // sending it would drop rows that the local, case-insensitive check
      // matches - a narrowing, which breaks the contract.
      complete = false;
      return;
    }
    complete = false;
  };

  one(val);
  return { conditions: out, complete };
};

/**
 * Pick the conditions of a Saltcorn where that GAQL can express.
 *
 * Only top-level conjuncts are considered: a condition inside an `or` does not
 * constrain the result set on its own, so pushing it down would narrow the
 * query below what the `or` actually asks for.
 *
 * @param {object} where - a Saltcorn where-object
 * @param {object} columns - flat column name => { gaql, type, filterable }
 * @returns {object} { conditions, residual }
 */
const pushdown = (where = {}, columns = {}) => {
  const conditions = [];
  const residual = {};

  for (const [key, val] of Object.entries(where)) {
    const col = columns[key];
    // `or` and `not` have no GAQL form; `_fts` is a whole-row text search,
    // which GAQL cannot do either.
    if (!col || col.filterable === false) {
      residual[key] = val;
      continue;
    }
    const { conditions: cs, complete } = conditionsFor(col, val);
    conditions.push(...cs);
    // Re-checked locally either way; kept in the residual only when the
    // pushdown was partial, so the local pass is not asked to redo work the
    // API already did.
    if (!complete) residual[key] = val;
  }

  return { conditions, residual };
};

/**
 * Assemble a GAQL query.
 *
 * @param {object} spec
 * @param {string[]} spec.select - GAQL field names
 * @param {string} spec.from - the resource to select from
 * @param {string[]} [spec.where] - conditions, joined with AND
 * @param {string} [spec.orderBy] - a GAQL field name
 * @param {boolean} [spec.orderDesc]
 * @param {number} [spec.limit]
 * @returns {string} the query
 */
const buildQuery = ({ select, from, where = [], orderBy, orderDesc, limit }) => {
  if (!select || !select.length)
    throw new Error("google-ads: a GAQL query needs at least one field.");
  if (!from) throw new Error("google-ads: a GAQL query needs a FROM resource.");
  const parts = [`SELECT ${select.join(", ")}`, `FROM ${from}`];
  if (where.length) parts.push(`WHERE ${where.join(" AND ")}`);
  if (orderBy) parts.push(`ORDER BY ${orderBy}${orderDesc ? " DESC" : " ASC"}`);
  if (limit) parts.push(`LIMIT ${Math.floor(limit)}`);
  return parts.join(" ");
};

/** A `segments.date` window, inclusive at both ends. */
const dateWindow = (from, to) => {
  const a = toDateOnly(from);
  const b = toDateOnly(to);
  if (!a || !b) return [];
  return [`segments.date BETWEEN ${quote(a)} AND ${quote(b)}`];
};

/** The YYYY-MM-DD `days` either side of today, in local terms. */
/**
 * Today's calendar date in an IANA time zone, as YYYY-MM-DD.
 *
 * segments.date is a date in the Google Ads *account's* time zone, which is
 * fixed when the account is created and can never be changed. Saltcorn
 * usually runs somewhere else - UTC on a deployed server - so for part of
 * every day the server's calendar date and the account's are different days.
 * Building a report window from the server's date then silently drops or adds
 * a day at the edge.
 *
 * @param {string} [tz] - IANA zone, e.g. "Africa/Kigali"; falsy means server local
 * @param {Date} [now] - injectable clock, for tests
 * @returns {string} YYYY-MM-DD
 */
const todayIn = (tz, now = new Date()) => {
  if (!tz) return toDateOnly(now);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const at = (t) => (parts.find((p) => p.type === t) || {}).value;
    const y = at("year");
    const m = at("month");
    const d = at("day");
    if (!y || !m || !d) return toDateOnly(now);
    return `${y}-${m}-${d}`;
  } catch {
    // An unknown or misspelled zone must not take the table down - fall back
    // to the old behaviour rather than throwing out of a provider read.
    return toDateOnly(now);
  }
};

/**
 * Shift a YYYY-MM-DD by whole calendar days.
 *
 * Done in UTC on purpose: the value is a bare calendar date with no instant
 * behind it, so arithmetic must not be able to pick up the server's offset or
 * a daylight-saving transition.
 *
 * @param {string} ymd - YYYY-MM-DD
 * @param {number} days - may be negative
 * @returns {string|null}
 */
const shiftDateOnly = (ymd, days) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/**
 * The default report window, counted back from today in the account's zone.
 *
 * @param {number} days
 * @param {string} [tz] - the account's IANA zone; falsy means server local
 * @param {Date} [now] - injectable clock, for tests
 */
const relativeWindow = (days, tz, now = new Date()) => {
  const to = todayIn(tz, now);
  const back = Math.abs(Number(days) || 0);
  return { from: shiftDateOnly(to, -back), to };
};

/**
 * The SELECT list of a hand-written query, so its columns can be typed.
 *
 * Deliberately narrow: it reads the field list and nothing else, and returns
 * [] rather than guessing when the query is not shaped as expected.
 *
 * @param {string} query - a GAQL query
 * @returns {string[]} the selected field names
 */
const selectedFields = (query) => {
  const m = /\bselect\b([\s\S]*?)\bfrom\b/i.exec(String(query || ""));
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)+$/i.test(s));
};

/** The resource a hand-written query selects from. */
const selectedFrom = (query) => {
  const m = /\bfrom\s+([a-z_][a-z0-9_]*)/i.exec(String(query || ""));
  return m ? m[1] : null;
};

/** Does the query already constrain its own row count? */
const hasLimit = (query) => /\blimit\s+\d+/i.test(String(query || ""));

module.exports = {
  quote,
  literal,
  toDateOnly,
  conditionsFor,
  pushdown,
  buildQuery,
  dateWindow,
  relativeWindow,
  todayIn,
  shiftDateOnly,
  selectedFields,
  selectedFrom,
  hasLimit,
};
