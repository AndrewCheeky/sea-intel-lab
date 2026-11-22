"""Sea Intel Lab – marlin strike score grid (experimental).

Reads the LIVE Sea Intelligence site's published files (never changes that site), adds depth and logged
releases, and writes a relative score for every ~0.6 NM square south of Kingston:

  site/grid.json         shaded squares (compact rows: i, j, score, reasons)
  site/top-spots.json    best squares, at least 2 NM apart
  site/strike-grid.kml   for Google Earth / Google My Maps
  site/top-spots.gpx     waypoints for Navionics and chartplotters
  site/meta.json         when it was built and from what

The score is a RELATIVE ranking of conditions, not a probability and not a fish forecast.
"""
import io, json, math, os, sys, time, urllib.request, urllib.parse, csv
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'site'
DATA = ROOT / 'data'
BASE = os.getenv('SOURCE_SITE', 'https://andrewcheeky.github.io/jamaica-marine-currents/').rstrip('/') + '/'

# Area scored (south coast around Kingston); cell size in degrees (~0.6 NM)
AREA = dict(west=-79.50, east=-74.50, south=16.00, north=20.00)   # same area as the Fishing Intelligence map
CELL = 0.01
WEIGHTS = dict(drop=.27, front=.27, release=.18, zoo=.12, temp=.12, conv=.04)
SIGMA_NM = dict(drop=2.0, front=2.5, release=3.0, zoo=2.5, conv=3.0, temp=3.0)
ALIGN_BONUS = .06      # a temperature break lining up with the drop-off or the colour change
COOL_BONUS = .04       # the cooler side of a break (water a little cooler than around it)
COMFORT_C = (23.0, 30.5)   # outside this, scores are lowered
SIGHT_BONUS = .12          # birds / bait / weed seen recently (fades quickly)
SIGHT_HALF_LIFE_H = 6
SIGHTINGS = ('Birds working', 'Bait (surface)', 'Bait (sounder)', 'Fish busting', 'Weedline', 'Debris / log')
# Reference spots for the "best times" strip (tides and current turns)
TIME_POINTS = {'south': (17.70, -76.88), 'east': (17.85, -76.15), 'north': (18.55, -77.60)}
COS = math.cos(math.radians(17.7))
# Map image layout of chlorophyll-latest.png (fixed by the source site's composite.py)
MAP_EXTENT = (-79.5, -74.5, 16.0, 20.0)
# Fallback drop-off axis (middle of the slope), estimated from a Navionics chart, if depth data can't be fetched
DROP_FALLBACK = [(17.85, -76.64), (17.84, -76.72), (17.83, -76.80), (17.80, -76.83), (17.767, -76.864),
                 (17.708, -76.895), (17.669, -76.916), (17.618, -76.942), (17.55, -76.97)]


def log(*a): print('[grid]', *a, flush=True)


