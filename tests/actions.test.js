const test = require("node:test");
const assert = require("node:assert");
const api = require("../lib/api");
const actions = require("../lib/actions");

const CFG = { customer_id: "1234567890" };

/** Replace api.mutate for one test, capturing what it was asked to do. */
const withMutate = async (res, fn) => {
  const real = api.mutate;
  const calls = [];
  api.mutate = async (collection, operations, opts) => {
    calls.push({ collection, operations, opts });
    return res || {};
  };
  try {
    return await fn(calls);
  } finally {
    api.mutate = real;
  }
};

/** The live config a run() reads; there is no state in a unit test. */
const withCfg = (cfg, fn) => {
  const config = require("../lib/config");
  const real = config.liveCfg;
  // liveCfg is read through the module object by actions.js
  Object.defineProperty(config, "liveCfg", { value: () => cfg, configurable: true });
  const done = () =>
    Object.defineProperty(config, "liveCfg", { value: real, configurable: true });
  const out = fn();
  return out && out.then ? out.finally(done) : (done(), out);
};

const run = (action, configuration, row = {}) =>
  action.run({ row, table: null, user: null, configuration });

test("every action is namespaced and described", () => {
  const names = [
    "google_ads_run_query",
    "google_ads_set_campaign_status",
    "google_ads_set_ad_group_status",
    "google_ads_set_campaign_budget",
  ];
  for (const n of names) {
    assert.ok(actions[n], n);
    assert.equal(actions[n].namespace, "Google Ads");
    assert.ok(actions[n].description, n);
    assert.equal(typeof actions[n].run, "function", n);
    assert.equal(typeof actions[n].configFields, "function", n);
  }
});

test("a numeric id is expanded to a resource name for the chosen account", () => {
  assert.equal(
    actions.resourceName("campaigns", "55", CFG),
    "customers/1234567890/campaigns/55",
  );
  // the provider's rows carry hyphens nowhere, but a pasted id might
  assert.equal(
    actions.resourceName("campaigns", " 55 ", CFG),
    "customers/1234567890/campaigns/55",
  );
});

test("a resource name is passed through untouched, even for another account", () => {
  // so a row read from one account's table can be acted on as it stands
  assert.equal(
    actions.resourceName("campaigns", "customers/9999999999/campaigns/7", CFG),
    "customers/9999999999/campaigns/7",
  );
});

test("something that is neither is refused by name", () => {
  assert.throws(() => actions.resourceName("campaigns", "abc", CFG), /neither a resource name nor a numeric id/);
  assert.throws(() => actions.resourceName("campaigns", "", CFG), /no campaign given/);
  assert.throws(() => actions.resourceName("adGroups", null, CFG), /no adGroup given/);
});

test("setting a campaign status sends an update with a status mask", async () => {
  await withMutate({ results: [{ resourceName: "customers/1234567890/campaigns/55" }] }, async (calls) => {
    const out = await withCfg(CFG, () =>
      run(actions.google_ads_set_campaign_status, {
        target_expr: "campaign_id",
        status_expr: '"PAUSED"',
      }, { campaign_id: 55 }),
    );
    assert.equal(calls[0].collection, "campaigns");
    assert.deepEqual(calls[0].operations, [
      {
        update: { resourceName: "customers/1234567890/campaigns/55", status: "PAUSED" },
        // snake_case: the mask names the proto field, not the JSON key
        updateMask: "status",
      },
    ]);
    assert.equal(calls[0].opts.validateOnly, false);
    // status_expr with no `status` is what every configuration saved before
    // the dropdown existed looks like, and it still has to work
    assert.deepEqual(out, {
      applied: true,
      results: ["customers/1234567890/campaigns/55"],
      notify: "Campaign set to PAUSED.",
    });
  });
});

// Picking a status out of a dropdown is the whole point: "PAUSED" in a
// JavaScript box needs quotes, and without them it is a free variable that
// evaluates to nothing.
test("a status chosen from the dropdown needs no expression", async () => {
  await withMutate({ results: [] }, async (calls) => {
    const out = await withCfg(CFG, () =>
      run(actions.google_ads_set_campaign_status, {
        target_expr: "campaign_id",
        status: "ENABLED",
      }, { campaign_id: 55 }),
    );
    assert.equal(calls[0].operations[0].update.status, "ENABLED");
    assert.equal(out.notify, "Campaign set to ENABLED.");
  });
});

