"""One-off: trace Jamaica's coastline from a Fishing Intelligence map image into data/coast.geojson."""
import sys, json, numpy as np, matplotlib
matplotlib.use('Agg'); import matplotlib.pyplot as plt
from PIL import Image
from scipy.ndimage import binary_opening, binary_fill_holes, label
src = sys.argv[1]
a = np.asarray(Image.open(src).convert('RGB')).astype(int)
FX0, FY0, FX1, FY1 = 411, 156, 1668, 1161; W, E, S, N = -79.5, -74.5, 16.0, 20.0
sub = a[FY0+2:FY1-1, FX0+2:FX1-1]
R, G, B = sub[..., 0], sub[..., 1], sub[..., 2]
land = (R > 195) & (G > 205) & (B > 210) & (np.abs(R - 217) < 25) & (np.abs(B - 233) < 25)
land = binary_opening(land, iterations=1); land = binary_fill_holes(land)
lab, n = label(land); sizes = np.bincount(lab.ravel()); keep = [i for i in range(1, n + 1) if sizes[i] > 400]
land = np.isin(lab, keep)
h, w = land.shape
cs = plt.contour(np.pad(land.astype(float), 1), levels=[.5])
feats = []
for seg in cs.allsegs[0]:
    if len(seg) < 20: continue
    seg = seg[::2]
    coords = [[round(W + (x - 1 + 2) / (FX1 - FX0) * (E - W), 4), round(N - (y - 1 + 2) / (FY1 - FY0) * (N - S), 4)] for x, y in seg]
    coords.append(coords[0])
    feats.append({'type': 'Feature', 'properties': {}, 'geometry': {'type': 'Polygon', 'coordinates': [coords]}})
json.dump({'type': 'FeatureCollection', 'features': feats}, open('data/coast.geojson', 'w'))
print(len(feats), 'polygons', sum(len(f['geometry']['coordinates'][0]) for f in feats), 'points')
