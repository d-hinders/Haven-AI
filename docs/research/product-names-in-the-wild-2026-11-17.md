---
owner: "@AntonioSaaranen"
status: research
covers: []  # narrative — a dated investigation (#4878), no direct code mirror
last-verified: "2026-11-17"
---

# Product names for purchases in the wild: what a real merchant gives Haven (#4878)

**Question.** A merchant that does not send Haven's receipt shape
([`merchant-receipt-shape.md`](../operations/merchant-receipt-shape.md)) still
sells something. Can Haven put the product's name, quantity and value on the
purchase's accounting document from what the merchant itself returns?

**Case.** Bitrefill's plain-HTTP x402 API, a Bik Bok Sverige gift card, as in the
[October field test](field-test-2026-10-07-prod-x402-bitrefill.md).

**Answer.** Not on the paths Haven supports today, and not safely by reading
bodies. Of the three paid steps of a purchase, only the **status** answer names
the product, and it carries the gift card's code and PIN in the same object. The
catalogue answers (`gift-cards/search`, `products/detail`) name it too, with no
secret, but they are browsing calls with no `invoice_id`: they cannot be tied to
a purchase, and with a Bitrefill session token they are free, so not Haven
payments at all. The route for such merchants is the agent's own words,
#4877. A change *by the merchant* — the receipt header, see Q4 — would make the
product readable with no merchant-specific Haven code, once Haven's hosted
plain-HTTP path also captures that header (a gap, see Q4).

## Evidence used

All on Haven production, Base mainnet (chain 8453), agent `test`
(`1c92bc52…`). No new purchase was made for this investigation.

| When | What | Cost |
|---|---|---|
| 2026-10-08, 10-19, 10-26 | Three earlier Bik Bok purchases through `invoice/create` → `invoice/pay` → `invoice/status` (5 SEK, 1 SEK, 1 SEK). The response bodies are from the session records of those runs; the redemption code and PIN were redacted from those records before use, and are not reproduced here. | spent then: 0.503, 0.103, 0.103 USDC |
| 2026-10-26 | Haven payments for that purchase: create `69d1e317-3f6a-475e-8672-e344f87feb80`, pay `00ed8337-ab63-4e6d-b240-7e992a99a403`, status `a5fa6832-6ef1-4179-99a2-f1aa2e655407` (`haven_list_receipts`, read 2026-11-17) | — |
| 2026-11-17 | `haven_quote_x402` on `POST /x402/invoice/create` with body `{"items":[{"product_id":"bikbok-sverige-sweden","package_value":"1"}]}` — reads the 402 only, creates no payment | 0 |
| 2026-11-17 | Code paths at `origin/dev` @ `d6a89ecd7` (cited below) | — |

## Q1. What the merchant returns, and at which step

| Step | 402 challenge `resource.description` (Haven stores this) | Paid response body | Product named? |
|---|---|---|---|
| `POST /x402/invoice/create` | "Create a price-locked invoice for one or more gift cards, eSIMs, or mobile top-ups, payable in USDC or over Lightning." (same on 2026-10-26 and 2026-11-17) | `invoice_id`, `price_usdc` (`"100000"` for 1 SEK), `price_usd`, `price_satoshi`, `networks`, `expires_in_minutes`, `next_step {url, body}` | **No** |
| `POST /x402/invoice/pay` | "Pay a Bitrefill invoice in USDC via x402 to buy gift cards, eSIMs & mobile top-ups across 180+ countries." The whole 402 (resource, `accepts`, the `bazaar` and `builder-code` extensions), which Haven also persists, names no product, no SEK value and not even the invoice id (checked on the 2026-10-26 challenge) | `{"accepted": true, "message": "Payment accepted; poll invoice/status …", "next_step": {url}}` | **No** |
| `GET /x402/invoice/status` | "Check an invoice status and, with SIWX from the paying wallet or the Lightning payment preimage, retrieve redemption codes." | `invoice_id`, `status`, `delivery_status`, and `redemption_info.orders[]` with `product.{id, name, value, currency}` (e.g. `BikBok Sverige Sweden`, `5`, `SEK`) **next to** `redemption_info.orders[].redemption_info.{code, pin, other}` | **Yes — beside the code and PIN** |

