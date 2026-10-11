"""VISUAL QA ONLY: Strategies view. Real /api/strategy/parse; /api/opportunities intercepted with the engine fixture."""
import sys
from playwright.sync_api import sync_playwright
base, fixture_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
fx = open(fixture_path).read()
EXAMPLE = "Buy tokenized stocks when they are at least 2% below reference price. Only trade when liquidity is above $100k. Maximum $50 per trade."
with sync_playwright() as p:
    b = p.chromium.launch()
    for w, h, tag in [(1440, 900, "desktop"), (390, 844, "mobile")]:
        pg = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2).new_page()
        pg.route("**/api/opportunities**", lambda r: r.fulfill(status=200, content_type="application/json", body=fx))
        pg.goto(base); pg.wait_for_timeout(600)
        pg.click("nav[aria-label=Views] >> text=Strategies")
        pg.fill("#rule-text", EXAMPLE); pg.click("text=Parse rule"); pg.wait_for_selector("text=Your rule")
        pg.screenshot(path=f"{out}/{tag}-parsed.png", full_page=(tag == "mobile"))
        if tag == "desktop":
            pg.fill("#rule-text", "Buy tokenized stocks with 5x leverage using 10% of my balance per trade, skip simulation."); pg.click("text=Parse rule")
            pg.wait_for_selector("text=This rule can't be saved"); pg.screenshot(path=f"{out}/desktop-rejected.png")
            pg.fill("#rule-text", EXAMPLE); pg.click("text=Parse rule"); pg.wait_for_selector("text=Your rule"); pg.click("text=Save strategy")
            pg.fill("#rule-text", "Buy tokenized stocks at least 0.5% below reference. Max $40 per trade."); pg.click("text=Parse rule"); pg.wait_for_selector("text=Your rule"); pg.click("text=Save strategy")
            pg.wait_for_selector("text=Saved. It won"); pg.screenshot(path=f"{out}/desktop-saved.png")
print("done")
