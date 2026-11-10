/* ChannelHub — Unified Channel Pipeline deals from RADAR (shared.revops).
 * Data: GET /api/channelhub (silver_deals ⨝ silver_company, pipeline =
 * 'Unified Channel Pipeline'), line items: GET /api/channelhub/lines?deal=<id>
 * (silver_line_items). Only leads CREATED in 2025–2026 are loaded (server-side
 * filter on create_date); the year toggle (2025–2026 / 2025 / 2026) narrows by
 * create_date, so every KPI is for the leads created in that period (cohort view).
 */
(function () {
  'use strict';
  var NO_PARTNER = '(No partner on record)';
  var rows = [], loaded = false, loading = false, fetchedAt = '';
  var state = { range: 'all', q: '', stage: '', rep: '' };
  var openP = {}, openD = {}, linesCache = {};

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); };
  var num = function (v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };
  var money = function (v) { return num(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }); };
  var money2 = function (v) { return v == null || v === '' ? '—' : num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var day = function (ts) { return ts ? String(ts).slice(0, 10) : '—'; };
  var isOpen = function (r) { return r.journey === 'MQL' || r.journey === 'Opportunity'; };
  var isWon = function (r) { return r.journey === 'Customer'; };
  var isLost = function (r) { return r.journey === 'Closed Lost'; };
  var inRange = function (r) { return state.range === 'all' || String(r.create_date || '').slice(0, 4) === state.range; };
  var rangeLabel = function () { return state.range === 'all' ? '2025–2026' : state.range; };
  var chev = function (open) { return "<span class='bl-chev" + (open ? ' open' : '') + "' aria-hidden='true'>&#9656;</span>"; };
  var JOURNEY_COLOR = { MQL: '#7C8CF8', Opportunity: '#C2841C', Customer: '#17872F', 'Closed Lost': '#c23a3a' };

  // Leads that count for the selected period (by create_date).
  function scoped() {
    var q = state.q.toLowerCase();
    return rows.filter(function (r) {
      if (!inRange(r)) return false;
      if (state.stage && r.stage !== state.stage) return false;
      if (state.rep && r.sales_rep !== state.rep) return false;
      if (!q) return true;
      return [r.partner, r.deal_name, r.company, r.sales_rep, r.stage].some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
    });
  }

  function kpiCard(val, name, meta, color) {
    return "<div class='kpi' style='--c:" + color + "'><div class='val'>" + val + "</div><div class='name'>" + esc(name) + "</div><div class='meta'>" + esc(meta) + "</div></div>";
  }

  function renderKpis(list) {
    var won = list.filter(isWon);
    var lost = list.filter(isLost);
    var qualified = list.filter(function (r) { return r.qualified_lead === 'Yes'; });
    var open = list.filter(isOpen);
    var partners = {}; list.forEach(function (r) { if (r.partner) partners[r.partner] = 1; });
    var sum = function (a, k) { return a.reduce(function (t, r) { return t + num(r[k]); }, 0); };
    var winRate = won.length + lost.length ? Math.round(won.length / (won.length + lost.length) * 100) + '%' : '—';
    var lbl = 'leads created ' + rangeLabel();
    $('chKpis').innerHTML =
      kpiCard(Object.keys(partners).length, 'Active channel partners', 'partners with ' + lbl, 'var(--accent)') +
      kpiCard(list.length, 'Leads', qualified.length + ' qualified · ' + lbl, '#7C8CF8') +
      kpiCard(open.length, 'Open pipeline', '₱' + money(sum(open, 'amount')) + ' · still MQL / Opportunity', '#C2841C') +
      kpiCard(won.length, 'Leads won', '₱' + money(sum(won, 'amount')) + ' · ' + lbl, '#17872F') +
      kpiCard('₱' + money(sum(won, 'mrr')), 'Won MRR', 'rev-share MRR ₱' + money(sum(won, 'revshare_mrr')) + ' · ' + lbl, 'var(--brand)') +
      kpiCard(winRate, 'Win rate', won.length + ' won · ' + lost.length + ' lost · ' + lbl, '#17B5B0');
  }

  function renderStages(list) {
    var by = {}, order = [];
    list.forEach(function (r) {
      var k = r.stage || '—';
      if (!by[k]) { by[k] = { stage: k, journey: r.journey, n: 0, amt: 0 }; order.push(k); }
      by[k].n++; by[k].amt += num(r.amount);
    });
    var stages = order.map(function (k) { return by[k]; });
    var rank = { MQL: 0, Opportunity: 1, Customer: 2, 'Closed Lost': 3 };
    stages.sort(function (a, b) { return ((rank[a.journey] == null ? 9 : rank[a.journey]) - (rank[b.journey] == null ? 9 : rank[b.journey])) || b.n - a.n; });
    var max = stages.reduce(function (m, s) { return Math.max(m, s.n); }, 1);
    $('chStages').innerHTML = stages.length ? stages.map(function (s) {
      var c = JOURNEY_COLOR[s.journey] || 'var(--muted)';
      return "<div class='ch-stage'><div class='ch-stage-l'><span class='ch-dot' style='background:" + c + "'></span>" + esc(s.stage) +
        "<small>" + esc(s.journey || '') + "</small></div><div class='ch-bar'><span style='width:" + Math.max(2, s.n / max * 100) + "%;background:" + c + "'></span></div>" +
        "<div class='ch-stage-n num'>" + s.n + "</div><div class='ch-stage-a num'>₱" + money(s.amt) + "</div></div>";
    }).join('') : "<div class='empty'>No deals in this range.</div>";
  }

  function groupPartners(list) {
    var by = {}, order = [];
    list.forEach(function (r) {
      var k = r.partner || NO_PARTNER;
      if (!by[k]) { by[k] = { key: k, deals: [], open: 0, openAmt: 0, won: 0, wonAmt: 0, mrr: 0, lost: 0, latest: '' }; order.push(k); }
      var g = by[k]; g.deals.push(r);
      if (isOpen(r)) { g.open++; g.openAmt += num(r.amount); }
      if (isWon(r)) { g.won++; g.wonAmt += num(r.amount); g.mrr += num(r.mrr); }
      if (isLost(r)) g.lost++;
      var last = String(r.close_date || r.create_date || ''); if (last > g.latest) g.latest = last;
    });
    return order.map(function (k) { return by[k]; }).sort(function (a, b) {
      if (a.key === NO_PARTNER) return 1; if (b.key === NO_PARTNER) return -1;
      return (b.wonAmt + b.openAmt) - (a.wonAmt + a.openAmt) || a.key.localeCompare(b.key);
    });
  }

  function partnerRow(g) {
    var open = !!openP[g.key], wr = g.won + g.lost ? Math.round(g.won / (g.won + g.lost) * 100) + '%' : '—';
    var h = "<tr class='bl-co ch-p' data-p='" + esc(g.key) + "' tabindex='0' aria-expanded='" + open + "'>" +
      "<td style='font-weight:600'>" + chev(open) + esc(g.key) + "</td>" +
      "<td class='r num'>" + g.deals.length + "</td>" +
      "<td class='r num'>" + (g.open || '—') + "</td><td class='r num'>" + (g.openAmt ? money(g.openAmt) : '—') + "</td>" +
      "<td class='r num' style='color:#17872F;font-weight:600'>" + (g.won || '—') + "</td><td class='r num'>" + (g.wonAmt ? money(g.wonAmt) : '—') + "</td>" +
      "<td class='r num'>" + (g.mrr ? money(g.mrr) : '—') + "</td>" +
      "<td class='r num'>" + (g.lost || '—') + "</td><td class='r num'>" + wr + "</td>" +
      "<td class='num' style='font-size:12.5px;color:var(--muted)'>" + day(g.latest) + "</td></tr>";
    if (open) h += "<tr class='bl-nest'><td colspan='10'>" + dealsTable(g.deals) + "</td></tr>";
    return h;
  }

  function dealsTable(deals) {
    var h = "<table class='bl-sub'><thead><tr><th>Deal</th><th>Company</th><th>Stage</th><th>Journey</th><th>Sales rep</th>" +
      "<th>Created</th><th>Close</th><th class='r'>Amount</th><th class='r'>MRR</th><th class='r'>Rev-share MRR</th><th>Forecast</th></tr></thead><tbody>";
    deals.forEach(function (r) {
      var id = r.deal_id || '', open = !!openD[id], c = JOURNEY_COLOR[r.journey] || 'var(--muted)';
      h += "<tr class='bl-inv ch-d' data-d='" + esc(id) + "' tabindex='0' aria-expanded='" + open + "'>" +
        "<td style='font-weight:600;max-width:280px'>" + chev(open) + esc(r.deal_name || '—') + "</td>" +
        "<td style='font-size:12.5px'>" + esc(r.company || '—') + "</td>" +
        "<td style='font-size:12.5px'>" + esc(r.stage || '—') + "</td>" +
        "<td><span style='font-weight:600;color:" + c + "'>" + esc(r.journey || '—') + "</span></td>" +
        "<td style='font-size:12.5px'>" + esc(r.sales_rep || '—') + "</td>" +
        "<td class='num' style='font-size:12.5px;color:var(--muted)'>" + day(r.create_date) + "</td>" +
        "<td class='num' style='font-size:12.5px;color:var(--muted)'>" + day(r.close_date || r.projected_close_date) + "</td>" +
        "<td class='r num'>" + money2(r.amount) + "</td><td class='r num'>" + money2(r.mrr) + "</td><td class='r num'>" + money2(r.revshare_mrr) + "</td>" +
        "<td style='font-size:12.5px'>" + esc(r.forecast_category || '—') + "</td></tr>";
      if (open) h += "<tr class='bl-nest'><td colspan='11'>" + linesHtml(id) + "</td></tr>";
    });
    return h + '</tbody></table>';
  }

  function linesHtml(id) {
    var st = linesCache[id];
    if (!st || st.loading) return "<div class='bl-lines-msg'>Loading line items…</div>";
    if (st.error) return "<div class='bl-lines-msg' style='color:#c23a3a'><strong>Could not load line items.</strong> " + esc(st.error) + '</div>';
    if (!st.rows.length) return "<div class='bl-lines-msg'>No line items on this deal.</div>";
    return "<table class='bl-sub bl-lines'><thead><tr><th>Product</th><th>Product family</th><th>Clan</th><th>Status</th><th>Billing</th>" +
      "<th class='r'>Qty</th><th class='r'>Unit price</th><th class='r'>Discount</th><th class='r'>Amount</th><th class='r'>MRR</th><th class='r'>Rev share</th><th class='r'>Term (mo)</th></tr></thead><tbody>" +
      st.rows.map(function (l) {
        return "<tr><td style='font-size:12.5px;font-weight:600'>" + esc(l.product_name || '—') + "</td>" +
          "<td style='font-size:12.5px'>" + esc(l.parent_product || '—') + "</td><td style='font-size:12.5px'>" + esc(l.clan || '—') + "</td>" +
          "<td style='font-size:12.5px'>" + esc(l.product_status || '—') + "</td><td style='font-size:12.5px'>" + esc(l.recurring_billing_frequency || '—') + "</td>" +
          "<td class='r num'>" + (l.quantity == null ? '—' : esc(num(l.quantity))) + "</td><td class='r num'>" + money2(l.unit_price) + "</td>" +
          "<td class='r num'>" + money2(l.discount) + "</td><td class='r num' style='font-weight:600'>" + money2(l.amount) + "</td>" +
          "<td class='r num'>" + money2(l.mrr) + "</td><td class='r num'>" + money2(l.revenue_share) + "</td>" +
          "<td class='r num'>" + (l.contract_term_months == null ? '—' : esc(num(l.contract_term_months))) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function loadLines(id) {
    if (linesCache[id] && !linesCache[id].error) return;
    linesCache[id] = { loading: true };
    fetch('/api/channelhub/lines?deal=' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) return r.json().then(function (j) { throw new Error(j.message || ('HTTP ' + r.status)); }); return r.json(); })
      .then(function (d) { linesCache[id] = { rows: d.rows || [] }; })
      .catch(function (e) { linesCache[id] = { error: e.message }; })
      .then(function () { if (openD[id]) render(); });
  }

  function fillSelect(id, label, key, cur) {
    var seen = {}, vals = [];
    rows.forEach(function (r) { var v = r[key]; if (v && !seen[v]) { seen[v] = 1; vals.push(v); } });
    vals.sort();
    $(id).innerHTML = '<option value="">' + label + '</option>' + vals.map(function (v) { return '<option' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
  }

  function render() {
    var list = scoped();
    renderKpis(list); renderStages(list);
    var groups = groupPartners(list);
    $('chBody').innerHTML = groups.length ? groups.map(partnerRow).join('') :
      "<tr><td colspan='10'><div class='empty'><strong>No deals match.</strong></div></td></tr>";
    $('chFoot').textContent = groups.length + ' partners · ' + list.length + ' of ' + rows.length + ' Unified Channel Pipeline leads created ' + rangeLabel() +
      ' · click a partner for its leads, then a lead for line items';
  }

  function setStatus(html, isErr) {
    $('chBody').innerHTML = "<tr><td colspan='10'><div class='empty'" + (isErr ? " style='color:#c23a3a'" : '') + '>' + html + '</div></td></tr>';
  }

  function load(force) {
    if ((loaded && !force) || loading) return;
    loading = true;
    $('chRefresh').disabled = true;
    setStatus("<div class='sp' style='margin:0 auto 10px'></div>Loading Unified Channel Pipeline from RADAR…");
    $('chKpis').innerHTML = ''; $('chStages').innerHTML = '';
    fetch('/api/channelhub' + (force ? '?refresh=1' : ''), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) return r.json().then(function (j) { throw new Error(j.message || ('HTTP ' + r.status)); }); return r.json(); })
      .then(function (d) {
        if (!d.configured) { setStatus('<strong>RADAR connection not configured.</strong>Set RADAR_DB_HOST, RADAR_DB_TOKEN and RADAR_WAREHOUSE_ID on the server.'); return; }
        rows = d.rows || []; fetchedAt = d.fetchedAt || ''; loaded = true;
        if (force) linesCache = {};
        fillSelect('chStage', 'All stages', 'stage', state.stage);
        fillSelect('chRep', 'All sales reps', 'sales_rep', state.rep);
        $('chStamp').textContent = fetchedAt ? 'RADAR data as of ' + new Date(fetchedAt).toLocaleString() : '';
        render();
      })
      .catch(function (e) { setStatus('<strong>Could not connect to RADAR.</strong>' + esc(e.message), true); })
      .then(function () { loading = false; $('chRefresh').disabled = false; });
  }

  function onToggle(e) {
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    var d = e.target.closest('tr.ch-d'), p = e.target.closest('tr.ch-p');
    if (!d && !p) return;
    if (e.type === 'keydown') e.preventDefault();
    if (d) { var id = d.getAttribute('data-d'); openD[id] = !openD[id]; if (openD[id]) loadLines(id); }
    else { var k = p.getAttribute('data-p'); openP[k] = !openP[k]; }
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
  var inited = false;
  function init() {
    if (inited || !$('chBody')) return; inited = true;
    $('chBody').addEventListener('click', onToggle);
    $('chBody').addEventListener('keydown', onToggle);
    $('chRefresh').addEventListener('click', function () { load(true); });
    $('chRange').addEventListener('change', function (e) { state.range = e.target.value; if (loaded) render(); });
    $('chStage').addEventListener('change', function (e) { state.stage = e.target.value; if (loaded) render(); });
    $('chRep').addEventListener('change', function (e) { state.rep = e.target.value; if (loaded) render(); });
    $('chSearch').addEventListener('input', function (e) { state.q = e.target.value; if (loaded) render(); });
  }

  window.ChannelHub = { load: function () { load(false); } };
})();
