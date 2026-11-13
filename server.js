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
// RADAR results are cached longer than the sheet (Databricks queries are slow);
// the Refresh buttons always bypass the cache.
const RADAR_TTL = Number(process.env.RADAR_CACHE_TTL_SECONDS || 1800);

// Per-product access control lives in src/access.js. Ensure every internal +
// partner domain can sign in (product access is enforced per route below).
access.ensureSignInDomains();

app.set('trust proxy', 1);

// ── Old link → new link ───────────────────────────────────
// The portal moved off peoplebox-client-portal.vercel.app. Any request to an
// old host is permanently redirected (308, keeps method/path/query) to the
// canonical host: CANONICAL_HOST if set, otherwise the host of
// OAUTH_REDIRECT_URI (which already points at the new address). Only the hosts
// listed in OLD_HOSTS are redirected, so localhost and preview URLs are untouched.
const OLD_HOSTS = (process.env.OLD_HOSTS || 'peoplebox-client-portal.vercel.app')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const CANONICAL_HOST = (() => {
  if (process.env.CANONICAL_HOST) return process.env.CANONICAL_HOST.trim().toLowerCase();
  try { return new URL(process.env.OAUTH_REDIRECT_URI).host.toLowerCase(); } catch (e) { return ''; }
})();
app.use((req, res, next) => {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (CANONICAL_HOST && OLD_HOSTS.includes(host) && host !== CANONICAL_HOST) {
    return res.redirect(308, 'https://' + CANONICAL_HOST + req.originalUrl);
  }
  next();
});

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

// ── RADAR loading helper ─────────────────────────────────
// Every RADAR-backed endpoint goes through radarLoad():
//   • serves the cached result while fresh (RADAR_TTL) unless force=true;
//   • shares one in-flight query per key, so users opening the same report at
//     the same time don't each start a Databricks query;
//   • if RADAR fails, falls back to the last good result (up to 24h old) and
//     flags it stale, so the report keeps working through a RADAR hiccup.
const radarInflight = new Map();
async function radarLoad(key, force, loader) {
  if (!force) {
    const c = cache.get(key);
    if (c !== null) return { value: c, cached: true };
  }
  let p = radarInflight.get(key);
  if (!p) {
    p = (async () => {
      const value = await loader();
      cache.set(key, value, RADAR_TTL);
      return value;
    })();
    radarInflight.set(key, p);
    p.then(() => radarInflight.delete(key), () => radarInflight.delete(key));
  }
  try {
    return { value: await p, cached: false };
  } catch (err) {
    const old = cache.getStale(key);
    if (!old) throw err;
    console.warn('RADAR failed for', key, '— serving last good copy:', err.message);
    return { value: old.value, cached: true, stale: true, staleAt: new Date(old.at).toISOString(), staleReason: err.message };
  }
}
// Extra response fields when the result is a stale fallback.
const staleInfo = (r) => (r.stale ? { stale: true, staleAt: r.staleAt, staleReason: r.staleReason } : {});

// ── Peoplebox billing / AR from RADAR (Databricks) ───────
// All invoices (gold_billing_360) for the tracker's Peoplebox clients,
// matched by HubSpot Company ID. Cached as { rows, clientCount }.
const BILLING_CACHE_KEY = 'radar-billing';

function peopleboxBilling(force) {
  return radarLoad(BILLING_CACHE_KEY, force, async () => {
    const data = await loadData({});
    const ids = [...new Set((data.clients || []).map((c) => c.hsid).filter(Boolean))];
    const rows = await radar.billing(ids);
    return { rows, clientCount: ids.length };
  });
}

app.get('/api/billing', auth.requireAuth, requireProduct('peoplebox'), async (req, res) => {
  try {
    if (!radar.isConfigured()) {
      return res.json({ configured: false, rows: [] });
    }
    const r = await peopleboxBilling(req.query.refresh === '1');
    res.json({ configured: true, cached: r.cached, clientCount: r.value.clientCount, rows: r.value.rows, ...staleInfo(r) });
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

    const billingRows = (await peopleboxBilling(false)).value.rows;
    if (!billingRows.some((r) => r.invoice_ref === inv)) {
      return res.status(404).json({ error: 'unknown_invoice', message: 'Invoice is not in the Peoplebox billing report.' });
    }

    const r = await radarLoad('radar-lines:' + inv, false, () => radar.invoiceLines(inv));
    res.json({ configured: true, cached: r.cached, rows: r.value, ...staleInfo(r) });
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
    const r = await radarLoad(CH_CACHE_KEY, req.query.refresh === '1', async () => ({
      rows: await radar.channelDeals(), at: new Date().toISOString(),
    }));
    res.json({ configured: true, cached: r.cached, rows: r.value.rows, fetchedAt: r.value.at, ...staleInfo(r) });
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
    const r = await radarLoad('radar-ch-lines:' + id, false, () => radar.channelDealLines(id));
    res.json({ configured: true, cached: r.cached, rows: r.value, ...staleInfo(r) });
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
    const r = await radarLoad(PBL_CACHE_KEY, req.query.refresh === '1', async () => {
      const { deals, lines } = await radar.peopleboxLeads();
      return { rows: deals, lines, at: new Date().toISOString() };
    });
    res.json({ configured: true, cached: r.cached, rows: r.value.rows, lines: r.value.lines, fetchedAt: r.value.at, ...staleInfo(r) });
  } catch (err) {
    console.error('Failed to load Peoplebox leads:', err);
    res.status(502).json({ error: 'radar_failed', message: err.message });
  }
});

