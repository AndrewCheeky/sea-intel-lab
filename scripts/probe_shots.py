import asyncio, sys, functools, http.server, threading, os
from playwright.async_api import async_playwright
root = sys.argv[1]; os.makedirs('shots', exist_ok=True)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8766), functools.partial(http.server.SimpleHTTPRequestHandler, directory=root))
threading.Thread(target=srv.serve_forever, daemon=True).start()
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, geolocation={'latitude': 17.712, 'longitude': -76.8805}, permissions=['geolocation'], timezone_id='America/Jamaica')
        pg = await ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        await pg.goto('http://127.0.0.1:8766/index.html', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        print('conf:', await pg.inner_text('#confBtn'))
        await pg.evaluate("document.getElementById('confBtn').click()"); await pg.wait_for_timeout(300); await pg.screenshot(path='shots/1-confidence.png')
        await pg.evaluate("document.querySelectorAll('.sheet').forEach(s=>s.hidden=true)")
        await pg.evaluate("for (const id of ['curArrows','weedLayer']) { const e=document.getElementById(id); e.checked=true; e.dispatchEvent(new Event('change')); }")
        await pg.select_option('#areaSel', 'south'); await pg.wait_for_timeout(1200); await pg.screenshot(path='shots/2-arrows-weed.png')
        await pg.evaluate("document.querySelectorAll('.leaflet-interactive').forEach(e=>{})")
        # tap the Mackerel (Bowditch) bank pin
        pt = await pg.evaluate("(() => { const m = document.querySelector('#map'); return null; })()")
        await pg.click('#boatBtn'); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='shots/3-boat.png')
        await pg.evaluate("document.getElementById('areaSel').value='south';document.getElementById('areaSel').dispatchEvent(new Event('change'))"); await pg.wait_for_timeout(800)
        print('sea here:', await pg.inner_text('#seaHere'))
        await pg.screenshot(path='shots/3-boat.png')
        print('errors:', errs); await b.close()
asyncio.run(main())
