'use strict';

/* ---------- palette (assigned client-side; API returns data only) ---------- */
var STATUS_COLORS = [
  { re: /^active$/, c: 'var(--s-active)' },
  { re: /ongoing.*implementation/, c: 'var(--s-ongoing)' },
  { re: /implem.*on.?hold|implementation on-?hold/, c: 'var(--s-onhold)' },
  { re: /endorsed/, c: 'var(--s-endorsed)' },
  { re: /new won deal/, c: 'var(--s-won)' },
];
var INT_PALETTE = ['#17872F', '#2563B8', '#C2841C', '#D9A441', '#7A4BC4', '#8A938C', '#B0563E'];
var KPI_TONE = { active: 'var(--s-active)', ongoing: 'var(--s-ongoing)', indigo: 'var(--indigo)', onhold: 'var(--s-onhold)' };
var SVG = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>";
var ICONS = {
  active: SVG + "<path d='M22 11.08V12a10 10 0 1 1-5.93-9.14'/><path d='m9 11 3 3L22 4'/></svg>",
  ongoing: SVG + "<path d='M21 12a9 9 0 1 1-2.64-6.36'/><path d='M21 3v6h-6'/></svg>",
  integration: SVG + "<path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'/><path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'/></svg>",
  pending: SVG + "<circle cx='12' cy='12' r='10'/><path d='M12 6v6l4 2'/></svg>",
  clients: SVG + "<path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/><circle cx='9' cy='7' r='4'/><path d='M23 21v-2a4 4 0 0 0-3-3.87'/><path d='M16 3.13a4 4 0 0 1 0 7.75'/></svg>",
  invoice: SVG + "<path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/><path d='M14 2v6h6'/><path d='M16 13H8M16 17H8M10 9H8'/></svg>",
  settled: SVG + "<path d='M18 6 7 17l-5-5'/><path d='m22 10-7.5 7.5L13 16'/></svg>",
};
var TONE_ICON = { active: 'active', ongoing: 'ongoing', indigo: 'integration', onhold: 'pending' };
function kpiCard(opts) {
  var color = opts.color || 'var(--accent)';
  return "<div class='kpi" + (opts.hero ? ' hero' : '') + "' style='--c:" + color + "'>" +
    "<div class='kpi-top'><div class='ico'>" + (ICONS[opts.icon] || ICONS.clients) + "</div></div>" +
    "<div class='val num'>" + opts.val + "</div>" +
    "<div class='name'>" + esc(opts.name) + "</div>" +
    "<div class='meta'>" + esc(opts.meta) + "</div></div>";
}
var SWITCH_COLOR = {
  'Pbox Won': 'var(--s-active)', 'Under Nego': 'var(--s-ongoing)', 'for Demoing': 'var(--indigo)',
  'Not yet offered': 'var(--s-onhold)', 'Not interested': 'var(--s-neutral)', '—': 'var(--faint)',
};
function statusColor(name) {
  var n = String(name).toLowerCase();
  for (var i = 0; i < STATUS_COLORS.length; i++) if (STATUS_COLORS[i].re.test(n)) return STATUS_COLORS[i].c;
  return 'var(--s-neutral)';
}

/* ---------- helpers ---------- */
function $(s) { return document.querySelector(s); }
function el(t, c, h) { var e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); }
function lastHC(hc) { for (var i = hc.length - 1; i >= 0; i--) if (hc[i] != null) return hc[i]; return null; }
function billPill(v, okRe) {
  if (!v || v === '—') return "<span style='color:var(--faint)'>—</span>";
  var ok = okRe.test(v), color = ok ? 'var(--accent)' : 'var(--s-onhold)', bg = ok ? 'var(--accent-soft)' : 'var(--surface-2)';
  return "<span class='pill' style='background:" + bg + ";border:1px solid var(--border);color:" + color + "'><span class='d' style='background:" + color + "'></span>" + esc(v) + '</span>';
}
function parseDate(s) { var t = Date.parse(s); return isNaN(t) ? 0 : t; }

