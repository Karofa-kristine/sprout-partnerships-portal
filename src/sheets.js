'use strict';

const fs = require('fs');
const { google } = require('googleapis');

/**
 * Read-only Google Sheets client backed by a service account.
 * The service account must have Viewer access to the spreadsheet.
 */

let sheetsClient = null;

function loadCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + err.message);
    }
  }
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!file) {
    throw new Error(
      'No service-account credentials. Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_SERVICE_ACCOUNT_JSON.'
    );
  }
  if (!fs.existsSync(file)) {
    throw new Error('Service-account key file not found at: ' + file);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function getClient() {
  if (sheetsClient) return sheetsClient;
  const credentials = loadCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

/**
 * Fetch the full value grid of a single tab. Returns a 2D array of cells
 * (strings). Empty cells come back as '' so column positions stay aligned.
 *
 * @param {string} spreadsheetId
 * @param {string} tabName  exact tab label, e.g. "Peoplebox"
 * @returns {Promise<string[][]>}
 */
async function readTab(spreadsheetId, tabName) {
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const rows = res.data.values || [];
  // Normalize: ensure every row is an array and cells are strings.
  return rows.map((row) => (row || []).map((c) => (c == null ? '' : String(c).trim())));
}

module.exports = { readTab };
