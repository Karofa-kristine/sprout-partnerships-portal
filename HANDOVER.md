# Sprout Partnerships Portal — Handover

Last updated: 2026-11-10. Written to hand this project off to a new session
(e.g. Claude Desktop). Read this first, then `README.md` / `VERCEL.md` for detail.

---

## 1. What this is

A Node/Express web portal giving a **live, read-only view** of Sprout's partner
products, sourced from the **"Partner Products Active Clients" Google Sheet** plus
**RADAR** (Databricks RevOps) for billing. Google SSO; per-product access by email
domain.

- **Live (production):** https://sprout-partnerships-portal.vercel.app
  (renamed 2026-11-11). The old link https://peoplebox-client-portal.vercel.app
  still resolves but **redirects (308)** to the new one: see the "Old link → new
  link" middleware at the top of `server.js` (`OLD_HOSTS`, `CANONICAL_HOST`; the
  target defaults to the host of `OAUTH_REDIRECT_URI`). The Vercel project itself
  may still be named `peoplebox-client-portal`.
- **GitHub:** https://github.com/Karofa-kristine/sprout-partnerships-portal
  (branch `main` — pushing to it is what you deploy from).
- **Local project path:** `C:\Users\karofac_sprout\Downloads\peoplebox-client-portal`
- **Old Render deployment** (`*.onrender.com`): effectively retired — the free
  service went unreachable, which is why we moved to Vercel. Ignore it.

---

## 2. Quick start

### Run locally
```bash
cd "C:\Users\karofac_sprout\Downloads\peoplebox-client-portal"
npm install        # first time only
npm start          # or: npm run dev  (auto-restart on file changes)
```
Then open http://localhost:3000 and sign in with your @sprout.ph Google account.
Local uses `SECURE_COOKIES=false` so sign-in works over plain http.

> Local runs read `.env` + `service-account.json` (both present, both git-ignored).
> The RADAR vars are **not** in local `.env`, so the Billing tab shows
> "not configured" locally unless you add them.

### Deploy to production
Two equivalent ways:
- **Git:** `git push origin main` → Vercel auto-deploys.
- **CLI:** `vercel --prod --yes` (Vercel CLI is installed and logged in as
  `karofac-4762`, team scope `sprout-08f2`).

---

## 3. Architecture / file map

CommonJS Node/Express app. The Express app is exported from `server.js` and served
on Vercel as a native Express service (see `vercel.json`); it also `app.listen()`s
when run directly for local dev.

| File | Responsibility |
|---|---|
| `server.js` | Express app, routes, session, static. Exports `app`. |
| `src/auth.js` | Google OAuth sign-in (`/auth/google…`), `requireAuth`. |
| `src/access.js` | **Per-product access control** (domain → products). |
| `src/sheets.js` | Service-account read of the Google Sheet (`readTab`). |
| `src/transform.js` | Parses a product tab into `{clients, kpis, billing, statusBreakdown, integrationBreakdown, months}`. |
| `src/radar.js` | RADAR/Databricks client (`billing()` over `gold_billing_360`). |
| `src/cache.js` | Tiny in-memory TTL cache (per server instance). |
| `public/index.html` | The whole SPA shell + the big inline `<script>` (nav, access gating, Billing tab, Teamtailor/Disprz/Hubstaff reports). |
| `public/app.js` | The **Peoplebox** tab dashboard (KPIs, donut, roster, drawer, CSV). |
| `public/styles.css` | Styles. |
| `public/login.html` | Login page (only public asset). |
| `public/logos/` | Partner product logos. |

### Key HTTP routes (all auth-gated unless noted)
- `GET /login.html` — public.
- `GET /` — app shell (redirects to login if no session).
- `GET /api/access` — `{email, domain, internal, products[]}` (drives tiles/gating).
- `GET /api/data` — Peoplebox report data (transform of the Peoplebox tab).
- `GET /api/report/:product` — full report for `teamtailor|disprz|hubstaff` (and
  `peoplebox`); same transform, per-product tab. Enforces `allowedProducts`.
