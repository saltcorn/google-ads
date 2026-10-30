const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const api = require("./api");
const { liveCfg, PLUGIN_NAME } = require("./config");
const {
  RESOURCES,
  RESOURCE_NAMES,
  METRICS,
  METRIC_COLS,
  SEGMENTS,
  SEGMENT_COLS,
  SC_TYPE,
  columnsFor,
  columnMap,
  fieldsFor,
} = require("./resources");
const {
  toRow,
  columnsForQuery,
  syntheticKey,
  jsonPath,
  at,
} = require("./fields");
const {
  pushdown,
  buildQuery,
  dateWindow,
  relativeWindow,
  selectedFields,
  selectedFrom,
  hasLimit,
} = require("./gaql");

const { applyLocal } = require("./query");

const CUSTOM = "Custom GAQL";
const DEFAULT_DAYS = 30;

/**
 * The provider configuration in a usable shape.
 *
 * A table's provider_cfg is `null`, not `undefined`, on a provider table that
 * has never been configured - and a default parameter only fires for
 * `undefined`. Table.find builds every provider table up front, so this is
 * reached before anyone has chosen a resource.
 *
 * The metrics and segments arrive as one Bool per option, which is the only
 * multi-valued form control Saltcorn reads back predictably, so they are
 * gathered into lists here.
 */
const normaliseCfg = (cfgTable0) => {
  const c = cfgTable0 || {};
  const days = Number(c.days);
  return {
    ...c,
    custom: c.mode === CUSTOM,
    resource: RESOURCES[c.resource] ? c.resource : RESOURCE_NAMES[0],
    metrics: METRIC_COLS.filter((m) => c[`m_${m}`]),
    segments: SEGMENT_COLS.filter((s) => c[`seg_${s}`]),
    days: days > 0 ? Math.floor(days) : DEFAULT_DAYS,
  };
};