var DATA = null;     // full API payload
// Headcount progress window: January 2026 onward (auto-extends as new month
// columns are added to the sheet going forward).
var HC_FROM = Date.parse('January 1, 2026');
function winStartIdx() {
  var m = (DATA && DATA.months) || [];
  for (var i = 0; i < m.length; i++) { var t = Date.parse(m[i]); if (!isNaN(t) && t >= HC_FROM) return i; }
  return 0;
}
function shortMonth(label) {
  var p = String(label || '').split(' ');
  return (p[0] ? p[0].slice(0, 3) : label) + (p[1] ? " '" + p[1].slice(2) : '');
}
var MONTHS = [];     // sliced month labels
var state = { q: '', status: '', sw: '', paid: '', pboxInv: '', csm: '' };
var sort = { key: 'co', dir: 1 };

/* take the trailing-window slice of a client's hc array */
function hcWindow(hc) { return hc.slice(winStartIdx()); }

/* Roster cell: mini headcount sparkline (since Jan 2026) + latest value. */
function hcTrendCell(c) {
  var nums = hcWindow(c.hc).filter(function (v) { return v != null; });
  var last = lastHC(c.hc);
  if (nums.length < 2) return "<span style='color:var(--faint)'>" + (last == null ? '—' : last) + '</span>';
  return "<span style='display:inline-flex;align-items:center;gap:6px;justify-content:flex-end'>" +
    sparkline(c.hc, 64, 20) + "<span class='num' style='font-size:12.5px'>" + last + '</span></span>';
}

/* Drawer: month-by-month headcount chips from Jan 2026 to the latest month. */
function hcTable(c) {
  var win = hcWindow(c.hc);
  if (!win.some(function (v) { return v != null; })) return "<div style='color:var(--muted);font-size:12px'>No monthly headcount recorded yet.</div>";
  return "<div style='display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px'>" + MONTHS.map(function (mLabel, i) {
    var v = win[i];
    return "<div style='min-width:52px;text-align:center;border:1px solid var(--border);border-radius:6px;padding:4px 6px;background:var(--surface-2)'>" +
      "<div style='font-size:9.5px;color:var(--faint);font-family:var(--font-mono)'>" + esc(shortMonth(mLabel)) + '</div>' +
      "<div class='num' style='font-size:12.5px;font-weight:600'>" + (v == null ? '—' : v) + '</div></div>';
  }).join('') + '</div>';
}

/* ---------- charts ---------- */
function sparkline(hcFull, w, h) {
  var vals = hcWindow(hcFull);
  var nums = vals.filter(function (v) { return v != null; });
  if (nums.length < 2) return "<svg width='" + w + "' height='" + h + "'></svg>";
  var mn = Math.min.apply(null, nums), mx = Math.max.apply(null, nums), rng = (mx - mn) || 1;
  var pad = 2, iw = w - pad * 2, ih = h - pad * 2, segs = [], cur = [];
  for (var i = 0; i < vals.length; i++) {
    if (vals[i] == null) { if (cur.length) segs.push(cur); cur = []; continue; }
    var x = pad + iw * (i / (vals.length - 1));
    var y = pad + ih - ih * ((vals[i] - mn) / rng);
    cur.push(x.toFixed(1) + ',' + y.toFixed(1));
  }
  if (cur.length) segs.push(cur);
  var path = segs.map(function (s) { return "<polyline points='" + s.join(' ') + "' fill='none' stroke='var(--accent)' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/>"; }).join('');
  var li = -1; for (var k = vals.length - 1; k >= 0; k--) if (vals[k] != null) { li = k; break; }
  var dot = '';
  if (li >= 0) { var dx = pad + iw * (li / (vals.length - 1)); var dy = pad + ih - ih * ((vals[li] - mn) / rng); dot = "<circle cx='" + dx.toFixed(1) + "' cy='" + dy.toFixed(1) + "' r='2.2' fill='var(--accent)'/>"; }
  return "<svg class='spark' width='" + w + "' height='" + h + "' viewBox='0 0 " + w + " " + h + "'>" + path + dot + '</svg>';
}

