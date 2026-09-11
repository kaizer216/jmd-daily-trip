// Vercel serverless function: GET /api/trips
// Reads the TRIPS tab of the Google Sheet server-side with a Google service
// account (read-only), aggregates it with compute(), and returns JSON.
// The sheet's other tabs (including the credentials/reference tab) are never
// requested - the range below is scoped to TRIPS only.

const { google } = require('googleapis');
const { compute, computeOpx } = require('./_compute.js');

const SHEET_ID = '1QG6xB0Opkx0hgYjQ-oXzPL3AwJNydfoJc1ijgnTc7Aw';
const RANGE_TRIPS = 'TRIPS!A6:AB6000';
// MONTHLY OPX: office/yard/admin expenses - a separate ledger from per-trip cash-out.
// Same spreadsheet, still scoped to just this one tab (never the credentials tab).
const RANGE_OPX = "'MONTHLY OPX'!A5:G5000";

let cachedAuth = null;
function getAuth() {
  if (cachedAuth) return cachedAuth;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error(
      'Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY environment variables.'
    );
  }
  // Env vars can't hold literal newlines, so the key is stored with escaped
  // "\n" sequences - un-escape them back into real line breaks.
  const privateKey = rawKey.replace(/\\n/g, '\n');

  cachedAuth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  return cachedAuth;
}

module.exports = async (req, res) => {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const resp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SHEET_ID,
      ranges: [RANGE_TRIPS, RANGE_OPX],
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    });

    const [tripsResult, opxResult] = resp.data.valueRanges || [];
    const tripsRows = (tripsResult && tripsResult.values) || [];
    const opxRows = (opxResult && opxResult.values) || [];

    const payload = compute(tripsRows);
    try {
      payload.opx = computeOpx(opxRows);
    } catch (opxErr) {
      // Admin-expense chart is a nice-to-have - never let a hiccup there take down the whole dashboard.
      payload.opx = null;
    }

    // Fresh-ish but cached at the edge for a minute so a burst of visits
    // doesn't burst-call the Sheets API; stale-while-revalidate keeps it fast.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json(payload);
  } catch (err) {
    res.status(500).json({
      error: err.message || 'Failed to load trip data.'
    });
  }
};
