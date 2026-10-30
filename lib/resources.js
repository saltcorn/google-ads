/**
 * The Google Ads resources this plugin exposes as tables, their columns, and
 * the GAQL field each column comes from.
 *
 * A column definition carries everything three places need: `type` drives both
 * the Saltcorn field type and the conversion in either direction, `gaql` is
 * what goes in SELECT, WHERE and ORDER BY, and the two flags say what GAQL
 * will not do with the field.
 */

/** Saltcorn's field type for each conversion kind. */
const SC_TYPE = {
  int: "Integer",
  float: "Float",
  micros: "Float",
  bool: "Bool",
  date: "Date",
  datetime: "Date",
  string: "String",
  enum: "String",
};

const f = (col, gaql, type, label, extra = {}) => ({
  col,
  gaql,
  type,
  label,
  ...extra,
});

/** A repeated field arrives as an array; it is flattened to a joined string. */
const repeated = { repeated: true, filterable: false, sortable: false };

/**
 * Performance metrics, available on every resource here.
 *
 * `cost` and the other money columns are exposed in the account's currency,
 * not micros - the API's own unit, which is unusable in a view. Filters on
 * them are converted back to micros before they are sent.
 *
 * `ctr` and the other rate metrics are left exactly as Google reports them,
 * which is a fraction: 0.0512, not 5.12.
 */
const METRICS = [
  f("impressions", "metrics.impressions", "int", "Impressions"),
  f("clicks", "metrics.clicks", "int", "Clicks"),
  f("ctr", "metrics.ctr", "float", "CTR (fraction)"),
  f("average_cpc", "metrics.average_cpc", "micros", "Average CPC"),
  f("cost", "metrics.cost_micros", "micros", "Cost"),
  f("conversions", "metrics.conversions", "float", "Conversions"),
  f("conversions_value", "metrics.conversions_value", "float", "Conversion value"),
  f("cost_per_conversion", "metrics.cost_per_conversion", "micros", "Cost per conversion"),
  f("interactions", "metrics.interactions", "int", "Interactions"),
];

/** Segments, which multiply the rows rather than adding columns. */
const SEGMENTS = {
  date: f("date", "segments.date", "date", "Date"),
  device: f("device", "segments.device", "enum", "Device"),
};

/**
 * The synthesised primary key.
 *
 * No Ads report row has one of its own. A resource has a stable resource name,
 * but segmenting by date or device repeats it once per segment value, so the
 * key is the resource name with the segment values appended - the only thing
 * that identifies a row across two runs of a sync.
 */
const ROW_KEY = {
  col: "row_key",
  type: "string",
  label: "Row key",
  synthetic: true,
  filterable: false,
  sortable: false,
};

const campaignRefs = [
  f("campaign_id", "campaign.id", "int", "Campaign ID"),
  f("campaign_name", "campaign.name", "string", "Campaign"),
];
const adGroupRefs = [
  f("ad_group_id", "ad_group.id", "int", "Ad group ID"),
  f("ad_group_name", "ad_group.name", "string", "Ad group"),
];

/**
 * Each entry is one selectable table.
 *
 * `from` is the GAQL resource. `base` are the columns always selected;
 * `metrics` says whether performance columns may be added.
 */