function trendChart(hcFull) {
  var w = 392, h = 120, pad = 6, vals = hcWindow(hcFull);
  var nums = vals.filter(function (v) { return v != null; });
  if (nums.length < 2) return "<div style='color:var(--muted);font-size:12px;padding:18px 0'>Not enough headcount history to chart.</div>";
  var mn = Math.min.apply(null, nums), mx = Math.max.apply(null, nums), rng = (mx - mn) || 1;
  var iw = w - pad * 2 - 26, ih = h - pad * 2 - 16, x0 = pad + 26;
  function X(i) { return x0 + iw * (i / (vals.length - 1)); }
  function Y(v) { return pad + ih - ih * ((v - mn) / rng); }
  var segs = [], cur = [];
  for (var i = 0; i < vals.length; i++) {
    if (vals[i] == null) { if (cur.length) segs.push(cur); cur = []; continue; }
    cur.push(X(i).toFixed(1) + ',' + Y(vals[i]).toFixed(1));
  }
  if (cur.length) segs.push(cur);
  var lines = segs.map(function (s) { return "<polyline points='" + s.join(' ') + "' fill='none' stroke='var(--accent)' stroke-width='2' stroke-linejoin='round' stroke-linecap='round'/>"; }).join('');
  var grid =
    "<line x1='" + x0 + "' y1='" + Y(mx).toFixed(1) + "' x2='" + (w - pad) + "' y2='" + Y(mx).toFixed(1) + "' stroke='var(--border)'/>" +
    "<line x1='" + x0 + "' y1='" + Y(mn).toFixed(1) + "' x2='" + (w - pad) + "' y2='" + Y(mn).toFixed(1) + "' stroke='var(--border)'/>" +
    "<text x='" + (x0 - 5) + "' y='" + (Y(mx) + 3).toFixed(1) + "' text-anchor='end' font-size='9' fill='var(--faint)' font-family='var(--font-mono)'>" + mx + '</text>' +
    "<text x='" + (x0 - 5) + "' y='" + (Y(mn) + 3).toFixed(1) + "' text-anchor='end' font-size='9' fill='var(--faint)' font-family='var(--font-mono)'>" + mn + '</text>';
  var dots = '';
  for (var k = 0; k < vals.length; k++) if (vals[k] != null) dots += "<circle cx='" + X(k).toFixed(1) + "' cy='" + Y(vals[k]).toFixed(1) + "' r='2' fill='var(--accent)'/>";
  var labels =
    "<text x='" + x0 + "' y='" + (h - 2) + "' font-size='9' fill='var(--faint)' font-family='var(--font-mono)'>" + esc(MONTHS[0] || '') + '</text>' +
    "<text x='" + (w - pad) + "' y='" + (h - 2) + "' text-anchor='end' font-size='9' fill='var(--faint)' font-family='var(--font-mono)'>" + esc(MONTHS[MONTHS.length - 1] || '') + '</text>';
  return "<svg width='100%' viewBox='0 0 " + w + ' ' + h + "'>" + grid + lines + dots + labels + '</svg>';
}