- `GET /api/billing` — RADAR billing/AR (gold_billing_360) for Peoplebox clients.
- `GET /api/rawtab/:key` — legacy generic raw tab dump; no longer used by the UI
  (route still present, harmless).

---

## 4. Environment variables

**Never commit secrets.** They live in two places:
- **Local:** `.env` (+ `service-account.json`) — git-ignored.
- **Production:** Vercel → Project Settings → Environment Variables (manage with
  `vercel env ls|add|rm … production`).

| Var | Purpose | Notes |
|---|---|---|
| `SESSION_SECRET` | signs the cookie session | long random string |
| `SECURE_COOKIES` | `true` in prod (HTTPS), `false` local | |
| `SPREADSHEET_ID` | source sheet | `15hU9z9N8xjyUCsUFRpD5ybEs3VYNbiU-LTRqYocxdYE` |
| `PEOPLEBOX_TAB` | `Peoplebox` | also `TEAMTAILOR_TAB`/`DISPRZ_TAB`/`HUBSTAFF_TAB` default to the product name |
| `CACHE_TTL_SECONDS` | `60` | |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Sheets read creds | **prod** uses this inline JSON (Vercel has no secret files); local uses `GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./service-account.json` |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Google OAuth web client | |
| `OAUTH_REDIRECT_URI` | prod: `https://sprout-partnerships-portal.vercel.app/auth/google/callback` (its host is also the redirect target for the old link) | **must** also be listed in the Google OAuth client's Authorized redirect URIs (Google Cloud Console → APIs & Services → Credentials) |
| `ALLOWED_EMAIL_DOMAINS` | sign-in domains | `access.js` also unions in internal + all product domains automatically |
| `INTERNAL_DOMAINS` | `sprout.ph` | internal = sees all products |
| `RADAR_DB_HOST` | Databricks host | **bare hostname, NO `https://`** — see gotcha below |
| `RADAR_DB_TOKEN` | Databricks PAT | expires periodically — see gotcha |
| `RADAR_WAREHOUSE_ID` | SQL warehouse id | |

---

## 5. Data sources

### Google Sheet (per-product tabs)
`transform.js` parses each product tab by **anchor columns** (finds the header row
with "Company Name" + a "Client Status" column), not fixed positions. Shared schema
across Peoplebox / Teamtailor / Disprz / Hubstaff: Company Name, Client Status,
Integration Status, Subscription start/end, CSM. Peoplebox additionally has billing
status columns + monthly headcount columns; Disprz/Hubstaff have headcount;
Teamtailor has neither.

### RADAR (Databricks) — Billing tab
`src/radar.js` → `billing()` queries **`shared.revops.gold_billing_360`** (invoice-
level AR) via the RADAR proxy (`https://radar-revops.vercel.app`), scoped to the
tracker's Peoplebox clients by `hubspot_company_id`. Returns ~930 invoices with
amount / paid / balance / collection status / aging / days overdue. Same RADAR
world as the separate "Client Payment Monitoring" dashboard.

**Drill-down (added 2026-11-10, not yet verified against live RADAR):** the Billing
tab now lists **clients first** (invoice count, latest invoice, amount / paid /
balance, overdue invoices, max days overdue; sorted by balance). Clicking a client
expands its invoices (from gold_billing_360); clicking an invoice loads its **line
items** via `GET /api/billing/lines?invoice=<number>` → `radar.invoiceLines()`, which
joins **`shared.revops.silver_ns_transaction_line`** to **`shared.revops.silver_ns_invoice`**
on the invoice number and drops mainline/tax lines. The silver column names weren't
known when this was written, so `invoiceLines()` runs `DESCRIBE TABLE` once per server
instance and picks join columns from candidate lists (`CAND` in `radar.js`). If no
match is found, the line-item panel shows an error listing the actual columns — add
the right name to `CAND` and redeploy. The endpoint only serves invoice numbers that
are already in the Peoplebox billing result. The UI shows Line / Item / Description /
Qty / Rate / Amount / Tax when those columns exist, otherwise every non-empty column.

