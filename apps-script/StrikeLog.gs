/**
 * Strike grid – release logging (for the Sea Intel Lab live map)
 * --------------------------------------------------------------
 * The live map's "Log release" button sends each log here (and its Delete button removes one); they are kept in a Google Sheet
 * ("Strike grid logs", created the first time). The lab's GitHub build reads them back with a
 * private key, scores each one against the grid that was published BEFORE it, and shows the hit rate.
 *
 * Boat codes: each boat captain creates their boat's code in the app (More → Boat code → Create) and shares
 * it with the crew. Codes are kept in the "Boats" tab of the logs sheet (Boat | Code | Sharing | Changed | Created by).
 * Boat names must be unique: a second request for the same name is told who created it, to ask them for the code.
 * Boat type (private / sports charter / commercial) is chosen at creation; only the captain can change it.
 * Each boat also has a CAPTAIN CODE (Boats tab, last column), shown once to the creator. Only a phone with it can
 * change the boat's sharing or delete other crew members' logs. Run fillCaptainCodes() to give older boats one.
 * Sharing is chosen by the boat in the app (and can be changed any time, e.g. off for a tournament):
 *   research – the default: nobody else sees the logs (each phone sees only its own); used privately to improve the map
 *   crew     – everyone on the boat code sees the boat's logs at the exact spot
 *   bank     – Tournament Mode: other anglers see the species, boat and nearest bank only
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
  HEADER: ['Received (UTC)', 'Logged at (phone)', 'Lat', 'Lon', 'Species', 'Count', 'Note', 'Exact GPS', 'Id', 'Boat', 'Phone', 'Approx weight (lb)'],
  BOATS_HEADER: ['Boat', 'Code', 'Sharing', 'Changed', 'Created by', 'Captain code', 'Boat type'],
  TYPES: ['private', 'charter', 'commercial'],            // as the NFA licences them: recreational / sports charter / artisanal
  SHARES: ['research', 'crew', 'bank', 'all'],
  ABC: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',                      // no 0/O or 1/I to mix up
  SPECIES: ['Blue marlin', 'White marlin', 'Sailfish', 'Wahoo', 'Dolphin (mahi)', 'Tuna', 'No strikes here', 'Other',
            'Birds working', 'Bait (surface)', 'Bait (sounder)', 'Fish busting', 'Weedline', 'Debris / log'],   // last six: sightings
  MAX_PER_DAY: 300,
  MAX_NEW_BOATS_PER_DAY: 30,
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
  if (q.op === 'create') return json(strikeLogCreateBoat_(props, q.name, q.by, q.type));   // a captain creates their boat's code
  // action=strikelog: add one log (or op=share / del=1), always with a boat code
  const boat = strikeLogBoat_(props, String(q.code || ''));
  if (!boat) return json({ok: false, error: 'wrong boat code'});
  const isCaptain = !!boat.cap && String(q.cap || '').trim().toUpperCase() === boat.cap.toUpperCase();
  if (q.op === 'share') return json(strikeLogShare_(props, boat, q.level, isCaptain));
  if (q.op === 'captain') return json({ok: isCaptain, boat: boat.name, captain: isCaptain, share: boat.share || 'research', boatType: boat.type, error: isCaptain ? undefined : 'wrong captain code'});
  if (q.op === 'boattype') return json(strikeLogBoatType_(props, boat, q.type, isCaptain));
  if (q.op === 'team') return json({ok: true, boat: boat.name, share: boat.share || 'research', captain: isCaptain, boatType: boat.type,
                                    logs: (boat.share || 'research') === 'research' ? [] : strikeLogTeam_(props, boat)});
  if (q.del === '1') return json(strikeLogDelete_(props, q, boat, isCaptain));          // the Delete button on a log dot
  const lat = Number(q.lat), lon = Number(q.lon), count = Math.round(Number(q.count));
  const B = STRIKELOG.BOX;
  if (!(lat > B.south && lat < B.north && lon > B.west && lon < B.east)) return json({ok: false, error: 'position outside the area'});
  if (!(count >= 0 && count <= 50)) return json({ok: false, error: 'bad count'});
  let wt = '';
  if (q.wt !== undefined && String(q.wt) !== '') { wt = Math.round(Number(q.wt) * 10) / 10; if (!(wt > 0 && wt <= 20000)) return json({ok: false, error: 'weight must be 0–20,000 lb'}); }
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
                  species, count, note, q.exact === '1' ? 'yes' : 'no', id, boat.name, String(q.dev || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40), wt]);
  } finally {
    lock.releaseLock();
  }
  return json({ok: true, boat: boat.name, share: boat.share || 'research'});
}

/** The Boats tab: one row per boat code. Created the first time, with STRIKELOG_CODE as "My boat". */
function strikeLogBoatsSheet_(props) {
  const ss = strikeLogSheet_(props).getParent();
  let sh = ss.getSheetByName('Boats');
  if (!sh) {
    sh = ss.insertSheet('Boats');
    sh.getRange(1, 1, 1, 7).setValues([STRIKELOG.BOATS_HEADER]).setFontWeight('bold'); sh.setFrozenRows(1);
    const old = props.getProperty('STRIKELOG_CODE');
    if (old) sh.appendRow(['My boat', old, 'research', '', '', strikeLogNewCode_(10)]);
  }
  if (!sh.getRange(1, 5).getValue()) sh.getRange(1, 5).setValue('Created by').setFontWeight('bold');   // older tabs
  if (!sh.getRange(1, 6).getValue()) sh.getRange(1, 6).setValue('Captain code').setFontWeight('bold');
  if (!sh.getRange(1, 7).getValue()) sh.getRange(1, 7).setValue('Boat type').setFontWeight('bold');
  return sh;
}

