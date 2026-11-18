---
owner: "@d-hinders"
status: current
covers:
  - packages/demo-merchant-mcp/src/x402.ts
  - packages/demo-merchant-mcp/src/http.ts
  - packages/demo-merchant-mcp/src/products.ts
  - packages/demo-merchant-mcp/src/cdp.ts
  - packages/merchant-payments/src/cdp.ts
  - packages/merchant-payments/src/cdp-settlement.ts
  - packages/merchant-payments/src/consumed-payment-store.ts
  - packages/merchant-payments/src/settle-once.ts
  - packages/merchant-payments/src/sale-report.ts
  - packages/merchant-payments/src/merchant-reference.ts
  - packages/demo-merchant-mcp/src/sales.ts
  - packages/sdk/src/merchant-discovery.ts
  - packages/sdk/src/merchant-egress.ts
  - packages/sdk/src/merchant-completion.ts
  - packages/sdk/src/merchant-answer.ts
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/connect/src/runtime-manifest.ts
  - scripts/release-bump.mjs
  - .github/workflows/publish.yml
  - packages/backend/src/routes/machine-payments.ts
  - packages/backend/src/routes/merchant-sales.ts
  - packages/demo-merchant-mcp/src/invoice.ts
  - packages/merchant-payments/src/receipt.ts
  - packages/merchant-payments/src/tax-declaration.ts
  - packages/merchant-payments/src/authorization-digest.ts
  - packages/paywall-proxy/src/**
  - packages/backend/src/modules/accounting/receipt-statement.ts
  - packages/backend/src/modules/accounting/receipt-underlag.ts
  - packages/backend/src/modules/mpp/merchant-receipt.ts
  - packages/sdk/src/x402.ts
  - packages/signer/src/siwx.ts
last-verified: "2026-11-18"
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
| Sales reporter | After each settled call the proxy sends a small record to Haven. The reporter itself is the shared core's (`sale-report`, #4950); the proxy wires it in. | Yes for the pilot; optional for a merchant that only wants to accept payments | #4950 (core), #4898 (proxy) |

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
for the pilot (owner decision of 2026-11-16, recorded under *Owner decisions*
on epic [#4884](https://github.com/d-hinders/Haven-AI/issues/4884): licence and distribution are decided after the first pilot).

| Package | Directory | What it holds |
|---|---|---|
| `@haven_ai/merchant-payments` | `packages/merchant-payments/` | The shared payment core from #4890: the receipt builder and the buyer's tax-declaration check (section 11), the Coinbase facilitator client and its timeout and credentials handling, the checks made before a payment is sent for verification, the chain recovery that reads the chain when the facilitator's answer is lost, the settle-exactly-once coordinator, and the consumed-payment store interface in section 6 with an in-memory implementation (the demo merchant's). |
| `@haven_ai/paywall-proxy` | `packages/paywall-proxy/` | The proxy from #4893: the products file reader, the challenge, the settlement call into the core, the persistent consumed-payment store, the upstream forwarder and the sales reporter. |

Both are `private: true` and pin internal dependencies as `"*"`, as
`lint:workspace-pins` requires. The core is the code that lived in
`packages/demo-merchant-mcp/src/cdp.ts` and the Coinbase path in
`packages/demo-merchant-mcp/src/x402.ts`, moved without changing the demo
merchant's behaviour (#4890); the demo merchant now calls it. It takes the chain id, the USDC address
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
- a licence decision for the kit. The repository is public with no root
  `LICENSE` file (the five published packages declare `MIT` in their own
  `package.json`), so the kit packages would need a licence, a `repository`
  block and a distribution decision, which epic #4884 defers to after the
  pilot.

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
| `products[].name` | No | Human name. When present it is the sale record's `product_name`; when absent the proxy sends the `id`. Part of the receipt line (section 11), so it is under the same character rule as `description`. |
| `products[].route` | Yes | `METHOD /path`, matched exactly against the request's method and path after the proxy's base path. A product is selected by its route. |
| `products[].model` | No | When present, the request body's `model` must equal it, or the request is refused before settlement. This is how an inference product is pinned to one model. |
| `products[].price` | Yes | The price in whole atomic USDC units, as a decimal string. USDC has 6 decimals, so `"10000"` is $0.01. Never a float and never a dollar string: a JSON number is refused, because a float cannot represent every atomic amount exactly. |
| `products[].output_token_cap` | No | The maximum output tokens one purchase buys. Required for an inference product; absent for a product that is not token-priced. |
| `products[].description` | Yes | Shown in the 402 challenge and in the discovery document. The receipt line is composed from it and the name (section 11), and **the composed line is at most 300 characters** with no character Haven's receipt reader refuses: the reader reads at most 300 and refuses the whole receipt otherwise. The description alone is therefore well inside the 500 Coinbase's facilitator allows at verify and settle (section 4). The proxy refuses a products file that breaks either rule at startup, naming the product. |
| `products[].input_example` | No | An example request body for this product, carried into the challenge's directory block when listing is on (section 4). It must pass the proxy's own checks (the route, `model`, a settable cap), because a directory probes the route with it. Without it a directory can list the product but an agent cannot build a valid call from the listing. |
| `products[].input_schema` | No | A JSON Schema the request body validates against, for the same block. |
| `products[].output_example` | No | An example response body, for the same block. |

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
The SDK probes exactly `/.well-known/haven-demo-merchant` and `/`
(`MERCHANT_DISCOVERY_PATHS` in `packages/sdk/src/merchant-discovery.ts`) and
acts on `mcp_url` for MCP merchants; a kit document at the demo path, or
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
| `operator.contact` | No | A URL or address a reader can use to reach the operator: `OPERATOR_CONTACT`. |
| `name`, `description` | Yes | Human identification of the endpoint: `ENDPOINT_NAME` and `ENDPOINT_DESCRIPTION`. The proxy refuses to start without them. |
| `network` | Yes | CAIP-2 identifier. The same value the challenge advertises. |
| `asset` | Yes | The USDC contract address on that network. |
| `pay_to` | Yes | The receiving address. One setting of the deployment; every product is paid to it. |
| `settlement.scheme` | Yes | `exact`. The kit does not offer `upto` or `batch-settlement`. |
| `settlement.facilitator` | Yes | `coinbase-cdp`, the only value for the pilot: the #4890 core is Coinbase's client. |
| `settlement.methods` | Yes | `["eip3009"]`. The kit advertises EIP-3009 only; ERC-7710 is later work (#4887). |
| `products[]` | Yes | The same product objects as the products file: `id`, `name`, `route`, `model`, `price`, `output_token_cap`, `description`. |
| `updated` | No | RFC 3339 timestamp of the last change, for caches. |

The document starts from the one the demo merchant serves today
(`packages/demo-merchant-mcp/src/http.ts`, built from
`packages/demo-merchant-mcp/src/products.ts`) but is a different shape, not a
superset. It drops the demo's MCP and environment fields (`mcp_url`,
`current_base_url`, `hosted_urls`, `routing`, `environment`, `chain_id`,
`settlement_methods`, `default_settlement_method`, and per product `category`,
`tools`, `settlement_methods`, `default_settlement_method` and the conditional
`qa_fixture`). It replaces the
demo's human-decimal `price_usdc` with atomic `price`, keeps `network`, and
adds `version`, `operator`, `asset`, `pay_to`, `settlement` and per product `route`
and `description`. The demo merchant keeps serving its own document,
unchanged, at its own paths; the kit's document is the proxy's.

### Fields for Coinbase's directory

Read from Coinbase's pages on 2026-11-17 (neither page shows a last-updated
date):

- <https://docs.cdp.coinbase.com/x402/bazaar> — "Discover services (Bazaar)",
  the buyer-side overview.
- <https://docs.cdp.coinbase.com/x402/seller/get-discovered.md> — "Get
  discovered (Bazaar)", the seller guide.

What those pages say decides where the directory fields go:

- **The directory does not read this document.** Neither page mentions
  `/.well-known/x402` or any other file on the seller's domain. The Bazaar
  reads the endpoint itself: a 402 challenge carrying an `extensions.bazaar`
  block, and a settled paid call through Coinbase's facilitator whose settle
  request carries `paymentPayload.extensions.bazaar` and
  `paymentPayload.resource`. There is no registration form or separate API
  call. Indexing can take up to 15 minutes after the settled call.
- **So the fields go in the challenge, and only when listing is on.** A
  settle that carries `extensions.bazaar` is what indexes a route, and Haven's
  SDK copies the merchant's whole `extensions` object from the challenge into
  the payment payload (`packages/sdk/src/x402.ts`, #2361), which the core
  forwards to Coinbase's settle call. A challenge that always carried the
  block would list every deployment on its first settled call. The deployment
  setting `DIRECTORY_LISTING` is therefore `off` by default; with it `off` the
  challenge carries no `extensions.bazaar`. Haven's demo (#4892) leaves it off:
  the owner decision of 2026-11-17 on [#4884](https://github.com/d-hinders/Haven-AI/issues/4884) keeps the demo unlisted and parks
  listing in #4887.
- With `DIRECTORY_LISTING=on` the proxy builds the block from the products
  file, and this document mirrors the same metadata so every reader sees it:

| Directory field | Where it lives | Kit source |
|---|---|---|
| Route key, `METHOD /path` with a specific method and absolute path | the challenge's `extensions.bazaar` (`method`) and the resource URL | `products[].route` |
| `description`, at most 500 characters | the route's challenge; verify and settle reject a longer one | `products[].description`, which the kit already caps at 300 (section 3) |
| `info.input` (an example request body) and its schema | `extensions.bazaar` | `products[].input_example`, `products[].input_schema` |
| `output.example` | `extensions.bazaar` | `products[].output_example` |
| `price` | the challenge's payment requirements | `products[].price` |
| `resource.iconUrl`, a public JPG, JPEG, PNG, WebP or GIF image (not SVG) | the challenge's `resource` object | the deployment's `ICON_URL` setting, also served here as `icon_url` |

The discovery document therefore gains, per product, the optional
`input_example`, `input_schema` and `output_example` of the products file, and
at the top level an optional `icon_url`. They are optional in version 1, so
the version does not change.

The seller guide does not give the full JSON schema of `extensions.bazaar` or
a required-or-optional table. Building the block, and checking it with
Coinbase's validator (`POST https://api.cdp.coinbase.com/platform/v2/x402/validate`
with `{"resource": ..., "method": ...}`, no API key; it checks reachability,
the 402 answer and the block), belongs with listing in #4887. The pilot builds
`DIRECTORY_LISTING=off` only.

One side effect to know when listing is turned on: Haven's SDK reads an
`extensions.bazaar` block as a sign of an MCP merchant
(`packages/sdk/src/mcp-merchant-transport.ts`) and tries an MCP `initialize`
POST first. That POST carries no payment, so the proxy answers it with the
challenge (402) and no `mcp-session-id`, and the SDK falls back cleanly, at the
cost of one extra unpaid request against the per-IP limit.

Conditions the deployment inherits, from the same pages:

- **A settled call through Coinbase's facilitator is what lists a route.** A
  deployment settling through the x402.org facilitator is not in the Coinbase
  Bazaar; x402.org keeps a separate catalog.
- **Testnet routes surface in the discovery endpoints** once verify and settle
  have run through Coinbase on Base Sepolia, but curation needs live mainnet
  payments, so a Base Sepolia deployment is listed and never curated.
- **A route with no settlement for 30 days lapses** from the listing.
- **Metadata is content-checked.** A description that could read as an
  instruction to an agent gets the route rejected or delisted, so a product
  description states what the call does and nothing else.

Listing a deployment is not part of the kit epic's build (#4884); the fields
exist so a merchant that wants to be listed has nothing to retrofit.

### How an older kit is treated

A document with no `version` is not a kit document: the demo merchant's
document has none, and it lacks fields version 1 requires, so a reader does
not read it as version 1. A reader that finds a higher version than it knows
reads the fields it knows and ignores unknown fields; it does not refuse the
document. A missing optional field means what the field tables say its
absence means (an absent `output_token_cap` is an uncapped product, an absent
`operator.contact` is no contact, and so on). The discovery document is a catalogue,
not an authority: a reader that cannot understand a product simply does not
offer it.

The sale record is stricter (section 5): Haven refuses a record whose `version`
it does not know, because it cannot know what the fields mean.

## 5. The sale record

After each settled call the merchant sends one sale record to Haven. The record
is JSON, `POST`ed to `POST /merchant/sales` with
`Authorization: Bearer <merchant key>` and `Content-Type: application/json`.

**One reporter, two consumers (#4950).** The record is built and sent by the
shared core, `packages/merchant-payments/src/sale-report.ts`:
`buildSaleRecord` makes the record below and `reportSale` posts it with the
retry policy under *Delivery*. It takes the Haven base URL and the key as
arguments and reads no environment variable. `newMerchantReference`
(`merchant-reference.ts`) is the one `sale_<ULID>` generator; the settle-once
coordinator and the proxy both call it, and no other package defines one.

- **The demo merchant** (#4950) reports the sales of its one Sales product,
  `field_notes`, paid into its Haven Sales account. Its settings are
  `MERCHANT_SALES_ADDRESS`, `MERCHANT_SALES_KEY` and the existing
  `MERCHANT_HAVEN_BASE_URL`; the demo merchant README says how it holds what
  is in flight.
- **The paywall proxy** (#4898) reports every settled call, to the URL in
  `HAVEN_SALES_URL` with `HAVEN_MERCHANT_KEY`.

The route and the merchant key (the Sales key) are Haven's (#4897); a
consumer only needs the URL and the key. The key's limits — what it can and cannot do, the accepted
residual, and how revocation works — are documented for merchants in
[`docs/security/merchant-key-limits.md`](../security/merchant-key-limits.md);
the kit README links there.

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
  "merchant_reference": "sale_01JB8Z3K4M5N6P7Q8R9S0T1V2W",
  "receipt_number": "FAK-5552735618149454",
  "vat_treatment": "SE_25"
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
| `merchant_reference` | Yes | The merchant's own reference for the sale. A ULID generated once per payment (`sale_<ulid>`, `newMerchantReference` in the core) when the payment is reserved, kept in the consumed-payment store (section 6) and, on the demo merchant, on the settled payment (`SettledPayment.merchantReference`), sent, and logged. A payment has one reference however often its call is retried or its record resent. Haven stores it and does not interpret it. |
| `receipt_number` | When a VAT rule is configured | The number the payment's receipt carries (section 11), derived from `tx_hash`, so it is known at settlement whether or not the call later delivers. It lets the merchant find the sale on Haven from the receipt and the other way round. Absent when the deployment has no VAT rule and so issues no receipts. |
| `vat_treatment` | When a VAT rule is configured | The VAT treatment for this payment, `SE_25` or `REVERSE_CHARGE`, decided at settlement from the rule and the request's declaration (section 11). Absent with `receipt_number`. |

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
| `amount` | Haven stores what the chain read gives (#4897 defines how several transfers in one transaction are summed); the record's value is not used. | |
| `payer` | Haven stores the sender or senders the chain read gives (#4897 defines several payers); the record's value is not used. | |
| asset and time | Yes: the transfer must be USDC, and its time comes from the chain. | |
| `product_id` | | Yes. Nothing on-chain names a product. |
| `product_name` | | Yes. Display only. |
| `merchant_reference` | | Yes. Stored, not interpreted. |
| `receipt_number` | | Yes. Haven can recompute it from `tx_hash` but stores what the merchant sent. |
| `vat_treatment` | | Yes. The merchant decides its own tax treatment; Haven records what it states. |
| `version` | | Shape-checked only; an unknown version is refused. |

A record whose hash paid a different Haven account gets the same answer as a
hash that paid nobody, so a merchant key cannot be used to test whether a hash
paid another account (#4897).

### The route and its answers

`POST /merchant/sales`, authenticated by the merchant key alone (the account is
the key's, never the record's), limited to 120 requests a minute per key, whichever header carries it. The
body is the record above, with no other field. Every answer below is documented
in Haven's OpenAPI spec, and a refusal carries `error` and `error_code` with the
same machine-readable code, and `message` in words.

| Situation | Answer |
|---|---|
| A new sale was stored | 201, the sale |
| An identical resend: the same transaction and the same `product_id`, `product_name`, `merchant_reference`, `receipt_number` and `vat_treatment` | 200, the same sale; nothing is written |
| A different record for a transaction that already has a sale on the account | 409 `sale_record_conflict`; the first record stands |
| The receipt is not found yet, or has fewer than 3 confirmations | 425 `transaction_not_visible`, with `Retry-After: 10` and `retry_after_seconds: 10`. The only 4xx answer the proxy retries |
| The transaction is confirmed but has no USDC transfer into the key's account | 422 `no_payment_to_account`. The same answer whether it paid another Haven account or nobody |
| `chain` is not `eip155:<the key account's chain id>` | 422 `chain_mismatch` |
| `version` is anything but 1 | 400 `unsupported_record_version`; version 1 is the only one |
| The chain could not be read | 503 `chain_unavailable`; nothing is stored. Retry |

The sale carries the amount, payer, token and time Haven read from the chain.
When one transaction carries several USDC transfers into the account, the sale
attaches to the transaction: its amount is the sum of the transfers that do not
come from the owner's own addresses, and its payer is the single sender when
every revenue transfer shares one, otherwise "several payers" (an own leg beside
one customer leg is the customer's sale). A sale is its own record,
not a match kind: it cannot block a receipt or an x402 match and it does not
change the receive balance.

### Delivery

The proxy sends **one record per payment**, once, after settlement, whatever
happens to the upstream call: the payment settled either way.
`saleReported` in the consumed-payment store records that it was sent, so a
retried call never sends a second, different record (#4897 refuses a second
record for the same transaction that differs from the first).

Delivery is at-least-once. The core reporter retries a 5xx, a timeout (no
answer in 10 s) or a network failure, and the answer #4897 defines for "the
transaction is not visible on the chain yet, retry" — 425
`transaction_not_visible` (Haven accepts a record only after 3 confirmations,
so a record sent straight after settlement usually gets that answer first) —
with exponential backoff (1 s, 4 s, 16 s), each wait raised to the answer's
`Retry-After` (capped at 60 s). After the last retry the reporter returns the
outcome to its caller. The proxy then moves the record to a bounded
on-disk outbox (`SALES_OUTBOX`, JSON Lines, 10,000 records) that a background
task replays every 60 s. Any other 4xx is not retried: the record was refused,
and the reporter logs `sales_report_refused` with the answer's status and code. When the outbox is
full the proxy keeps the records it has, logs `sales_outbox_full` for each
record it cannot add, and the merchant must clear the cause (section 12).
Haven's ingest is idempotent on chain, transaction hash and account, so a
resent identical record is harmless.

The demo merchant has no outbox (#4950). It reports only a payment
`settled_onchain`, once per transaction (an in-memory dedupe, so a replayed
payment header sends nothing more), without making the buyer wait, and after
the last retry it logs `sales_report_gave_up` and keeps nothing. A restart
forgets what was in flight, as it forgets the rest of its state.

## 6. The consumed-payment store

The demo merchant keeps settled payments in memory and serves a settled
payment again when it is presented again, including after a restart (the
shared core's settle-once coordinator, `packages/merchant-payments/src/settle-once.ts`,
over the in-memory store in `consumed-payment-store.ts`). The proxy needs the opposite: a
payment buys one call, remembered across restarts. The core calls a store
through one interface; each consumer supplies its own implementation and
policy.

### The interface

```ts
export type ConsumedPaymentState =
  | 'settling'
  | 'settlement_unknown'
  | 'settled'
  | 'forwarding'
  | 'delivered'
  | 'failed'
  | 'exhausted'

export interface ConsumedPaymentRecord {
  key: string
  state: ConsumedPaymentState
  productId: string
  chain: string
  payer: string
  amount: string
  /** The authorization's `validBefore`, in seconds. */
  validBefore: number
  /** When the key was reserved; bounds how long a `settling` record's holder is trusted. */
  reservedAt: string
  /** Generated once, at reservation; the sale record's `merchant_reference`. */
  merchantReference: string
  /**
   * SHA-256 of the full signed authorization: from, to, value, validAfter,
   * validBefore, nonce and the signature, in a canonical form (addresses and
   * hex lower-cased, integers in decimal) so the same authorization always
   * gives the same digest (`authorizationDigest` in the core). A change to the
   * encoding would turn every known key into `payment_mismatch`.
   */
  authorizationDigest: string
  txHash?: string
  settledAt?: string
  forwardingStartedAt?: string
  forwardCount: number
  deliveredAt?: string
  failedAt?: string
  failureReason?: string
  upstreamStatus?: number
  saleReported: boolean
}