**Validated 2026-11-10** against the prior source (`netsuite_invoices_summary`) for
the same Peoplebox clients: identical **930 invoices**, **100% invoice-number overlap**
(0 only-in-either), **all 930 amounts match exactly**, and **totals are identical
(₱141,647,855.55)**. AR self-consistency also holds: amount = paid (₱133,856,664.89) +
balance (₱7,791,190.66) on every row (0 inconsistent). So gold_billing_360 reconciles
with the old NetSuite source and adds the paid/balance/aging detail. (Of the 930,
101 were cancelled; the report now **excludes cancelled** invoices → 829 shown,
total ₱113,188,639.61, outstanding balance ₱7,791,190.66.)

---

## 6. Features (current state)

**Overview** landing with a tile per product. **Peoplebox** tab (`app.js`):
- KPI cards under an **"Integration Status"** heading: Active clients · Ongoing CRF ·
  Integrations activated · Needs action (definitions in §7).
- Client-status donut, Billing & payments band, sortable/filterable client roster.
- Roster shows **one headcount column per month (Jan 2026 → current)**, auto-
  extending; client drawer shows month-by-month + trend chart.
- **Peoplebox Billing** card → the RADAR `gold_billing_360` report.

**Teamtailor / Disprz / Hubstaff** reports (`makeProductReport` in `index.html`):
same dashboard (KPIs + donut + roster), no billing band (no billing columns in those
tabs); month columns for Disprz/Hubstaff (2026 cols currently empty in the sheet),
none for Teamtailor.

---

## 7. Integration KPI definitions (agreed with user)

Computed in `transform.js buildKpis`, scoped to **Active** clients, excluding ones
that don't need an integration.
- **Base ("relevant")** = Client Status `Active` AND Integration Status NOT in
  {`No Sprout HR`, `No Activation Required`, `Churn`}.
- **Integrations activated** = relevant with `Activated`; the % is of the relevant base.
- **Needs action** = relevant tagged `Pending` or `SSO only (no data sync required)`
  ONLY (ongoing CRF is **not** counted here).
- **Ongoing CRF** (replaced the old "Ongoing implementation" card) = **Active**
  clients with Integration Status matching `/crf/i`.
- Headcount KPI "Headcount on Paid Peoplebox Invoices" = sum of **licenses
  purchased** (col U, `c.lic`) for clients whose Peoplebox invoice remark = `Paid`.

Live Integration Status vocabulary: Activated, Pending, SSO only (no data sync
required), Churn, Ongoing CRF, No Sprout HR, No Activation Required.

---

## 8. Access control & view-only (per email domain)

In `src/access.js`. All partner + internal domains can **sign in**; the restriction
is which **product** each can open — enforced **server-side** (routes 403 otherwise),
not just UI.

| Domain | Products | On login |
|---|---|---|
| `sprout.ph` (internal) | all four | lands on Overview; sees all tiles; **keeps Export CSV** |
| `peoplebox.ai` | Peoplebox | redirected straight to its tab |
| `teamtailor.com` | Teamtailor | redirected straight to its tab |
| `disprz.com` | Disprz | redirected straight to its tab |
| `hubstaff.com` | Hubstaff | redirected straight to its tab |

Partner UI rules (frontend, in `index.html`):
- **View-only:** all Export CSV buttons hidden for non-internal accounts.
- Single-product partners are **auto-redirected** to their tab on login.
- If a partner reaches the Overview, non-accessible tiles are **locked** (dimmed +
  "🔒 No access") and blocked from opening (toast).

