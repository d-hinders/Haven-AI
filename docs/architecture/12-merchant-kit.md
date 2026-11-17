---
owner: "@d-hinders"
status: current
covers:
  - packages/demo-merchant-mcp/src/x402.ts
  - packages/demo-merchant-mcp/src/http.ts
  - packages/demo-merchant-mcp/src/products.ts
  - packages/demo-merchant-mcp/src/cdp.ts
  - packages/sdk/src/merchant-discovery.ts
  - packages/sdk/src/merchant-egress.ts
  - packages/sdk/src/merchant-completion.ts
  - packages/sdk/src/merchant-answer.ts
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/connect/src/runtime-manifest.ts
  - scripts/release-bump.mjs
  - .github/workflows/publish.yml
  - packages/backend/src/routes/machine-payments.ts
last-verified: "2026-11-17"
---

# Merchant kit: design

This is the design the paywall proxy (#4893) and Haven's sales ingest (#4897)
are both built from, so the two sides agree before either is coded. It is part
of epic [#4884](https://github.com/d-hinders/Haven-AI/issues/4884). It settles
every decision the proxy's builder would otherwise have to guess, and it names
the two new workspace packages.

The kit lets a merchant that sells an HTTP API accept x402 payments by taking
this repository, filling in a products file and a few settings, without
changing their own code and without a Stripe account. The money lands in the
merchant's own Haven account. Haven is never in the payment path and never
holds the merchant's upstream API key.

## 1. The four parts, and which are required

| Part | What it is | Required | Built in |
|---|---|---|---|
| Paywall proxy | A standalone reverse proxy. It answers an unpaid call with an x402 challenge, has the payment verified and settled by a facilitator, then forwards the call upstream with the merchant's API key. | Yes | #4893 |
| Products file | One file mapping a route or model to a fixed price (x402 `exact`), with an optional output-token cap and a description. | Yes | #4893 |
| Discovery document | A public, machine-readable list of the products, served by the proxy, which agents, directories and Haven read. | Yes | #4891 |
| Sales reporter | After each settled call the proxy sends a small record to Haven. | Yes for the pilot; optional for a merchant that only wants to accept payments | #4898 |

Three parts are required to accept a payment: the proxy, the products file and
the discovery document. The sales reporter is required for the pilot, because
the pilot's point is Haven's sales ingest, and for any merchant that wants the
sale to appear on Haven's Sales page. A merchant that only wants to accept
payments can run the proxy without the sales settings; the proxy then logs
`sales_reporting: off` at startup and sends nothing.

The shared payment core (#4890) is not a part the merchant fills in. It is a
dependency of the proxy, and the demo merchant uses the same core.

## 2. The two new packages

Both are workspace-private packages in this repository. Neither is published
for the pilot (owner decision, 2026-11-16: licence and distribution are decided
after the first pilot).

| Package | Directory | What it holds |
|---|---|---|
| `@haven_ai/merchant-payments` | `packages/merchant-payments/` | The shared payment core from #4890: the Coinbase facilitator client and its timeout and credentials handling, the checks made before a payment is sent for verification, the chain recovery that reads the chain when the facilitator's answer is lost, and the consumed-payment store interface in section 6. |
| `@haven_ai/paywall-proxy` | `packages/paywall-proxy/` | The proxy from #4893: the products file reader, the challenge, the settlement call into the core, the persistent consumed-payment store, the upstream forwarder and the sales reporter. |

Both are `private: true` and pin internal dependencies as `"*"`, as
`lint:workspace-pins` requires. The core is the code that lives in
`packages/demo-merchant-mcp/src/cdp.ts` and the Coinbase path in
`packages/demo-merchant-mcp/src/x402.ts` today, moved without changing the demo
merchant's behaviour (#4890). It takes the chain id, the USDC address
and the USDC signing domain as parameters; it reads no environment variable and
has no default chain (#4890). The proxy's chain table supplies those values
from its one network setting.

The core does not live in the SDK. The SDK ships to buyers, and merchant-side
code in it would ship merchant code to buyers. The demo merchant imports the
core from `packages/merchant-payments/` and keeps its own chain table, its own
products and its own self-settlement path.

### What publishing would involve, later

The repository publishes five packages today: `@haven_ai/sdk`,
`@haven_ai/signer`, `@haven_ai/mcp`, `@haven_ai/connect` and `@haven_ai/cli`.
Publishing the two new packages would mean, at minimum:

- adding them to `PUBLISHED_PACKAGES` in `scripts/release-bump.mjs`, so the
  lockstep version bump, the cross-package pins and the ordered rebuild cover
  them;
- adding them to the package list and the build order in
  `.github/workflows/publish.yml`, and to the dev-channel snapshot job that
  publishes `0.0.0-dev.*` versions under the `dev` dist-tag;
- deciding whether `packages/connect/src/runtime-manifest.ts` needs to name
  them (it pins `sdkVersion` and `signerVersion`; connect does not depend on
  either new package, so it would not);
- a licence. The repository is public and has no licence today, so a published
  package would need one, plus a `repository` block and a distribution
  decision.

None of that is in scope for the pilot. The document records it so the
decision is not rediscovered later.

## 3. The products file

The products file is JSON, read from the path in `PRODUCTS_FILE`. JSON rather
than YAML because the proxy already runs on Node and needs no new parser, and
because a JSON Schema can validate it at startup. The proxy refuses to start
when the file is missing, is not valid JSON, or fails validation.

### Shape

```json
{
  "version": 1,
  "products": [
    {
      "id": "opper-gpt-6-sol-1k",
      "name": "Opper GPT-6 Sol, 1,000 output tokens",
      "route": "POST /v3/compat/chat/completions",
      "model": "openai/gpt-6-sol",
      "price": "10000",
      "output_token_cap": 1000,
      "description": "One chat completion on openai/gpt-6-sol, up to 1,000 output tokens."
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | Yes | The products-file schema version. `1` is the only version. An unknown version refuses startup. |
| `products[].id` | Yes | Stable, unique, lower-case identifier. It is the `product_id` in the sale record and the key the discovery document lists. |
| `products[].name` | No | Human name. When present it is the sale record's `product_name`; when absent the proxy sends the `id`. |
| `products[].route` | Yes | `METHOD /path`, matched exactly against the request's method and path after the proxy's base path. A product is selected by its route. |
| `products[].model` | No | When present, the request body's `model` must equal it, or the request is refused before settlement. This is how an inference product is pinned to one model. |
| `products[].price` | Yes | The price in whole atomic USDC units, as a decimal string. USDC has 6 decimals, so `"10000"` is $0.01. Never a float and never a dollar string: a JSON number is refused, because a float cannot represent every atomic amount exactly. |
| `products[].output_token_cap` | No | The maximum output tokens one purchase buys. Required for an inference product; absent for a product that is not token-priced. |
| `products[].description` | Yes | Shown in the 402 challenge and in the discovery document. |

The network is one setting of the deployment, not a field per product. The
proxy reads `NETWORK` as a CAIP-2 identifier (`eip155:84532` for Base Sepolia,
`eip155:8453` for Base) and derives the USDC address and the EIP-712 domain
from its chain table. A products file that names a network is refused at
startup, so a product cannot be priced on one chain and settled on another.
The proxy also refuses to start when `NETWORK`, `PAY_TO` or `OPERATOR_NAME` is
missing, so a deployment cannot come up without a network, a receiving address
or an operator.

Two products may share a route when they differ by `model`; the proxy selects
the product whose `model` matches the body. Two products with the same route
and the same model are refused at startup, because the price would be
ambiguous.

## 4. The discovery document

The proxy serves the discovery document at `/.well-known/x402`, the x402
well-known path (RFC 8615), and nowhere else. It does not serve it at
`/.well-known/haven-demo-merchant` and it does not carry an `mcp_url` field.
The SDK probes exactly those two paths and acts on `mcp_url` for MCP merchants
(`packages/sdk/src/merchant-discovery.ts`); a kit document at the demo path, or
one carrying `mcp_url`, would be read as an MCP merchant and the SDK would try
to open an MCP session against a plain HTTP proxy. The kit's document is for
agents, directories and Haven to read the products; it carries no MCP endpoint.

`/` is not the discovery document. It is proxied to the upstream like any other
route, or refused when it is not a product route.

### Shape

```json
{
  "version": 1,
  "operator": {
    "name": "Haven",
    "contact": "https://haven.example/merchant-kit"
  },
  "name": "Haven inference demo",
  "description": "Opper inference paid per call on Base Sepolia.",
  "network": "eip155:84532",
  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "pay_to": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "settlement": {
    "scheme": "exact",
    "facilitator": "coinbase-cdp",
    "methods": ["eip3009"]
  },
  "products": [
    {
      "id": "opper-gpt-6-sol-1k",
      "name": "Opper GPT-6 Sol, 1,000 output tokens",
      "route": "POST /v3/compat/chat/completions",
      "model": "openai/gpt-6-sol",
      "price": "10000",
      "output_token_cap": 1000,
      "description": "One chat completion on openai/gpt-6-sol, up to 1,000 output tokens."
    }
  ],
  "updated": "2026-11-17T00:00:00Z"
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | Yes | The kit document version. `1` is the only version. |
| `operator.name` | Yes | Who operates the endpoint. A Haven-run demo says `Haven`; a third-party merchant says its own name. The proxy refuses to start without `OPERATOR_NAME` (#4893). |
| `operator.contact` | No | A URL or address a reader can use to reach the operator. |
| `name`, `description` | Yes | Human identification of the endpoint. |
| `network` | Yes | CAIP-2 identifier. The same value the challenge advertises. |
| `asset` | Yes | The USDC contract address on that network. |
| `pay_to` | Yes | The receiving address. One setting of the deployment; every product is paid to it. |
| `settlement.scheme` | Yes | `exact`. The kit does not offer `upto` or `batch-settlement`. |
| `settlement.facilitator` | Yes | `coinbase-cdp` or `x402-org`. |
| `settlement.methods` | Yes | `["eip3009"]`. The kit advertises EIP-3009 only; ERC-7710 is later work (#4887). |
| `products[]` | Yes | The same product objects as the products file: `id`, `name`, `route`, `model`, `price`, `output_token_cap`, `description`. |
| `updated` | No | RFC 3339 timestamp of the last change, for caches. |

The document is a superset of the product list the demo merchant serves today
(`packages/demo-merchant-mcp/src/http.ts` builds it from
`packages/demo-merchant-mcp/src/products.ts`). It drops the demo's MCP fields
(`mcp_url`, `current_base_url`, `hosted_urls`, `routing`) and adds `version`,
`operator`, `asset`, `pay_to` and `settlement`. The demo merchant keeps serving
its own document unchanged; the kit's document is the proxy's.

### How an older kit is treated

A reader that finds no `version` treats the document as version 1. The demo
merchant's document today has no version field, and its product list is a
subset of version 1, so this is the compatible reading.

A reader that finds a higher version than it knows reads the fields it knows
and ignores unknown fields; it does not refuse the document. A reader that
finds a lower version reads the fields present and applies the documented
default for a missing optional field. The discovery document is a catalogue,
not an authority: a reader that cannot understand a product simply does not
offer it.

The sale record is stricter (section 5): Haven refuses a record whose `version`
it does not know, because it cannot know what the fields mean.

## 5. The sale record

After each settled call the proxy sends one sale record to Haven. The record is
JSON, `POST`ed to the URL in `HAVEN_SALES_URL` with
`Authorization: Bearer $HAVEN_MERCHANT_KEY` and `Content-Type: application/json`.
The route and the merchant key are Haven's (#4897); the proxy only needs the
URL and the key.

### Shape

```json
{
  "version": 1,
  "tx_hash": "0x9f2c4b1e7a3d5c8f0e6b2a4d7c9e1f3a5b7d9c0e2f4a6b8d0c2e4f6a8b0d2c4e",
  "chain": "eip155:84532",
  "product_id": "opper-gpt-6-sol-1k",
  "product_name": "Opper GPT-6 Sol, 1,000 output tokens",
  "amount": "10000",
  "payer": "0x7a3f9c2e1b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a",
  "merchant_reference": "sale_01JB8Z3K4M5N6P7Q8R9S0T1V2W"
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | Yes | The sale-record schema version. `1` is the only version. A record with an unknown version is refused by Haven with an answer that says so (#4897). A record with no `version` is read as version 1. |
| `tx_hash` | Yes | The settlement transaction hash, `0x`-prefixed, lower-case. It is the key Haven reads the chain with. |
| `chain` | Yes | CAIP-2 identifier of the chain the transaction is on. The same value as the discovery document's `network`. |
| `product_id` | Yes | The product's `id` from the products file. |
| `product_name` | No | The product's `name` when the products file has one; otherwise the proxy sends the `id`. |
| `amount` | Yes | The settled amount in whole atomic USDC units, as a decimal string. It must equal the product's `price`. |
| `payer` | Yes | The address that paid. For an EIP-3009 payment from a Haven agent this is the agent's delegate address, not the Haven account (see below). |
| `merchant_reference` | Yes | The merchant's own reference for the sale. The proxy generates a ULID once per settled call (`sale_<ulid>`), sends it, and logs it. Haven stores it and does not interpret it. |

### The payer address

For an EIP-3009 payment from a Haven agent, `payer` is the agent's delegate
address, not the Haven account. The funding leg moves USDC from the Haven smart
account to the agent's delegate address; the delegate then signs the EIP-3009
authorization that the merchant settles. The on-chain transfer into the
merchant is therefore from the delegate, and the delegate is the address the
proxy reads from the payment payload's `from` field and writes into the record.
The Haven account never appears in the transfer and must not appear in the
record.

For a buyer that is not a Haven agent, `payer` is whatever address signed the
authorization. The proxy does not guess an identity from it.

### What Haven checks, and what it takes on the merchant's word

Haven reads the transaction itself and stores the sale only when it finds a
USDC transfer into the merchant key's account (#4897). The split is:

| Field | Checked against the chain | Taken on the merchant's word |
|---|---|---|
| `tx_hash` | Yes: it is the lookup key, and the transaction must exist on `chain`. | |
| `chain` | Yes: the transaction must be on that chain. | |
| `amount` | Yes: it must equal the transfer into the account. Haven stores the chain's amount, not the record's. | |
| `payer` | Yes: it must equal the transfer's sender. Haven stores the chain's sender. | |
| asset and time | Yes: the transfer must be USDC, and its time comes from the chain. | |
| `product_id` | | Yes. Nothing on-chain names a product. |
| `product_name` | | Yes. Display only. |
| `merchant_reference` | | Yes. Stored, not interpreted. |
| `version` | | Shape-checked only; an unknown version is refused. |

A record whose hash paid a different Haven account gets the same answer as a
hash that paid nobody, so a merchant key cannot be used to test whether a hash
paid another account (#4897).

### Delivery

The proxy sends the record after the upstream call completes, whether it
delivered or failed, because the payment settled either way. Delivery is
at-least-once: the proxy retries a 5xx or a timeout three times with
exponential backoff (1 s, 4 s, 16 s), and on a final failure appends the record
to a bounded on-disk outbox (`SALES_OUTBOX`, JSON Lines, 10,000 records) that a
background task replays every 60 s. A 4xx is not retried: the record was
refused, and the proxy logs `sales_report_refused` with the answer. Haven's
ingest is idempotent on chain, transaction hash and account, so a duplicate is
harmless.

## 6. The consumed-payment store

The shared core keeps settled payments in memory today and serves a settled
payment again when it is presented again, including after a restart
(`packages/demo-merchant-mcp/src/x402.ts`). The proxy needs the opposite: a
payment buys one call, remembered across restarts. The core calls a store
through one interface; each consumer supplies its own implementation and
policy.

### The interface

```ts
export type ConsumedPaymentState = 'settled' | 'forwarding' | 'delivered' | 'failed'

export interface ConsumedPaymentRecord {
  key: string
  state: ConsumedPaymentState
  productId: string
  txHash: string
  chain: string
  payer: string
  amount: string
  settledAt: string
  forwardingStartedAt?: string
  deliveredAt?: string
  failedAt?: string
  failureReason?: string
  upstreamStatus?: number
}

export interface ConsumedPaymentStore {
  /** Record a settlement. Returns the existing record when the key is known. */
  claim(input: {
    key: string
    productId: string
    txHash: string
    chain: string
    payer: string
    amount: string
    settledAt: string
  }): Promise<ConsumedPaymentRecord>

  /** Atomically move a settled or failed record to forwarding. */
  beginForwarding(key: string, now: string): Promise<'forward' | 'in_flight' | 'delivered'>

  markDelivered(key: string, input: { upstreamStatus: number; deliveredAt: string }): Promise<void>

  markFailed(key: string, input: { reason: string; failedAt: string }): Promise<void>

  get(key: string): Promise<ConsumedPaymentRecord | null>
}
```

The core calls `claim` after settlement and before it returns the settled
payment. The consumer calls `beginForwarding`, `markDelivered` and `markFailed`
around its own work. The core keeps no map of its own: the store is the one
place a settled payment is recorded.

### The key

The key is the payment authorization's identity, not the transaction hash,
because a duplicate can arrive before the settlement transaction exists:

- EIP-3009: `eip3009:<chain>:<payer>:<nonce>`, lower-cased.
- ERC-7710: `erc7710:<chain>:<delegator>:<permissionContextHash>`, lower-cased.

The proxy accepts EIP-3009 only, so its keys are the first form. The key is
derivable from the payment header alone, which is what makes the one-call rule
survive a restart: the buyer presents the same header, the proxy derives the
same key, and the store answers.

### The states

| State | Meaning | Next states |
|---|---|---|
| `settled` | Settlement is confirmed and the transaction hash is recorded. The call has not been forwarded. | `forwarding` |
| `forwarding` | The upstream call is in flight. `forwardingStartedAt` bounds it. | `delivered`, `failed` |
| `delivered` | The upstream answered and the buyer received the response. | none |
| `failed` | The upstream call failed. The payment may be served again. | `forwarding` |

`beginForwarding` is the atomic transition. It returns `forward` when the
record was `settled` or `failed`, or when it was `forwarding` and
`now - forwardingStartedAt` is at least the upstream timeout (it first marks
that record `failed`). It returns `in_flight` when the record is `forwarding`
and younger than the timeout. It returns `delivered` when the record is
`delivered`. The implementation does this with one conditional update and
checks the affected row count, so two concurrent requests cannot both get
`forward`.

### Policy per consumer

- **Demo merchant.** An in-memory `Map` behind the interface. `claim` returns
  the existing record; the merchant serves the cached result again, which is
  its current behaviour. `beginForwarding` returns `delivered` for a delivered
  record, and the merchant serves the cached result. Nothing is persisted, so a
  restart forgets settled payments, exactly as today.
- **Proxy.** A SQLite file at `PAYMENTS_DB`, using the built-in `node:sqlite`
  module (the repository runs Node 24, so no new dependency). One table keyed
  on `key`, with the state and the timestamps above. A payment buys one call:
  a `delivered` record is never forwarded again, and a `failed` record is
  forwarded again on the same payment.

### Restart and crash answers

| Situation | Answer |
|---|---|
| Unknown key after a restart or a crash between settlement and delivery | The core verifies the payment, then settles. If the facilitator says the authorization was already used, the core's chain recovery finds the transaction, the store records `settled`, and the proxy forwards. If the chain shows no transaction, the payment is refused as unsettled and nothing was paid. An unknown key is never served without a settlement. |
| `settled` after a restart | Forward. The settlement is recorded and the call was never made. |
| `forwarding` after a restart, older than the upstream timeout | Mark `failed`, then forward. The process that was forwarding is gone and the upstream call cannot still be running past its timeout. |
| `forwarding` after a restart, younger than the upstream timeout | Refuse as in flight with `Retry-After` set to the remaining time. The upstream call may still be running. |
| `delivered` after a restart | Refuse: the payment already bought its one call. |
| `failed` after a restart | Forward. |

### The same payment twice while a call is in flight

The second request gets HTTP 200 with `error: "payment_in_flight"` and
`retry_after_seconds` set to the remaining time (section 8 explains why a
post-settlement answer is 2xx). No second upstream call is made and no second
settle call is sent. The first call's outcome decides the record.

### What "the upstream call failed" means

A call **failed** when any of these is true:

- no response headers arrived within `UPSTREAM_TIMEOUT_MS` (300 s);
- the connection was refused, reset, or the DNS lookup failed before headers;
- the upstream answered 5xx, 408 or 429;
- the response body was truncated: fewer bytes than `Content-Length`, or an
  SSE stream that ended without the upstream's terminal event (`data: [DONE]`
  for an OpenAI-compatible stream);
- the buyer disconnected before the upstream response completed.

A call **delivered** when the upstream answered with a complete body, whatever
the status: 2xx, 3xx or 4xx. A 4xx is the upstream's answer to the buyer's
request, and the call was served; retrying the same request would get the same
4xx, so serving it again would waste the merchant's money. A 3xx is forwarded
as-is; the proxy does not follow upstream redirects.

A partial response counts as failed only when the upstream's own framing says
it is incomplete. A complete body that is shorter than the buyer hoped is
delivered.

## 7. The proxy's request handling

### Headers removed before forwarding

The proxy removes these request headers and never forwards them:

`PAYMENT-SIGNATURE`, `X-PAYMENT`, `X-Tax-Declaration`, `SIGN-IN-WITH-X`,
`Authorization`, `Cookie`, `Proxy-Authorization`, `Host`, `Content-Length`,
`Transfer-Encoding`, `Connection`, `Keep-Alive`, `TE`, `Trailer`, `Upgrade`,
`X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `Forwarded`,
`X-Real-IP`.

`PAYMENT-SIGNATURE` and `X-PAYMENT` are the buyer's payment; the upstream has no
use for them and must not see them. `X-Tax-Declaration` and `SIGN-IN-WITH-X` are
Haven buyer metadata. `Authorization` is always removed, even when the upstream
key is sent as `Authorization`: the buyer's value is replaced, never forwarded.
The proxy sets `Host` to the upstream host and recomputes `Content-Length`. It
does not add `X-Forwarded-For` or any other forwarding header, so the upstream
sees the proxy's address and not the buyer's.

On the response side the proxy removes any upstream `PAYMENT-REQUIRED` and
`PAYMENT-RESPONSE` header and sets its own `PAYMENT-RESPONSE` with the
settlement. It forwards the upstream's other headers, including
`Content-Type` and `X-Opper-Cost`.

### The upstream key

The key is read from `UPSTREAM_API_KEY`. It is sent in the header named by
`UPSTREAM_AUTH_HEADER` (default `Authorization`) with the scheme in
`UPSTREAM_AUTH_SCHEME` (default `Bearer`), so an upstream that wants
`x-api-key: $UPSTREAM_API_KEY` is configured rather than special-cased. The key appears in
no response, no error body and no log line. The proxy refuses to start without
it.

### Body size limits

- Request body: 1 MiB. A larger body is refused with 413 before settlement.
  Inference prompts are far smaller; the limit exists so an unpaid request
  cannot make the proxy buffer an arbitrary body.
- Response body: 5 MiB, the same cap Haven's hosted path applies to a delivery
  (`packages/sdk/src/merchant-egress.ts`). The proxy buffers the upstream
  response up to the cap. A response over the cap is a failed call: the buyer
  gets the post-settlement failure body with `reason: "response_too_large"` and
  the same payment can be retried with a smaller cap.
- Upstream timeout: 300 s, the same deadline Haven's hosted path applies to a
  delivery. A call that exceeds it is failed.

### Limiting unpaid requests

Unpaid requests are limited per client IP: 60 requests a minute with a burst of
10, and at most 10 concurrent unpaid requests per IP. Over the limit the proxy
answers 429 with `Retry-After` and no challenge. Paid requests are not
rate-limited by the proxy; the payment is the limit. A global cap of 32
concurrent upstream calls bounds the merchant's own spend: a paid request waits
up to 10 s for a slot before settlement, and if no slot is free it is refused
with 503 before any verify or settle call, so nothing is settled for a call
that will not be served.

### Streamed responses

The proxy buffers the upstream response in full and does not stream. A request
with `stream: true` is accepted; the upstream's SSE body is buffered and
returned as one body, and the buyer's client parses the events in order, just
not incrementally.

The reason is Haven's hosted path: it reads the merchant response into a string
in full, with a 5 MiB cap enforced while reading
(`packages/sdk/src/merchant-egress.ts`, `packages/sdk/src/mcp-merchant-transport.ts`),
so a stream would never reach a hosted buyer incrementally. Buffering also lets
the proxy choose the status code when the upstream fails after settlement,
which it cannot do once response headers are on the wire. Real streaming is
later work, and it needs a Haven-side change first.

### The output-token cap

The cap is carried by `max_tokens` in the JSON body of an OpenAI-compatible
chat completions request. Opper's compatibility endpoint
(`POST /v3/compat/chat/completions`) accepts both `max_tokens` and
`max_completion_tokens`; the proxy sets `max_tokens` to the product's
`output_token_cap` and, when the buyer's body carries `max_completion_tokens`,
sets that to the cap too. It never raises a value the buyer set lower.

The proxy refuses a request whose cap it cannot set, before settlement, with
400 and `reason: "cap_not_settable"`: the body is not a JSON object, the route
is not the product's route, or the product has a cap and the body is not a chat
completions request. It does not forward a request whose cap it could not set.

The cap is advisory on the upstream API. When the upstream delivers more than
was paid for, the merchant absorbs the overage: the price is fixed, the buyer
is not charged again, and the proxy does not truncate the answer (truncating
would corrupt the goods). The proxy logs `overage_tokens` from
`usage.completion_tokens` when the upstream reports it, and the merchant's
recourse is to lower the cap or raise the price.

## 8. Refusals before settlement, and the post-settlement answer

Haven classifies a paid retry by its HTTP status: 2xx is accepted, non-2xx is
`MERCHANT_REJECTED_AFTER_FUNDING` (`packages/sdk/src/merchant-completion.ts`,
`packages/sdk/src/merchant-answer.ts`). A Haven agent paying by EIP-3009 has
already moved USDC to its delegate address before the proxy sees the request,
so a non-2xx refusal after funding is recorded as a rejection and the buyer
must sweep the delegate (`haven_sweep_delegate`).

The proxy therefore follows one rule: **before settlement, refuse with the
narrowest 4xx and no verify or settle call; after settlement, answer 2xx with a
machine-readable body.** A payment that reached the merchant is never reported
as rejected.

### Before settlement

| Condition | Status | Body `error` | Challenge? | Haven classification | Buyer recourse |
|---|---|---|---|---|---|
| No payment header, route is a product | 402 | the x402 challenge | Yes, in `PAYMENT-REQUIRED` | No payment yet | Pay the challenge |
| Payment header does not match the challenge (network, asset, `pay_to`, amount, product) | 402 | `payment_mismatch` | Yes | Rejected after funding if the agent had funded | Sweep the delegate |
| Route is not in the products file | 404 | `unknown_route` | No | Rejected after funding if paid | Sweep the delegate |
| Body is not JSON, or `model` does not match the product | 400 | `bad_request` | No | Rejected after funding if paid | Sweep the delegate |
| Product has a cap and the body cannot carry it | 400 | `cap_not_settable` | No | Rejected after funding if paid | Sweep the delegate |
| Body over 1 MiB | 413 | `body_too_large` | No | Rejected after funding if paid | Sweep the delegate |
| Unpaid rate limit | 429 | `rate_limited` | No | No payment yet | Retry after `Retry-After` |
| No upstream slot | 503 | `at_capacity` | No | Rejected after funding if paid | Sweep the delegate |
| Proxy not ready (missing upstream key) | 503 | `not_ready` | No | Rejected after funding if paid | Sweep the delegate |

Every refusal body is JSON with `error`, a human `message`, and, where it
applies, `retry_after_seconds`. The proxy never calls the facilitator for a
request it will refuse, so nothing is settled for a request that will not be
served.

### After settlement

Every answer after settlement is 2xx, because the payment reached the merchant
and Haven must not record a rejection. The body's `error` field carries the
outcome:

| Condition | Status | Body `error` |
|---|---|---|
| Upstream call failed (section 6) | 200 | `upstream_failed_after_settlement` |
| Same payment presented while a call is in flight | 200 | `payment_in_flight` |
| Same payment presented after its call was delivered | 200 | `payment_already_delivered` |
| Payment settled for a different product | 200 | `payment_used_for_other_product` |

### The upstream-failure answer

```json
{
  "error": "upstream_failed_after_settlement",
  "message": "The payment settled and the upstream call failed. Retry the same request with the same payment header; it will be served without a second charge.",
  "payment": {
    "tx_hash": "0x9f2c4b1e7a3d5c8f0e6b2a4d7c9e1f3a5b7d9c0e2f4a6b8d0c2e4f6a8b0d2c4e",
    "chain": "eip155:84532"
  },
  "reason": "upstream_timeout",
  "retry": {
    "same_payment": true,
    "after_seconds": 0
  }
}
```

The response carries the standard `PAYMENT-RESPONSE` header with the settlement
transaction hash, so Haven can anchor the evidence. `reason` is one of
`upstream_timeout`, `upstream_unreachable`, `upstream_status`,
`response_too_large` or `buyer_disconnected`. The same payment presented again
gets the call it paid for, because the store recorded `failed`.

## 9. The limits Haven's hosted path puts on a response

`packages/sdk/src/merchant-egress.ts` installs the strict hosted policy:

| Use | Timeout | Byte cap |
|---|---|---|
| `quote` | 15 s | 256 KiB |
| `mcpSession` | 15 s | 256 KiB |
| `discovery` | 5 s | 64 KiB |
| `delivery` | 300 s | 5 MiB |

The policy also allows at most 3 GET redirects, and every hop is checked
against the URL rules before it connects. The delivery
body is read into a string in full, with the cap enforced while reading
(`packages/sdk/src/mcp-merchant-transport.ts`), so a hosted buyer receives the
whole body at once and never a stream.

These bound the kit's token caps. The 5 MiB cap is roughly 1.3 million tokens
of English text, so it is not the binding limit. The 300 s delivery timeout is:
at 30 to 50 output tokens a second, a hosted buyer can receive about 9,000 to
15,000 tokens before Haven's deadline. A product whose cap is above that will
be cut off by Haven, not by the proxy, and the buyer sees a timeout rather than
the answer. The demo's 1,000-token cap is well inside both limits.

## 10. Settlement cost per call

Read from the vendor's pages on 2026-11-17:

- <https://docs.cdp.coinbase.com/x402/seller/facilitator> — the pricing table.
- <https://docs.cdp.coinbase.com/x402/support/faq> — what counts as a
  transaction.
- <https://docs.cdp.coinbase.com/x402/network-support> — supported networks,
  including Base Sepolia.

The vendor states:

- **Price per settled call:** $0.001 per onchain facilitator transaction after
  the free tier. Verification is always free. A `settle` call that returns 2xx
  counts as one transaction; a `settle` call that fails with 4xx or 5xx,
  including a payment declined by compliance screening, is not billed. Gas is
  paid on-chain separately.
- **Free allowance:** the first 1,000 onchain transactions each month are free.
- **Base Sepolia:** the CDP facilitator supports `eip155:84532` with `exact`,
  `upto` and `batch-settlement`. The x402.org testnet facilitator supports Base
  Sepolia `exact` and `upto` with no API key.

The kit uses `exact`, so one settled call is one onchain transaction and costs
$0.001 after the free tier.

The smallest product price at which settlement cost stays under a stated share
of the price:

| Settlement share of the price | Smallest price | Atomic USDC |
|---|---|---|
| 10% | $0.01 | `"10000"` |
| 5% | $0.02 | `"20000"` |
| 1% | $0.10 | `"100000"` |

The demo's inference product is priced at $0.01 (`"10000"`), so settlement is
10% of the price after the free tier and zero for the first 1,000 calls each
month. A $0.001 product would net nothing, which is why the demo does not use
one.

## 11. What this document does not decide

- The sales ingest route's path and the merchant key's format are #4897's.
- The licence and the distribution decision are #4887's, after the pilot.
- ERC-7710 support, and advertising it when a facilitator supports it, is
  #4887's. The kit advertises EIP-3009 only.
- Opper's terms for the demo are checked in #4892 before the demo is shown
  outside Haven.
- The proxy's money-path classification is the owner's decision recorded on
  #4893: a control file until a QA scenario drives it, runtime once #4892
  deploys it with a harness address.