/** The columns a hand-written query was resolved to, as the config stored them. */
const storedQueryColumns = (norm) => {
  try {
    const parsed = JSON.parse(norm.query_columns || "[]");
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch (e) {
    // fall through to re-deriving from the query text
  }
  // The resolve step was skipped or its value was lost; the field names alone
  // still give a table, with every column a string.
  return columnsForQuery(selectedFields(norm.query));
};

/** Every column one table exposes, whichever mode it is in. */
const columnsOf = (norm) =>
  norm.custom ? storedQueryColumns(norm) : columnsFor(norm);

/**
 * Resolve a hand-written query's columns against the field catalogue.
 *
 * @param {string} query - a GAQL query
 * @param {object} [opts] - { cfg, fetchImpl }
 * @returns {Promise<object>} { columns, names, from, error }
 */
const resolveQuery = async (query, opts = {}) => {
  const names = selectedFields(query);
  const from = selectedFrom(query);
  if (!names.length)
    return {
      columns: [],
      names,
      from,
      error:
        "No field names were found. A query looks like: SELECT campaign.id, " +
        "campaign.name FROM campaign",
    };
  let meta = [];
  let error = null;
  try {
    meta = await api.describeFields(names, opts);
  } catch (e) {
    // Types are a convenience; the query still works with string columns.
    error = `Could not read field types: ${e.message}`;
  }
  return { columns: columnsForQuery(names, meta), names, from, error };
};

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Table",
        form: async () =>
          new Form({
            blurb:
              "A report exposes one Google Ads resource with the columns " +
              "below. Custom GAQL runs a query you write, and takes its " +
              "columns from what it selects.",
            fields: [
              {
                name: "mode",
                label: "Source",
                type: "String",
                required: true,
                attributes: { options: ["Report", CUSTOM] },
                default: "Report",
              },
              {
                name: "resource",
                label: "Resource",
                sublabel: "Ignored when the source is Custom GAQL.",
                type: "String",
                required: true,
                attributes: { options: RESOURCE_NAMES },
                default: RESOURCE_NAMES[0],
              },
            ],
          }),
      },
      {
        name: "Columns",
        onlyWhen: (context) => context.mode !== CUSTOM,
        form: async (context) => {
          const norm = normaliseCfg(context);
          const res = RESOURCES[norm.resource];
          return new Form({
            blurb:
              `Always included: ${res.base
                .map((c) => c.label)
                .join(", ")}. Money columns are in the account's currency; ` +
              "rate columns such as CTR are fractions, as Google reports them.",
            fields: [
              ...METRICS.map((m) => ({
                name: `m_${m.col}`,
                label: m.label,
                type: "Bool",
                default: ["impressions", "clicks", "cost"].includes(m.col),
              })),
              ...SEGMENT_COLS.map((s) => ({
                name: `seg_${s}`,
                label: `Segment by ${SEGMENTS[s].label.toLowerCase()}`,
                sublabel:
                  s === "date"
                    ? "One row per day per resource, rather than one total."
                    : "One row per device per resource.",
                type: "Bool",
                default: false,
              })),
              {
                name: "days",
                label: "Default window (days)",
                sublabel:
                  "How far back to read when a view does not filter on the " +
                  "date column. Only used when segmenting by date.",
                type: "Integer",
                default: DEFAULT_DAYS,
                attributes: { min: 1 },
              },
            ],
          });
        },
      },
      {
        name: "Query",
        onlyWhen: (context) => context.mode === CUSTOM,
        form: async () =>
          new Form({
            blurb:
              "Field names are snake_case and dotted. GAQL has no OR and no " +
              "parentheses in WHERE, and no OFFSET. Filters from views are " +
              "applied in Saltcorn, not added to this query.",
            fields: [
              {
                name: "query",
                label: "GAQL",
                type: "String",
                required: true,
                fieldview: "textarea",
                default:
                  "SELECT campaign.id, campaign.name, campaign.status, " +
                  "metrics.impressions, metrics.cost_micros\n" +
                  "FROM campaign\n" +
                  "WHERE segments.date DURING LAST_30_DAYS",
              },
            ],
          }),
      },
      {
        name: "Resolve",
        onlyWhen: (context) => context.mode === CUSTOM,
        form: async (context) => {
          const { columns, error } = await resolveQuery(context.query, {
            cfg: liveCfg(),
          });
          const listing = columns.length
            ? columns
                .map((c) => `${c.col} (${SC_TYPE[c.type] || "String"})`)
                .join(", ")
            : "none";
          return new Form({
            blurb: [
              error ? `<div class="alert alert-warning">${error}</div>` : "",
              `<p>Columns: <code>${listing}</code></p>`,
              hasLimit(context.query)
                ? '<p class="text-muted">This query has its own LIMIT, which ' +
                  "caps every view built on the table.</p>"
                : "",
            ].join(""),
            fields: [
              {
                name: "query_columns",
                input_type: "hidden",
                type: "String",
                default: JSON.stringify(columns),
              },
            ],
          });
        },
      },
    ],
  });

/**
 * Fetch rows for a report-mode table.
 *
 * Pushdown is where this provider differs from the other Google ones: GAQL
 * takes the filter, the order and a row cap, so most views cost one query of
 * exactly the rows wanted. What cannot be expressed - an `or`, a case-
 * insensitive match - stays in the residual and is checked locally over a
 * deliberately *wider* result set.
 *
 * @param {object} norm - the normalised provider configuration
 * @param {object} where - a Saltcorn where-object
 * @param {object} selopts - { orderBy, orderDesc, limit, offset }
 * @param {object} [opts] - { cfg, fetchImpl, maxPages }
 * @returns {Promise<object[]>} rows
 */
