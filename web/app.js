/* Sea Intel Lab – strike grid live map. Everything stays on the phone unless the user sends their logs. */
(() => {
  'use strict';
  const COLORS = {Highest: '#8c0040', High: '#d91a1a', Good: '#ff801a', Medium: '#ffd933', Low: '#fff266'};
  const OPAC = {Highest: .62, High: .55, Good: .45, Medium: .32, Low: .2};
  const $ = id => document.getElementById(id);
  const COS = Math.cos(17.7 * Math.PI / 180);
  const nm = (a, b) => Math.hypot((a[0] - b[0]) * 60, (a[1] - b[1]) * 60 * COS);
  const bearing = (a, b) => (Math.atan2((b[1] - a[1]) * COS, b[0] - a[0]) * 180 / Math.PI + 360) % 360;
  const compass = d => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];
  const ddm = (v, p, n) => { const h = v >= 0 ? p : n; v = Math.abs(v); return `${Math.floor(v)}°${((v % 1) * 60).toFixed(1).padStart(4, '0')}′${h}`; };
  const pos2txt = (la, lo) => `${ddm(la, 'N', 'S')} ${ddm(lo, 'E', 'W')}`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const store = {get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
                 set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }};
  function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }

  const map = L.map('map', {zoomControl: true, attributionControl: true, zoomSnap: .5, preferCanvas: true}).setView([17.70, -76.88], 11);
  map.attributionControl.setPrefix(false);
  let tiles = null, coastLayer = null;
  const COAST_PLAIN = {color: '#b6c9d0', weight: 1, fillColor: '#3b4a55', fillOpacity: 1};
  const COAST_OVER_TILES = {color: '#b6c9d0', weight: 0, fillOpacity: 0};
  const sea = L.layerGroup().addTo(map);

  let cells = new Map(), hot = [], meta = {}, area = null, cellDeg = .01, topSpots = [];
  const topMarkers = {};
  const key = (la, lo) => `${Math.floor((la - area.south) / cellDeg)}|${Math.floor((lo - area.west) / cellDeg)}`;
  const CLASSES = [[.9, 'Highest'], [.77, 'High'], [.62, 'Good'], [.47, 'Medium'], [.32, 'Low']];
  const VIEWS = {south: [[17.45, -77.45], [18.0, -76.25]], east: [[17.3, -76.6], [18.8, -75.4]],
                 north: [[18.2, -78.6], [18.8, -76.6]], all: [[16.6, -78.9], [19.2, -75.2]]};

  async function getJSON(u) { const r = await fetch(u, {cache: 'no-cache'}); if (!r.ok) throw Error(u + ' ' + r.status); return r.json(); }

  async function load() {
    const [coast, grid, top, rel, m, banks] = await Promise.all([
      getJSON('coast.geojson'), getJSON('grid.json'), getJSON('top-spots.json'),
      getJSON('releases.json').catch(() => []), getJSON('meta.json'), getJSON('banks.json').catch(() => [])]);
    meta = m; area = grid.area; cellDeg = grid.cell;
    const built = new Date(m.built_utc);
    $('built').textContent = `Built ${built.toLocaleString([], {weekday: 'short', hour: 'numeric', minute: '2-digit'})}` +
      (m.sea_date ? ` · sea data from ${new Date(m.sea_date + 'T12:00:00').toLocaleDateString([], {month: 'short', day: 'numeric'})}` : '') +
      (Date.now() - built > 18 * 3600e3 ? ' · may be out of date' : '');
    $('sources').textContent = `Updated with the latest sea conditions${m.releases_used ? ` and ${m.releases_used} recent release${m.releases_used === 1 ? '' : 's'}` : ''}.`;

    coastLayer = L.geoJSON(coast, {interactive: false, style: tiles ? COAST_OVER_TILES : COAST_PLAIN}).addTo(sea);
    const canvas = L.canvas({padding: .3});
    const n = v => v < 0 ? null : v / 10;
    for (const r of grid.rows) {
      const [i, j, s1000, depth, drop, front, zoo, conv, rel, temp = -1, cool = 0, sight = -1] = r, score = s1000 / 1000;
      const la = area.south + (i + .5) * cellDeg, lo = area.west + (j + .5) * cellDeg;
      const p = {score, cls: CLASSES.find(c => score >= c[0])[1], lat: la, lon: lo, depth_m: depth < 0 ? null : depth, drop: drop / 100,
                 front_nm: n(front), zoo_nm: n(zoo), conv_nm: n(conv), release_nm: n(rel), temp_nm: n(temp), cool: cool / 100, sight_nm: n(sight)};
      cells.set(`${i}|${j}`, p); if (score >= .77) hot.push(p);
      L.rectangle([[la - cellDeg / 2, lo - cellDeg / 2], [la + cellDeg / 2, lo + cellDeg / 2]],
        {renderer: canvas, stroke: false, fillColor: COLORS[p.cls], fillOpacity: OPAC[p.cls]}).on('click', ev => L.popup().setLatLng(ev.latlng).setContent(explain(p)).openOn(map)).addTo(sea);
    }
    banks.forEach(b => L.circleMarker([b.lat, b.lon], {radius: 5, color: '#fff', weight: 1.5, fillColor: '#e8475f', fillOpacity: 1})
      .bindPopup(() => bankPopup(b), {maxWidth: 300}).addTo(sea));
    rel.forEach(r => L.marker([r.lat, r.lon], {icon: L.divIcon({className: '', html: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.9 7.1.6-5.4 4.7 1.7 7.3L12 17.8 5.7 21.5l1.7-7.3L2 9.5l7.1-.6z" fill="#00e5ff" stroke="#061b33" stroke-width="1.5"/></svg>', iconSize: [22, 22], iconAnchor: [11, 11]}),
      title: 'Release ' + r.date.slice(0, 10)}).bindPopup(`Release ${esc(r.date.slice(0, 10))}<br>${pos2txt(r.lat, r.lon)}${r.note ? '<br>' + esc(r.note) : ''}`).addTo(sea));
    topSpots = top;
    top.forEach(t => topMarkers[`${t.region}|${t.rank}`] = L.marker([t.lat, t.lon], {icon: L.divIcon({className: 'spot', html: String(t.rank), iconSize: [26, 26]}), title: `${t.region || ''} top ${t.rank}`, zIndexOffset: 500})
      .bindPopup(`<b>${esc(t.region || '')} · spot ${t.rank}</b><br>${pos2txt(t.lat, t.lon)}`).addTo(sea));
    renderPlan();
    const v = store.get('sil.view', 'south'); $('areaSel').value = v; map.fitBounds(VIEWS[v] || VIEWS.south);
    drawMyLogs();
  }

  function explain(p) {
    const r = [], near = (v, d) => v != null && v <= d;
    if (p.drop >= .6) r.push('On the drop-off'); else if (p.drop >= .3) r.push('Near the drop-off');
    if (near(p.front_nm, 1.5)) r.push('Green-to-blue water line close by'); else if (near(p.front_nm, 3)) r.push('Green-to-blue water line nearby');
    if (near(p.temp_nm, 1.5)) r.push('Temperature break close by'); else if (near(p.temp_nm, 3)) r.push('Temperature break nearby');
    if (p.cool >= .4) r.push('Cooler water edge');
    if (near(p.zoo_nm, 2.5)) r.push('Bait likely nearby');
    if (near(p.conv_nm, 3)) r.push('Current line nearby');
    if (near(p.release_nm, 3)) r.push('Recent catch nearby');
    if (near(p.sight_nm, 2)) r.push('Birds or bait seen nearby recently');
    if (!r.length) r.push('Not much going for it today');
    return `<b>${p.cls}</b><br>${pos2txt(p.lat, p.lon)}<br><small>${r.join('<br>')}</small>`;
  }

  // ---------- boat
  let watch = null, boat = null, acc = null, last = null, follow = false, heading = null;
  const boatIcon = deg => L.divIcon({className: 'boat', iconSize: [28, 28], iconAnchor: [14, 14],
    html: `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" style="transform:rotate(${deg ?? 0}deg)"><circle cx="14" cy="14" r="8" fill="#1a73e8" stroke="#fff" stroke-width="3"/>${deg == null ? '' : '<path d="M14 1l5 8h-10z" fill="#1a73e8" stroke="#fff" stroke-width="1.5"/>'}</svg>`});

  function onPos(p) {
    const la = p.coords.latitude, lo = p.coords.longitude, here = [la, lo];
    if (p.coords.heading != null && !isNaN(p.coords.heading) && p.coords.speed > .5) heading = p.coords.heading;
    else if (last && nm(last, here) > .02) heading = bearing(last, here);
    last = here;
    if (!boat) { boat = L.marker(here, {icon: boatIcon(heading), zIndexOffset: 1000, keyboard: false}).addTo(map); acc = L.circle(here, {radius: p.coords.accuracy, weight: 1, color: '#1a73e8', fillOpacity: .08, interactive: false}).addTo(map); map.setView(here, Math.max(map.getZoom(), 12)); }
    else { boat.setLatLng(here).setIcon(boatIcon(heading)); acc.setLatLng(here).setRadius(p.coords.accuracy); }
    if (follow) map.panTo(here, {animate: true});
    if (!onPos.timesDone) { onPos.timesDone = true; renderTimes(); }
    $('boatBar').hidden = false;
    $('pos').textContent = pos2txt(la, lo);
    const c = area && cells.get(key(la, lo));
    $('here').textContent = c ? c.cls : 'Not shaded';
    if (Date.now() - (onPos.planAt || 0) > 30000) { onPos.planAt = Date.now(); renderPlan(); }
    let best = null, bd = 1e9;
    for (const h of hot) { const d = nm(here, [h.lat, h.lon]); if (d < bd) { bd = d; best = h; } }
    const cp = nearestCond(la, lo), ck = condIndex();
    if (cp && ck >= 0) { $('seaRow').hidden = false; $('seaHere').textContent = condText(cp, ck); } else $('seaRow').hidden = true;
    if (!onPos.confDone && confData) { onPos.confDone = true; renderConf(); }
    $('best').textContent = best ? (bd < .35 ? `You're on it (${best.cls})` : `${best.cls} ${bd.toFixed(1)} NM ${compass(bearing(here, [best.lat, best.lon]))}`) : '–';
  }
  function onErr(e) { toast(e.code === 1 ? 'Location permission is off for this site.' : 'No GPS fix yet – keep the page open.'); }

  $('boatBtn').addEventListener('click', () => {
    if (watch != null) { navigator.geolocation.clearWatch(watch); watch = null; $('boatBtn').textContent = 'Show my boat'; $('followBtn').disabled = true; return; }
    if (!('geolocation' in navigator)) return toast('This phone/browser has no location.');
    watch = navigator.geolocation.watchPosition(onPos, onErr, {enableHighAccuracy: true, maximumAge: 5000, timeout: 30000});
    $('boatBtn').textContent = 'Hide my boat'; $('followBtn').disabled = false;
  });
  $('followBtn').addEventListener('click', () => { follow = !follow; $('followBtn').setAttribute('aria-pressed', follow); if (follow && last) map.panTo(last); });
  map.on('dragstart', () => { if (follow) { follow = false; $('followBtn').setAttribute('aria-pressed', false); } });

  // ---------- releases logged on this phone
  const LOGS = 'sil.logs', CODE = 'sil.code';
  const LOG_URL = 'https://script.google.com/macros/s/AKfycbzwP_tF1SeJIBgB7HxTRBi374NiF0tQXGcSBFUk7EPPu1rSAepDsALW-iHeny6yo1Y/exec';   // marine Apps Script
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9-]/g, '');
  const myLayer = L.layerGroup().addTo(map);
  function drawMyLogs() {
    myLayer.clearLayers(); const logs = store.get(LOGS, []);
    logs.forEach(l => L.circleMarker([l.lat, l.lon], {radius: 6, color: '#061b33', weight: 2, fillColor: l.count === 0 ? '#9aa5b1' : '#00e5ff', fillOpacity: 1})
      .bindPopup(`${esc(l.species)} × ${l.count}<br>${new Date(l.time).toLocaleString()}<br>${pos2txt(l.lat, l.lon)}${l.note ? '<br>' + esc(l.note) : ''}<br><small>${l.synced ? 'Sent ✓' : 'Waiting to send'}</small>`).addTo(myLayer));
    const waiting = logs.filter(l => !l.synced).length;
    $('logCount').textContent = logs.length ? `${logs.length} on this phone${waiting ? ` · ${waiting} waiting to send` : ' · all sent'}` : 'none yet';
    $('codeState').textContent = store.get(CODE, '') ? 'set' : 'not set';
  }
  let pendingPos = null;
  $('logBtn').addEventListener('click', () => {
    pendingPos = last;
    $('species').value = 'Blue marlin'; $('count').value = 1;
    $('logWhere').textContent = last ? `At ${pos2txt(last[0], last[1])} (your boat).` : 'No boat position yet – it will use the centre of the map. Tap “Show my boat” first for an exact spot.';
    if (!last) { const c = map.getCenter(); pendingPos = [c.lat, c.lng]; }
    $('logDlg').showModal();
  });
  $('species').addEventListener('change', e => { if (e.target.value === 'No strikes here') $('count').value = 0; });
  $('logDlg').addEventListener('close', () => {
    if ($('logDlg').returnValue !== 'save' || !pendingPos) return;
    const logs = store.get(LOGS, []);
    logs.push({id: newId(), time: new Date().toISOString(), lat: +pendingPos[0].toFixed(5), lon: +pendingPos[1].toFixed(5), species: $('species').value,
               count: Math.max(0, parseInt($('count').value, 10) || 0), note: $('note').value.trim().slice(0, 120), exact: !!last, synced: false});
    store.set(LOGS, logs); $('note').value = ''; drawMyLogs();
    toast(store.get(CODE, '') ? 'Saved – sending when there is signal' : 'Saved on this phone (set a logging code to send it)');
    sendPending();
  });
  // Send logs to the Google Sheet; anything that fails stays queued and is retried later.
  let sending = false;
  async function sendPending() {
    const code = store.get(CODE, ''); if (!code || sending || !navigator.onLine) return;
    sending = true;
    try {
      for (const l of store.get(LOGS, []).filter(x => !x.synced)) {
        if (!l.id) l.id = newId();
        const q = new URLSearchParams({action: 'strikelog', code, id: l.id, time: l.time, lat: l.lat, lon: l.lon, species: l.species, count: l.count, note: l.note || '', exact: l.exact ? '1' : '0'});
        let j = null;
        try { const r = await fetch(`${LOG_URL}?${q}`, {cache: 'no-store'}); j = await r.json(); } catch { break; }       // no signal: try later
        if (j && j.ok) { const all = store.get(LOGS, []); const m = all.find(x => x.id === l.id || x.time === l.time); if (m) { m.synced = true; m.id = l.id; } store.set(LOGS, all); }
        else if (j && /code/.test(j.error || '')) { toast('Logging code not accepted – check it under More'); break; }
        else if (j) { toast('Not sent: ' + (j.error || 'unknown')); break; }
      }
    } finally { sending = false; drawMyLogs(); }
  }
  window.addEventListener('online', sendPending);
  setInterval(sendPending, 120000);
  $('codeBtn').addEventListener('click', () => {
    const v = prompt('Logging code (from Andrew). Leave empty to stop sending.', store.get(CODE, ''));
    if (v === null) return; store.set(CODE, v.trim()); drawMyLogs(); if (v.trim()) { toast('Code saved'); sendPending(); }
  });

  // ---------- track record
  async function loadTrack() {
    let t; try { t = await getJSON('track-record.json'); } catch { $('trackSummary').textContent = 'No track record yet.'; return; }
    const s = t.strikes, sh = t.area_share || {}, pct = v => v == null ? '–' : (v * 100 < 1 ? (v * 100).toFixed(1) : Math.round(v * 100)) + '%';
    $('trackShort').textContent = s.scored ? `${s.high_plus} of ${s.scored} strikes in High+` : 'collecting';
    $('trackSummary').innerHTML = s.scored
      ? `<b>${s.high_plus} of ${s.scored}</b> scored strikes were in <b>High or Highest</b> squares, which cover about <b>${pct(sh.high_plus)}</b> of the grid area. ` +
        `<b>${s.good_plus} of ${s.scored}</b> were Good or better (${pct(sh.good_plus)} of the area).` +
        (t.quiet.scored ? ` Quiet logs: ${t.quiet.below_good} of ${t.quiet.scored} were in squares below Good.` : '') +
        (t.not_scored ? ` <span class="small">(${t.not_scored} log${t.not_scored > 1 ? 's' : ''} not counted)</span>` : '') +
        (t.comparison && t.comparison.strikes ? `<br><span class="small"><b>With vs without sea temperature</b> (${t.comparison.strikes} strike${t.comparison.strikes > 1 ? 's' : ''}): ` +
          `High+ ${t.comparison.with_temp.strikes_high_plus} vs ${t.comparison.without_temp.strikes_high_plus} · ` +
          `Good+ ${t.comparison.with_temp.strikes_good_plus} vs ${t.comparison.without_temp.strikes_good_plus}` +
          (t.comparison.quiet ? ` · quiet logs in low squares ${t.comparison.with_temp.quiet_below_good} vs ${t.comparison.without_temp.quiet_below_good}` : '') + '</span>' : '') +
        (t.by_region ? '<br><span class="small">' + Object.entries(t.by_region).filter(([, r]) => r.scored).map(([k, r]) => `${esc(k)}: ${r.high_plus} of ${r.scored}`).join(' · ') + '</span>' : '')
      : `Collecting. ${t.snapshots} grid${t.snapshots === 1 ? '' : 's'} saved so far; logs made from now on will be scored against them.` +
        (t.not_scored ? ` ${t.not_scored} earlier log${t.not_scored > 1 ? 's' : ''} not counted.` : '');
    $('trackList').innerHTML = t.entries.slice(-12).reverse().map(e =>
      `<li>${esc(new Date(e.date).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}))} · ${esc(e.species)} × ${e.count}${e.region ? ' · ' + esc(e.region) : ''} · ` +
      (e.scored ? `<b>${esc(e.cls)}</b>${e.cls_no_temp && e.cls_no_temp !== e.cls ? ` <span class="small">(without temperature: ${esc(e.cls_no_temp)})</span>` : ''}` : 'not counted') + '</li>').join('');
  }
  $('trackBtn').addEventListener('click', () => { sheet($('trackBtn'), $('track')); loadTrack(); });

  $('sendLogs').addEventListener('click', async () => {
    const logs = store.get(LOGS, []); if (!logs.length) return toast('No releases logged yet');
    const text = 'Strike grid logs\n' + logs.map(l => `${l.time} | ${l.species} x${l.count} | ${l.lat}, ${l.lon}${l.exact ? '' : ' (map centre)'}${l.note ? ' | ' + l.note : ''}`).join('\n');
    try { if (navigator.share) { await navigator.share({title: 'Strike grid logs', text}); return; } } catch (e) { if (e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast('Copied – paste it in a message'); } catch { prompt('Copy your logs:', text); }
  });

  $('areaSel').addEventListener('change', e => { store.set('sil.view', e.target.value); renderTimes(); renderConf(); renderPlan(); follow = false; $('followBtn').setAttribute('aria-pressed', false); map.fitBounds(VIEWS[e.target.value]); });

  // ---------- birds / bait / weed sightings (logged like releases, short-lived on the map)
  const sightLayer = L.layerGroup().addTo(map);
  async function drawSightings() {
    sightLayer.clearLayers();
    let list = []; try { list = await getJSON('sightings.json'); } catch {}
    const mine = store.get(LOGS, []).filter(l => SIGHT.includes(l.species)).map(l => ({date: l.time, lat: l.lat, lon: l.lon, what: l.species}));
    const seen = new Set();
    for (const s of [...mine, ...list]) {
      const age = (Date.now() - new Date(s.date)) / 36e5, k = `${s.date.slice(0, 16)}|${s.lat.toFixed(3)}`;
      if (age > 24 || age < -1 || seen.has(k)) continue; seen.add(k);
      L.marker([s.lat, s.lon], {zIndexOffset: 600, icon: L.divIcon({className: 'seen', iconSize: [24, 24], iconAnchor: [12, 12],
        html: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" style="opacity:${Math.max(.35, 1 - age / 24)}"><circle cx="12" cy="12" r="10" fill="#7CFC9A" stroke="#061b33" stroke-width="2"/><path d="M6 13c2-2 4-2 6 0 2-2 4-2 6 0" fill="none" stroke="#061b33" stroke-width="2" stroke-linecap="round"/></svg>`})})
        .bindPopup(`<b>${esc(s.what)}</b><br>${age < 1 ? 'Under an hour ago' : Math.round(age) + ' h ago'}<br>${pos2txt(s.lat, s.lon)}`).addTo(sightLayer);
    }
  }
  const SIGHT = ['Birds working', 'Bait (surface)', 'Bait (sounder)', 'Fish busting', 'Weedline', 'Debris / log'];
  let seenPos = null;
  $('seenBtn').addEventListener('click', () => {
    seenPos = last; if (!last) { const c = map.getCenter(); seenPos = [c.lat, c.lng]; }
    $('seenWhere').textContent = last ? `At ${pos2txt(last[0], last[1])} (your boat).` : 'No boat position yet – it will use the centre of the map.';
    $('seenDlg').showModal();
  });
  $('seenDlg').addEventListener('close', () => {
    const v = $('seenDlg').returnValue; if (!SIGHT.includes(v) || !seenPos) return;
    const logs = store.get(LOGS, []);
    logs.push({id: newId(), time: new Date().toISOString(), lat: +seenPos[0].toFixed(5), lon: +seenPos[1].toFixed(5), species: v, count: 1, note: '[seen] ' + v, exact: !!last, synced: false});
    store.set(LOGS, logs); drawMyLogs(); drawSightings(); toast(`${v} logged`); sendPending();
  });

  // ---------- best times strip: dawn/dusk and solunar periods (worked out on the phone), tide and current turns (from the build)
  const POINTS = {south: [17.70, -76.88], east: [17.85, -76.15], north: [18.55, -77.60], all: [17.70, -76.88]};
  let timesData = null, tomorrow = false, BANKLIST = [], showAllTimes = false;
  const hm = d => d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  const hspan = (a, b) => { const x = hm(a), y = hm(b), ax = x.slice(-2), by = y.slice(-2); return (ax === by && /[AP]M/i.test(ax) ? x.slice(0, -3) : x) + '–' + y; };
  // One timetable for the whole island: worked out at the average position of all the banks (they differ by only minutes).
  function islandCentre() {
    if (!BANKLIST.length) return [17.95, -76.67];
    return [BANKLIST.reduce((t, b) => t + b.lat, 0) / BANKLIST.length, BANKLIST.reduce((t, b) => t + b.lon, 0) / BANKLIST.length];
  }
  function regionFor(la, lo) { let best = 'south', bd = 1e9; for (const k of ['south', 'east', 'north']) { const d = nm([la, lo], POINTS[k]); if (d < bd) { bd = d; best = k; } } return best; }
  // Dawn/dusk windows and the major/minor feeding periods for one local day (island-wide), with Prime marked.
  function feeding(day) {
    const [la, lo] = islandCentre(), mid = new Date(day.getTime() + 432e5);
    const sun = Sky.sunTimes(mid, la, lo);
    const win = [
      {start: sun.dawn, end: new Date(sun.sunrise.getTime() + 36e5), label: `Dawn ${hspan(sun.dawn, new Date(sun.sunrise.getTime() + 36e5))}`, why: 'First light to an hour after sunrise: fish often feed near the surface.'},
      {start: new Date(sun.sunset.getTime() - 36e5), end: sun.dusk, label: `Dusk ${hspan(new Date(sun.sunset.getTime() - 36e5), sun.dusk)}`, why: 'The last hour of sun to last light: another strong feeding time.'}];
    const overlaps = (x, w) => x.start < w.end && x.end > w.start;
    let nM = 0, nm2 = 0;
    const sol = Sky.solunar(day, la, lo).map(e => e.kind === 'major'
      ? {...e, label: `Major ${++nM} ${hspan(e.start, e.end)}`, why: `Major feeding period: the moon is ${e.what === 'overhead' ? 'overhead' : 'underfoot'} at ${hm(e.at)}. About two hours. Strongest when it lines up with dawn, dusk or a tide turn.`}
      : {...e, label: `Minor ${++nm2} ${hspan(e.start, e.end)}`, why: `Minor feeding period: moon${e.what} at ${hm(e.at)}. About an hour. Worth more when it falls at dawn or dusk.`});
    for (const e of sol) e.prime = win.some(w => overlaps(e, w));
    return {win, sol};
  }
  function renderTimes() {
    const now = new Date(), day = new Date(now); day.setHours(0, 0, 0, 0); if (tomorrow) day.setDate(day.getDate() + 1);
    const end = new Date(day.getTime() + 864e5), mid = new Date(day.getTime() + 432e5);
    const [la, lo] = islandCentre(), ref = last || POINTS[store.get('sil.view', 'south')] || POINTS.south, pk = regionFor(ref[0], ref[1]);
    const {win, sol} = feeding(day);
    const items = win.map(w => ({...w, kind: 'light'}));
    items.push(...sol);
    const P = timesData && timesData.points && timesData.points[pk];
    if (P) {
      for (const t of P.tides) { const d = new Date(t.time); if (d >= day && d < end) items.push({start: new Date(d - 27e5), end: new Date(+d + 27e5), at: d, kind: 'tide', label: `Tide ${t.type} ${hm(d)}`, why: `The tide turns (${t.type}). Bait often moves when water starts to move again.`}); }
      for (const t of P.current) { const d = new Date(t.time); if (d >= day && d < end) items.push({start: new Date(d - 27e5), end: new Date(+d + 27e5), at: d, kind: 'current', label: `Current ${t.type === 'slack' ? 'slack' : 'turns'} ${hm(d)}`, why: 'The current eases or changes direction. Strikes often come as it picks up again.'}); }
    }
    for (const it of items) if (it.kind === 'tide' || it.kind === 'current') it.prime = [...win, ...sol].some(w => it.at >= w.start && it.at <= w.end);
    items.sort((a, b) => a.start - b.start);
    // Compact by default: only the major and minor feeding periods on now or still to come. Everything else behind "+N more".
    const show = items.map(it => showAllTimes || ((it.kind === 'major' || it.kind === 'minor') && it.end >= now));
    const hidden = show.filter(v => !v).length;
    $('chips').innerHTML = items.map((it, k) => {
      if (!show[k]) return '';
      const cls = ['chip', it.kind, it.prime ? 'prime' : '', now >= it.start && now <= it.end ? 'now' : '', it.end < now ? 'past' : ''].join(' ');
      return `<button class="${cls}" data-k="${k}" title="${esc(it.why)}">${it.prime ? 'Prime · ' : ''}${esc(it.label)}</button>`;
    }).join('') + (hidden ? `<button class="chip more" id="chipMore">+${hidden} more</button>` : showAllTimes ? '<button class="chip more" id="chipMore">Show less</button>' : '');
    $('chips').querySelectorAll('button.chip[data-k]').forEach(b => b.addEventListener('click', () => toast(items[+b.dataset.k].why)));
    const mb = $('chipMore'); if (mb) mb.addEventListener('click', () => { showAllTimes = !showAllTimes; renderTimes(); });
    const il = Sky.moonIllum(mid);
    $('moonLine').textContent = `${Sky.phaseName(il.phase)}, ${Math.round(il.fraction * 100)}% lit`;
  }
  function setDay(t) { tomorrow = t; showAllTimes = false; $('tToday').setAttribute('aria-pressed', !t); $('tTomorrow').setAttribute('aria-pressed', t); renderTimes(); }
  $('tToday').addEventListener('click', () => setDay(false)); $('tTomorrow').addEventListener('click', () => setDay(true));
  getJSON('banks.json').then(bs => { BANKLIST = bs.filter(b => b.lat != null && b.lon != null); renderTimes(); renderPlan(); }).catch(() => {});
  getJSON('times.json').then(t => { timesData = t; renderTimes(); }).catch(() => renderTimes());
  setInterval(renderTimes, 300000);

  // ---------- depth contours (on/off, remembered)
  const DEPTH_COLORS = {100: '#9fe7ff', 200: '#e0f7ff', 500: '#5cc8ff', 1000: '#3a8fe0', 2000: '#8a7dff'};
  let contourLayer = null, contourData = null;
  const labelLayer = L.layerGroup();
  // Small depth labels along the lines, spaced by zoom and turned to follow the line (kept upright).
  function drawDepthLabels() {
    labelLayer.clearLayers();
    if (!contourData || !map.hasLayer(contourLayer) || map.getZoom() < 8) return;
    const spacingNm = 48 / Math.pow(2, map.getZoom() - 8), view = map.getBounds().pad(.2);
    for (const f of contourData.features) {
      const c = f.geometry.coordinates, d = f.properties.depth_m; let run = spacingNm / 2;
      for (let k = 1; k < c.length; k++) {
        const a = [c[k - 1][1], c[k - 1][0]], b = [c[k][1], c[k][0]];
        run += nm(a, b);
        if (run < spacingNm || !view.contains(b)) continue;
        run = 0;
        const pa = map.latLngToLayerPoint(a), pb = map.latLngToLayerPoint(b);
        let ang = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
        L.marker(b, {interactive: false, keyboard: false, icon: L.divIcon({className: 'dlabel', iconSize: [0, 0],
          html: `<span style="transform:translate(-50%,-50%) rotate(${ang.toFixed(0)}deg);color:${DEPTH_COLORS[d] || '#cfefff'}">${d} m</span>`})}).addTo(labelLayer);
      }
    }
  }
  map.on('zoomend moveend', drawDepthLabels);
  async function showContours(on) {
    store.set('sil.contours', on);
    if (!on) { if (contourLayer) { map.removeLayer(contourLayer); } map.removeLayer(labelLayer); return; }
    if (!contourLayer) {
      let gj; try { gj = await getJSON('contours.geojson'); } catch { toast('Depth contours not available yet'); $('contours').checked = false; return; }
      const levels = [...new Set(gj.features.map(f => f.properties.depth_m))].sort((a, b) => a - b);
      contourData = gj;
      contourLayer = L.geoJSON(gj, {interactive: true,
        style: f => ({color: DEPTH_COLORS[f.properties.depth_m] || '#5cc8ff', weight: f.properties.depth_m === 200 ? 2.6 : 1.3, opacity: f.properties.depth_m === 200 ? 1 : .85, dashArray: f.properties.depth_m >= 1000 ? '5 4' : null}),
        onEachFeature: (f, l) => l.bindTooltip(`${f.properties.depth_m} m (${Math.round(f.properties.depth_m * 3.281)} ft)`, {sticky: true})});
      contourLayer.bindPopup(`Depth lines: ${levels.join(', ')} m<br><small>Approximate – use your chart for real depths</small>`);
    }
    contourLayer.addTo(map); labelLayer.addTo(map); drawDepthLabels();
  }
  $('contours').addEventListener('change', e => showContours(e.target.checked));
  if (store.get('sil.contours', false)) { $('contours').checked = true; showContours(true); }


  // ---------- wind, sea and current (from the build) · weed seen by satellite · how much to trust the picture
  let cond = null;
  const VIEW_REGION = {south: 'South coast', east: 'East & north-east', north: 'North & west', all: 'South coast'};
  function condIndex() {
    if (!cond) return -1;
    const k = Math.floor((Date.now() - Date.parse(cond.start_utc)) / 36e5);
    return k >= 0 && k < 36 ? k : -1;
  }
  function condText(p, k) {
    const part = [];
    if (p.wind && p.wind[k] != null) part.push(`Wind ${p.wind[k]} kn from ${compass(p.wdir[k])}${p.gust[k] > p.wind[k] + 4 ? `, gusts ${p.gust[k]}` : ''}`);
    if (p.wave && p.wave[k] != null) part.push(`Seas ${p.wave[k].toFixed(1)} m${p.period[k] ? ` every ${p.period[k]} s` : ''}`);
    if (p.cur && p.cur[k] != null) part.push(`Current ${p.cur[k].toFixed(1)} kn running ${compass(p.cdir[k])}`);
    return part.join(' · ');
  }
  function nearestCond(la, lo) {
    if (!cond) return null; let best = null, bd = 1e9;
    for (const p of cond.points) { const d = nm([la, lo], [p.lat, p.lon]); if (d < bd) { bd = d; best = p; } }
    return bd < 25 ? best : null;
  }
  function bankPopup(b) {
    const k = condIndex(), p = cond && cond.points.find(x => x.kind === 'bank' && x.name === b.name);
    let html = `<div class="cond"><b>${esc(b.name)}</b>`;
    if (!p || k < 0) return html + '<br><small>Wind and sea not available yet</small></div>';
    html += `<br>${esc(condText(p, k))}<table><tr><th></th><th>Wind</th><th>Seas</th><th>Current</th></tr>`;
    for (let h = k; h < Math.min(k + 25, 36); h += 3) {
      const t = new Date(Date.parse(cond.start_utc) + h * 36e5);
      html += `<tr><th>${t.toLocaleTimeString([], {weekday: h - k >= 12 ? 'short' : undefined, hour: 'numeric'})}</th><td>${p.wind[h] ?? '–'} ${p.wdir[h] != null ? compass(p.wdir[h]) : ''}</td>` +
              `<td>${p.wave[h] != null ? p.wave[h].toFixed(1) + ' m' : '–'}</td><td>${p.cur[h] != null ? p.cur[h].toFixed(1) + ' → ' + compass(p.cdir[h]) : '–'}</td></tr>`;
    }
    return html + '</table><small>Wind from · current running towards · knots</small></div>';
  }
  const arrowLayer = L.layerGroup();
  function drawArrows() {
    arrowLayer.clearLayers(); const k = condIndex(); if (k < 0) return;
    for (const p of cond.points) {
      const v = p.cur && p.cur[k], d = p.cdir && p.cdir[k]; if (v == null || d == null) continue;
      const len = 14 + Math.min(v, 2) * 10;
      L.marker([p.lat, p.lon], {interactive: false, keyboard: false, icon: L.divIcon({className: 'curArrow', iconSize: [60, 60], iconAnchor: [30, 30],
        html: `<svg width="60" height="60" viewBox="-30 -30 60 60" aria-hidden="true"><g transform="rotate(${d})"><line x1="0" y1="${len / 2}" x2="0" y2="${-len / 2}" stroke="#061b33" stroke-width="5" stroke-linecap="round"/><path d="M0 ${-len / 2 - 6}l5 8h-10z" fill="#061b33"/>` +
              `<line x1="0" y1="${len / 2}" x2="0" y2="${-len / 2}" stroke="#7df9ff" stroke-width="2.5" stroke-linecap="round"/><path d="M0 ${-len / 2 - 5}l3.5 6.5h-7z" fill="#7df9ff"/></g>` +
              `<text x="0" y="${len / 2 + 13}" text-anchor="middle" font-size="10" font-weight="700" fill="#fff" stroke="#061b33" stroke-width="3" paint-order="stroke">${v.toFixed(1)}</text></svg>`})}).addTo(arrowLayer);
    }
  }
  $('curArrows').addEventListener('change', e => { store.set('sil.arrows', e.target.checked); if (e.target.checked) { drawArrows(); arrowLayer.addTo(map); if (!cond) toast('Current arrows load with signal'); } else map.removeLayer(arrowLayer); });
  const weedLayer = L.layerGroup();
  function drawWeed(w) {
    weedLayer.clearLayers();
    for (const p of w.patches) L.circleMarker([p.lat, p.lon], {radius: Math.min(3 + Math.sqrt(p.size), 9), color: '#2f5d12', weight: 1, fillColor: '#b6f23a', fillOpacity: .85})
      .bindPopup(`<b>Weed seen by satellite</b><br>${pos2txt(p.lat, p.lon)}<br><small>${p.size > 6 ? 'Large patch' : 'Small patch'} · seen in the 3 days to ${esc(w.date)}. It drifts, so look along the current.</small>`).addTo(weedLayer);
  }
  let weedData = null;
  $('weedLayer').addEventListener('change', e => { store.set('sil.weed', e.target.checked); if (e.target.checked) { if (!weedData) toast('Weed data loads with signal'); weedLayer.addTo(map); } else map.removeLayer(weedLayer); });
  let confData = null;
  function renderConf() {
    if (!confData) return;
    const ref = last ? null : VIEW_REGION[store.get('sil.view', 'south')];
    let reg = ref;
    if (last && cond) { const c = nearestCond(last[0], last[1]); reg = c ? (c.kind === 'spot' ? c.name.replace(/ spot \d+$/, '') : null) : null; }
    if (!reg || !confData[reg]) reg = VIEW_REGION[store.get('sil.view', 'south')] || 'South coast';
    const c = confData[reg]; if (!c) return;
    $('confBtn').hidden = false; $('confBtn').className = 'conf ' + c.level; $('confBtn').textContent = `Picture: ${c.level}`;
    $('confBtn').title = `${reg}: ${c.why.join('. ')}`;
    $('confList').innerHTML = Object.entries(confData).map(([r, v]) => `<div class="confRow"><b>${esc(r)}</b><span class="conf ${v.level}">${v.level}</span><ul>${v.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>`).join('');
  }
  $('confBtn').addEventListener('click', () => sheet($('confBtn'), $('confSheet')));
  getJSON('conditions.json').then(c => { cond = c; if (map.hasLayer(arrowLayer)) drawArrows(); renderConf(); renderPlan(); }).catch(() => {});
  getJSON('weed.json').then(w => { weedData = w; drawWeed(w); $('weedDate').textContent = `${w.patches.length} patches · 3 days to ${w.date}`; }).catch(() => { $('weedDate').textContent = 'not available yet'; });
  getJSON('confidence.json').then(c => { confData = c; renderConf(); renderPlan(); }).catch(() => {});
  if (store.get('sil.arrows', false)) { $('curArrows').checked = true; arrowLayer.addTo(map); }
  if (store.get('sil.weed', false)) { $('weedLayer').checked = true; weedLayer.addTo(map); }
  setInterval(() => { if (map.hasLayer(arrowLayer)) drawArrows(); }, 600000);


  // ---------- Today's plan: one card that pulls the best spot, best time, sea and confidence together
  function renderPlan() {
    if (!topSpots.length) return;
    const viewReg = VIEW_REGION[store.get('sil.view', 'south')] || 'South coast';
    let reg = viewReg;
    if (last) { let bd = 1e9; for (const t of topSpots) { const d = nm(last, [t.lat, t.lon]); if (d < bd) { bd = d; reg = t.region; } } }
    const spot = topSpots.find(t => t.region === reg && t.rank === 1) || topSpots[0];
    // where
    let where;
    if (last) { const d = nm(last, [spot.lat, spot.lon]); where = d < .5 ? "you're on it" : `${d.toFixed(0)} NM ${compass(bearing(last, [spot.lat, spot.lon]))} of you`; }
    else if (BANKLIST.length) {
      let b = null, bd = 1e9; for (const x of BANKLIST) { const d = nm([x.lat, x.lon], [spot.lat, spot.lon]); if (d < bd) { bd = d; b = x; } }
      where = bd < 1 ? `at ${b.name}` : `${bd.toFixed(0)} NM ${compass(bearing([b.lat, b.lon], [spot.lat, spot.lon]))} of ${b.name}`;
    } else where = pos2txt(spot.lat, spot.lon);
    // when: the next Prime period in the next 18 hours, otherwise the next feeding period
    const now = new Date(), d0 = new Date(now); d0.setHours(0, 0, 0, 0); const d1 = new Date(d0.getTime() + 864e5);
    const ahead = [...feeding(d0).sol, ...feeding(d1).sol].filter(e => e.end > now);
    const best = ahead.find(e => e.prime && e.start - now < 18 * 36e5) || ahead[0];
    let when = '–', at = now;
    if (best) {
      at = best.start > now ? best.start : now;
      const tag = best.prime ? 'Prime ' : '', kind = best.kind === 'major' ? 'major' : 'minor';
      when = best.start <= now ? `${tag}${kind} on now until ${hm(best.end)}` : `${tag}${kind} ${best.start >= d1 ? 'tomorrow ' : ''}${hspan(best.start, best.end)}`;
    }
    // sea at that time
    let seaTxt = '';
    if (cond) {
      const p = cond.points.find(x => x.kind === 'spot' && x.name === `${spot.region} spot ${spot.rank}`) || nearestCond(spot.lat, spot.lon);
      const k = Math.floor((at - Date.parse(cond.start_utc)) / 36e5);
      if (p && k >= 0 && k < 36) {
        const bits = [];
        if (p.wave[k] != null) bits.push(`Seas ${p.wave[k].toFixed(1)} m`);
        if (p.wind[k] != null) bits.push(`wind ${p.wind[k]} kn ${compass(p.wdir[k])}`);
        if (p.cur[k] != null) bits.push(`current running ${compass(p.cdir[k])}`);
        seaTxt = bits.join(', ');
      }
    }
    const c = confData && confData[spot.region];
    const el = $('plan'); el.hidden = false;
    el.innerHTML = `<span class="k">Today's plan</span><b>${esc(spot.region)} spot ${spot.rank}</b>, ${esc(where)} · <b>${esc(when)}</b>` +
      (seaTxt ? ` · ${esc(seaTxt)}` : '') + (c ? ` · <span class="conf ${c.level}">Picture: ${c.level}</span>` : '');
    el.onclick = () => { map.setView([spot.lat, spot.lon], Math.max(map.getZoom(), 12)); const m = topMarkers[`${spot.region}|${spot.rank}`]; if (m) m.openPopup(); };
  }
  setInterval(renderPlan, 300000);

  // ---------- sheets / tiles
  function sheet(btn, el) { const open = el.hidden; document.querySelectorAll('.sheet').forEach(s => s.hidden = true);
    document.querySelectorAll('[aria-expanded]').forEach(b => b.setAttribute('aria-expanded', 'false')); el.hidden = !open; btn.setAttribute('aria-expanded', open); }
  $('moreBtn').addEventListener('click', () => sheet($('moreBtn'), $('more')));
  $('infoBtn').addEventListener('click', () => sheet($('infoBtn'), $('info')));
  map.on('click', () => document.querySelectorAll('.sheet').forEach(s => s.hidden = true));
  $('tiles').addEventListener('change', e => {
    if (e.target.checked) tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 15, attribution: '© OpenStreetMap'}).addTo(map).bringToBack();
    else if (tiles) { map.removeLayer(tiles); tiles = null; }
    if (coastLayer) coastLayer.setStyle(tiles ? COAST_OVER_TILES : COAST_PLAIN);   // the detailed map shows the land itself
    store.set('sil.tiles', e.target.checked);
  });
  if (store.get('sil.tiles', false)) { $('tiles').checked = true; $('tiles').dispatchEvent(new Event('change')); }

  loadTrack(); setTimeout(sendPending, 1500); drawSightings();
  load().catch(e => { $('built').textContent = 'Could not load the grid. ' + (navigator.onLine ? 'Try again shortly.' : 'Open it once with signal.'); console.error(e); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(r => r.update()).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) $('newVer').hidden = false; });
    $('newVer').addEventListener('click', () => location.reload());
  }
})();
