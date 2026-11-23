/* Keeps the strike grid usable offshore: the page and the latest grid are saved when opened with signal. */
const CACHE = 'sil-v39';
const SHELL = ['./', 'index.html', 'app.js?v=37', 'app.css?v=22', 'manifest.webmanifest', 'sky.js?v=2',
  'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js'];
const DATA = ['grid.json', 'top-spots.json', 'releases.json', 'meta.json', 'coast.geojson', 'banks.json', 'strike-grid.kml', 'top-spots.gpx', 'track-record.json', 'contours.geojson', 'times.json', 'sightings.json', 'conditions.json', 'weed.json', 'confidence.json'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled([...SHELL, ...DATA].map(u => c.add(u)))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;   // other sites (map tiles, log sending): never cached
  const isData = DATA.some(d => u.pathname.endsWith('/' + d));
  if (isData || e.request.mode === 'navigate') {           // newest when there's signal, saved copy when not
    e.respondWith(fetch(e.request).then(r => { if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone())); return r; })
      .catch(() => caches.match(e.request, {ignoreSearch: true}).then(r => r || caches.match('index.html'))));
  } else {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { if (res.ok || res.type === 'opaque') caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; })));
  }
});
