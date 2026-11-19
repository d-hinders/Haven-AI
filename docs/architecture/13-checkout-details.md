---
owner: "@d-hinders"
status: current
covers:
  - packages/sdk/src/client.ts
  - packages/sdk/src/checkout-details.ts
  - packages/sdk/src/client-checkout-details.ts
  - packages/sdk/src/merchant-completion.ts
  - packages/sdk/src/x402.ts
  - packages/sdk/src/x402-erc7710-header-size.test.ts
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/sdk/src/tool-adapter.ts
  - packages/sdk/src/tax-declaration.ts
  - packages/sdk/src/client-tax-declaration.ts
  - packages/sdk/src/types.ts
  - packages/mcp/src/tools.ts
  - packages/mcp-server/src/tools/paid-mcp-completion.ts
  - packages/mcp-server/src/tools/state-direct-recovery.ts
  - packages/mcp-server/src/tools/catalog-purchase.ts
  - packages/mcp-server/src/tools/plain-http-x402.ts
  - packages/backend/src/modules/x402/stored-challenge.ts
  - packages/mcp-server/src/tools/support/errors.ts
  - packages/mcp-server/src/tools/support/guidance.ts
  - packages/mcp-server/src/tools/support/checkout-details.ts
  - packages/backend/src/routes/owner-company-details.ts
  - packages/backend/src/infra/repositories/machine-payments.ts
  - packages/backend/src/modules/accounting/receipt-underlag.ts
  - packages/backend/src/modules/accounting/fortnox-connector.ts
  - packages/backend/src/modules/accounting/accounted-connector.ts
  - packages/backend/src/modules/accounting/igdrasil-connector.ts
last-verified: "2026-11-17"
---

# Checkout details: how a merchant asks and how Haven answers

