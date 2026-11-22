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
        await pg.click('#boatBtn'); await pg.wait_for_timeout(1500)
        here = await pg.inner_text('#here'); best = await pg.inner_text('#best')
        await pg.screenshot(path=f'{root}/../smoke.png')
        print(f'built: {built}\nlayers: {squares}  top spots: {spots}\nboat square: {here}  best nearby: {best}\nerrors: {errs}')
        await b.close()
        if errs or 'Could not' in built or not spots: sys.exit(1)
asyncio.run(main())
