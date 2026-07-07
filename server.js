'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const auth = require('./src/auth');
const cache = require('./src/cache');
const { readTab } = require('./src/sheets');
const { transform } = require('./src/transform');

const app = express();
const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TAB = process.env.PEOPLEBOX_TAB || 'Peoplebox';
const TTL = Number(process.env.CACHE_TTL_SECONDS || 300);
const CACHE_KEY = 'peoplebox-data';

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

app.get('/api/data', auth.requireAuth, async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const data = await loadData({ force });
    res.json(data);
  } catch (err) {
    console.error('Failed to load sheet data:', err);
    res.status(502).json({ error: 'sheet_read_failed', message: err.message });
  }
});

// Static assets (css/js). Note: index.html is served only via the gated route
// above, so static files here are the supporting css/js + login page.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => {
  console.log(`Sprout Partnerships Portal listening on http://localhost:${PORT}`);
  if (!SPREADSHEET_ID) console.warn('⚠  SPREADSHEET_ID is not set — see .env.example');
});
