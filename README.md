# Sea Intel Lab – marlin strike grid (experimental)

A test area, separate from the Sea Intelligence site. It **reads** that site's published files and never changes it.

- `scripts/build_grid.py` – builds a relative score for every ~0.6 NM square within 35 NM of any bank (whole Fishing Intelligence map area) from: drop-off (ETOPO depth, NOAA ERDDAP),
  chlorophyll fronts and zooplankton lines (traced from the published `chlorophyll-latest.png`), convergence lines (`ocean-features.geojson`),
  and logged releases (`data/releases.json`, weight halves every 14 days). Writes `grid.geojson`, `top-spots.json`, `strike-grid.kml`, `top-spots.gpx`, `meta.json`.
- `web/` – the live map: shaded grid, top spots, "Show my boat" (phone GPS), "Log release", KML/GPX downloads. Works offline once opened.
- `.github/workflows/build.yml` – runs ~35 minutes after each map run, on demand, and on every push; publishes with GitHub Pages.

To add releases, edit `data/releases.json` (date in UTC, lat, lon, species, count, note).

The score ranks conditions; it is **not** a probability or a fish forecast, and **not for navigation**.