const getReportRows = async (norm, where = {}, selopts = {}, opts = {}) => {
  const cfg = opts.cfg || liveCfg();
  const res = RESOURCES[norm.resource];
  const cols = columnsOf(norm);
  const map = columnMap(cols);
  const { conditions, residual } = pushdown(where, map);

  // A date-segmented table with no date filter would otherwise read the whole
  // history of the account one 10,000-row page at a time.
  if (norm.segments.includes("date") && !("date" in where)) {
    // The account's zone, not the server's: see todayIn() in gaql.js.
    const { from, to } = relativeWindow(norm.days, cfg.account_time_zone);
    conditions.push(...dateWindow(from, to));
  }

  const oc = selopts.orderBy && map[selopts.orderBy];
  const canOrder = !!(oc && oc.sortable !== false);
  // LIMIT may only be sent when nothing is left to filter locally and the
  // order is the API's own - otherwise the rows that survive the local pass
  // are not the rows the API chose to keep.
  const residualEmpty = !Object.keys(residual).length;
  const canLimit = !!(
    selopts.limit &&
    residualEmpty &&
    (!selopts.orderBy || canOrder)
  );

  const select = [
    ...new Set([
      ...cols.filter((c) => !c.synthetic).map((c) => c.gaql),
      res.resourceNameField,
    ]),
  ];

  const query = buildQuery({
    select,
    from: res.from,
    where: conditions,
    orderBy: canOrder ? oc.gaql : undefined,
    orderDesc: selopts.orderDesc,
    limit: canLimit ? (selopts.offset || 0) + selopts.limit : undefined,
  });

  const results = await api.search(query, { ...opts, cfg });
  const rows = results.map((r) => toRow(r, cols, res, norm.segments));

  return applyLocal(rows, residual, {
    // Re-sorting what GAQL already ordered would only cost time.
    orderBy: canOrder ? undefined : selopts.orderBy,
    orderDesc: selopts.orderDesc,
    limit: selopts.limit,
    offset: selopts.offset,
  });
};

/**
 * Fetch rows for a hand-written query.
 *
 * Nothing is pushed down: appending conditions to a query that may already
 * carry its own WHERE, ORDER BY and LIMIT cannot be done safely by text, so
 * the query runs as written and the whole filter is applied locally.
 *
 * @param {object} norm - the normalised provider configuration
 * @param {object} where - a Saltcorn where-object
 * @param {object} selopts - { orderBy, orderDesc, limit, offset }
 * @param {object} [opts] - { cfg, fetchImpl, maxPages }
 * @returns {Promise<object[]>} rows
 */
const getQueryRows = async (norm, where = {}, selopts = {}, opts = {}) => {
  const cfg = opts.cfg || liveCfg();
  if (!norm.query) return [];
  const cols = storedQueryColumns(norm);
  const from = selectedFrom(norm.query);
  const nameField = from ? `${from}.resource_name` : null;

  const results = await api.search(norm.query, { ...opts, cfg });
  const rows = results.map((r) => {
    const row = {};
    for (const col of cols) row[col.col] = undefined;
    const flat = toRow(r, cols, { resourceNameField: nameField || "" }, []);
    // No resource name selected leaves nothing to key on, so fall back to a
    // hash of the row itself.
    const named = nameField && at(r, jsonPath(nameField));
    return { ...flat, row_key: named ? flat.row_key : syntheticKey(r) };
  });
  return applyLocal(rows, where, selopts);
};

/**
 * The provider's table object. Every method core may override is supplied,
 * because `disableFiltering` turns off the in-memory fallback wholesale.
 *
 * There is no insertRow, updateRow or deleteRows: Google Ads writes go through
 * per-resource `mutate` calls carrying a resource name and an update mask,
 * which a generic row write cannot build. The actions do those.
 */
const get_table = (cfgTable0) => {
  const norm = normaliseCfg(cfgTable0);

  const getRows = async (where = {}, selopts = {}, opts = {}) =>
    norm.custom
      ? await getQueryRows(norm, where, selopts, opts)
      : await getReportRows(norm, where, selopts, opts);

  return {
    disableFiltering: true,
    getRows,

    async countRows(where = {}) {
      // GAQL can report a total alongside the rows, but only through a request
      // field whose absence from older versions would be a hard error, so this
      // counts what it fetches - the same walk getRows would do.
      const rows = await getRows(where, {});
      return rows.length;
    },

    async distinctValues(fldNm, where = {}) {
      const rows = await getRows(where, {});
      return [...new Set(rows.map((r) => r[fldNm]))];
    },
  };
};

module.exports = {
  "Google Ads": {
    configuration_workflow,
    fields: (cfgTable) => {
      const norm = normaliseCfg(cfgTable);
      if (!norm.custom) return fieldsFor(norm);
      return storedQueryColumns(norm).map((c) => ({
        name: c.col,
        label: c.label || c.col,
        type: SC_TYPE[c.type] || "String",
        ...(c.col === "row_key" ? { primary_key: true } : {}),
      }));
    },
    get_table,
  },
  // exported for tests
  normaliseCfg,
  getReportRows,
  getQueryRows,
  resolveQuery,
  storedQueryColumns,
  columnsOf,
  CUSTOM,
  DEFAULT_DAYS,
};
