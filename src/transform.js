'use strict';

/**
 * Turns the raw 2D cell grid of the Peoplebox tab into the portal's data model.
 *
 * The tab stacks several tables on top of each other (summary counts, a big
 * per-client table, milestone notes, etc.). Rather than hard-code row numbers
 * — which break the moment someone inserts a row — we locate each table by an
 * "anchor": a recognizable header cell. Column positions within the per-client
 * table are matched by header name, so reordering columns is also tolerated.
 *
 * Finance-sensitive columns (ARR, PRICE/HC, Payment Terms, AR TEAM REMARKS) are
 * never mapped into the output. They stay in the source; they never reach the
 * render layer. (PRD §6.2 / NFR-03.)
 */

const MONTH_NAMES = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

// Standard implementation track (source milestone table). Per-client milestone
// data is not published in the sheet, so this is the reference onboarding track.
const MILESTONES = [
  { t: 'Kick-off Meeting & Operational Study', done: true },
  { t: 'Employee Upload', done: true },
  { t: 'Admin Training (Performance Review creation)', done: true },
  { t: 'OKR Setup', done: false },
  { t: 'Admin Training – Performance Review Setup / Form creation', done: false },
  { t: 'Employee Training', done: false },
  { t: 'Sprout Integration', done: false },
  { t: 'Soft Launch', done: false },
  { t: 'Pre-Launch Review (Performance Review)', done: false },
  { t: 'Final Launch (Performance Review Cycle)', done: false },
];

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function parseMonthHeader(cell) {
  const m = norm(cell).match(/^([a-z]{3,9})\.?\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTH_NAMES[m[1]];
  if (month == null) return null;
  return { label: cell.trim(), year: Number(m[2]), month, sort: Number(m[2]) * 12 + month };
}

function toNumber(cell) {
  if (cell == null || cell === '') return null;
  const n = Number(String(cell).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null; // '#N/A', '#REF!', text -> null
}

/** Normalize a boolean-ish cell (true/false, yes/no) into 'Yes' | 'No' | '—'. */
function yesNo(cell) {
  const v = String(cell == null ? '' : cell).trim().toLowerCase();
  if (v === 'true' || v === 'yes') return 'Yes';
  if (v === 'false' || v === 'no') return 'No';
  return '—';
}

/** Find the first row index where `pred(rowCells)` is true. */
function findRow(grid, pred, from = 0) {
  for (let i = from; i < grid.length; i++) if (pred(grid[i])) return i;
  return -1;
}

/** Build a {fieldKey: columnIndex} map from a header row. */
function mapColumns(headerRow) {
  const want = {
    clientStatus: ['client status'],
    cid: ['cid'],
    hsid: ['hubspot company id'],
    company: ['company name'],
    closedDate: ['closed date'],
    csm: ['csm'],
    goLive: ['go-live date', 'go live date', 'implem project handover date', 'project handover date'],
    years: ['# of years subscribed', '# of  years subscribed', 'number of years subscribed'],
    subStart: ['subscription start date', 'hrps subscription start date'],
    subEnd: ['subscription end date', 'hrps subscription end date'],
    // Per-client "switched to Peoplebox?" flag (P+ Switcher: Yes/No).
    switch: ['peoplebox switch status', 'p+ switcher', 'p+ switch'],
    // Per-client Integration Status (sheet col N) — drives the integration
    // breakdown chart, a roster column, and a drawer field.
    activation: ['integration status'],
    upsell: ['upsell comments', 'notes'],
    licenses: ['# of licenses initially purchased', '# of  licenses initially purchased'],
    // Billing status (operational flags — not pricing/ARR, which stay excluded).
    paidSprout: ['client payment to sprout status', 'payment to sprout'],
    pboxInvoiced: ['invoice from peoplebox'],
    pboxInvoice: ['peoplebox invoice remarks'],
  };
  const idx = {};
  headerRow.forEach((cell, c) => {
    const n = norm(cell);
    for (const key of Object.keys(want)) {
      if (idx[key] != null) continue;
      if (want[key].some((alias) => n === alias || n.includes(alias))) idx[key] = c;
    }
  });
  return idx;
}

function parseClientTable(grid) {
  const headerIdx = findRow(
    grid,
    (r) => r.some((c) => norm(c) === 'company name') && r.some((c) => norm(c).includes('client status'))
  );
  if (headerIdx < 0) {
    throw new Error('Could not locate the per-client table (no "Company Name" + "Client Status" header row).');
  }
  const header = grid[headerIdx];
  const cols = mapColumns(header);

  // Month columns: every header cell that looks like "May 2026".
  const monthCols = [];
  header.forEach((cell, c) => {
    const m = parseMonthHeader(cell);
    if (m) monthCols.push({ ...m, col: c });
  });
  monthCols.sort((a, b) => a.sort - b.sort); // chronological
  const months = monthCols.map((m) => m.label);

  const clients = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    const company = (row[cols.company] || '').trim();
    if (!company) {
      // A fully blank row signals the end of the table; a single gap is skipped.
      if (row.every((c) => !c || !c.trim())) break;
      continue;
    }
    const acctRaw = (row[cols.clientStatus] || '').trim();
    const sw = (row[cols.switch] || '').trim();
    // Column U is the per-client headcount ("SUM OF HEADCOUNT"; also labelled
    // "# of Licenses Initially Purchased"). The monthly columns drive the trend
    // when populated; otherwise the current headcount falls back to column U.
    const headcount = toNumber(row[cols.licenses]);
    const monthlyHc = monthCols.map((m) => toNumber(row[m.col]));
    const hc = monthlyHc.some((v) => v != null) ? monthlyHc : headcount != null ? [headcount] : monthlyHc;
    clients.push({
      co: company,
      cid: (row[cols.cid] || '').trim(),
      hsid: (row[cols.hsid] || '').trim(),
      closed: (row[cols.closedDate] || '').trim(),
      acct: acctRaw || 'Unknown',
      sw: sw || '—',
      act: (row[cols.activation] || '').trim() || '—',
      csm: (row[cols.csm] || '').trim() || 'Unassigned',
      start: (row[cols.subStart] || '').trim(),
      end: (row[cols.subEnd] || '').trim(),
      go: (row[cols.goLive] || '').trim(),
      yrs: (row[cols.years] || '').trim() || '—',
      lic: headcount,
      up: (row[cols.upsell] || '').trim(),
      paidSprout: (row[cols.paidSprout] || '').trim() || '—',
      pboxInvoiced: yesNo(row[cols.pboxInvoiced]),
      pboxInvoice: (row[cols.pboxInvoice] || '').trim() || '—',
      hc: hc,
    });
  }
  return { clients, months };
}

/**
 * Tally a list of label values into a sorted [{name, count}] breakdown.
 * The source tab no longer carries pre-aggregated summary tables, so the
 * status and integration breakdowns are computed from the per-client rows.
 */
function tally(values) {
  const counts = new Map();
  values.forEach((v) => {
    const name = (v || '').trim();
    if (!name || name === '—') return;
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  return Array.from(counts, ([name, count]) => ({ name, count })).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name)
  );
}

function buildKpis(status, integration) {
  const find = (arr, re) => (arr.find((x) => re.test(norm(x.name))) || {}).count || 0;
  const active = find(status, /^active$/);
  const ongoing = find(status, /ongoing.*implementation/);
  const activated = find(integration, /^activated$/);
  // Any Integration Status that starts with "Pending" (plain Pending,
  // "Pending with Peoplebox", "Pending (Transition to Sprout)").
  const pending = integration
    .filter((x) => /^pending/.test(norm(x.name)))
    .reduce((sum, x) => sum + x.count, 0);
  const activeTotal = active || 0;
  return [
    { val: active, name: 'Active clients', meta: 'Live Peoplebox subscriptions', tone: 'active' },
    { val: ongoing, name: 'Ongoing implementation', meta: 'In onboarding pipeline', tone: 'ongoing' },
    {
      val: activated,
      name: 'Integrations activated',
      meta: activeTotal ? `of ${activeTotal} active · ${Math.round((activated / activeTotal) * 100)}% utilized` : '',
      tone: 'indigo',
    },
    { val: pending, name: 'Pending integration', meta: 'with Peoplebox + transition', tone: 'onhold' },
  ];
}

/**
 * @param {string[][]} grid  raw values from the Peoplebox tab
 * @param {{spreadsheetId:string, tab:string}} source
 */
function lastHc(hc) {
  for (let i = hc.length - 1; i >= 0; i--) if (hc[i] != null) return hc[i];
  return null;
}
function buildBilling(clients) {
  const total = clients.length;
  const paidToSprout = clients.filter((c) => /^paid$/i.test(c.paidSprout)).length;
  const pendingToSprout = clients.filter((c) => /^pending$/i.test(c.paidSprout)).length;
  const invoicedByPbox = clients.filter((c) => c.pboxInvoiced === 'Yes').length;
  const pboxInvoicePaid = clients.filter((c) => /^paid$/i.test(c.pboxInvoice)).length;
  const pboxPaidHeadcount = clients
    .filter((c) => /^paid$/i.test(c.pboxInvoice))
    .reduce((sum, c) => sum + (lastHc(c.hc) || 0), 0);
  return { total, paidToSprout, pendingToSprout, invoicedByPbox, pboxInvoicePaid, pboxPaidHeadcount };
}

function transform(grid, source) {
  const { clients, months } = parseClientTable(grid);
  const statusBreakdown = tally(clients.map((c) => c.acct));
  const integrationBreakdown = tally(clients.map((c) => c.act));
  return {
    generatedAt: new Date().toISOString(),
    source,
    kpis: buildKpis(statusBreakdown, integrationBreakdown),
    billing: buildBilling(clients),
    statusBreakdown,
    integrationBreakdown,
    months,
    milestones: MILESTONES,
    clients,
  };
}

module.exports = { transform };
