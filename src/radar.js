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
const SUMMARY = 'shared.revops.netsuite_invoices_summary';
const LINES = 'shared.revops.netsuite_invoice_lineitems';

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
 * All NetSuite invoice line items for a set of HubSpot Company IDs.
 * Returns [{ client, hsid, item_display, invoice_ref, invoice_status, recurring_sub }].
 * (recurring_sub = line_description, i.e. the Peoplebox remarks.)
 */
async function subscriptions(hubspotIds) {
  const ids = [...new Set((hubspotIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const inList = ids.map(sqlStr).join(',');
  const sql = `
    SELECT
      COALESCE(NULLIF(s.hubspot_company_name,''), s.customer_name) client,
      s.hubspot_company_id hsid,
      l.item_display_name item_display,
      s.invoice_number invoice_ref,
      s.invoice_status invoice_status,
      l.line_description recurring_sub
    FROM ${LINES} l
    JOIN ${SUMMARY} s ON l.invoice_id = s.invoice_id
    WHERE s.hubspot_company_id IN (${inList})
    ORDER BY client, s.invoice_number
    LIMIT 5000`;
  return runStatement(sql);
}

module.exports = { isConfigured, subscriptions };
