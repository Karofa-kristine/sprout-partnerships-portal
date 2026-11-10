'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const auth = require('./src/auth');
const cache = require('./src/cache');
const radar = require('./src/radar');
const access = require('./src/access');
const { readTab } = require('./src/sheets');
const { transform } = require('./src/transform');
const { allowedProducts, requireProduct } = access;

const app = express();
const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TAB = process.env.PEOPLEBOX_TAB || 'Peoplebox';
const TTL = Number(process.env.CACHE_TTL_SECONDS || 300);
const CACHE_KEY = 'peoplebox-data';

// Per-product access control lives in src/access.js. Ensure every internal +
// partner domain can sign in (product access is enforced per route below).
access.ensureSignInDomains();

app.set('trust proxy', 1);
app.use(express.json());
// Stateless, signed-cookie sessions. The whole session (just the small `user`
// object) lives in the cookie, so no server-side store is needed — this works
// identically on a persistent server and on serverless (e.g. Vercel), where
// there is no shared memory between invocations.
app.use(
  cookieSession({
    name: 'sppsess',
    keys: [process.env.SESSION_SECRET || 'dev-insecure-secret-change-me'],
    httpOnly: true,
    sameSite: 'lax',
    secure: String(process.env.SECURE_COOKIES) === 'true',
    maxAge: 1000 * 60 * 60 * 8, // 8h
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
  const domain = access.userDomain(req);
  res.json({
    email: (req.session.user && req.session.user.email) || '',
    domain: domain,
    internal: access.internalDomains().includes(domain),
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

// ── Peoplebox billing / AR from RADAR (Databricks) ───────
// All invoices (gold_billing_360) for the tracker's Peoplebox clients,
// matched by HubSpot Company ID.
const BILLING_CACHE_KEY = 'radar-billing';

app.get('/api/billing', auth.requireAuth, requireProduct('peoplebox'), async (req, res) => {
  try {
    if (!radar.isConfigured()) {
      return res.json({ configured: false, rows: [] });
    }
    const force = req.query.refresh === '1';
    if (!force) {
      const cached = cache.get(BILLING_CACHE_KEY);
      if (cached) return res.json({ configured: true, cached: true, rows: cached });
    }
    const data = await loadData({});
    const ids = [...new Set((data.clients || []).map((c) => c.hsid).filter(Boolean))];
    const rows = await radar.billing(ids);
    cache.set(BILLING_CACHE_KEY, rows, TTL);
    res.json({ configured: true, cached: false, clientCount: ids.length, rows });
  } catch (err) {
    console.error('Failed to load RADAR billing:', err);
    res.status(502).json({ error: 'radar_failed', message: err.message });
  }
});

// Line items for one invoice (silver_ns_invoice + silver_ns_transaction_line).
// Only invoice numbers already in the Peoplebox billing result are allowed, so
// this can't be used to read arbitrary NetSuite invoices.
app.get('/api/billing/lines', auth.requireAuth, requireProduct('peoplebox'), async (req, res) => {
  try {
    if (!radar.isConfigured()) return res.json({ configured: false, rows: [] });
    const inv = String(req.query.invoice || '').trim();
    if (!inv) return res.status(400).json({ error: 'missing_invoice', message: 'invoice is required' });

    let billingRows = cache.get(BILLING_CACHE_KEY);
    if (!billingRows) {
      const data = await loadData({});
      const ids = [...new Set((data.clients || []).map((c) => c.hsid).filter(Boolean))];
      billingRows = await radar.billing(ids);
      cache.set(BILLING_CACHE_KEY, billingRows, TTL);
    }
    if (!billingRows.some((r) => r.invoice_ref === inv)) {
      return res.status(404).json({ error: 'unknown_invoice', message: 'Invoice is not in the Peoplebox billing report.' });
    }

    const key = 'radar-lines:' + inv;
    const cached = cache.get(key);
    if (cached) return res.json({ configured: true, cached: true, rows: cached });
    const rows = await radar.invoiceLines(inv);
    cache.set(key, rows, TTL);
    res.json({ configured: true, cached: false, rows });
  } catch (err) {
    console.error('Failed to load invoice lines:', err);
    res.status(502).json({ error: 'radar_failed', message: err.message });
  }
});

// ── ChannelHub (Unified Channel Pipeline deals from RADAR) ─
// Internal-only (product key 'channelhub', see src/access.js).
const CH_CACHE_KEY = 'radar-channelhub';

app.get('/api/channelhub', auth.requireAuth, requireProduct('channelhub'), async (req, res) => {
  try {
    if (!radar.isConfigured()) return res.json({ configured: false, rows: [] });
    if (req.query.refresh !== '1') {
      const cached = cache.get(CH_CACHE_KEY);
      if (cached) return res.json({ configured: true, cached: true, rows: cached.rows, fetchedAt: cached.at });
    }
    const rows = await radar.channelDeals();
    const at = new Date().toISOString();
    cache.set(CH_CACHE_KEY, { rows, at }, TTL);
    res.json({ configured: true, cached: false, rows, fetchedAt: at });
  } catch (err) {
    console.error('Failed to load ChannelHub:', err);
    res.status(502).json({ error: 'radar_failed', message: err.message });
  }
});

app.get('/api/channelhub/lines', auth.requireAuth, requireProduct('channelhub'), async (req, res) => {
  try {
    if (!radar.isConfigured()) return res.json({ configured: false, rows: [] });
    const id = String(req.query.deal || '').trim();
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'bad_deal', message: 'deal must be a numeric deal id' });
    const key = 'radar-ch-lines:' + id;
    const cached = cache.get(key);
    if (cached) return res.json({ configured: true, cached: true, rows: cached });
    const rows = await radar.channelDealLines(id);
    cache.set(key, rows, TTL);
    res.json({ configured: true, cached: false, rows });
  } catch (err) {
    console.error('Failed to load ChannelHub line items:', err);
    res.status(502).json({ error: 'radar_failed', message: err.message });
  }
});

// ── Peoplebox ongoing leads (RADAR, internal-only: product key 'pbleads') ─
const PBL_CACHE_KEY = 'radar-pb-leads';
app.get('/api/peoplebox/leads', auth.requireAuth, requireProduct('pbleads'), async (req, res) => {
  try {
    if (!radar.isConfigured()) return res.json({ configured: false, rows: [] });
    if (req.query.refresh !== '1') {
      const cached = cache.get(PBL_CACHE_KEY);
      if (cached) return res.json({ configured: true, cached: true, rows: cached.rows, lines: cached.lines, fetchedAt: cached.at });
    }
    const { deals, lines } = await radar.peopleboxLeads();
    const at = new Date().toISOString();
    cache.set(PBL_CACHE_KEY, { rows: deals, lines, at }, TTL);
    res.json({ configured: true, cached: false, rows: deals, lines, fetchedAt: at });
  } catch (err) {
    console.error('Failed to load Peoplebox leads:', err);
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

// ── Full per-product report (same shape as /api/data) ────
// For any product tab that follows the Peoplebox schema (Company Name +
// Client Status + Integration Status + subscription dates …). Powers the
// Teamtailor/Disprz/Hubstaff dashboards, which reuse the Peoplebox renderer.
const REPORT_TABS = Object.assign({ peoplebox: TAB }, RAW_TABS);
app.get('/api/report/:product', auth.requireAuth, async (req, res) => {
  const product = req.params.product;
  const tab = REPORT_TABS[product];
  if (!tab) return res.status(404).json({ error: 'unknown_product' });
  if (allowedProducts(req).indexOf(product) < 0) {
    return res.status(403).json({ error: 'forbidden', message: 'Your account does not have access to this product.' });
  }
  try {
    const force = req.query.refresh === '1';
    const cacheKey = 'report-' + product;
    if (!force) {
      const cached = cache.get(cacheKey);
      if (cached) return res.json({ ...cached, cached: true });
    }
    const grid = await readTab(SPREADSHEET_ID, tab);
    const data = transform(grid, { spreadsheetId: SPREADSHEET_ID, tab });
    cache.set(cacheKey, data, TTL);
    res.json({ ...data, cached: false });
  } catch (err) {
    console.error('Failed to build report for', product, err);
    res.status(502).json({ error: 'report_failed', message: err.message });
  }
});

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

// Start a listener only when run directly (local `npm start` / persistent host).
// On serverless (Vercel), server.js is required by api/index.js, which exports
// `app` as the request handler — no listener is created.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Sprout Partnerships Portal listening on http://localhost:${PORT}`);
    if (!SPREADSHEET_ID) console.warn('⚠  SPREADSHEET_ID is not set — see .env.example');
  });
}

module.exports = app;
