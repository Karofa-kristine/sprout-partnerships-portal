# Sprout Partnerships Portal — Handover

Last updated: 2026-11-10. Written to hand this project off to a new session
(e.g. Claude Desktop). Read this first, then `README.md` / `VERCEL.md` for detail.

---

## 1. What this is

A Node/Express web portal giving a **live, read-only view** of Sprout's partner
products, sourced from the **"Partner Products Active Clients" Google Sheet** plus
**RADAR** (Databricks RevOps) for billing. Google SSO; per-product access by email
domain.

- **Live (production):** https://peoplebox-client-portal.vercel.app
  (Vercel project is named `peoplebox-client-portal`; that's just the project name —
  the app is the "Sprout Partnerships Portal".)
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
| `OAUTH_REDIRECT_URI` | prod: `https://peoplebox-client-portal.vercel.app/auth/google/callback` | **must** also be listed in the Google OAuth client's Authorized redirect URIs (Google Cloud Console → APIs & Services → Credentials) |
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

## 10. Open items / things the user may ask next

- **Billing tab scope:** currently **all** invoices for Peoplebox clients (~930),
  including non-Peoplebox and cancelled ones. Optional refinements discussed but not
  done: a toggle to narrow to `invoice_memo LIKE '%peoplebox%'` (~48), and/or hide
  `Cancelled - CM/CN` collection-status rows.
- **Teamtailor/Disprz/Hubstaff** could also get a Billing tab the same way (they have
  `hubspot_company_id` via their sheet tabs — would need mapping in their transform).
- Subscriptions/billing table columns aren't individually sortable yet (the Peoplebox
  roster is).

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
