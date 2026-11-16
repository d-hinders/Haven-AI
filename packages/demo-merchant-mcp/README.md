# @haven_ai/demo-merchant-mcp

Internal x402 demo merchant MCP server for Haven. It exposes a small fake
merchant catalog, gates purchases with standard x402 `PAYMENT-SIGNATURE`,
supports ERC-7710 and EIP-3009 settlement options for Base USDC, and returns a
Swedish-style invoice.

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
- Two settlement paths (see [Settlement paths](#settlement-paths-4852)):
  merchant self-settlement with EIP-3009 `transferWithAuthorization` for every
  product but the joke — the submitter key only pays gas and does not need to
  be the receiving wallet — and, for the joke only, verification and settlement
  by Coinbase's hosted facilitator (CDP).
- ERC-7710 settlement by simulating and submitting `redeemDelegations` against
  an operator-configured trusted DelegationManager. The submitter key is the
  redeemer; it is not a Haven key and cannot spend without a buyer-signed
  delegation that allows the merchant payment.
- Tiny test prices for repeatable agent-payment demos.
- In-process duplicate/nonce handling and payment verification before tool
  handlers run.
- The x402 v2 extensions echo, advertised in every challenge and enforced on
  every payment (see [Extensions echo](#extensions-echo-x402-v2-enforced)).
- An invoice after a settled purchase: Swedish bookkeeping JSON (also sent as
  the `x-receipt-json` header) and a rendered text, English by default and
  Swedish with `locale: 'sv'` (#1550).
- Stripe machine payments (#4853): with a deposit address and a restricted key
  configured, the joke is paid to the Stripe deposit address and each settled
  payment is recorded as a PaymentIntent in `transaction_verification` mode,
  keyed on the transaction hash. A reconciliation script records the ones the
  request path missed.

## Products

| Product | Tool | Price |
|---|---|---|
| NordShield VPN Basic | `buy_vpn` | 0.001 USDC |
| NordShield VPN Legacy | `buy_vpn` | 0.001 USDC, EIP-3009 only |
| NordShield VPN Pro | `buy_vpn` | 0.003 USDC |
| NordShield VPN Ultra | `buy_vpn` | 0.005 USDC |
| CloudNest 50 GB | `buy_cloud_storage` | 0.0005 USDC |
| CloudNest 200 GB | `buy_cloud_storage` | 0.0015 USDC |
| CloudNest 1 TB | `buy_cloud_storage` | 0.004 USDC |
| Haven Joke (only with CDP configured) | `buy_joke` | 0.01 USDC, EIP-3009 only, one-time |

`vpn_legacy` (`plan: "legacy"`) is the one self-settled EIP-3009-only product
(#1441): the QA harness's hosted funding-leg scenario needs a merchant offer the
erc7710 preference cannot pick. The joke is EIP-3009-only too, but Coinbase's
facilitator settles it (see [Coinbase facilitator](#coinbase-facilitator-cdp-joke-product-4851)).
Every other product supports both methods.

Every product's x402 capability shows in `list_products`, in its text line and
in its `structuredContent.products` record:

- the network: `eip155:8453` on prod/mainnet, or `eip155:84532` when configured for dev/testnet
- the asset: USDC
- the settlement methods it supports: `eip3009`, plus `erc7710` when the
  merchant enabled it and the product supports it
- the default settlement method: the first supported one, which is `eip3009`
- the merchant MCP URL, and in the text line the hosted dev and prod routing
  targets

The discovery document (`GET /`, below) carries the same per-product methods
plus `hosted_urls` and `routing` for both deployments.

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
`structuredContent.summary` object — `{ status, product_id, product_name,
invoice_id, amount_atomic, amount, asset, network, settlement_tx_hash }` — for
agent-facing purchase reporting. `status` is `'confirmed'` with a real
`settlement_tx_hash` on a verified settlement; on the two paths with no
observed settlement (#2969) it is `'already_settled_earlier'` (the
authorization moved the money in an earlier transaction this process never
saw) or `'delivered_unsettled'` (the `MERCHANT_SKIP_SETTLE_PRODUCT` QA hook),
and `settlement_tx_hash` is `null` — never the zero hash. It is
**display/reporting data only**: it never replaces the `x-receipt-json` header,
the invoice, or on-chain settlement state as the source of truth for
bookkeeping/reconciliation, and every field is read off the already-settled
payment (never re-derived from the quoted catalog price).

Purchase tools (all but `buy_joke`, which offers one method) accept an optional
`settlement_method` argument. It decides
which option comes FIRST in the 402's `accepts`; every other method the product
and the merchant support is still offered after it:

- omitted: `eip3009` first, which keeps generic x402 clients compatible
- `erc7710`: the smart-account option first, paid through the configured
  DelegationManager
- `eip3009`: the EIP-3009 option first

A method the merchant has not enabled, or the product does not support, is
refused. The tools also take `locale` (`sv` for Swedish text) and
`result_detail` (`summary` drops the rendered invoice and the bookkeeping JSON
from the text; the structured content, including `summary`, and the
`x-receipt-json` header are the same either way).

A generic client that takes the first matching Base USDC `exact` option gets
EIP-3009 by default. Haven's clients read `extra.assetTransferMethod`: under
the #1450 preference rule, whose selector came with #1453, they prefer the option tagged `assetTransferMethod: "erc7710"` when the
account is on the delegation rail and fall back to EIP-3009 otherwise
(`selectX402SettlementScheme` in `packages/sdk/src/x402.ts`).

## Settlement paths (#4852)

Each product carries a settlement kind (`settlement` in `src/products.ts`, read
through `productSettlementKind`; #4850). There are two:

| | Own key (`self`) | Coinbase facilitator (`cdp`) |
|---|---|---|
| Products | the seven VPN and storage products, `vpn_legacy` included | the joke (`buy_joke`, 0.01 USDC) |
| Offered | always | only with `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` both set |
| Methods | EIP-3009, plus ERC-7710 when enabled (`vpn_legacy`: EIP-3009 only) | EIP-3009 only |
| Verifies | this merchant: signature, amount, recipient, window, or a simulated `redeemDelegations` | this merchant's own checks first, then CDP's `verify` (including its sanctions and risk screening) |
| Submits and pays gas | `SETTLEMENT_PRIVATE_KEY` | CDP |
| Receives the USDC | `MERCHANT_ADDRESS` | the Stripe deposit address when Stripe is on (#4853), else `MERCHANT_ADDRESS` |
| Readiness gate on the merchant's gas wallet | applies | exempt |
| After a failure | EIP-3009: the pre-submit `authorizationState` read (#1519); ERC-7710: the pinned enforcer's `spentMap` check (#1515) | the merchant's own chain read and event search ([Coinbase facilitator](#coinbase-facilitator-cdp-joke-product-4851)) |

In both, the merchant is paid in one transfer from the payer straight to
`MERCHANT_ADDRESS`; Haven is not a party to it. (For a Haven agent paying with
EIP-3009, the payer is its delegate wallet, which Haven's bridge funded from the
agent's budget just before — that funding leg is Haven's, not the merchant's.) A product's receiving address can
differ from `MERCHANT_ADDRESS` (#4850), and one does: the joke is paid to the
Stripe deposit address when Stripe recording is on (#4853, below).

**Why the joke is not in Haven's catalog.** The demo store's funding target —
which merchant-locked budgets are pinned to — is computed over all of its
active, verified catalog rows
(`MERCHANT_FUNDING_AGGREGATES_SQL` in
`packages/backend/src/infra/repositories/merchants.ts`): the rows must all
offer ERC-7710 and must agree on one `payTo`. One EIP-3009-only row would make
merchant-locked budgets for the demo store refuse with 409, failing the QA
`merchant-locked-budget` scenario, and a second receiving address (Stripe's
deposit address, epic #4849 M2) would make the target conflicting. Like
`vpn_legacy`, which has no catalog row either (and would hit the same refusal if
it had one), the joke is paid at
this merchant's MCP endpoint directly: quote, then pay, as for any MCP merchant
outside the catalog. Listing it would need a change to that aggregate.

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
`erc7710Header` in `src/erc7710.test.ts`, and `signSkipSettleHeader` in
`src/skip-settle-guard.test.ts`. The rule's own tests are
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

- The retired backend `/demo/mpp/*` surface was the internal Machine Payment
  Protocol smoke-test resource, never the CloudNest/NordShield merchant. #1328
  deleted it, and the dev backend answers 404 there.
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
- `GET /healthz` - liveness plus settlement-wallet readiness (#2490): when the
  settlement client can read its balance, the response carries a `settlement`
  block with `address`, `native_balance_wei`, `cost_per_settlement_wei`,
  `settlements_remaining`, the band `status` (`usable` | `warn` | `fail`) and
  both floors (`warn_floor` 25 / `fail_floor` 12) beside the legacy `ok`
  boolean (`ok` is true unless `status` is `fail`). A read failure reports
  `ok: null` + `error` instead of taking health down. A `cdp` block appears
  only when CDP is configured (#4851), and a `stripe` block only when Stripe
  recording is on (#4853): `deposit_address`, `api_version`, `network`,
  `recorded`, `pending`, `declined` and `record_failures` (#4866: `recorded`
  counts only PaymentIntents Stripe accepted). Neither block ever carries a
  credential.

### Sessions: unknown-session 404, idle TTL, and what a redeploy does (#1578, #3171)

`POST /mcp` with an `mcp-session-id` this process does not hold answers HTTP
404 with JSON-RPC `-32001` BEFORE the payment gate (#1578), so a one-use
payment authorization is never consumed for a session-less response. Since
#3171 that 404 tells the buyer what it could not otherwise know: the message
begins `Session not found. Nothing was settled here` and `error.data` is
`{ reason: 'session_expired', settled: false, next_action:
'reinitialize_then_retry_same_payment_header' }`. That is the merchant's own
guarantee, and the Haven SDK acts on exactly that shape: it re-initializes once
and resends the SAME payment header on the new session, which then settles
exactly once (`src/http-session-restart.test.ts`). `initialize` is exempt from
the guard even with a stale id attached, so the recovery door is always open.

The session store is memory-only (`Map` in `http.ts`) — deliberately, this is
a demo merchant with no shared state. Two consequences, both written here
because they are observable: **a redeploy forgets every session at once**, so
every in-flight buyer gets the 404 above on its next call and recovers through
it; and since #3171 a session idle longer than `sessionIdleTtlMs` (default
30 minutes, `DEFAULT_SESSION_IDLE_TTL_MS`; `0` disables) is closed and
forgotten by a lazy sweep on the next request, answering the same 404 — before
that, every `initialize` from anyone on the internet stayed resident until the
client happened to close it. Keep the TTL longer than the slowest settlement:
the idle clock is stamped when a request starts, and closing a session cuts
its open response streams. The sweep is linear in resident sessions and there
is still no cap on how many an unauthenticated `initialize` burst can mint
inside one TTL window; a demo merchant accepts that. One refusal shape, one
remedy, for both causes.

### `/mcp` settlement-readiness gate (#2979)

`/healthz` reporting the `fail` band was not enough on its own: before #2979,
`/mcp` never consulted it, so a wallet with no gas left still issued 402
challenges — the agent signed an authorization, and only then did settlement
fail, with no way to have known beforehand.

`POST /mcp` now reads the same `readiness()` signal (cached per server for
`readinessCacheMs`, default 15s, so a busy merchant does not turn every tool
call into an extra RPC read) on every PAID tool call — the unpaid call that
would receive the 402 challenge and the agent's signed retry alike, so a
wallet that drains between the two is caught before anything is settled.

- **`fail`**: the call is refused with `HTTP 503` and no 402 is ever issued
  (or, on the paid retry, nothing is settled):
  ```json
  {
    "error": "merchant_not_ready",
    "reason_code": "settlement_wallet_out_of_gas",
    "recovery": "operator_top_up",
    "settlements_remaining": 0,
    "fail_floor": 12,
    "retry_after_s": 60
  }
  ```
  with a matching `Retry-After: 60` header.
  `recovery: "operator_top_up"` (out-of-gas refusals only) says the settlement
  wallet does not refill itself: the merchant's operator must top it up, and a
  retry before then is refused again. `retry_after_s` / `Retry-After` are only a
  back-off interval, not a promise of recovery. The gate refuses below
  `fail_floor`, so `settlements_remaining` just under the floor (e.g. 11 of 12)
  still refuses, while exactly at the floor proceeds.
- **`warn`**: unchanged — the call proceeds normally.
- **unknown** (the `readiness()` read itself threw, e.g. an unreachable RPC):
  unchanged — same "never block on an unknown" rule as `/healthz`.
- **Exempt**: free (unpaid) tools, and the `MERCHANT_SKIP_SETTLE_PRODUCT`
  QA fixture below — neither one settles anything on-chain, so a drained
  wallet cannot block a settlement that never runs. Also exempt: a
  CDP-settled product (the joke, #4851) — Coinbase's facilitator pays that
  gas, not this wallet.

The existing merchant-fault 402 body (the #1517 fault-class message) also now
carries a `reason_code` additively — `settlement_wallet_out_of_gas`,
`settlement_rpc_unreachable`, or `merchant_fault` — so a client can branch on
it without parsing the message prose. The message text itself is unchanged.

Since #3170 an ERC-7710 redemption that REVERTS at submit (the simulation
passed moments earlier) is no longer one of those faults: the merchant first
asks the chain whether the settlement child already moved the money (the #1515
already-settled decision, served) and otherwise refuses it as a payer-side
DECISION — a 402 whose `error` names the revert, then the next action (nothing
settled; re-quote, pay with a fresh authorization), then the likely causes (the
child's transfer-amount caveat exhausted, the delegator short of the price, the
child redeemed elsewhere). No `reason_code` rides that decision; only the CDP
path's decisions carry one (`facilitator_refused` / `facilitator_retryable`,
see [Coinbase facilitator](#coinbase-facilitator-cdp-joke-product-4851)). Only a PROVEN
revert takes that branch — viem's `ContractFunctionRevertedError` carrying
decoded data, an error signature or an "execution reverted" reason, the
node's `ExecutionRevertedError` (minus geth's "gas required exceeds
allowance", which viem files there although it means the merchant's key
cannot pay for gas), or a non-viem client's error message naming a revert or
an enforcer; viem wraps every `writeContract` failure in
`ContractFunctionExecutionError`, so the wrapper alone is not proof. Everything
else the merchant's own settlement key or node can fail with — nonce too low,
fee cap, "already known", a JSON-RPC rate limit or internal error, an
unreachable RPC, gas — keeps its fault classification and `reason_code`, the
same split #1519 drew for the EIP-3009 rail's pre-submit checks. The next
action is placed first and the revert reason flattened to printable ASCII and
capped at 120 characters (so the cap survives JSON escaping) because the
hosted server relays the first 500 characters of this body
(`packages/mcp-server/src/tools/paid-mcp-completion.ts`).

`MERCHANT_ADDRESS` is required and must be the Base address that receives USDC.
It is the default receiving address: a product may name its own
(`receivingAddress` in `src/products.ts`, read through
`productReceivingAddress`), and the 402's `payTo`, the verification and the
invoice's recipient address all follow the product being bought. Today no
product names one, so every payment goes to `MERCHANT_ADDRESS`.
`SETTLEMENT_PRIVATE_KEY` is the gas-funded key that submits USDC
`transferWithAuthorization` (and `redeemDelegations`) for every own-key product;
it does not settle the joke, which CDP settles. It does not need to be the
receiving wallet and should not hold user or agent funds.

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

## Coinbase facilitator (CDP): joke product (#4851)

`buy_joke` sells one joke for 0.01 USDC. It is the only product verified and
settled by Coinbase's hosted x402 facilitator (CDP) instead of this merchant's
own `SETTLEMENT_PRIVATE_KEY`; CDP pays the gas. It is offered only when both
`CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` are set. With neither, the merchant
behaves exactly as it does without the product. With only one, it logs a
warning and does not offer the product; it still starts. `/healthz` carries a
`cdp` block only when CDP is configured, and never a credential.

- **EIP-3009 only.** Haven agents prefer ERC-7710 whenever it is offered, and
  CDP does not settle it, so the joke offers EIP-3009 alone. An agent whose
  budget is pinned to one recipient cannot pay it: EIP-3009 needs an open budget.
- **The merchant checks its own quote first.** The extensions echo, x402
  version, quoted option, resource, recipient, amount, signature and validity
  window are checked before CDP is called at all. A signed window
  (`validBefore - validAfter`) longer than 42,600 s (just under 12 h) is
  refused too: the recovery search below could not cover it in full.
- **The chain decides every failure.** After any settle failure or timeout
  (30 s per call), the merchant reads USDC's `authorizationState` itself and
  matches no facilitator error string. Used: USDC's events decide whether it
  was this payment (next bullet). Unused: a
  retryable refusal; the same header retried runs the check again and settles
  at most once. A retry after `validBefore` is served when the chain says the
  money moved, and refused as expired when it did not.
- **Settled or cancelled.** `authorizationState` reads "used" for a payment,
  a cancelled authorization and a nonce spent by another authorization alike.
  The merchant searches USDC's `AuthorizationUsed` event for this payer and
  nonce inside the authorization's own validity window — the only time a
  payment for it can land. Found, and its transaction paid this merchant the
  price: served, with that hash. Found paying anything else, or the whole
  window empty: a final refusal. "Whole" means `validBefore` is at least
  300 blocks (about 10 minutes) behind the RPC's head, so a node lagging a few
  blocks cannot hide a payment that just landed. When the search fails, the
  window is too long to search in full, or it closed too recently, the buyer is
  served with the reference marked unavailable — never refused.
  The search reads in `eth_getLogs` windows the RPC serves (#4866): 500
  blocks by default, narrowed by `ETH_GETLOGS_MAX_BLOCK_RANGE` and by the
  provider's refusal. Before #4866 a node that serves fewer blocks (the
  public Base Sepolia RPC serves 200) refused every window wider than that,
  so on the dev merchant a final refusal was unreachable and the buyer was
  always served. It is reachable there now, as on mainnet. At 200-block
  windows the 21,600-block cap is up to 108 sequential calls.
- **Refusal codes.** The 402 body carries `reason_code: "facilitator_refused"`
  (final: CDP refused at verification — including its sanctions and risk
  screening — and the chain shows the authorization unused, or the
  authorization was consumed by something other than this
  payment) or `"facilitator_retryable"` (nothing has moved yet; retry the SAME
  header, never a newly signed one). Haven's
  clients read `reason_code` only inside a 503 `merchant_not_ready` body, so
  these degrade to the ordinary refusal there.
- **Not in Haven's catalog.** Like `vpn_legacy`, the joke is paid at this
  endpoint directly; a catalog row would change the demo store's funding target.

## Stripe recording (#4853)

With `STRIPE_DEPOSIT_ADDRESS` and `STRIPE_SECRET_KEY` both set, the joke's
receiving address is the Stripe deposit address, and every settled joke payment
is recorded in Stripe as a PaymentIntent in `transaction_verification` mode,
keyed on the transaction hash. No other product can name the deposit address:
the address belongs to the recorded product (`stripeRecording` in
`src/products.ts`), resolved through `productReceivingAddress`.

Stripe is **off**, with a logged warning, and the joke keeps `MERCHANT_ADDRESS`,
when:

| Condition | What happens |
|---|---|
| only one of the two variables is set | warning; the joke keeps `MERCHANT_ADDRESS` |
| CDP is not configured | warning; the joke is not offered at all (#4851) |
| the joke's price is below one cent or not a whole number of cents | warning; the joke keeps `MERCHANT_ADDRESS` |
| `STRIPE_DEPOSIT_ADDRESS` is not a 20-byte hex address | warning; the joke keeps `MERCHANT_ADDRESS` |

The merchant never refuses to start over any of them. With neither variable set
it says nothing, exactly as before.

A third, optional variable — `STRIPE_PREVIOUS_DEPOSIT_ADDRESS` — names the
deposit address this one replaces, so a payment that already settled to it is
still served. See [the operator note](#operator-note-changing-the-stripe-variables-changes-the-quoted-address).

**The PaymentIntent.** `amount` in US cents (the joke is 10,000 atomic USDC =
one cent), `currency=usd`, `confirm=true`, `payment_method_data[type]=crypto`,
`allowed_payment_method_types=[crypto]`, and
`payment_method_options[crypto][mode]=transaction_verification` with
`network=base` and the transaction hash. The transaction hash is also the
idempotency key, and it is stored in `metadata.transaction_hash`. The API
version follows the chain: `2026-07-29.preview` on Base Sepolia (the dev
merchant), `2026-05-27.preview` on Base. The network name is `base` on both — a
sandbox deposit address is a Base Sepolia address, but the parameter does not
change.

**"Already recorded" is a read, not the idempotency key.** Stripe prunes
idempotency keys after about 24 hours, so a key cannot answer "did this
transaction get recorded?" a day later. The recorder first searches
PaymentIntents for `metadata.transaction_hash`, and only creates when the search
finds nothing. The idempotency key is still sent: it closes the window between
the search and the create. **The restricted key therefore needs read access to
PaymentIntents as well as create** — "create PaymentIntents; read balance
transactions" is not enough.

**Recording never blocks delivery.** The payment has settled before Stripe is
called, so the call is fire-and-forget: a refusal, a timeout (10 s per call) or
a network error is logged and counted, and the goods are delivered regardless.
The durable signals are the log lines

```
[stripe] record_failed tx=<hash> reason=<stripe type/code | StripeTimeoutError>
[stripe] record_declined tx=<hash> payment_intent=<pi_…> code=<Stripe's decline code>
[stripe] record_pending tx=<hash> payment_intent=<pi_…>
[stripe] not_recorded tx=<hash> reason=paid_other_address
```

and `/healthz` carries a `stripe` block with `recorded`, `pending`, `declined`
and `record_failures`. Those counters are process-local — the merchant sleeps
after about 10 minutes — so the log lines are what an operator greps for.

**Stripe's verdict, not the create call's (#4866).** Stripe verifies a
`transaction_verification` PaymentIntent after create returns: create answers
`processing`, and Stripe later moves it to `succeeded` or declines it
(`requires_payment_method` with `last_payment_error.code`; `canceled` counts as
declined too). The recorder logs `[stripe] submitted …` on create, then reads
the PaymentIntent every 3 s, for up to 60 s of waiting plus the reads (each
read is bounded at 10 s) — well under the merchant's sleep — and only a
`succeeded` one is `recorded`. A failed read ends the wait as `pending`. One still undecided at the bound is
`record_pending`, and the reconciliation script reads it again later. A decline
is permanent: Stripe allows one PaymentIntent per transaction, so the
transaction cannot be recorded again — say so to Stripe, not to this script.
When create is refused with `resource_already_exists` (a PaymentIntent tracks
the transaction but the metadata search missed it — no metadata, or Stripe's
search has not indexed it yet), the recorder reads the PaymentIntent Stripe
names instead of failing; only that `pi_…` ID is taken from the error, never
the message.

**Only payments to the current deposit address are sent (#4866).** A payment
recovered after an address change paid the previous address (served through
`recoverCdpPaymentAfterQuoteChange`, see the operator note below). Stripe
declines a transaction that did not pay the deposit address, so it is not
sent: it is logged as `[stripe] not_recorded … reason=paid_other_address`. No Stripe secret is ever logged:
a failure names the hash and Stripe's own error `type`/`code`, never the
response body or the request.

**A payment served through recovery without a transaction hash** (#4851) creates
no PaymentIntent at request time: there is nothing to key one on. The
reconciliation script picks it up from the chain.

### Reconciliation

```sh
npm run build -w packages/demo-merchant-mcp
npm run reconcile:stripe -w packages/demo-merchant-mcp -- \
  --from-block 12345678 --to-block 12349999
```

It lists the settled payments to the deposit address that have no
PaymentIntent, and records them. The range is read in `eth_getLogs` windows the
RPC serves (#4866): 500 blocks by default, narrowed by
`ETH_GETLOGS_MAX_BLOCK_RANGE` when set, and by the provider's own refusal — the
public Base Sepolia RPC serves 200 and says so, and the script learns it from
that refusal and asks again narrower. The same windows serve #4851's recovery
search. There is no database to remember a block range,
so the range is an argument.

- Only an **EIP-3009 transfer of the joke's exact price** is recorded. An
  EIP-3009 transfer is the on-chain shape CDP's settlement leaves: USDC's
  `AuthorizationUsed` for the payer in the same transaction as the `Transfer`.
- Any other transfer to the address — a plain `transfer`, a Permit2 pull, an
  ERC-7710 redemption — is listed as `not_recorded` with reason `not_eip3009`
  and left alone. Recording a transfer CDP did not settle needs Stripe's
  confirmation first (epic #4849, Out of scope). A transfer of another amount is
  listed as `amount_mismatch` and left alone too.
- It is idempotent: "already recorded" is the same Stripe read, so a second run
  over the same range creates nothing.

The report is JSON on stdout (the recorder's log lines go to stderr):
`recorded`, `already_recorded`, `pending`, `declined`, `not_recorded` and
`failed` arrays of transaction hashes and PaymentIntent IDs. `recorded` and
`already_recorded` hold only PaymentIntents Stripe accepted (#4866).

| Exit | Meaning |
|---|---|
| 0 | nothing declined or failed — `pending` entries are listed, not an error; run again later |
| 1 | usage or configuration |
| 2 | a payment is listed under `failed` or `declined` — a Stripe refusal, decline, timeout or API error on that payment (Stripe errors never stop the run) |
| 3 | an RPC error stopped the run, printed as one line naming the error class — never a stack trace, never the message (a viem error message carries the RPC URL, which can hold an API key). Payments before the error may already be recorded; run the same range again, it is idempotent |

**Where it runs.** Inside the merchant service's environment, as a one-off
command using that service's variables. The key is never exported to a local
shell or written to a file, and the report recorded on #4854/#4858 carries
hashes and PaymentIntent IDs only. The logic lives in `src/stripe-reconcile.ts`
and `src/reconcile-cli.ts` — under the money-path list, because it creates live
PaymentIntents — and `scripts/reconcile-stripe.mjs` is the thin wrapper.

**Who runs it.** The merchant's operator, after each live batch (#4858) and at
each promotion. The merchant itself cannot: it has no database and sleeps.

### Operator note: changing the Stripe variables changes the quoted address

`STRIPE_DEPOSIT_ADDRESS` is the joke's `payTo`, so changing it (or turning
Stripe on or off) changes the address a new quote names. A payment quoted before
the change and paid after it is refused **only while its authorization is
unsettled**: the quote no longer matches and nothing has moved, so the buyer
re-quotes and pays the new address.

A retry of an authorization that **already settled** to the previous receiving
address is served, not refused — but only when the merchant is told which
address that was. Set `STRIPE_PREVIOUS_DEPOSIT_ADDRESS` to the address you are
replacing, for one deploy:

```sh
STRIPE_DEPOSIT_ADDRESS=0xNEW
STRIPE_PREVIOUS_DEPOSIT_ADDRESS=0xOLD
```

The chain is then checked first (#4851's rule), and a buyer whose authorization
settled to `0xOLD` is served with that transaction's hash. Remove the variable
once no quote from the old address can still be paid.

**Why it is a variable and not inferred.** The payment's own `payTo` is
attacker-chosen: a buyer can sign an authorization to any address, pay it, and
send the header here. Serving a used authorization addressed to whatever the
payment names would hand goods to anyone who paid an address of their own. Only
an address this merchant actually quoted before can be honoured, and the
merchant has no database to remember one — so the operator names it.

Without the variable, a settled retry after a change is refused. The
reconciliation script still records the payment from the chain if you run it
over the range with the old deposit address, so the money is accounted for.

### What we learned from Stripe sandbox (#4854)

One run on 2026-11-16: the dev merchant (Base Sepolia) with a Stripe sandbox,
API version `2026-07-29.preview`. A Haven dev agent bought the joke —
transaction `0x6c210cfc73766647b5081f89b27c96369b74de7d87263ba3ac838cbfb90ed31b`,
recorded as `pi_3UcQXqJ1wRWdOmCA1hKg75Zh`, shown as Succeeded in the sandbox
Dashboard. Four more create calls were made by hand from inside the service,
with the merchant's own key, to answer what Stripe's page does not say: one
created a PaymentIntent, and Stripe refused the other three.
Each answer below is what the sandbox did, not what Stripe documents.

**Deposit address.** `POST /v1/crypto/deposit_addresses` with `network=base` in
a sandbox returns a Base Sepolia address: its `supported_tokens` lists USDC at
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, Circle's Base Sepolia USDC. The
address object has `metadata`. Creating one needs the *Crypto Deposit
Addresses* permission (under *Crypto Payins*); the merchant's key does not need
it, because the operator creates the address once. In Stripe Shell,
`stripe post` is refused ("only supported by the locally installed Stripe
CLI"), so the call was made with `curl`.

**The restricted key.** *PaymentIntents: Write* (which includes read) and
*Balance: Read* are enough for the merchant, the reconciliation script and
reading balance transactions.

**`metadata`, `receipt_email`, `customer`.**

| Parameter | Result |
|---|---|
| `metadata` | Accepted; shown on the PaymentIntent (`product_id`, `transaction_hash`). |
| `receipt_email` | Accepted at create and returned on the object. |
| `customer` | The parameter is recognised: an unknown ID is refused with `resource_missing` on `customer`, not `parameter_unknown`. Not tested with a real Customer — the key has no Customers permission and this merchant keeps no customers. |

**How Stripe matches the hash.** For both new hashes tried, create answered 200
with status `processing`, and Stripe checked the transaction afterwards. A hash
of a transaction that does not exist or reverted was not tried.

- The joke's transaction: `processing` → `succeeded` in about 3 seconds.
- The hash of a USDC transfer to another address (the buyer's funding leg):
  within 30 seconds the PaymentIntent was `requires_payment_method` with
  `last_payment_error.code` `payment_method_provider_decline` ("The payment has
  invalid information. Retries won't succeed.").
- Stripe reads the payer itself: the payment method shows the address that sent
  the transfer — for a Haven agent, its delegate address, not the owner's
  account.

**One PaymentIntent per transaction, permanently.** A second create for the
same hash, with a new idempotency key (as after the old one is pruned), is refused with 400
`resource_already_exists` on `payment_method_options[crypto][transaction_verification_options]`,
naming the PaymentIntent already tracking the transaction. This held for the
succeeded PaymentIntent and for the declined one. So Stripe itself keeps a
transaction from being recorded twice after its idempotency keys are pruned —
and a hash whose PaymentIntent was declined cannot be recorded again.

**Handled since #4866.** At the time of this run the recorder counted
`recorded` when the create call returned, while the PaymentIntent was still
`processing`, and the reconciliation script treated a declined PaymentIntent as
`already_recorded`, so a decline was silent. A payment recovered to the address
named in `STRIPE_PREVIOUS_DEPOSIT_ADDRESS` was also sent to Stripe, the same
shape as the declined probe. Both are fixed: see [Stripe's verdict, not the
create call's](#stripe-recording-4853) above.

**The SEK amount and the rate.** The balance transaction for the one-cent
payment: `amount` 10 (öre), `currency` `sek`, `exchange_rate` 10.0742, `fee` 0,
`net` 10, `reporting_category` `charge`, `status` `pending`. The balance
transaction was created at 14:06:08 UTC, a second before the payment
succeeded, so the SEK amount and rate are known at once;
the funds become available seven days later (`available_on` 2026-11-23 00:00
UTC for a payment on 2026-11-16). The Dashboard says the charge "was received in
USD, but the funds will be transferred to you in SEK". The payment object is a
`py_…`, not a `ch_…`. The sandbox fee is 0; the live fee is not known from this
run. Stripe applies no tax ("No tax rate applied"): the VAT on the receipt is
this merchant's own (#4855).

**Refunds.** The Dashboard's refund dialog asks only for an amount and a reason
— no address — and says crypto refunds "may take up to an hour to reach the
customer's crypto wallet". The refund (`pyr_…`) is a `payment_refund` balance
transaction of −10 SEK at the original payment's rate, 10.0742, with the same
`available_on`, and the payment reads `refunded: true`.
The refund object (`pyr_1UcQgFJ1wRWdOmCAXbr6Pro6`, created 14:14:47 UTC) reads
`status: succeeded` with `destination_details.crypto.reference: null`, but
**nothing moved on chain**: one hour later there was no USDC transfer out of the
deposit address and none into the payer's address. In this run the refund was
bookkeeping only, and the run cannot say where a live refund is sent.
The Dashboard names no destination, and the only address Stripe shows for the
payment is the sender — for a Haven agent its delegate address, not the owner's
account. If a live refund goes there, it lands on the delegate and has to be
swept back. Check that with the first live refund (#4858) before relying on it.

**The reconciliation run.** Inside the dev service (`railway ssh`), over the
200 blocks around the purchase:

```sh
node scripts/reconcile-stripe.mjs --from-block 59580400 --to-block 59580599
```

```json
{
  "from_block": "59580400",
  "to_block": "59580599",
  "transfers": 1,
  "recorded": [],
  "already_recorded": [
    {
      "tx_hash": "0x6c210cfc73766647b5081f89b27c96369b74de7d87263ba3ac838cbfb90ed31b",
      "payment_intent": "pi_3UcQXqJ1wRWdOmCA1hKg75Zh"
    }
  ],
  "not_recorded": [],
  "failed": []
}
```

The public Base Sepolia RPC (`https://sepolia.base.org`) answers `eth_getLogs`
for at most 200 blocks, and the script asks for the whole range in one call: a
1,001-block range failed with RPC error -32614 ("eth_getLogs is limited to a 200
range") and a stack trace. Since #4866 the script reads in windows that RPC
serves and an error ends in one line with exit 3; see § *Reconciliation*.

## Agent Passport check (advisory, #4723)

The merchant is the first consumer of the SDK's merchant-side passport verifier.
When a payment carries a `haven-passport` reference, the merchant resolves it
against Haven and reports the result in its purchase response. It **never
refuses a payment** over it: the check runs after settlement, is cached per
payment, and every failure — 503, 429, a timeout, a network error, a malformed
reference — is reported as an error, not a refusal.

Two env values, and **both** must be set:

| Variable | Value |
|---|---|
| `MERCHANT_HAVEN_BASE_URL` | the Haven API origin to resolve passports against |
| `MERCHANT_PASSPORT_ISSUER` | the issuer address from `GET /passport/issuer` on that deployment |

With either missing, the merchant advertises only `haven-demo` and reports
`passport: null` — exactly the pre-#4723 behaviour. A half-configured or invalid
value logs a warning and disables the check rather than taking the merchant
down.

When both are set, every 402 challenge advertises `haven-passport` as
`{ info: {} }` (the #4722 convention: the client adds `attestation_uid` and
`chain_id` inside `info`). The purchase response then carries:

- `structuredContent.summary.passport` — `{ standing, checked_at }` when the
  receipt authenticated, was unexpired, named this chain and bound the payer;
  `{ error, checked_at }` otherwise; `null` when the payment carried no
  reference.
- a `Passport:` line in the text — "standing checked" or "standing not
  checked". It never says "verified agent": only L2 may say verified, and L2 is
  not issuable.

**The env flip is a real window.** The merchant's echo rule refuses a payment
whose extensions do not contain every advertised key, so a 402 quoted before
the flip and paid after it is refused — and on the EIP-3009 bridge that happens
after funding, so the funds strand until a sweep. Set both values together, on
a service that is not mid-quote. See
[railway-services.md](../../docs/operations/railway-services.md).

Rotating `PASSPORT_RECEIPT_SIGNING_KEY` breaks the pin: the merchant answers
`not_signed_by_issuer` for every receipt until `MERCHANT_PASSPORT_ISSUER` is
updated.

## Buyer tax declaration and VAT treatment (#4855)

A paid request may carry a signed `X-Tax-Declaration` header: base64url(JSON) of
the SDK's seven-field declaration (`version`, `jurisdiction`, `taxableStatus`,
`taxId`, `validUntil`, `principalId`, `principalAttributionHash`) plus its
EIP-712 `signature`. The buyer's own payment key signs it — the same key that
signs the EIP-3009 authorization — and it travels only to the seller, never to
Haven or a facilitator. It is sent on EIP-3009 payments made through the SDK or
the local MCP server; the hosted, keyless path does not send one.

The merchant **accepts** a declaration only when all of these hold, and treats
it as absent otherwise:

- the signature verifies and recovers to the payment's payer
  (`authorization.from`);
- `principalId` is that payer on the payment's network
  (`did:pkh:eip155:<chainId>:<payer>`);
- `principalAttributionHash` recomputes from `principalId`;
- `validUntil` is in the future.

A refused declaration never refuses the purchase: the payment settles and the
receipt is the same as if no header had been sent. The check runs after
settlement, like the passport check.

**What the receipt shows.** The declaration carries no company name and no
organisation number, so the buyer block shows only what is there — the declared
country, the VAT number, the status, and the date the declaration is valid
until:

```json
"kopare": {
  "identifierare": "0x…",
  "typ": "blockkedjeadress",
  "roll": "agent_delegate",
  "deklaration": {
    "land": "DE",
    "moms_nr": "DE123456789",
    "status": "TAXABLE_PERSON",
    "giltig_till": "2027-06-30"
  }
}
```

`deklaration` is absent when no declaration was accepted, so a receipt without
one keeps its previous shape apart from the new `momsbehandling` field.

**VAT treatment, display only.** For a Swedish seller of an electronic service:

| `momsbehandling` | When | Amounts |
|---|---|---|
| `SE_25` | the declared country is Sweden, or there is no accepted declaration | unchanged: 25% VAT taken out of the price |
| `REVERSE_CHARGE` | the declared country is another EU country | net = total = the product price, VAT rate 0, VAT amount 0 |

Under `REVERSE_CHARGE` the rendered invoice names both VAT numbers and says
"reverse charge" (English) / "omvänd betalningsskyldighet" (Swedish). The price
does not change with the treatment.

**Limits.** The merchant applies a display rule; it does not compute, assert or
file tax, and it does not verify the VAT number against VIES. A non-EU
treatment is not built — a Haven buyer only ever sends a declaration for an EU
VAT number, and a non-EU jurisdiction falls back to `SE_25`. The declaration is
not persisted: it lives on the receipt for the payment that carried it.

## QA hook: verify-without-settle (testnet-only)

`MERCHANT_SKIP_SETTLE_PRODUCT=<product_id,...>` (#603) verifies listed
products' payments but skips on-chain settlement — the QA sweep-recovery
scenario uses it to strand the delegate deterministically. It is
**testnet-only, enforced in code**: startup fails unless
`MERCHANT_CHAIN_ID=84532`, because a skipped settlement also skips the only
balance check — on any real chain a listed product would hand out goods
against a well-formed authorization from an empty wallet.

Listed products are also exempt from the `/mcp` settlement-readiness gate
(#2979) above: the gate exists to stop settling against a wallet that cannot
afford it, and this fixture settles nothing, so a fail-band wallet cannot
block it either.

**Disclosed to the agent, not just to the operator (#2989).** Before this, a
cold agent buying a listed product got an honest "Delivered — not confirmed
on-chain" receipt with no way to know beforehand that the outcome was by
design — a quality scan spent 30 minutes chasing it as a stuck payment. Every
surface an agent reads now carries the same marker on that product, and only
that product:

- `list_products`: a `qa_fixture: { kind: "skip_settle", settles_on_chain: false }`
  field in the matching `structuredContent.products` entry, plus a text line
  ("QA fixture: verified but never settled on-chain — the receipt will read
  'Delivered — not confirmed on-chain'", localized for `locale: 'sv'`).
- The product's 402 challenge `description` — visible to the agent at quote
  time, before it signs.
- The discovery document (`GET /` / `GET /.well-known/haven-demo-merchant`) —
  the same `qa_fixture` field on the product's entry.

Absent (not `null` or `undefined`-valued) on every other product and on every
other chain, so the prod shape this fixture is inert on is unchanged.

**Delisted from Haven's catalog, not just disclosed (#3421).** The Sepolia
`storage_50gb` product was ALSO a seeded Haven `merchant_catalog` row —
`GET /catalog` could hand it to an agent that never read this merchant's
discovery document or its `qa_fixture` marker, funding a purchase that then
never settles. Migration `102_delist_skip_settle_catalog_row` delisted that
one row (the owner's call: delist, not relabel — it stays reachable only by
calling this merchant directly, never through catalog discovery), and Haven's
`x402-catalog-guided-purchase` QA leg carries a tripwire that fails if any
`qa_fixture` product this discovery document names ever gets a listed catalog
row again. **Rule:** the product named in `MERCHANT_SKIP_SETTLE_PRODUCT` must
have no non-delisted `merchant_catalog` row on the dev host; moving the env
var to a different product needs a delisting migration first. See
`docs/operations/agent-qa.md`.

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

Because the merchant self-settles every ERC-7710 payment (CDP settles no
ERC-7710, and the joke offers none), the settlement key is the **redeemer** — a
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
