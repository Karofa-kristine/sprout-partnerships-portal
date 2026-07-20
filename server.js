'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const auth = require('./src/auth');
const cache = require('./src/cache');
const radar = require('./src/radar');
const { readTab } = require('./src/sheets');
const { transform } = require('./src/transform');

const app = express();
const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TAB = process.env.PEOPLEBOX_TAB || 'Peoplebox';
const TTL = Number(process.env.CACHE_TTL_SECONDS || 300);
const CACHE_KEY = 'peoplebox-data';

// ── Per-product access control ───────────────────────────
// Internal Sprout domains see every product. Each partner domain sees ONLY its
// own product. Peoplebox Subscriptions rides on Peoplebox access.
const PRODUCT_DOMAINS = {
  peoplebox: 'peoplebox.ai',
  teamtailor: 'teamtailor.com',
  disprz: 'disprz.com',
  hubstaff: 'hubstaff.com',
};
function internalDomains() {
  return (process.env.INTERNAL_DOMAINS || 'sprout.ph')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function userDomain(req) {
  const email = (req.session && req.session.user && req.session.user.email) || '';
  return (email.split('@')[1] || '').toLowerCase();
}
function allowedProducts(req) {
  const d = userDomain(req);
  if (internalDomains().includes(d)) return Object.keys(PRODUCT_DOMAINS);
  return Object.keys(PRODUCT_DOMAINS).filter((k) => PRODUCT_DOMAINS[k] === d);
}
// Middleware: block a route unless the signed-in user may see `product`.
function requireProduct(product) {
  return function (req, res, next) {
    if (allowedProducts(req).indexOf(product) >= 0) return next();
    return res.status(403).json({ error: 'forbidden', message: 'Your account does not have access to this product.' });
  };
}

// Every internal + partner domain must be able to SIGN IN (access to specific
// products is enforced separately, per tile). Augment ALLOWED_EMAIL_DOMAINS in
// code so partners aren't blocked at the Google gate even if the env var wasn't
// updated on the host.
(function ensureSignInDomains() {
  const set = {};
  (process.env.ALLOWED_EMAIL_DOMAINS || 'sprout.ph')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .concat(internalDomains())
    .concat(Object.values(PRODUCT_DOMAINS))
    .forEach((d) => { if (d) set[d] = 1; });
  process.env.ALLOWED_EMAIL_DOMAINS = Object.keys(set).join(',');
})();

app.set('trust proxy', 1);
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: String(process.env.SECURE_COOKIES) === 'true',
      maxAge: 1000 * 60 * 60 * 8, // 8h
    },
  })
);

// ── Auth routes (/auth/google, /api/me, ...) ─────────────
auth.mount(app);

// The login page is the only public asset.
app.get('/login.html', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
);

// Gate the app shell: send unauthenticated users to the login page.
app.get('/', (req, res) => {
  if (!(req.session && req.session.user)) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Data API (authenticated) ─────────────────────────────
async function loadData({ force } = {}) {
  if (!force) {
    const cached = cache.get(CACHE_KEY);
    if (cached) return { ...cached, cached: true };
  }
  const grid = await readTab(SPREADSHEET_ID, TAB);
  const data = transform(grid, { spreadsheetId: SPREADSHEET_ID, tab: TAB });
  cache.set(CACHE_KEY, data, TTL);
  return { ...data, cached: false };
}

// Which products the signed-in user may access (drives the Overview tiles).
app.get('/api/access', auth.requireAuth, (req, res) => {
  res.json({
    email: (req.session.user && req.session.user.email) || '',
    domain: userDomain(req),
    internal: internalDomains().includes(userDomain(req)),
    products: allowedProducts(req),
  });
});

app.get('/api/data', auth.requireAuth, requireProduct('peoplebox'), async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const data = await loadData({ force });
    res.json(data);
  } catch (err) {
    console.error('Failed to load sheet data:', err);
    res.status(502).json({ error: 'sheet_read_failed', message: err.message });
  }
});

// ── Peoplebox subscriptions from RADAR (Databricks) ──────
// Joins RADAR invoice line items to the tracker's clients by HubSpot Company ID.
const SUBS_CACHE_KEY = 'radar-subscriptions';

app.get('/api/subscriptions', auth.requireAuth, requireProduct('peoplebox'), async (req, res) => {
  try {
    if (!radar.isConfigured()) {
      return res.json({ configured: false, rows: [] });
    }
    const force = req.query.refresh === '1';
    if (!force) {
      const cached = cache.get(SUBS_CACHE_KEY);
      if (cached) return res.json({ configured: true, cached: true, rows: cached });
    }
    const data = await loadData({});
    const ids = [...new Set((data.clients || []).map((c) => c.hsid).filter(Boolean))];
    const rows = await radar.subscriptions(ids);
    cache.set(SUBS_CACHE_KEY, rows, TTL);
    res.json({ configured: true, cached: false, clientCount: ids.length, rows });
  } catch (err) {
    console.error('Failed to load RADAR subscriptions:', err);
    res.status(502).json({ error: 'radar_failed', message: err.message });
  }
});

// ── Raw sheet-tab dumps (Teamtailor, Disprz, Hubstaff) ───
// Reads a whitelisted tab and returns all columns + rows generically, so the
// portal reflects whatever the sheet holds (no fixed schema). The key must be
// in RAW_TABS — the route never reads an arbitrary caller-supplied tab name.
const RAW_TABS = {
  teamtailor: process.env.TEAMTAILOR_TAB || 'Teamtailor',
  disprz: process.env.DISPRZ_TAB || 'Disprz',
  hubstaff: process.env.HUBSTAFF_TAB || 'Hubstaff',
};

app.get('/api/rawtab/:key', auth.requireAuth, async (req, res) => {
  const key = req.params.key;
  const tab = RAW_TABS[key];
  if (!tab) return res.status(404).json({ error: 'unknown_tab' });
  if (allowedProducts(req).indexOf(key) < 0) {
    return res.status(403).json({ error: 'forbidden', message: 'Your account does not have access to this product.' });
  }
  try {
    const force = req.query.refresh === '1';
    const cacheKey = 'rawtab-' + key;
    if (!force) {
      const cached = cache.get(cacheKey);
      if (cached) return res.json({ cached: true, ...cached });
    }
    const grid = await readTab(SPREADSHEET_ID, tab);
    const hi = grid.findIndex((r) => r.some((c) => c && c.trim()));
    const headers = hi < 0 ? [] : grid[hi].map((c, i) => (c && c.trim() ? c.trim() : 'Column ' + (i + 1)));
    const rows = [];
    for (let r = hi + 1; r < grid.length; r++) {
      const row = grid[r];
      if (row.every((c) => !c || !c.trim())) continue;
      rows.push(headers.map((_, i) => (row[i] == null ? '' : String(row[i]).trim())));
    }
    const out = { headers, rows };
    cache.set(cacheKey, out, TTL);
    res.json({ cached: false, ...out });
  } catch (err) {
    console.error('Failed to load tab', key, err);
    res.status(502).json({ error: 'tab_failed', message: err.message });
  }
});

// Static assets (css/js). Note: index.html is served only via the gated route
// above, so static files here are the supporting css/js + login page.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => {
  console.log(`Sprout Partnerships Portal listening on http://localhost:${PORT}`);
  if (!SPREADSHEET_ID) console.warn('⚠  SPREADSHEET_ID is not set — see .env.example');
});
