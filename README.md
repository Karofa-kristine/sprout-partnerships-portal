# Sprout Partnerships Portal

A live, read-only web portal that surfaces Peoplebox client monitoring data from
the **Peoplebox** tab of the *Partner Products Active Clients* tracker. Internal
access only (Google SSO, restricted to `@sprout.ph`).

Implements the PRD: portfolio KPIs, client-status donut, integration-status
breakdown, searchable/filterable client roster with live headcount sparklines,
a per-client detail drawer (headcount trend + milestones + upsell notes), CSV
export, and manual refresh. Finance-sensitive columns (ARR, PEPM, pricing, AR
remarks) are never read into the render layer.

```
peoplebox-client-portal/
├─ server.js            Express app: sessions, auth gating, /api/data
├─ src/
│  ├─ auth.js           Google OAuth sign-in + domain allow-list
│  ├─ sheets.js         Read-only Sheets API client (service account)
│  ├─ transform.js      Peoplebox tab grid → portal data model
│  └─ cache.js          In-memory TTL cache
└─ public/
   ├─ index.html        App shell (auth-gated)
   ├─ login.html        Sign-in page
   ├─ app.js            Frontend rendering + interactions
   └─ styles.css        Sprout-green console theme
```

## How it works

- **Sign-in** uses Google OAuth. Only verified emails on an allowed domain
  (`ALLOWED_EMAIL_DOMAINS`, default `sprout.ph`) get a session.
- **Data** is read by a **service account** with Viewer access to the sheet —
  separate from the signed-in user, so no per-user sheet permissions are needed.
- `/api/data` returns the transformed model and is cached for
  `CACHE_TTL_SECONDS`. The **Refresh** button calls `/api/data?refresh=1` to
  bypass the cache.

## Setup

### 1. Install

```powershell
cd peoplebox-client-portal
npm install
Copy-Item .env.example .env
```

### 2. Service account (reads the sheet)

1. In the [Google Cloud Console](https://console.cloud.google.com/), create (or
   pick) a project and **enable the Google Sheets API**.
2. **APIs & Services → Credentials → Create credentials → Service account.**
3. Open the service account → **Keys → Add key → JSON**. Save the file as
   `service-account.json` in the project root (it's git-ignored).
4. **Share the spreadsheet** with the service account's `client_email`
   (Viewer is enough).

Point `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` at that file (default
`./service-account.json`), or paste the JSON into `GOOGLE_SERVICE_ACCOUNT_JSON`.

### 3. OAuth client (signs users in)

1. **APIs & Services → OAuth consent screen** → Internal → fill in app name.
2. **Credentials → Create credentials → OAuth client ID → Web application.**
3. Add an **Authorized redirect URI** that matches `OAUTH_REDIRECT_URI`
   exactly, e.g. `http://localhost:3000/auth/google/callback`.
4. Copy the client ID/secret into `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET`.

### 4. Fill in `.env`

See `.env.example`. At minimum set `SESSION_SECRET`, the service-account
credentials, and the OAuth client ID/secret. `SPREADSHEET_ID` is pre-filled.

Generate a session secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5. Run

```powershell
npm start          # http://localhost:3000
# or: npm run dev  (auto-restart on file changes)
```

Open `http://localhost:3000`, sign in with a Sprout account, and the portal
loads live data.

## Adapting to the real tab layout

`src/transform.js` finds tables by **anchor cells**, not fixed row numbers, so it
tolerates inserted rows and reordered columns:

- The per-client table is located by a header row containing both
  `Company Name` and `Peoplebox Switch Status`.
- Month columns are auto-detected by header text like `May 2026`.
- Summary tables are found by their first-cell labels (`Peoplebox`,
  `Peoplebox Integration Status`).

If your tab uses different labels, adjust the alias lists in `mapColumns()` and
the anchor regexes in `transform()`. If the tab name isn't `Peoplebox`, set
`PEOPLEBOX_TAB`.

## Deploying

- Set `SECURE_COOKIES=true` and serve over HTTPS.
- Update `OAUTH_REDIRECT_URI` to the production callback URL and add it to the
  OAuth client's authorized redirect URIs.
- Provide credentials via environment variables (use
  `GOOGLE_SERVICE_ACCOUNT_JSON`) rather than committing files.
- For multiple instances, replace the in-memory session store and `cache.js`
  with a shared store (e.g. Redis).

## Notes / known limitations

- **Per-client integration status** is published in the sheet only as an
  aggregate, so it drives the breakdown chart, not table rows. The per-client
  Peoplebox signal shown is **Peoplebox Switch Status**.
- **Milestones** are the standard implementation track from the source milestone
  table; the sheet does not carry per-client milestone state. When that data
  exists, extend `transform.js` to read it and pass it per client.