def fetch(url, timeout=60, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'sea-intel-lab (GitHub Actions)'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            last = e; log(f'fetch failed ({i + 1}/{tries}) {url}: {e}'); time.sleep(5 * (i + 1))
    raise last


# ---------------- grid helpers
glat = np.round(np.arange(AREA['south'] + CELL / 2, AREA['north'], CELL), 5)
glon = np.round(np.arange(AREA['west'] + CELL / 2, AREA['east'], CELL), 5)
GLON, GLAT = np.meshgrid(glon, glat)


def nm_between(lat1, lon1, lat2, lon2):
    return np.hypot((lat1 - lat2) * 60, (lon1 - lon2) * 60 * COS)


def dist_to_points(P):
    """Distance (NM) from every square to the nearest of the points (lat, lon)."""
    from scipy.spatial import cKDTree
    if P is None or not len(P): return np.full(GLAT.shape, 999.0)
    P = np.asarray(P, float)
    tree = cKDTree(np.c_[P[:, 0] * 60, P[:, 1] * 60 * COS])
    d, _ = tree.query(np.c_[GLAT.ravel() * 60, GLON.ravel() * 60 * COS], distance_upper_bound=60)
    return np.minimum(d, 999.0).reshape(GLAT.shape)


def dist_to_lines(lines):
    """Distance (NM) to the nearest line, by densifying the lines into points ~0.2 NM apart."""
    pts = []
    for L in lines:
        L = np.asarray(L, float)
        for (a1, o1), (a2, o2) in zip(L[:-1], L[1:]):
            n = max(2, int(math.ceil(nm_between(a1, o1, a2, o2) / .2)) + 1)
            pts.append(np.c_[np.linspace(a1, a2, n), np.linspace(o1, o2, n)])
    return dist_to_points(np.vstack(pts)) if pts else np.full(GLAT.shape, 999.0)


gauss = lambda d, s: np.exp(-(d / s) ** 2)


# ---------------- inputs
def read_map_layers():
    """Chlorophyll fronts (white) and zooplankton lines (pink) traced from the source site's map image."""
    png = fetch(BASE + 'chlorophyll-latest.png')
    a = np.asarray(Image.open(io.BytesIO(png)).convert('RGB')).astype(int)
    bg = a[5, 5]
    row = a[a.shape[0] // 2]; col = a[:, int(a.shape[1] * .55)]
    xs = np.where(np.abs(row - bg).sum(1) > 40)[0]; ys = np.where(np.abs(col - bg).sum(1) > 40)[0]
    fx0, fx1 = xs[0], xs[-1]
    ys = ys[(ys > a.shape[0] * .08) & (ys < a.shape[0] * .93)]
    fy0, fy1 = ys[0], ys[-1]
    W, E, S, N = MAP_EXTENT
    if abs((fx1 - fx0) / (fy1 - fy0) - (E - W) / (N - S)) > .02:
        raise ValueError(f'unexpected map frame {fx0},{fy0}-{fx1},{fy1}')
    sub = a[fy0 + 2:fy1 - 1, fx0 + 2:fx1 - 1]
    R, G, B = sub[..., 0], sub[..., 1], sub[..., 2]
    # label text = white glyphs with a near-black outline; drop white pixels next to near-black ones
    dark = (R + G + B) < 110
    from scipy.ndimage import binary_dilation
    near_dark = binary_dilation(dark, iterations=3)
    white = (R > 235) & (G > 235) & (B > 235) & ~near_dark
    pink = (R > 190) & (G > 80) & (G < 160) & (B > 210) & ~near_dark

    def to_ll(mask):
        yy, xx = np.nonzero(mask)
        lat = N - (yy + 2) / (fy1 - fy0) * (N - S); lon = W + (xx + 2) / (fx1 - fx0) * (E - W)
        return np.c_[lat, lon]
    return to_ll(white), to_ll(pink)


def read_feature_lines():
    """Current lines and temperature breaks published by the source site (ocean-features.geojson)."""
    gj = json.loads(fetch(BASE + 'ocean-features.geojson'))
    out = {'convergence': [], 'sst_front': []}
    for f in gj.get('features', []):
        p, g = f.get('properties', {}), f.get('geometry', {})
        if p.get('kind') in out and g.get('type') == 'LineString':
            out[p['kind']].append([(c[1], c[0]) for c in g['coordinates']])
    return out, gj.get('properties', {})


def read_sst():
    """Sea surface temperature now (Open-Meteo marine), on a 0.1° grid near the banks, smoothed onto the score grid.
    Returns (sst °C, anomaly °C = this square minus its surroundings; negative = cooler water)."""
    from scipy.ndimage import gaussian_filter, distance_transform_edt
    from scipy.interpolate import RegularGridInterpolator
    clat = np.round(np.arange(AREA['south'], AREA['north'] + .001, .1), 2); clon = np.round(np.arange(AREA['west'], AREA['east'] + .001, .1), 2)
    CL, CO = np.meshgrid(clat, clon, indexing='ij')
    want = np.ones(CL.shape, bool)
    if BANKS:
        want = np.zeros(CL.shape, bool)
        for b in BANKS: want |= nm_between(CL, CO, b['lat'], b['lon']) < BANK_REACH_NM + 8
    idx = np.argwhere(want)
    vals = np.full(CL.shape, np.nan)
    hour = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:00')
    for k in range(0, len(idx), 150):
        chunk = idx[k:k + 150]
        q = urllib.parse.urlencode({'latitude': ','.join(f'{CL[i, j]:.2f}' for i, j in chunk), 'longitude': ','.join(f'{CO[i, j]:.2f}' for i, j in chunk),
                                    'hourly': 'sea_surface_temperature', 'timezone': 'GMT', 'forecast_days': 1, 'cell_selection': 'sea'})
        res = json.loads(fetch('https://marine-api.open-meteo.com/v1/marine?' + q, timeout=90))
        res = res if isinstance(res, list) else [res]
        for (i, j), r in zip(chunk, res):
            h = r.get('hourly', {}); t = h.get('time', []); v = h.get('sea_surface_temperature', [])
            if not t: continue
            n = t.index(hour) if hour in t else min(len(v) - 1, int(datetime.now(timezone.utc).hour))
            if v and v[n] is not None: vals[i, j] = float(v[n])
    if np.isnan(vals).all(): raise ValueError('no sea temperature returned')
    holes = np.isnan(vals)                               # fill gaps (land, far water) with the nearest value
    _, (ii, jj) = distance_transform_edt(holes, return_indices=True); filled = vals[ii, jj]
    fine = RegularGridInterpolator((clat, clon), filled, bounds_error=False, fill_value=None)(np.c_[GLAT.ravel(), GLON.ravel()]).reshape(GLAT.shape)
    anomaly = fine - gaussian_filter(fine, 20)           # vs the water ~12 NM around
    return fine, anomaly


def read_depth():
    """ETOPO 1-arc-minute depth from NOAA ERDDAP; returns (depth_m positive down, slope m/km) on the grid."""
    q = (f"altitude%5B({AREA['south'] - .05}):1:({AREA['north'] + .05})%5D"
         f"%5B({AREA['west'] - .05}):1:({AREA['east'] + .05})%5D")
    cache = ROOT / 'cache' / 'etopo_{west}_{east}_{south}_{north}.csv'.format(**AREA)                # depth never changes: fetch once, then reuse (kept by actions/cache)
    if cache.exists() and cache.stat().st_size > 1000:
        txt = cache.read_text()
    else:
        # NOAA ERDDAP sometimes refuses large or repeated requests: ask in 1° bands, trying two mirrors.
        parts = []
        lat0 = AREA['south'] - .05
        while lat0 < AREA['north'] + .05:
            lat1 = min(lat0 + 1, AREA['north'] + .05)
            qq = (f"altitude%5B({lat0:.2f}):1:({lat1:.2f})%5D%5B({AREA['west'] - .05}):1:({AREA['east'] + .05})%5D")
            for host in ('coastwatch.pfeg.noaa.gov', 'upwell.pfeg.noaa.gov'):
                try:
                    t = fetch(f'https://{host}/erddap/griddap/etopo180.csv?' + qq, timeout=90, tries=1).decode(); break
                except Exception as e:
                    t = None; last = e
            if t is None: raise last
            parts.append(t if not parts else '\n'.join(t.splitlines()[2:]))
            lat0 = lat1
        txt = '\n'.join(parts)
        cache.parent.mkdir(exist_ok=True); cache.write_text(txt)
    rows = [r for r in csv.reader(io.StringIO(txt)) if len(r) >= 3]
    rows = [r for r in rows if r[0] not in ("latitude", "degrees_north")]   # band headers
    lat = np.array(sorted({float(r[0]) for r in rows})); lon = np.array(sorted({float(r[1]) for r in rows}))
    z = np.full((len(lat), len(lon)), np.nan)
    li = {v: i for i, v in enumerate(lat)}; lj = {v: j for j, v in enumerate(lon)}
    for r in rows: z[li[float(r[0])], lj[float(r[1])]] = float(r[2])
    depth = -z
    dy = np.gradient(lat) * 111.2; dx = np.gradient(lon) * 111.2 * COS
    gy = np.gradient(depth, axis=0) / dy[:, None]; gx = np.gradient(depth, axis=1) / dx[None, :]
    slope = np.hypot(gx, gy)
    ii = np.clip(np.searchsorted(lat, GLAT), 1, len(lat) - 1); jj = np.clip(np.searchsorted(lon, GLON), 1, len(lon) - 1)
    return depth[ii, jj], slope[ii, jj]


# Regions for top spots and the track record: a square belongs to the region of its nearest bank
REGIONS = ['South coast', 'East & north-east', 'North & west']
BANK_REACH_NM = 35          # squares further than this from every bank are not scored
BANKS = []


def bank_region(b):
    if b['lon'] >= -76.3: return 'East & north-east'
    if b['lat'] < 17.98 and b['lon'] > -77.7: return 'South coast'
    return 'North & west'


def region_of(lat, lon):
    if not BANKS: return REGIONS[0]
    return bank_region(min(BANKS, key=lambda b: nm_between(lat, lon, b['lat'], b['lon'])))


def parse_time(v):
    t = datetime.fromisoformat(str(v).replace('Z', '+00:00'))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def read_logs():
    """All logs: data/releases.json plus the live map's logs from the Apps Script sheet (if configured)."""
    f = DATA / 'releases.json'
    logs = [dict(r, source='file') for r in (json.loads(f.read_text()) if f.exists() else [])]
    url, key = os.getenv('STRIKELOG_URL', '').strip(), os.getenv('STRIKELOG_KEY', '').strip()
    if url and key:
        try:
            j = json.loads(fetch(url + ('&' if '?' in url else '?') + urllib.parse.urlencode({'action': 'strikelogs', 'key': key})))
            if j.get('ok'): logs += [dict(r, source='app') for r in j.get('logs', [])]
            else: log('strike logs refused:', j.get('error'))
        except Exception as e:
            log('strike logs unavailable:', e)
    out, seen = [], set()
    for r in logs:
        try:
            r['when'] = parse_time(r['date']); r['lat'] = float(r['lat']); r['lon'] = float(r['lon'])
            r['count'] = int(r.get('count', 1)); r['species'] = r.get('species', 'Other')
            note = str(r.get('note') or '')
            if note.startswith('[seen] ') and note[7:] in SIGHTINGS: r['species'] = note[7:]   # sightings sent to an older sheet script
        except Exception as e:
            log('skipping log', r, e); continue
        k = (r['when'].strftime('%Y%m%d%H%M'), round(r['lat'], 3), round(r['lon'], 3))
        if k in seen: continue
        seen.add(k); out.append(r)
    return out


def is_sighting(r): return r['species'] in SIGHTINGS


def is_strike(r): return r['count'] > 0 and r['species'] != 'No strikes here' and not is_sighting(r)


NE_DEPTHS = (('ne_10m_bathymetry_K_200', 200), ('ne_10m_bathymetry_J_1000', 1000), ('ne_10m_bathymetry_I_2000', 2000))


def read_depth_lines():
    """Natural Earth 10m bathymetry depth lines (200, 1000, 2000 m) inside the area, as [[lat, lon], ...] lines (cached)."""
    cache = ROOT / 'cache' / 'ne_lines_{west}_{east}_{south}_{north}.json'.format(**AREA)
    if cache.exists(): return json.loads(cache.read_text())
    out = {}
    inside = lambda x, y: AREA['west'] - .3 < x < AREA['east'] + .3 and AREA['south'] - .3 < y < AREA['north'] + .3
    for name, depth in NE_DEPTHS:
        gj = json.loads(fetch(f'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/{name}.geojson', timeout=180))
        lines = []
        for f in gj['features']:
            g = f['geometry']; polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
            for poly in polys:
                for ring in poly:
                    cur = []
                    for x, y in ring:
                        if inside(x, y): cur.append([round(y, 4), round(x, 4)])
                        elif cur:
                            if len(cur) > 1: lines.append(cur)
                            cur = []
                    if len(cur) > 1: lines.append(cur)
        out[str(depth)] = lines
    cache.parent.mkdir(exist_ok=True); cache.write_text(json.dumps(out, separators=(',', ':')))
    return out


def read_depth_contours():
    """Points along the 200 m and 1000 m lines, for the drop-off score."""
    L = read_depth_lines()
    return {k: [p for line in L[k] for p in line] for k in ('200', '1000')}


def contours_geojson(depth=None):
    """Depth lines for the map's on/off switch: from ETOPO when available (100–2000 m), else Natural Earth."""
    feats = []
    if depth is not None:
        import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
        levels = [100, 200, 500, 1000, 2000]
        cs = plt.contour(GLON, GLAT, np.nan_to_num(depth, nan=-1), levels=levels)
        for lev, segs in zip(levels, cs.allsegs):
            for seg in segs:
                if len(seg) < 4: continue
                feats.append({'type': 'Feature', 'properties': {'depth_m': lev},
                              'geometry': {'type': 'LineString', 'coordinates': [[round(float(x), 4), round(float(y), 4)] for x, y in seg[::2]]}})
        plt.close('all'); src = 'ETOPO 1 arc-minute'
    else:
        for k, lines in read_depth_lines().items():
            for line in lines:
                feats.append({'type': 'Feature', 'properties': {'depth_m': int(k)},
                              'geometry': {'type': 'LineString', 'coordinates': [[p[1], p[0]] for p in line[::2] + line[-1:]]}})
        src = 'Natural Earth 10m (generalised)'
    return {'type': 'FeatureCollection', 'properties': {'source': src}, 'features': feats}


def read_releases(logs):
    now = datetime.now(timezone.utc)
    out = []
    for r in [x for x in logs if is_strike(x)]:
        try:
            age = (now - r['when']).days
            if age > 60: continue
            out.append(dict(r, weight=0.5 ** (age / 14)))          # half the weight every 14 days
        except Exception as e:
            log('skipping release', r, e)
    return out


# ---------------- build
def main():
    OUT.mkdir(parents=True, exist_ok=True)
    reasons, sources = {}, {}
    global BANKS
    try:
        banks_raw = fetch(BASE + 'banks.json'); BANKS = [b for b in json.loads(banks_raw) if 'lat' in b and 'lon' in b]
    except Exception as e:
        log('banks unavailable:', e); banks_raw = None
    # chlorophyll front + zooplankton
    try:
        white, pink = read_map_layers(); sources['chlorophyll'] = 'traced from chlorophyll-latest.png'
    except Exception as e:
        log('map image unavailable:', e); white, pink = None, None; sources['chlorophyll'] = f'unavailable ({e})'[:120]
    d_front, d_zoo = dist_to_points(white), dist_to_points(pink)
    # convergence
    try:
        lines, feat_props = read_feature_lines(); conv, breaks = lines['convergence'], lines['sst_front']
        sources['convergence'] = f'{len(conv)} lines'; sources['temperature breaks'] = f'{len(breaks)} lines'
    except Exception as e:
        log('features unavailable:', e); conv, breaks, feat_props = [], [], {}; sources['convergence'] = 'unavailable'
    d_conv = dist_to_lines(conv) if conv else np.full(GLAT.shape, 999.0)
    d_temp = dist_to_lines(breaks) if breaks else np.full(GLAT.shape, 999.0)
    try:
        sst, sst_anom = read_sst(); sources['sea temperature'] = 'Open-Meteo marine'
    except Exception as e:
        log('sea temperature unavailable:', e); sst = sst_anom = None
    # depth / drop-off
    depth = None
    try:
        depth, slope = read_depth()
        steep = np.clip(slope / max(np.nanpercentile(slope, 92), 1e-6), 0, 1)
        window = ((depth > 40) & (depth < 2200)).astype(float)
        s_drop = np.nan_to_num(steep * window)
        from scipy.ndimage import gaussian_filter
        s_drop = gaussian_filter(s_drop, 1.2); s_drop /= max(s_drop.max(), 1e-6)
        sources['depth'] = 'ETOPO 1 arc-minute (NOAA ERDDAP)'
    except Exception as e:
        log('ETOPO depth unavailable:', e)
        try:
            c = read_depth_contours()
            d200, d1000 = dist_to_points(c['200']), dist_to_points(c['1000'])
            s_drop = .5 * gauss(d200, 2.0) + .5 * gauss(d1000, 2.5)        # the shelf edge and the steep slope below it
            s_drop /= max(s_drop.max(), 1e-6)
            sources['depth'] = 'Natural Earth 200 m / 1000 m depth lines'
        except Exception as e2:
            log('depth lines unavailable, using approximate drop-off line:', e2)
            s_drop = gauss(dist_to_lines([DROP_FALLBACK]), SIGMA_NM['drop']); sources['depth'] = 'approximate drop-off line (Navionics chart, south coast only)'
    # releases
    logs = read_logs()
    rel = read_releases(logs)
    s_rel = np.zeros(GLAT.shape)
    d_rel = np.full(GLAT.shape, 999.0)
    for r in rel:
        d = nm_between(GLAT, GLON, r['lat'], r['lon']); d_rel = np.minimum(d_rel, d)
        s_rel = np.maximum(s_rel, r['weight'] * gauss(d, SIGMA_NM['release']))

    # birds / bait / weed seen in the last 18 hours: a short-lived lift around each sighting
    now = datetime.now(timezone.utc)
    sightings = [r for r in logs if is_sighting(r) and 0 <= (now - r['when']).total_seconds() < 18 * 3600]
    s_sight = np.zeros(GLAT.shape); d_sight = np.full(GLAT.shape, 999.0)
    for r in sightings:
        d = nm_between(GLAT, GLON, r['lat'], r['lon']); d_sight = np.minimum(d_sight, d)
        s_sight = np.maximum(s_sight, 0.5 ** ((now - r['when']).total_seconds() / 3600 / SIGHT_HALF_LIFE_H) * gauss(d, 2.0))

    s = dict(drop=s_drop, front=gauss(d_front, SIGMA_NM['front']), zoo=gauss(d_zoo, SIGMA_NM['zoo']),
             conv=gauss(d_conv, SIGMA_NM['conv']), release=s_rel, temp=gauss(d_temp, SIGMA_NM['temp']))
    used = {k: v for k, v in WEIGHTS.items() if not (k == 'front' and white is None) and not (k == 'zoo' and pink is None)
            and not (k == 'conv' and not conv) and not (k == 'release' and not rel) and not (k == 'temp' and not breaks)}
    tot = sum(used.values())
    score = sum(used[k] / tot * s[k] for k in used)
    # Side-by-side comparison: the same score WITHOUT sea temperature, kept only for the track record
    used_alt = {k: v for k, v in used.items() if k != 'temp'}
    alt = sum(used_alt[k] / sum(used_alt.values()) * s[k] for k in used_alt)
    score = score + SIGHT_BONUS * s_sight; alt = alt + SIGHT_BONUS * s_sight
    if breaks:                                              # break lining up with the drop-off or the colour change
        score = score + ALIGN_BONUS * s['temp'] * np.maximum(s['drop'], s['front'])
    cool = np.zeros(GLAT.shape)
    if sst_anom is not None:                                # cooler side of a break, within comfortable water
        cool = np.clip(-sst_anom / .4, 0, 1) * np.maximum(s['temp'], .35 * s['front'])
        score = score + COOL_BONUS * cool
        lo, hi = COMFORT_C
        score = score * np.where((sst < lo) | (sst > hi), .7, 1.0)

    # no score on land or within 0.5 NM of it
    land = np.zeros(GLAT.shape, bool)
    coast = coast_geojson()
    from matplotlib.path import Path as MPath
    flat = np.c_[GLON.ravel(), GLAT.ravel()]
    for f in coast['features']:
        for ring in polygon_rings(f['geometry']):
            land |= MPath(np.asarray(ring)).contains_points(flat).reshape(GLAT.shape)
    if depth is not None: land |= depth < 3
    from scipy.ndimage import binary_dilation
    mask = binary_dilation(land, iterations=1)
    if BANKS:                                               # only the waters around the banks
        mask |= dist_to_points([(b['lat'], b['lon']) for b in BANKS]) > BANK_REACH_NM
    score[mask] = 0; alt[mask] = 0
    score = score / max(score.max(), 1e-6); alt = alt / max(alt.max(), 1e-6)

    classes = [(.9, 'Highest'), (.77, 'High'), (.62, 'Good'), (.47, 'Medium'), (.32, 'Low')]
    feats = []
    rows = []            # compact for the phone: [i, j, score×1000, depth m, drop×100, front NM×10, zoo NM×10, conv NM×10, release NM×10] (-1 = n/a)
    q10 = lambda d: int(min(round(float(d) * 10), 9990))
    h = CELL / 2
    for i in range(GLAT.shape[0]):
        for j in range(GLAT.shape[1]):
            v = float(score[i, j])
            if v < .32: continue
            la, lo = float(GLAT[i, j]), float(GLON[i, j])
            cls = next(c for t, c in classes if v >= t)
            why = {}
            if depth is not None: why['depth_m'] = int(round(float(depth[i, j])))
            why['drop'] = round(float(s_drop[i, j]), 2)
            if white is not None: why['front_nm'] = round(float(d_front[i, j]), 1)
            if pink is not None: why['zoo_nm'] = round(float(d_zoo[i, j]), 1)
            if conv: why['conv_nm'] = round(float(d_conv[i, j]), 1)
            if rel: why['release_nm'] = round(float(d_rel[i, j]), 1)
            rows.append([int(i), int(j), int(round(v * 1000)), int(round(float(depth[i, j]))) if depth is not None else -1, int(round(float(s_drop[i, j]) * 100)),
                         q10(d_front[i, j]) if white is not None else -1, q10(d_zoo[i, j]) if pink is not None else -1,
                         q10(d_conv[i, j]) if conv else -1, q10(d_rel[i, j]) if rel else -1,
                         q10(d_temp[i, j]) if breaks else -1, int(round(float(cool[i, j]) * 100)),
                         q10(d_sight[i, j]) if sightings else -1])
            if v < .62: continue                     # the KML keeps Good and better only (file size)
            feats.append({'type': 'Feature', 'properties': dict(score=round(v, 3), cls=cls, lat=la, lon=lo, **why),
                          'geometry': {'type': 'Polygon', 'coordinates': [[[round(lo - h, 5), round(la - h, 5)], [round(lo + h, 5), round(la - h, 5)],
                                                                            [round(lo + h, 5), round(la + h, 5)], [round(lo - h, 5), round(la + h, 5)],
                                                                            [round(lo - h, 5), round(la - h, 5)]]]}})
    # top spots: the best 3 squares in each region, at least 3 NM apart
    top, per = [], {}
    for k in np.argsort(-score, axis=None):
        i, j = np.unravel_index(k, score.shape)
        la, lo = float(GLAT[i, j]), float(GLON[i, j])
        if score[i, j] < .5: break
        if i < 2 or j < 2 or i >= score.shape[0] - 2 or j >= score.shape[1] - 2: continue   # skip the area's edges
        reg = region_of(la, lo)
        if per.get(reg, 0) >= 3: continue
        if all(nm_between(la, lo, t['lat'], t['lon']) > 3.0 for t in top):
            per[reg] = per.get(reg, 0) + 1
            top.append(dict(rank=per[reg], region=reg, lat=la, lon=lo, score=round(float(score[i, j]), 3)))
        if len(per) == len(REGIONS) and all(v >= 3 for v in per.values()): break
    top.sort(key=lambda t: (REGIONS.index(t['region']), t['rank']))

    built = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    chl_meta = {}
    try: chl_meta = json.loads(fetch(BASE + 'chlorophyll.json'))
    except Exception: pass
    # public: when it was built and how fresh the sea data is – nothing about how the score is made
    meta = dict(built_utc=built, sea_date=chl_meta.get('observation_date'), releases_used=len(rel),
                note='A guide to where to start looking, not a promise of fish. Not for navigation.')
    log('inputs used:', sources)
    (OUT / 'grid.json').write_text(json.dumps(dict(area=AREA, cell=CELL, rows=rows), separators=(',', ':')))
    (OUT / 'top-spots.json').write_text(json.dumps(top, indent=1))
    # public page: date, species and position only (notes stay in the private sheet)
    (OUT / 'releases.json').write_text(json.dumps([{'date': r['when'].strftime('%Y-%m-%dT%H:%MZ'), 'lat': round(r['lat'], 4), 'lon': round(r['lon'], 4),
                                                    'note': f"{r['species']} × {r['count']}"} for r in rel], indent=1))
    (OUT / 'meta.json').write_text(json.dumps(meta, indent=1))
    (OUT / 'coast.geojson').write_text(json.dumps(coast, separators=(',', ':')))
    if banks_raw: (OUT / 'banks.json').write_bytes(banks_raw)
    try:
        (OUT / 'contours.geojson').write_text(json.dumps(contours_geojson(depth), separators=(',', ':')))
    except Exception as e:
        log('depth lines for the map unavailable:', e)
    write_kml(feats, top, rel, meta); write_gpx(top, rel)
    (OUT / 'sightings.json').write_text(json.dumps([{'date': r['when'].strftime('%Y-%m-%dT%H:%MZ'), 'lat': round(r['lat'], 4), 'lon': round(r['lon'], 4),
                                                      'what': r['species']} for r in logs if is_sighting(r) and (now - r['when']).total_seconds() < 48 * 3600], indent=1))
    try:
        (OUT / 'times.json').write_text(json.dumps(build_times(), separators=(',', ':')))
    except Exception as e:
        log('tide / current times unavailable:', e)
    try:
        (OUT / 'conditions.json').write_text(json.dumps(read_conditions(top), separators=(',', ':')))
    except Exception as e:
        log('wind / sea / current unavailable:', e)
    try:
        (OUT / 'weed.json').write_text(json.dumps(read_weed(depth), separators=(',', ':')))
    except Exception as e:
        log('weed unavailable:', e)
    clear = {}
    try: _, clear = read_clear_sky(depth)
    except Exception as e: log('clear sky unavailable:', e)
    conf = confidence(chl_meta, clear, sst is not None, logs)
    log('confidence:', {k: v['level'] for k, v in conf.items()})
    (OUT / 'confidence.json').write_text(json.dumps(conf, indent=1))
    # this build's grid, kept for the track record (scores ×1000 for every shaded square)
    ocean = int(np.count_nonzero(score > 0))
    shaded = [[int(i), int(j), int(round(float(score[i, j]) * 1000))] for i, j in zip(*np.nonzero(score >= .32))]
    shaded_alt = [[int(i), int(j), int(round(float(alt[i, j]) * 1000))] for i, j in zip(*np.nonzero(alt >= .32))]
    (OUT / 'snapshot.json').write_text(json.dumps(dict(built_utc=built, area=AREA, cell=CELL, ocean_cells=ocean, cells=shaded,
                                                       variants={'no_temp': shaded_alt}), separators=(',', ':')))
    track_record(logs)
    log(f'{len(feats)} squares, top spots {[(t["lat"], t["lon"]) for t in top]}, sources {sources}')


# ---------------- wind, sea and current at the banks and top spots
COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']


def read_conditions(top):
    """Hourly wind (knots), waves and current for every bank and top spot, from now for 36 hours (Open-Meteo)."""
    pts = [dict(name=b['name'], kind='bank', lat=float(b['lat']), lon=float(b['lon'])) for b in BANKS if b.get('name')]
    pts += [dict(name=f"{t['region']} spot {t['rank']}", kind='spot', lat=t['lat'], lon=t['lon']) for t in top]
    if not pts: raise ValueError('no points')
    la = ','.join(f"{p['lat']:.4f}" for p in pts); lo = ','.join(f"{p['lon']:.4f}" for p in pts)
    q = lambda d: urllib.parse.urlencode(d)
    wind = json.loads(fetch('https://api.open-meteo.com/v1/forecast?' + q({'latitude': la, 'longitude': lo, 'hourly': 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
                                                                            'wind_speed_unit': 'kn', 'timezone': 'GMT', 'forecast_days': 3}), timeout=90))
    time.sleep(2)
    sea = json.loads(fetch('https://marine-api.open-meteo.com/v1/marine?' + q({'latitude': la, 'longitude': lo, 'hourly': 'wave_height,wave_period,ocean_current_velocity,ocean_current_direction',
                                                                                'timezone': 'GMT', 'forecast_days': 3, 'cell_selection': 'sea'}), timeout=90))
    wind = wind if isinstance(wind, list) else [wind]; sea = sea if isinstance(sea, list) else [sea]
    t_all = wind[0]['hourly']['time']
    start = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:00')
    k0 = t_all.index(start) if start in t_all else 0
    sl = slice(k0, k0 + 36)
    r1 = lambda v, n=1: [None if x is None else round(float(x), n) for x in v[sl]]
    r0 = lambda v: [None if x is None else int(round(float(x))) for x in v[sl]]
    for p, w, m in zip(pts, wind, sea):
        hw, hm = w.get('hourly', {}), m.get('hourly', {})
        p.update(wind=r0(hw.get('wind_speed_10m', [])), gust=r0(hw.get('wind_gusts_10m', [])), wdir=r0(hw.get('wind_direction_10m', [])),
                 wave=r1(hm.get('wave_height', [])), period=r0(hm.get('wave_period', [])),
                 cur=[None if x is None else round(float(x) / 1.852, 1) for x in (hm.get('ocean_current_velocity') or [])[sl]],   # km/h → knots
                 cdir=r0(hm.get('ocean_current_direction', [])))
    return {'built_utc': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'start_utc': t_all[k0] + 'Z', 'points': pts}


# ---------------- weed (floating algae) seen by satellite
AFAI_HOST = 'https://cwcgom.aoml.noaa.gov/erddap/griddap/'
WEED_MIN = 2.5e-4          # how far above the surrounding water a pixel must be to count as weed


def afai(dataset, stride=1):
    W, E, S, N = MAP_EXTENT
    url = f'{AFAI_HOST}{dataset}.csv?AFAI[last][({S}):{stride}:({N})][({W}):{stride}:({E})]'
    rows = [l.split(',') for l in fetch(url, timeout=180).decode().splitlines()[2:]]
    rows = [r for r in rows if len(r) >= 4]
    lat = np.array(sorted({float(r[1]) for r in rows})); lon = np.array(sorted({float(r[2]) for r in rows}))
    li = {v: k for k, v in enumerate(lat)}; oi = {v: k for k, v in enumerate(lon)}
    a = np.full((len(lat), len(lon)), np.nan)
    for r in rows:
        if r[3] not in ('', 'NaN'): a[li[float(r[1])], oi[float(r[2])]] = float(r[3])
    return rows[0][0][:10], lat, lon, a


def water_mask(lat, lon, depth, min_depth=30):
    """Open water away from reefs and shallows (bottom and surf show up like weed)."""
    from scipy.interpolate import RegularGridInterpolator
    LA, LO = np.meshgrid(lat, lon, indexing='ij')
    if depth is not None:
        d = RegularGridInterpolator((glat, glon), depth, method='nearest', bounds_error=False, fill_value=np.nan)(np.c_[LA.ravel(), LO.ravel()]).reshape(LA.shape)
        ok = d > min_depth
    else:
        ok = np.ones(LA.shape, bool)
    from matplotlib.path import Path as MPath
    flat = np.c_[LO.ravel(), LA.ravel()]; land = np.zeros(LA.shape, bool)
    for f in coast_geojson()['features']:
        for ring in polygon_rings(f['geometry']): land |= MPath(np.asarray(ring)).contains_points(flat).reshape(LA.shape)
    from scipy.ndimage import binary_dilation
    ok &= ~binary_dilation(land, iterations=2)
    if BANKS:
        near = np.zeros(LA.shape, bool)
        for b in BANKS: near |= nm_between(LA, LO, b['lat'], b['lon']) < BANK_REACH_NM + 10
        ok &= near
    return LA, LO, ok


def read_weed(depth):
    """Patches of floating algae (likely weed) from the 3-day satellite composite, as points with a size and strength."""
    from scipy.ndimage import gaussian_filter, label
    date, lat, lon, a = afai('noaa_aoml_atlantic_oceanwatch_AFAI_3D')
    LA, LO, ok = water_mask(lat, lon, depth)
    from scipy.ndimage import binary_erosion
    valid = binary_erosion(np.isfinite(a), iterations=2) & ok     # cloud edges look like weed, so stay 2 pixels clear of them
    w = gaussian_filter(valid.astype(float), 6); bg = gaussian_filter(np.where(valid, a, 0), 6) / np.maximum(w, 1e-6)
    d = np.where(valid, a - bg, np.nan)
    hit = np.nan_to_num(d) > WEED_MIN
    lab, n = label(hit, structure=np.ones((3, 3)))
    pts = []
    for k in range(1, n + 1):
        ii, jj = np.nonzero(lab == k)
        if len(ii) < 2: continue                         # single pixels are mostly noise
        pts.append(dict(lat=round(float(LA[ii, jj].mean()), 4), lon=round(float(LO[ii, jj].mean()), 4), size=int(len(ii)),
                        strength=round(float(np.nanmax(d[ii, jj]) / WEED_MIN), 1)))
    pts.sort(key=lambda p: -p['size'] * p['strength'])
    pc = {q: round(float(np.nanpercentile(d, q)), 5) for q in (50, 90, 99, 99.5, 99.9)}
    log(f'weed: {date} {int(valid.sum())} clear water pixels, {n} patches, {len(pts)} kept, spread {pc}, raw {[round(float(np.nanpercentile(a[valid], q)), 5) for q in (50, 99)]}')
    log('weed biggest:', pts[:8])
    return {'date': date, 'patches': pts[:200]}


def read_clear_sky(depth):
    """Share of open water each region's satellites could see on the latest day (the rest was cloud or glare)."""
    date, lat, lon, a = afai('noaa_aoml_atlantic_oceanwatch_AFAI_1D', stride=2)
    LA, LO, ok = water_mask(lat, lon, depth)
    out = {}
    for reg in REGIONS:
        sel = ok & (np.vectorize(region_of)(LA, LO) == reg) if BANKS else ok
        if sel.sum() < 20: continue
        out[reg] = round(float(np.isfinite(a[sel]).mean()), 2)
    log('clear sky:', date, out)
    return date, out


# ---------------- how much to trust the picture in each area
def confidence(chl_meta, clear, have_sst, logs):
    today = datetime.now(timezone.utc).date()
    try: age = (today - datetime.strptime(chl_meta['observation_date'], '%Y-%m-%d').date()).days
    except Exception: age = None
    now = datetime.now(timezone.utc)
    out = {}
    for reg in REGIONS:
        pts, why = 3, []
        if age is None: pts -= 2; why.append('Water colour data is missing')
        elif age >= 5: pts -= 2; why.append(f'Water colour data is {age} days old')
        elif age >= 3: pts -= 1; why.append(f'Water colour data is {age} days old')
        if chl_meta.get('status') == 'previous_observation': pts -= 1; why.append('The colour map was not refreshed this time')
        c = clear.get(reg)
        if c is not None:
            if c < .15: pts -= 2; why.append('Cloud hid almost all of this area from the satellites')
            elif c < .4: pts -= 1; why.append('Cloud hid much of this area from the satellites')
            else: why.append('Satellites had a clear view')
        if not have_sst: pts -= 1; why.append('Water temperature is missing this update')
        recent = [r for r in logs if region_of(r['lat'], r['lon']) == reg and 0 <= (now - r['when']).total_seconds() < 24 * 3600 and r['species'] != 'No strikes here']
        if recent: pts += 1; why.append('Boats reported fish or bait here in the last day')
        if age is not None and age < 3 and not any('missing' in w or 'Cloud' in w for w in why): why.insert(0, 'Fresh water colour data')
        out[reg] = {'level': 'Good' if pts >= 3 else 'Fair' if pts == 2 else 'Poor', 'why': why}
    return out


# ---------------- track record
def track_record(logs):
    """Scores every log against the latest grid published BEFORE it (within 36 h), never a later one."""
    hist = Path(os.getenv('HISTORY_DIR', ROOT / 'history')) / 'grids'
    snaps = []
    for f in sorted(hist.glob('*.json')) if hist.exists() else []:
        try:
            d = json.loads(f.read_text()); d['t'] = parse_time(d['built_utc'])
            d['lookup'] = {(c[0], c[1]): c[2] / 1000 for c in d['cells']}
            alt = (d.get('variants') or {}).get('no_temp')
            d['lookup_alt'] = {(c[0], c[1]): c[2] / 1000 for c in alt} if alt is not None else None
            snaps.append(d)
        except Exception as e:
            log('bad snapshot', f.name, e)
    cls_of = lambda v: next((c for t, c in [(.9, 'Highest'), (.77, 'High'), (.62, 'Good'), (.47, 'Medium'), (.32, 'Low')] if v >= t), 'Not shaded')
    entries, cover_hi, cover_good, alt_cover = [], [], [], []
    for r in sorted((x for x in logs if not is_sighting(x)), key=lambda x: x['when']):   # sightings aren't strikes or quiet spots
        before = [s for s in snaps if s['t'] < r['when'] and (r['when'] - s['t']).total_seconds() < 36 * 3600]
        e = dict(date=r['when'].strftime('%Y-%m-%dT%H:%MZ'), species=r['species'], count=r['count'], strike=is_strike(r), region=region_of(r['lat'], r['lon']))
        if not before:
            e['scored'] = False; entries.append(e); continue
        s = before[-1]; A = s['area']
        i = math.floor((r['lat'] - A['south']) / s['cell']); j = math.floor((r['lon'] - A['west']) / s['cell'])
        if not (A['south'] <= r['lat'] < A['north'] and A['west'] <= r['lon'] < A['east']):
            e['scored'] = False; e['why'] = 'outside the grid area'; entries.append(e); continue
        v = s['lookup'].get((i, j), 0.0)
        e.update(scored=True, score=round(v, 2), cls=cls_of(v), grid_built=s['built_utc'])
        if s['lookup_alt'] is not None:
            va = s['lookup_alt'].get((i, j), 0.0); e.update(score_no_temp=round(va, 2), cls_no_temp=cls_of(va))
            n = max(s['ocean_cells'], 1)
            alt_cover.append((sum(1 for x in s['lookup_alt'].values() if x >= .77) / n, sum(1 for x in s['lookup_alt'].values() if x >= .62) / n))
        n = max(s['ocean_cells'], 1)
        cover_hi.append(sum(1 for x in s['lookup'].values() if x >= .77) / n)
        cover_good.append(sum(1 for x in s['lookup'].values() if x >= .62) / n)
        entries.append(e)
    sc = [e for e in entries if e.get('scored')]
    st = [e for e in sc if e['strike']]; qu = [e for e in sc if not e['strike']]
    out = dict(updated_utc=datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), snapshots=len(snaps),
               strikes=dict(scored=len(st), high_plus=sum(e['score'] >= .77 for e in st), good_plus=sum(e['score'] >= .62 for e in st)),
               quiet=dict(scored=len(qu), below_good=sum(e['score'] < .62 for e in qu)),
               area_share=dict(high_plus=round(sum(cover_hi) / len(cover_hi), 3) if cover_hi else None,
                               good_plus=round(sum(cover_good) / len(cover_good), 3) if cover_good else None),
               not_scored=len(entries) - len(sc), entries=entries[-50:],
               comparison=compare(sc, alt_cover),
               by_region={reg: dict(scored=sum(1 for e in st if e['region'] == reg), high_plus=sum(1 for e in st if e['region'] == reg and e['score'] >= .77))
                          for reg in REGIONS})
    (OUT / 'track-record.json').write_text(json.dumps(out, indent=1))
    log('track record:', {k: out[k] for k in ('snapshots', 'strikes', 'quiet', 'area_share', 'not_scored')})


def compare(scored, alt_cover):
    """With vs without sea temperature, over logs scored by grids that kept both versions."""
    both = [e for e in scored if 'score_no_temp' in e]
    st = [e for e in both if e['strike']]; qu = [e for e in both if not e['strike']]
    avg = lambda xs: round(sum(xs) / len(xs), 3) if xs else None
    side = lambda key: dict(strikes_high_plus=sum(e[key] >= .77 for e in st), strikes_good_plus=sum(e[key] >= .62 for e in st),
                            quiet_below_good=sum(e[key] < .62 for e in qu))
    return dict(strikes=len(st), quiet=len(qu), with_temp=side('score'), without_temp=side('score_no_temp'),
                area_share_without_temp=dict(high_plus=avg([a for a, _ in alt_cover]), good_plus=avg([b for _, b in alt_cover])))


# ---------------- best times: tide turns and current turns (sun and moon are worked out on the phone)
def turning_points(times, vals, kind_hi, kind_lo):
    out = []
    for k in range(1, len(vals) - 1):
        a, b, c = vals[k - 1], vals[k], vals[k + 1]
        if None in (a, b, c): continue
        if (b > a and b >= c) or (b < a and b <= c):
            den = a - 2 * b + c
            off = 0.5 * (a - c) / den if den else 0          # refine between the hours
            t = parse_time(times[k]) + __import__('datetime').timedelta(hours=max(-.5, min(.5, off)))
            out.append({'time': t.strftime('%Y-%m-%dT%H:%MZ'), 'type': kind_hi if b > a else kind_lo})
    return out


def build_times():
    out = {}
    for name, (la, lo) in TIME_POINTS.items():
        q = urllib.parse.urlencode({'latitude': la, 'longitude': lo, 'hourly': 'sea_level_height_msl,ocean_current_velocity,ocean_current_direction',
                                    'timezone': 'GMT', 'forecast_days': 3, 'past_days': 1, 'cell_selection': 'sea'})
        h = json.loads(fetch('https://marine-api.open-meteo.com/v1/marine?' + q, timeout=60))['hourly']
        t = [x + 'Z' for x in h['time']]
        tides = turning_points(t, h.get('sea_level_height_msl') or [], 'high', 'low')
        spd = h.get('ocean_current_velocity') or []; dirs = h.get('ocean_current_direction') or []
        turns = [x for x in turning_points(t, spd, 'strongest', 'slack') if x['type'] == 'slack']
        for k in range(1, len(dirs)):                         # direction swings of 60°+ within an hour
            if dirs[k] is None or dirs[k - 1] is None: continue
            dd = abs((dirs[k] - dirs[k - 1] + 180) % 360 - 180)
            if dd >= 60: turns.append({'time': t[k], 'type': 'turn'})
        rng = [v for v in (h.get('sea_level_height_msl') or []) if v is not None]
        out[name] = {'tides': tides, 'current': sorted(turns, key=lambda x: x['time']),
                     'tide_range_m': round(max(rng) - min(rng), 2) if rng else None}
    return {'built_utc': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'points': out}


# ---------------- coast
def coast_geojson():
    cache = DATA / 'coast-ne.geojson'
    if cache.exists(): return json.loads(cache.read_text())
    try:
        ne = json.loads(fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson', timeout=120))
        bx = (AREA['west'] - 2.5, AREA['east'] + 2.5, AREA['south'] - 1.5, AREA['north'] + 1.5)
        feats = []
        for f in ne['features']:
            for ring in polygon_rings(f['geometry']):
                xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
                if max(xs) < bx[0] or min(xs) > bx[1] or max(ys) < bx[2] or min(ys) > bx[3]: continue
                feats.append({'type': 'Feature', 'properties': {}, 'geometry': {'type': 'Polygon', 'coordinates': [[[round(x, 4), round(y, 4)] for x, y in ring]]}})
        if feats:
            out = {'type': 'FeatureCollection', 'features': feats}
            return out
    except Exception as e:
        log('Natural Earth coastline unavailable, using traced coastline:', e)
    return json.loads((DATA / 'coast.geojson').read_text())


def polygon_rings(g):
    if g['type'] == 'Polygon': return [g['coordinates'][0]]
    if g['type'] == 'MultiPolygon': return [p[0] for p in g['coordinates']]
    return []


def points_in_ring(X, Y, ring):
    inside = np.zeros(X.shape, bool)
    xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
    if max(xs) < X.min() or min(xs) > X.max() or max(ys) < Y.min() or min(ys) > Y.max(): return inside
    n = len(ring)
    for k in range(n - 1):
        x1, y1 = ring[k]; x2, y2 = ring[k + 1]
        cond = ((y1 > Y) != (y2 > Y)) & (X < (x2 - x1) * (Y - y1) / ((y2 - y1) or 1e-12) + x1)
        inside ^= cond
    return inside


# ---------------- KML / GPX
def ddm(v, pos, neg):
    h = pos if v >= 0 else neg; v = abs(v)
    return f"{int(v)}°{(v % 1) * 60:04.1f}′{h}"


def write_kml(feats, top, rel, meta):
    colors = {'Highest': 'c8400080', 'High': 'b41a1ad9', 'Good': '9a1a80ff', 'Medium': '7333d9ff', 'Low': '4766f2ff'}
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
           f'<name>Marlin strike grid – built {meta["built_utc"]}</name>',
           '<description>A guide to where to start looking, not a promise of fish. Not for navigation.</description>']
    for c, col in colors.items():
        out.append(f'<Style id="{c}"><LineStyle><color>00ffffff</color><width>0</width></LineStyle><PolyStyle><color>{col}</color><outline>0</outline></PolyStyle></Style>')
    out.append('<Style id="top"><IconStyle><color>ff0000ff</color><scale>1.2</scale></IconStyle></Style>')
    out.append('<Style id="rel"><IconStyle><color>ffffe500</color><scale>1.1</scale></IconStyle></Style>')
    out.append('<Folder><name>Grid squares</name>')
    for f in feats:
        p = f['properties']; ring = ' '.join(f'{x},{y},0' for x, y in f['geometry']['coordinates'][0])
        out.append(f'<Placemark><name>{p["cls"]} ({p["score"]:.2f})</name><styleUrl>#{p["cls"]}</styleUrl>'
                   f'<Polygon><outerBoundaryIs><LinearRing><coordinates>{ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>')
    out.append('</Folder><Folder><name>Top spots</name>')
    for t in top:
        out.append(f'<Placemark><name>{t["region"]} top {t["rank"]}: {ddm(t["lat"], "N", "S")} {ddm(t["lon"], "E", "W")}</name><styleUrl>#top</styleUrl>'
                   f'<Point><coordinates>{t["lon"]},{t["lat"]},0</coordinates></Point></Placemark>')
    out.append('</Folder><Folder><name>Past releases</name>')
    for r in rel:
        out.append(f'<Placemark><name>Release {r["date"][:10]}</name><styleUrl>#rel</styleUrl><Point><coordinates>{r["lon"]},{r["lat"]},0</coordinates></Point></Placemark>')
    out.append('</Folder></Document></kml>')
    (OUT / 'strike-grid.kml').write_text('\n'.join(out))


def write_gpx(top, rel):
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="Sea Intel Lab" xmlns="http://www.topografix.com/GPX/1/1">']
    for t in top: out.append(f'<wpt lat="{t["lat"]:.4f}" lon="{t["lon"]:.4f}"><name>{''.join(w[0] for w in t["region"].replace('&', '').split()).upper()} TOP {t["rank"]}</name></wpt>')
    for r in rel: out.append(f'<wpt lat="{r["lat"]:.4f}" lon="{r["lon"]:.4f}"><name>REL {r["date"][5:10]}</name></wpt>')
    out.append('</gpx>')
    (OUT / 'top-spots.gpx').write_text('\n'.join(out))


if __name__ == '__main__':
    main()