> Note: hiding export is a UI restriction; the hard boundary is the server-side
> per-product gate (a partner can never load another product's data).

---

## 9. Known gotchas

1. **RADAR_DB_HOST must be the bare hostname** (`adb-….azuredatabricks.net`), **no
   `https://`** — the proxy does a raw DNS lookup on the value, so a scheme prefix
   gives `ENOTFOUND`. (`.env.example` shows https:// but that's wrong for the proxy.)
2. **Databricks PAT (`RADAR_DB_TOKEN`) expires.** When the Billing tab suddenly shows
   an error/empty, the token has likely expired → generate a new one in the Databricks
   workspace (User Settings → Developer → Access tokens) and update it on Vercel, then
   redeploy. The same token powers the Client Payment Monitoring dashboard.
3. **In-memory cache is per server instance.** On Vercel (serverless) each cold start
   starts empty, so the sheet/RADAR are re-fetched more often than on a single
   persistent server. Functional, just a few extra reads. Use a tab's Refresh button
   to force-bust the cache after a query change.
4. **Cookie sessions** (`cookie-session`) — the whole session is the small `user`
   object in a signed cookie; there's no server store. Needed for serverless.
5. **Monthly headcount columns**: Peoplebox 2026 months are populated; Disprz/Hubstaff
   currently only have 2025 data, so their Jan 2026+ columns render blank until filled.
6. Windows line-endings: git shows `LF will be replaced by CRLF` warnings on commit —
   harmless.

---

## 10. Pending items (checklist)

Carried over from the build sessions. Nothing here is broken — these are
enhancements, cleanups, verifications, and ongoing maintenance.

### A. Needs the user's action / decision
- [ ] **Vercel plan:** Hobby (free) tier is for non-commercial use; this is an internal
      business tool, so strictly it should be on **Pro**. Not a technical blocker.
- [ ] **Re-enter the new RADAR token** in the separate **Client Payment Monitoring**
      dashboard (same Databricks connection; its old token was the expired one).
- [ ] **Confirm the partner experience** with a real partner-domain test account
      (peoplebox.ai / teamtailor.com / disprz.com / hubstaff.com) — view-only export,
      auto-redirect to their tab, locked tiles. Can't be verified from a @sprout.ph login.
- [ ] **Decommission old Render services** if not already — both `*.onrender.com`
      services are dead/retired; delete them in the Render dashboard to avoid confusion.

### B. Billing tab (gold_billing_360) refinements — discussed, not done
- [x] ~~Optional toggle to narrow from all invoices to Peoplebox-memo only~~ — DONE
      (2026-11-10, not yet verified against live RADAR): `billing()` now also selects
      `invoice_memo AS memo`; the Billing tab shows a **Memo** column, memo is searchable,
      and a filter dropdown switches between "All invoices" and "Peoplebox memo only"
      (memo contains "peoplebox", case-insensitive; ~48 expected before cancel-exclusion).
- [x] ~~Hide cancelled invoices~~ — DONE (2026-11-10): the `gold_billing_360` query now
      excludes any `collection_status`/`invoice_status` containing "cancel" (930 → 829).
- [ ] Make the Billing table **columns sortable** (click headers) like the Peoplebox roster.

### C. Feature enhancements
- [ ] **Billing tab for Teamtailor / Disprz / Hubstaff** — same `gold_billing_360`
      approach; needs `hubspot_company_id` surfaced from those tabs in `transform.js`
      (Peoplebox already maps `c.hsid`).
- [ ] **Disprz/Hubstaff monthly headcount**: their Jan 2026+ columns are blank until
      that data is entered in the sheet (they currently hold only 2025 figures). No code
      change — just awaiting sheet data. Optionally, show their existing 2025 months.
- [ ] **Teamtailor** has no headcount data at all → no month columns; revisit if that
      data gets added to its tab.
- [ ] Optionally lock partners entirely to their one tab (hide the top-bar "Overview"
      button for them) so they can't reach the locked-tile Overview at all.

### D. Tech debt / cleanup (safe to leave)
- [ ] `src/radar.js` old line-item query is gone, but `server.js` still has the unused
      `/api/rawtab/:key` route and `makeRawReport` is replaced — dead code could be removed.
- [ ] `app.js` has leftover `hcTrendCell()` / sparkline-cell helpers no longer used after
      switching the roster to per-month columns — harmless, removable.

### E. Ongoing maintenance (recurring)
- [ ] **RADAR token expiry** — Databricks PATs expire. When the Billing tab errors/empties,
      regenerate the token and update it on Vercel (see §9 gotcha #2). This will recur.

### Verification still owed (do after any related change)
- [ ] Open each tab in the live site and eyeball: Peoplebox KPIs/roster/month columns,
      Teamtailor/Disprz/Hubstaff reports, and the Billing tab totals vs. expectation.
      (Automated checks pass; final rendered-pixel confirmation is the user's.)

---

## 11. Continuing in Claude Desktop

1. Open this project folder in Claude Desktop.
2. Read this file, then `src/transform.js` (data shaping) and `public/app.js` +
   the inline script in `public/index.html` (UI) — that's where most logic lives.
3. To verify RADAR work, the pattern used in this project was a throwaway script at
   the repo root that sets the 3 RADAR env vars, `require('./src/radar')`, and calls
   `billing(ids)` with ids pulled from the Peoplebox tab — run with `node`, then delete.
4. After any change: `git add -A && git commit && git push` (auto-deploys), or
   `vercel --prod --yes`. Then hard-refresh the live site (Ctrl+Shift+R).

Deploy/env detail lives in `VERCEL.md`. Original build notes in `README.md`/`DEPLOY.md`.

---

## ChannelHub tab (added 2026-11-10, not yet verified against live RADAR)

Overview tile **ChannelHub** → `#channelhubPanel`, UI in `public/channelhub.js`.
**Internal-only**: product key `channelhub` is granted to `INTERNAL_DOMAINS` accounts
only (`INTERNAL_ONLY` in `src/access.js`); partner domains never see it.

Data (RADAR, per the RevOps table spec — only documented columns are used):
- `GET /api/channelhub` → `radar.channelDeals()`: `shared.revops.silver_deals` where
  `pipeline_name = 'Unified Channel Pipeline'`, LEFT JOIN `silver_company` on
  `Company_id = company_id` for the company name. Cached for `CACHE_TTL_SECONDS`;
  `?refresh=1` (the 🔄 Refresh button) bypasses the cache.
- `GET /api/channelhub/lines?deal=<deal_id>` → `radar.channelDealLines()`:
  `silver_line_items` for that deal (numeric id only; must be in the channel pipeline).

UI: date range **Year to date** (default) / **All time**; search, stage and sales-rep
filters. KPIs: active channel partners, deals created (create_date basis), open
pipeline (current MQL + Opportunity snapshot, not date-filtered), deals won and won
MRR (close_date basis; won = `client_journey_stage = 'Customer'`), win rate (won vs
Closed Lost). "Deal pipeline by stage" bars, then a **partner table** (grouped by
`partner_on_record`; blank → "(No partner on record)") → click a partner for its
deals → click a deal for its line items. YTD scope = deal created OR closed this year.

**ChannelHub update (2026-11-10):** limited to **leads created 2025–2026** —
`channelDeals()` filters `create_date >= '2025-01-01' AND < '2027-01-01'` (`CH_FROM`/
`CH_TO` in `radar.js`). The YTD/All-time toggle was replaced by a **lead created year**
switch (2025–2026 / 2026 / 2025); every KPI is for the leads created in that period
(cohort view, create_date basis). Partner table column "Deals" → **"Leads"**.

---

## Peoplebox Ongoing Leads (added 2026-11-10, not yet verified against live RADAR)

Card **"Peoplebox Ongoing Leads"** inside the Peoplebox tab → `#pbleadsPanel`, UI in
`public/pbleads.js`. **Internal-only** (product key `pbleads` in `INTERNAL_ONLY`,
`src/access.js`); the card is hidden for partner accounts and the API returns 403.

`GET /api/peoplebox/leads` → `radar.peopleboxLeads()` runs two queries:
- **Leads:** `silver_deals` where `client_journey_stage IN ('MQL','Opportunity')`
  (any pipeline) that have ≥1 `silver_line_items` row whose `product_name` or
  `parent_product` contains "peoplebox" or "perform pro" (covers "Peoplebox",
  "Perform Pro", "Sprout Perform Pro"); joined to `silver_company` for the name.
  Includes the Peoplebox-only line-item amount/MRR and product list per deal.
- **Line items:** those Peoplebox line items for the same open deals (shown when a
  lead row is clicked).
UI: search (deal / deal ID / company / rep / product), pipeline, stage and rep filters,
🔄 Refresh, KPIs (ongoing leads, MQL, Opportunity, Peoplebox line-item value + MRR).

**Update (2026-11-10): renamed to "Peoplebox Leads", now ALL leads from 2025 onward.**
`peopleboxLeads()` no longer limits to open deals: it returns every deal with a
Peoplebox / Perform Pro line item created on/after **2025-01-01 with no end date**
(`PB_SCOPE` in `radar.js`), any `client_journey_stage`. Also returns `close_date`.
UI adds a **Year** filter (built from the data, so new years appear automatically)
and a **Status** filter (Ongoing = MQL + Opportunity / Won = Customer / Lost = Closed
Lost). KPIs: Peoplebox leads, Ongoing, Won (+ Peoplebox value, win rate), Lost,
Peoplebox line-item value + MRR, Forecast: Commit (ongoing leads). "Close date"
column shows the actual close date, or the projected one marked "proj.".

**Update (2026-11-10): Peoplebox Leads column filters.** Filters now sit in a row
under the table headers: Pipeline, Stage, Journey, Sales rep (dropdowns) and Created,
Projected close date (from/to date pickers). "Clear column filters" resets them. Year,
Status, Forecast and search stay in the toolbar. The **Partner** column was removed.
"Projected close date" shows `projected_close_date`, or the actual `close_date`
(tagged "closed") when a closed lead has no projected date; its filter uses that value.

**Update (2026-11-10): Peoplebox Leads limited to 2025–2026.** `PB_SCOPE` in
`radar.js` is now `create_date >= '2025-01-01' AND < '2027-01-01'` (replaces the
earlier "2025 onward, no end date"). Year filter reads "All years (2025–2026)".

**Update (2026-11-10): Peoplebox Leads — stage exclusions + multi-select filters.**
- `PB_SCOPE` also excludes deals whose `stage_label` is **Project Handover** or
  **Contract Signed** (`PB_EXCLUDED_STAGES` in `radar.js`, case/space-insensitive).
  Applies to both the leads and line-items queries.
- Every dropdown filter is now a **multi-select** (tick boxes + Select all / Clear):
  Year, Status, Forecast (toolbar) and Pipeline, Stage, Journey, Sales rep (column
  headers). Nothing ticked = all. Lists are `position:fixed` (`placePop()` in
  `pbleads.js`) so the scrolling table can't clip them; they close on outside click,
  Esc, or page/table scroll. "Clear filters" resets every filter incl. the date ranges.

**Update (2026-11-12): Peoplebox Leads shared with peoplebox.ai.** `PARTNER_EXTRAS` in
`src/access.js` grants `pbleads` to `peoplebox.ai` accounts on top of their Peoplebox
tab (API + card visibility follow automatically). ChannelHub stays internal-only.
Partner accounts are still auto-opened on their one product tab: the login redirect
in `index.html` ignores sub-reports (`SUBREPORTS = ['pbleads']`) when counting products.
Note: this shows Peoplebox's partner pipeline (deal names, companies, sales reps, amounts)
to Peoplebox users; export buttons stay hidden for partner accounts.

**Update (2026-11-12): ChannelHub hidden from partner accounts.** The Overview's
ChannelHub heading + tile (`#chHead`, `#chtiles`) start hidden and are shown only when
`/api/access` includes `channelhub` (internal `INTERNAL_DOMAINS` accounts). Partner
accounts (Peoplebox, Teamtailor, Disprz, Hubstaff) never see it; `/api/channelhub*`
already returns 403 for them.

---

## Teamtailor / Disprz / Hubstaff — Billing + Leads (added 2026-11-12, not yet verified against live RADAR)

Each of these product tabs now has the same two cards as Peoplebox: **<Product> Billing**
and **<Product> Leads** (tabs `ttbill`/`ttleads`, `dzbill`/`dzleads`, `hsbill`/`hsleads`).
Config lives in `PARTNER_REPORTS` (inline script in `index.html`) and `PRODUCT_TERMS`
(`src/radar.js`).

**Which line items count** (`product_name` or `parent_product` contains, case-insensitive):
- Teamtailor: "teamtailor" or "team tailor" (TeamTailor - (1–200 / 201–500 / 501–1000 / +1000 FTE))
- Disprz: "disprz" (Disprz - LXP Essentials, Disprz - LMS Essentials)
- Hubstaff: "hubstaff" (Hubstaff Team / Enterprise Plan, Add-on: Hubstaff - …)

**Leads** — `GET /api/leads/:product` → `radar.productLeads()`: identical query/scope to
Peoplebox Leads (created 2025–2026, Project Handover / Contract Signed excluded). UI is
`public/leads-report.js`, **generated** from `public/pbleads.js` + the Peoplebox Leads panel
markup (keep them in sync; the generator was a one-off script — re-derive by hand if needed).

**Billing** — `GET /api/pbilling/:product` (+ `/lines?invoice=`) → `radar.productBilling()`.
These sheet tabs have **no HubSpot Company ID column**, so clients come from RADAR instead:
companies with a **won** deal (`client_journey_stage = 'Customer'`) that has one of the
product's line items (`product_status` Availed or blank). Their invoices come from
`gold_billing_360` like Peoplebox (all invoices for those clients, any product; cancelled
excluded); the memo filter offers "<Product> memo only". UI is `public/billing-report.js`.
If a client is missing, it likely has no won HubSpot deal with a matching line item.

**Access** — Billing rides on the product key (each partner sees its own, like Peoplebox
Billing). Leads keys `ttleads`/`dzleads`/`hsleads` are in `INTERNAL_ONLY` and shared with
the matching partner domain via `PARTNER_EXTRAS` (`src/access.js`). Styles: shared classes
`.bl-report` / `.ld-report` (copied from the Peoplebox report CSS, bottom of `styles.css`).

**Update (2026-11-12): every won deal counts toward Won / win rate.** The Leads queries
(Peoplebox + Teamtailor/Disprz/Hubstaff) no longer drop Project Handover / Contract Signed
deals; they return them with `excluded_stage = 'Y'` (`PB_EXCLUDED_FLAG` in `radar.js`).
The Leads UI (`pbleads.js`, regenerated `leads-report.js`) keeps those deals out of the
table and filter lists, but adds the **won** ones (journey = Customer) to the Won KPI and
win rate (same Year/Status/filters applied). The Won card notes "incl. N in Project
Handover / Contract Signed (not listed below)".

**Update (2026-11-12): RADAR speed + reliability.**
- `src/radar.js` `runStatement`: submits with `wait_timeout: '10s'` so quick queries return
  inline (no polling); polls back off 0.5s → 2s; submit/poll calls retry network errors,
  HTTP 429 and 5xx (after 1s, then 3s); one query may take up to `RADAR_QUERY_BUDGET_MS`
  (default 240000, under Vercel's 300s limit). Multi-chunk results are now read in full
  (extra chunks fetched straight from Databricks with the server-side token). Each query
  logs `[radar] query ok in Nms, N rows` in the Vercel logs.
- `server.js` `radarLoad()`: every RADAR endpoint caches for `RADAR_CACHE_TTL_SECONDS`
  (default 1800 = 30 min; separate from the sheet's `CACHE_TTL_SECONDS`), shares one
  in-flight query per report, and if RADAR fails serves the last good copy (up to 24h,
  same server instance) with `stale: true`. Refresh buttons still bypass the cache.
- `src/cache.js`: keeps expired entries for `getStale()`.
- `public/radar-fetch.js`: `radarFetch()` (used by all RADAR reports) retries once after 3s on
  network/5xx errors; `radarStaleNote()` adds a warning to the report's "as of" line when
  the server sent the last saved copy.
- Fixed the `channelDealLines` deal-id check (`/^d+$/` → `/^\d+$/`), which made every
  ChannelHub line-item drill-down fail with "Invalid deal id".
- `leads-report.js` was patched directly (same change as `pbleads.js`).
- Still slow after idle: the first query wakes the Databricks warehouse; only the
  warehouse's auto-stop / serverless setting changes that.
