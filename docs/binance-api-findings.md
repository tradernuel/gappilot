# Binance Web3 API — investigation log

Working notes from phase 1. They feed the Developer Experience Report (25% of
the hackathon score), so they record *where* each fact came from and *what was
hard*, not just the answer.

Investigation date: 2026-10-08.

## Sources, in order of trust

1. **`@binance-web3/wallet@13.0.1`** — Binance's official generated JS connector,
   published 2026-10-02 from `github.com/binance/binance-web3-connector-js`.
   Its `.d.ts` models carry the spec's field descriptions and every method links
   to a doc anchor under `https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/...`.
   **This is the source of truth for every path, parameter and type in GapPilot.**
2. **`@binance-web3/common@1.1.2`** — the connector's transport. Source of truth
   for signing, base URL, headers and envelope handling.
3. **developers.binance.com `llms.txt`** — confirmed the Agentic Wallet / Wallet
   Skills product pages exist; the Web3 Open API itself is not indexed there.
4. **Hackathon blog** (bnbchain.org, 2026-09-16) — rules: BSC mainnet, spot only,
   bStocks/Ondo/xStocks central, "dry-run with the Transaction API".
5. **Other teams' public repos** — used only to flag things to verify. Nothing in
   GapPilot's code depends on a claim from this tier.

The docs site itself (`web3.binance.com/en/dev-docs`) renders client-side and
could not be read by a non-browser fetcher. **DevEx note:** a static or
`llms.txt` export of the Web3 API reference would remove the need to reverse-
engineer the SDK to get a machine-readable contract.

## Transport contract (verified against the SDK source)

| Item | Value |
|---|---|
| Base URL | `https://web3.binance.com/build` |
| Auth | Every endpoint we use is signed (`isSigned: true` on all SDK calls) |
| Headers | `X-OC-APIKEY`, `X-OC-TIMESTAMP` (ISO-8601), `X-OC-SIGN`, optional `X-OC-RECV-WINDOW` (default 5000, max 60000), optional `X-OC-NONCE` (falls back to the signature) |
| Prehash | `timestamp + METHOD + requestPath + body`, no separators |
| `requestPath` | Path **including the `/build` prefix** plus the raw query string, e.g. `/build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0xa%2C0xb` |
| Signature | base64(HMAC-SHA256(secret, prehash)); Ed25519 keys also supported |
| Envelope | `{ code, msg, data, timestamp, success }`; `code === 0` is success; non-zero is an error even on HTTP 200 |
| Rate-limit headers | `x-oc-ratelimit-limit`, `x-oc-ratelimit-remaining`, `x-oc-used-weight`, `retry-after` |
| Query encoding | `URLSearchParams` (commas become `%2C`); the encoded form is what gets signed |

The `/build` prefix in the prehash is the easiest thing to get wrong: `new URL("/api/v1/...", "https://web3.binance.com/build")`
silently drops `/build`. The SDK re-adds it explicitly. GapPilot's `buildRequestTarget`
builds the wire URL and the signed path from the same string so they cannot drift.

## Findings that shaped the design

### F1. `referencePrice` is not an independent stock price

Spec text on `referencePrice` (rwa/tokens, rwa/price, rwa/underlying-market):
it is a per-share price derived from the on-chain token price, explicitly not
an official quote from the traditional stock market.

Consequences:
- `tokenPrice` vs `referencePrice` measures the token-to-share conversion, not
  the weekend gap the hackathon brief describes.
- No RWA or Market endpoint returns an official last close, or a timestamp for
  the TradFi reference.
- The only documented price-age field is `tokenPriceUpdatedAt` on `/rwa/price`
  (age of the *on-chain* price).

Design response: GapPilot's primary signal is **cross-issuer divergence**
(bStocks vs Ondo, same ticker, normalised per share by `tokenToShareRatio`).
A token-vs-official-close signal is behind the `ReferencePriceProvider` seam and
stays off until a real source is wired.

**DevEx note:** the field name `referencePrice` strongly implies the opposite of
what the description says. Builders who skim will compute a fake gap.

### F2. Equity/RWA tokens always execute as RFQ

From `/quote` and `/swap` descriptions: equity/RWA tokens always return
`executionMode = "RFQ"`. Flow:

