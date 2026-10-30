const {
  get_async_expression_function,
} = require("@saltcorn/data/models/expression");
const api = require("./api");
// Required as a namespace, not destructured: an action has no cfg parameter to
// inject through, so reading the live config through the module object is what
// lets a test substitute it.
const config = require("./config");
const { customerId, digits } = config;

const NAMESPACE = "Google Ads";

const STATUSES = ["ENABLED", "PAUSED", "REMOVED"];
/** The dropdown entry that hands the choice back to an expression. */
const STATUS_FROM_EXPR = "From expression";

const QUERY_FIXED = "Fixed query";
const QUERY_EXPR = "From expression";

/**
 * Evaluate one of the action's JavaScript expressions against the row.
 *
 * Uses the same evaluator as the built-in row actions, so the bindings a user
 * already knows - the row's own fields, `user`, `$`-prefixed state - all work.
 *
 * @param {string} expr - the expression source
 * @param {object} ctx - { row, table, user }
 * @returns {Promise<*>} whatever the expression evaluates to
 */
const evalExpr = async (expr, { row, table, user }) => {
  if (!expr) return undefined;
  const fields =
    (table && table.fields) || Object.keys(row || {}).map((k) => ({ name: k }));
  const f = get_async_expression_function(expr, fields, { user, console });
  return await f(row || {}, user);
};

const codeField = (name, label, sublabel, table) => ({
  name,
  label,
  sublabel,
  input_type: "code",
  attributes: {
    mode: "application/javascript",
    compact: true,
    expression_type: "row",
    table: table && table.name,
    nojoins: true,
    user: true,
  },
});

const resultVariable = (mode, sublabel) =>
  mode === "workflow"
    ? [{ name: "result_variable", label: "Result variable", sublabel, type: "String" }]
    : [];

const dryRunField = {
  name: "validate_only",
  label: "Dry run",
  sublabel:
    "Ask Google to validate the change and report what it would say, " +
    "without applying it.",
  type: "Bool",
  default: false,
};

/**
 * A resource name for one of this account's resources.
 *
 * Accepts what the provider's rows actually carry - either the full resource
 * name or the bare numeric id - so a row read from a Google Ads table can be
 * fed straight back in.
 *
 * @param {string} collection - the resource path segment, e.g. "campaigns"
 * @param {*} idOrName - a resource name or an id
 * @param {object} cfg - plugin configuration
 * @returns {string} customers/<cid>/<collection>/<id>
 */
const resourceName = (collection, idOrName, cfg) => {
  const raw = String(idOrName ?? "").trim();
  if (!raw)
    throw new Error(`google-ads: no ${collection.replace(/s$/, "")} given.`);
  if (raw.startsWith("customers/")) return raw;
  const id = digits(raw);
  if (!id)
    throw new Error(
      `google-ads: "${raw}" is neither a resource name nor a numeric id.`,
    );
  return `customers/${customerId(cfg)}/${collection}/${id}`;
};

/** What a mutate reply says it did, in a shape worth storing in a variable. */
const mutateResult = (res, validateOnly) => ({
  applied: !validateOnly,
  results: (res.results || []).map((r) => r.resourceName).filter(Boolean),
  ...(res.partialFailureError ? { error: res.partialFailureError } : {}),
});

/**
 * Change a resource's status.
 *
 * One factory for campaigns and ad groups: the operation is identical bar the
 * collection it is addressed to.
 */
