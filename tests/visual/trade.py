"""VISUAL QA ONLY: trade preview dialog. Routes intercepted with fixtures from make-trade-fixtures.mts."""
import json, sys, time
from playwright.sync_api import sync_playwright
base, fx_path, trade_path, out = sys.argv[1:5]
audit_path = sys.argv[5] if len(sys.argv) > 5 else None
fx = open(fx_path).read()
trades = json.load(open(trade_path))
WALLET_JS = """window.ethereum={request:async({method})=>method==='eth_chainId'?'0x38':['0x7f3a00000000000000000000000000000000c41d'],on(){},removeListener(){}};
localStorage.setItem('gappilot:wallet-connected','1');localStorage.setItem('gappilot:settings:v1',JSON.stringify({notional:250,maxPairs:10,refreshSec:0}));"""

def fresh(kind):
    d = json.loads(json.dumps(trades[kind])); d["data"]["expiresAt"] = int(time.time() * 1000) + 25_000; return json.dumps(d)

# Approval now returns the audit record produced by the real policy + mock provider (see make-audit-fixture.mts).
rec = json.load(open(audit_path))["records"][0] if audit_path else None
if rec:
    rec = {**rec, "strategy": None, "authorization": {**rec["authorization"], "state": "USER_APPROVED", "approvalId": "visual", "grantId": None}}
APPROVED = json.dumps({"ok": True, "data": rec})

with sync_playwright() as p:
    b = p.chromium.launch()
    def open_preview(kind, w=1440, h=900):
        ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2); ctx.add_init_script(WALLET_JS)
        pg = ctx.new_page()
        pg.route("**/api/opportunities**", lambda r: r.fulfill(status=200, content_type="application/json", body=fx))
        pg.route("**/api/trade/simulate", lambda r: r.fulfill(status=200, content_type="application/json", body=fresh(kind)))
        pg.route("**/api/trade/approve", lambda r: r.fulfill(status=200, content_type="application/json", body=APPROVED))
        pg.goto(base); pg.wait_for_timeout(700)
        sel = "tr:has-text('bStocks vs ACMEon')" if w >= 768 else "ul[aria-label^='Opportunities'] li >> nth=0"
        pg.click(sel); pg.wait_for_selector("text=Simulate trade")
        pg.click("button:has-text('Simulate trade')"); pg.wait_for_selector("#trade-title"); pg.wait_for_timeout(500)
        return pg
    pg = open_preview("passed"); pg.screenshot(path=f"{out}/trade-passed.png")
    pg.locator("dialog >> text=I've reviewed").click(); pg.wait_for_timeout(100); pg.screenshot(path=f"{out}/trade-ready.png")
    pg.click("button:has-text('Confirm trade')"); pg.wait_for_selector("text=executed in simulation"); pg.screenshot(path=f"{out}/trade-approved.png")
    pg = open_preview("failed"); pg.screenshot(path=f"{out}/trade-failed.png")
    pg = open_preview("unverifiable"); pg.screenshot(path=f"{out}/trade-unverifiable.png")
    pg = open_preview("passed", 390, 844); pg.screenshot(path=f"{out}/trade-mobile.png")
print("done")