// ── Partner product Billing + Leads (Teamtailor, Disprz, Hubstaff) ─────────
// Same reports as Peoplebox Billing / Peoplebox Leads, per product.
//   Billing → access rides on the product key (like Peoplebox Billing).
//   Leads   → its own access key (LEADS_KEY), see src/access.js.
const LEADS_KEY = { teamtailor: 'ttleads', disprz: 'dzleads', hubstaff: 'hsleads' };
const isPartnerProduct = (p) => radar.PARTNER_PRODUCTS.indexOf(p) >= 0;
function canOpen(req, key) { return allowedProducts(req).indexOf(key) >= 0; }

function productBillingRows(product, force) {
  return radarLoad('radar-billing-' + product, force, () => radar.productBilling(product));
}

app.get('/api/pbilling/:product', auth.requireAuth, async (req, res) => {
  const product = req.params.product;
  if (!isPartnerProduct(product)) return res.status(404).json({ error: 'unknown_product' });
  if (!canOpen(req, product)) return res.status(403).json({ error: 'forbidden', message: 'Your account does not have access to this product.' });
  try {
    if (!radar.isConfigured()) return res.json({ configured: false, rows: [] });
    const r = await productBillingRows(product, req.query.refresh === '1');
    const rows = r.value;
    const clients = {}; rows.forEach((x) => { clients[x.hsid || x.client] = 1; });
    res.json({ configured: true, cached: r.cached, clientCount: Object.keys(clients).length, rows, ...staleInfo(r) });
  } catch (err) {
    console.error('Failed to load billing for', product, err);
    res.status(502).json({ error: 'radar_failed', message: err.message });
  }
});

// Invoice line items for a partner product's billing report. Only invoices
// already in that product's billing result are served.
app.get('/api/pbilling/:product/lines', auth.requireAuth, async (req, res) => {
  const product = req.params.product;
  if (!isPartnerProduct(product)) return res.status(404).json({ error: 'unknown_product' });
  if (!canOpen(req, product)) return res.status(403).json({ error: 'forbidden', message: 'Your account does not have access to this product.' });
  try {
    if (!radar.isConfigured()) return res.json({ configured: false, rows: [] });
    const inv = String(req.query.invoice || '').trim();
    if (!inv) return res.status(400).json({ error: 'missing_invoice', message: 'invoice is required' });
    const rows = (await productBillingRows(product, false)).value;
    if (!rows.some((r) => r.invoice_ref === inv)) {
      return res.status(404).json({ error: 'unknown_invoice', message: 'Invoice is not in this billing report.' });
    }
    const r = await radarLoad('radar-lines:' + inv, false, () => radar.invoiceLines(inv));
    res.json({ configured: true, cached: r.cached, rows: r.value, ...staleInfo(r) });
  } catch (err) {
    console.error('Failed to load invoice lines for', product, err);
    res.status(502).json({ error: 'radar_failed', message: err.message });
  }
});

app.get('/api/leads/:product', auth.requireAuth, async (req, res) => {
  const product = req.params.product;
  if (!isPartnerProduct(product)) return res.status(404).json({ error: 'unknown_product' });
  if (!canOpen(req, LEADS_KEY[product])) return res.status(403).json({ error: 'forbidden', message: 'Your account does not have access to this report.' });
  try {
    if (!radar.isConfigured()) return res.json({ configured: false, rows: [] });
    const r = await radarLoad('radar-leads-' + product, req.query.refresh === '1', async () => {
      const { deals, lines } = await radar.productLeads(product);
      return { rows: deals, lines, at: new Date().toISOString() };
    });
    res.json({ configured: true, cached: r.cached, rows: r.value.rows, lines: r.value.lines, fetchedAt: r.value.at, ...staleInfo(r) });
  } catch (err) {
    console.error('Failed to load leads for', product, err);
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
