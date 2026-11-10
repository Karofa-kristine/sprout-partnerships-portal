/* Peoplebox Leads — ALL HubSpot deals created from 2025-01-01 onward (no end
 * date; any stage: MQL | Opportunity | Customer | Closed Lost) across all
 * pipelines that carry a Peoplebox line item ("Peoplebox", "Perform Pro",
 * "Sprout Perform Pro"). Data: GET /api/peoplebox/leads (RADAR silver_deals +
 * silver_company + silver_line_items). Internal-only (product key 'pbleads').
 */
(function () {
  'use strict';
  var rows = [], linesBy = {}, loaded = false, loading = false;
  var state = { q: '', stage: '', pipeline: '', rep: '', journey: '', forecast: '', year: '', status: '',
    createdFrom: '', createdTo: '', closeFrom: '', closeTo: '' };
  // Date shown/filtered in the "Projected close date" column: the projected
  // close date, or the actual close date for closed leads that have none.
  var closeDay = function (r) { return String(r.projected_close_date || r.close_date || '').slice(0, 10); };
  var inRange = function (d, from, to) { if (!from && !to) return true; if (!d) return false; return (!from || d >= from) && (!to || d <= to); };
  var openD = {};

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); };
  var num = function (v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };
  var money = function (v) { return num(v).toLocaleString(undefined, { maximumFractionDigits: 0 }); };
  var money2 = function (v) { return v == null || v === '' ? '—' : num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var day = function (ts) { return ts ? String(ts).slice(0, 10) : '—'; };
  var W = 'white-space:normal;overflow-wrap:break-word;vertical-align:top;line-height:1.4;';
  var TXT = W + 'min-width:110px;max-width:280px;font-size:12.5px;';
  var NAME = W + 'min-width:220px;max-width:340px;font-weight:600;';
  var JC = { MQL: '#7C8CF8', Opportunity: '#C2841C', Customer: '#17872F', 'Closed Lost': '#c23a3a' };
  var isOngoing = function (r) { return r.journey === 'MQL' || r.journey === 'Opportunity'; };
  var isWon = function (r) { return r.journey === 'Customer'; };
  var isLost = function (r) { return r.journey === 'Closed Lost'; };
  var yearOf = function (r) { return String(r.create_date || '').slice(0, 4); };
  // Forecast category colours (Commit > Best Case > Pipeline > Omitted).
  var fcColor = function (f) { f = String(f || '').toLowerCase();
    if (/commit/.test(f)) return '#17872F'; if (/best/.test(f)) return '#C2841C';
    if (/omit/.test(f)) return 'var(--muted)'; if (f) return '#7C8CF8'; return 'var(--muted)'; };
  var chev = function (open) { return "<span class='bl-chev" + (open ? ' open' : '') + "' aria-hidden='true'>&#9656;</span>"; };

  function scoped() {
    var q = state.q.toLowerCase();
    return rows.filter(function (r) {
      if (state.stage && r.stage !== state.stage) return false;
      if (state.pipeline && r.pipeline !== state.pipeline) return false;
      if (state.rep && r.sales_rep !== state.rep) return false;
      if (state.journey && r.journey !== state.journey) return false;
      if (!inRange(String(r.create_date || '').slice(0, 10), state.createdFrom, state.createdTo)) return false;
      if (!inRange(closeDay(r), state.closeFrom, state.closeTo)) return false;
      if (state.forecast && (r.forecast_category || '') !== state.forecast) return false;
      if (state.year && yearOf(r) !== state.year) return false;
      if (state.status === 'ongoing' && !isOngoing(r)) return false;
      if (state.status === 'won' && !isWon(r)) return false;
      if (state.status === 'lost' && !isLost(r)) return false;
      if (!q) return true;
      return [r.deal_name, r.deal_id, r.company, r.sales_rep, r.products, r.stage, r.forecast_category].some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
    });
  }

  function kpi(val, name, meta, color) {
    return "<div class='kpi' style='--c:" + color + "'><div class='val'>" + val + "</div><div class='name'>" + esc(name) + "</div><div class='meta'>" + esc(meta) + '</div></div>';
  }

  function renderKpis(list) {
    var sum = function (k) { return list.reduce(function (t, r) { return t + num(r[k]); }, 0); };
    var mql = list.filter(function (r) { return r.journey === 'MQL'; }).length;
    var opp = list.filter(function (r) { return r.journey === 'Opportunity'; }).length;
    var won = list.filter(isWon), lost = list.filter(isLost);
    var wsum = function (a, k) { return a.reduce(function (t, r) { return t + num(r[k]); }, 0); };
    var period = state.year ? 'created in ' + state.year : 'created since 2025';
    var closed = won.length + lost.length;
    $('pblKpis').innerHTML =
      kpi(list.length, 'Peoplebox leads', period + ' · with a Peoplebox / Perform Pro line item', 'var(--accent)') +
      kpi(mql + opp, 'Ongoing', mql + ' MQL · ' + opp + ' Opportunity', JC.Opportunity) +
      kpi(won.length, 'Won', '₱' + money(wsum(won, 'pb_amount')) + ' Peoplebox value · ' + (closed ? Math.round(won.length / closed * 100) + '% win rate' : 'no closed leads'), JC.Customer) +
      kpi(lost.length, 'Lost', 'Closed Lost · ' + period, JC['Closed Lost']) +
      kpi('₱' + money(sum('pb_amount')), 'Peoplebox line-item value', 'sum of Peoplebox line amounts · MRR ₱' + money(sum('pb_mrr')), 'var(--brand)') +
      kpi(list.filter(function (r) { return isOngoing(r) && /commit/i.test(r.forecast_category || ''); }).length, 'Forecast: Commit',
        'ongoing leads · ' + list.filter(function (r) { return isOngoing(r) && /best/i.test(r.forecast_category || ''); }).length + ' Best Case', '#17872F');
  }

  function linesHtml(id) {
    var ls = linesBy[id] || [];
    if (!ls.length) return "<div class='bl-lines-msg'>No Peoplebox line items on this deal.</div>";
    return "<table class='bl-sub bl-lines'><thead><tr><th>Product</th><th>Product family</th><th>Status</th><th>Billing</th>" +
      "<th class='r'>Qty</th><th class='r'>Users</th><th class='r'>Unit price</th><th class='r'>Discount</th><th class='r'>Amount</th><th class='r'>MRR</th><th class='r'>Term (mo)</th></tr></thead><tbody>" +
      ls.map(function (l) {
        return "<tr><td style='" + NAME + "font-size:12.5px'>" + esc(l.product_name || '—') + '</td>' +
          "<td style='" + TXT + "'>" + esc(l.parent_product || '—') + "</td><td style='" + TXT + "'>" + esc(l.product_status || '—') + '</td>' +
          "<td style='" + TXT + "'>" + esc(l.recurring_billing_frequency || '—') + '</td>' +
          "<td class='r num'>" + (l.quantity == null ? '—' : esc(num(l.quantity))) + "</td><td class='r num'>" + (l.number_of_users == null ? '—' : esc(num(l.number_of_users))) + '</td>' +
          "<td class='r num'>" + money2(l.unit_price) + "</td><td class='r num'>" + money2(l.discount) + '</td>' +
          "<td class='r num' style='font-weight:600'>" + money2(l.amount) + "</td><td class='r num'>" + money2(l.mrr) + '</td>' +
          "<td class='r num'>" + (l.contract_term_months == null ? '—' : esc(num(l.contract_term_months))) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function render() {
    var list = scoped();
    renderKpis(list);
    $('pblBody').innerHTML = list.length ? list.map(function (r) {
      var id = r.deal_id || '', open = !!openD[id];
      var h = "<tr class='pbl-d' data-d='" + esc(id) + "' tabindex='0' aria-expanded='" + open + "'>" +
        "<td style='" + NAME + "'>" + chev(open) + esc(r.deal_name || '—') + '</td>' +
        "<td class='num' style='font-size:12.5px;color:var(--muted);white-space:nowrap'>" + esc(id || '—') + '</td>' +
        "<td style='" + TXT + "'>" + esc(r.company || '—') + '</td>' +
        "<td style='" + TXT + "'>" + esc(r.pipeline || '—') + '</td>' +
        "<td style='" + TXT + "'>" + esc(r.stage || '—') + '</td>' +
        "<td style='white-space:nowrap'><span style='font-weight:600;color:" + (JC[r.journey] || 'var(--muted)') + "'>" + esc(r.journey || '—') + '</span></td>' +
        "<td style='white-space:nowrap;font-size:12.5px;font-weight:600;color:" + fcColor(r.forecast_category) + "'>" + esc(r.forecast_category || '—') + '</td>' +
        "<td style='" + TXT + "'>" + esc(r.sales_rep || '—') + '</td>' +
        "<td class='num' style='font-size:12.5px;color:var(--muted);white-space:nowrap'>" + day(r.create_date) + '</td>' +
        "<td class='num' style='font-size:12.5px;color:var(--muted);white-space:nowrap'>" + (closeDay(r) || '—') + (!r.projected_close_date && r.close_date ? " <small style='color:var(--faint)'>closed</small>" : '') + '</td>' +
        "<td class='r num' style='white-space:nowrap'>" + money2(r.pb_amount) + '</td>' +
        "<td class='r num' style='white-space:nowrap'>" + money2(r.pb_mrr) + '</td>' +
        "<td style='" + TXT + "'>" + esc(r.products || '—') + '</td></tr>';
      if (open) h += "<tr class='bl-nest'><td colspan='13'>" + linesHtml(id) + '</td></tr>';
      return h;
    }).join('') : "<tr><td colspan='13'><div class='empty'><strong>No Peoplebox leads match.</strong></div></td></tr>";
    $('pblFoot').textContent = list.length + ' of ' + rows.length + ' Peoplebox leads (created 2025 onward) · click a lead to see its Peoplebox line items';
  }

  function fill(id, label, key, cur) {
    // label is ignored for column-header filters (they read "All").
    if ($(id) && $(id).classList.contains('cflt')) label = 'All';
    var seen = {}, vals = [];
    rows.forEach(function (r) { var v = r[key]; if (v && !seen[v]) { seen[v] = 1; vals.push(v); } });
    vals.sort();
    $(id).innerHTML = '<option value="">' + label + '</option>' + vals.map(function (v) { return '<option' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
  }

  function msg(html, err) { $('pblBody').innerHTML = "<tr><td colspan='13'><div class='empty'" + (err ? " style='color:#c23a3a'" : '') + '>' + html + '</div></td></tr>'; }

  function load(force) {
    if ((loaded && !force) || loading) return;
    loading = true; $('pblRefresh').disabled = true; $('pblKpis').innerHTML = '';
    msg("<div class='sp' style='margin:0 auto 10px'></div>Loading Peoplebox leads from RADAR…");
    fetch('/api/peoplebox/leads' + (force ? '?refresh=1' : ''), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) return r.json().then(function (j) { throw new Error(j.message || ('HTTP ' + r.status)); }); return r.json(); })
      .then(function (d) {
        if (!d.configured) { msg('<strong>RADAR connection not configured.</strong>Set RADAR_DB_HOST, RADAR_DB_TOKEN and RADAR_WAREHOUSE_ID on the server.'); return; }
        rows = d.rows || []; linesBy = {};
        (d.lines || []).forEach(function (l) { (linesBy[l.deal_id] = linesBy[l.deal_id] || []).push(l); });
        loaded = true;
        fill('pblStage', 'All stages', 'stage', state.stage);
        fill('pblPipeline', 'All pipelines', 'pipeline', state.pipeline);
        fill('pblRep', 'All sales reps', 'sales_rep', state.rep);
        fill('pblJourney', 'All', 'journey', state.journey);
        fill('pblForecast', 'All forecast categories', 'forecast_category', state.forecast);
        var years = {}; rows.forEach(function (r) { var y = yearOf(r); if (y) years[y] = 1; });
        $('pblYear').innerHTML = '<option value="">All years (2025 onward)</option>' + Object.keys(years).sort().reverse().map(function (y) { return '<option' + (y === state.year ? ' selected' : '') + '>' + y + '</option>'; }).join('');
        $('pblStamp').textContent = d.fetchedAt ? 'RADAR data as of ' + new Date(d.fetchedAt).toLocaleString() : '';
        render();
      })
      .catch(function (e) { msg('<strong>Could not connect to RADAR.</strong>' + esc(e.message), true); })
      .then(function () { loading = false; $('pblRefresh').disabled = false; });
  }

  function onToggle(e) {
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    var d = e.target.closest('tr.pbl-d'); if (!d) return;
    if (e.type === 'keydown') e.preventDefault();
    var id = d.getAttribute('data-d'); openD[id] = !openD[id]; render();
  }

  var inited = false;
  function init() {
    if (inited || !$('pblBody')) return; inited = true;
    $('pblBody').addEventListener('click', onToggle);
    $('pblBody').addEventListener('keydown', onToggle);
    $('pblRefresh').addEventListener('click', function () { load(true); });
    $('pblSearch').addEventListener('input', function (e) { state.q = e.target.value; if (loaded) render(); });
    $('pblStage').addEventListener('change', function (e) { state.stage = e.target.value; if (loaded) render(); });
    $('pblPipeline').addEventListener('change', function (e) { state.pipeline = e.target.value; if (loaded) render(); });
    $('pblRep').addEventListener('change', function (e) { state.rep = e.target.value; if (loaded) render(); });
    $('pblJourney').addEventListener('change', function (e) { state.journey = e.target.value; if (loaded) render(); });
    [['pblCreatedFrom', 'createdFrom'], ['pblCreatedTo', 'createdTo'], ['pblCloseFrom', 'closeFrom'], ['pblCloseTo', 'closeTo']].forEach(function (p) {
      $(p[0]).addEventListener('change', function (e) { state[p[1]] = e.target.value; if (loaded) render(); });
    });
    $('pblClearCols').addEventListener('click', function () {
      ['pblPipeline', 'pblStage', 'pblJourney', 'pblRep', 'pblCreatedFrom', 'pblCreatedTo', 'pblCloseFrom', 'pblCloseTo'].forEach(function (id) { $(id).value = ''; });
      state.pipeline = state.stage = state.journey = state.rep = '';
      state.createdFrom = state.createdTo = state.closeFrom = state.closeTo = '';
      if (loaded) render();
    });
    $('pblForecast').addEventListener('change', function (e) { state.forecast = e.target.value; if (loaded) render(); });
    $('pblYear').addEventListener('change', function (e) { state.year = e.target.value; if (loaded) render(); });
    $('pblStatus').addEventListener('change', function (e) { state.status = e.target.value; if (loaded) render(); });
  }
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();

  window.PeopleboxLeads = { load: function () { load(false); } };
})();
