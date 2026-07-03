'use strict';

const { google } = require('googleapis');

/**
 * Google OAuth 2.0 sign-in, restricted to one or more email domains
 * (e.g. sprout.ph). On success the user's profile is stored in the session.
 *
 * Routes added by mount():
 *   GET /auth/google           -> redirect to Google consent
 *   GET /auth/google/callback  -> exchange code, verify domain, set session
 *   POST /auth/logout          -> destroy session
 *   GET /api/me                -> current user (or 401)
 */

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.OAUTH_REDIRECT_URI
  );
}

function allowedDomains() {
  return (process.env.ALLOWED_EMAIL_DOMAINS || 'sprout.ph')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** Express middleware: block API access unless signed in. */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'unauthenticated' });
}

function mount(app) {
  app.get('/auth/google', (req, res) => {
    const url = oauthClient().generateAuthUrl({
      access_type: 'online',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      // Hint Google to the org domain (UX only — we still verify below).
      hd: allowedDomains()[0],
    });
    res.redirect(url);
  });

  app.get('/auth/google/callback', async (req, res) => {
    try {
      const { code } = req.query;
      if (!code) return res.redirect('/login.html?error=missing_code');

      const client = oauthClient();
      const { tokens } = await client.getToken(code);
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      const email = (payload.email || '').toLowerCase();
      const domain = email.split('@')[1];

      if (!payload.email_verified || !allowedDomains().includes(domain)) {
        return res.redirect('/login.html?error=domain');
      }

      req.session.user = { email, name: payload.name, picture: payload.picture };
      res.redirect('/');
    } catch (err) {
      console.error('OAuth callback failed:', err.message);
      res.redirect('/login.html?error=oauth');
    }
  });

  app.post('/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get('/api/me', (req, res) => {
    if (req.session && req.session.user) return res.json(req.session.user);
    res.status(401).json({ error: 'unauthenticated' });
  });
}

module.exports = { mount, requireAuth };