const statusAction = (collection, label, idLabel, idHint) => ({
  description: `Enable, pause or remove a ${label} in Google Ads`,
  namespace: NAMESPACE,
  configFields: async ({ table, mode }) => [
    codeField(
      "target_expr",
      `${idLabel} expression`,
      `JavaScript returning the ${label}'s resource name or numeric ID. A ` +
        `bare column name is already an expression, so the usual answer is ` +
        `just <code>${idHint}</code>.`,
      table,
    ),
    {
      name: "status",
      label: "Status",
      sublabel: "Removing cannot be undone through the API.",
      type: "String",
      required: true,
      attributes: { options: [...STATUSES, STATUS_FROM_EXPR] },
      default: "PAUSED",
    },
    {
      ...codeField(
        "status_expr",
        "Status expression",
        'JavaScript returning <code>"ENABLED"</code>, <code>"PAUSED"</code> ' +
          'or <code>"REMOVED"</code>.',
        table,
      ),
      showIf: { status: STATUS_FROM_EXPR },
    },
    dryRunField,
    ...resultVariable(mode, "Context variable to fill with the result"),
  ],
  run: async ({ row, table, user, configuration, ...rest }) => {
    const cfg = config.liveCfg();
    const target = await evalExpr(configuration.target_expr, { row, table, user });
    // A saved configuration from before the dropdown existed has no `status`
    // at all, so an absent one still means "ask the expression".
    const picked = configuration.status;
    const raw =
      picked && picked !== STATUS_FROM_EXPR
        ? picked
        : await evalExpr(configuration.status_expr, { row, table, user });
    const status = String(raw ?? "")
      .trim()
      .toUpperCase();
    if (!STATUSES.includes(status))
      throw new Error(
        `google-ads: "${status}" is not a status. Use ENABLED, PAUSED or ` +
          "REMOVED.",
      );
    const res = await api.mutate(
      collection,
      [
        {
          update: { resourceName: resourceName(collection, target, cfg), status },
          // snake_case: the mask names the proto field, not the JSON key
          updateMask: "status",
        },
      ],
      { cfg, validateOnly: !!configuration.validate_only },
    );
    const out = mutateResult(res, configuration.validate_only);
    if (configuration.result_variable)
      return { [configuration.result_variable]: out };
    // Pressed as a button there is nowhere for a return value to go, so the
    // action said nothing at all and looked like it had not run.
    return {
      ...out,
      notify: configuration.validate_only
        ? `Dry run: this ${label} would be set to ${status}.`
        : `${idLabel} set to ${status}.`,
    };
  },
});

const set_campaign_status = statusAction(
  "campaigns",
  "campaign",
  "Campaign",
  "campaign_id",
);
const set_ad_group_status = statusAction(
  "adGroups",
  "ad group",
  "Ad group",
  "ad_group_id",
);

/**
 * Change a campaign budget's daily amount.
 *
 * The amount is in the account's currency, as the provider's `budget` column
 * reports it, and is converted to micros here.
 */
const set_campaign_budget = {
  description: "Change a campaign budget's daily amount in Google Ads",
  namespace: NAMESPACE,
  configFields: async ({ table, mode }) => [
    codeField(
      "budget_expr",
      "Budget expression",
      "JavaScript returning the campaign budget's resource name or numeric " +
        "ID. The Campaigns table's <code>budget_resource_name</code> column " +
        "holds it. Example: <code>budget_resource_name</code>",
      table,
    ),
    codeField(
      "amount_expr",
      "Amount expression",
      "JavaScript returning the new daily amount in the account's currency - " +
        "not micros. Example: <code>50</code>",
      table,
    ),
    dryRunField,
    ...resultVariable(mode, "Context variable to fill with the result"),
  ],
  run: async ({ row, table, user, configuration }) => {
    const cfg = config.liveCfg();
    const target = await evalExpr(configuration.budget_expr, { row, table, user });
    const raw = await evalExpr(configuration.amount_expr, { row, table, user });
    // Number(null) and Number("") are both 0, so an expression that produced
    // nothing would otherwise zero the budget and stop the campaign delivering.
    if (raw === null || raw === undefined || String(raw).trim() === "")
      throw new Error(
        "google-ads: the amount expression produced nothing. Refusing to " +
          "treat that as a budget of zero, which would stop the campaign.",
      );
    const amount = Number(raw);
    if (!isFinite(amount) || amount < 0)
      throw new Error(
        `google-ads: ${JSON.stringify(raw)} is not a budget amount.`,
      );
    const res = await api.mutate(
      "campaignBudgets",
      [
        {
          update: {
            resourceName: resourceName("campaignBudgets", target, cfg),
            amountMicros: String(Math.round(amount * 1e6)),
          },
          updateMask: "amount_micros",
        },
      ],
      { cfg, validateOnly: !!configuration.validate_only },
    );
    const out = mutateResult(res, configuration.validate_only);
    if (configuration.result_variable)
      return { [configuration.result_variable]: out };
    return {
      ...out,
      notify: configuration.validate_only
        ? `Dry run: the daily budget would be set to ${amount}.`
        : `Daily budget set to ${amount}.`,
    };
  },
};