export interface ConsumedPaymentStore {
  /**
   * Reserve the key BEFORE verify and settle. Returns `reserved` for a new
   * key, or the existing record when the key is known.
   */
  reserve(input: {
    key: string
    productId: string
    chain: string
    payer: string
    amount: string
    validBefore: number
    merchantReference: string
    authorizationDigest: string
    now: string
  }): Promise<
    // The token is returned here and nowhere else. The store keeps only its
    // SHA-256, in a column ConsumedPaymentRecord omits, so neither reserve's
    // known-key answer nor get ever returns it.
    { reserved: true; reservationToken: string } | { reserved: false; record: ConsumedPaymentRecord }
  >

  /**
   * Record the settlement, as one conditional update on the record's state.
   * - With the reserving request's `reservationToken`: a `settling` record
   *   whose stored token hash matches moves straight to `forwarding`,
   *   forwardCount 1, and the answer is `forward`. This is the in-process
   *   first forward, the only one that needs no proof.
   * - Without a token: a `settlement_unknown` record, or a `settling` record
   *   with no token hash (cleared at startup, or by a later request past
   *   `RESERVATION_DEADLINE_MS`), becomes `settled`, and the
   *   answer is `settled`. Forwarding it needs a proof.
   * - Anything else changes nothing and answers `not_settleable`; the caller
   *   reads the record again and answers by its state.
   */
  markSettled(
    key: string,
    input: { txHash: string; settledAt: string; reservationToken?: string },
  ): Promise<'forward' | 'settled' | 'not_settleable'>