/* ---------- sections ---------- */
function renderKPIs() {
  var c = $('#kpis'); c.innerHTML = '';
  DATA.kpis.forEach(function (k, i) {
    c.insertAdjacentHTML('beforeend', kpiCard({
      val: k.val, name: k.name, meta: k.meta,
      color: KPI_TONE[k.tone] || 'var(--accent)',
      icon: TONE_ICON[k.tone] || 'clients',
      hero: i === 0,
    }));
  });
}
function pct(n, d) { return d ? Math.round((n / d) * 100) + '%' : '0%'; }
function renderBilling() {
  var b = DATA.billing, c = $('#billing'); if (!b || !c) return; c.innerHTML = '';
  var cards = [
    { val: b.paidToSprout, color: 'var(--s-active)', icon: 'active', name: 'Paid Clients to Sprout', meta: 'of ' + b.total + ' clients · ' + pct(b.paidToSprout, b.total) + ' settled' },
    { val: b.pendingToSprout, color: 'var(--s-onhold)', icon: 'pending', name: 'Not yet paid to Sprout', meta: pct(b.pendingToSprout, b.total) + ' of clients · payment pending' },
    { val: b.invoicedByPbox, color: 'var(--indigo)', icon: 'invoice', name: 'Invoiced by Peoplebox', meta: 'have a Peoplebox invoice issued' },
    { val: b.pboxInvoicePaid, color: 'var(--s-ongoing)', icon: 'settled', name: 'Peoplebox invoice settled', meta: 'Peoplebox invoices marked paid' },
    { val: (b.pboxPaidHeadcount || 0).toLocaleString(), color: 'var(--brand)', icon: 'clients', name: 'Headcount on Paid Peoplebox Invoices', meta: 'total headcount across settled Peoplebox invoices' },
  ];
  cards.forEach(function (k) { c.insertAdjacentHTML('beforeend', kpiCard(k)); });
  $('#billingNote').textContent = b.total + ' clients · billing status from source sheet';
}
function renderDonut() {
  var b = DATA.statusBreakdown, total = b.reduce(function (a, x) { return a + x.count; }, 0), acc = 0, stops = [];
  b.forEach(function (s) {
    var from = acc / total * 360, to = (acc + s.count) / total * 360;
    stops.push(statusColor(s.name) + ' ' + from.toFixed(2) + 'deg ' + to.toFixed(2) + 'deg'); acc += s.count;
  });
  $('#donut').style.background = 'conic-gradient(' + stops.join(',') + ')';
  $('#donutTotal').textContent = total; $('#statusTotal').textContent = total + ' total';
  var lg = $('#statusLegend'); lg.innerHTML = '';
  b.forEach(function (s) {
    lg.appendChild(el('div', 'row', "<span class='dot' style='background:" + statusColor(s.name) + "'></span><span class='nm'>" + esc(s.name) + "</span><span class='ct num'>" + s.count + '</span>'));
  });
}
/* ---------- filters + table ---------- */
function uniq(a) { var o = {}, r = []; a.forEach(function (v) { if (v && !o[v]) { o[v] = 1; r.push(v); } }); return r; }
function populateFilters() {
  var cs = DATA.clients;
  uniq(cs.map(function (c) { return c.acct; })).sort().forEach(function (v) { var o = el('option', null, v); o.value = v; $('#fStatus').appendChild(o); });
  uniq(cs.map(function (c) { return c.paidSprout; }).filter(function (v) { return v && v !== '—'; })).sort().forEach(function (v) { var o = el('option', null, v); o.value = v; $('#fPaid').appendChild(o); });
  uniq(cs.map(function (c) { return c.pboxInvoice; }).filter(function (v) { return v && v !== '—'; })).sort().forEach(function (v) { var o = el('option', null, v); o.value = v; $('#fPboxInv').appendChild(o); });
  uniq(cs.map(function (c) { return c.csm; })).sort().forEach(function (v) { var o = el('option', null, v); o.value = v; $('#fCsm').appendChild(o); });
}
function filtered() {
  var rows = DATA.clients.filter(function (c) {
    if (state.q && c.co.toLowerCase().indexOf(state.q.toLowerCase()) < 0) return false;
    if (state.status && c.acct !== state.status) return false;
    if (state.paid && c.paidSprout !== state.paid) return false;
    if (state.pboxInv && c.pboxInvoice !== state.pboxInv) return false;
    if (state.csm && c.csm !== state.csm) return false;
    return true;
  });
  rows.sort(function (a, b) {
    var x, y;
    if (sort.key === 'hc') { x = a.lic == null ? -1 : a.lic; y = b.lic == null ? -1 : b.lic; }
    else if (sort.key === 'hclast') { x = lastHC(a.hc); x = x == null ? -1 : x; y = lastHC(b.hc); y = y == null ? -1 : y; }
    else if (sort.key.indexOf('mon:') === 0) { var mi = parseInt(sort.key.slice(4), 10), aw = hcWindow(a.hc), bw = hcWindow(b.hc); x = aw[mi] == null ? -1 : aw[mi]; y = bw[mi] == null ? -1 : bw[mi]; }
    else if (sort.key === 'closed') { x = parseDate(a.closed); y = parseDate(b.closed); }
    else if (sort.key === 'start') { x = parseDate(a.start); y = parseDate(b.start); }
    else if (sort.key === 'end') { x = parseDate(a.end); y = parseDate(b.end); }
    // Any other column sorts as text (blanks/"—" grouped at one end).
    else { var g = function (o) { var v = o[sort.key]; return (v == null || v === '—') ? '' : String(v).toLowerCase(); }; x = g(a); y = g(b); }
    return x < y ? -sort.dir : x > y ? sort.dir : 0;
  });
  return rows;
}
function renderChips() {
  var c = $('#chips'); c.innerHTML = '';
  function add(label, key) {
    var chip = el('div', 'chip', esc(label));
    var b = el('button', null, '×'); b.onclick = function () { state[key] = ''; syncControls(); render(); };
    chip.appendChild(b); c.appendChild(chip);
  }
  if (state.q) add('Search: “' + state.q + '”', 'q');
  if (state.status) add('Account: ' + state.status, 'status');
  if (state.paid) add('Client Invoice Status: ' + state.paid, 'paid');
  if (state.pboxInv) add('Pbox invoice: ' + state.pboxInv, 'pboxInv');
  if (state.csm) add('CSM: ' + state.csm, 'csm');
}
// Inject one sortable roster column per month (Jan 2026 → current), mirroring
// the headcount columns in the Google Sheet. Rebuilt each render so it tracks
// new months automatically.
function buildMonthHeaders() {
  var row = document.querySelector('#app thead tr'); if (!row) return;
  Array.prototype.slice.call(row.querySelectorAll('th.month-col')).forEach(function (th) { th.remove(); });
  var anchor = row.querySelector("th[data-sort='hc']"); // after "Initial Headcount"
  MONTHS.forEach(function (label, i) {
    var th = document.createElement('th');
    th.className = 'r sortable month-col';
    th.setAttribute('data-sort', 'mon:' + i);
    th.style.whiteSpace = 'nowrap';
    th.innerHTML = esc(shortMonth(label)) + "<span class='arrow'></span>";
    th.onclick = function () { var k = 'mon:' + i; if (sort.key === k) sort.dir *= -1; else { sort.key = k; sort.dir = -1; } render(); };
    if (anchor && anchor.parentNode) { anchor.parentNode.insertBefore(th, anchor.nextSibling); anchor = th; }
  });
}
function renderSortIndicators() {
  document.querySelectorAll('thead th.sortable').forEach(function (th) {
    var key = th.getAttribute('data-sort'), arrow = th.querySelector('.arrow');
    if (key === sort.key) { th.classList.add('sorted'); arrow.textContent = sort.dir > 0 ? '▲' : '▼'; }
    else { th.classList.remove('sorted'); arrow.textContent = ''; }
  });
}
function render() {
  renderChips(); buildMonthHeaders(); renderSortIndicators();
  var rows = filtered(), tb = $('#tbody'); tb.innerHTML = '';
  if (!rows.length) {
    tb.appendChild(el('tr', null, "<td colspan='" + (11 + MONTHS.length) + "'><div class='empty'><strong>No clients match these filters.</strong>Try clearing a filter or searching a different name.</div></td>"));
  } else {
    rows.forEach(function (c) {
      var tr = el('tr'); tr.tabIndex = 0;
      var isA = c.acct === 'Active';
      tr.innerHTML =
        "<td class='num' style='font-size:12.5px;color:var(--muted)'>" + esc(c.closed || '—') + '</td>' +
        "<td class='co'><span class='stripe' style='background:" + (isA ? 'var(--s-active)' : 'var(--s-neutral)') + "'></span>" + esc(c.co) + "<span class='cid'>" + esc(c.cid) + '</span></td>' +
        "<td><span class='pill' style='background:" + (isA ? 'var(--accent-soft)' : '#F0EFEF') + ';color:' + (isA ? 'var(--accent)' : 'var(--s-neutral)') + "'><span class='d' style='background:" + (isA ? 'var(--accent)' : 'var(--s-neutral)') + "'></span>" + esc(c.acct) + '</span></td>' +
        '<td>' + billPill(c.act, /activated/i) + '</td>' +
        '<td>' + billPill(c.paidSprout, /^paid$/i) + '</td>' +
        '<td>' + billPill(c.pboxInvoiced, /^yes$/i) + '</td>' +
        '<td>' + billPill(c.pboxInvoice, /^paid$/i) + '</td>' +
        "<td class='csm'>" + (c.csm === 'Unassigned' ? "<span style='color:var(--faint)'>Unassigned</span>" : esc(c.csm)) + '</td>' +
        "<td class='num' style='font-size:12.5px;color:var(--muted)'>" + esc(c.start || '—') + '</td>' +
        "<td class='num' style='font-size:12.5px;color:var(--muted)'>" + esc(c.end || '—') + '</td>' +
        "<td class='r hc num'>" + (c.lic == null ? '—' : c.lic) + '</td>' +
        hcWindow(c.hc).map(function (v) { return "<td class='r num' style='font-size:12px;color:var(--muted)'>" + (v == null ? '—' : v) + '</td>'; }).join('');
      tr.onclick = function () { openDrawer(c); };
      tr.onkeydown = function (e) { if (e.key === 'Enter') openDrawer(c); };
      tb.appendChild(tr);
    });
  }
  $('#tablefoot').textContent = 'Showing ' + rows.length + ' of ' + DATA.clients.length + ' client records.';
  $('#rosterNote').textContent = DATA.clients.length + ' records · live from source sheet';
}
function syncControls() { $('#search').value = state.q; $('#fStatus').value = state.status; $('#fPaid').value = state.paid; $('#fPboxInv').value = state.pboxInv; $('#fCsm').value = state.csm; }