- The **request** of `invoice/create` names the product: `items[].product_id`
  (a slug, `bikbok-sverige-sweden`) and `package_value` (`"1"`, with no
  currency). The challenge's own `bazaar` extension documents that input and an
  output example with no product field (read 2026-11-17).
- **VAT:** no step states any: nothing in the three answers is a VAT amount or
  a VAT treatment.
- The purchase leg (`invoice/pay`) is the one the accounting document is for,
  and it carries neither the product nor the value in SEK — only its USDC
  amount, which Haven already has from the payment itself.

## Q2. What passes through Haven, and what the agent alone sees

| Path | Request body | Response body | What Haven keeps |
|---|---|---|---|
| **Hosted plain-HTTP** (`haven_quote_x402` → `haven_pay_x402_quote` → the agent's own retry → `haven_report_x402_outcome`) — the path the field test used | Only inside the hosted MCP process, which sends the unpaid request to read the 402 (`packages/mcp-server/src/tools/plain-http-x402.ts:913`, `:1223–1224`); never sent to the backend — `POST /x402` carries the challenge's fields, not the request (`packages/sdk/src/client.ts:497–529`; `packages/backend/src/modules/x402/types.ts:29–67`) | **Only the agent sees it.** Haven never sends the paid request on this path. The agent may pass `merchant_response` (object) and, on a rejection, `merchant_body` (≤4096 characters) to `haven_report_x402_outcome` | `machine_metadata.description` = the challenge description, and `machine_metadata.payment_required` = the whole 402 challenge (`packages/backend/src/modules/x402/delegation-authorize.ts:587–594`, `payment_required` at `:592`; sent when ≤64 KB, `packages/sdk/src/client.ts:519–521`); from `merchant_response`, only Bitrefill's `invoice_id` as `purchase_group_id` (`packages/backend/src/modules/mpp/purchase-group.ts:85–101`; "never stored (only the derived id is)", `packages/backend/src/modules/mpp/evidence.ts:161–167`); from `merchant_body`, the first 1000 characters in a reconciliation event, rejected outcomes only (`packages/sdk/src/merchant-completion.ts:833–848`) |
| **SDK local** (`haven_pay_x402`, the SDK retries the merchant) | Stays on the client: the SDK sends the merchant request itself, and the backend calls carry the challenge's fields only (`packages/sdk/src/client.ts:497–529`) | The SDK reads it; on success it reports evidence and the `x-receipt-json` / `x-receipt-url` header only (`:400–412`, `:459`, `:476–494`) | Evidence fields and the merchant receipt, when the merchant sends the header |
| **Hosted MCP merchant** (`haven_pay_mcp_tool` → `haven_settle_mcp_tool`) — not how Bitrefill sells | The tool name and arguments, stored as `mcp_call_context` | Haven's hosted server makes the paid call and reads the whole result (`packages/sdk/src/client.ts:1915–1921`); a product name in `structuredContent.summary.product_name` (or `.product`) goes into the agent-facing `purchase_summary` only, not persisted (`packages/mcp-server/src/tools/support/guidance.ts:574–584`) | Evidence fields and the receipt header |

The challenge description Haven does store never reaches the accounting
document: the entry's description is built from kind, merchant, host and route
(`packages/backend/src/modules/accounting/entry.ts:406–411`,
`transaction-kind.ts:404–414`), and that is what the underlag
(`receipt-underlag.ts:218`) and the Fortnox comment
(`fortnox-connector.ts:193`) print. `delivery_reference` is stored on the
evidence row (migration 107) and only steers the transaction kind
(`entry.ts:353`, `transaction-kind.ts:341–342`); its text reaches no document.

## Q3. Can a small, bounded extract be captured where Haven sees it?

Two places could, and both are refused here:

1. **The status answer, reported by the agent as `merchant_response`.** It is
   the only answer with the product's name and value, so the extract would be
   `orders[].product.{name, value, currency}` — new Bitrefill-specific parsing,
   since the map reads only `invoice_id` today (`purchase-group.ts:85–101`).
   And the agent would have to hand Haven the whole body to get there, and
   that body holds the gift card's code and PIN. Haven would not store them —
   the map keeps only what it extracts — but they would cross Haven's API and
   its request handling, which the issue rules out ("nothing that redeems value
   is stored or logged") in spirit if not in letter, and a future change to
   logging could store them. Asking agents to strip the secrets first makes the
   safety depend on every agent doing it right.
2. **The `invoice/create` request, seen by the hosted MCP at quote time.** It
   names the slug and the face value without any secret. But it is the
   *request*, not something the merchant returned; it lives only in the hosted
   MCP process and is attached to the **fee** leg, not the purchase; reading
   `items[].product_id` and `package_value` is merchant-specific parsing beyond
   the map's current `invoice_id`; and the value has no currency in it. The
   issue requires a maintainer's agreement for such parsing, and the result
   would still be the agent's own words about what it ordered — which is what
   #4877 records, for every merchant, without parsing.

Both options need merchant-specific parsing, which the issue reserves for a
maintainer's agreement; the first also routes redemption secrets through Haven.

So outcome **(b)**: no merchant-returned product name is reachable on the
paths Haven supports without either receiving redemption secrets or new
merchant-specific parsing. The route is **#4877**: the agent's own words —
its `delivery_reference` — on the accounting document, labelled as stated by
the agent. The field-test agent already wrote
`Bitrefill invoice fbb21c0f paid (Bik Bok SE 1 SEK)` as the pay leg's
`delivery_reference` on 2026-10-26.

**Input for #4877.** As #4877 is written, the merchant's quote description
outranks the delivery reference as the product line, and the delivery
reference is the first line dropped when the Fortnox comment runs over its
budget. For Bitrefill the quote description is the generic "Pay a Bitrefill
invoice in USDC via x402 to buy gift cards, eSIMs & mobile top-ups…", the same
for every purchase, so the product line would carry no product, and
"Bik Bok SE 1 SEK" would be the first text cut. Worth deciding on #4877 whether
a description that is the same for every purchase should still outrank what
the agent stated.

## Q4. What a merchant would need to send

Any of these, in order of preference, would let Haven read the product with no
merchant-specific code:

1. **The `x-receipt-json` header on the paid `invoice/pay` response**, in the
   shape `merchant-receipt-shape.md` documents (`rader[]` with `beskrivning`,
   `antal`, amounts; `momsbehandling` when VAT applies). The SDK path and the
   hosted MCP merchant path capture it today (`packages/sdk/src/merchant-completion.ts:459`
   and `packages/sdk/src/client.ts:2063`, both into `merchant-completion.ts:476–494`), and
   #4875 reads its lines into the accounting entry. On the hosted plain-HTTP
   path the agent makes the retry, so the agent would also need to pass the
   header on — and `haven_report_x402_outcome` has no receipt field
   (`packages/mcp-server/src/tools/contracts.ts:570–600`). That is a Haven gap,
   worth its own issue once a merchant sends the header; the change would be
   general, not Bitrefill-specific.
2. **An `x-receipt-url`** pointing to the same document over https, for a
   merchant that will not put it in a header.
3. **A per-invoice `resource.description` on the `invoice/pay` 402** (for
   example "Bik Bok Sverige gift card, 1 SEK"). Haven already stores it, but it
   does not reach the accounting document today; using it would be a small,
   general Haven change, and the text would be merchant prose, not structured
   lines.

None of these needs Haven to know Bitrefill. The first is the one that gives
quantity, value and VAT as data.

Bitrefill's own account MCP (field test path C) also returns the product, but
to the agent, outside Haven; Haven only pays the invoice it names.

## What was not done

- No new purchase: the three earlier purchases and a free quote answered the
  questions. A paid `invoice/status` read would only have repeated the October
  body.
- No code: outcome (b). Nothing in this record stores or reproduces a
  redemption code, a PIN or a whole merchant body.
