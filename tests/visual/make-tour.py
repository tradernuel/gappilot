"""
Builds the single-file screen tour (HTML with embedded WebP screenshots).
VISUAL QA / DEMO ONLY. Usage: python3 tests/visual/make-tour.py <shots_dir> <out.html>
"""
import base64, html, io, sys
from PIL import Image

shots, out = sys.argv[1], sys.argv[2]

def uri(name):
    im = Image.open(f"{shots}/{name}.png").convert("RGB")
    w, h = im.size
    t = 780 if w < 1200 else 1600
    if w > t:
        im = im.resize((t, round(h * t / w)), Image.LANCZOS)
    buf = io.BytesIO(); im.save(buf, "WEBP", quality=82, method=6)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()

SECTIONS = [
 ("weekend", "Weekend Mode", "The demo story: the US market is closed, tokenized stocks keep trading, and GapPilot shows what that means right now.", [
   ("weekend-active", "Weekend Mode: active", "ACTIVE only when Binance reports the US market closed. Reference prices may be stale, a countdown to the open, and Monitoring, Opportunities and Actionable straight from the scan.", "wide"),
   ("weekend-standby", "Market open: standby", "When the market trades, Weekend Mode says so (hollow dot, green OPEN) instead of claiming to be active.", "wide"),
   ("weekend-off", "Toggle off", "Switch it off in the header and the regular summary strip returns.", "wide"),
   ("weekend-mobile", "Mobile: Weekend Mode", "", "phone"),
 ]),
 ("scanner", "Scanner", "Finds price gaps between the same stock on two issuers, and decides whether you can actually act on them.", [
   ("01-desktop-table", "Opportunity scanner", "Each tokenized stock is compared per share with the same stock from the other issuer. The bar draws the gap; the rail and badge show the engine's verdict.", "wide"),
   ("02-desktop-detail", "Opportunity detail", "Every engine figure, your wallet position, and the deterministic reasons under \u201cWhy am I seeing this?\u201d", "wide"),
   ("03-desktop-agent", "Agent: simulate first", "The reasoning agent recommends a simulation; risks main-first, with your rule checks.", "wide"),
   ("03b-desktop-agent-actionable", "Agent: stricter than the engine", "A discount the wallet can't fund: the agent downgrades it to watch, no action, and says why.", "wide"),
   ("09-settings", "Settings and agent rules", "Rules can make the agent stricter than the engine, never looser.", "wide"),
   ("06-loading", "Loading", "Skeleton rows while the scan runs.", "third"),
   ("07-error", "Error", "Failures name the cause and the fix.", "third"),
   ("08-empty", "Empty", "When no stock is listed by both issuers.", "third"),
   ("04-mobile-list", "Mobile: scanner", "", "phone"),
   ("05-mobile-detail", "Mobile: detail", "", "phone"),
 ]),
 ("strategies", "Strategies", "Plain-English rules, parsed and validated deterministically, shown back before saving.", [
   ("desktop-parsed", "Parsed rule", "Defaults are tagged, simulation is always required, nothing is saved until you press Save.", "wide"),
   ("desktop-rejected", "Rejected rule", "Leverage, skipped simulation, percentage sizing and a missing spread, all reported at once.", "wide"),
   ("desktop-saved", "Saved strategies", "Read-only matches against the latest scan.", "wide"),
   ("mobile-parsed", "Mobile: strategy builder", "", "phone"),
 ]),
 ("trade", "Trade simulation", "Fresh quote, Binance-built transactions, Transaction API simulation, then your explicit approval.", [
   ("trade-passed", "Simulation passed", "The six-step pipeline and every trade field.", "wide"),
   ("trade-ready", "Explicit confirmation", "Confirm stays disabled until you tick the box, inside the 30-second quote window.", "wide"),
   ("trade-failed", "Simulation failed", "The simulator's reason; no way to confirm.", "wide"),
   ("trade-unverifiable", "Can't be simulated", "RFQ with an existing allowance: nothing to simulate, so it's blocked rather than passed.", "wide"),
   ("trade-mobile", "Mobile: trade preview", "", "phone"),
 ]),
 ("autonomy", "Autonomy", "The agent acts on one saved strategy inside your limits. In the web app, execution is always simulated.", [
   ("autonomy-desktop-form", "Authorize the agent", "Per-trade capped at the strategy's limit, daily count and cap, duration, explicit consent.", "wide"),
   ("autonomy-desktop-run", "Cycles and audit log", "Two simulated fills, then a refusal at the daily limit. Every attempt is an audit record marked SIMULATED.", "wide"),
   ("autonomy-mobile-form", "Mobile: authorize", "", "phone"),
   ("autonomy-mobile-run", "Mobile: audit log", "", "phone"),
 ]),
]

def fig(name, title, cap, kind):
    return f'''<figure class="fig {kind}"><button class="shot" type="button" aria-label="Enlarge: {html.escape(title)}"><img src="{uri(name)}" alt="{html.escape(title)}" loading="lazy" decoding="async"></button><figcaption><strong>{html.escape(title)}</strong>{(" " + html.escape(cap)) if cap else ""}</figcaption></figure>'''

nav, body, total = "", "", 0
for sid, title, intro, figs in SECTIONS:
    total += len(figs)
    nav += f'<a href="#{sid}">{title}<span>{len(figs)}</span></a>'
    groups = [(k, "".join(fig(*f) for f in figs if f[3] == k)) for k in ("wide", "third", "phone")]
    body += f'<section id="{sid}" aria-labelledby="{sid}-h"><header class="sec-head"><h2 id="{sid}-h">{title}</h2><p>{intro}</p></header>' + "".join(f'<div class="grid-{k}">{g}</div>' for k, g in groups if g) + "</section>"

CSS = open(__file__.replace("make-tour.py", "tour.css")).read()
page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>GapPilot: screen tour</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body>
<div class="wrap top">
  <div class="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="12" height="4" rx="1" fill="#f0a73a"/><rect x="9" y="14" width="12" height="4" rx="1" fill="currentColor"/><rect x="15.5" y="6" width="1.5" height="12" fill="#f0a73a" opacity=".55"/></svg>GapPilot</div>
  <h1>Screen tour</h1>
  <p class="lede">Every screen built so far, from Weekend Mode to simulated autonomous execution, captured from the production build at desktop and phone sizes.</p>
  <p class="note"><b>About the data:</b> the build environment can't reach Binance, so these screens were rendered with fictional tickers (ACME, GLBX, XYZ…) and synthetic prices fed into GapPilot's real engine, agent, simulation and execution policy. Layouts and logic are real; the numbers aren't market data, and all execution shown is simulated.</p>
</div>
<nav class="toc" aria-label="Sections"><div class="wrap">{nav}</div></nav>
<main class="wrap">{body}<footer>{total} screens. Click any screenshot to see it full size; phone screens open at full length.</footer></main>
<dialog id="lightbox" aria-label="Screenshot"><button class="close" type="button" aria-label="Close">Close</button><div class="inner"><img id="lightbox-img" alt=""></div></dialog>
<script>(()=>{{const d=document.getElementById("lightbox"),i=document.getElementById("lightbox-img");document.querySelectorAll(".shot").forEach(b=>b.addEventListener("click",()=>{{const s=b.querySelector("img");i.src=s.src;i.alt=s.alt;d.querySelector(".inner").scrollTop=0;d.showModal();}}));d.querySelector(".close").addEventListener("click",()=>d.close());d.addEventListener("click",e=>{{if(e.target===d)d.close();}});}})();</script>
</body></html>'''
open(out, "w").write(page)
print(f"{total} screens, {len(page)//1024} KB")