/* ---------- drawer ---------- */
function fieldRow(k, v, mono) { return "<div class='field'><div class='k'>" + esc(k) + "</div><div class='v" + (mono ? ' mono' : '') + "'>" + (v == null || v === '' ? "<span style='color:var(--faint);font-weight:400'>—</span>" : esc(v)) + '</div></div>'; }
function openDrawer(c) {
  var d = $('#drawer'), hc = lastHC(c.hc), win = hcWindow(c.hc), nums = win.filter(function (v) { return v != null; });
  var first = nums[0], delta = hc != null && first != null ? hc - first : 0;
  var dcls = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  var firstLabel = ''; for (var i = 0; i < win.length; i++) { if (win[i] != null) { firstLabel = MONTHS[i]; break; } }
  var dtxt = (delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : '● ') + (delta === 0 ? 'no change' : Math.abs(delta) + ' since ' + firstLabel);
  var swColor = SWITCH_COLOR[c.sw] || 'var(--text)', isA = c.acct === 'Active';
  var miles = DATA.milestones.map(function (m) {
    return "<div class='mile " + (m.done ? 'done' : 'pend') + "'><span class='ic'>" + (m.done ? '✓' : '') + "</span><div><div class='t'>" + esc(m.t) + "</div><div class='st'>" + (m.done ? 'Done' : 'Pending') + '</div></div></div>';
  }).join('');
  d.innerHTML =
    "<div class='dr-head'><button class='x' id='drX'>×</button><h3>" + esc(c.co) + "</h3><div class='cidline'>" + esc(c.cid) + "</div><div class='dr-pills'>" +
      "<span class='pill' style='background:" + (isA ? 'var(--accent-soft)' : '#F0EFEF') + ';color:' + (isA ? 'var(--accent)' : 'var(--s-neutral)') + "'><span class='d' style='background:" + (isA ? 'var(--accent)' : 'var(--s-neutral)') + "'></span>" + esc(c.acct) + '</span>' +
      (c.sw === '—' ? '' : "<span class='pill' style='background:var(--surface-2);border:1px solid var(--border);color:" + swColor + "'><span class='d' style='background:" + swColor + "'></span>Pbox: " + esc(c.sw) + '</span>') +
    '</div></div>' +
    "<div class='dr-body'>" +
      "<h4>Headcount trend · since January 2026</h4>" +
      "<div class='trend'><div class='top'><span class='cur num'>" + (hc == null ? '—' : hc) + "</span><span class='delta " + dcls + "'>" + dtxt + '</span></div>' + trendChart(c.hc) + '</div>' +
      '<h4>Monthly headcount · since January 2026</h4>' + hcTable(c) +
      '<h4>Subscription &amp; ownership</h4><div class="fields">' +
        fieldRow('CSM / Owner', c.csm) + fieldRow('Current headcount', hc == null ? '—' : String(hc), true) +
        fieldRow('Closed date', c.closed, true) + fieldRow('Subscription start', c.start, true) + fieldRow('Subscription end', c.end, true) +
        fieldRow('Go-live / Handover', c.go, true) + fieldRow('Years subscribed', c.yrs) +
        fieldRow('Licenses purchased', c.lic == null ? null : String(c.lic), true) + fieldRow('Peoplebox switch', c.sw === '—' ? null : c.sw) +
        fieldRow('Integration status', c.act === '—' ? null : c.act) +
      '</div>' +
      '<h4>Billing &amp; payments</h4><div class="fields">' +
        fieldRow('Paid Clients to Sprout', c.paidSprout === '—' ? null : c.paidSprout) +
        fieldRow('Invoice from Peoplebox', c.pboxInvoiced === '—' ? null : c.pboxInvoiced) +
        fieldRow('Peoplebox invoice status', c.pboxInvoice === '—' ? null : c.pboxInvoice) +
      '</div>' +
      '<h4>Implementation milestones</h4><div class="miles">' + miles + '</div>' +
      '<h4>Upsell notes</h4>' + (c.up ? "<div class='notebox'>" + esc(c.up) + '</div>' : "<div class='notebox empty-note'>No upsell notes recorded for this client.</div>") +
    '</div>';
  d.classList.add('on'); d.setAttribute('aria-hidden', 'false'); $('#overlay').classList.add('on');
  $('#drX').onclick = closeDrawer;
}
function closeDrawer() { $('#drawer').classList.remove('on'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#overlay').classList.remove('on'); }

/* ---------- CSV ---------- */
function exportCSV() {
  var rows = filtered();
  var head = ['Closed Date', 'Company Name', 'CID', 'Account Status', 'Peoplebox Switch Status', 'Integration Status', 'CSM', 'Subscription Start', 'Subscription End', 'Go-live / Handover', 'Years Subscribed', 'Licenses', 'Current Headcount', 'Paid Clients to Sprout', 'Invoice from Peoplebox', 'Peoplebox Invoice Status'].concat(MONTHS);
  var lines = [head.join(',')];
  rows.forEach(function (c) {
    var hc = lastHC(c.hc);
    var clean = function (v) { return v === '—' ? '' : v; };
    var vals = [c.closed, c.co, c.cid, c.acct, clean(c.sw), clean(c.act), c.csm === 'Unassigned' ? '' : c.csm, c.start, c.end, c.go, c.yrs === '—' ? '' : c.yrs, c.lic == null ? '' : c.lic, hc == null ? '' : hc, clean(c.paidSprout), clean(c.pboxInvoiced), clean(c.pboxInvoice)].concat(hcWindow(c.hc).map(function (v) { return v == null ? '' : v; }));
    lines.push(vals.map(function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','));
  });
  var blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'peoplebox-clients.csv'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 500);
}

/* ---------- timestamp + chrome ---------- */
function stamp(iso) {
  var d = iso ? new Date(iso) : new Date();
  $('#refreshTs').textContent = d.toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function renderUser(me) {
  var box = $('#userBox');
  box.innerHTML =
    (me.picture ? "<img src='" + esc(me.picture) + "' alt=''/>" : '') +
    "<div><div class='nm'>" + esc(me.name || me.email) + "</div><button class='linkbtn' id='logout'>Sign out</button></div>";
  $('#logout').onclick = function () { fetch('/auth/logout', { method: 'POST' }).then(function () { location.href = '/login.html'; }); };
}
function showError(msg) {
  $('#loading').style.display = 'none';
  var e = $('#error'); e.style.display = 'block';
  e.innerHTML = '<strong>Could not load client data</strong>' + esc(msg) + "<br><br><button class='btn' onclick='location.reload()'>Retry</button>";
}

/* ---------- boot ---------- */
var lastSig = null;
// Signature of the data that actually drives the UI — used so the background
// auto-refresh only re-renders when the sheet has genuinely changed.
function sigOf(d) { return JSON.stringify([d.clients, d.billing, d.statusBreakdown, d.integrationBreakdown]); }
function applyData(payload) {
  DATA = payload;
  lastSig = sigOf(payload);
  MONTHS = (DATA.months || []).slice(winStartIdx());
  $('#loading').style.display = 'none';
  $('#app').style.display = '';
  if (!$('#fStatus').dataset.filled) { populateFilters(); $('#fStatus').dataset.filled = '1'; }
  renderKPIs(); renderBilling(); renderDonut(); render(); stamp(DATA.generatedAt);
  $('#footer').innerHTML = 'Source: Partner Products Active Clients (WIP) · ' + esc(DATA.source.tab) + ' tab · File ID ' + esc(DATA.source.spreadsheetId) + ' · Read-only. Finance-sensitive columns (ARR, PEPM, pricing, AR remarks) are excluded from this view.';
}
function load(force, silent) {
  return fetch('/api/data' + (force ? '?refresh=1' : ''), { credentials: 'same-origin' })
    .then(function (r) {
      if (r.status === 401) { if (!silent) location.href = '/login.html'; return null; }
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.message || ('HTTP ' + r.status)); });
      return r.json();
    })
    .then(function (j) {
      if (!j) return;
      // Background polls skip re-render when nothing changed, so an open
      // dashboard isn't disrupted; it updates only when the sheet does.
      if (silent && sigOf(j) === lastSig) return;
      applyData(j);
    })
    .catch(function (err) { if (!silent) showError(err.message); });
}

