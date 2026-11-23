import asyncio, sys, functools, http.server, threading, base64, io, json
from playwright.async_api import async_playwright
from PIL import Image
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8799), functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1]))
threading.Thread(target=srv.serve_forever, daemon=True).start()
async def shot(pg, name):
    b = await pg.screenshot(type='jpeg', quality=70); im = Image.open(io.BytesIO(b)); im = im.resize((im.width // 2, im.height // 2)); o = io.BytesIO(); im.save(o, 'JPEG', quality=70)
    print('IMG', name, base64.b64encode(o.getvalue()).decode())
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for name, seed in [('with-boat', {'sil.code': 'TRSY-0002', 'sil.boat': 'Trsy 2', 'sil.btype': ''}), ('no-boat', {})]:
            ctx = await b.new_context(viewport={'width': 412, 'height': 860}, device_scale_factor=2, is_mobile=True)
            await ctx.add_init_script(' '.join(f'localStorage.setItem({json.dumps(k)}, {json.dumps(json.dumps(v))});' for k, v in seed.items()))
            pg = await ctx.new_page(); await pg.goto('http://127.0.0.1:8799/index.html'); await pg.wait_for_timeout(1500)
            await pg.evaluate("document.getElementById('codeBtn').click()"); await pg.wait_for_timeout(500)
            await shot(pg, name)
            if name == 'with-boat':
                await pg.evaluate("document.getElementById('otherBoat').open = true"); await pg.wait_for_timeout(300)
                await pg.evaluate("document.querySelector('#codeDlg .codeBox').scrollIntoView(false); document.getElementById('createBtn').scrollIntoView()"); await shot(pg, 'with-boat-open')
            await ctx.close()
        await b.close()
asyncio.run(main())
