# @haven_ai/demo-merchant-mcp

Internal x402 demo merchant MCP server for Haven. It exposes a small fake
merchant catalog, gates purchases with standard x402 `PAYMENT-SIGNATURE`,
supports ERC-7710 and EIP-3009 settlement options for Base USDC, and returns
Swedish invoice-style output.

This package is a technical demo for a merchant-controlled wallet, not a Haven
custody, facilitator, acquiring, fiat/card, third-party merchant settlement, or
merchant-of-record product. Funds do not flow through Haven.

## What It Demonstrates

- MCP tools that return x402 payment requirements when no valid payment header
  is present.
- Base USDC x402 `exact` payments using ERC-7710 smart-account delegation or
  EIP-3009 authorization.
- Standard x402 headers: `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and
  `PAYMENT-RESPONSE`.
- Haven compatibility: `X-PAYMENT` is accepted as an alias for
  `PAYMENT-SIGNATURE` while Haven SDK clients transition.
- Merchant self-settlement with EIP-3009 `transferWithAuthorization`; the
  submitter key only pays gas and does not need to be the receiving wallet.
- ERC-7710 settlement by simulating and submitting `redeemDelegations` against
  an operator-configured trusted DelegationManager. The submitter key is the
  redeemer; it is not a Haven key and cannot spend without a buyer-signed
  delegation that allows the merchant payment.
- Tiny test prices for repeatable agent-payment demos.
- In-process duplicate/nonce handling and payment verification before tool
  handlers run.
- The x402 v2 extensions echo, advertised in every challenge and enforced on
  every payment (see [Extensions echo](#extensions-echo-x402-v2-enforced)).
- Swedish invoice text and JSON output after a settled purchase.

## Products

| Product | Tool | Price |
|---|---|---|
| NordShield VPN Basic | `buy_vpn` | 0.001 USDC |
| NordShield VPN Pro | `buy_vpn` | 0.003 USDC |
| NordShield VPN Ultra | `buy_vpn` | 0.005 USDC |
| CloudNest 50 GB | `buy_cloud_storage` | 0.0005 USDC |
| CloudNest 200 GB | `buy_cloud_storage` | 0.0015 USDC |
| CloudNest 1 TB | `buy_cloud_storage` | 0.004 USDC |

Every product advertises x402 capability metadata through `list_products`:

- `network`: `eip155:8453` on prod/mainnet, or `eip155:84532` when configured for dev/testnet
- `asset`: USDC
- `settlement_methods`: `eip3009`, `erc7710` when both are enabled
- `default_settlement_method`: `eip3009`
- `resource_url`: the configured merchant MCP URL
- `hosted_urls`: the canonical dev and prod MCP URLs

`list_products` also returns a `structuredContent.products` array — one stable,
machine-readable record per product (`product_id`, `display_name`,
`price_atomic`, `asset`, `network`, `billing_period`, `tool_name`,
`arguments_schema`, `supported_settlement_methods`, `default_settlement_method`,
`mcp_url`, `environment`) — so an agent can pick e.g.
`buy_cloud_storage { tier: "50gb" }` without parsing the localized `description`
prose. `supported_settlement_methods` always lists `eip3009` first when present;
`erc7710` only appears when the merchant enabled it (operator config pinned to
Haven's registered DelegationManager — see below).

A successful `buy_vpn`/`buy_cloud_storage` call also returns a
`structuredContent.summary` object — `{ status: 'confirmed', product_id,
product_name, invoice_id, amount_atomic, amount, asset, network,
settlement_tx_hash }` — for agent-facing purchase reporting. It is
**display/reporting data only**: it never replaces the `x-receipt-json` header,
the invoice, or on-chain settlement state as the source of truth for
bookkeeping/reconciliation, and every field is read off the already-settled
payment (never re-derived from the quoted catalog price).

Purchase tools accept an optional `settlement_method` argument:

- omitted: uses `eip3009`, which keeps current Haven SDK and generic x402 clients compatible
- `erc7710`: pays directly from a smart account through the configured DelegationManager
- `eip3009`: uses the EIP-3009 fallback path

Default payment requirements keep the EIP-3009 option first because existing
Haven SDK clients select the first matching Base USDC `exact` option and do not
yet inspect `extra.assetTransferMethod`. ERC-7710-aware clients should select
the option tagged with `assetTransferMethod: "erc7710"` explicitly.

## Extensions echo (x402 v2, enforced)

Every 402 challenge this merchant issues carries an `extensions` object, and
every payment must echo it. Since #2361 the challenge advertises exactly this
(`DEMO_MERCHANT_EXTENSIONS` in `src/x402.ts`):

```json
"extensions": {
  "haven-demo": {
    "version": "1",
    "echoRule": "x402 v2: clients must echo this extensions object in PaymentPayload"
  }
}
```

The rule (`assertExtensionsEchoed` in `src/x402.ts`) is the first thing
`verifyAndSettle` does after decoding the payment header — **before** scheme
dispatch, so it applies identically to `eip3009` and `erc7710` payments and
runs before any signature recovery, delegation simulation, RPC call or
settlement work. In order:

1. **`x402Version` must equal the challenge's (`2`).** Checked first, on every
   payload, and independently of the echo: a mismatch is refused even when the
   extensions are echoed perfectly, and a payload that declares
   `x402Version: 1` cannot use that to skip the echo rule. This merchant only
   issues v2 challenges and has no v1 verification path.
2. **`extensions` must be present and be an object** (not absent, `null`, a
   string or an array).
3. **Every advertised key must be present with a deep-equal value.** The
   check is subset containment, not byte equality: you may **append** keys —
   at the top level (`"clientNote": {...}`) or inside `haven-demo` — which is
   the spec's "may append additional info". **Deleting** any advertised key
   (including a nested one such as `echoRule`), sending `{}`, or **changing**
   any advertised value is refused.

A refused payment gets **HTTP 402** with the same challenge again — re-sent in
the `PAYMENT-REQUIRED` header and as the JSON body — with the body's `error`
replaced by the reason. There is no `PAYMENT-RESPONSE` and nothing is settled.
The exact strings, captured from the running merchant:

| Payload | `error` in the 402 body |
|---|---|
| `x402Version` is not `2` (with or without an echo) | `Payment x402Version 1 does not match the challenge's 2` |
| `extensions` absent or not an object | `Payment must echo the challenge's extensions object (x402 v2 extensions echo rule)` |
| an advertised key dropped (top-level or nested), `extensions: {}`, or a value changed | `Payment extensions must include the challenge's extensions unmodified (x402 v2: append-only, never delete or overwrite)` |

