import json, urllib.request, urllib.parse, time
def get(u, t=60):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'sea-intel-lab probe'}), timeout=t); b = r.read(); return r.status, b
    except Exception as e: return 'ERR', str(e).encode()
S = 'https://andrewcheeky.github.io/jamaica-marine-currents/'
for f in ['sargassum.json', 'chlorophyll.json', 'forecast.json']:
    s, b = get(S + f); print('==', f, s); print(b[:2500].decode('utf8', 'replace'))
for host, ids in [('https://cwcgom.aoml.noaa.gov/erddap', ['noaa_aoml_atlantic_oceanwatch_AFAI_1D', 'noaa_aoml_atlantic_oceanwatch_AFAI_3D', 'noaa_aoml_atlantic_oceanwatch_AFAI_7D']),
                  ('https://upwell.pfeg.noaa.gov/erddap', ['noaa_aoml_3896_1b40_b974', 'noaa_aoml_ae10_d11a_85ab', 'noaa_aoml_9406_b52e_b95b'])]:
    for i in ids:
        s, b = get(f'{host}/griddap/{i}.csv?time[last]', 60); print('==', host, i, s, b[:200])
s, b = get('https://cwcgom.aoml.noaa.gov/erddap/griddap/noaa_aoml_atlantic_oceanwatch_AFAI_3D.csv?AFAI[last][(17.3):4:(18.1)][(-77.2):4:(-76.0)]', 90)
print('== AFAI 3D subset', s, len(b)); txt = b.decode('utf8','replace').splitlines(); print(txt[:4]); 
vals = [l.split(',')[-1] for l in txt[2:]]; print('n', len(vals), 'nan', sum(v in ('NaN','') for v in vals))
B = [(17.52,-76.947),(17.75,-76.783),(17.3,-76.5),(17.87,-76.62),(18.117,-76.083),(18.5,-75.75),(18.525,-77.95),(17.416,-75.972),(17.797,-77.075)]
q = lambda d: urllib.parse.urlencode(d)
la = ','.join(str(a) for a,_ in B); lo = ','.join(str(b) for _,b in B)
s, b = get('https://api.open-meteo.com/v1/forecast?' + q({'latitude': la, 'longitude': lo, 'hourly': 'wind_speed_10m,wind_direction_10m,wind_gusts_10m', 'wind_speed_unit': 'kn', 'timezone': 'GMT', 'forecast_days': 2}))
print('== wind', s, b[:300])
s, b = get('https://marine-api.open-meteo.com/v1/marine?' + q({'latitude': la, 'longitude': lo, 'hourly': 'wave_height,wave_period,wave_direction,ocean_current_velocity,ocean_current_direction', 'timezone': 'GMT', 'forecast_days': 2, 'cell_selection': 'sea'}))
print('== marine', s, b[:300])
