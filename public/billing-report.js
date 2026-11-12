/* Reusable Billing & AR report (same as Peoplebox Billing) for a partner
 * product. Clients come from RADAR (companies with a won deal carrying the
 * product's line items); invoices from gold_billing_360. Drill-down:
 * client → invoices → invoice line items.
 *
 *   window.makeBillingReport({
 *     product: 'teamtailor', label: 'Teamtailor', tab: 'ttbill', back: 'teamtailor',
 *     memoTerms: ['teamtailor', 'team tailor'],
 *   })  → { load }
 *
 * Data: GET /api/pbilling/<product>  ·  GET /api/pbilling/<product>/lines?invoice=
 * (The Peoplebox Billing tab keeps its own inline code in index.html.)
 */
(function () {
  'use strict';

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); };
  var num = function (v) { var n = parseFloat(v); return isNaN(n) ? null : n; };
  var money = function (v) { var n = num(v); return n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  // Collection-status colour: paid=green, unpaid/overdue=red, partial=amber.
  var colColor = function (s) { s = String(s || '').toLowerCase();
    if (/paid|closed/.test(s) && !/unpaid|partial/.test(s)) return '#17872F';
    if (/partial/.test(s)) return '#C2841C';
    if (/unpaid|overdue/.test(s)) return '#c23a3a';
    return 'var(--muted)'; };
  var chev = function (open) { return "<span class='bl-chev" + (open ? ' open' : '') + "' aria-hidden='true'>&#9656;</span>"; };
  var WRAP = 'font-size:12.5px;white-space:normal;overflow-wrap:break-word;vertical-align:top;';

  // Line-item columns: show familiar NetSuite fields when present (first
  // matching name wins); otherwise fall back to every non-empty column.
  var LINE_COLS = [
    { label: 'Line', keys: ['linesequencenumber', 'line_sequence_number', 'line_number', 'linenumber'] },
    { label: 'Item', keys: ['item_name', 'item_display_name', 'itemname', 'item_id_name', 'item', 'item_id'] },
    { label: 'Description', keys: ['description', 'item_description', 'memo', 'line_memo'] },
    { label: 'Qty', keys: ['quantity', 'qty'], num: true },
    { label: 'Rate', keys: ['rate', 'unit_price', 'price'], money: true },
    { label: 'Amount', keys: ['amount', 'net_amount', 'netamount', 'foreign_amount', 'foreignamount', 'line_amount'], money: true },
    { label: 'Tax', keys: ['tax_amount', 'taxamount', 'tax_code', 'taxcode'] },
  ];
  function lineColumns(rows) {
    var cols = rows.length ? Object.keys(rows[0]) : [], lower = cols.map(function (c) { return c.toLowerCase(); });
    var picked = [];
    LINE_COLS.forEach(function (d) {
      for (var i = 0; i < d.keys.length; i++) { var at = lower.indexOf(d.keys[i]); if (at >= 0) { picked.push({ label: d.label, key: cols[at], num: d.num, money: d.money }); break; } }
    });
    if (picked.length >= 3) return picked;
    return cols.filter(function (c) { return rows.some(function (r) { return r[c] != null && r[c] !== ''; }); })
      .map(function (c) { return { label: c, key: c }; });
  }

  window.makeBillingReport = function (C) {
    var P = C.tab; // id prefix
    var data = [], loaded = false, filters = { client: '', status: '', aging: '', memo: '' };
    var openCo = {}, openInv = {}, linesCache = {};
    var memoRe = new RegExp((C.memoTerms || [C.label]).map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|'), 'i');
    var isProductMemo = function (r) { return memoRe.test(r.memo || ''); };
    var $ = function (s) { return document.getElementById(P + s); };

    // ---- Panel ----
    var panel = document.createElement('div');
    panel.className = 'wrap tabpanel hide bl-report';
    panel.id = P + 'Panel';
    panel.setAttribute('data-tab', C.tab);
    panel.innerHTML =
      "<button class='backlink' data-goto='" + esc(C.back) + "'>← Back to " + esc(C.label) + "</button>" +
      "<div class='section-head'><h2>" + esc(C.label) + " billing &amp; AR</h2><span class='note' id='" + P + "Note'>from RADAR · all invoices for " + esc(C.label) + " clients</span></div>" +
      "<p style='margin:-6px 2px 18px;color:var(--muted);font-size:12.5px;line-height:1.5;max-width:900px'>Clients are companies with a <strong>won</strong> HubSpot deal that includes a " + esc(C.label) + " line item; invoices are every non-cancelled invoice for those clients in RADAR <code>gold_billing_360</code> (matched by HubSpot Company ID).</p>" +
      "<div class='toolbar'>" +
        "<div class='search'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='11' cy='11' r='7'/><path d='m21 21-4.3-4.3'/></svg>" +
          "<input id='" + P + "Search' type='text' placeholder='Search client / invoice / memo…' autocomplete='off'/></div>" +
        "<button class='btn' id='" + P + "Refresh'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M21 12a9 9 0 1 1-2.64-6.36'/><path d='M21 3v6h-6'/></svg> Refresh</button>" +
      "</div>" +
      "<div class='filterbar' id='" + P + "Filters'></div>" +
      "<div class='table-wrap'><div class='table-scroll'><table>" +
        "<thead><tr><th>Client</th><th class='r'>Invoices</th><th>Latest invoice</th><th class='r'>Amount</th><th class='r'>Paid</th><th class='r'>Balance</th><th class='r'>Overdue invoices</th><th class='r'>Max days overdue</th></tr></thead>" +
        "<tbody id='" + P + "Body'><tr><td colspan='8'><div class='empty'>Open this report to load billing.</div></td></tr></tbody>" +
      "</table></div><div class='tablefoot' id='" + P + "Foot'></div></div>";
    var footer = document.getElementById('footer');
    footer.parentNode.insertBefore(panel, footer);

    // ---- Filters ----
    function buildFilters() {
      var bar = $('Filters'); bar.innerHTML = '';
      function addSel(label, dataKey, filterKey) {
        var seen = {}, o = []; data.forEach(function (r) { var v = (r[dataKey] || '').toString().trim(); if (v && !seen[v]) { seen[v] = 1; o.push(v); } }); o.sort();
        var sel = document.createElement('select'); sel.className = 'flt';
        sel.innerHTML = '<option value="">' + label + '</option>' + o.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('');
        sel.addEventListener('change', function () { filters[filterKey] = sel.value; render(); });
        bar.appendChild(sel);
      }
      addSel('All clients', 'client', 'client');
      addSel('All collection status', 'collection_status', 'status');
      addSel('All aging', 'aging', 'aging');
      var memoSel = document.createElement('select'); memoSel.className = 'flt';
      memoSel.innerHTML = '<option value="">All invoices (any memo)</option><option value="prod">' + esc(C.label) + ' memo only (' + data.filter(isProductMemo).length + ')</option>';
      memoSel.addEventListener('change', function () { filters.memo = memoSel.value; render(); });
      bar.appendChild(memoSel);
      var clr = document.createElement('button'); clr.className = 'btn'; clr.textContent = 'Clear';
      clr.addEventListener('click', function () { filters = { client: '', status: '', aging: '', memo: '' }; bar.querySelectorAll('select').forEach(function (s) { s.value = ''; }); render(); });
      bar.appendChild(clr);
    }

    // ---- Drill-down ----
    function groupByCompany(rows) {
      var by = {}, order = [];
      rows.forEach(function (r) {
        var k = r.hsid || r.client || '—';
        if (!by[k]) { by[k] = { key: k, client: r.client || '—', invoices: [], amt: 0, paid: 0, bal: 0, overdue: 0, maxOd: 0, latest: '' }; order.push(k); }
        var g = by[k], od = num(r.days_overdue) || 0;
        g.invoices.push(r);
        g.amt += num(r.amount) || 0; g.paid += num(r.amount_paid) || 0; g.bal += num(r.balance) || 0;
        if (od > 0 && (num(r.balance) || 0) > 0) { g.overdue++; if (od > g.maxOd) g.maxOd = od; }
        if ((r.invoice_date || '') > g.latest) g.latest = r.invoice_date || '';
      });
      return order.map(function (k) { return by[k]; }).sort(function (a, b) { return (b.bal - a.bal) || a.client.localeCompare(b.client); });
    }
    function companyRowHtml(g) {
      var open = !!openCo[g.key];
      var h = "<tr class='bl-co' data-co='" + esc(g.key) + "' tabindex='0' aria-expanded='" + open + "'>" +
        "<td style='font-weight:600'>" + chev(open) + esc(g.client) + '</td>' +
        "<td class='r num'>" + g.invoices.length + '</td>' +
        "<td class='num' style='font-size:12.5px;color:var(--muted)'>" + esc(g.latest || '—') + '</td>' +
        "<td class='r num'>" + money(g.amt) + '</td>' +
        "<td class='r num'>" + money(g.paid) + '</td>' +
        "<td class='r num' style='font-weight:600" + (g.bal > 0 ? ';color:#c23a3a' : '') + "'>" + money(g.bal) + '</td>' +
        "<td class='r num'" + (g.overdue ? " style='color:#c23a3a;font-weight:600'" : '') + '>' + (g.overdue || '—') + '</td>' +
        "<td class='r num'" + (g.maxOd ? " style='color:#c23a3a;font-weight:600'" : '') + '>' + (g.maxOd || '—') + '</td></tr>';
      if (open) h += "<tr class='bl-nest'><td colspan='8'>" + invoiceTableHtml(g.invoices) + '</td></tr>';
      return h;
    }
    function invoiceTableHtml(invs) {
      var h = "<table class='bl-sub'><thead><tr><th>Invoice #</th><th>Invoice date</th><th>Due date</th><th>Status</th><th>Collection</th>" +
        "<th class='r'>Amount</th><th class='r'>Paid</th><th class='r'>Balance</th><th>Aging</th><th class='r'>Days overdue</th><th>Memo</th></tr></thead><tbody>";
      invs.forEach(function (r) {
        var od = num(r.days_overdue) || 0, ref = r.invoice_ref || '', open = !!openInv[ref];
        h += "<tr class='bl-inv' data-inv='" + esc(ref) + "' tabindex='0' aria-expanded='" + open + "'>" +
          "<td class='num' style='font-size:12.5px;font-weight:600'>" + chev(open) + esc(ref || '—') + '</td>' +
          "<td class='num' style='font-size:12.5px;color:var(--muted)'>" + esc(r.invoice_date || '—') + '</td>' +
          "<td class='num' style='font-size:12.5px;color:var(--muted)'>" + esc(r.due_date || '—') + '</td>' +
          "<td style='" + WRAP + "min-width:110px;max-width:220px'>" + esc(r.invoice_status || '—') + '</td>' +
          "<td><span style='font-weight:600;color:" + colColor(r.collection_status) + "'>" + esc(r.collection_status || '—') + '</span></td>' +
          "<td class='r num'>" + money(r.amount) + '</td>' +
          "<td class='r num'>" + money(r.amount_paid) + '</td>' +
          "<td class='r num' style='font-weight:600'>" + money(r.balance) + '</td>' +
          "<td style='font-size:12.5px'>" + esc(r.aging || '—') + '</td>' +
          "<td class='r num'" + (od > 0 ? " style='color:#c23a3a;font-weight:600'" : '') + '>' + (od > 0 ? od : '—') + '</td>' +
          "<td style='font-size:12.5px;color:var(--muted);max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' title='" + esc(r.memo || '') + "'>" + esc(r.memo || '—') + '</td></tr>';
        if (open) h += "<tr class='bl-nest'><td colspan='11'>" + linesHtml(ref) + '</td></tr>';
      });
      return h + '</tbody></table>';
    }
    function linesHtml(ref) {
      var st = linesCache[ref];
      if (!st || st.loading) return "<div class='bl-lines-msg'>Loading line items…</div>";
      if (st.error) return "<div class='bl-lines-msg' style='color:#c23a3a'><strong>Could not load line items.</strong> " + esc(st.error) + '</div>';
      if (!st.rows.length) return "<div class='bl-lines-msg'>No line items found for this invoice.</div>";
      var cols = lineColumns(st.rows);
      return "<table class='bl-sub bl-lines'><thead><tr>" + cols.map(function (c) { return '<th' + (c.num || c.money ? " class='r'" : '') + '>' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        st.rows.map(function (r) {
          return '<tr>' + cols.map(function (c) {
            var v = r[c.key];
            if (c.money) return "<td class='r num'>" + money(v) + '</td>';
            if (c.num) return "<td class='r num'>" + (v == null || v === '' ? '—' : esc(v)) + '</td>';
            return "<td style='" + WRAP + "min-width:120px;max-width:320px'>" + esc(v == null || v === '' ? '—' : v) + '</td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody></table>';
    }
    function loadLines(ref) {
      if (linesCache[ref] && !linesCache[ref].error) return;
      linesCache[ref] = { loading: true };
      fetch('/api/pbilling/' + encodeURIComponent(C.product) + '/lines?invoice=' + encodeURIComponent(ref), { credentials: 'same-origin' })
        .then(function (res) { if (!res.ok) return res.json().then(function (j) { throw new Error(j.message || ('HTTP ' + res.status)); }); return res.json(); })
        .then(function (d) { linesCache[ref] = { rows: d.rows || [] }; })
        .catch(function (err) { linesCache[ref] = { error: err.message }; })
        .then(function () { if (openInv[ref]) render(); });
    }
    function onToggle(e) {
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      var inv = e.target.closest('tr.bl-inv'), co = e.target.closest('tr.bl-co');
      if (!inv && !co) return;
      if (e.type === 'keydown') e.preventDefault();
      if (inv) { var ref = inv.getAttribute('data-inv'); openInv[ref] = !openInv[ref]; if (openInv[ref]) loadLines(ref); }
      else { var k = co.getAttribute('data-co'); openCo[k] = !openCo[k]; }
      render();
    }

    function render() {
      var q = ($('Search').value || '').toLowerCase();
      var rows = data.filter(function (r) {
        if (filters.client && (r.client || '') !== filters.client) return false;
        if (filters.status && (r.collection_status || '') !== filters.status) return false;
        if (filters.aging && (r.aging || '') !== filters.aging) return false;
        if (filters.memo === 'prod' && !isProductMemo(r)) return false;
        if (!q) return true;
        return [r.client, r.invoice_ref, r.invoice_status, r.collection_status, r.memo].some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
      });
      var tb = $('Body');
      tb.innerHTML = rows.length ? groupByCompany(rows).map(companyRowHtml).join('') :
        "<tr><td colspan='8'><div class='empty'><strong>No matching invoices.</strong></div></td></tr>";
      var tAmt = 0, tBal = 0; rows.forEach(function (r) { tAmt += num(r.amount) || 0; tBal += num(r.balance) || 0; });
      var coCount = {}; rows.forEach(function (r) { coCount[r.hsid || r.client] = 1; });
      $('Foot').textContent = Object.keys(coCount).length + ' clients · ' + rows.length + ' of ' + data.length +
        ' invoices · click a client to see invoices, then an invoice to see line items · total ' + money(tAmt) + ' · outstanding balance ' + money(tBal);
    }

    function load(force) {
      if (loaded && !force) return;
      var tb = $('Body');
      tb.innerHTML = "<tr><td colspan='8'><div class='empty'>Loading " + esc(C.label) + ' billing from RADAR…</div></td></tr>';
      fetch('/api/pbilling/' + encodeURIComponent(C.product) + (force ? '?refresh=1' : ''), { credentials: 'same-origin' })
        .then(function (res) { if (!res.ok) return res.json().then(function (j) { throw new Error(j.message || ('HTTP ' + res.status)); }); return res.json(); })
        .then(function (d) {
          loaded = true;
          if (!d.configured) {
            tb.innerHTML = "<tr><td colspan='8'><div class='empty'><strong>RADAR connection not configured.</strong>Set RADAR_DB_HOST, RADAR_DB_TOKEN and RADAR_WAREHOUSE_ID on the server to enable this report.</div></td></tr>";
            $('Foot').textContent = '';
            return;
          }
          data = d.rows || [];
          if (force) linesCache = {};
          $('Note').textContent = 'from RADAR · ' + data.length + ' invoices across ' + (d.clientCount || 0) + ' ' + C.label + ' clients (won deals with ' + C.label + ' line items)';
          buildFilters();
          render();
        })
        .catch(function (err) {
          tb.innerHTML = "<tr><td colspan='8'><div class='empty' style='color:#c23a3a'><strong>Could not load billing.</strong>" + esc(err.message) + '</div></td></tr>';
        });
    }

    $('Body').addEventListener('click', onToggle);
    $('Body').addEventListener('keydown', onToggle);
    $('Search').addEventListener('input', function () { if (loaded) render(); });
    $('Refresh').addEventListener('click', function () { load(true); });
    return { load: load };
  };
})();