1. `GET /aggregator/quote` with `userWalletAddress` (required for RFQ routes)
2. `GET /aggregator/swap` with `quoteId` (TTL ≈ 30s) → `rfq.typedDataToSign`
3. Wallet signs with `eth_signTypedData_v4`
4. `POST /aggregator/order/submit` (`requestId` UUID = idempotency key, 30 min)
5. Poll `GET /aggregator/order/{orderId}` → `FILLED | FAILED | EXPIRED | CANCELLED`

Approvals for RFQ go to a vendor-specific spender (1inch router, PcsX Permit2,
CowSwap VaultRelayer); `/approve-transaction` needs `vendor` for Ondo/bStocks.

### F3. Simulation coverage for RFQ is unclear

`POST /pre-transaction/simulate` takes an EVM tx (`from, to, value, data`).
It can simulate the ERC-20 approve. The RFQ fill is settled by the vendor's
relayer from an off-chain signature, so there is no user-side tx to simulate.

GapPilot's planned "simulatable before execution" gate for RFQ trades:
- simulate the approve tx (if an approval is needed),
- fresh quote + `/swap` build with no signature (a true dry run),
- decode `typedDataToSign` and check receiver = user wallet, sell amount = quote,
  min-receive within slippage, deadline in the future,
- check balances via the Wallet API.

**Must confirm with Binance** whether this satisfies the "every trade must be
simulatable" requirement, or whether `/simulate` accepts something for RFQ.

### F4. Agentic Wallet is a CLI with a local session

`@binance/agentic-wallet` (bin: `baw`, v1.10.0) signs in by QR scan in the
Binance app and keeps a local session. It exposes `market-order quote/swap`,
limit orders, balance, etc. That is a poor fit for Vercel serverless functions.
Planned integration: a separate long-running agent worker that receives an
already-validated, already-simulated trade plan from GapPilot.

## Documentation / SDK inconsistencies (for the DevEx report)

| # | Where | What |
|---|---|---|
| D1 | `POST /market/price`, `POST /market/price-info` | Generated SDK sends an empty body; the request body schema is missing from the machine-readable spec. Not wired in GapPilot. |
| D2 | `POST /aggregator/order/submit` → `quoteId` | Described as "`rfq.orderId` from the `/swap` response", but the documented `rfq` object has no `orderId` field. |
| D3 | `GET /aggregator/order/{orderId}` | SDK puts `orderId` in the body of a GET as well as in the path. GapPilot sends it only in the path. |
| D4 | `/simulate`, `/gas-limit` | `evmTx`, `solTx`, `tronTx` all marked required "for rendering purposes only"; the real rule (exactly one) is only in prose. |
| D5 | `decimals` | String in `/rwa/tokens`, number in `/market/token/basic-info`. |
| D6 | `/transaction-detail-by-txhash` | Response uses `chainIndex`; every other endpoint uses `binanceChainId`. Path is `post-transaction/...` but the docs group it under Wallet API. |
| D7 | `/simulate` → `status` | Only `SUCCESS` given as an example; no enum. |
| D8 | `/rwa/*` `marketStatus` | Enumerated only in prose. |
| D9 | SDK default timeout | 1000 ms — too tight for `/quote` and `/swap` from a serverless cold start. |
| D10 | Docs site | Client-rendered; no static/`llms.txt` export of the Web3 API reference. |
| D11 | `POST /market/token/basic-info` | A POST whose parameters go in the query string, with no body. |
| D12 | `/pre-transaction/simulate` vs RFQ | Equity trades are always RFQ; `approveTarget` is null once approved, so a repeat trade has **no transaction to simulate**. The docs don't say how to simulate an RFQ order. GapPilot blocks these as UNVERIFIABLE. **Question for Binance:** is there a supported way to simulate RFQ settlement? |
| D13 | `/aggregator/quote` → `router` | Named like a contract address, but documented as "routing path description, addresses joined with `--`". The router contract is `tx.to` from `/swap`. |
| D15 | Agentic Wallet CLI | `baw market-order swap` has no quote ID or minimum-output parameter, and the JSON quote strips `quoteId`; a swap can't be bound to a simulated transaction. Option lists and JSON shapes are only discoverable from `--help` and the bundled source. 6 releases in 2 months; UNLICENSED, no public repo. |
| D16 | Agentic Wallet session | Session in the OS keychain (`keytar`) after QR sign-in, so the wallet is desktop-only and not usable from serverless backends. |
| D17 | `rwa/tokens` (live) | **Found on the first live deploy:** `marketCap` is `null` for some tokens although the spec types it as a string. GapPilot's strict response check stopped the scan. Response schemas now accept `null` for optional scalar fields (types widened to `T \| null`, 7 code paths fixed); wrong types (e.g. a number for a price) are still rejected. |
| D14 | Gas units | Documented consistently in wei (gas-price, approve `gasPrice`, swap `gasPrice`); no USD gas except quote `tradeFee`. GapPilot converts approval gas to USD with `tradeFee ÷ estimateGasFee` from the same quote. |

