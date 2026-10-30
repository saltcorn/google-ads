/**
 * Evaluating a Saltcorn `where` locally, and ordering and paging the result.
 *
 * The provider sets `disableFiltering`, so core does no filtering, ordering or
 * paging of its own - GAQL takes what it can (see gaql.js) and whatever is
 * left is checked here. Core's own fallback could not be used: its `ilike` is
 * a case-sensitive `includes`, and its comparator is `a.x-b.x`, which returns
 * NaN for every string column.
 */

/** Compare two cell values of any type, nulls last. */
const cmp = (a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean")
    return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
};

const numeric = (v) => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const d = new Date(v);
  if (!isNaN(d.getTime())) return d.getTime();
  return Number(v);
};

/**
 * Does `row` satisfy one `key: value` condition?
 *
 * Supports the operators core's external-table fallback supports - equality,
 * `in`, `or`, `not`, `ilike`, `lt`/`gt` with optional `equal`, arrays of
 * conditions and null tests. Anything else throws: a view filtering a Google
 * Ads table through `inSelect` is a misconfiguration, and an error that names
 * the operator beats a view that silently renders no rows.
 */
const satisfies = (row, key, val) => {
  if (key === "or" && Array.isArray(val))
    return val.some((sub) => matches(row, sub));
  if (key === "not" && val && typeof val === "object")
    return !matches(row, val);
  if (Array.isArray(val)) return val.every((v) => satisfies(row, key, v));

  const cell = row[key];
  if (val === null) return cell === null || cell === undefined;
  if (val instanceof Date) return numeric(cell) === val.getTime();

  if (val && typeof val === "object") {
    if ("in" in val) return (val.in || []).some((v) => cell == v);
    if ("ilike" in val)
      return String(cell ?? "")
        .toLowerCase()
        .includes(String(val.ilike ?? "").toLowerCase());
    if ("lt" in val || "gt" in val) {
      // both bounds may arrive in one object; each must hold
      const l = numeric(cell);
      if ("lt" in val) {
        const r = numeric(val.lt);
        if (!(val.equal ? l <= r : l < r)) return false;
      }
      if ("gt" in val) {
        const r = numeric(val.gt);
        if (!(val.equal ? l >= r : l > r)) return false;
      }
      return true;
    }
    const op = Object.keys(val)[0];
    throw new Error(
      `google-ads: the "${op}" filter is not supported against the Google ` +
        `Ads API. GAQL has no OR and no parentheses in WHERE. Sync this ` +
        `table into a local one and filter that instead.`,
    );
  }
  if (cell instanceof Date) return cell.getTime() === numeric(val);
  return cell == val;
};

/**
 * Evaluate a whole where-object against a row.
 *
 * @param {object} row - a flattened row
 * @param {object} where - a Saltcorn where-object
 * @returns {boolean} true when every condition holds
 */
const matches = (row, where = {}) =>
  Object.entries(where).every(([k, v]) => satisfies(row, k, v));

/**
 * Filter, sort and page rows locally.
 *
 * @param {object[]} rows - rows fetched from the API
 * @param {object} where - the residual where-object
 * @param {object} [selopts] - { orderBy, orderDesc, limit, offset }
 * @returns {object[]} the rows core asked for
 */
const applyLocal = (rows, where = {}, selopts = {}) => {
  const out = rows.filter((r) => matches(r, where));
  if (selopts.orderBy && typeof selopts.orderBy === "string") {
    const key = selopts.orderBy;
    out.sort((a, b) =>
      selopts.orderDesc ? cmp(b[key], a[key]) : cmp(a[key], b[key]),
    );
  }
  const offset = selopts.offset || 0;
  if (selopts.limit) return out.slice(offset, offset + selopts.limit);
  return offset ? out.slice(offset) : out;
};

module.exports = { matches, satisfies, cmp, numeric, applyLocal };
