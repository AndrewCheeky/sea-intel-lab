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
WEIGHTS = dict(drop=.30, front=.30, release=.20, zoo=.15, conv=.05)
SIGMA_NM = dict(drop=2.0, front=2.5, release=3.0, zoo=2.5, conv=3.0)
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


def read_convergence():
    gj = json.loads(fetch(BASE + 'ocean-features.geojson'))
    lines = []
    for f in gj.get('features', []):
        p, g = f.get('properties', {}), f.get('geometry', {})
        if p.get('kind') == 'convergence' and g.get('type') == 'LineString':
            lines.append([(c[1], c[0]) for c in g['coordinates']])
    return lines, gj.get('properties', {})


def read_depth():
    """ETOPO 1-arc-minute depth from NOAA ERDDAP; returns (depth_m positive down, slope m/km) on the grid."""
    q = (f"altitude%5B({AREA['south'] - .05}):1:({AREA['north'] + .05})%5D"
         f"%5B({AREA['west'] - .05}):1:({AREA['east'] + .05})%5D")
    cache = ROOT / 'cache' / 'etopo_{west}_{east}_{south}_{north}.csv'.format(**AREA)                # depth never changes: fetch once, then reuse (kept by actions/cache)
    if cache.exists() and cache.stat().st_size > 1000:
        txt = cache.read_text()
    else:
        txt = fetch('https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.csv?' + q, timeout=90).decode()
        cache.parent.mkdir(exist_ok=True); cache.write_text(txt)
    rows = list(csv.reader(io.StringIO(txt)))[2:]
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
        except Exception as e:
            log('skipping log', r, e); continue
        k = (r['when'].strftime('%Y%m%d%H%M'), round(r['lat'], 3), round(r['lon'], 3))
        if k in seen: continue
        seen.add(k); out.append(r)
    return out


def is_strike(r): return r['count'] > 0 and r['species'] != 'No strikes here'


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
        conv, feat_props = read_convergence(); sources['convergence'] = 'ocean-features.geojson'
    except Exception as e:
        log('features unavailable:', e); conv, feat_props = [], {}; sources['convergence'] = 'unavailable'
    d_conv = dist_to_lines(conv) if conv else np.full(GLAT.shape, 999.0)
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
        log('depth unavailable, using approximate drop-off line:', e)
        s_drop = gauss(dist_to_lines([DROP_FALLBACK]), SIGMA_NM['drop']); sources['depth'] = 'approximate drop-off line (Navionics chart)'
    # releases
    logs = read_logs()
    rel = read_releases(logs)
    s_rel = np.zeros(GLAT.shape)
    d_rel = np.full(GLAT.shape, 999.0)
    for r in rel:
        d = nm_between(GLAT, GLON, r['lat'], r['lon']); d_rel = np.minimum(d_rel, d)
        s_rel = np.maximum(s_rel, r['weight'] * gauss(d, SIGMA_NM['release']))

    s = dict(drop=s_drop, front=gauss(d_front, SIGMA_NM['front']), zoo=gauss(d_zoo, SIGMA_NM['zoo']),
             conv=gauss(d_conv, SIGMA_NM['conv']), release=s_rel)
    used = {k: v for k, v in WEIGHTS.items() if not (k == 'front' and white is None) and not (k == 'zoo' and pink is None)
            and not (k == 'conv' and not conv) and not (k == 'release' and not rel)}
    tot = sum(used.values())
    score = sum(used[k] / tot * s[k] for k in used)

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
    score[binary_dilation(land, iterations=1)] = 0
    if BANKS:                                               # only the waters around the banks
        score[dist_to_points([(b['lat'], b['lon']) for b in BANKS]) > BANK_REACH_NM] = 0
    score = score / max(score.max(), 1e-6)

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
                         q10(d_conv[i, j]) if conv else -1, q10(d_rel[i, j]) if rel else -1])
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
    meta = dict(built_utc=built, area=AREA, cell_deg=CELL, weights={k: round(v / tot, 3) for k, v in used.items()},
                sources=sources, chlorophyll_date=chl_meta.get('observation_date'), zooplankton_date=chl_meta.get('zooplankton_date'),
                currents_valid_utc=feat_props.get('currents_valid_utc'), releases_used=len(rel), source_site=BASE,
                note='Relative ranking of conditions. Not a probability, not a fish forecast, not for navigation.')
    (OUT / 'grid.json').write_text(json.dumps(dict(area=AREA, cell=CELL, fields=['i', 'j', 'score', 'depth_m', 'drop', 'front_nm', 'zoo_nm', 'conv_nm', 'release_nm'],
                                                   rows=rows), separators=(',', ':')))
    (OUT / 'top-spots.json').write_text(json.dumps(top, indent=1))
    # public page: date, species and position only (notes stay in the private sheet)
    (OUT / 'releases.json').write_text(json.dumps([{'date': r['when'].strftime('%Y-%m-%dT%H:%MZ'), 'lat': round(r['lat'], 4), 'lon': round(r['lon'], 4),
                                                    'note': f"{r['species']} × {r['count']}"} for r in rel], indent=1))
    (OUT / 'meta.json').write_text(json.dumps(meta, indent=1))
    (OUT / 'coast.geojson').write_text(json.dumps(coast, separators=(',', ':')))
    if banks_raw: (OUT / 'banks.json').write_bytes(banks_raw)
    write_kml(feats, top, rel, meta); write_gpx(top, rel)
    # this build's grid, kept for the track record (scores ×1000 for every shaded square)
    ocean = int(np.count_nonzero(score > 0))
    shaded = [[int(i), int(j), int(round(float(score[i, j]) * 1000))] for i, j in zip(*np.nonzero(score >= .32))]
    (OUT / 'snapshot.json').write_text(json.dumps(dict(built_utc=built, area=AREA, cell=CELL, ocean_cells=ocean, cells=shaded), separators=(',', ':')))
    track_record(logs)
    log(f'{len(feats)} squares, top spots {[(t["lat"], t["lon"]) for t in top]}, sources {sources}')


# ---------------- track record
def track_record(logs):
    """Scores every log against the latest grid published BEFORE it (within 36 h), never a later one."""
    hist = Path(os.getenv('HISTORY_DIR', ROOT / 'history')) / 'grids'
    snaps = []
    for f in sorted(hist.glob('*.json')) if hist.exists() else []:
        try:
            d = json.loads(f.read_text()); d['t'] = parse_time(d['built_utc'])
            d['lookup'] = {(c[0], c[1]): c[2] / 1000 for c in d['cells']}; snaps.append(d)
        except Exception as e:
            log('bad snapshot', f.name, e)
    cls_of = lambda v: next((c for t, c in [(.9, 'Highest'), (.77, 'High'), (.62, 'Good'), (.47, 'Medium'), (.32, 'Low')] if v >= t), 'Not shaded')
    entries, cover_hi, cover_good = [], [], []
    for r in sorted(logs, key=lambda x: x['when']):
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
               by_region={reg: dict(scored=sum(1 for e in st if e['region'] == reg), high_plus=sum(1 for e in st if e['region'] == reg and e['score'] >= .77))
                          for reg in REGIONS})
    (OUT / 'track-record.json').write_text(json.dumps(out, indent=1))
    log('track record:', {k: out[k] for k in ('snapshots', 'strikes', 'quiet', 'area_share', 'not_scored')})


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
           '<description>Relative ranking of conditions (drop-off, chlorophyll front, past releases, zooplankton, convergence). '
           'Not a probability, not a fish forecast, not for navigation.</description>']
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
