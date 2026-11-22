/**
 * Strike grid – release logging (for the Sea Intel Lab live map)
 * --------------------------------------------------------------
 * The live map's "Log release" button sends each log here; they are kept in a Google Sheet
 * ("Strike grid logs", created the first time). The lab's GitHub build reads them back with a
 * private key, scores each one against the grid that was published BEFORE it, and shows the hit rate.
 *
 * Two codes, both kept only in Script Properties:
 *   STRIKELOG_CODE      – the logging code you type once into the live map (share it with your crew only)
 *   STRIKELOG_READ_KEY  – a long random key used only by the GitHub build to read the logs
 *
 * Setup (once), in the Wx-Exercise5day project:
 *  1. Add this file (StrikeLog.gs).
 *  2. In Code.gs doGet, next to the tally line (before setupExwxOps()), add:
 *        if (action === 'strikelog' || action === 'strikelogs') return strikeLogRoute_(e);
 *  3. Project Settings → Script Properties: add STRIKELOG_CODE (e.g. a 6+ character word) and
 *     STRIKELOG_READ_KEY (run makeStrikeLogReadKey() to print a random one).
 *  4. Run testStrikeLog() and allow the Google Sheets permission. The log shows the sheet's link.
 *  5. Deploy → Manage deployments → edit the web app → Version: New version → Deploy.
 */

const STRIKELOG = {
  SHEET_NAME: 'Strike grid logs',
  HEADER: ['Received (UTC)', 'Logged at (phone)', 'Lat', 'Lon', 'Species', 'Count', 'Note', 'Exact GPS', 'Id'],
  SPECIES: ['Blue marlin', 'White marlin', 'Sailfish', 'Wahoo', 'Dolphin (mahi)', 'Tuna', 'No strikes here', 'Other',
            'Birds working', 'Bait (surface)', 'Bait (sounder)', 'Fish busting', 'Weedline', 'Debris / log'],   // last six: sightings
  MAX_PER_DAY: 300,
  BOX: {south: 15.5, north: 20.5, west: -80, east: -73.5},
};

function strikeLogRoute_(e) {
  const q = (e && e.parameter) || {};
  const json = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  const props = PropertiesService.getScriptProperties();
  if (q.action === 'strikelogs') {
    const key = props.getProperty('STRIKELOG_READ_KEY') || '';
    if (!key || q.key !== key) return json({ok: false, error: 'not allowed'});
    return json({ok: true, logs: strikeLogRows_(props)});
  }
  // action=strikelog: add one log
  const code = props.getProperty('STRIKELOG_CODE') || '';
  if (!code || String(q.code || '') !== code) return json({ok: false, error: 'wrong logging code'});
  const lat = Number(q.lat), lon = Number(q.lon), count = Math.round(Number(q.count));
  const B = STRIKELOG.BOX;
  if (!(lat > B.south && lat < B.north && lon > B.west && lon < B.east)) return json({ok: false, error: 'position outside the area'});
  if (!(count >= 0 && count <= 50)) return json({ok: false, error: 'bad count'});
  const species = STRIKELOG.SPECIES.indexOf(String(q.species)) >= 0 ? String(q.species) : 'Other';
  const note = String(q.note || '').replace(/[\u0000-\u001f<>]/g, ' ').slice(0, 120);
  const id = String(q.id || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  let when = new Date(String(q.time || ''));
  if (isNaN(when.getTime()) || Math.abs(when.getTime() - Date.now()) > 7 * 86400000) when = new Date();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return json({ok: false, error: 'busy, try again'});
  try {
    const sh = strikeLogSheet_(props);
    const last = sh.getLastRow();
    if (id && last > 1) {                                  // already received (a retry after weak signal)
      const ids = sh.getRange(2, 9, last - 1, 1).getValues().map(r => String(r[0]));
      if (ids.indexOf(id) >= 0) return json({ok: true, duplicate: true});
    }
    const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
    const n = Number(props.getProperty('STRIKELOG_N_' + today) || 0);
    if (n >= STRIKELOG.MAX_PER_DAY) return json({ok: false, error: 'daily limit reached'});
    props.setProperty('STRIKELOG_N_' + today, String(n + 1));
    sh.appendRow([new Date().toISOString(), when.toISOString(), Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5,
                  species, count, note, q.exact === '1' ? 'yes' : 'no', id]);
  } finally {
    lock.releaseLock();
  }
  return json({ok: true});
}

function strikeLogRows_(props) {
  const sh = strikeLogSheet_(props);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, STRIKELOG.HEADER.length).getValues().map(r => ({
    received: r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
    date: r[1] instanceof Date ? r[1].toISOString() : String(r[1]),
    lat: Number(r[2]), lon: Number(r[3]), species: String(r[4]), count: Number(r[5]),
    note: String(r[6] || ''), exact: r[7] === 'yes', id: String(r[8] || '')}));
}

function strikeLogSheet_(props) {
  let id = props.getProperty('STRIKELOG_SHEET_ID'), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(STRIKELOG.SHEET_NAME);
    props.setProperty('STRIKELOG_SHEET_ID', ss.getId());
    const sh = ss.getSheets()[0];
    sh.setName('Logs');
    sh.getRange(1, 1, 1, STRIKELOG.HEADER.length).setValues([STRIKELOG.HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return ss.getSheetByName('Logs') || ss.getSheets()[0];
}

/** Run once: prints a random read key to paste into Script Properties (STRIKELOG_READ_KEY) and the GitHub secret. */
function makeStrikeLogReadKey() {
  console.log(Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8));
}

/** Run once: creates the sheet and checks the codes are set. */
function testStrikeLog() {
  const props = PropertiesService.getScriptProperties();
  const sh = strikeLogSheet_(props);
  console.log('Sheet: ' + sh.getParent().getUrl());
  console.log('STRIKELOG_CODE set: ' + !!props.getProperty('STRIKELOG_CODE') + ' · STRIKELOG_READ_KEY set: ' + !!props.getProperty('STRIKELOG_READ_KEY'));
  console.log('Logs so far: ' + Math.max(0, sh.getLastRow() - 1));
}
