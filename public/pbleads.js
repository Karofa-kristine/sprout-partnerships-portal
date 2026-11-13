/* Peoplebox Leads — ALL HubSpot deals created in 2025–2026 (2025-01-01 ..
 * 2026-12-31; any stage: MQL | Opportunity | Customer | Closed Lost) across all
 * pipelines that carry a Peoplebox line item ("Peoplebox", "Perform Pro",
 * "Sprout Perform Pro"). Data: GET /api/peoplebox/leads (RADAR silver_deals +
 * silver_company + silver_line_items). Internal-only (product key 'pbleads').
 */
(function () {
  'use strict';
  // rows: leads shown in the table. hiddenWon: won deals in the Project Handover /
  // Contract Signed stages (excluded_stage = 'Y') — hidden from the table but
  // still counted in the Won KPI and win rate.
  var rows = [], hiddenWon = [], linesBy = {}, loaded = false, loading = false;
  // Multi-select filters: each holds the list of ticked values ([] = all).
  var state = { q: '', stage: [], pipeline: [], rep: [], journey: [], forecast: [], year: [], status: [],
    createdFrom: '', createdTo: '', closeFrom: '', closeTo: '' };
  var NOT_SET = '(not set)';
  var MS = [
    { id: 'pblYear', key: 'year', label: 'Year', all: 'All years (2025–2026)', get: function (r) { return yearOf(r); }, desc: true },
    { id: 'pblStatus', key: 'status', label: 'Status', all: 'All statuses', fixed: [['ongoing', 'Ongoing (MQL + Opportunity)'], ['won', 'Won'], ['lost', 'Lost']],
      test: function (r, v) { return v === 'ongoing' ? isOngoing(r) : v === 'won' ? isWon(r) : isLost(r); } },
    { id: 'pblForecast', key: 'forecast', label: 'Forecast', all: 'All forecast categories', get: function (r) { return r.forecast_category || NOT_SET; } },
    { id: 'pblPipeline', key: 'pipeline', label: 'Pipeline', all: 'All', get: function (r) { return r.pipeline || NOT_SET; } },
    { id: 'pblStage', key: 'stage', label: 'Stage', all: 'All', get: function (r) { return r.stage || NOT_SET; } },
    { id: 'pblJourney', key: 'journey', label: 'Journey', all: 'All', get: function (r) { return r.journey || NOT_SET; } },
    { id: 'pblRep', key: 'rep', label: 'Sales rep', all: 'All', get: function (r) { return r.sales_rep || NOT_SET; } },
  ];
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

  function scoped(src) {
    var q = state.q.toLowerCase();
    return (src || rows).filter(function (r) {
      for (var i = 0; i < MS.length; i++) {
        var m = MS[i], sel = state[m.key];
        if (!sel.length) continue;
        var ok = m.test ? sel.some(function (v) { return m.test(r, v); }) : sel.indexOf(m.get(r)) >= 0;
        if (!ok) return false;
      }
      if (!inRange(String(r.create_date || '').slice(0, 10), state.createdFrom, state.createdTo)) return false;
      if (!inRange(closeDay(r), state.closeFrom, state.closeTo)) return false;
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
    // Won includes the hidden Project Handover / Contract Signed won deals
    // (same filters applied), so the win rate counts every won deal.
    var hw = scoped(hiddenWon);
    var won = list.filter(isWon).concat(hw), lost = list.filter(isLost);
    var wsum = function (a, k) { return a.reduce(function (t, r) { return t + num(r[k]); }, 0); };
    var period = state.year.length ? 'created in ' + state.year.slice().sort().join(', ') : 'created 2025–2026';
    var closed = won.length + lost.length;
    $('pblKpis').innerHTML =
      kpi(list.length, 'Peoplebox leads', period + ' · with a Peoplebox / Perform Pro line item', 'var(--accent)') +
      kpi(mql + opp, 'Ongoing', mql + ' MQL · ' + opp + ' Opportunity', JC.Opportunity) +
      kpi(won.length, 'Won', '₱' + money(wsum(won, 'pb_amount')) + ' Peoplebox value · ' + (closed ? Math.round(won.length / closed * 100) + '% win rate' : 'no closed leads') +
        (hw.length ? ' · incl. ' + hw.length + ' in Project Handover / Contract Signed (not listed below)' : ''), JC.Customer) +
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
    $('pblFoot').textContent = list.length + ' of ' + rows.length + ' Peoplebox leads (created 2025–2026) · click a lead to see its Peoplebox line items';
  }

  // ---- Multi-select dropdown (button + tick-box list) ----
  function mselOptions(m) {
    if (m.fixed) return m.fixed;
    var seen = {}, vals = [];
    rows.forEach(function (r) { var v = m.get(r); if (v && !seen[v]) { seen[v] = 1; vals.push(v); } });
    vals.sort(function (a, b) { if (a === NOT_SET) return 1; if (b === NOT_SET) return -1; return a.localeCompare(b); });
    if (m.desc) vals.reverse();
    return vals.map(function (v) { return [v, v]; });
  }
  function mselSummary(m) {
    var sel = state[m.key];
    if (!sel.length) return m.all;
    if (sel.length === 1) { var o = (m.fixed || []).filter(function (f) { return f[0] === sel[0]; })[0]; return o ? o[1] : sel[0]; }
    return sel.length + ' selected';
  }
  function buildMsel(m) {
    var el = $(m.id); if (!el) return;
    var opts = mselOptions(m), sel = state[m.key];
    // Drop ticked values that no longer exist after a refresh.
    state[m.key] = sel.filter(function (v) { return opts.some(function (o) { return o[0] === v; }); });
    var open = el.classList.contains('open');
    el.innerHTML = "<button type='button' class='msel-btn' aria-haspopup='listbox' aria-expanded='" + open + "' title='" + esc(m.label) + "'>" +
      "<span class='msel-txt'>" + esc(mselSummary(m)) + "</span><span class='msel-car' aria-hidden='true'>&#9662;</span></button>" +
      "<div class='msel-pop' role='listbox' aria-multiselectable='true' aria-label='" + esc(m.label) + "'>" +
      "<div class='msel-acts'><button type='button' data-act='all'>Select all</button><button type='button' data-act='none'>Clear</button></div>" +
      "<div class='msel-list'>" + opts.map(function (o) {
        var on = state[m.key].indexOf(o[0]) >= 0;
        return "<label class='msel-opt'><input type='checkbox' value='" + esc(o[0]) + "'" + (on ? ' checked' : '') + '/><span>' + esc(o[1]) + '</span></label>';
      }).join('') + (opts.length ? '' : "<div class='msel-empty'>No values</div>") + '</div></div>';
  }
  function buildAllMsel() { MS.forEach(buildMsel); }
  function refreshSummaries() {
    MS.forEach(function (m) { var el = $(m.id); if (!el) return; var t = el.querySelector('.msel-txt'); if (t) t.textContent = mselSummary(m);
      el.classList.toggle('active', state[m.key].length > 0); });
  }
  function closeAllMsel(except) {
    document.querySelectorAll('#pbleadsPanel .msel.open').forEach(function (el) {
      if (el === except) return; el.classList.remove('open'); var b = el.querySelector('.msel-btn'); if (b) b.setAttribute('aria-expanded', 'false');
    });
  }
  // The list is position:fixed so the scrolling table can't clip it; place it
  // under its button (or above, if there's no room below) and keep it on-screen.
  function placePop(el) {
    var pop = el.querySelector('.msel-pop'), b = el.querySelector('.msel-btn'); if (!pop || !b) return;
    var r = b.getBoundingClientRect(), w = Math.max(220, r.width);
    pop.style.minWidth = w + 'px';
    var left = Math.min(r.left, window.innerWidth - w - 8); pop.style.left = Math.max(8, left) + 'px';
    var below = window.innerHeight - r.bottom, h = Math.min(pop.scrollHeight || 320, 340);
    if (below < h + 12 && r.top > below) { pop.style.top = ''; pop.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { pop.style.bottom = ''; pop.style.top = (r.bottom + 4) + 'px'; }
  }
  function wireMsel(m) {
    var el = $(m.id); if (!el) return;
    el.addEventListener('click', function (e) {
      var btn = e.target.closest('.msel-btn');
      if (btn) {
        var willOpen = !el.classList.contains('open'); closeAllMsel(el); el.classList.toggle('open', willOpen); btn.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) placePop(el);
        return;
      }
      var act = e.target.closest('[data-act]');
      if (act) {
        state[m.key] = act.getAttribute('data-act') === 'all' ? mselOptions(m).map(function (o) { return o[0]; }) : [];
        el.querySelectorAll('input[type=checkbox]').forEach(function (c) { c.checked = state[m.key].indexOf(c.value) >= 0; });
        refreshSummaries(); if (loaded) render();
      }
    });
    el.addEventListener('change', function (e) {
      if (e.target.type !== 'checkbox') return;
      state[m.key] = Array.prototype.filter.call(el.querySelectorAll('input[type=checkbox]'), function (c) { return c.checked; }).map(function (c) { return c.value; });
      refreshSummaries(); if (loaded) render();
    });
    el.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeAllMsel(); var b = el.querySelector('.msel-btn'); if (b) b.focus(); } });
  }

  function msg(html, err) { $('pblBody').innerHTML = "<tr><td colspan='13'><div class='empty'" + (err ? " style='color:#c23a3a'" : '') + '>' + html + '</div></td></tr>'; }

  function load(force) {
    if ((loaded && !force) || loading) return;
    loading = true; $('pblRefresh').disabled = true; $('pblKpis').innerHTML = '';
    msg("<div class='sp' style='margin:0 auto 10px'></div>Loading Peoplebox leads from RADAR…");
    radarFetch('/api/peoplebox/leads' + (force ? '?refresh=1' : ''))
      .then(function (d) {
        if (!d.configured) { msg('<strong>RADAR connection not configured.</strong>Set RADAR_DB_HOST, RADAR_DB_TOKEN and RADAR_WAREHOUSE_ID on the server.'); return; }
        var all = d.rows || []; linesBy = {};
        rows = all.filter(function (r) { return r.excluded_stage !== 'Y'; });
        hiddenWon = all.filter(function (r) { return r.excluded_stage === 'Y' && isWon(r); });
        (d.lines || []).forEach(function (l) { (linesBy[l.deal_id] = linesBy[l.deal_id] || []).push(l); });
        loaded = true;
        buildAllMsel(); refreshSummaries();
        $('pblStamp').textContent = (d.fetchedAt ? 'RADAR data as of ' + new Date(d.fetchedAt).toLocaleString() : '') + radarStaleNote(d);
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
    buildAllMsel(); MS.forEach(wireMsel);
    document.addEventListener('click', function (e) { if (!e.target.closest('#pbleadsPanel .msel')) closeAllMsel(); });
    // Close an open list when the page or table scrolls (it is fixed-positioned).
    window.addEventListener('scroll', function (e) {
      // Scrolling inside an open list must not close it.
      if (e.target && e.target.closest && e.target.closest('.msel-pop')) return;
      closeAllMsel();
    }, true);
    window.addEventListener('resize', function () { closeAllMsel(); });
    [['pblCreatedFrom', 'createdFrom'], ['pblCreatedTo', 'createdTo'], ['pblCloseFrom', 'closeFrom'], ['pblCloseTo', 'closeTo']].forEach(function (p) {
      $(p[0]).addEventListener('change', function (e) { state[p[1]] = e.target.value; if (loaded) render(); });
    });
    $('pblClearCols').addEventListener('click', function () {
      MS.forEach(function (m) { state[m.key] = []; });
      ['pblCreatedFrom', 'pblCreatedTo', 'pblCloseFrom', 'pblCloseTo'].forEach(function (id) { $(id).value = ''; });
      state.createdFrom = state.createdTo = state.closeFrom = state.closeTo = '';
      buildAllMsel(); refreshSummaries(); if (loaded) render();
    });
  }
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();

  window.PeopleboxLeads = { load: function () { load(false); } };
})();
