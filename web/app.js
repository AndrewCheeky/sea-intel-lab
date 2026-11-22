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

  let cells = new Map(), hot = [], meta = {}, area = null;
  const key = (la, lo) => `${Math.floor((la - area.south) / meta.cell_deg)}|${Math.floor((lo - area.west) / meta.cell_deg)}`;

  async function getJSON(u) { const r = await fetch(u, {cache: 'no-cache'}); if (!r.ok) throw Error(u + ' ' + r.status); return r.json(); }

  async function load() {
    const [coast, grid, top, rel, m, banks] = await Promise.all([
      getJSON('coast.geojson'), getJSON('grid.geojson'), getJSON('top-spots.json'),
      getJSON('releases.json').catch(() => []), getJSON('meta.json'), getJSON('banks.json').catch(() => [])]);
    meta = m; area = m.area;
    const built = new Date(m.built_utc);
    $('built').textContent = `Built ${built.toLocaleString([], {weekday: 'short', hour: 'numeric', minute: '2-digit'})}` +
      (m.chlorophyll_date ? ` · chlorophyll ${m.chlorophyll_date}` : '') + (Date.now() - built > 18 * 3600e3 ? ' · may be out of date' : '');
    $('sources').textContent = 'Inputs: ' + Object.entries(m.sources || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') +
      ` · weights ${Object.entries(m.weights || {}).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ')}` + ` · ${m.releases_used} releases`;

    coastLayer = L.geoJSON(coast, {interactive: false, style: tiles ? COAST_OVER_TILES : COAST_PLAIN}).addTo(sea);
    L.geoJSON(grid, {
      style: f => ({stroke: false, fillColor: COLORS[f.properties.cls], fillOpacity: OPAC[f.properties.cls]}),
      onEachFeature: (f, layer) => {
        const p = f.properties; cells.set(key(p.lat, p.lon), p); if (p.score >= .77) hot.push(p);
        layer.on('click', () => layer.bindPopup(explain(p)).openPopup());
      }
    }).addTo(sea);
    banks.forEach(b => L.circleMarker([b.lat, b.lon], {radius: 3.5, color: '#fff', weight: 1, fillColor: '#e8475f', fillOpacity: 1, interactive: false}).addTo(sea));
    rel.forEach(r => L.marker([r.lat, r.lon], {icon: L.divIcon({className: '', html: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.9 7.1.6-5.4 4.7 1.7 7.3L12 17.8 5.7 21.5l1.7-7.3L2 9.5l7.1-.6z" fill="#00e5ff" stroke="#061b33" stroke-width="1.5"/></svg>', iconSize: [22, 22], iconAnchor: [11, 11]}),
      title: 'Release ' + r.date.slice(0, 10)}).bindPopup(`Release ${esc(r.date.slice(0, 10))}<br>${pos2txt(r.lat, r.lon)}${r.note ? '<br>' + esc(r.note) : ''}`).addTo(sea));
    top.forEach(t => L.marker([t.lat, t.lon], {icon: L.divIcon({className: 'spot', html: String(t.rank), iconSize: [26, 26]}), title: 'Top ' + t.rank, zIndexOffset: 500})
      .bindPopup(`<b>Top ${t.rank}</b><br>${pos2txt(t.lat, t.lon)}<br>Score ${t.score.toFixed(2)}`).addTo(sea));
    if (grid.features.length) map.fitBounds(L.geoJSON(grid).getBounds().pad(.05), {maxZoom: 12});
    drawMyLogs();
  }

  function explain(p) {
    const r = [];
    if (p.depth_m != null) r.push(`Depth about ${p.depth_m} m`);
    r.push(p.drop >= .6 ? 'On the drop-off' : p.drop >= .3 ? 'Near the drop-off' : 'Away from the drop-off');
    if (p.front_nm != null) r.push(`${p.front_nm} NM from a chlorophyll front`);
    if (p.release_nm != null) r.push(`${p.release_nm} NM from a past release`);
    if (p.zoo_nm != null) r.push(`${p.zoo_nm} NM from a zooplankton line`);
    if (p.conv_nm != null && p.conv_nm < 30) r.push(`${p.conv_nm} NM from convergence`);
    return `<b>${p.cls}</b> (score ${p.score.toFixed(2)})<br>${pos2txt(p.lat, p.lon)}<br><small>${r.join('<br>')}</small>`;
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
  const LOG_URL = 'https://script.google.com/macros/s/AKfycbyFY483SYd2P772OZbtMiMTD6CUUuTwLFsJBm2GLxmxmZk2uBm9oUr2N2emOf41L1_CTw/exec';
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
        (t.not_scored ? ` <span class="small">(${t.not_scored} log${t.not_scored > 1 ? 's' : ''} not counted)</span>` : '')
      : `Collecting. ${t.snapshots} grid${t.snapshots === 1 ? '' : 's'} saved so far; logs made from now on will be scored against them.` +
        (t.not_scored ? ` ${t.not_scored} earlier log${t.not_scored > 1 ? 's' : ''} not counted.` : '');
    $('trackList').innerHTML = t.entries.slice(-12).reverse().map(e =>
      `<li>${esc(new Date(e.date).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}))} · ${esc(e.species)} × ${e.count} · ` +
      (e.scored ? `<b>${esc(e.cls)}</b> (${e.score.toFixed(2)})` : 'not counted') + '</li>').join('');
  }
  $('trackBtn').addEventListener('click', () => { sheet($('trackBtn'), $('track')); loadTrack(); });

  $('sendLogs').addEventListener('click', async () => {
    const logs = store.get(LOGS, []); if (!logs.length) return toast('No releases logged yet');
    const text = 'Strike grid logs\n' + logs.map(l => `${l.time} | ${l.species} x${l.count} | ${l.lat}, ${l.lon}${l.exact ? '' : ' (map centre)'}${l.note ? ' | ' + l.note : ''}`).join('\n');
    try { if (navigator.share) { await navigator.share({title: 'Strike grid logs', text}); return; } } catch (e) { if (e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast('Copied – paste it in a message'); } catch { prompt('Copy your logs:', text); }
  });

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

  loadTrack(); setTimeout(sendPending, 1500);
  load().catch(e => { $('built').textContent = 'Could not load the grid. ' + (navigator.onLine ? 'Try again shortly.' : 'Open it once with signal.'); console.error(e); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
