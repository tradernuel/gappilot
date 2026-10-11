"""VISUAL QA ONLY: Autonomy view. Audit records from make-audit-fixture.mts (real runner, mock provider)."""
import json, sys
from playwright.sync_api import sync_playwright
base, fx_path, audit_path, out = sys.argv[1:5]
fx = open(fx_path).read(); a = json.load(open(audit_path))
INIT = f"""window.ethereum={{request:async({{method}})=>method==='eth_chainId'?'0x38':['0x7000000000000000000000000000000000000007'],on(){{}},removeListener(){{}}}};
localStorage.setItem('gappilot:wallet-connected','1');
localStorage.setItem('gappilot:strategies:v1', JSON.stringify([{json.dumps(a['saved'])}]));
localStorage.setItem('gappilot:audit:v1', JSON.stringify({json.dumps(list(reversed(a['records'][:2])))}));"""
GRANT = json.dumps({"ok": True, "data": {"grant": a["grant"], "grantToken": "visual.token"}})
RUN = json.dumps({"ok": True, "data": {"wallet": "0x7000000000000000000000000000000000000007", "scanned": 2, "candidates": [{"symbol": "XYZon", "spreadPercent": -1}], "records": [a["records"][2]], "note": "The best candidate was refused by the execution policy.", "mode": "SIMULATED"}})
with sync_playwright() as p:
    b = p.chromium.launch()
    for w, h, tag in [(1440, 900, "desktop"), (390, 844, "mobile")]:
        ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2); ctx.add_init_script(INIT)
        pg = ctx.new_page()
        pg.route("**/api/opportunities**", lambda r: r.fulfill(status=200, content_type="application/json", body=fx))
        pg.route("**/api/autonomy/grant", lambda r: r.fulfill(status=200, content_type="application/json", body=GRANT))
        pg.route("**/api/autonomy/run", lambda r: r.fulfill(status=200, content_type="application/json", body=RUN))
        pg.goto(base); pg.wait_for_timeout(600)
        pg.click("nav[aria-label=Views] >> text=Autonomy"); pg.wait_for_selector("#grant-title")
        pg.select_option("select >> nth=0", "s1"); pg.check("text=I authorize the agent")
        pg.screenshot(path=f"{out}/autonomy-{tag}-form.png", full_page=(tag == "mobile"))
        pg.click("button:has-text('Authorize simulated autonomy')"); pg.wait_for_selector("text=Active grant")
        pg.click("button:has-text('Run one cycle')"); pg.wait_for_selector("text=Daily trade count reached")
        pg.screenshot(path=f"{out}/autonomy-{tag}-run.png", full_page=(tag == "mobile"))
        sw = pg.evaluate("document.documentElement.scrollWidth"); print(tag, "scrollWidth", sw, "viewport", w)
print("done")
