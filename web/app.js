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

  let cells = new Map(), hot = [], meta = {}, area = null, cellDeg = .01;
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
    banks.forEach(b => L.circleMarker([b.lat, b.lon], {radius: 3.5, color: '#fff', weight: 1, fillColor: '#e8475f', fillOpacity: 1, interactive: false}).addTo(sea));
    rel.forEach(r => L.marker([r.lat, r.lon], {icon: L.divIcon({className: '', html: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.9 7.1.6-5.4 4.7 1.7 7.3L12 17.8 5.7 21.5l1.7-7.3L2 9.5l7.1-.6z" fill="#00e5ff" stroke="#061b33" stroke-width="1.5"/></svg>', iconSize: [22, 22], iconAnchor: [11, 11]}),
      title: 'Release ' + r.date.slice(0, 10)}).bindPopup(`Release ${esc(r.date.slice(0, 10))}<br>${pos2txt(r.lat, r.lon)}${r.note ? '<br>' + esc(r.note) : ''}`).addTo(sea));
    top.forEach(t => L.marker([t.lat, t.lon], {icon: L.divIcon({className: 'spot', html: String(t.rank), iconSize: [26, 26]}), title: `${t.region || ''} top ${t.rank}`, zIndexOffset: 500})
      .bindPopup(`<b>${esc(t.region || '')} · spot ${t.rank}</b><br>${pos2txt(t.lat, t.lon)}`).addTo(sea));
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
    $('here').textContent = c ? `${c.cls} (${c.score.toFixed(2)})` : 'Not shaded';
    let best = null, bd = 1e9;
    for (const h of hot) { const d = nm(here, [h.lat, h.lon]); if (d < bd) { bd = d; best = h; } }
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

  $('areaSel').addEventListener('change', e => { store.set('sil.view', e.target.value); renderTimes(); follow = false; $('followBtn').setAttribute('aria-pressed', false); map.fitBounds(VIEWS[e.target.value]); });

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

  // ---------- best times strip: dawn/dusk (phone), tide and current turns (from the build), moon (phone, for information)
  const POINTS = {south: [17.70, -76.88], east: [17.85, -76.15], north: [18.55, -77.60], all: [17.70, -76.88]};
  let timesData = null, tomorrow = false;
  const hm = d => d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  function nearestPoint() {
    if (last) { let best = 'south', bd = 1e9; for (const k of ['south', 'east', 'north']) { const d = nm(last, POINTS[k]); if (d < bd) { bd = d; best = k; } } return best; }
    const v = store.get('sil.view', 'south'); return v === 'all' ? 'south' : v;
  }
  function renderTimes() {
    const now = new Date(), day = new Date(now); day.setHours(0, 0, 0, 0); if (tomorrow) day.setDate(day.getDate() + 1);
    const end = new Date(day.getTime() + 864e5), mid = new Date(day.getTime() + 432e5);
    const pk = nearestPoint(), [la, lo] = last || POINTS[pk];
    const sun = Sky.sunTimes(mid, la, lo);
    const win = [
      {start: sun.dawn, end: new Date(sun.sunrise.getTime() + 36e5), label: `Dawn ${hm(sun.dawn)}–${hm(new Date(sun.sunrise.getTime() + 36e5))}`, why: 'First light to an hour after sunrise: fish often feed near the surface.'},
      {start: new Date(sun.sunset.getTime() - 36e5), end: sun.dusk, label: `Dusk ${hm(new Date(sun.sunset.getTime() - 36e5))}–${hm(sun.dusk)}`, why: 'The last hour of sun to last light: another strong feeding time.'}];
    const items = win.map(w => ({...w, kind: 'light'}));
    const P = timesData && timesData.points && timesData.points[pk];
    if (P) {
      for (const t of P.tides) { const d = new Date(t.time); if (d >= day && d < end) items.push({start: new Date(d - 27e5), end: new Date(+d + 27e5), at: d, kind: 'tide', label: `Tide ${t.type} ${hm(d)}`, why: `The tide turns (${t.type}). Bait often moves when water starts to move again.`}); }
      for (const t of P.current) { const d = new Date(t.time); if (d >= day && d < end) items.push({start: new Date(d - 27e5), end: new Date(+d + 27e5), at: d, kind: 'current', label: `Current ${t.type === 'slack' ? 'slack' : 'turns'} ${hm(d)}`, why: 'The current eases or changes direction. Strikes often come as it picks up again.'}); }
    }
    for (const it of items) if (it.kind !== 'light') it.prime = win.some(w => it.at >= w.start && it.at <= w.end);
    const md = Sky.moonDay(day, la, lo), il = Sky.moonIllum(mid);
    const info = [];
    if (md.overhead && md.overhead >= day && md.overhead < end) info.push({at: md.overhead, label: `Moon overhead ${hm(md.overhead)}`});
    if (md.underfoot && md.underfoot >= day && md.underfoot < end) info.push({at: md.underfoot, label: `Moon underfoot ${hm(md.underfoot)}`});
    items.sort((a, b) => a.start - b.start);
    $('chips').innerHTML = items.map((it, k) => {
      const cls = ['chip', it.prime ? 'prime' : '', now >= it.start && now <= it.end ? 'now' : '', it.end < now ? 'past' : ''].join(' ');
      return `<button class="${cls}" data-k="${k}" title="${esc(it.why)}">${it.prime ? 'Prime · ' : ''}${esc(it.label)}</button>`;
    }).join('') + info.map(i => `<span class="chip info" title="Moon times, for information">${esc(i.label)}</span>`).join('');
    $('chips').querySelectorAll('button.chip').forEach(b => b.addEventListener('click', () => toast(items[+b.dataset.k].why)));
    $('moonLine').textContent = `${Sky.phaseName(il.phase)}, ${Math.round(il.fraction * 100)}% lit`;
  }
  function setDay(t) { tomorrow = t; $('tToday').setAttribute('aria-pressed', !t); $('tTomorrow').setAttribute('aria-pressed', t); renderTimes(); }
  $('tToday').addEventListener('click', () => setDay(false)); $('tTomorrow').addEventListener('click', () => setDay(true));
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
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
