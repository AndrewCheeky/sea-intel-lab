"""Opens the built page in a headless phone-sized browser and fails the run if it doesn't load cleanly."""
import asyncio, sys, functools, http.server, threading
from playwright.async_api import async_playwright
root = sys.argv[1]
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), functools.partial(http.server.SimpleHTTPRequestHandler, directory=root))
threading.Thread(target=srv.serve_forever, daemon=True).start()
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, geolocation={'latitude': 17.712, 'longitude': -76.8805}, permissions=['geolocation'])
        pg = await ctx.new_page(); errs = []
        from datetime import datetime, timezone
        t = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        await ctx.add_init_script("if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', 1); localStorage.setItem('sil.code', JSON.stringify('SMOKE-TEST')); localStorage.setItem('sil.tagged1', 'true'); localStorage.setItem('sil.logs', JSON.stringify([{id: 'smoke-1', code: 'SMOKE-TEST', time: '%s', lat: 17.70, lon: -76.90, species: 'Birds working', count: 1, note: '[seen] Birds working', exact: false, synced: false}, {id: 'smoke-2', code: 'SMOKE-TEST', time: '%s', lat: 17.60, lon: -76.80, species: 'Blue marlin', count: 1, note: '[Strike, Released] ', exact: false, synced: false}, {id: 'smoke-3', code: 'OTHER-BOAT', time: '%s', lat: 17.65, lon: -76.70, species: 'Wahoo', count: 1, note: '[Strike] ', exact: false, synced: false}])); }" % (t, t, t))
        pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://127.0.0.1:8765/index.html', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        built = await pg.inner_text('#built')
        squares = await pg.evaluate("document.querySelectorAll('.leaflet-overlay-pane canvas').length")
        spots = await pg.evaluate("document.querySelectorAll('.spot').length")
        await pg.click('#moreBtn'); await pg.click('#contours'); await pg.wait_for_timeout(1200)
        labels = await pg.evaluate("document.querySelectorAll('.dlabel').length")
        print(f'depth labels shown: {labels}')
        print('times strip:', await pg.inner_text('#chips'))
        print('plan:', await pg.inner_text('#plan'))
        if await pg.query_selector('#planConf'):
            await pg.click('#planConf'); await pg.wait_for_timeout(300)
            print('picture sheet open:', not await pg.evaluate("document.getElementById('confSheet').hidden"))
        await pg.evaluate("document.querySelectorAll('.sheet').forEach(s => s.hidden = true)")
        pins = await pg.query_selector_all('.leaflet-pins-pane path')
        bank_popup = ''
        for pin in pins:
            box = await pin.bounding_box()
            if box and 0 < box['x'] < 380 and 200 < box['y'] < 700:
                await pg.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2); await pg.wait_for_timeout(500)
                el = await pg.query_selector('.leaflet-popup-content'); bank_popup = (await el.inner_text()) if el else '(no popup)'; break
        print(f'bank pins: {len(pins)}  popup: {bank_popup[:160]!r}')
        await pg.keyboard.press('Escape'); await pg.mouse.click(5, 820)
        # delete the seeded bird log from its popup
        await pg.evaluate("document.querySelectorAll('.sheet').forEach(s => s.hidden = true)")
        seen = await pg.query_selector('.seen'); deleted = None
        if seen:
            await seen.dispatch_event('click'); await pg.wait_for_timeout(400)
            btn = await pg.query_selector('.leaflet-popup .delLog')
            if btn: await btn.click(); await pg.wait_for_timeout(600)
            bird_gone = await pg.evaluate("JSON.parse(localStorage.getItem('sil.logs') || '[]').filter(l => l.code === 'SMOKE-TEST').length === 1 && !document.querySelector('.seen')")
            other_hidden = await pg.evaluate("[...document.querySelectorAll('path')].filter(p => p.getAttribute('fill') === '#2ee66b').length === 1")
            print('other boat hidden:', other_hidden)
            green = await pg.query_selector('path[fill="#2ee66b"]')
            if bird_gone and green:
                await green.dispatch_event('click'); await pg.wait_for_timeout(400)
                print('strike popup:', (await pg.inner_text('.leaflet-popup-content'))[:80].replace(chr(10), ' / '))
                btn = await pg.query_selector('.leaflet-popup .delLog')
                if btn: await btn.click(); await pg.wait_for_timeout(600)
            deleted = other_hidden and await pg.evaluate("JSON.parse(localStorage.getItem('sil.logs') || '[]').filter(l => l.code === 'SMOKE-TEST').length === 0 && [...document.querySelectorAll('path')].filter(p => p.getAttribute('fill') === '#2ee66b').length === 0")
        print('delete a log:', deleted)
        await pg.evaluate("document.getElementById('shareBtn').click()"); await pg.wait_for_timeout(300)
        share_open = await pg.evaluate("document.getElementById('shareDlg').open && document.querySelectorAll('#shareDlg .shareOpts button').length === 4 && !document.getElementById('capNote').hidden")
        await pg.evaluate("document.getElementById('shareDlg').close('cancel')")
        print('sharing dialog:', share_open)
        await pg.evaluate("const t = document.getElementById('tiles'); t.checked = true; t.dispatchEvent(new Event('change'))"); await pg.wait_for_timeout(3000)
        tiles_ok = await pg.evaluate("[...document.querySelectorAll('.leaflet-tile-pane img')].filter(i => i.complete && i.naturalWidth > 0).map(i => new URL(i.src).host).join(' ')")
        print('street map tiles loaded:', tiles_ok)
        await pg.evaluate("const t = document.getElementById('tiles'); t.checked = false; t.dispatchEvent(new Event('change'))")
        await pg.evaluate("localStorage.setItem('sil.code', '\"\"')")
        await pg.evaluate("document.getElementById('logBtn').click()"); await pg.wait_for_timeout(1300)
        needs_code = await pg.evaluate("document.getElementById('codeDlg').open && !document.getElementById('logDlg').open")
        await pg.evaluate("document.getElementById('codeDlg').close()")
        print('strike without a boat code asks for one:', needs_code)
        await pg.click('#moreBtn')
        await pg.click('#boatBtn'); await pg.wait_for_timeout(1500)
        here = await pg.inner_text('#here'); best = await pg.inner_text('#best')
        await pg.screenshot(path=f'{root}/../smoke.png')
        print('plan with boat:', await pg.inner_text('#plan'))
        print(f'built: {built}\nlayers: {squares}  top spots: {spots}\nboat square: {here}  best nearby: {best}\nerrors: {errs}')
        await b.close()
        if errs or 'Could not' in built or not spots or deleted is not True or not share_open or not needs_code or ('Wind' not in bank_popup and 'not available' not in bank_popup): sys.exit(1)
asyncio.run(main())