The same enforcement applies whether the payment arrives as `PAYMENT-SIGNATURE`
or the `X-PAYMENT` alias.

**Why this merchant is strict where real merchants may be lenient.** The x402
v2 spec makes the echo a client MUST, but live merchants differ: CoinGecko's
facilitator rejects a payment that drops it with a bare 400 (#2360), while
others settle the echo-less shape. This merchant is the counterparty the QA
harness settles against on Base Sepolia, so if it were lenient, CI would go
green for a Haven client that stopped echoing and the first strict mainnet
facilitator would find the regression instead. The net is deliberate — it
caught #2373 in a single QA run — and the refusal names the rule rather than
returning a bare 400.

**Building a payment fixture by hand?** Copy a working pattern instead of
inventing one. After decoding the challenge as `pr`, the in-repo test helpers
all echo it with
`...(pr.extensions ? { extensions: pr.extensions } : {})`: `signedHeader` in
`src/x402.test.ts`, `src/http.test.ts` and `src/http-session-restart.test.ts`,
and `erc7710Header` in `src/erc7710.test.ts`. The rule's own tests are
`describe('extensions echo rule (#2361)')` in `src/x402.test.ts`, one per
branch of `assertExtensionsEchoed`: the version cross-check (with a dropped
echo, and with a perfect one), an absent or non-object echo, a dropped key
(top-level and nested), `{}`, an overwritten value, an append, and a challenge
that advertises no extensions. The three refusal strings in the table above,
the re-sent `PAYMENT-REQUIRED` challenge and the `X-PAYMENT` alias are pinned
at the HTTP boundary by `describe('extensions echo refusals over HTTP (#2403)')`
in `src/http.test.ts`. Haven's real clients echo through the SDK's
`x402V2PaymentEnvelope`, which the edge signer also uses.

## Hosted URLs

Use the hosted merchant URL for partner or agent runtime testing. Use localhost
only when you are intentionally running this package on your machine.

| Environment | MCP URL |
|---|---|
| Dev demo merchant (Base Sepolia) | `https://demo-merchant-dev-84e4.up.railway.app/mcp` |
| Production demo merchant (Base mainnet) | `https://enthusiastic-blessing-production-171f.up.railway.app/mcp` |
| Local-only merchant | `http://localhost:3456/mcp` |

Routing rule:

- Haven dev / Base Sepolia (`eip155:84532`) -> `https://demo-merchant-dev-84e4.up.railway.app/mcp`
- Haven prod / Base mainnet (`eip155:8453`) -> `https://enthusiastic-blessing-production-171f.up.railway.app/mcp`

Hosted deployments derive the default `BASE_URL` from `MERCHANT_CHAIN_ID`.
If a hosted deploy accidentally receives a localhost `BASE_URL`, it falls back
to the canonical hosted URL so generated requirements and tool metadata do not
point hosted agents at a local merchant. Agents can also read `GET /` or
`GET /.well-known/haven-demo-merchant` on either deployment to discover the
current environment, chain, MCP URL, and both hosted routing targets.

This standalone MCP service is the CloudNest/NordShield x402 demo merchant.
Do not confuse it with backend demo surfaces:

- Backend `/demo/mpp/*` is the internal Machine Payment Protocol smoke-test
  resource. It is not the CloudNest/NordShield merchant and does not expose the
  `buy_cloud_storage` or `buy_vpn` tools.
- The retired backend `/x402/resources/*` surface was an experimental x402
  resource registry/API, not the hosted MCP merchant deployment agents should
  use for demo product purchases. It is no longer registered; this package is
  the standalone merchant path.

## Run

```sh
MERCHANT_ADDRESS=0xYourBaseUsdcReceivingWallet \
BASE_RPC_URL=https://base-mainnet.example/rpc \
SETTLEMENT_PRIVATE_KEY=0xGasFundedSubmitterPrivateKey \
MERCHANT_X402_SETTLEMENT_METHODS=eip3009,erc7710 \
MERCHANT_ERC7710_DELEGATION_MANAGER=0xTrustedDelegationManager \
BASE_URL=http://localhost:3456 \
PORT=3456 \
npm run dev -w packages/demo-merchant-mcp
```

Endpoints:

- `POST /mcp` - MCP endpoint and x402-gated resource
- `GET /healthz` - liveness

`MERCHANT_ADDRESS` is required and must be the Base address that receives USDC.
`SETTLEMENT_PRIVATE_KEY` is the gas-funded key that submits USDC
`transferWithAuthorization`; it does not need to be the receiving wallet and
should not hold user or agent funds.

`MERCHANT_X402_SETTLEMENT_METHODS` defaults to EIP-3009 only unless the trusted
DelegationManager is configured. If `erc7710` is requested but the manager is
missing or does not match the pinned Haven DelegationManager for the configured
chain, the merchant starts and advertises EIP-3009 only; explicit ERC-7710
purchases are refused instead of crashing the hosted process. Set
`MERCHANT_X402_SETTLEMENT_METHODS=eip3009` for an EIP-3009-only fallback or
local-only merchant.

**`MERCHANT_CHAIN_ID`** selects the chain (default `8453`, Base mainnet). Set it
to **`84532`** for a **Base Sepolia** testnet deploy — e.g. the dev instance used
by the QA harness (#575). On Base Sepolia the merchant uses Circle's testnet USDC
(`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) and the correct per-chain EIP-712
domain name (`"USDC"` vs mainnet's `"USD Coin"`). `BASE_RPC_URL` must point at the
matching chain's RPC (Base mainnet, or `https://sepolia.base.org` for Sepolia),
and `SETTLEMENT_PRIVATE_KEY` must be gas-funded on that chain.

## QA hook: verify-without-settle (testnet-only)

`MERCHANT_SKIP_SETTLE_PRODUCT=<product_id,...>` (#603) verifies listed
products' payments but skips on-chain settlement — the QA sweep-recovery
scenario uses it to strand the delegate deterministically. It is
**testnet-only, enforced in code**: startup fails unless
`MERCHANT_CHAIN_ID=84532`, because a skipped settlement also skips the only
balance check — on any real chain a listed product would hand out goods
against a well-formed authorization from an empty wallet.

## ERC-7710 Smart-Account Payments

ERC-7710 is the preferred smart-account demo flow when the required
DelegationManager is configured for the selected Base environment. The manager
must match the in-repo Haven pin used by the backend
(`0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` for Base mainnet and Base
Sepolia today); bare environment values that point elsewhere are ignored for
ERC-7710 advertising.

Decision recorded 2026-08-10: mainnet ERC-7710 is permitted for this demo
merchant only when the operator-configured manager matches the pinned registry;
the old #747 "mainnet must never advertise erc7710" guard is replaced by that
pin-and-refuse posture.

A smart account (the **delegator**) pays by presenting a signed ERC-7710
delegation instead of an ECDSA authorization; the payload carries `delegator`,
`delegationManager`, and `permissionContext`. There is no signature recovery:
the merchant **verifies by simulating**
`delegationManager.redeemDelegations([permissionContext], [mode],
[executionCallData])` (the calldata encodes `USDC.transfer(merchant, amount)`),
then settles by submitting that same call from `SETTLEMENT_PRIVATE_KEY`.

Because the merchant self-settles, the settlement key is the **redeemer** — a
delegation with a redeemer caveat must name the settlement account. Each
delegation settles at most one product here (in-process dedupe keyed on the
`permissionContext` hash); scoping of token, amount, recipient, and expiry is
enforced on-chain by the delegation's caveats.

## Smoke Tests

Discovery:

```sh
curl -fsS https://enthusiastic-blessing-production-171f.up.railway.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_products","arguments":{}}}'
```

Machine-readable environment discovery:

```sh
curl -fsS https://demo-merchant-dev-84e4.up.railway.app/.well-known/haven-demo-merchant
curl -fsS https://enthusiastic-blessing-production-171f.up.railway.app/.well-known/haven-demo-merchant
```

Default EIP-3009 quote:

```sh
curl -i -sS https://enthusiastic-blessing-production-171f.up.railway.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"buy_vpn","arguments":{"plan":"basic"}}}'
```

Explicit EIP-3009 fallback quote:

```sh
curl -i -sS https://enthusiastic-blessing-production-171f.up.railway.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"buy_vpn","arguments":{"plan":"basic","settlement_method":"eip3009"}}}'
```

Explicit ERC-7710 quote, only when the pinned DelegationManager is configured:

```sh
curl -i -sS https://enthusiastic-blessing-production-171f.up.railway.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"buy_vpn","arguments":{"plan":"basic","settlement_method":"erc7710"}}}'
```

The payment retry must reuse the same MCP request and include a
`PAYMENT-SIGNATURE` or `X-PAYMENT` header signed by the buyer wallet or agent
runtime. The merchant cannot spend from a Haven wallet or agent budget with an
API credential alone.

## Test With Haven

1. Create a Haven agent with a small Base USDC agent budget.
2. Connect the agent through hosted MCP or a direct SDK/MCP integration.
3. Ask the agent to list products, inspect the price, and buy one product.
4. The merchant returns an x402 challenge.
5. Haven funds and tracks the budget-constrained leg when needed.
6. The agent signs the merchant payment header with its own wallet or agent
   runtime key and retries the same request with `PAYMENT-SIGNATURE` or Haven's
   compatible `X-PAYMENT` alias.
7. The merchant settles the selected method, returns `PAYMENT-RESPONSE`, and
   includes the settlement tx in the invoice.

Keep the amount tiny and demo-only. Do not use this package for third-party
merchant acceptance, merchant dashboards, fees, fiat/card, swaps, refunds, or
production settlement without separate product, legal, and security review
under [`docs/regulatory/casp-risk-guardrails.md`](../../docs/regulatory/casp-risk-guardrails.md).