function strikeLogBoats_(props) {
  const sh = strikeLogBoatsSheet_(props), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 7).getValues().map((r, k) => ({row: k + 2, name: String(r[0]).trim(), code: String(r[1]).trim(),
    share: STRIKELOG.SHARES.indexOf(String(r[2]).trim()) >= 0 ? String(r[2]).trim() : '', by: String(r[4] || '').trim(),
    cap: String(r[5] || '').trim(), type: STRIKELOG.TYPES.indexOf(String(r[6]).trim()) >= 0 ? String(r[6]).trim() : ''})).filter(b => b.name && b.code);
}

function strikeLogNewCode_(len) {
  let c = ''; for (let i = 0; i < len; i++) c += STRIKELOG.ABC[Math.floor(Math.random() * STRIKELOG.ABC.length)];
  return len === 8 ? c.slice(0, 4) + '-' + c.slice(4) : 'CAP-' + c;
}

function strikeLogBoat_(props, code) {
  code = code.trim();
  if (!code) return null;
  return strikeLogBoats_(props).find(b => b.code.toUpperCase() === code.toUpperCase()) || null;
}

/** A captain creates a code for their boat. Names are unique: a duplicate is told who to ask for the code. */
function strikeLogCreateBoat_(props, name, by, type) {
  const clean = v => String(v || '').replace(/[\u0000-\u001f<>"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  name = clean(name); by = clean(by);
  if (name.length < 2) return {ok: false, error: 'enter the boat name'};
  if (by.length < 2) return {ok: false, error: 'enter your name'};
  type = String(type || '');
  if (STRIKELOG.TYPES.indexOf(type) < 0) return {ok: false, error: 'choose the boat type'};
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return {ok: false, error: 'busy, try again'};
  try {
    const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
    const n = Number(props.getProperty('STRIKELOG_NEWBOATS_' + today) || 0);
    if (n >= STRIKELOG.MAX_NEW_BOATS_PER_DAY) return {ok: false, error: 'too many new boats today, try tomorrow'};
    const boats = strikeLogBoats_(props), codes = boats.map(b => b.code);
    const key = v => v.toLowerCase().replace(/[^a-z0-9]/g, '');               // 'Reel Deal' = 'reel-deal' = 'REELDEAL'
    const dup = boats.find(b => key(b.name) === key(name));
    if (dup) return {ok: false, duplicate: true, boat: dup.name, by: dup.by,
                     error: dup.by ? `${dup.name} already has a code – check with ${dup.by} for it` : `${dup.name} already has a code – check with the boat's captain for it`};
    const unique = name;
    let code = '';
    do { code = strikeLogNewCode_(8); } while (codes.indexOf(code) >= 0);
    const cap = strikeLogNewCode_(10);
    strikeLogBoatsSheet_(props).appendRow([unique, code, 'research', new Date().toISOString(), by, cap, type]);   // default: private sharing
    props.setProperty('STRIKELOG_NEWBOATS_' + today, String(n + 1));
    return {ok: true, boat: unique, code: code, cap: cap, share: 'research', captain: true, boatType: type};
  } finally {
    lock.releaseLock();
  }
}

/** Read (no level) or set the boat's sharing choice (captain code needed). Applies to every phone and log of that boat. */
/** Read or (captain only) set the boat type: private / charter / commercial. */
function strikeLogBoatType_(props, boat, type, isCaptain) {
  if (!type) return {ok: true, boat: boat.name, boatType: boat.type};
  if (!isCaptain) return {ok: false, error: 'only the captain can change the boat type', boatType: boat.type};
  if (STRIKELOG.TYPES.indexOf(String(type)) < 0) return {ok: false, error: 'bad boat type'};
  strikeLogBoatsSheet_(props).getRange(boat.row, 7).setValue(String(type));
  return {ok: true, boat: boat.name, boatType: String(type), captain: true};
}

function strikeLogShare_(props, boat, level, isCaptain) {
  if (level === undefined || level === '') return {ok: true, boat: boat.name, share: boat.share || 'research', captain: isCaptain, boatType: boat.type};
  if (!isCaptain) return {ok: false, error: 'only the captain can change sharing', share: boat.share || 'research'};
  level = String(level);
  if (STRIKELOG.SHARES.indexOf(level) < 0) return {ok: false, error: 'bad sharing level'};
  strikeLogBoatsSheet_(props).getRange(boat.row, 3, 1, 2).setValues([[level, new Date().toISOString()]]);
  return {ok: true, boat: boat.name, share: level, captain: true};
}

/** Removes one log: the phone that logged it, or the captain for any of the boat's logs. */
function strikeLogDelete_(props, q, boat, isCaptain) {
  const id = String(q.id || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  if (!id) return {ok: false, error: 'missing id'};
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return {ok: false, error: 'busy, try again'};
  try {
    const sh = strikeLogSheet_(props), last = sh.getLastRow();
    if (last < 2) return {ok: true, notFound: true};
    const rows = sh.getRange(2, 9, last - 1, 3).getValues(), dev = String(q.dev || '');
    for (let k = rows.length - 1; k >= 0; k--) {
      if (String(rows[k][0]) !== id) continue;
      if (rows[k][1] && String(rows[k][1]) !== boat.name) return {ok: false, error: 'not your log'};   // only the boat that logged it
      if (!isCaptain && (!dev || String(rows[k][2]) !== dev)) return {ok: false, error: 'only the captain can delete crew logs'};
      sh.deleteRow(k + 2); return {ok: true, deleted: true};
    }
    return {ok: true, notFound: true};
  } finally {
    lock.releaseLock();
  }
}

/** The boat's own logs from the last 14 days, exact positions, for its crew's phones only. */
function strikeLogTeam_(props, boat) {
  const since = Date.now() - 14 * 86400000;
  return strikeLogRows_(props).filter(r => r.boat === boat.name && Date.parse(r.date) >= since)
    .map(r => ({id: r.id, date: r.date, lat: r.lat, lon: r.lon, species: r.species, count: r.count, note: r.note, wt: r.wt}));
}

function strikeLogRows_(props) {
  const sh = strikeLogSheet_(props);
  if (sh.getLastRow() < 2) return [];
  const share = {}, btype = {}; strikeLogBoats_(props).forEach(b => { share[b.name] = b.share || 'research'; btype[b.name] = b.type || ''; });
  return sh.getRange(2, 1, sh.getLastRow() - 1, STRIKELOG.HEADER.length).getValues().map(r => ({
    received: r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
    date: r[1] instanceof Date ? r[1].toISOString() : String(r[1]),
    lat: Number(r[2]), lon: Number(r[3]), species: String(r[4]), count: Number(r[5]),
    note: String(r[6] || ''), exact: r[7] === 'yes', id: String(r[8] || ''),
    boat: String(r[9] || ''), wt: r[11] === '' || r[11] == null ? null : Number(r[11]), share: share[String(r[9] || '')] || 'research', boatType: btype[String(r[9] || '')] || ''}));     // unknown or unset → private
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
  if (!logs.getRange(1, 11).getValue()) logs.getRange(1, 11).setValue('Phone').setFontWeight('bold');
  if (!logs.getRange(1, 12).getValue()) logs.getRange(1, 12).setValue('Approx weight (lb)').setFontWeight('bold');
  return logs;
}

/** Run once: prints a random read key to paste into Script Properties (STRIKELOG_READ_KEY) and the GitHub secret. */
function makeStrikeLogReadKey() {
  console.log(Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8));
}

/** Gives every boat without one a captain code (e.g. boats made before captain codes). Prints them to pass on. */
function fillCaptainCodes() {
  const props = PropertiesService.getScriptProperties(), sh = strikeLogBoatsSheet_(props);
  strikeLogBoats_(props).forEach(b => {
    if (b.cap) return;
    const cap = strikeLogNewCode_(10);
    sh.getRange(b.row, 6).setValue(cap);
    console.log(b.name + ': captain code ' + cap + (b.by ? ' (give to ' + b.by + ')' : ''));
  });
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
  fillCaptainCodes();
  if (!sh.getRange(1, 11).getValue()) sh.getRange(1, 11).setValue('Phone').setFontWeight('bold');
}