  /**
   * settling → settlement_unknown, clearing the token hash: the reserving
   * request gave up learning the settle outcome and answers 503.
   */
  markSettlementUnknown(key: string, now: string): Promise<void>

  /**
   * settling → removed: any failure before settlement (verify rejected,
   * settle definitely failed with the authorization unused).
   */
  release(key: string): Promise<void>

  /**
   * Atomically move a settled, failed or stale forwarding record to
   * forwarding. The core calls it only after it has verified a
   * SIGN-IN-WITH-X proof from the record's payer; the store checks no proof.
   */
  beginForwarding(key: string, now: string): Promise<'forward' | 'in_flight' | 'delivered' | 'exhausted'>

  markDelivered(key: string, input: { upstreamStatus: number; deliveredAt: string }): Promise<void>

  markFailed(key: string, input: { reason: string; failedAt: string }): Promise<void>

  markSaleReported(key: string): Promise<void>

  get(key: string): Promise<ConsumedPaymentRecord | null>
}
```

The core calls `reserve` before it sends a payment for verification, and
`markSettled`, `markSettlementUnknown` or `release` around its verify and
settle calls, in a `finally` so that a request that throws still leaves the
record in one of those states. The `finally` calls `release` only when the
settle call was never sent; once it may have been sent, it calls
`markSettlementUnknown`, never `release`, because a released key whose
settlement landed could be reserved again. **Every failure before settlement releases the reservation**, a
verify rejection included, so a header that never verifies cannot hold a key.
The key contains the payer and the nonce, which are public once the payment
settles (USDC's `AuthorizationUsed` event emits both), so **the key alone
authorizes nothing.** Every request whose key is known must also match the
record's `authorizationDigest` exactly. A request that does not is not that
payment: it is answered 402 `payment_mismatch` and does not touch the record,
whatever the record's state.
The consumer calls `beginForwarding`, `markDelivered` and `markFailed` around
its own work. The core keeps no map of its own: the store is the one place a
payment is recorded.

### The key

The key is the payment authorization's identity, not the transaction hash,
because a duplicate can arrive before the settlement transaction exists:

- EIP-3009: `eip3009:<chain>:<payer>:<nonce>`, lower-cased.
- ERC-7710: `erc7710:<chain>:<delegator>:<permissionContextHash>`, lower-cased.

The proxy accepts EIP-3009 only, so its keys are the first form. The key is
derivable from the payment header alone, which is what makes the one-call rule
survive a restart: the buyer presents the same header, the proxy derives the
same key, and the store answers.

**A known key is answered from the store first,** before the payment checks
section 8 makes before settlement, once its digest matches, and its answer
follows the record's state (section 8, *For a known key*). The body checks
(JSON, `model`, the cap, the size) still run on every request. Their failure
on a record that would be forwarded (`settled`, `failed`, or a `forwarding`
record older than the takeover threshold) is answered 200
`bad_request_after_settlement`: not forwarded, and no forward used, so a
re-presented payment can never carry an uncapped or oversized request
upstream. A record in any other state is answered by its state's own answer,
whatever the body: an unsettled one (`settling`, `settlement_unknown`) with
503 or 402, never a 200.

**The full authorization is public too.** The signed authorization is in the
settlement transaction's calldata, so after settlement anyone can rebuild the
exact header, and a digest match proves nothing about who presents it. What
the header could still buy is a forward: the retry of a `failed` call, the
takeover of a stale `forwarding` one, or the first forward of a payment whose
settlement a later request found on the chain. **Exactly one forward needs no
proof: the one made in-process by the request that holds the reservation.**
That request settles the payment (resolving a lost settle answer itself,
within `SETTLE_RESOLVE_MS`, while the record is still `settling`) and calls
`markSettled` with its `reservationToken`, which moves the record straight to
`forwarding` in one conditional update. The token lives only in that request's
memory; the store keeps its hash, never returns it, and **clears every token
hash at startup**, so a restart voids the exemption for every payment in
progress. No other request ever holds the token, so no other request can make
that forward, however exactly it rebuilds the header.

**Within its deadline, no other request resolves the holder's payment.** A
`settling` record that still has a token hash and is younger than
`RESERVATION_DEADLINE_MS` is answered 503 `settlement_unknown` to any other
request, which makes no verify, settle or chain read. Only a
`settlement_unknown` record (the holder has answered 503 and cleared its
token) or a `settling` record with no token hash (after a restart, or cleared
past the deadline, below) is resolved by a later request, from the
chain, and a payment found there becomes `settled`, never `forwarding`. So a holder that finishes within `RESERVATION_DEADLINE_MS` cannot
lose its `markSettled` to another request, and its buyer never needs a proof
for its own first forward.

**The holder has a deadline.** The token hash is trusted for
`RESERVATION_DEADLINE_MS` (120 s) from `reservedAt`. From `reservedAt` the
holder's worst case is the core's chain read before verify (the "chain first"
check in `packages/merchant-payments/src/cdp-settlement.ts`, bounded at 10 s as below),
verify at 30 s, the upstream slot wait at 10 s (taken after verify, section
7), settle at 30 s, and `SETTLE_RESOLVE_MS` (30 s): 110 s.
When the chain-first read finds the authorization already used, the recovery
that finds its transaction (`recoverUsedAuthorization` and its log-window scan
in the core's `cdp-settlement.ts`) replaces verify and settle and is bounded in total at
`SETTLE_RESOLVE_MS` (30 s), whatever `validAfter` the buyer chose; not found in
time, the holder answers 503 `settlement_unknown` as for a lost settle answer.
**Found and checked, the holder does not forward it** (amended by the review of
#4893). This holder never sent that settlement, and the authorization is
public in its calldata, so the request may be anyone's replay: another proxy on
the same `PAY_TO`, or a store restored from a backup that predates the
delivery. The holder records the settlement without its token (`settled`) and
answers 200 `payment_retry_needs_proof`: the payment settled, so the answer
stays 2xx, and a forward needs a `SIGN-IN-WITH-X` proof from the payer. The one
proof-free forward is a settlement the holder itself sent.
The check that a found event paid this merchant (below) runs inside the
`SETTLE_RESOLVE_MS` bound, not after it.
**Every chain read is bounded at 10 s in total.** The demo merchant's client
before #4890 was viem's default `http()` transport, whose 10 s timeout is per
attempt and which retries a timed-out read three times, so one hung read could
take about 41 s. The shared core (`packages/merchant-payments/src/cdp.ts`) does
both: it builds the transport with `retryCount: 0` and a 10 s timeout, and races
each chain read against `CHAIN_READ_TIMEOUT_MS` (10 s), as `withCdpTimeout`
does for verify and settle. A recovery search that does not finish inside
`SETTLE_RESOLVE_MS` is answered "outcome unknown, retry the same header", never
served. The resolve poll starts no read
that could end after `SETTLE_RESOLVE_MS` and cuts off one still running at
that bound, so the 110 s holds and leaves 10 s of margin. The deadline is measured on the process's monotonic clock
(the deadline only matters within one process, since a restart clears every
token hash), with `reservedAt` recorded for the log. A later request that finds a `settling` record older than that treats
it as tokenless: it clears the hash in one conditional update (state still
`settling`, `reservedAt` unchanged) and then resolves it from the chain as
after a restart. When that update changes no row, the holder or another later request got
there first: the later request reads the record again and acts only on what
the re-read finds, never on the strength of its own failed clear. A holder that hung and wakes late then gets `not_settleable`, and so
does a holder whose hash a restart cleared. **On `not_settleable` the holder
reads the record again and answers by its state, as any later request would:**
its own buyer then needs a proof, the same loss path as a restart mid-settle.

**One proxy process per `PAYMENTS_DB`.** Clearing every token hash at startup
is safe only because no other process holds one. The proxy opens the database with
`PRAGMA locking_mode=EXCLUSIVE` and a write transaction at startup, and refuses
to start on `SQLITE_BUSY`; the operating system drops that lock when the
process dies, so a crash never blocks the next start. That makes deploying by
stop-then-start, never overlapping, and one replica per store, a requirement on
the operator (section 12). **Every other forward requires a
`SIGN-IN-WITH-X` header** (CAIP-122) signed by the record's payer address.
Without a valid one the answer is 200 `payment_retry_needs_proof` with a
challenge: nothing is forwarded and no forward is used. Haven's signer already
signs this proof (`haven_sign_siwx`). A buyer whose client cannot sign it gets
no further forward whenever the reserving request's own first forward does not
deliver: it failed, it never ran (a settlement found later on the chain, a
restart mid-settle, a holder past its deadline), or the proxy restarted
mid-forward. Its payment can then only be refunded by hand from the merchant's
log.

**The challenge.** The answers that leave a record a proof could forward
(`upstream_failed_after_settlement`, `payment_retry_needs_proof`,
`payment_in_flight`, `bad_request_after_settlement`,
`at_capacity_after_settlement`) carry a challenge under
`sign_in_with_x`. Any other answer whose retry would need a proof (503
`settlement_unknown`, when the settle lands later) is followed by one
`payment_retry_needs_proof` round trip, which carries it. The challenge is sent
in the `{ info, supportedChains }` form, built to what Haven's signer accepts
(`validateSiwxChallenge` in `packages/signer/src/siwx.ts`), or Haven's buyer
cannot answer it:

- the proxy's URL is `https`;
- `domain` is the request URL's host, with no whitespace, and `uri` has the
  URL's scheme and host;
- `version` is `1`;
- `nonce` is alphanumeric, at least 8 characters;
- `issuedAt` is a parseable timestamp;
- `expirationTime` is an absolute timestamp, not in the past and at most 300 s
  away (the signer allows 30 s of clock skew on either edge);
- `supportedChains` offers the payment's chain as `eip155:<chainId>` with type
  `eip191`. The signer checks it against its own credential's chain, which for
  a Haven buyer is the payment's chain;
- every string field is a single line, and no scalar field is anything but a
  string.

**The challenge nonces are the proxy's, not the store's.** The proxy keeps
them in its own table in the `PAYMENTS_DB` file, outside the
`ConsumedPaymentStore` interface: **one live nonce per payment key**, issued
again unchanged while at least 60 s of it remain and replaced by a fresh one
after that, so a stranger replaying a public header cannot grow the table.
Expired rows are pruned on the same write. A proof is accepted only for that
key's live nonce, before it expires, and only once. **Retiring the nonce is
the acceptance point**, one conditional update (still this key's live nonce,
unexpired, not yet retired) made after the upstream slot is taken (section 7),
so of two concurrent requests with the same proof only one forwards; the other,
like a proof whose nonce or `expirationTime` lapsed while it waited, is
answered `payment_retry_needs_proof` with the key's live challenge. The next
answer after an accepted proof issues a new nonce. A proof whose recovered address is
not the record's `payer` is answered `payment_retry_needs_proof` with the same
challenge. **Answers to a known key whose digest matches, and that forward
nothing, are not rate-limited** (section 7). For a settled payment, the only
kind whose header is public, each costs one store read and at most one nonce
write per key per nonce lifetime, and no upstream call, so a replayed public
header buys a stranger nothing and costs the merchant almost nothing. The
states that read the chain (`settlement_unknown`, `settling` without a token)
are almost always left before the header is public. When a settle lands after
a 503 they are not, so **chain resolution is single-flight per key** within the
process: a request that finds a resolve of its key already running answers 503
`settlement_unknown` with `Retry-After` and reads nothing, and a burst of
replays costs one bounded resolve until it writes `settled`.
A 429 there would also be a non-2xx answer to a settled payment, which Haven
would read as a rejection after funding (section 8). The demo merchant needs neither: it serves a cached
result again and makes no second upstream call, so it asks for no proof.

### The states

| State | Meaning | Next states |
|---|---|---|
| `settling` | Reserved; verify and settle are in progress, in the reserving request (or that request's process died). | `forwarding` (settled by the reserving request), `settled` (resolved by a later request after a restart or after `RESERVATION_DEADLINE_MS`), `settlement_unknown`, removed |
| `settlement_unknown` | The reserving request did not learn the settle outcome within `SETTLE_RESOLVE_MS`, answered 503 and cleared its token; chain recovery has not yet found a transaction. | `settled`, removed |
| `settled` | Settlement was confirmed by a request that does not hold the reservation (chain resolution of a `settlement_unknown` record, or of a `settling` one after a restart or past `RESERVATION_DEADLINE_MS`), and the transaction hash is recorded. The call has not been forwarded; forwarding it needs a proof. | `forwarding` |
| `forwarding` | The upstream call is in flight. `forwardingStartedAt` bounds it. | `delivered`, `failed` |
| `delivered` | The upstream gave a complete answer the proxy can pass on (below) and the proxy wrote it to the buyer. | none |
| `failed` | The upstream call failed. The payment may be served again. | `forwarding`, `exhausted` |
| `exhausted` | The payment was forwarded `MAX_FORWARDS_PER_PAYMENT` times (3) and failed each time. | none |

`markSettled` with the reservation token is the atomic transition for the
reserving request's first forward. `beginForwarding` is the atomic transition
for every other forward, and the core calls it only once a proof has verified.
It returns `forward` when the record was `settled`, or `failed` with `forwardCount` below the cap, or
`forwarding` and older than the **takeover threshold** (it first marks that
record `failed`); it increments `forwardCount`. The takeover threshold is
`UPSTREAM_TIMEOUT_MS` plus 30 s, strictly longer than any call can run, so a
call that is still running is never taken over. It returns `in_flight` for a
younger `forwarding` record, `delivered` for a delivered one, and `exhausted`
when the cap is reached (it marks the record `exhausted`). The implementation
does this with one conditional update and checks the affected row count, so
two concurrent requests cannot both get `forward`.

A `settling` or `settlement_unknown` record is resolved by the core, not by
`beginForwarding`, either by the reserving request or, under the rule above,
by a later one: it looks for the USDC `AuthorizationUsed` event for the
authorization's payer and nonce, reading at the latest block as the core does
today (the event, not `authorizationState`, which is also true for a cancelled
nonce). The event alone is not enough, as in the core's `paidMerchant`
(`packages/merchant-payments/src/cdp.ts`): the record becomes `settled` only
when the event's transaction succeeded and moved exactly the product's price
in USDC from the payer to `PAY_TO`. An authorization used in a transaction
that did not pay this merchant (`used_elsewhere` in the core) is released and
refused 402 `payment_mismatch`. When the settle call's
answer is lost, the first request polls the chain for up to
`SETTLE_RESOLVE_MS` (30 s) before it answers, so an ordinary slow settle is
resolved within the request. Still not found, the answer is **503
`settlement_unknown`** with `Retry-After`, deliberately a non-2xx: Haven then
records a rejection after funding and its verify-then-sweep path takes over,
which checks the payment's status before it sweeps (section 8), so a payment
that lands later is found rather than swept, and one that never lands leaves
the funds on the delegate with a prompt to recover them. After `validBefore`
with no event, the authorization can no longer be executed, so nothing was
paid: the record is released and the payment is refused as unsettled (402
`settle_failed`).

### Policy per consumer

- **Demo merchant.** An in-memory `Map` behind the interface. A known key
  returns the existing record; the merchant serves the cached result again,
  which is its current behaviour. `beginForwarding` returns `delivered` for a
  delivered record, and the merchant serves the cached result. Nothing is
  persisted, so a restart forgets settled payments, exactly as today. The
  reservation's `merchantReference` (from `newMerchantReference`, #4950) is
  also carried on the settled payment, which is what the demo merchant's sale
  report sends; it keeps no `saleReported` flag, only an in-memory
  per-transaction dedupe (section 5, *Delivery*).
- **Proxy.** A SQLite file at `PAYMENTS_DB`, using the built-in `node:sqlite`
  module (the repository runs Node 24, so no new dependency). A payments
  table keyed on `key`, with the fields above plus the token hash, and the
  challenge-nonce table (above). A payment buys one call: a `delivered`
  record is never forwarded again, a `failed` record is forwarded again on the
  same payment, and no payment is forwarded more than three times in all.

### Restart and crash answers

| Situation | Answer |
|---|---|
| Unknown key | Reserve, verify, settle. An unknown key is never served without a settlement. |
| `settling` or `settlement_unknown` after a restart, or `settling` past `RESERVATION_DEADLINE_MS` | Resolve from the chain as above. When the event is found the record becomes `settled` (the reservation's holder is gone), and the request is forwarded only with a valid `SIGN-IN-WITH-X` proof, else 200 `payment_retry_needs_proof`. Answer 503 `settlement_unknown` while the authorization is still valid and no event is found; 402 `settle_failed` after `validBefore`. |
| `settled` after a restart | Forward with a valid `SIGN-IN-WITH-X` proof, else 200 `payment_retry_needs_proof`. The settlement is recorded and the call was never made. |
| `forwarding` after a restart, older than the takeover threshold | Mark `failed`, then forward (within the cap) with a valid `SIGN-IN-WITH-X` proof, else 200 `payment_retry_needs_proof`. The process that was forwarding is gone and no call runs past its deadline. |
| `forwarding` after a restart, younger than the takeover threshold | Answer `payment_in_flight` (200) with `retry_after_seconds` set to the remaining time. |
| `delivered` after a restart | Answer `payment_already_delivered` (200): the payment already bought its one call. |
| `failed` after a restart | Forward, within the cap, with a valid `SIGN-IN-WITH-X` proof, else 200 `payment_retry_needs_proof`. |
| `exhausted` | Answer `payment_exhausted` (200). |

**The at-least-once window.** A call that completed upstream just before a
crash, before `markDelivered` ran, is recorded `forwarding` and is forwarded
again after the takeover threshold, when the payer presents it with a proof. The merchant may pay its upstream twice for
that payment. This is accepted: the alternative, never retrying a call whose
outcome was lost, would leave a buyer who paid with nothing.

### The same payment twice while it is in progress

While the first request is forwarding, the second gets HTTP 200 with
`error: "payment_in_flight"` and `retry_after_seconds`. While the first is
still settling, the second gets 503 `settlement_unknown` with `Retry-After`,
for the reason above. No second verify, settle or upstream call is made. The first request's
outcome decides the record.

### What "the upstream call failed" means

`UPSTREAM_TIMEOUT_MS` (180 s) is **one total deadline for the whole call**,
headers and body together. It is set from the budget before the call starts,
taken from the core's constants: the 10 s chain read before verify, verify at
`CDP_CALL_TIMEOUT_MS` (30 s), up to 10 s waiting for an upstream slot (section
7), settle at 30 s (`packages/merchant-payments/src/cdp.ts`), and
`SETTLE_RESOLVE_MS` (30 s), which is 110 s at worst. 110 s plus 180 s is
290 s, which leaves 10 s of Haven's hosted 300 s delivery wait for transit. That keeps the ordinary case
well inside Haven's deadline; it does not make a timeout impossible. When
every step runs to its limit Haven can still time out first, and records the
payment as funded but undelivered, which is the open owner question in
section 13. A call **failed** when any of these is true:

- the deadline passed before the response was complete;
- the connection was refused, reset, or the DNS lookup failed;
- the upstream answered 5xx, 408 or 429;
- the upstream answered 401, 402, 403 or 407: the merchant's own key or
  account was refused, which is not the buyer's fault (logged as
  `upstream_auth_refused`; the merchant must fix its key);
- the response body was truncated: fewer bytes than `Content-Length`, or an
  SSE stream that ended without the upstream's terminal event (`data: [DONE]`
  for an OpenAI-compatible stream);
- the response was larger than the 5 MiB cap (section 7);
- the buyer disconnected before the response was written. The proxy then
  **aborts the upstream call**, so a disconnect does not keep spending.

A call **delivered** when the upstream answered with a complete body and any
other status: 2xx, 3xx, or a 4xx other than those above. Such a 4xx is the
upstream's answer to the buyer's own request (a malformed prompt, say);
retrying it would get the same answer and spend the merchant's money again. A
3xx is not followed. Every delivered answer reaches the buyer as a 2xx
(section 8): a 2xx is passed through, and a 3xx or 4xx is wrapped.

A partial response counts as failed only when the upstream's own framing says
it is incomplete. A complete body that is shorter than the buyer hoped is
delivered.

Each failed forward counts against the cap of three. The merchant may have
paid its upstream for a failed call too; the cap bounds what one payment can
cost.

## 7. The proxy's request handling

### Headers removed before forwarding

The proxy removes these request headers and never forwards them:

`PAYMENT-SIGNATURE`, `X-PAYMENT`, `X-Tax-Declaration`, `SIGN-IN-WITH-X`,
`Authorization`, `Cookie`, `Proxy-Authorization`, `Host`, `Content-Length`,
`Transfer-Encoding`, `Connection`, `Keep-Alive`, `TE`, `Trailer`, `Upgrade`,
`X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `Forwarded`,
`X-Real-IP`, `x402-wallet`, `mcp-session-id`.

