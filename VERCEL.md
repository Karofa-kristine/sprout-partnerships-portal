# Deploying the Sprout Partnerships Portal to Vercel

The app has been adapted from a persistent Express server (Render) to run as a
Vercel serverless function. Code changes already made in this repo:

- **Sessions are now stateless** (`cookie-session` instead of `express-session`),
  so sign-in survives across serverless invocations with no server-side store.
- **`server.js` exports the Express app** and only calls `app.listen()` when run
  directly (local `npm start`), so the same file works both ways.
- **`api/index.js`** is the Vercel entry point (it just re-exports the app).
- **`vercel.json`** routes every path to that function and sets a 60s max
  duration (headroom for RADAR queries).
- The service account is read from the **`GOOGLE_SERVICE_ACCOUNT_JSON`** env var
  (Vercel has no secret files), which `src/sheets.js` already supports.

---

## 1. Push the latest code to GitHub

The repo is already on GitHub (`Karofa-kristine/sprout-partnerships-portal`).
Commit and push the changes above:

```bash
cd "C:\Users\karofac_sprout\Downloads\peoplebox-client-portal"
git add -A
git commit -m "Adapt for Vercel serverless (cookie-session, api/ adapter, vercel.json)"
git push
```

## 2. Create the Vercel project

1. Go to https://vercel.com → **Add New… → Project**.
2. **Import** the `sprout-partnerships-portal` GitHub repo (authorize Vercel for
   GitHub if prompted).
3. Framework preset: **Other**. Leave Build Command empty; Vercel will run
   `npm install` automatically. Click **Deploy** (it will fail the first health
   check until env vars are set — that's expected; add them next).

## 3. Set Environment Variables

In the project → **Settings → Environment Variables**, add each of these for the
**Production** environment (values are the same ones currently on Render):

| Name | Value / notes |
|---|---|
| `SESSION_SECRET` | a long random string — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SECURE_COOKIES` | `true` |
| `SPREADSHEET_ID` | `15hU9z9N8xjyUCsUFRpD5ybEs3VYNbiU-LTRqYocxdYE` |
| `PEOPLEBOX_TAB` | `Peoplebox` |
| `CACHE_TTL_SECONDS` | `60` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the **entire** service-account JSON, pasted as one value |
| `GOOGLE_OAUTH_CLIENT_ID` | your OAuth client id (…`apps.googleusercontent.com`) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | your OAuth client secret |
| `OAUTH_REDIRECT_URI` | `https://<your-vercel-domain>/auth/google/callback` (fill in after step 4) |
| `ALLOWED_EMAIL_DOMAINS` | `sprout.ph,peoplebox.ai,teamtailor.com,disprz.com,hubstaff.com` |
| `INTERNAL_DOMAINS` | `sprout.ph` |
| `RADAR_DB_HOST` | Databricks host (optional — for the Subscriptions tab) |
| `RADAR_DB_TOKEN` | Databricks PAT (optional) |
| `RADAR_WAREHOUSE_ID` | SQL warehouse id (optional) |

> Do **not** set `PORT` — Vercel manages that. Do not upload `.env` or
> `service-account.json`; `.vercelignore` excludes them.

## 4. Note your production domain

After the first deploy, Vercel gives you a domain like
`https://sprout-partnerships-portal.vercel.app`. Use it to:

- Set `OAUTH_REDIRECT_URI` = `https://sprout-partnerships-portal.vercel.app/auth/google/callback`
  (Settings → Environment Variables), then **redeploy** so it takes effect.

## 5. Update the Google OAuth client

In Google Cloud Console → **APIs & Services → Credentials** → your OAuth 2.0
Web client → **Authorized redirect URIs**, add:

```
https://sprout-partnerships-portal.vercel.app/auth/google/callback
```

(Keep the localhost one for local dev.) Save.

## 6. Redeploy & test

- Trigger a redeploy (Vercel → Deployments → ⋯ → Redeploy), or push a commit.
- Visit the domain, sign in with your `@sprout.ph` account, and confirm the
  Overview tiles + Peoplebox report + Subscriptions tab load.

---

## Notes / trade-offs on Vercel

- **Cold starts**: the first request after idle spins up the function (~1–2s).
- **Caching**: the in-memory TTL cache (`src/cache.js`) is per-instance, so
  serverless will re-fetch the sheet more often than a single persistent server
  did. Functionally fine; just slightly more Sheets/RADAR calls.
- **RADAR duration**: `vercel.json` allows 60s per request. Normal queries
  finish in a few seconds; a very slow one could hit the limit (raise the plan's
  limit or optimize the query if that ever happens).
- **Plan/ToS**: Vercel's free **Hobby** tier is for non-commercial use. As an
  internal Sprout tool, this should be on a **Pro** (paid) plan to be compliant.
