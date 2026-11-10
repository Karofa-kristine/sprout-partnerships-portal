'use strict';

/**
 * Read-only access to RADAR (Sprout RevOps on Databricks) via the RADAR proxy.
 *
 * Credentials live in server env vars — never sent to the browser:
 *   RADAR_DB_HOST        Databricks workspace host (https://…)
 *   RADAR_DB_TOKEN       Personal access token
 *   RADAR_WAREHOUSE_ID   SQL warehouse id
 *   RADAR_PROXY_URL      (optional) defaults to the shared proxy
 *
 * The proxy avoids CORS and brokers the Databricks Statement Execution API:
 * submit a statement (returns a statement_id), then poll until SUCCEEDED.
 */

const PROXY = process.env.RADAR_PROXY_URL || 'https://radar-revops.vercel.app';
const BILLING = 'shared.revops.gold_billing_360';

function isConfigured() {
  return !!(process.env.RADAR_DB_HOST && process.env.RADAR_DB_TOKEN && process.env.RADAR_WAREHOUSE_ID);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sqlStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";

async function runStatement(sql) {
  const host = process.env.RADAR_DB_HOST;
  const token = process.env.RADAR_DB_TOKEN;
  const wh = process.env.RADAR_WAREHOUSE_ID;

  const submit = await fetch(PROXY + '/api/databricks', {
    method: 'POST',
    headers: { 'x-db-host': host, 'x-db-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      warehouse_id: wh,
      statement: sql,
      wait_timeout: '0s',
      on_wait_timeout: 'CONTINUE',
      format: 'JSON_ARRAY',
    }),
  });
  if (!submit.ok) {
    throw new Error('RADAR submit failed — HTTP ' + submit.status + ': ' + (await submit.text()).slice(0, 200));
  }

  let data = await submit.json();
  let id = data.statement_id;
  let state = data.status && data.status.state;

  let guard = 0;
  while (state === 'PENDING' || state === 'RUNNING' || !state) {
    if (++guard > 150) throw new Error('RADAR query timed out.');
    await sleep(1000);
    const poll = await fetch(PROXY + '/api/databricks-poll?id=' + encodeURIComponent(id));
    if (!poll.ok) throw new Error('RADAR poll failed — HTTP ' + poll.status);
    data = await poll.json();
    state = data.status && data.status.state;
  }
  if (state !== 'SUCCEEDED') {
    const m = (data.status && data.status.error && data.status.error.message) || state;
    throw new Error('RADAR query ' + state + ': ' + m);
  }

  const cols = ((data.manifest && data.manifest.schema && data.manifest.schema.columns) || []).map((c) => c.name);
  const arr = (data.result && data.result.data_array) || [];
  // JSON_ARRAY returns every value as a string; callers get {colName: value}.
  return arr.map((r) => {
    const o = {};
    cols.forEach((c, i) => (o[c] = r[i]));
    return o;
  });
}

/**
 * Invoice-level billing / AR for a set of HubSpot Company IDs, from the
 * gold_billing_360 view (all invoices for those clients, any product).
 * Returns [{ client, hsid, invoice_ref, invoice_date, due_date, invoice_status,
 *   collection_status, amount, amount_paid, balance, aging, days_overdue,
 *   currency, memo }]. (Numbers come back as strings from JSON_ARRAY.)
 * `memo` is the NetSuite invoice memo; the UI uses it for the
 * "Peoplebox memo only" filter (memo contains "peoplebox").
 */