/**
 * Run a GAQL query and return its rows.
 *
 * The rows are the API's own nested objects rather than the provider's flat
 * ones: an action's caller asked for this query, not for a table's columns.
 */
const run_query = {
  description: "Run a GAQL query against Google Ads",
  namespace: NAMESPACE,
  configFields: async ({ table, mode }) => [
    {
      name: "query_source",
      label: "Query",
      sublabel:
        "A fixed query is the usual case. An expression builds the query " +
        "from the row it runs on.",
      type: "String",
      required: true,
      attributes: { options: [QUERY_FIXED, QUERY_EXPR] },
      default: QUERY_FIXED,
    },
    {
      name: "query",
      label: "GAQL",
      sublabel:
        "Written as it is sent - no quotes and no backticks. Example: " +
        "<code>SELECT campaign.id, campaign.name, metrics.clicks FROM " +
        "campaign</code>",
      type: "String",
      fieldview: "textarea",
      showIf: { query_source: QUERY_FIXED },
    },
    {
      ...codeField(
        "query_expr",
        "Query expression",
        "JavaScript returning the GAQL query. A template literal reaches " +
          "the row's columns: <code>`SELECT campaign.id, metrics.clicks " +
          "FROM campaign WHERE campaign.id = ${campaign_id}`</code>",
        table,
      ),
      showIf: { query_source: QUERY_EXPR },
    },
    {
      name: "max_pages",
      label: "Maximum pages",
      sublabel: "Each page is up to 10,000 rows.",
      type: "Integer",
      default: 2,
      attributes: { min: 1 },
    },
    ...resultVariable(mode, "Context variable to fill with the rows"),
  ],
  run: async ({ row, table, user, configuration }) => {
    // A configuration saved before the fixed-query box existed carries only
    // the expression, and no query_source to say so.
    const useExpr =
      configuration.query_source === QUERY_EXPR ||
      (!configuration.query && !!configuration.query_expr);
    const query = useExpr
      ? await evalExpr(configuration.query_expr, { row, table, user })
      : configuration.query;
    if (!query || !String(query).trim())
      throw new Error(
        useExpr
          ? "google-ads: the query expression produced nothing."
          : "google-ads: no query. Write one in the GAQL box.",
      );
    const rows = await api.search(String(query), {
      cfg: config.liveCfg(),
      maxPages: Number(configuration.max_pages) || 2,
    });
    if (configuration.result_variable)
      return { [configuration.result_variable]: rows };
    // Outside a workflow the rows have nowhere to go, so at least say how
    // many came back rather than appearing to do nothing.
    return {
      rows,
      notify: `Query returned ${rows.length} row${rows.length === 1 ? "" : "s"}.`,
    };
  },
};

module.exports = {
  google_ads_run_query: run_query,
  google_ads_set_campaign_status: set_campaign_status,
  google_ads_set_ad_group_status: set_ad_group_status,
  google_ads_set_campaign_budget: set_campaign_budget,
  // exported for tests
  resourceName,
  evalExpr,
  mutateResult,
};
