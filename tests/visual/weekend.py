"""VISUAL QA ONLY: Weekend Mode states. /api/opportunities intercepted with the synthetic fixture."""
import sys, time
from playwright.sync_api import sync_playwright
base, closed_fx, open_fx, out = sys.argv[1:5]
WALLET = """window.ethereum={request:async({method})=>method==='eth_chainId'?'0x38':['0x7f3a00000000000000000000000000000000c41d'],on(){},removeListener(){}};
localStorage.setItem('gappilot:wallet-connected','1');localStorage.setItem('gappilot:settings:v1',JSON.stringify({notional:250,maxPairs:10,refreshSec:0}));"""
with sync_playwright() as p:
    b = p.chromium.launch()
    def page(fx, w=1440, h=900, delay=0, off=False):
        ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2)
        ctx.add_init_script(WALLET + ("localStorage.setItem('gappilot:weekend:v1','off');" if off else ""))
        pg = ctx.new_page()
        body = open(fx).read()
        def handler(r):
            if delay: time.sleep(delay)
            r.fulfill(status=200, content_type="application/json", body=body)
        pg.route("**/api/opportunities**", handler)
        return pg
    pg = page(closed_fx); pg.goto(base); pg.wait_for_selector("text=Reference prices may be stale."); pg.wait_for_timeout(500)
    pg.screenshot(path=f"{out}/weekend-active.png")
    print("switch aria-checked:", pg.get_attribute("[role=switch]", "aria-checked"))
    pg.click("[role=switch]"); pg.wait_for_selector("text=Opportunities detected"); pg.wait_for_timeout(200)
    pg.screenshot(path=f"{out}/weekend-off.png", clip={"x": 0, "y": 0, "width": 1440, "height": 260})
    print("after toggle aria-checked:", pg.get_attribute("[role=switch]", "aria-checked"))
    pg = page(open_fx); pg.goto(base); pg.wait_for_selector("text=STANDBY"); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{out}/weekend-standby.png", clip={"x": 0, "y": 0, "width": 1440, "height": 260})
    pg = page(closed_fx, delay=20); pg.goto(base); pg.wait_for_selector("text=STARTING"); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{out}/weekend-loading.png", clip={"x": 0, "y": 0, "width": 1440, "height": 260})
    pg = page(closed_fx, 390, 844); pg.goto(base); pg.wait_for_selector("text=Reference prices may be stale."); pg.wait_for_timeout(500)
    pg.screenshot(path=f"{out}/weekend-mobile.png")
    print("mobile scrollWidth", pg.evaluate("document.documentElement.scrollWidth"))
    for w in (320, 768, 1024):
        pg = page(closed_fx, w, 800); pg.goto(base); pg.wait_for_selector("text=Reference prices may be stale.")
        print(w, "scrollWidth", pg.evaluate("document.documentElement.scrollWidth"))
print("done")