const RESOURCES = {
  Campaigns: {
    from: "campaign",
    resourceNameField: "campaign.resource_name",
    base: [
      ...campaignRefs,
      f("status", "campaign.status", "enum", "Status"),
      f("channel_type", "campaign.advertising_channel_type", "enum", "Channel"),
      f("bidding_strategy", "campaign.bidding_strategy_type", "enum", "Bidding strategy"),
      // campaign.start_date and campaign.end_date were removed in API v23 and
      // replaced by these, which carry a time as well. The column names are
      // kept so tables built on the old ones keep their fields.
      //
      // Not pushed down: a DATE literal is 'YYYY-MM-DD', and how GAQL
      // compares one against a "YYYY-MM-DD HH:mm:ss" field is not something
      // this plugin has been able to verify against a live account. Filters
      // and sorts on them are applied locally instead, which is always
      // correct and costs nothing at campaign counts.
      f("start_date", "campaign.start_date_time", "datetime", "Start date", {
        filterable: false,
        sortable: false,
      }),
      f("end_date", "campaign.end_date_time", "datetime", "End date", {
        filterable: false,
        sortable: false,
      }),
      f("budget", "campaign_budget.amount_micros", "micros", "Daily budget"),
      f("budget_resource_name", "campaign_budget.resource_name", "string", "Budget resource name", { sortable: false }),
      f("resource_name", "campaign.resource_name", "string", "Resource name", { sortable: false }),
    ],
    metrics: true,
  },

  "Ad groups": {
    from: "ad_group",
    resourceNameField: "ad_group.resource_name",
    base: [
      ...adGroupRefs,
      f("status", "ad_group.status", "enum", "Status"),
      f("ad_group_type", "ad_group.type", "enum", "Type"),
      f("cpc_bid", "ad_group.cpc_bid_micros", "micros", "CPC bid"),
      ...campaignRefs,
      f("resource_name", "ad_group.resource_name", "string", "Resource name", { sortable: false }),
    ],
    metrics: true,
  },

  Ads: {
    from: "ad_group_ad",
    resourceNameField: "ad_group_ad.resource_name",
    base: [
      f("ad_id", "ad_group_ad.ad.id", "int", "Ad ID"),
      f("ad_name", "ad_group_ad.ad.name", "string", "Ad name"),
      f("ad_type", "ad_group_ad.ad.type", "enum", "Ad type"),
      f("status", "ad_group_ad.status", "enum", "Status"),
      f("approval_status", "ad_group_ad.policy_summary.approval_status", "enum", "Approval"),
      f("final_urls", "ad_group_ad.ad.final_urls", "string", "Final URLs", repeated),
      ...adGroupRefs,
      ...campaignRefs,
      f("resource_name", "ad_group_ad.resource_name", "string", "Resource name", { sortable: false }),
    ],
    metrics: true,
  },

  Keywords: {
    from: "keyword_view",
    resourceNameField: "ad_group_criterion.resource_name",
    base: [
      f("criterion_id", "ad_group_criterion.criterion_id", "int", "Criterion ID"),
      f("keyword", "ad_group_criterion.keyword.text", "string", "Keyword"),
      f("match_type", "ad_group_criterion.keyword.match_type", "enum", "Match type"),
      f("status", "ad_group_criterion.status", "enum", "Status"),
      f("quality_score", "ad_group_criterion.quality_info.quality_score", "int", "Quality score"),
      f("cpc_bid", "ad_group_criterion.cpc_bid_micros", "micros", "CPC bid"),
      ...adGroupRefs,
      ...campaignRefs,
      f("resource_name", "ad_group_criterion.resource_name", "string", "Resource name", { sortable: false }),
    ],
    metrics: true,
  },

  "Search terms": {
    from: "search_term_view",
    resourceNameField: "search_term_view.resource_name",
    base: [
      f("search_term", "search_term_view.search_term", "string", "Search term"),
      f("status", "search_term_view.status", "enum", "Status"),
      ...adGroupRefs,
      ...campaignRefs,
      f("resource_name", "search_term_view.resource_name", "string", "Resource name", { sortable: false }),
    ],
    metrics: true,
  },

  Accounts: {
    from: "customer",
    resourceNameField: "customer.resource_name",
    base: [
      f("customer_id", "customer.id", "int", "Customer ID"),
      f("name", "customer.descriptive_name", "string", "Name"),
      f("currency_code", "customer.currency_code", "enum", "Currency"),
      f("time_zone", "customer.time_zone", "string", "Time zone"),
      f("manager", "customer.manager", "bool", "Manager account"),
      f("test_account", "customer.test_account", "bool", "Test account"),
      f("resource_name", "customer.resource_name", "string", "Resource name", { sortable: false }),
    ],
    metrics: true,
  },
};

const RESOURCE_NAMES = Object.keys(RESOURCES);
const METRIC_COLS = METRICS.map((m) => m.col);
const SEGMENT_COLS = Object.keys(SEGMENTS);

/**
 * The columns one table configuration exposes.
 *
 * @param {object} cfgTable - the provider configuration for this table
 * @returns {object[]} column definitions, row_key first
 */
const columnsFor = (cfgTable = {}) => {
  const res = RESOURCES[cfgTable.resource] || RESOURCES[RESOURCE_NAMES[0]];
  const wanted = new Set(cfgTable.metrics || []);
  const segs = (cfgTable.segments || []).map((s) => SEGMENTS[s]).filter(Boolean);
  return [
    ROW_KEY,
    ...segs,
    ...res.base,
    ...METRICS.filter((m) => wanted.has(m.col)),
  ];
};

/** Those columns keyed by column name, as the pushdown wants them. */
const columnMap = (cols) =>
  Object.fromEntries(cols.filter((c) => !c.synthetic).map((c) => [c.col, c]));

/**
 * The Saltcorn field list for one table configuration.
 *
 * @param {object} cfgTable - the provider configuration for this table
 * @returns {object[]} Saltcorn field definitions
 */
const fieldsFor = (cfgTable = {}) =>
  columnsFor(cfgTable).map((c) => ({
    name: c.col,
    label: c.label,
    type: SC_TYPE[c.type] || "String",
    ...(c.col === "row_key" ? { primary_key: true } : {}),
  }));

module.exports = {
  RESOURCES,
  RESOURCE_NAMES,
  METRICS,
  METRIC_COLS,
  SEGMENTS,
  SEGMENT_COLS,
  ROW_KEY,
  SC_TYPE,
  columnsFor,
  columnMap,
  fieldsFor,
};