async function billing(hubspotIds) {
  const ids = [...new Set((hubspotIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const inList = ids.map(sqlStr).join(',');
  const sql = `
    SELECT
      customer_name            client,
      hubspot_company_id       hsid,
      invoice_number           invoice_ref,
      CAST(invoice_date AS STRING) invoice_date,
      CAST(due_date AS STRING)     due_date,
      invoice_status           invoice_status,
      collection_status        collection_status,
      invoice_amount           amount,
      netsuite_amount_paid     amount_paid,
      remaining_balance        balance,
      aging_bucket             aging,
      days_overdue             days_overdue,
      currency                 currency,
      invoice_memo             memo
    FROM ${BILLING}
    WHERE hubspot_company_id IN (${inList})
      AND COALESCE(LOWER(collection_status),'') NOT LIKE '%cancel%'
      AND COALESCE(LOWER(invoice_status),'')    NOT LIKE '%cancel%'
    ORDER BY invoice_date DESC, client
    LIMIT 5000`;
  return runStatement(sql);
}

// ── Invoice line items (NetSuite silver tables) ──────────────────────────
// silver_ns_invoice           one row per invoice (header)
// silver_ns_transaction_line  one row per transaction line (all txn types)
//
// Column names in the silver layer weren't documented when this was built, so
// the join columns are discovered once per server instance via DESCRIBE and
// matched against common NetSuite / RevOps naming. If nothing matches, the
// error lists the columns that WERE found so the candidate lists below can be
// extended in one edit.
const NS_INVOICE = 'shared.revops.silver_ns_invoice';
const NS_LINE = 'shared.revops.silver_ns_transaction_line';

const CAND = {
  // invoice header: the human invoice number (matches gold_billing_360.invoice_number)
  invNumber: ['invoice_number', 'tranid', 'tran_id', 'document_number', 'doc_number', 'transaction_number', 'invoice_no'],
  // invoice header: NetSuite internal id
  invId: ['invoice_id', 'id', 'internal_id', 'internalid', 'transaction_id', 'ns_internal_id', 'netsuite_id', 'invoice_internal_id'],
  // line table: FK to the transaction header
  lineTxn: ['transaction', 'transaction_id', 'invoice_id', 'transaction_internal_id', 'internal_id_transaction', 'txn_id', 'tran_internal_id'],
  // line table: invoice number carried directly on the line (lets us skip the join)
  lineNumber: ['invoice_number', 'tranid', 'tran_id', 'document_number', 'transaction_number'],
  // line table: header/summary-line flag to exclude (NetSuite "mainline")
  mainline: ['mainline', 'is_mainline', 'main_line'],
  // line table: tax-line flag to exclude
  taxline: ['taxline', 'is_tax_line', 'tax_line'],
  // line table: ordering
  lineSeq: ['linesequencenumber', 'line_sequence_number', 'line_number', 'linenumber', 'line_id', 'id'],
};

let nsSchema = null; // cached { invNumber, invId, lineTxn, lineNumber, mainline, taxline, lineSeq }

async function columnsOf(table) {
  const rows = await runStatement('DESCRIBE TABLE ' + table);
  // DESCRIBE returns col_name rows, then a blank row / "# Partition Information" etc.
  const out = [];
  for (const r of rows) {
    const n = String(r.col_name || '').trim();
    if (!n || n.startsWith('#')) break;
    out.push(n);
  }
  return out;
}

function pick(cols, cands) {
  const lower = cols.map((c) => c.toLowerCase());
  for (const c of cands) {
    const i = lower.indexOf(c);
    if (i >= 0) return cols[i];
  }
  return null;
}

async function resolveNsSchema() {
  if (nsSchema) return nsSchema;
  const [invCols, lineCols] = await Promise.all([columnsOf(NS_INVOICE), columnsOf(NS_LINE)]);
  const s = {
    invNumber: pick(invCols, CAND.invNumber),
    invId: pick(invCols, CAND.invId),
    lineTxn: pick(lineCols, CAND.lineTxn),
    lineNumber: pick(lineCols, CAND.lineNumber),
    mainline: pick(lineCols, CAND.mainline),
    taxline: pick(lineCols, CAND.taxline),
    lineSeq: pick(lineCols, CAND.lineSeq),
  };
  const canJoin = s.invNumber && s.invId && s.lineTxn;
  if (!canJoin && !s.lineNumber) {
    throw new Error(
      'Could not work out how invoice lines link to invoices. ' +
        NS_INVOICE + ' columns: ' + invCols.join(', ') + ' | ' +
        NS_LINE + ' columns: ' + lineCols.join(', ')
    );
  }
  nsSchema = s;
  return s;
}

const q = (c) => '`' + String(c).replace(/`/g, '') + '`';
// Flags may be 'T'/'F' strings or booleans — compare as text.
const notTrue = (col) => `COALESCE(LOWER(CAST(l.${q(col)} AS STRING)),'f') NOT IN ('t','true','1','y','yes')`;

/**
 * All line items for one invoice number (as shown in gold_billing_360).
 * Returns raw silver_ns_transaction_line rows ({col: value}); the UI picks
 * the familiar columns (item, description, qty, rate, amount) when present.
 */
async function invoiceLines(invoiceNumber) {
  const s = await resolveNsSchema();
  const where = [];
  let from;
  if (s.invNumber && s.invId && s.lineTxn) {
    from = `${NS_LINE} l JOIN ${NS_INVOICE} i ON l.${q(s.lineTxn)} = i.${q(s.invId)}`;
    where.push(`i.${q(s.invNumber)} = ${sqlStr(invoiceNumber)}`);
  } else {
    from = `${NS_LINE} l`;
    where.push(`l.${q(s.lineNumber)} = ${sqlStr(invoiceNumber)}`);
  }
  if (s.mainline) where.push(notTrue(s.mainline));
  if (s.taxline) where.push(notTrue(s.taxline));
  const sql = `SELECT l.* FROM ${from} WHERE ${where.join(' AND ')}` +
    (s.lineSeq ? ` ORDER BY l.${q(s.lineSeq)}` : '') + ' LIMIT 500';
  return runStatement(sql);
}

// ── ChannelHub: Unified Channel Pipeline (HubSpot via RADAR silver tables) ──
// Schema per the RADAR table spec:
//   shared.revops.silver_deals       1 row per deal (deal_id PK, company_id FK)
//   shared.revops.silver_company     1 row per company (Company_id PK)
//   shared.revops.silver_line_items  1 row per line item (deal_id FK)
// Only leads (deals) in pipeline_name = 'Unified Channel Pipeline' that were
// CREATED in 2025–2026 (create_date, PH time). The UI's year toggle
// (2025–2026 / 2025 / 2026) narrows further client-side.
const CH_PIPELINE = 'Unified Channel Pipeline';
const CH_FROM = '2025-01-01';
const CH_TO = '2027-01-01'; // exclusive

async function channelDeals() {
  const sql = `
    SELECT
      CAST(d.deal_id AS STRING)                 deal_id,
      d.deal_name                               deal_name,
      d.partner_on_record                       partner,
      d.stage_label                             stage,
      d.client_journey_stage                    journey,
      d.deal_type                               deal_type,
      CAST(d.create_date AS STRING)             create_date,
      CAST(d.close_date AS STRING)              close_date,
      CAST(d.projected_close_date AS STRING)    projected_close_date,
      CAST(d.amount AS DOUBLE)                  amount,
      d.mrr                                     mrr,
      d.revshare_mrr                            revshare_mrr,
      d.revshare_otp                            revshare_otp,
      CAST(d.revenue_share AS DOUBLE)           revenue_share,
      d.sales_rep                               sales_rep,
      d.forecast_category                       forecast_category,
      d.deal_tags                               deal_tags,
      d.segment                                 segment,
      d.qualified_lead                          qualified_lead,
      d.reasons_for_lost_deal                   lost_reason,
      CAST(d.company_id AS STRING)              company_id,
      c.Company_name                            company
    FROM shared.revops.silver_deals d
    LEFT JOIN shared.revops.silver_company c ON c.Company_id = d.company_id
    WHERE d.pipeline_name = ${sqlStr(CH_PIPELINE)}
      AND d.create_date >= TIMESTAMP ${sqlStr(CH_FROM)}
      AND d.create_date <  TIMESTAMP ${sqlStr(CH_TO)}
    ORDER BY d.create_date DESC
    LIMIT 20000`;
  return runStatement(sql);
}

/** Line items for one Unified Channel Pipeline deal (silver_line_items). */
async function channelDealLines(dealId) {
  if (!/^d+$/.test(String(dealId))) throw new Error('Invalid deal id');
  const sql = `
    SELECT
      li.product_name, li.parent_product, li.clan, li.product_status,
      li.recurring_billing_frequency, li.quantity, li.unit_price, li.amount,
      li.discount, li.mrr, li.revenue_share, li.contract_term_months
    FROM shared.revops.silver_line_items li
    JOIN shared.revops.silver_deals d ON d.deal_id = li.deal_id
    WHERE li.deal_id = ${dealId}
      AND d.pipeline_name = ${sqlStr(CH_PIPELINE)}
    ORDER BY li.amount DESC
    LIMIT 500`;
  return runStatement(sql);
}

module.exports = { isConfigured, billing, invoiceLines, channelDeals, channelDealLines };
