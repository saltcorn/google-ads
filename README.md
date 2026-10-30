# @saltcorn/google-ads

A Google Ads table provider and actions for Saltcorn. Campaigns, ad groups,
ads, keywords and search terms become tables you can build views on, and a
handful of actions change campaign status and budgets.

Queries go through **GAQL**, Google's SQL-like query language, so filters,
ordering and row limits from a Saltcorn view are translated into the query
rather than applied after the fact. That makes this provider considerably
cheaper than one over a plain REST API — see
[What gets pushed down](#what-gets-pushed-down).

No runtime dependencies beyond the Saltcorn packages. Node 18 or newer.

## Before you start: access levels

This is the part that stops most first attempts, and it is not about the
plugin. Enabling the Google Ads API on a Cloud project grants **Test** access,
which reaches *test accounts only* — pointing it at a real account returns a
permission error no amount of configuration will fix.

| Level | Reaches | Operations/day | How to get it |
| --- | --- | --- | --- |
| Test | Test accounts only | 15,000 | Automatic when you enable the API |
| Explorer | Test + production | 2,880 production | Apply in the Cloud console; usually automated |
| Basic | Both | 15,000 each | Requires brand verification |
| Standard | Both | Unlimited | Manual audit, around 10 business days |

Explorer also blocks account creation, user management, Keyword Planner and
reach planning. At 2,880 operations a day, a handful of live views refreshing
all afternoon will exhaust it — prefer
[syncing into a local table](#syncing-into-a-local-table).

Check your project's level on Google's
[access levels](https://developers.google.com/google-ads/api/docs/access-levels)
page.

### Developer tokens

Google's access-levels page says developer tokens were **sunset on 9 September
2026**, and that API access now belongs to the Cloud project rather than to a
token. Its
[call structure](https://developers.google.com/google-ads/api/docs/concepts/call-structure)
page still lists `developer-token` as a required header, and the official REST
examples send no such header at all.

The sunset is now confirmed: the API ignores the header, and Google has said
it will start rejecting it in a future major version. Access level is a
property of the Cloud project, visible and upgradable at **Google Cloud
console → APIs → Google Ads API → Overview**. Apply for Explorer there, not
from the Ads API Center — requests started from the API Center are not
processed.

The plugin leaves the **Developer token** field optional and sends the header
only when you fill it in, which is correct either way. Leave it empty.

A manager (MCC) account is no longer required either. You only need one if the
account you are querying is *held under* a manager — see
[Manager accounts](#manager-accounts).

## Setup

### 1. Open the plugin configuration and fill in the base URL

The first step shows the **redirect URI** you have to register with Google. It
is derived from the base URL, and updates as you type, so you can copy it
before going anywhere near the Cloud console. Until a base URL is set it shows
a placeholder host and says so — that value is not registrable.

### 2. Set up the Google Cloud project

In the [Google Cloud console](https://console.cloud.google.com/apis/library/googleads.googleapis.com):

1. Enable the **Google Ads API**. Nothing works until this is on.
2. Check the project's API **access level** (see above).
3. Under **APIs & Services → Credentials**, create an **OAuth 2.0 Client ID**
   of type **Web application**.
4. Add the redirect URI from step 1 under **Authorised redirect URIs**,
   character for character.

### 3. Finish the plugin configuration

Paste the client ID and secret, optionally a developer token, and set the **API
version** (see [Versions](#versions)). Then **Connect Google account** on the
Connect step, and pick the account on the Account step.

On a successful connection the plugin lists the accounts your Google login can
reach and caches them, so the Account step is a picker rather than ten digits
typed from memory.

### Publishing status

Google's OAuth consent screen behaves differently depending on its publishing
status, and one combination will bite you weekly:

| User type | Status | Refresh token lifetime |
| --- | --- | --- |
| Internal | — | Indefinite |
| External | Testing | **7 days** |
| External | In production | Indefinite |

An external app left in Testing hands out refresh tokens that expire after a
week. The plugin detects this and says so (see
[Troubleshooting](#troubleshooting)), but the fix is to publish the app or use
an Internal user type.

While in Testing, add **the Google account you will connect with** under
**Audience → Test users**, or consent fails with `access_denied`. That is not
necessarily the account that owns the Cloud project: a test manager has to be
created under a Google account that is not linked to a production manager, so
the account you connect with is often a different one from the account you
built the OAuth client in. Both can coexist — the OAuth client identifies the
*application*, not the user — but every account you intend to sign in as must
be listed here.

### Which identity is which

Three separate things are easy to conflate:

| | What it is | When it changes |
| --- | --- | --- |
| Cloud project | Owns the OAuth client and carries the API **access level** | Rarely — reuse it |
| Client ID / secret | The application's identity | Only with the project |
| Connected Google account | Whose refresh token is stored, and what it can reach | Whenever you target a different Ads hierarchy |

Pointing the plugin at a different Google Ads account usually means changing
only the third: reconnect on the **Connect** step as an account that can reach
it. The client ID and secret stay as they are.

## Finding the two IDs

Both are ten digits in the same `123-456-7890` shape, which is most of why
they get swapped.

- **Customer ID** — open the account at <https://ads.google.com> and read the
  number at the top right, beside the account name. This is the account the
  data comes from: the *client* account. A manager account holds no campaigns
  of its own, so pointing the plugin at one gives tables that are empty rather
  than broken — there is no error to go on.
- **Manager account ID** — open the manager and read the same top-right
  number. From the manager's **Accounts** page, the **Direct manager** column
  shows it against every account it holds.

Leave **Manager account ID** empty when the account is not held under a
manager. Setting one that does not manage the account gives
`USER_PERMISSION_DENIED`.

The Account step checks both as you type: it flags an ID that is not ten
digits, and flags the two fields naming the same account.

## Manager accounts

If the account you want is held under a manager (MCC) account, set **Manager
account ID** to the *manager's* customer ID. It is sent as the
`login-customer-id` header, which Google requires in that case.

Accounts under a manager do not appear in the Account step's picker — only the
manager does. Type the client account's ID into **Customer ID** and the
manager's into **Manager account ID**.

## Testing without spending

You do not need a billable Google Ads account to use this plugin. Google Ads
only charges for clicks and impressions on campaigns that are actually
serving; adding a payment method does not by itself cost anything. But the
new-account signup flow pushes you into launching a campaign, and a live
campaign does spend, so the safe way to develop against this plugin is an API
**test account**.

Test accounts never serve ads, have no billing, and cannot interact with
production accounts. To set one up:

1. Create a **test manager account** at
   <https://ads.google.com/nav/selectaccount?sf=mt> — this is the "Create a
   test manager account" button from Google's test-accounts page, and it is
   the *only* way to get a manager flagged as a test manager. Sign in with a
   Google account that is not already linked to a production manager account.
   A test account cannot be created under a production manager.
2. In that test manager, on <https://ads.google.com>, open **Accounts** in the
   left navigation, click the **+** (add) button, and choose **Create new
   account**. Client accounts created under a test manager are automatically
   test accounts. A budget error during creation is expected and can be
   ignored — test accounts have no budgets.

   A plain (non-manager) Google Ads account has no **Accounts** section at
   all, so if you cannot find it, you are not in a manager account.
3. Create a campaign or two under the client account so there is something to
   read.
4. In this plugin's configuration, connect as the test manager's Google
   account, then set **Customer ID** to the *client* account's ID and
   **Manager account ID** to the *test manager's* ID.

Two things that catch people out:

- You do not need a developer token, and you do not need a manager account to
  get started. Access now belongs to the Cloud project: enabling the API
  grants **Test** access, which reaches test accounts *only*. Check the level
  at **Google Cloud console → APIs → Google Ads API → Overview**.
- A test account shows up in the Google Ads UI as **cancelled**, because it
  has no billing and serves nothing. That is by design, not a problem to fix.
  Two consequences that look like failures but are not:

  - The **Accounts** list in the manager filters on `Account status: Active,
    Draft` by default, which excludes cancelled — so a freshly created test
    account is missing from the list and the total reads "1 Manager, 0
    Account". Remove that filter chip, or add *Cancelled* to it, and the
    account appears.
  - Opening **Billing & payments** on a test account gives "Your account's
    access level doesn't include billing information". There is no billing to
    show. Google's post-creation flow lands you on this page anyway.

  Neither affects the API, which treats the account as fully usable. Cancelled
  is a UI display state here, not the account state behind
  `CUSTOMER_NOT_ENABLED`.

What you can and cannot exercise this way: campaign, ad group, ad, keyword and
account structure all read normally, so the provider's querying, paging,
column mapping and filter pushdown are all testable. Serving metrics —
impressions, clicks, cost, conversions — come back empty, because nothing ever
serves. Billing, conversion uploads and bid simulations cannot be tested at
all. A test account left with no activity for a year is deleted.

## Creating a table

Create a table, choose **Google Ads** as the provider, then configure it.

The first step picks the **source**:

- **Report** — one of six curated resources, with columns and metrics chosen
  from checkboxes. This is what you want nearly always.
- **Custom GAQL** — a query you write. Its columns are read from what it
  selects, and typed by asking Google's field catalogue.

### Report resources

| Resource | GAQL `FROM` | Key columns |
| --- | --- | --- |
| Campaigns | `campaign` | id, name, status, channel, bidding strategy, dates, daily budget |
| Ad groups | `ad_group` | id, name, status, type, CPC bid, campaign |
| Ads | `ad_group_ad` | ad id, type, status, approval status, final URLs, ad group, campaign |
| Keywords | `keyword_view` | criterion id, keyword text, match type, status, quality score, CPC bid |
| Search terms | `search_term_view` | search term, status, ad group, campaign |
| Accounts | `customer` | id, name, currency, time zone, manager and test flags |

Any of them can carry metrics: impressions, clicks, CTR, average CPC, cost,
conversions, conversion value, cost per conversion and interactions.

### Units

Two conventions worth knowing before you build a view on these:

- **Money is in the account's currency**, not micros. Google reports
  `cost_micros`; the `cost` column divides it by a million. Filters written
  against the column are converted back before they are sent, so
  `cost > 12.50` does the right thing.
- **Rates are fractions**, exactly as Google reports them. A 5.12% CTR is
  `0.0512`, not `5.12`. Nothing is scaled behind your back — format it in the
  view.

### Segments and the primary key

Ticking **Segment by date** gives one row per day per resource rather than one
total. **Segment by device** does the same per device.

No Ads report row has a primary key of its own, which matters as soon as you
want to sync. A resource has a stable resource name, but segmenting repeats it
once per segment value. So every table here exposes a synthesised **`row_key`**
column — the resource name with the segment values appended — and that is the
primary key. It is what `sync_table_from_external` matches rows on.

### The default window

A date-segmented table with no date filter would read the account's whole
history. So when **Segment by date** is on and a view does not filter on the
`date` column, the query is limited to the last **Default window (days)** days,
30 by default. A view that does filter on `date` replaces the window entirely
rather than intersecting with it.

A table with no date segment gets no window: it is a set of totals, not a time
series.

### Which day is "today"

Every date in a report — `segments.date`, and the window counted back from
today — is a calendar date in the **Google Ads account's** time zone. That zone
is chosen when the account is created and can never be changed afterwards.

Saltcorn usually runs somewhere else. A server in UTC and an account in
`Africa/Kigali` (UTC+2) disagree about the date for two hours out of every
twenty-four, and during those hours a window built from the server's clock
asks for a day that has already ended in the account and misses the day that
is current:

```
instant 2026-10-28T23:30:00Z, 7-day window
  server's date (UTC):       2026-10-21 .. 2026-10-28
  account's date (Kigali):   2026-10-22 .. 2026-10-29
```

So set **Account time zone** on the plugin's **Confirm account** step. It is looked up
from the account automatically when the configuration is saved — the step runs
`SELECT customer.time_zone FROM customer` once — and can be overridden by hand.

If it is left empty the server's time zone is used, which is the old behaviour
and is correct only when the two zones agree. An unrecognised zone name falls
back to the server's rather than failing the read.

## What gets pushed down

The provider sets `disableFiltering`, so it owns filtering, ordering and
paging. GAQL takes most of it:

| Saltcorn filter | Sent to Google as |
| --- | --- |
| `{col: value}` | `field = value` |
| `{col: {in: [...]}}` | `field IN (...)` |
| `{col: {gt, lt, equal}}` | `field > / >= / < / <=` |
| `{col: null}` | `field IS NULL` |
| `{col: [{gt}, {lt}]}` | both bounds, ANDed |
| `orderBy` / `orderDesc` | `ORDER BY field ASC\|DESC` |
| `limit` + `offset` | `LIMIT offset+limit`, head dropped locally |

What stays in Saltcorn, and why:

- **`or`** — GAQL's `WHERE` is a conjunction. There is no `OR` and no
  parenthesis, so a disjunction cannot be expressed at all. A top-level
  condition *beside* an `or` is still pushed down; the `or` is checked locally
  over the wider set.
- **`ilike`** — GAQL's `LIKE` is case-sensitive. Pushing it would drop rows the
  local case-insensitive check matches, which would be a *narrowing*. The rule
  throughout is that anything sent to Google may only ever widen the result
  set, because everything is re-checked locally; a superset is safe and a
  subset silently loses rows.
- **`not`, `_fts`, `inSelect`** — no GAQL form. `inSelect` throws, naming
  itself, rather than quietly returning the wrong rows.
- **`offset`** — GAQL has no `OFFSET`. Paging is by opaque page token, so an
  offset is folded into the `LIMIT` and the head dropped.

A `LIMIT` is only sent when nothing is left to filter locally *and* the
ordering is the API's own. Otherwise the rows GAQL chose to keep are not the
rows that survive the local pass.

### Custom GAQL

Nothing is pushed into a hand-written query. Appending conditions to a query
that may already carry its own `WHERE`, `ORDER BY` and `LIMIT` cannot be done
safely by text, so the query runs exactly as written and the whole filter is
applied in Saltcorn. If you give the query its own `LIMIT`, it caps every view
built on the table.

## Writing

The provider is **read-only**: there is no `insertRow`, `updateRow` or
`deleteRows`. This is not a scope restriction — Google Ads has no read-only
OAuth scope, and the plugin connects with full `adwords` access. It is that
Ads writes go through per-resource `mutate` calls carrying a resource name and
an `update_mask`, which a generic row write cannot build.

Writes are the actions instead, and each can be run as a dry run.

## Actions

All namespaced **Google Ads**:

| Action | What it does |
| --- | --- |
| `google_ads_run_query` | Runs a GAQL query and returns its rows |
| `google_ads_set_campaign_status` | ENABLED / PAUSED / REMOVED on a campaign |
| `google_ads_set_ad_group_status` | The same for an ad group |
| `google_ads_set_campaign_budget` | Sets a campaign budget's daily amount |

**Status** is a dropdown — ENABLED, PAUSED or REMOVED — not something to type.
`REMOVED` cannot be undone through the API.

**The query** in `google_ads_run_query` is a plain GAQL box, written exactly as
it is sent, with no quotes and no backticks. Switch **Query** to *From
expression* only when the query has to be built from the row it runs on; that
box is JavaScript, so the query needs backticks there.

**Targets** are JavaScript expressions over the row, using the same evaluator
as the built-in row actions. A bare column name is already a valid expression,
so the usual answer is just `campaign_id`. They accept either a resource name
or a bare numeric id, so a row read from one of these tables can be fed
straight back in — the Campaigns table's `budget_resource_name` column is what
the budget action wants.

**Budget amounts** are in the account's currency, not micros. An expression
that produces nothing is refused rather than read as a budget of zero, which
would stop the campaign delivering.

### Where the result goes

In a workflow, set **Result variable** and the result lands in the context. Run
from a button and there is nowhere for a return value to go, so each action
reports what it did as a notification instead — `Campaign set to PAUSED.`,
`Query returned 3 rows.`, or `Dry run: ...` when **Dry run** is ticked.

To do anything *with* the rows a query returns, run it in a workflow with a
result variable. A button press can only tell you how many there were.

## Syncing into a local table

Given the daily operation caps, a scheduled sync is usually the right shape
rather than reading the provider live:

1. Create a local table with the same columns.
2. Run the built-in **sync_table_from_external** action on a schedule, matching
   on `row_key`.

Views then read local rows, and the API is touched once per sync. This is also
the way to get filtering GAQL cannot do — `or`, case-insensitive text search —
at full speed.

## Versions

Google ships a major API version roughly quarterly and sunsets each about a
year after release. The version is a configuration field, not a constant, so a
sunset is a one-line change on the configuration page rather than a new release
of the plugin. It currently defaults to `v26`.

A 404 whose path names the version is almost always a sunset; the error message
says so.

## Troubleshooting

**`Error 400: redirect_uri_mismatch`** — the URI registered in Google Cloud
does not match what the plugin sends, character for character. The Connect step
shows the exact value expected. A plain `http://localhost:3000/...` is fine;
localhost is explicitly allowed and exempt from Google's HTTPS requirement.

**`Error 403: access_denied`** — the consent screen is in Testing and your
account is not a test user. Add it under **Audience → Test users**.

**"Google Ads API has not been used in project … before"** — the API is not
enabled for the project that owns the OAuth client.

**A developer-token error** — your Cloud project's access level does not cover
this account, or a token is genuinely required. Try filling in the **Developer
token** field, and check the access level.

**`USER_PERMISSION_DENIED`** — the connected Google account cannot reach the
customer ID. If it is held under a manager, set **Manager account ID**.

**`CUSTOMER_NOT_ENABLED`** — a different problem with a similar-sounding
message. The account is reachable; Google Ads has not enabled it. Either its
signup was never finished (a new account stays unusable until the first
campaign and billing are set up) or it has been cancelled. Check in the Google
Ads UI that the account's status is Active. The account list this plugin
offers comes from `listAccessibleCustomers`, which includes accounts that are
not usable yet.

If the account is an API **test account**, it is reached through its test
manager, so **Manager account ID** must be set to that manager's customer ID.
A test account also shows as cancelled in the Google Ads UI by design, since
it has no billing and never serves ads — that alone is not a fault. See
[Testing without spending](#testing-without-spending).

**Rows shows `NaN` on the table's settings page** — not a counting bug.
Saltcorn prints `NaN` when `countRows` throws, so the real error is whatever
the table's list view reports. Open the view to read it.

**`UNRECOGNIZED_FIELD`** — a field in the query no longer exists in the
selected API version. Google removes fields across major versions, and one
removed field fails the whole query, not just that column. Known example:
`campaign.start_date` and `campaign.end_date` were removed in **v23** and
replaced by `campaign.start_date_time` and `campaign.end_date_time`; this
plugin selects the new names. If you meet this on another field, check
Google's [version diff
tool](https://developers.google.com/google-ads/api/diff-tool) for the
version you have set on step 1.

**`REQUESTED_METRICS_FOR_MANAGER`** — **Customer ID** is a manager account.
A manager holds no campaigns of its own and reports no metrics, so every
table built on it fails. Set **Customer ID** to an account held *under* the
manager and put the manager's ID in **Manager account ID**. The **Confirm
account** step warns about this before any table is built.

**`RESOURCE_EXHAUSTED`** — the daily operation limit is spent. Explorer access
allows 2,880 production operations a day. Sync instead of reading live.

**A query error** — field names are snake_case and dotted
(`campaign.id`, `metrics.cost_micros`), and GAQL has no `OR` and no
parentheses in `WHERE`.

**Reconnecting roughly every 7 days** — the OAuth app is external and still in
Testing. Publish it, or switch to an Internal user type. The plugin records
this and the configuration page reports the connection as broken rather than
showing it as connected.

## Development

```
npm install
npm test
```

154 tests, no network. The Google API is replaced by a fetch stand-in, and the
token source is substituted rather than mocked at the HTTP layer.

For local development against a checkout of Saltcorn, symlink the peer
packages:

```
mkdir -p node_modules/@saltcorn
ln -s ~/saltcorn/packages/saltcorn-data   node_modules/@saltcorn/data
ln -s ~/saltcorn/packages/saltcorn-markup node_modules/@saltcorn/markup
ln -s ~/saltcorn/packages/db-common       node_modules/@saltcorn/db-common
```

### Layout

| File | What is in it |
| --- | --- |
| `index.js` | Plugin registration and the three-step configuration workflow |
| `lib/config.js` | Names, endpoints, the versioned path helper, headers |
| `lib/oauth.js` | The OAuth2 lifecycle: consent, refresh, revoke, persistence |
| `lib/routes.js` | The three consent-flow routes |
| `lib/api.js` | `search` paging, `mutate`, the field catalogue, error reading |
| `lib/gaql.js` | Building GAQL, and `where` → `WHERE` pushdown |
| `lib/resources.js` | The six resources, their columns and GAQL field names |
| `lib/fields.js` | Nested API result → flat row, and the conversions |
| `lib/query.js` | Local `where` evaluation, ordering and paging |
| `lib/provider.js` | The table provider and its configuration workflow |
| `lib/actions.js` | The five actions |

`table_providers`, `actions` and `routes` are exported as **functions** of the
plugin config. With a `configuration_workflow`, `State.registerPlugin` calls
every plugin key, so an object or array there would be invoked and throw.

## Licence

MIT
