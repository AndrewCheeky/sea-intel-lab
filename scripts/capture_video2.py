"""What's-new walkthrough of the lab: phone-size screenshots + manifest for the video (temporary)."""
import asyncio, functools, http.server, json, os, sys, threading
from datetime import datetime, timedelta, timezone
from playwright.async_api import async_playwright

ROOT = sys.argv[1]; OUT = sys.argv[2]; os.makedirs(f'{OUT}/frames', exist_ok=True)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8777), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
shots = []

async def main():
    now = datetime.now(timezone.utc)
    iso = lambda d: d.strftime('%Y-%m-%dT%H:%M:%S.000Z')
    logs = [{'id': 'demo-1', 'code': 'DEMO-BOAT', 'time': iso(now - timedelta(hours=2)), 'lat': 17.705, 'lon': -76.905, 'species': 'Blue marlin', 'count': 1,
             'note': '[Strike, Released] ', 'exact': True, 'synced': True, 'wt': 300},
            {'id': 'demo-2', 'code': 'DEMO-BOAT', 'time': iso(now - timedelta(minutes=40)), 'lat': 17.66, 'lon': -76.84, 'species': 'Birds working', 'count': 1,
             'note': '[seen] Birds working', 'exact': True, 'synced': True}]
    seed = {'sil.code': 'DEMO-BOAT', 'sil.boat': 'Demo Boat', 'sil.share': 'research', 'sil.btype': 'charter', 'sil.caps': {'DEMO-BOAT': 'CAP-DEMO'},
            'sil.tagged1': True, 'sil.view': 'south', 'sil.logs': logs, 'sil.dev': 'demo-phone'}
    js = 'if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", 1); ' + ' '.join(
        f'localStorage.setItem({json.dumps(k)}, {json.dumps(json.dumps(v))});' for k, v in seed.items()) + ' }'
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 432, 'height': 768}, device_scale_factor=2.5, is_mobile=True, has_touch=True,
                                  geolocation={'latitude': 17.69, 'longitude': -76.93}, permissions=['geolocation'], timezone_id='America/Jamaica')
        await ctx.add_init_script(js)
        pg = await ctx.new_page()
        async def center(sel):
            el = await pg.query_selector(sel)
            if not el: return None
            bx = await el.bounding_box()
            return [round(bx['x'] + bx['width'] / 2, 1), round(bx['y'] + bx['height'] / 2, 1)] if bx else None
        async def shot(name, caption, tap=None, hold=3.6, new=False):
            await pg.screenshot(path=f'{OUT}/frames/{name}.jpg', type='jpeg', quality=92)
            shots.append({'name': name, 'caption': caption, 'tap': tap, 'hold': hold, 'new': new}); print('shot', name, tap)
        js_click = lambda sel: pg.evaluate(f"document.querySelector({json.dumps(sel)}).click()")
        close_popup = lambda: pg.evaluate("document.querySelector('.leaflet-popup-close-button')?.click()")
        hide_sheets = lambda: pg.evaluate("document.querySelectorAll('.sheet').forEach(s => s.hidden = true)")

        await pg.goto('http://127.0.0.1:8777/index.html', wait_until='networkidle'); await pg.wait_for_timeout(3500)
        await pg.select_option('#areaSel', 'south'); await pg.wait_for_timeout(1500)
        await shot('01-open', 'Open the lab: today’s fishing picture for Jamaican waters, by area.', tap=await center('#areaSel'), hold=3.6)
        await shot('02-plan', 'Today’s plan: the best spot, the best time and the sea at that time.', tap=await center('#plan'), hold=3.8)
        t = await center('#planConf')
        if t:
            await js_click('#planConf'); await pg.wait_for_timeout(900)
            await shot('03-conf', 'Tap the Picture badge to see how sure the map is in each area, and why.', tap=t, hold=4.0, new=True)
            await hide_sheets()
        await shot('04-times', 'Major and minor feeding times for the whole island. Only what’s coming up is shown.', tap=await center('#chips .chip'), hold=4.0, new=True)
        for pin in await pg.query_selector_all('.leaflet-pins-pane path'):
            bx = await pin.bounding_box()
            if bx and 40 < bx['x'] < 390 and 230 < bx['y'] < 600:
                tap = [bx['x'] + bx['width'] / 2, bx['y'] + bx['height'] / 2]
                await pin.dispatch_event('click'); await pg.wait_for_timeout(800)
                await shot('05-bank', 'Tap a red dot for that bank’s wind, seas and current.', tap=tap, hold=3.8, new=True); break
        await close_popup()
        await pg.evaluate("for (const id of ['curArrows','weedLayer']) { const e = document.getElementById(id); if (!e.checked) { e.checked = true; e.dispatchEvent(new Event('change')); } }")
        await pg.wait_for_timeout(1500)
        await shot('06-layers', 'Arrows show which way the current runs. Green marks are weed seen by satellite.', hold=4.0, new=True)
        # boat code: create a boat
        t = await center('#moreBtn'); await js_click('#moreBtn'); await pg.wait_for_timeout(400)
        t = await center('#codeBtn'); await js_click('#codeBtn'); await pg.wait_for_timeout(600)
        await pg.evaluate("""(() => { document.getElementById('otherBoat').open = true;
          const s = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
          s('boatIn', 'Reel Irie'); s('byIn', 'Captain Andrew'); s('newType', 'charter');
          document.getElementById('createBtn').scrollIntoView({block: 'center'}); })()""")
        await pg.wait_for_timeout(500)
        await shot('07-create', 'Captains create the boat code: boat name, your name and boat type. Crew join with it.', tap=await center('#createBtn'), hold=4.2, new=True)
        await pg.evaluate("document.getElementById('codeDlg').close()")
        await js_click('#moreBtn'); await pg.wait_for_timeout(400); t = await center('#shareBtn'); await js_click('#shareBtn'); await pg.wait_for_timeout(700)
        await shot('08-share', 'Only the captain picks who sees catches. Research, the default, never shares a spot.', tap=t, hold=4.4, new=True)
        await pg.evaluate("document.getElementById('shareDlg').close('cancel')"); await hide_sheets()
        # strike with weight (GPS must be on first, like on the boat)
        await js_click('#boatBtn'); await pg.wait_for_timeout(4000)
        t = await center('#logBtn'); await js_click('#logBtn'); await pg.wait_for_timeout(800)
        print('strike dialog open:', await pg.evaluate("document.getElementById('logDlg').open"))
        await pg.evaluate("""(() => { document.getElementById('species').value = 'Blue marlin';
          for (const id of ['oStrike', 'oReleased']) document.getElementById(id).checked = true;
          document.getElementById('wt').value = '300'; document.getElementById('wt').scrollIntoView({block: 'center'}); })()""")
        await pg.wait_for_timeout(400)
        await shot('09-strike', 'Hooked up? Tap Strike, tick what happened and add an approx weight. Needs your boat code and GPS.', tap=t, hold=4.6, new=True)
        await pg.evaluate("document.getElementById('logDlg').close('cancel')"); await pg.wait_for_timeout(3500)
        star = None
        for el in await pg.query_selector_all('.leaflet-marker-pane path'):
            if await el.get_attribute('fill') == '#2ee66b': star = el; break
        if star:
            bx = await star.bounding_box(); tap = [bx['x'] + bx['width'] / 2, bx['y'] + bx['height'] / 2] if bx else None
            await star.dispatch_event('click'); await pg.wait_for_timeout(700)
            await shot('10-star', 'Your strikes show as stars, with the weight. Logged by mistake? Delete it.', tap=tap, hold=4.0, new=True); await close_popup()
        await js_click('#moreBtn'); await pg.wait_for_timeout(400); t = await center('#trackBtn'); await js_click('#trackBtn'); await pg.wait_for_timeout(1500)
        await shot('11-track', 'Track record: how often strikes landed in the map’s hot spots. Every log tests it.', tap=t, hold=4.4, new=True)
        json.dump(shots, open(f'{OUT}/manifest.json', 'w'), indent=1)
        await b.close()
asyncio.run(main())
