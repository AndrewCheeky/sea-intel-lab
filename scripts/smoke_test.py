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
        await pg.click('#moreBtn')
        await pg.click('#boatBtn'); await pg.wait_for_timeout(1500)
        here = await pg.inner_text('#here'); best = await pg.inner_text('#best')
        await pg.screenshot(path=f'{root}/../smoke.png')
        print('plan with boat:', await pg.inner_text('#plan'))
        print(f'built: {built}\nlayers: {squares}  top spots: {spots}\nboat square: {here}  best nearby: {best}\nerrors: {errs}')
        await b.close()
        if errs or 'Could not' in built or not spots or ('Wind' not in bank_popup and 'not available' not in bank_popup): sys.exit(1)
asyncio.run(main())
