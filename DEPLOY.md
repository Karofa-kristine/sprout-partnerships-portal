# Deploying to Render

The app is ready to deploy. Non-secret config is in `render.yaml`; secrets are
entered in the Render dashboard so they never live in the repo.

> Secret values come from **your local files** (not committed):
> - `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` → from `.env`
> - service-account key → the contents of `service-account.json`

## 1. Put the code on GitHub

1. Create a **new, empty, private** repo at <https://github.com/new> named
   `peoplebox-client-portal`. Do **not** add a README, .gitignore, or license.
2. Copy the repo URL, then from the project folder push to it:
   ```powershell
   git remote add origin https://github.com/<you>/peoplebox-client-portal.git
   git push -u origin main
   ```
   The first push opens a browser to sign in to GitHub (Git Credential Manager).

## 2. Create the Render service (Blueprint)

1. Sign up / in at <https://render.com> using **GitHub**, and authorize access
   to the new repo.
2. **New + → Blueprint**, pick the `peoplebox-client-portal` repo. Render reads
   `render.yaml` and proposes the web service. Click **Apply**.
3. When prompted, fill the secret env vars (leave `OAUTH_REDIRECT_URI` for now):
   - `GOOGLE_OAUTH_CLIENT_ID` — from `.env`
   - `GOOGLE_OAUTH_CLIENT_SECRET` — from `.env`
4. Add the service account as a **Secret File**:
   - Service → **Environment → Secret Files → Add Secret File**
   - Filename: `service-account.json`
   - Contents: paste everything inside your local `service-account.json`
   - (It mounts at `/etc/secrets/service-account.json`, which
     `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` already points to.)

## 3. Wire up the production URL + OAuth

1. Render assigns a URL like `https://peoplebox-client-portal.onrender.com`
   (may have a random suffix if the name is taken). Copy it.
2. In Render, set the env var:
   - `OAUTH_REDIRECT_URI = https://<your-url>/auth/google/callback`
3. In **Google Cloud Console → APIs & Services → Credentials → your OAuth client**:
   - Under **Authorized redirect URIs**, add the exact same
     `https://<your-url>/auth/google/callback`.
   - Ensure the **OAuth consent screen** is **Internal** (so every `@sprout.ph`
     user can sign in without per-user test-user entries).
4. Render redeploys automatically on env changes (or hit **Manual Deploy**).

## 4. Test

Open `https://<your-url>`, sign in with a `@sprout.ph` account — the dashboard
should load live data.

## Notes

- **Free plan** idles after ~15 min of inactivity; the next visit takes ~30–50s
  to wake, then it's fast. Upgrade the service to a paid instance for always-on.
- **Updates**: `git push` to `main` auto-deploys (`autoDeploy: true`).
- The service account must remain a **Viewer** on the source spreadsheet.
