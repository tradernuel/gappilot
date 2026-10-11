"""End-to-end check of the built single-file test app in Chromium. Usage: demo-e2e.py <file.html> <shots_dir>"""
import sys
from playwright.sync_api import sync_playwright
src, out = sys.argv[1], sys.argv[2]
url = "file://" + src
errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2).new_page()
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "403" not in m.text else None)  # 403 = fonts blocked in this sandbox
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(url)
    pg.wait_for_selector("text=Reference prices may be stale.", timeout=20000)
    pg.wait_for_selector("table tbody tr")
    mon = pg.locator("section[aria-label='Weekend mode'] dd").first.inner_text()
    print("1 scan: monitoring", mon, "| rows", pg.locator("table tbody tr").count())
    pg.screenshot(path=f"{out}/01-scanner.png")

    pg.click("tr:has-text('Ondo vs NEBLb')"); pg.wait_for_selector("#detail-title"); pg.wait_for_timeout(400)
    pg.locator("#agent-heading").scroll_into_view_if_needed(); pg.wait_for_timeout(200)
    pg.screenshot(path=f"{out}/02-agent.png")
    pg.click("button:has-text('Simulate trade')"); pg.wait_for_selector("text=SIMULATION PASSED", timeout=15000)
    pg.screenshot(path=f"{out}/03-sim-passed.png")
    pg.locator("dialog >> text=I've reviewed").click(); pg.click("button:has-text('Confirm trade')")
    pg.wait_for_selector("text=Approved and executed in simulation", timeout=15000); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{out}/04-approved.png")
    print("2 trade: simulated, approved, record:", pg.locator("dialog article header").first.inner_text().replace("\n", " "))
    pg.click("dialog button:has-text('Close')")

    pg.click("nav[aria-label=Views] >> text=Strategies")
    pg.fill("#rule-text", "Buy tokenized stocks when they are at least 2% below reference price. Only trade when liquidity is above $100k. Maximum $50 per trade.")
    pg.click("text=Parse rule"); pg.wait_for_selector("text=Your rule"); pg.click("text=Save strategy"); pg.wait_for_selector("text=Saved. It won")
    pg.wait_for_timeout(300); pg.screenshot(path=f"{out}/05-strategy.png")
    print("3 strategy: saved;", pg.locator("li:has-text('Buy at 2% discount')").first.inner_text().split("\n")[-1][:80])

    pg.click("nav[aria-label=Views] >> text=Autonomy"); pg.wait_for_selector("#grant-title")
    pg.select_option("select >> nth=0", index=1); pg.check("text=I authorize the agent")
    pg.click("button:has-text('Authorize simulated autonomy')"); pg.wait_for_selector("text=Active grant")
    pg.click("button:has-text('Run one cycle')"); pg.wait_for_selector("text=Scanned", timeout=20000); pg.wait_for_timeout(400)
    pg.screenshot(path=f"{out}/06-autonomy.png")
    print("4 autonomy:", pg.locator("p[role=status]").first.inner_text()[:110])

    pg.click("nav[aria-label=Views] >> text=Scanner")
    pg.click("[aria-label='Open demo controls']"); pg.wait_for_selector("[aria-label='Demo controls']")
    pg.click("[aria-label='Simulated US market'] >> text=Open"); pg.wait_for_selector("text=STANDBY", timeout=15000)
    pg.screenshot(path=f"{out}/07-market-open.png", clip={"x": 0, "y": 0, "width": 1440, "height": 260})
    print("5 market open: STANDBY shown")
    pg.screenshot(path=f"{out}/07b-demo-controls.png")
    pg.click("[aria-label='Simulated US market'] >> text=Closed"); pg.wait_for_selector("text=ACTIVE", timeout=15000)
    pg.click("[aria-label='Minimize demo controls']")

    m = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2).new_page()
    m.on("pageerror", lambda e: errors.append(str(e)))
    m.goto(url); m.wait_for_selector("text=Reference prices may be stale.", timeout=20000); m.wait_for_timeout(400)
    m.screenshot(path=f"{out}/08-mobile.png")
    print("6 mobile: scrollWidth", m.evaluate("document.documentElement.scrollWidth"))
print("console/page errors:", errors if errors else "none")