This is the design the four build slices of epic
[#4868](https://github.com/d-hinders/Haven-AI/issues/4868) are built from, so
they build the same thing. It decides the wire shape: the extension a merchant
adds to its payment challenge, the header Haven answers with, the address
shape #4870 stores and #4871 returns, the payment paths that carry the answer,
where a purchase stops before paying, and what the privacy record says.

The outcome is a document and no code. #4870, #4872 and #4873 are not claimed
until this document is merged to `dev`.

The epic's *How it works* section already states the shape at the level of
intent: the merchant asks in its challenge, Haven answers on the paid request,
a merchant that does not ask receives today's request, and a required field
that cannot be shared stops the purchase before money moves. This document
confirms that section and fills in every decision it left to the builder. It
does not change it (section 8).

## 1. Standards check

Read on 2026-11-17. The question is whether the x402 foundation, or its tax
working group, has a proposal for contact, billing or shipping details, and
whether the x402 specification tells clients to ignore extensions they do not
know.

| Source | What was read |
|---|---|
| [x402 specification v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) (`specs/x402-specification-v2.md`, main) | The `Extensions` object (§5.1.1), the `PaymentPayload` echo (§5.2.1), the facilitator's extension sidechannel (§7.2.1), and the discovery API (§8). |
| [x402 extension specs](https://github.com/x402-foundation/x402/tree/main/specs/extensions) (main) | The directory listing: `bazaar`, `builder_code`, `eip2612_gas_sponsoring`, `erc20_gas_sponsoring`, `extension-auth-hints`, `extension-offer-and-receipt`, `http-message-signatures`, `payment_identifier`, `sign-in-with-x`. |
| [Extensions overview](https://docs.x402.org/extensions/overview) | The extension list, the server-side registration rule, and the client echo-validation note. |
| [x402-foundation/wg-tax](https://github.com/x402-foundation/wg-tax) | Open issues #3 and #6; open pull requests #1, #2, #4, #5, #7 and #8. |
| [wg-tax PR #5, buyer-side tax declaration](https://github.com/x402-foundation/wg-tax/pull/5) | The declaration's fields and its §6.6.5 note on the erc7710 payer question. |
| [x402 PR #2853, compliance-fields](https://github.com/x402-foundation/x402/pull/2853) (open, unmerged) | The `buyer.name`, `buyer.address` and `buyer.taxId` members and the postal-address shape. |
| [x402 issue #2943, x402 Direct](https://github.com/x402-foundation/x402/issues/2943) (open) | The proposed checkout session and its "fulfillment destination". |
| [x402 issue #999, e-commerce extensions](https://github.com/x402-foundation/x402/issues/999) (open) | The proposed dynamic-pricing, settlement-timing and checkout-component extensions. |

What those sources say:

- **No proposal for contact, billing or shipping details exists.** The
  specification's extension directory has no such extension. The tax working
  group's open work is about tax status, jurisdiction and audit records: PR #5
  is a buyer-side tax declaration, and PR #4 is a jurisdiction and audit-receipt
  strawman. Neither asks a buyer for an email or an address.
- **The nearest proposal is a receipt record, not a request.** PR #2853
  (`compliance-fields`, open since 2026-07-14 and unmerged) adds `buyer.name`,
  `buyer.address` and `buyer.taxId` to a signed tax/audit record that composes
  with `offer-receipt`. It is what a merchant writes on a receipt, not what a
  merchant asks for before payment. Its `buyer.address` shape is the only
  x402-adjacent address shape, and section 2 maps to it.
- **The nearest request is a checkout session, not the challenge.** Issue #2943
  proposes a stateful `POST /checkout-sessions` that prices line items and a
  "fulfillment destination" before the 402 fires. It is a feature request, not
  a specification proposal, and it puts the details outside the payment
  challenge. Issue #999 proposes e-commerce extensions (dynamic pricing,
  settlement timing, a React checkout component) and no contact, billing or
  shipping field.
- **The specification does not tell clients to ignore extensions they do not
  know.** §5.1.1 says: "Servers advertise supported extensions in
  `PaymentRequired`, and clients echo them in `PaymentPayload`. The client must
  include at least the info received; it may append additional info but cannot
  delete or overwrite existing info." An unknown extension is therefore echoed,
  not ignored. The forward-compatibility guidance is in the offer-and-receipt
  extension spec: "Implementers SHOULD design with forward compatibility in
  mind and SHOULD treat unknown extension-specific fields as unsupported rather
  than attempting best-effort interpretation." The extensions overview's
  "silently ignored" sentence is about a server-side extension declared on a
  route but not registered on the server, not about a client.

Two consequences decide the rest of this document:

1. **A merchant that adds this entry is safe for every client.** A client that
   echoes verbatim (Haven's SDK does, #2361) sends the entry back and answers
   nothing; a client that does not know the entry echoes it and answers
   nothing. That is the epic's "no request, nothing sent" invariant, and it
   holds without any client change.
2. **The answer must not go into the echoed entry.** The echo is a
   specification MUST and the payment payload's `extensions` reaches the
   facilitator at verify and settle. The merchant's request may be echoed; the
   owner's email and address may not.

The owner decision of 2026-11-16 stands: Haven supports this now, the extension
is versioned and marked provisional, and a proposal from the foundation is
followed when it lands. If PR #2853 or a successor lands, the mapping is the
address shape in section 2 and the field names in section 2; the request side
has no proposal to map to.

## 2. The merchant's request

The merchant adds one entry under the challenge's `extensions`, keyed
`haven-checkout-details`. The key follows `haven-passport`, the extension Haven
already reads. The entry follows the specification's extension structure, an
object with `info` and `schema`:

```json
"extensions": {
  "haven-checkout-details": {
    "info": {
      "version": 1,
      "fields": {
        "receipt_email": { "required": true },
        "billing_address": { "required": false },
        "shipping_address": { "required": false }
      }
    },
    "schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": ["version", "fields"],
      "properties": {
        "version": { "const": 1 },
        "fields": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "receipt_email": { "type": "object", "required": ["required"], "properties": { "required": { "type": "boolean" } } },
            "billing_address": { "type": "object", "required": ["required"], "properties": { "required": { "type": "boolean" } } },
            "shipping_address": { "type": "object", "required": ["required"], "properties": { "required": { "type": "boolean" } } }
          }
        }
      }
    }
  }
}
```

| Member | Required | Meaning |
|---|---|---|
| `info.version` | Yes | `1` is the only version. A version other than `1` makes the request unreadable (below). |
| `info.fields` | Yes | An object whose keys are the field names the merchant wants. A field not listed is not requested. |
| `info.fields.<name>.required` | Yes | `true` means the merchant will not serve the purchase without the field; `false` means it wants the field if Haven can share it. |
| `schema` | No | A JSON Schema for `info`, for a generic client. Haven reads `info` and ignores `schema`; a missing `schema` does not make the request unreadable. |

The three field names are `receipt_email`, `billing_address` and
`shipping_address`. They are the names #4870 stores and #4871 returns; no slice
renames them.

### Reading the request

The merchant's request is untrusted input. Haven reads it as follows:

- An unknown field name under `fields` is ignored, never guessed at.
- A field listed with `required: false` is optional; a field listed with
  `required: true` is required.
- A malformed entry is treated as **no request**: the value is not an object,
  `info` is missing or not an object, `version` is not `1`, `fields` is not an
  object, a field's value is not an object, or `required` is not a boolean.
  Haven sends nothing and logs the shape failure. It does not refuse the
  purchase, because an unreadable request does not say a field is required, and
  the epic's invariant is that a merchant that does not make a readable request
  receives exactly today's request.
- A version other than `1` is unreadable rather than read as version 1. The
  version exists so a future shape is not misread: reading a v2 entry as v1
  could turn an optional field into a required one, or the other way round.
  This is the sale record's rule (Haven refuses a record whose version it does
  not know), applied to the request.

### The address shape

This document owns the address shape. #4870 stores it and #4871 returns it
under these names.

```json
{
  "line1": "Sveavagen 1",
  "line2": "4 tr",
  "city": "Stockholm",
  "postCode": "111 57",
  "subdivision": "SE-AB",
  "country": "SE"
}
```

| Member | Required | Max length | Meaning |
|---|---|---|---|
| `line1` | Yes | 70 | Street address, first line. |
| `line2` | No | 70 | Second line. |
| `line3` | No | 70 | Third line. |
| `city` | Yes | 50 | City or locality. |
| `postCode` | No | 16 | Postal code, as the owner writes it. |
| `subdivision` | No | 6 | ISO 3166-2 subdivision code, for example `SE-AB`. |
| `country` | Yes | 2 | ISO 3166-1 alpha-2, uppercase. |

An absent optional member is omitted from the JSON, never sent as `null` or as
an empty string. The lengths are Haven's own bounds: they fit every address an
owner can type and they bound the answer (section 3). They are not a validation
of the address, and Haven does not check that the address exists.

The shape is the `buyer.address` shape of the unmerged compliance-fields
extension (PR #2853): `line1`, `line2`, `line3`, `city`, `postCode`,
`subdivision`, `country`, with `country` as ISO 3166-1 alpha-2. That extension
aligns the shape with EN 16931 BG-8, the European e-invoicing buyer address. A
merchant that later adopts compliance-fields reads the same names from Haven's
answer, and a merchant that already writes that shape on its receipt reads the
same names in the request. `receipt_email` has no counterpart there; it is
Haven's own field.

### The receipt email

`receipt_email` is one address, at most 254 characters (RFC 5321 §4.5.3.1.3's
forward-path limit, less the angle brackets), with no display name and no CR or
LF. It is shared only when the owner saved one. The sign-up email is never
sent: the form suggests it as a prefill only while the owner has no company
details saved at all, and nothing reaches a merchant until the owner has saved
a receipt email (owner decision 2026-11-17). Once a row exists, a row with no
receipt email shows the field empty — a cleared email and one never set are
both `NULL`, so a per-field prefill would store the sign-up email again on the
owner's next save (owner decision 2026-11-18, #4946). Haven never falls back
to the sign-up email.

## 3. Haven's answer

### Header and encoding

The answer is one request header on the paid request:

```
X-Checkout-Details: <base64url of the UTF-8 JSON, no padding>
```

The encoding is the tax declaration's: base64url of the JSON, no padding
(`encodeTaxDeclarationHeader` in `packages/sdk/src/tax-declaration.ts`). The
values are UTF-8 (an address can carry non-ASCII), a header value must be
ASCII, and base64url is header-safe. The header name is `X-Checkout-Details`.

The JSON is:

```json
{
  "version": 1,
  "receipt_email": "philip@example.se",
  "billing_address": { "line1": "Sveavagen 1", "city": "Stockholm", "postCode": "111 57", "country": "SE" }
}
```

Only the fields the merchant asked for are present. A field the merchant did
not ask for is never included, even when the owner stored it. `version` is `1`,
so the merchant can tell which shape it received.

### Unsigned, and why

The answer is **unsigned**. Three reasons:

1. **The hosted route cannot sign.** The hosted route is in scope (owner
   decision 2026-11-17), and Haven's hosted MCP server does not hold the
   agent's delegate key. It relays a signed payment header the edge signer
   produced and cannot mint or reuse signing authority (the custody note on
   `completeX402MerchantCall` in `packages/sdk/src/client.ts`). A signed answer
   would need a new signing surface and a round trip to the signer on every
   hosted purchase.
2. **The tax declaration is signed for a different reason.** It is an
   attestation the merchant relies on for its tax treatment, and the merchant
   can verify it against the payer. Checkout details are not an attestation:
   they are data the owner stored and consented to share. A signature would
   prove only that the agent sent them, which the payment header already binds
   to the payment. No signature Haven could produce would let the merchant
   verify the owner's consent.
3. **The answer is not authority.** It moves no money and changes no payment
   term. The epic's trust model already treats the merchant's request as
   untrusted input and the answer as data.

### Never merged into the echoed entry

The answer is never merged into the challenge's `extensions` entry. The
`haven-passport` extension does merge its answer there
(`withHavenPassportExtension` in `packages/sdk/src/x402.ts`, line 474), and
this epic does not follow that precedent. The reason is the echo: the
specification makes the client echo the merchant's `extensions` in the payment
payload, and the payment payload reaches the facilitator at verify and settle.
The passport fields are a public attestation reference, safe to send to a
facilitator. A receipt email and a home address are not. The answer therefore
rides a separate header, which only the merchant receives.

### The byte budget

**The answer's budget is 1,536 bytes**, measured as the encoded header value
(the base64url string), excluding the header name and separator.

The largest answer the shape allows is **1,426 bytes encoded** (1,069 bytes of
JSON):

| Part | Bytes |
|---|---|
| Envelope (`{"version":1,...}` and the three keys) | 71 |
| `receipt_email` at 254 characters | 254 |
| Two addresses at their maximum lengths (372 bytes of JSON each) | 744 |
| **JSON total** | **1,069** |
| **base64url total** (`ceil(1,069 × 4 / 3)`) | **1,426** |

The budget is that plus 110 bytes of slack, for a future optional field or a
longer header name. No address the shape allows reaches it.

### The paid request's headers stay under 16 KB

The ceiling is 16,384 bytes, Node's default `maxHeaderSize`, the 16 KB the
transport names at `packages/sdk/src/mcp-merchant-transport.ts` line 779. The
headers that matter are `PAYMENT-SIGNATURE`, which echoes the merchant's whole
`extensions` including this request entry, plus this answer.

Measured on 2026-11-17 with the SDK's own `x402V2PaymentEnvelope` and
`encodeBase64Json`, with the largest answer (1,426 bytes) and the request entry
(680 bytes of JSON) echoed:

| Case | `PAYMENT-SIGNATURE` line | Answer line | Other headers | Block | Headroom |
|---|---|---|---|---|---|
| EIP-3009, request echo | 2,129 | 1,448 | 227 | 3,804 | 12,580 |
| EIP-3009, request and bazaar echo | 3,281 | 1,448 | 227 | 4,956 | 11,428 |
| erc7710 (the repository's own fixture), request echo | 6,321 | 1,448 | 227 | 7,996 | 8,388 |

Each line is the header name, a colon and a space, the value, and CRLF. The
`PAYMENT-SIGNATURE` values are 2,108, 3,260 and 6,300 bytes; the answer value
is 1,426 bytes. The other headers are `content-type`, `accept`, `user-agent`,
`mcp-session-id` and `x402-wallet`. The erc7710 fixture is the repository's own
conservative lower bound (`packages/sdk/src/x402-erc7710-header-size.test.ts`);
a real delegation chain is larger, and the 8,388 bytes of headroom is what
absorbs it.

The two encodings are different and are named separately. `encodeBase64Json`
is standard base64 **with** padding, and it produces the `PAYMENT-SIGNATURE`
value. The answer header is base64url **without** padding, the tax
declaration's encoding (`encodeTaxDeclarationHeader` in
`packages/sdk/src/tax-declaration.ts`), and it produces the answer value.

The inputs, so the numbers can be reproduced:

- `resource`:
  `{"url":"https://merchant.test/v3/compat/chat/completions","description":"One chat completion on openai/gpt-6-sol, up to 1,000 output tokens.","mimeType":"application/json"}`.
- `accepted`:
  `{"scheme":"exact","network":"eip155:8453","amount":"10000","payTo":"0x1212121212121212121212121212121212121212","maxTimeoutSeconds":300,"asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","extra":{"name":"USD Coin","version":"2"}}`.
- `payload`:
  `{"signature":S,"authorization":{"from":"0x1212121212121212121212121212121212121212","to":"0x1212121212121212121212121212121212121212","value":"10000","validAfter":"0","validBefore":"1794950000","nonce":N}}`,
  where `S` is `0x` followed by `ab` repeated 65 times and `N` is `0x`
  followed by `cd` repeated 32 times.
- `extensions`: `{"haven-checkout-details": <the section 2 entry>}`. The bazaar
  row adds
  `"bazaar":{"info":{"input":{"model":"openai/gpt-6-sol","messages":[{"role":"user","content":X}]},"output":{"example":{"id":"chatcmpl-1","choices":[{"message":{"content":Y}}]}}},"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}}`,
  where `X` is `"x"` repeated 200 times and `Y` is `"y"` repeated 400 times.
- The erc7710 row is the repository's fixture object (`erc7710Header()` in
  `packages/sdk/src/x402-erc7710-header-size.test.ts`) with the same
  `extensions` added. It is built directly rather than through
  `x402V2PaymentEnvelope`, because the fixture carries `scheme` and `network`
  at the top level.
- The other headers are `content-type: application/json`,
  `accept: application/json, text/event-stream`,
  `user-agent: haven-sdk/0.0.0 (node 24)`, `mcp-session-id: "a" repeated 36
  times` and `x402-wallet: 0x1212121212121212121212121212121212121212`; with
  their CRLFs they are 227 bytes.

The payment header would have to exceed **14,709 bytes** before the largest
answer pushed the block over the ceiling. The 431 that #4754 fixed was a
4,969-byte EIP-3009 header sent under both names after funding; a v2 payload
now goes out under `PAYMENT-SIGNATURE` alone, so that doubling is gone.

### The size check

The answer's encoded size is checked against the budget before `authorizeX402`.
The SDK also checks the whole block before `authorizeX402`: the challenge's
`extensions` echo, `resource` and `accepted` are known, and the only unknown
part of the payment header is the signature, whose length is fixed for the
scheme (65 bytes for EIP-3009; the erc7710 payload is built from the delegation
the SDK holds). So the block's size is known before the payment is authorised.

- A field that would take the answer over budget is not sent. A required field
  that does not fit is a refusal before payment (section 5); an optional field
  that does not fit is omitted, and the rest of the answer is sent.
- A block that would exceed 16,384 bytes is not sent. A required field is a
  refusal before payment; with no required field the answer is dropped and the
  purchase proceeds.
- The paid request re-checks the actual block as a safety net and never sends
  one that would answer 431.

## 4. Which payment paths carry it

> **Implementation status (#4872).** The SDK paths (`fetch`, `payX402Quote`,
> `resumeX402Payment`) and the local MCP tools that reach them (`haven_pay_x402`,
> `haven_pay_x402_quote`, `haven_resume_x402_payment`, `haven_pay_mcp_tool`)
> carry the answer and refuse before payment, in
> `packages/sdk/src/checkout-details.ts` and `client-checkout-details.ts`. The
> SDK paths pay the EIP-3009 option, so on them the answer rides EIP-3009 only;
> the pre-authorise block estimate counts the caller's own request headers.
> The hosted MCP-merchant completion is supported too
> (`packages/mcp-server/src/tools/support/checkout-details.ts`):
> `haven_pay_mcp_tool` and `haven_prepare_catalog_purchase` refuse before any
> intent, sized for the option actually paid (erc7710 or EIP-3009); the settle
> and complete legs read the merchant's request back from the challenge stored
> at authorize (`GET /x402/:id/merchant-call-context` serves it as
> `checkout_details_request`), read the agent's details again, and send the
> answer on the paid request. At settle the block is measured on the actual
> payment header. Settle decides BEFORE anything is spent: on EIP-3009 before
> the funding relay (the agent's header is in hand), on erc7710 availability
> before the settlement child is submitted and the block right after it; the
> complete leg, already funded, decides after the funding wait. An explicitly
> threaded context (the flow the pay tools describe) still reads the stored
> request; only the merchant URL the payment was quoted for receives the
> details, and a different one refuses a required field
> (`merchant_mismatch`). A required request in a challenge too large to store
> (over 64 KB) is refused at pay time. The answer rides only the paid
> `tools/call` (`completeX402MerchantCall`'s `paidRequestHeaders`), never the
> MCP handshake. The hosted plain-HTTP path is supported too (#4872 part 2b):
> `haven_pay_x402_quote` refuses before any intent, sized for the option paid,
> in both its payment_required and request modes. On that path the agent sends
> the paid request itself, so `haven_submit` reads the merchant's request back
> from the challenge stored at authorize (`GET /x402/:id/payment-required`),
> reads the agent's details, and decides before it spends: on EIP-3009 before
> the funding relay, with the block ESTIMATED from the stored challenge (the
> agent's payment header never reaches this tool); on erc7710 availability
> before the settlement child is submitted and the real block right after it.
> The answer comes back in the result for the agent's own retry: in
> `retry_headers` on erc7710, in `additional_retry_headers` on EIP-3009. It is
> returned only when the payment did not come from the MCP-tool flow, where
> `haven_complete_mcp_tool` sends it itself. When the stored challenge cannot
> be read, the submit proceeds as today and sends no answer (§5, "A path that
> is not supported"); the pay tool has already refused any required field the
> agent could not share. On EIP-3009 the answer comes back only once the relay
> has confirmed: a relay that is still `submitted` returns none.

The census below covers every path the issue names, plus the local MCP tools
that reach the same SDK seam. "Supported in this epic" means the path answers
the request and refuses before payment when a required field cannot be shared.

| Path | Decision | Where the answer is attached |
|---|---|---|
| SDK `fetch` (`packages/sdk/src/client.ts`, line 1764) | **Supported in this epic.** | `merchantCompletion.retryRequest`, the one seam `fetch`, `payX402Quote` and `resumeX402Payment` all reach. |
| SDK `payX402Quote` (`packages/sdk/src/client.ts`, line 1479) | **Supported in this epic.** | The same seam. |
| SDK `resumeX402Payment` (`packages/sdk/src/client.ts`, line 1638) | **Supported in this epic**, with the funded-payment rule in section 5. | The same seam, after the resume re-signs the payment header. |
| Local MCP tools (`packages/mcp/src/tools.ts`, lines 879, 1043 and 1057) | **Supported in this epic.** | They call `haven.fetch` and `haven.payX402Quote`, so they reach the same seam. |
| Hosted MCP-merchant completion (`packages/mcp-server/src/tools/paid-mcp-completion.ts`, lines 760 to 762, into `completeX402MerchantCall` at `packages/sdk/src/client.ts` line 1825) | **Supported in this epic.** | Haven's server sends the paid request itself and adds the header to the request it sends. |
| Hosted plain-HTTP pay tool (`packages/mcp-server/src/tools/plain-http-x402.ts`, the `haven_pay_x402_quote` tool) | **Supported in this epic.** | None here: it refuses before any intent. The answer is attached by the state-direct `haven_submit` below. |
| Hosted state-direct path (`packages/mcp-server/src/tools/state-direct-recovery.ts`, the `haven_submit` tool) | **Supported in this epic**, on both schemes. | Haven's server adds the header to the `retry_headers` it returns on erc7710, and returns it as `additional_retry_headers` on EIP-3009 (the signer builds that scheme's `retry_headers`); the agent sends the paid request itself. |
| Hosted `haven_resume_x402_payment` | **Not supported, because** it resumes from the same resume state as the local `payment_id` resume, which carries no merchant `extensions`. Its description says a resume sends no answer. | None. The funded payment is delivered as today. |
| A resume by `payment_id` alone (the local `haven_resume_x402_payment { payment_id }`, which reads `GET /payments/:id/resume_state`) | **Not supported, because** the stored resume state rebuilds `paymentRequired` without the merchant's `extensions`, so there is no request to answer or refuse. A resume from a preserved `resume_state` that carries the challenge is supported. | None. The funded payment is delivered as today. |
| SDK tool adapter `authorize_x402_payment` (`packages/sdk/src/client.ts`, line 2286) and `resume_x402_payment` (line 2309) | **Not supported, because** they rebuild the challenge from tool arguments with `toolX402PaymentRequired`, which carries no `extensions` (`packages/sdk/src/tool-adapter.ts` has no `extensions` at all), so they can neither answer nor refuse. | None. The purchase is paid as today. |
| An integrator calling `POST /x402/authorize` directly | **Not supported, because** the request carries the payment requirements the integrator supplies, not the merchant's challenge, so Haven never sees the merchant's request. | None. The purchase is paid as today. |
| An installed client older than #4872 | **Not supported, because** it does not know the extension: it echoes the entry and sends no answer. | None. The purchase is paid as today. |

### ERC-7710

**ERC-7710 payments carry the answer.** The answer is unsigned and
scheme-independent, and the measured erc7710 block (a 6,321-byte
`PAYMENT-SIGNATURE` line, the 1,448-byte answer line and 227 bytes of other
headers, 7,996 in all) leaves 8,388 bytes of headroom. On erc7710 the paid
request is sent by the agent (the state-direct path) or by Haven's server (the
hosted completion), and both carry the header.

The tax header is EIP-3009-only for two reasons that do not apply here: it is
signed by the delegate key, and the erc7710 payer question is open (wg-tax PR 5
§6.6.5). Checkout details are unsigned and do not depend on who the payer is,
so the scheme does not gate them.

### Today's tax header, for contrast

The tax header is attached only where the local SDK holds the agent's key and
the payment is EIP-3009 (`packages/sdk/src/merchant-completion.ts`, lines 281
to 299). The checkout-details attach site is the same seam, with a different
condition: the challenge asked for a field and the answer is available. The
hosted paths attach it in the server, not in the SDK.

## 5. Refusal

The rule is the epic's: a required field that cannot be shared stops the
purchase before the payment is authorised (`authorizeX402`), not at the paid
request, which is sent after funding.

| Path | Where the check runs | What happens |
|---|---|---|
| SDK `fetch` and `payX402Quote` | Before `authorizeX402` (lines 1764 and 1479). | A required field that cannot be shared throws `CheckoutDetailsUnavailableError`. No payment is created and no funds move. |
| SDK `resumeX402Payment` | Before the paid request, after the payment is already funded (line 1638). | The resume reports the refusal and does not send the paid request. The payment stays funded but undelivered. |
| Hosted MCP-merchant completion | In `haven_pay_mcp_tool` and `haven_prepare_catalog_purchase` (`packages/mcp-server/src/tools/catalog-purchase.ts`), after the quote, cap and scheme and before `prepareX402Erc7710` or `createX402Intent`; again in `haven_settle_mcp_tool` before the funding relay (EIP-3009, with the real header block) or before the settlement child is submitted (erc7710, availability; the block right after submit); in `haven_complete_mcp_tool` after the funding wait. | Before the intent and before the relay or submit: nothing is created or spent. After an erc7710 submit: the settlement is never sent, so nothing is redeemed (`unsent`, start a new purchase). On complete: funded but not delivered (`funded`, complete again once fixed, or verify then sweep). |
| Hosted state-direct (plain HTTP) | In `haven_pay_x402_quote`, after the cap and scheme and before `prepareX402Erc7710` or `createX402Intent`; again in `haven_submit` before the funding relay (EIP-3009, availability and the estimated block) or before the settlement child is submitted (erc7710, availability; the real block right after the submit). | Before the intent and before the relay or submit: nothing is created or spent (`before_payment`, which on `haven_submit` stands only while the intent is still `pending_signature`, as on settle). After an erc7710 submit: no `payment_header` is returned, so nothing can be redeemed (`unsent`). An EIP-3009 `haven_submit` of the decomposed MCP-tool flow refuses before the relay too, where it used to be decided only after funding by `haven_complete_mcp_tool`. |

### The machine-readable reason

The code is `CHECKOUT_DETAILS_UNAVAILABLE`, a new `AgentPaymentFailureCode`
value in `packages/sdk/src/types.ts` (#4872 adds it). The refusal carries:

| Field | Meaning |
|---|---|
| `missing_fields` | The field names that could not be shared, in the order the merchant listed them. |
| `reason` | `not_shared` (the owner has not turned sharing on for this agent), `feature_disabled` (the deployment has checkout details off), `not_stored` (the owner has not saved the field), `over_budget` (the answer or the block would exceed its limit), `unreadable` (Haven's read of the details failed), or `backend_unsupported` (a backend without the agent read, a 404). The last three were added by #4872, as the issue requires the read failure and the older backend to be told apart from "sharing off". |
| `next_action` | `stop_and_tell_user`. The owner must turn sharing on or save the field; the agent cannot. |

The message names the field and the owner setting, and says no payment was
created.

The SDK throws `CheckoutDetailsUnavailableError`, a `HavenApiError` subclass
with status 409, `failureCause: { kind: 'deterministic' }` and
`readonly checkoutDetailsErrorCode = 'checkout_details_unavailable'`, carrying
the fields above on its body, plus `stage` (`before_payment`, `funded`,
`unsent` or `state_unknown`, #4872). The hosted tools throw the same SDK error, and the hosted
`normalizeError` (`packages/mcp-server/src/tools/support/errors.ts`) answers it
with the same code and fields, a `phase` per stage and a
`refusalNextStep({ nextAction: StopAndTellUser })` whose omitted reason is the
stage's: only `before_payment` says to call again. On the hosted settle leg
and the plain-HTTP `haven_submit` a `before_payment` refusal stands only while
the intent is still `pending_signature`; a repeated settle or submit of a
payment that already moved gets the submit's or relay's own answer instead
(the settled replay on erc7710), and its message there is "Nothing was funded,
submitted or sent for this payment", since the intent exists. When the
payment's state cannot be read, the refusal still stands (nothing is spent),
with a fourth stage, `state_unknown` (hosted `phase: unknown`): it says an
earlier settle or submit may already have funded or settled the payment, and
to check `haven_get_payment_status` before a new purchase.

Status 409 because the request conflicts with the owner's current sharing
state, and repeating it unchanged gets the same answer. It is not a
payment-required challenge (402) and not a malformed request (400).

### A resumed payment, which is already funded

The resume **reports the refusal and does not send the paid request**. The
payment is funded; sending the paid request without a required field would buy
goods the merchant cannot deliver as asked, and the agent would have no signal.
Reporting it lets the owner turn sharing on and the agent resume the same
payment again: the authorization is unused, so a second resume re-signs the
same nonce and sends the paid request. If the owner will not share, the agent's
recourse is the shipped verify-then-sweep rule (#4062): check
`haven_get_payment_status` first, then `haven_sweep_delegate`. The payment
stays in the existing funded-but-undelivered state (#2145).

### A path that is not supported

The purchase is paid as today, and the merchant receives a paid request without
the field. **The merchant serves it.** A missing field never turns a settled
purchase into an error: the merchant must not refuse the call or answer
non-2xx, because Haven reads a non-2xx answer after funding as
`MERCHANT_REJECTED_AFTER_FUNDING`, and the buyer's recourse is verify-then-sweep.
The demo merchant (#4873) serves the product and prints the fields it received,
and its receipt states the field as absent when it is absent.

## 6. Privacy

### What is stored

- The receipt email, billing address and shipping address are stored in the
  owner's business details (#4870), per user (`owner_company_details.user_id`),
  not per account. Billing and shipping address are optional (owner decision
  2026-11-16).
- The per-agent sharing switch (#4871) is stored per agent. It is off by
  default, and only the owner can turn it on; an agent cannot switch it on for
  itself.
- The answer is not stored. It is built from the stored details at the paid
  request and discarded.
- The merchant's receipt, when it prints the details, is stored in
  `merchant_receipts` (see the receipt flow below).

### Who receives it

- **The merchant only.** Never the facilitator, never the payment payload. The
  answer is a separate header, and the echoed `extensions` entry carries only
  the merchant's request, not the answer.
- **On the hosted route, Haven's hosted MCP server sees the values.** It builds
  the answer for `retry_headers` or sends the paid request itself. Owner
  decision 2026-11-17: this is accepted, and the server neither stores nor logs
  them.
- **The agent itself can read the values** once sharing is on (#4871). "Seller
  only" describes what Haven sends, not a limit on the agent.

Per supported path, whether the values pass through a Haven server:

| Path | Through a Haven server? |
|---|---|
| SDK `fetch`, `payX402Quote`, `resumeX402Payment` | No. The SDK builds the answer locally from the backend read and sends it to the merchant. |
| Local MCP tools | No. They reach the same SDK seam. |
| Hosted MCP-merchant completion | Yes. Haven's server builds the answer and sends the paid request. It neither stores nor logs the values. |
| Hosted state-direct | Yes. Haven's server builds the answer into `retry_headers` (erc7710) or `additional_retry_headers` (EIP-3009) and returns it in the `haven_submit` result, and nowhere else in it; the agent sends it. It neither stores nor logs the values. |

### What is logged

Field names, the answer's byte size, the outcome (`sent`,
`dropped_over_budget`, `refused_missing_required`) and the merchant's host.
**Values are never logged**: no email, no address line, no postal code. The
hosted server's request log records the header name and its size, not its
value. The tax declaration's existing log line records the tax id for its audit
trail; the checkout-details path has no equivalent, because the values are
personal data and the audit trail does not need them.

### How the owner removes it

- `DELETE /user/company-details` (`packages/backend/src/routes/owner-company-details.ts`,
  line 170) removes the stored details. It is deliberately not gated by the
  feature flag: erasure is the owner's, always.
- The per-agent sharing switch is turned off in the agent's settings (#4871).
  Turning it off stops future answers.
- Deleting the stored details does not reach copies already made: a merchant's
  own records, and the receipts Haven stored.

### The receipt flow

A merchant that prints the details on its receipt returns them to Haven. The
SDK reports the merchant's receipt after the paid request
(`reportMerchantReceipt` in `packages/sdk/src/merchant-completion.ts`, lines
470 to 499), and the hosted MCP-merchant completion does the same
(`packages/sdk/src/client.ts`, line 2063).

Haven stores it in `merchant_receipts` (`INSERT_MERCHANT_RECEIPT_SQL` in
`packages/backend/src/infra/repositories/machine-payments.ts`, line 1189; first
write wins, and a stored receipt is immutable). It is attached as a PDF in
every accounting connection the owner has: Fortnox, Accounted and Igdrasil
(`merchantReceiptDocument` in `packages/backend/src/modules/accounting/fortnox-connector.ts`,
`accounted-connector.ts` and `igdrasil-connector.ts`). The PDF renders the
inline JSON with non-ASCII characters folded to `?` (`merchantReceiptPdf` in
`packages/backend/src/modules/accounting/receipt-underlag.ts`, line 452).

Owner decision 2026-11-17: this is accepted. A receipt may show the details in
full, and it is the owner's own bookkeeping record.

`DELETE /user/company-details` removes the stored details, not past receipts.
The retention basis for those receipts is the owner's bookkeeping obligation:
Swedish bookkeeping law (bokföringslagen 1999:1078, 7 kap. 2 §) requires
accounting information to be preserved until the end of the seventh year after
the calendar year in which the fiscal year ended. Under the GDPR, the right to
erasure (Article 17) does not apply where processing is necessary for
compliance with a legal obligation (Article 17(3)(b)). Haven keeps the receipt
because the owner's accounting connection needs it; the owner can delete the
stored details, and the past receipts stay for that period.

### The receipt email, again

The receipt email is shared only when the owner saved one. The sign-up email is
never sent (owner decision 2026-11-17). The form suggests the sign-up email as
a prefill only when the owner has no company details saved (#4946); nothing
reaches a merchant until the owner has saved a receipt email.

### Personal data

An email or an address can be personal data, and a sole trader's business
address can be a home address. The stored details are the owner's own data,
entered by the owner, shared only with the merchant the owner's agent is paying,
and only when the owner turned sharing on for that agent.

## 7. What this document does not decide

- The storage schema and the routes for the details are #4870's.
- The per-agent switch's route and the agent's read of the values are #4871's.
- The implementation of the attach site, the refusal and the size check is
  #4872's.
- The demo merchant's product and receipt are #4873's.
- Whether the x402 foundation adopts a proposal. If one lands, Haven maps to
  it; the address shape in section 2 is already the compliance-fields shape.
- Address validation and email verification are out of scope in the epic.
- Haven sending receipt emails itself is out of scope in the epic.
- Changing when the buyer tax declaration is sent is out of scope in the epic.

## 8. What this document changes in the epic

Nothing in the epic's *How it works* section. The six points confirm it: the
merchant asks in its challenge, Haven answers on the paid request, a merchant
that does not ask receives today's request, a required field that cannot be
shared stops the purchase before money moves, and a merchant serves a paid
request that lacks a field. The epic body is not edited.

The document adds the decisions the epic left to the builder: the extension key
and version, the field names and the address shape, the header name and
encoding, the unsigned answer, the 1,536-byte budget, the per-path census, the
refusal code and the resume rule, and the privacy record.