test("the dropdown wins over a stale expression, unless it defers", async () => {
  await withMutate({ results: [] }, async (calls) => {
    await withCfg(CFG, () =>
      run(actions.google_ads_set_campaign_status, {
        target_expr: "campaign_id",
        status: "REMOVED",
        status_expr: '"ENABLED"',
      }, { campaign_id: 55 }),
    );
    assert.equal(calls[0].operations[0].update.status, "REMOVED");

    await withCfg(CFG, () =>
      run(actions.google_ads_set_campaign_status, {
        target_expr: "campaign_id",
        status: "From expression",
        status_expr: '"ENABLED"',
      }, { campaign_id: 55 }),
    );
    assert.equal(calls[1].operations[0].update.status, "ENABLED");
  });
});

test("a dry run says it was one", async () => {
  await withMutate({ results: [] }, async () => {
    const out = await withCfg(CFG, () =>
      run(actions.google_ads_set_campaign_status, {
        target_expr: "campaign_id",
        status: "PAUSED",
        validate_only: true,
      }, { campaign_id: 55 }),
    );
    assert.match(out.notify, /^Dry run: this campaign would be set to PAUSED\.$/);
  });
});

test("an ad group status goes to the adGroups collection", async () => {
  await withMutate({}, async (calls) => {
    await withCfg(CFG, () =>
      run(actions.google_ads_set_ad_group_status, {
        target_expr: "ad_group_id",
        status_expr: '"ENABLED"',
      }, { ad_group_id: 7 }),
    );
    assert.equal(calls[0].collection, "adGroups");
    assert.equal(
      calls[0].operations[0].update.resourceName,
      "customers/1234567890/adGroups/7",
    );
  });
});

test("a status is upper-cased and trimmed before it is checked", async () => {
  await withMutate({}, async (calls) => {
    await withCfg(CFG, () =>
      run(actions.google_ads_set_campaign_status, {
        target_expr: "1",
        status_expr: '" paused "',
      }),
    );
    assert.equal(calls[0].operations[0].update.status, "PAUSED");
  });
});

test("a status Google does not have is refused before the call", async () => {
  await withMutate({}, async (calls) => {
    await assert.rejects(
      () =>
        withCfg(CFG, () =>
          run(actions.google_ads_set_campaign_status, {
            target_expr: "1",
            status_expr: '"ARCHIVED"',
          }),
        ),
      /"ARCHIVED" is not a status.*ENABLED, PAUSED or REMOVED/s,
    );
    assert.equal(calls.length, 0);
  });
});

test("a dry run is passed through to the API", async () => {
  await withMutate({}, async (calls) => {
    const out = await withCfg(CFG, () =>
      run(actions.google_ads_set_campaign_status, {
        target_expr: "1",
        status_expr: '"PAUSED"',
        validate_only: true,
      }),
    );
    assert.equal(calls[0].opts.validateOnly, true);
    // and the result says plainly that nothing changed
    assert.equal(out.applied, false);
  });
});

test("a budget is given in currency and sent in micros", async () => {
  await withMutate({}, async (calls) => {
    await withCfg(CFG, () =>
      run(actions.google_ads_set_campaign_budget, {
        budget_expr: "budget_resource_name",
        amount_expr: "50.25",
      }, { budget_resource_name: "customers/1234567890/campaignBudgets/9" }),
    );
    assert.equal(calls[0].collection, "campaignBudgets");
    assert.deepEqual(calls[0].operations, [
      {
        update: {
          resourceName: "customers/1234567890/campaignBudgets/9",
          amountMicros: "50250000",
        },
        updateMask: "amount_micros",
      },
    ]);
  });
});

test("a budget of zero is allowed, a negative or unparseable one is not", async () => {
  await withMutate({}, async (calls) => {
    await withCfg(CFG, () =>
      run(actions.google_ads_set_campaign_budget, { budget_expr: "9", amount_expr: "0" }),
    );
    assert.equal(calls[0].operations[0].update.amountMicros, "0");

    for (const bad of ["-5", '"abc"'])
      await assert.rejects(
        () =>
          withCfg(CFG, () =>
            run(actions.google_ads_set_campaign_budget, { budget_expr: "9", amount_expr: bad }),
          ),
        /is not a budget amount/,
        bad,
      );
    assert.equal(calls.length, 1);
  });
});

test("an empty amount is refused, not read as a budget of zero", async () => {
  // Number(null) and Number("") are both 0, so this would otherwise stop the
  // campaign delivering rather than fail.
  await withMutate({}, async (calls) => {
    for (const nothing of ["null", "undefined", '""', '"  "'])
      await assert.rejects(
        () =>
          withCfg(CFG, () =>
            run(actions.google_ads_set_campaign_budget, {
              budget_expr: "9",
              amount_expr: nothing,
            }),
          ),
        /produced nothing.*would stop the campaign/s,
        nothing,
      );
    assert.equal(calls.length, 0);
  });
});

