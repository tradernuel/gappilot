/**
 * DEMO ONLY. Installs the in-browser /api/* router and a demo wallet before the
 * app renders. Nothing here exists in the deployed Next.js app.
 */
import { Buffer } from "./shims/buffer";
import { handleApi } from "./api";
import { DEMO_WALLET } from "./backend";

// GapPilot's signing code uses the Node global `Buffer`.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

const realFetch = globalThis.fetch.bind(globalThis);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw, "https://gappilot.demo");
  if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
  await delay(250 + Math.random() * 450); // feel like a network round trip
  const method = (init?.method ?? "GET").toUpperCase();
  let body: Record<string, unknown> = {};
  if (init?.body && typeof init.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      return new Response(JSON.stringify({ ok: false, error: { kind: "validation", message: "Body must be JSON" } }), { status: 400 });
    }
  }
  try {
    return await handleApi(url.pathname, method, url, body);
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: { kind: "internal", message: e instanceof Error ? e.message : "Demo error" } }), { status: 500 });
  }
};

// First visit: connect the demo wallet automatically so quotes (RFQ needs a wallet) work
// immediately. Disconnecting in the header is respected afterwards.
try {
  if (!localStorage.getItem("gappilot:demo:initialized")) {
    localStorage.setItem("gappilot:demo:initialized", "1");
    localStorage.setItem("gappilot:wallet-connected", "1");
  }
} catch {
  /* storage unavailable: the user can press Connect wallet */
}

// Demo wallet: read-only EIP-1193 on BSC. It never signs anything (GapPilot never asks it to).
const demoProvider = {
  isGapPilotDemo: true,
  request: async ({ method }: { method: string }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [DEMO_WALLET];
    if (method === "eth_chainId") return "0x38";
    if (method === "wallet_switchEthereumChain") return null;
    throw Object.assign(new Error("The demo wallet only shares its address."), { code: 4200 });
  },
  on() {},
  removeListener() {},
};
try {
  Object.defineProperty(window, "ethereum", { value: demoProvider, configurable: true, writable: true });
} catch {
  /* an extension locked window.ethereum; the app will use it read-only */
}