`PAYMENT-SIGNATURE` and `X-PAYMENT` are the buyer's payment; the upstream has no
use for them and must not see them. `X-Tax-Declaration` and `SIGN-IN-WITH-X` are
Haven buyer metadata, and `x402-wallet` (set by Haven's SDK) names the
payer's delegate address. `mcp-session-id` belongs to an MCP session the
upstream is not part of. `Authorization` is always removed, even when the upstream
key is sent as `Authorization`: the buyer's value is replaced, never forwarded.
The proxy sets `Host` to the upstream host and recomputes `Content-Length`. It
does not add `X-Forwarded-For` or any other forwarding header, so the upstream
sees the proxy's address and not the buyer's.

On the response side the proxy removes any upstream `PAYMENT-REQUIRED`,
`PAYMENT-RESPONSE`, `x-receipt-json` and `x-receipt-url` header and sets its own `PAYMENT-RESPONSE` with the
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
  the same payment can be retried, within the cap of three forwards, with a
  smaller output cap.
- Upstream deadline: 180 s for the whole call, headers and body together
  (`UPSTREAM_TIMEOUT_MS`, section 6), set so that the 110 s worst-case budget
  before the call plus the call stays inside the 300 s Haven's hosted path
  waits for a delivery. A call that
  exceeds it is failed.

### Limiting unpaid requests

Unpaid requests are limited per client IP: 60 requests a minute with a burst of
10, and at most 10 concurrent unpaid requests per IP. The client IP is the connection's peer
address, or, when `CLIENT_IP_HEADER` names a header the merchant's own front
proxy sets (`X-Forwarded-For`, `CF-Connecting-IP`), that header's value; for a
list, its rightmost entry, the one the merchant's proxy appended. Behind a
reverse proxy without that setting every request has the reverse proxy's
address, and the limit is shared by every buyer. Over the limit the proxy
answers 429 with `Retry-After` and no challenge. **A payment header that fails
verification counts against the same limit**, and so does one that matches a
known key but not its `authorizationDigest` (402 `payment_mismatch`): a header
that has not verified is not yet a payment, and anyone can sign one with an
empty key or rebuild one from a settled payment. Once an IP is over the limit,
its requests with an unknown key are answered 429 before they are reserved. A
header that verifies is not counted, because every hosted Haven buyer reaches
the merchant from Haven's own servers, one shared address, and counting
honest payments would throttle all of them together. A 429 comes before
settlement, so a Haven buyer recovers through verify-then-sweep (section 8). **A request whose
header matches a known key's digest is never answered 429**, so a payer whose
payment settled can always retry from behind a busy shared address (section 6).
A payment that verified is its own limit.

**Two global caps bound the merchant's own cost, whatever address requests
come from.** Concurrent verify calls are capped at 16: a request with an
unknown key over that cap is answered 503 `at_capacity` before it is
reserved, so concurrent junk headers cost at most 16 verify calls in flight,
however they are timed. A request holds its verify token from before `reserve`
until verify returns, and gives it back on any earlier exit too: `reserve`
finding a known record, the chain-first read finding the authorization used,
or a chain read that times out or fails. Requests with a payment header do not
count toward the 10 concurrent unpaid requests per IP (a header that fails
verification still counts toward the 60 a minute and the burst of 10); the verify cap bounds them instead, so
Haven's shared address is not limited to 10 payments in flight. Concurrent
upstream calls are capped at 32, and **a request takes its upstream slot after
verify and before settle**, so a header that has not verified never holds one.
It waits up to 10 s; if no slot is free the reservation is released (the settle
call was never sent) and the request is answered 503 `at_capacity`, so nothing
is settled for a call that will not be served.

**A forward for a known key** (a proof-backed retry, the first forward of a
`settled` record, a stale takeover) takes a slot too, waiting up to 10 s, after
its proof is checked and before the nonce is retired or `beginForwarding`
runs. If none is free it is answered 200 `at_capacity_after_settlement` with
`retry_after_seconds: 10` and the challenge: no forward is used, the nonce is
not retired (the challenge carries the key's live nonce, the same one or a
fresh one under the 60 s rule), and the answer to a settled payment stays 2xx
(section 8). **Every request that takes a slot and does not forward gives it
back before it answers**: a failed nonce retire, a `beginForwarding` answer of
`in_flight`, `delivered` or `exhausted`, a settle that fails, or a settle
whose outcome is not learned within `SETTLE_RESOLVE_MS`.

**A residual this design does not solve: a per-IP limit cannot tell hosted
Haven buyers apart.** Every hosted Haven buyer reaches the merchant from
Haven's own servers, and that one address also sends their unpaid traffic:
Haven fetches each challenge itself on quote and pay, and a listed MCP merchant
gets an unpaid `initialize` too. Enough of that traffic, or about ten failing
headers in a burst from one broken or hostile Haven agent (a Haven agent holds
its own delegate key, so it can spend or cancel its authorization's nonce, or
move the delegate's funds, before Haven relays it), puts Haven's address over
the limit at that merchant. Every hosted Haven buyer's next payment with an
unknown key is then answered 429 for up to a minute, after Haven funded its
delegate. Nothing is lost, since each recovers through verify-then-sweep, but
the throttle is shared. Haven can limit failed relays per agent on its side;
whether the kit should exempt or separately limit a known Haven address is an
open owner question (section 13).

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

## 8. Refusals before settlement, and every answer after it

Haven's SDK classifies the answer to a paid retry
(`decidePostFundingMerchantAnswer` in `packages/sdk/src/merchant-answer.ts`,
used by `packages/sdk/src/merchant-completion.ts`): it is **accepted** when the
HTTP status is 2xx and the body carries no in-band refusal, which is a
payment-required challenge, `_meta` with `success: false`, or an `isError`
result with no settlement hash. Anything else is
`MERCHANT_REJECTED_AFTER_FUNDING`. A Haven agent paying by EIP-3009 has already
moved USDC to its delegate address before the proxy sees the request, so a
rejection after funding leaves money on the delegate. The buyer's recourse is
the shipped verify-then-sweep rule (#4062,
`docs/architecture/04-x402-payment-sequence.md`): check
`haven_get_payment_status` first, because the merchant may still redeem the
authorization within its window, and only then `haven_sweep_delegate`.

The proxy therefore follows one rule: **before settlement, refuse with the
narrowest 4xx or 503 and make no verify or settle call; once a payment has
settled, answer 2xx with a machine-readable body.** The only non-2xx answers
to a request whose key the store knows are the two where the payment has not
settled (503 `settlement_unknown` while that cannot be told yet, 402
`settle_failed` once its authorization has expired unsettled), and 402
`payment_mismatch` for a request whose authorization does not match the
record's, because that request is not the payment. The proxy's 2xx bodies carry an `error` field, never `isError`, a
challenge or `success: false`, so Haven reads them as accepted: a payment that
reached the merchant is never reported as rejected.

The order of checks on a paid request is: the body checks (JSON, `model`, the
cap, the size); then derive the key and look it up in the store, where a known
key is answered by the table *For a known key* below (a body-check failure on
a settled key is 200 `bad_request_after_settlement`); then, for an unknown
key, the payment checks below; then the per-IP rate limit and the verify
cap (section 7); then reserve, the chain read, verify, the upstream slot wait,
and settle.

### Before settlement (unknown key)

| Condition | Status | Body `error` | Challenge? | Haven classification | Buyer recourse |
|---|---|---|---|---|---|
| No payment header, route is a product | 402 | the x402 challenge | Yes, in `PAYMENT-REQUIRED` | No payment yet | Pay the challenge |
| Payment header does not match the challenge (network, asset, `pay_to`, amount, product) | 402 | `payment_mismatch` | Yes | Rejected after funding if the agent had funded | Verify, then sweep the delegate |
| The facilitator rejects the payment at verify | 402 | `payment_invalid` | Yes | Rejected after funding if funded | Verify, then sweep the delegate |
| Settle failed and the authorization is unused (the facilitator answered a definite failure, and no transfer is found on the chain) | 402 | `settle_failed` | Yes | Rejected after funding if funded | Verify, then sweep the delegate |
| Route is not in the products file | 404 | `unknown_route` | No | Rejected after funding if paid | Verify, then sweep the delegate |
| Body is not JSON, or `model` does not match the product | 400 | `bad_request` | No | Rejected after funding if paid | Verify, then sweep the delegate |
| Product has a cap and the body cannot carry it | 400 | `cap_not_settable` | No | Rejected after funding if paid | Verify, then sweep the delegate |
| Body over 1 MiB | 413 | `body_too_large` | No | Rejected after funding if paid | Verify, then sweep the delegate |
| Rate limit: an unpaid request, or an unknown-key payment header from an IP over the limit (section 7) | 429 | `rate_limited` | No | No payment yet; rejected after funding if a Haven agent funded its delegate | Retry after `Retry-After`; verify, then sweep the delegate if funded |
| Coinbase's facilitator gave no answer at verify, or the settle call was never sent (the reservation is released; nothing settled) | 503 | `facilitator_unavailable`, with `Retry-After` | No | Rejected after funding if a Haven agent funded its delegate | Retry the same header after `Retry-After`; otherwise verify, then sweep the delegate |
| No verify capacity (before reserve), or no upstream slot within 10 s after verify (the reservation is released; nothing settled) | 503 | `at_capacity` | No | Rejected after funding if paid | Verify, then sweep the delegate |
| Proxy not ready (missing upstream key) | 503 | `not_ready` | No | Rejected after funding if paid | Verify, then sweep the delegate |

Every refusal body is JSON with `error`, a human `message`, and, where it
applies, `retry_after_seconds`. Except for the two rows that come out of the
verify and settle calls themselves, the proxy never calls the facilitator for
a request it will refuse.

### For a known key, and after settlement

Every answer to a settled payment is 2xx, because the payment reached the
merchant. The two exceptions are the payments that have not settled, at the
end of the table. The body's `error` field carries the outcome:

| Condition | Status | Body `error` |
|---|---|---|
| Upstream answered 2xx (delivered) | the upstream's 2xx | none: the upstream's body, unchanged |
| Upstream answered a 3xx or a buyer-side 4xx (delivered, section 6) | 200 | `upstream_answered`, with `upstream_status`, `upstream_content_type`, and the upstream body under `upstream_body`: the parsed JSON when the body is JSON, otherwise the body as a UTF-8 string, or base64 with `upstream_body_encoding: "base64"` when it is not valid UTF-8 |
| Upstream call failed (section 6) | 200 | `upstream_failed_after_settlement` |
| Same payment presented while a call is in flight | 200 | `payment_in_flight`, with the challenge |
| Same payment presented after its call was delivered | 200 | `payment_already_delivered` |
| A forward for a known key (with a valid proof) and no upstream slot free within 10 s | 200 | `at_capacity_after_settlement`, with `retry_after_seconds: 10` and the challenge; no forward used, the nonce not retired |
| The payment's three forwards all failed | 200 | `payment_exhausted` |
| Any forward other than the reserving request's first (a retry, a stale takeover, a settlement found on the chain by a later request) without a valid `SIGN-IN-WITH-X` from the payer (section 6) | 200 | `payment_retry_needs_proof`, with the challenge; nothing forwarded, no forward used |
| Header matches a known key but not its `authorizationDigest`, or the authorization was used in a transaction that did not pay this merchant | 402 | `payment_mismatch`: not this payment, so a refusal; the record is untouched |
| Payment settled for a different product | 200 | `payment_used_for_other_product` |
| A settled payment whose re-presented body fails the body checks | 200 | `bad_request_after_settlement`, with the challenge; not forwarded, no forward used |
| Settle outcome not yet known (`settling`, `settlement_unknown`, no `AuthorizationUsed` event yet) | 503 | `settlement_unknown`, with `Retry-After`: not settled, so a refusal; Haven's verify-then-sweep checks status before sweeping |
| A `settlement_unknown` payment whose authorization expired with no event on the chain | 402 | `settle_failed`: nothing was paid, so this is a refusal, and the buyer verifies then sweeps |

### The upstream-failure answer

```json
{
  "error": "upstream_failed_after_settlement",
  "message": "The payment settled and the upstream call failed. Retry the same request with the same payment header and a SIGN-IN-WITH-X proof signed by the payer over the challenge below; it will be served without a second charge.",
  "payment": {
    "tx_hash": "0x9f2c4b1e7a3d5c8f0e6b2a4d7c9e1f3a5b7d9c0e2f4a6b8d0c2e4f6a8b0d2c4e",
    "chain": "eip155:84532"
  },
  "reason": "upstream_timeout",
  "retry": {
    "same_payment": true,
    "after_seconds": 0,
    "forwards_left": 2,
    "proof": "SIGN-IN-WITH-X"
  },
  "sign_in_with_x": { "...": "the CAIP-122 challenge the retry signs" }
}
```

The response carries the standard `PAYMENT-RESPONSE` header with the settlement
transaction hash, so Haven can anchor the evidence. `reason` is one of
`upstream_timeout`, `upstream_unreachable`, `upstream_status`,
`upstream_auth_refused`, `response_too_large` or `buyer_disconnected`. A body
shorter than its `Content-Length`, a stream error mid-body, and an
event stream that ends without `data: [DONE]` are reported as
`upstream_unreachable`: the upstream did not deliver a complete answer. The
same payment presented again, with a `SIGN-IN-WITH-X` proof signed by the
payer over the challenge in this answer, gets the call it paid for, within the
cap, because the store recorded `failed`.

**Who can present the payment again.** Any buyer that kept its payment header
and can sign a `SIGN-IN-WITH-X` proof with the payer key can. A Haven agent cannot yet: the SDK records this 2xx as accepted and has no
retry for it, and `resumeX402Payment` (local signer path only) re-signs the
same nonce but refuses once the delegate's funds are gone, which after
settlement they are. Until a Haven-side retry path exists, a Haven buyer
whose call failed after settlement has paid for nothing, and the merchant's
log (`upstream_failed_after_settlement`) is where the merchant sees it. **This
is an open owner question** (section 13): whether the pilot accepts that loss
path, or a Haven-side retry is built first.

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
of English text, so it is not the binding limit. The 300 s delivery timeout is,
and the proxy's own 180 s upstream deadline (section 6) sits inside it: at 30
to 50 output tokens a second, an upstream call can produce about 5,400 to
9,000 tokens within 180 s. A product whose cap is above that is cut off by the
proxy's deadline, and the call counts as failed. The planned Opper demo's 1,000-token cap (#4892) is well inside both limits.

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

The smallest product price at which settlement cost is at most a stated share
of the price:

| Settlement share of the price | Smallest price | Atomic USDC |
|---|---|---|
| 10% | $0.01 | `"10000"` |
| 5% | $0.02 | `"20000"` |
| 1% | $0.10 | `"100000"` |

The planned Opper demo (#4892) prices its inference product at $0.01
(`"10000"`), so settlement is 10% of the price after the free tier and zero for the first 1,000 calls each
month. A $0.001 product would net nothing, which is why the demo does not use
one.

## 11. The receipt

The kit returns the same receipt the demo merchant returns today, built by
the shared core's `buildReceipt` (`packages/merchant-payments/src/receipt.ts`,
which the demo merchant calls from `packages/demo-merchant-mcp/src/invoice.ts`), so Haven's buyer-side
accounting reads a kit receipt with no change: its reader
(`packages/backend/src/modules/accounting/receipt-statement.ts`, documented
field by field in `docs/operations/merchant-receipt-shape.md`) is the
contract, and the shape is not changed. The code moves into the shared core
with #4890; the kit's use of it is built in #4913, in
`packages/paywall-proxy/src/receipt.ts`, which assembles the core's parameters
and defines no VAT computation, no receipt-number derivation and no declaration
verification of its own.

The proxy sends the receipt as the `x-receipt-json` response header only:
the receipt's JSON, base64-encoded so the header stays ASCII-safe, on the
response to a successful upstream call (section 6's definition of delivered).
The Haven SDK captures it and relays it to Haven next to the payment evidence;
the encoded header stays well under the 64 KiB (decoded) at which the SDK
drops it and the backend refuses it.

The demo merchant also returns the receipt as rendered text, inside its MCP
tool result. **A proxy has no carrier for that text:** the response body is
the upstream API's goods, which the proxy passes through unchanged on a 2xx
(a 3xx or 4xx it wraps in its own JSON, section 8). The JSON is the
receipt; the text is a render of it, and the renderer moves to the shared core
with #4890, so any reader that wants the text renders it from the header.

The proxy removes `x-receipt-json` and `x-receipt-url` from the upstream's
response, so an upstream cannot pass off its own receipt as the kit's. A
receipt that cannot be built never fails a settled call: the header is left
out and the failure is logged.

The keys stay the demo's Swedish bookkeeping keys (`fakturanummer`,
`saljare`, `kopare`, `rader[]`, `belopp_exkl_moms`, `moms_procent`,
`moms_belopp`, `totalt_inkl_moms`, `momsbehandling`, `valuta`, and the rest of
`InvoiceJson`). Only the values change: they come from the deployment instead
of the demo merchant's seller (its built-in demo seller, or `MERCHANT_SELLER_*`
since #4856). The receipt names no Haven address or
contact.

### Where each field comes from

| Receipt field | Source |
|---|---|
| `saljare.name`, `address`, `org_nr`, `moms_nr` | Deployment configuration: `SELLER_NAME`, `SELLER_ADDRESS`, `SELLER_ORG_NR`, `SELLER_VAT_NR`. With a VAT rule configured, name, organisation number and VAT number are required: on Base mainnet the proxy refuses to start without them; on a test network it starts with a warning and sends no receipt. Haven's accounting reads `name`, `org_nr` and `moms_nr` from this block. |
| The support line in the rendered text | Deployment configuration: `SELLER_SUPPORT_CONTACT`, the merchant's own contact, never Haven's. |
| `saljare.iban`, `bic` | Deployment configuration, optional (`SELLER_IBAN`, `SELLER_BIC`); empty when unset. |
| `saljare.crypto_address` | Deployment configuration: `PAY_TO`. |
| `betalningssatt` | Deployment configuration: the network name from `NETWORK`. |
| `momsbehandling`, `moms_procent` | Deployment configuration (`VAT_RULE`) applied to the payment's declaration (below). |
| `rader[].beskrivning` | Products file: `<name> — <description>` (the `id` when there is no name), with no billing period for a per-call product. The composed line is at most 300 characters (section 3). |
| `totalt_inkl_moms` and the line's total | Products file: `price`, which is also the settled amount. |
| `belopp_exkl_moms`, `moms_belopp`, the line's VAT figures | Computed from the price and the treatment (below). |
| `fakturanummer` (the receipt number) | The payment: `FAK-` and the settlement transaction hash modulo 10^16 as 16 digits, the demo's `receiptNumberForTransaction`. The same transaction gives the same number after a restart. |
| `ocr_nummer` | The payment: the receipt number's digits plus a Luhn check digit. |
| `fakturadatum`, `forfallodatum` | The payment: the date of `settledAt` in the consumed-payment store, and 30 days later, so a retry on a later day gives the same receipt. |
| `kopare.identifierare`, `kopare.roll` | The payment: the payer address, which for a Haven agent paying by EIP-3009 is its delegate address (`roll: agent_delegate`), as in section 5. |
| `kopare.deklaration` | The payment: present only when the request carried an `X-Tax-Declaration` that verifies against the payer, on the payment's chain, and is unexpired. Display only; a declaration that fails any check is treated as absent and never refuses the purchase. |
| `kopare.receipt_email`, `kopare.billing_address`, `kopare.shipping_address` | The paid request: present only when the merchant asked for the field in its challenge (`haven-checkout-details`, the shape [`13-checkout-details.md`](13-checkout-details.md) §2 fixes) and the request carried it in `X-Checkout-Details` (#4873). Display only; a malformed or oversized header is treated as absent and never refuses the purchase. The demo merchant is the first merchant that asks; the proxy does not ask yet, so its receipts keep their exact shape. |
| `blockkedje_referens`, `status` | The payment: the settlement transaction hash, and `Betald`. |

### The VAT rule is a deployment setting

`VAT_RULE` is set by the merchant. For the pilot it has one value:

- `SE_25_WITH_EU_REVERSE_CHARGE`: the demo merchant's rule, with its two
  treatments. Swedish VAT at 25% is taken out of the price (`SE_25`) when the
  request carries no accepted declaration or a Swedish one. An accepted
  declaration from another EU country moves the receipt to `REVERSE_CHARGE`:
  the full price is the net amount, VAT is 0% and zero, and the rendered text
  names both VAT numbers.

**A seller to whom neither treatment applies configures no rule, and the kit
then sends no receipt.** Haven's reader accepts a receipt only when it states
VAT figures (`receipt-statement.ts`), and a receipt stating a VAT of zero
would be read as a stated zero, which is a tax claim the kit has no basis to
make. With no rule there is no `x-receipt-json` header, the sale record
carries no `receipt_number` and no `vat_treatment`, and no seller details are
required. The proxy logs `receipt: off (no VAT_RULE)` at startup.

The merchant decides its own tax treatment. The kit applies the rule the
merchant configures and makes no tax decision of its own: it neither computes
a treatment the merchant did not choose nor files tax. The price never changes
with the treatment: VAT is taken out of the price, never added to it. A rule
for another jurisdiction is later work, added as a new `VAT_RULE` value.

### Amounts below the smallest unit shown

The receipt states USDC amounts to the atomic unit, six decimals with
trailing zeros trimmed (the demo's `formatUsdc`), and computes VAT in atomic
units: the net amount is the price times 100 / 125 rounded down, and the VAT
is the remainder. The lines therefore always add up to the price, and no VAT
amount is ever smaller than the smallest unit the receipt shows. A $0.01 call
under `SE_25` states `0.008` net and `0.002` VAT.

Where a reader shows fewer decimals than the receipt (a fiat amount in
cents or öre), a per-call VAT can round to zero there; Haven books its own
fiat value at settlement and does not take the merchant's. A buyer that makes
thousands of calls gets thousands of receipts, one per call. A periodic
statement that sums them is later work and is not designed here.

## 12. Running and monitoring the kit

What the merchant runs:

- the proxy process (Node 24), behind HTTPS on a public host name the
  merchant controls. A shared tunnel domain works but ranks lower in Coinbase's
  directory;
- the products file at `PRODUCTS_FILE`, and the settings: `NETWORK`, `PAY_TO`,
  `OPERATOR_NAME`, `ENDPOINT_NAME` and `ENDPOINT_DESCRIPTION` (the discovery
  document's name and description, §4), optionally `OPERATOR_CONTACT`,
  `UPSTREAM_BASE_URL` (where calls are forwarded),
  `BASE_PATH` (the path prefix the products' routes are matched under; empty by
  default), `UPSTREAM_API_KEY` (with `UPSTREAM_AUTH_HEADER` and
  `UPSTREAM_AUTH_SCHEME` when the upstream wants them), Coinbase facilitator
  credentials `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` (the pilot settles
  through Coinbase's facilitator only, because the #4890 core is Coinbase's
  client), `RPC_URL` (the chain reads that resolve a lost settle answer and a
  used authorization), `PAYMENTS_DB`, optionally `PUBLIC_BASE_URL` (the
  public origin the challenge's `resource.url` names; it must be `https` in
  production, and without it the proxy derives `http://<Host>`; Haven's
  signer answers a retry challenge only for an `https` origin), optionally
  `CLIENT_IP_HEADER` (the header a front proxy sets to the client's address,
  for the per-IP limits, section 7), `PORT` and
  `HOST`, `UPSTREAM_TIMEOUT_MS` (at most 180 s) and `RESERVATION_DEADLINE_MS`
  (at least the holder's 110 s worst case), which the proxy refuses to start
  outside those bounds, an empty `UPSTREAM_AUTH_SCHEME` sending the key bare
  (an `x-api-key` style header), optionally `VAT_RULE` with the seller settings (section 11) and `DIRECTORY_LISTING` with `ICON_URL` (section 4, off by default), and, for sales
  reporting, `HAVEN_SALES_URL` and `HAVEN_MERCHANT_KEY`;
- persistent disk for the consumed-payment store (`PAYMENTS_DB`) and the
  sales outbox (`SALES_OUTBOX`), used by exactly one proxy process at a time
  (the proxy locks `PAYMENTS_DB` at startup, section 6), so the deployment
  stops the old process before it starts the new one and never runs a second
  replica on the same store. Losing `PAYMENTS_DB` loses the one-call rule
  for payments already delivered, so it is backed up like any other
  ledger, by an in-process backup (the `backup()` function of `node:sqlite`) or a disk
  snapshot: the exclusive lock shuts every other process out of the file,
  readers included, so an external `sqlite3 .backup` cannot run while the
  proxy does. A restored backup is safe for payments delivered after it: a
  later presentation finds the settlement on the chain and, never having sent
  it, does not forward it without a proof (section 6). One `PAY_TO` per
  `PAYMENTS_DB`: two stores on one receiving address would each owe the payer
  a proof-backed call;
- a health route, `GET /healthz`, which needs no payment and reports
  readiness (the upstream key present, the store and outbox writable);
- a Haven account that receives the money, with Sales turned on (#4885) when
  the sales should appear on Haven's Sales page.

What the merchant monitors:

- **Settlement.** Verify and settle failures and facilitator timeouts; a
  burst means buyers are paying and not being served.
- **Upstream health.** The rate of `upstream_failed_after_settlement`,
  `payment_exhausted` and `payment_in_flight` answers, and any
  `upstream_auth_refused`, which means the merchant's own key is wrong. Every failed call is a payment
  the merchant owes a retry.
- **Retry proofs.** The rate of `payment_retry_needs_proof` answers. A spike
  means strangers are replaying public payment headers, or paying buyers
  cannot sign the proof and are owed a refund by hand.
- **Overage.** `overage_tokens` in the log: a product whose answers often run
  over its cap is priced too low or capped too high (section 7).
- **Sales reporting.** The outbox depth and `sales_report_refused` lines. A
  growing outbox means Haven is not receiving the sales; a refused record
  means its shape or key is wrong.
- **Cost.** Coinbase facilitator usage against the 1,000 free transactions a
  month (section 10), and the upstream provider's spend.
- **Money.** The receiving account's balance in Haven against the settled
  calls in the proxy's log.
- **Listing**, only with `DIRECTORY_LISTING=on`: a route with no settled call
  for 30 days lapses from Coinbase's directory (section 4).
- **Disk.** The size of `PAYMENTS_DB` and `SALES_OUTBOX`, and the outbox's
  10,000-record bound.

Secrets (`UPSTREAM_API_KEY`, the Coinbase credentials, `HAVEN_MERCHANT_KEY`)
are rotated by the merchant. The proxy never logs them, and a rotated Haven
merchant key takes effect on the next sales report.

## 13. What this document does not decide

- The sales ingest route's path (`POST /merchant/sales`) is settled by #4897 (section 5); the merchant key's format is #4896's.
- The licence and the distribution decision come after the pilot (owner decision on [#4884](https://github.com/d-hinders/Haven-AI/issues/4884)).
- Listing a deployment in Coinbase's directory, and any other directory, is outside the kit epic (#4884) and parked in #4887; section 4 names the fields and keeps them off by default.
- **Open question (owner):** per-IP limits cannot tell hosted Haven buyers apart, because they all reach a merchant from Haven's servers (section 7). Does the pilot accept the shared throttle, with Haven limiting failed relays per agent, or does the kit exempt or separately limit a known Haven address?
- **Open question (owner):** a Haven buyer has paid for nothing, until a Haven-side retry path exists, whenever its payment needs any forward other than the reserving request's first, because that forward needs a `SIGN-IN-WITH-X` proof the SDK does not send yet (section 6). The cases: its call fails after settlement (section 8); its settle outcome is unknown, the proxy answers 503 `settlement_unknown`, and the settle lands later; the proxy restarts mid-settle, or the holder passes `RESERVATION_DEADLINE_MS`, and the settle had landed; the proxy crashes mid-forward; and Haven's own 300 s deadline passes first when every step runs to its limit (all section 6). Does the pilot accept that, with the merchant refunding by hand from its log, or is a Haven-side retry (which would present the payment again with a `SIGN-IN-WITH-X` proof) built before the first live payment? Asked on #4884.
- A periodic statement that sums a buyer's per-call receipts is later work (section 11).
- ERC-7710 support, and advertising it when a facilitator supports it, is
  #4887's. The kit advertises EIP-3009 only.
- Opper's terms for the demo are checked in #4892 before the demo is shown
  outside Haven.
- The proxy's money-path classification is the owner's decision recorded on
  #4893: a control file until a QA scenario drives it, runtime once #4892
  deploys it with a harness address.