test("a result variable renames the output for a workflow step", async () => {
  await withMutate({ results: [{ resourceName: "r" }] }, async () => {
    const out = await withCfg(CFG, () =>
      run(actions.google_ads_set_campaign_status, {
        target_expr: "1",
        status_expr: '"PAUSED"',
        result_variable: "paused",
      }),
    );
    assert.deepEqual(Object.keys(out), ["paused"]);
    assert.deepEqual(out.paused.results, ["r"]);
  });
});

test("the result variable field appears only for a workflow", async () => {
  const forWorkflow = await actions.google_ads_set_campaign_status.configFields({ mode: "workflow" });
  const forRow = await actions.google_ads_set_campaign_status.configFields({ mode: "row" });
  assert.ok(forWorkflow.some((f) => f.name === "result_variable"));
  assert.ok(!forRow.some((f) => f.name === "result_variable"));
});

test("a partial failure is reported rather than swallowed", async () => {
  await withMutate({ results: [], partialFailureError: { message: "one operation failed" } }, async () => {
    const out = await withCfg(CFG, () =>
      run(actions.google_ads_set_campaign_status, { target_expr: "1", status_expr: '"PAUSED"' }),
    );
    assert.deepEqual(out.error, { message: "one operation failed" });
  });
});

test("run_query evaluates the expression and returns the rows", async () => {
  const real = api.search;
  const calls = [];
  api.search = async (q, opts) => {
    calls.push({ q, opts });
    return [{ campaign: { id: "1" } }];
  };
  try {
    const out = await withCfg(CFG, () =>
      run(actions.google_ads_run_query, {
        query_expr: '`SELECT campaign.id FROM campaign WHERE campaign.id = ${campaign_id}`',
        max_pages: 3,
      }, { campaign_id: 42 }),
    );
    assert.equal(calls[0].q, "SELECT campaign.id FROM campaign WHERE campaign.id = 42");
    assert.equal(calls[0].opts.maxPages, 3);
    // no query_source, as every configuration saved before the GAQL box
    // existed - the expression is still what runs
    assert.deepEqual(out, {
      rows: [{ campaign: { id: "1" } }],
      notify: "Query returned 1 row.",
    });
  } finally {
    api.search = real;
  }
});

// GAQL in a JavaScript box has to be a quoted or backticked string, which is
// the step everyone misses: the box looked like somewhere to type a query.
test("a fixed query is sent exactly as it was typed", async () => {
  const real = api.search;
  const calls = [];
  api.search = async (q) => {
    calls.push(q);
    return [{ campaign: { id: "1" } }, { campaign: { id: "2" } }];
  };
  try {
    const out = await withCfg(CFG, () =>
      run(actions.google_ads_run_query, {
        query_source: "Fixed query",
        query: "SELECT campaign.id FROM campaign",
        query_expr: '`never used`',
      }),
    );
    assert.equal(calls[0], "SELECT campaign.id FROM campaign");
    assert.equal(out.notify, "Query returned 2 rows.");
  } finally {
    api.search = real;
  }
});

test("an empty GAQL box says so without blaming an expression", async () => {
  await assert.rejects(
    () =>
      withCfg(CFG, () =>
        run(actions.google_ads_run_query, { query_source: "Fixed query" }),
      ),
    /Write one in the GAQL box/,
  );
});

test("run_query refuses an expression that produced nothing", async () => {
  await assert.rejects(
    () => withCfg(CFG, () => run(actions.google_ads_run_query, { query_expr: '""' })),
    /the query expression produced nothing/,
  );
  await assert.rejects(
    () => withCfg(CFG, () => run(actions.google_ads_run_query, { query_expr: '"   "' })),
    /produced nothing/,
  );
});

test("run_query defaults to a small page budget", async () => {
  const real = api.search;
  const calls = [];
  api.search = async (q, opts) => {
    calls.push(opts);
    return [];
  };
  try {
    await withCfg(CFG, () =>
      run(actions.google_ads_run_query, { query_expr: '"SELECT a.b FROM c"' }),
    );
    assert.equal(calls[0].maxPages, 2);
  } finally {
    api.search = real;
  }
});

test("mutateResult reports what was applied and what came back", () => {
  assert.deepEqual(
    actions.mutateResult({ results: [{ resourceName: "a" }, {}, { resourceName: "b" }] }, false),
    { applied: true, results: ["a", "b"] },
  );
  assert.deepEqual(actions.mutateResult({}, true), { applied: false, results: [] });
});