## Third-party claims to verify with live calls

Reported in other hackathon teams' public repos. Not relied on.

- `marketStatus` returned `null` while `reasonCode = TRADING` (after US hours).
- `/rwa/tokens?tabId=3` (Upcoming Earnings) returned every bStock.
- 3 concurrent requests triggered HTTP 429 → GapPilot limits concurrency to 2.
- Missing key returns HTTP 401 with `code 40101`.
- `/swap` returns both `tx` and `rfq` objects, with the inapplicable one empty.

## Environment notes

- npm 10 crashes with `Cannot read properties of null (reading 'edgesOut')`
  while resolving optional peer sets in this tree. `.npmrc` sets
  `legacy-peer-deps=true`; `vite` is therefore listed explicitly because
  Vitest 5 declares it as a peer.
- The build sandbox used for phase 1 could not reach `web3.binance.com`, so
  **no live call has been made yet**. `npm run smoke` is the first-call test.

## Phase 2 notes (API integration)

- **Response strictness.** Response schemas follow the SDK's field types
  exactly (decimal values as strings, timestamps as numbers) but accept unknown
  extra fields. If a live response returns, say, `tokenPrice` as a number, the
  call fails with `kind: "parse"` and `issues: [{ path: "data.0.tokenPrice" }]`.
  That is deliberate: a silent type drift would become `NaN` in gap maths. If it
  happens, record it here as a docs-vs-reality finding before loosening the schema.
- **Timeouts.** One `AbortSignal.timeout` covers connect and body read. Timed-out
  GETs are retried (max 2); POSTs never are.
- **Total vs partial failure.** `RwaService` returns partial results with an
  `errors` list when some sub-calls fail, but throws the upstream error when all
  of them fail, so a dead API key can't look like an empty market.
- **No execution surface.** The `submitRfqOrder` stub from phase 1 was removed.
  No client method submits an order or broadcasts a transaction.
- **Still no live call** from the build environment (egress blocked). First real
  evidence will come from `npm run smoke -- --wallet 0x... --save`.

## Phase 7 notes (simulation)

- Visual QA caught two fixture bugs through the production safety checks themselves: a 38-character
  wallet address (rejected by input validation), and a fake backend that didn't echo the requested amount
  (flagged by the approve-amount and RFQ sell-amount checks). Both were test-tooling errors; the checks
  behaved as intended.
- **Still no live call.** The first live run should start with `npm run smoke -- --wallet 0x... --save`,
  then a dashboard simulation from a wallet that has not yet approved the stablecoin, the only RFQ case
  with a transaction to simulate.

## Phase 8 notes (execution providers)

- **Agentic Wallet contract used** (v1.10.0, read from README + CLI source): every command with `--json` prints
  `{"success":true,"data":…}` or `{"success":false,"error":{code,name,message}}` (exit 1). Fields used:
  `wallet status → status`, `wallet address → addresses[].{binanceChainId,address}`, `wallet tx-lock → status`,
  `wallet left-quota → quotaLeft`, `market-order quote → toCoinAmount, slippage (fraction)`,
  `market-order swap → orderId`, `market-order list --orderId → list[].{status,txHash,toTokenActualQty}`.
  The adapter pins `1.10.x` and fails closed on anything else.
- **Questions for Binance:** (1) a way to execute or bind to a specific quote/transaction from the Agentic Wallet;
  (2) a documented, versioned JSON schema for `--json`; (3) whether `/pre-transaction/simulate` can cover the
  Agentic Wallet's router path.
- Tests and the worker caught three test-tooling mistakes through the production guards: an invalid test strategy
  (slippage equal to threshold), restarting fake quote IDs (refused as DUPLICATE), and a per-cycle grant in a
  daily-limit test (usage is per grant, by design).
