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

module.exports = { isConfigured, billing };