fetch('/api/me', { credentials: 'same-origin' })
  .then(function (r) { return r.ok ? r.json() : null; })
  .then(function (me) { if (!me) { location.href = '/login.html'; return; } renderUser(me); return load(false); });

// Auto-refresh: poll the live sheet data every 60s and re-render on change.
setInterval(function () { if (DATA) load(false, true); }, 60000);

$('#search').addEventListener('input', function (e) { state.q = e.target.value; render(); });
$('#fStatus').addEventListener('change', function (e) { state.status = e.target.value; render(); });
$('#fPaid').addEventListener('change', function (e) { state.paid = e.target.value; render(); });
$('#fPboxInv').addEventListener('change', function (e) { state.pboxInv = e.target.value; render(); });
$('#fCsm').addEventListener('change', function (e) { state.csm = e.target.value; render(); });
$('#clearBtn').addEventListener('click', function () { state = { q: '', status: '', sw: '', paid: '', pboxInv: '', csm: '' }; syncControls(); render(); });
$('#exportBtn').addEventListener('click', exportCSV);
$('#overlay').addEventListener('click', closeDrawer);
$('#refreshBtn').addEventListener('click', function () { load(true); });
document.querySelectorAll('thead th.sortable').forEach(function (th) {
  th.addEventListener('click', function () {
    var key = th.getAttribute('data-sort');
    if (sort.key === key) sort.dir *= -1; else { sort.key = key; sort.dir = key === 'hc' ? -1 : 1; }
    render();
  });
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
