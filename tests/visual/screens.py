"""
VISUAL QA ONLY. Screenshots the production build with API routes intercepted
in the browser (fixture from make-fixture.ts) and a fake read-only wallet.
Usage: python3 tests/visual/screens.py <base_url> <fixture.json> <out_dir>
"""
import json, sys, time
from playwright.sync_api import sync_playwright

base, fixture_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
fixture = open(fixture_path).read()
WALLET_JS = """
window.ethereum = {
  request: async ({ method }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return ['0x7f3a00000000000000000000000000000000c41d'];
    if (method === 'eth_chainId') return '0x38';
    throw new Error('not supported in fixture');
  },
  on() {}, removeListener() {}
};
localStorage.setItem('gappilot:wallet-connected', '1');
localStorage.setItem('gappilot:settings:v1', JSON.stringify({ notional: 250, maxPairs: 10, refreshSec: 0 }));
"""

def page_for(p, width, height, opp_handler, wallet=True):
    ctx = p.chromium.launch().new_context(viewport={"width": width, "height": height}, device_scale_factor=2)
    if wallet: ctx.add_init_script(WALLET_JS)
    pg = ctx.new_page()
    pg.route("**/api/opportunities**", opp_handler)
    return pg

ok = lambda r: r.fulfill(status=200, content_type="application/json", body=fixture)

with sync_playwright() as p:
    pg = page_for(p, 1440, 900, ok)
    pg.goto(base); pg.wait_for_selector("table tbody tr")
    pg.screenshot(path=f"{out}/01-desktop-table.png")
    pg.click("text=ACMEb >> nth=0"); pg.wait_for_selector("#detail-title"); pg.wait_for_timeout(400)
    pg.screenshot(path=f"{out}/02-desktop-detail.png")
    pg.locator("#agent-heading").scroll_into_view_if_needed(); pg.wait_for_timeout(200)
    pg.screenshot(path=f"{out}/03-desktop-agent.png")
    pg.click("tr:has-text('Ondo vs ACMEb')"); pg.wait_for_selector("#agent-heading")
    pg.locator("#agent-heading").scroll_into_view_if_needed(); pg.wait_for_timeout(250)
    pg.screenshot(path=f"{out}/03b-desktop-agent-actionable.png")
    pg.click("[aria-label='Settings']"); pg.wait_for_selector("#settings-title"); pg.wait_for_timeout(150)
    pg.screenshot(path=f"{out}/09-settings.png")

    pg = page_for(p, 390, 844, ok)
    pg.goto(base); pg.wait_for_selector("ul[aria-label^='Opportunities'] li")
    pg.screenshot(path=f"{out}/04-mobile-list.png", full_page=True)
    pg.click("ul[aria-label^='Opportunities'] li >> nth=1"); pg.wait_for_selector("#detail-title")
    pg.wait_for_timeout(400)  # let the sheet's slide-in animation finish
    pg.screenshot(path=f"{out}/05-mobile-detail.png")

    pg = page_for(p, 1280, 720, lambda r: (time.sleep(30), r.abort()), wallet=False)
    pg.goto(base); pg.wait_for_selector("[aria-label='Loading opportunities']"); time.sleep(0.4)
    pg.screenshot(path=f"{out}/06-loading.png")

    err = json.dumps({"ok": False, "error": {"kind": "http", "message": "GET /api/v1/dex/market/rwa/tokens failed with HTTP 401", "upstreamStatus": 401}})
    pg = page_for(p, 1280, 720, lambda r: r.fulfill(status=502, content_type="application/json", body=err), wallet=False)
    pg.goto(base); pg.wait_for_selector("[role=alert]")
    pg.screenshot(path=f"{out}/07-error.png")

    empty = json.loads(fixture); empty["data"].update(opportunities=[], pairsFound=0, pairsScanned=0, attestations={})
    pg = page_for(p, 1280, 720, lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(empty)), wallet=False)
    pg.goto(base); pg.wait_for_selector("text=No stock is listed")
    pg.screenshot(path=f"{out}/08-empty.png")
print("done")
