/**
 * Builds the hosted test app: ONE self-contained HTML file.
 *   node scripts/build-demo.mjs [out.html]
 * Bundles src/demo/main.tsx (the real dashboard + in-browser API on a simulated
 * Binance backend) and the app's real Tailwind stylesheet.
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const out = process.argv[2] ?? "dist-demo/gappilot-test-app.html";
const shim = (p) => path.join(root, "src/demo/shims", p);

const js = await build({
  entryPoints: ["src/demo/main.tsx"],
  bundle: true,
  minify: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: ["es2020", "safari15"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  alias: { "node:crypto": shim("crypto.ts"), "node:fs": shim("empty.ts"), "node:path": shim("empty.ts"), "server-only": shim("empty.ts") },
  logLevel: "warning",
});
const code = js.outputFiles[0].text;

// Fail-safe: nothing server-side or live-execution may reach the browser bundle.
for (const banned of ["child_process", "BinanceAgenticWalletProvider", "OPENAI_API_KEY", "api.openai.com", "nodeCliRunner"]) {
  if (code.includes(banned)) throw new Error(`demo bundle must not contain "${banned}"`);
}

const cssIn = readFileSync("src/app/globals.css", "utf8");
const css = (await postcss([tailwind({ base: root })]).process(cssIn, { from: path.join(root, "src/app/globals.css") })).css;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#101820">
<title>GapPilot test app</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>${css}
/* Hosted demo: keep content clear of phone system bars. */
:root { box-sizing: border-box; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
html { scroll-padding-top: env(safe-area-inset-top, 0px); }
@media (min-width: 1024px) { html, body { height: 100%; } }
</style>
</head>
<body>
<div id="root"></div>
<noscript>GapPilot needs JavaScript.</noscript>
<script>${code.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>`;
writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1024).toFixed(0)} KB (js ${(code.length / 1024).toFixed(0)} KB, css ${(css.length / 1024).toFixed(0)} KB)`);
