/**
 * Strike grid – release logging (for the Sea Intel Lab live map)
 * --------------------------------------------------------------
 * The live map's "Log release" button sends each log here (and its Delete button removes one); they are kept in a Google Sheet
 * ("Strike grid logs", created the first time). The lab's GitHub build reads them back with a
 * private key, scores each one against the grid that was published BEFORE it, and shows the hit rate.
 *
 * Boat codes: each boat has its own code, listed in the "Boats" tab of the logs sheet
 * (Boat | Code | Sharing | Changed). Add a row to give a boat a code. The crew types it once into the map.
 * Sharing is chosen by the boat in the app (and can be changed any time, e.g. off for a tournament):
 *   research – exact positions kept private, used only to improve the map (the default)
 *   bank     – other anglers see the species and nearest bank only
 *   all      – other anglers see the exact spot
 * STRIKELOG_CODE (Script Properties) still works: it becomes the first boat ("My boat").
 * STRIKELOG_READ_KEY – a long random key used only by the GitHub build to read the logs.
 *
 * Setup (once), in the MARINE Apps Script project (the one behind marine.islandsoutside.com):
 *  1. Add this file (StrikeLog.gs).
 *  2. In Code.gs doGet, right after the 'marinealert' line, add:
 *        if (mw8Action === 'strikelog' || mw8Action === 'strikelogs') return strikeLogRoute_(e);
 *  3. Project Settings → Script Properties: add STRIKELOG_READ_KEY (run makeStrikeLogReadKey() to print a
 *     random one). Boat codes go in the Boats tab of the sheet (STRIKELOG_CODE, if set, becomes "My boat").
 *  4. Run testStrikeLog() and allow the Google Sheets permission. The log shows the sheet's link.
 *  5. Deploy → Manage deployments → edit the web app → Version: New version → Deploy.
 */

const STRIKELOG = {
  SHEET_NAME: 'Strike grid logs',
  HEADER: ['Received (UTC)', 'Logged at (phone)', 'Lat', 'Lon', 'Species', 'Count', 'Note', 'Exact GPS', 'Id', 'Boat'],
  BOATS_HEADER: ['Boat', 'Code', 'Sharing', 'Changed'],
  SHARES: ['research', 'bank', 'all'],
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
  // action=strikelog: add one log (or op=share / del=1), always with a boat code
  const boat = strikeLogBoat_(props, String(q.code || ''));
  if (!boat) return json({ok: false, error: 'wrong boat code'});
  if (q.op === 'share') return json(strikeLogShare_(props, boat, q.level));
  if (q.del === '1') return json(strikeLogDelete_(props, q, boat));          // the Delete button on a log dot
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
                  species, count, note, q.exact === '1' ? 'yes' : 'no', id, boat.name]);
  } finally {
    lock.releaseLock();
  }
  return json({ok: true, boat: boat.name, share: boat.share});
}

/** The Boats tab: one row per boat code. Created the first time, with STRIKELOG_CODE as "My boat". */
function strikeLogBoatsSheet_(props) {
  const ss = strikeLogSheet_(props).getParent();
  let sh = ss.getSheetByName('Boats');
  if (!sh) {
    sh = ss.insertSheet('Boats');
    sh.getRange(1, 1, 1, 4).setValues([STRIKELOG.BOATS_HEADER]).setFontWeight('bold'); sh.setFrozenRows(1);
    const old = props.getProperty('STRIKELOG_CODE');
    if (old) sh.appendRow(['My boat', old, '', '']);
  }
  return sh;
}

function strikeLogBoats_(props) {
  const sh = strikeLogBoatsSheet_(props), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 4).getValues().map((r, k) => ({row: k + 2, name: String(r[0]).trim(), code: String(r[1]).trim(),
    share: STRIKELOG.SHARES.indexOf(String(r[2]).trim()) >= 0 ? String(r[2]).trim() : ''})).filter(b => b.name && b.code);
}

function strikeLogBoat_(props, code) {
  code = code.trim();
  if (!code) return null;
  return strikeLogBoats_(props).find(b => b.code === code) || null;
}

/** Read (no level) or set the boat's sharing choice. Applies to every phone and every log of that boat. */
function strikeLogShare_(props, boat, level) {
  if (level === undefined || level === '') return {ok: true, boat: boat.name, share: boat.share};
  level = String(level);
  if (STRIKELOG.SHARES.indexOf(level) < 0) return {ok: false, error: 'bad sharing level'};
  strikeLogBoatsSheet_(props).getRange(boat.row, 3, 1, 2).setValues([[level, new Date().toISOString()]]);
  return {ok: true, boat: boat.name, share: level};
}

/** Removes one log by its id (only phones with the logging code can do this). */
function strikeLogDelete_(props, q, boat) {
  const id = String(q.id || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  if (!id) return {ok: false, error: 'missing id'};
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return {ok: false, error: 'busy, try again'};
  try {
    const sh = strikeLogSheet_(props), last = sh.getLastRow();
    if (last < 2) return {ok: true, notFound: true};
    const rows = sh.getRange(2, 9, last - 1, 2).getValues();
    for (let k = rows.length - 1; k >= 0; k--) {
      if (String(rows[k][0]) !== id) continue;
      if (rows[k][1] && String(rows[k][1]) !== boat.name) return {ok: false, error: 'not your log'};   // only the boat that logged it
      sh.deleteRow(k + 2); return {ok: true, deleted: true};
    }
    return {ok: true, notFound: true};
  } finally {
    lock.releaseLock();
  }
}

function strikeLogRows_(props) {
  const sh = strikeLogSheet_(props);
  if (sh.getLastRow() < 2) return [];
  const share = {}; strikeLogBoats_(props).forEach(b => share[b.name] = b.share || 'research');
  return sh.getRange(2, 1, sh.getLastRow() - 1, STRIKELOG.HEADER.length).getValues().map(r => ({
    received: r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
    date: r[1] instanceof Date ? r[1].toISOString() : String(r[1]),
    lat: Number(r[2]), lon: Number(r[3]), species: String(r[4]), count: Number(r[5]),
    note: String(r[6] || ''), exact: r[7] === 'yes', id: String(r[8] || ''),
    boat: String(r[9] || ''), share: share[String(r[9] || '')] || 'research'}));     // unknown or unset → private
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
  const logs = ss.getSheetByName('Logs') || ss.getSheets()[0];
  if (!logs.getRange(1, 10).getValue()) logs.getRange(1, 10).setValue('Boat').setFontWeight('bold');   // older sheets
  return logs;
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
  console.log('STRIKELOG_READ_KEY set: ' + !!props.getProperty('STRIKELOG_READ_KEY'));
  const boats = strikeLogBoats_(props);
  console.log('Boats: ' + (boats.length ? boats.map(b => b.name + ' (' + (b.share || 'not chosen yet') + ')').join(', ') : 'none yet – add rows to the Boats tab'));
  console.log('Logs so far: ' + Math.max(0, sh.getLastRow() - 1));
}
