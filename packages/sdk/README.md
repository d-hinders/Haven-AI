# @haven_ai/sdk

TypeScript SDK for [Haven](https://github.com/d-hinders/Haven-AI) — agent wallet infrastructure for the autonomous economy.

Haven lets AI agents request and sign payments within strict, user-approved on-chain guardrails. This SDK makes it straightforward to integrate Haven payment requests into any agent without giving Haven custody of user or agent keys.

## Install

```bash
npm install @haven_ai/sdk
```

## Quick Start

```typescript
import { HavenClient } from '@haven_ai/sdk'

const haven = new HavenClient({
  apiKey: 'sk_agent_xxx',          // from Haven dashboard
  delegateKey: '0x...',             // agent's delegate EOA private key
  baseUrl: 'http://localhost:3001', // Haven API URL
})

// One-liner payment — handles intent, signing, submission, and confirmation
const result = await haven.pay({
  token: 'EURe',
  amount: '5.00',
  to: '0xabc...',
})

console.log(result.txHash)      // 0x...
console.log(result.explorerUrl) // https://gnosisscan.io/tx/0x... (or basescan.org for Base)
```

## Pay for an x402 resource

Point `haven.fetch` at any HTTP resource gated behind `402 Payment Required` —
the SDK detects the 402, pays through Haven, and retries automatically:

```typescript
import { HavenClient } from '@haven_ai/sdk'

const haven = new HavenClient({
  apiKey: process.env.HAVEN_API_KEY!,       // from Haven dashboard
  delegateKey: process.env.DELEGATE_KEY!,   // agent's delegate private key
  baseUrl: 'https://havenbackend-production-8a00.up.railway.app', // hosted Haven, or your self-hosted URL
})

// haven.fetch handles 402 → pay → retry automatically
const response = await haven.fetch('https://your-x402-endpoint.example/resource')
const data = await response.json()
```

The payment fits within the agent's on-chain budget — anything outside it is
declined before any money moves, never queued for you to approve later — and it
shows up in your Haven dashboard activity feed.

## Supported Networks & Tokens

| Network | CAIP-2 | Tokens |
|---------|--------|--------|
| Gnosis Chain | `eip155:100` | EURe, USDC.e, xDAI |
| Base | `eip155:8453` | USDC, ETH |

## Credential Lifecycle

- The Haven API key identifies the agent. It is not payment authority.
- The delegate key signs payment payloads locally. Haven's backend never receives it.
- The agent's on-chain budget delegation enforces the agent budget: budget, recipient and expiry are checked by audited caveat enforcers at redemption, not by an off-chain rules engine.
- `getAllowances()` / `get_allowances` is the right path for budget, remaining amount, reset period, or "what can I spend?" questions.
- If an API key is exposed or lost, rotate it from the Haven agent detail page. The new key is shown once and the old key stops working.
- If a delegate key is exposed or lost, a delegation-rail agent is **re-keyed** rather than replaced — same agent, new signing key, budget remainder carried. See [Replacing an agent's signing key](../../docs/product/agent-key-rotation.md).

## Step-by-Step API

Discovery and listing: `discoverTools({ verified?: 'any' | 'verified' | 'operator' })` returns the merged
catalog — operator-curated plus `verified_payable` directory entries (epic #1717), each with `source`,
`domainVerified` and `verifiedPayable`. `submitCatalogEntry(resourceUrl)` submits a merchant endpoint to
the Verified Payable Directory (queue-only; the seller still must prove domain ownership before listing),
and `getCatalogSubmissionStatus(id)` returns coarse status plus the ownership-proof instructions while
the submission can still prove ownership.

For agents that need control over each step (e.g., external signing):

```typescript
// Step 1: Create a payment intent
const intent = await haven.createIntent({
  token: 'USDC',
  amount: '5.00',
  to: '0xabc...',
})

// Step 2: Sign the hash (or sign externally)
const signature = haven.sign(intent.signData.hash)

// Step 3: Submit the signature
await haven.submitSignature(intent.paymentId, signature)

// Step 4: Wait for on-chain confirmation
const result = await haven.waitForConfirmation(intent.paymentId)
```

## x402 Protocol Support

Production merchant acceptance, facilitator, settlement, fiat, or acquiring functionality needs separate product and legal review under the repo's [CASP / MiCA guardrails](../../docs/regulatory/casp-risk-guardrails.md). The hosted x402 endpoint is an internal technical demo, not a merchant settlement product.

The SDK supports [x402](https://x402.org) client flows. When an API returns HTTP 402, the SDK evaluates the challenge against the agent's on-chain budget, uses the configured delegate key for the required signature, and retries automatically:

```typescript
// Automatic — fetch() intercepts 402, pays, and retries.
// Use a stable idempotencyKey so one user intent stays one Haven payment.
const response = await haven.fetch(
  'https://paid-api.example.com/data',
  undefined,
  { idempotencyKey: 'paid-api-data-2026-05-22' },
)
const data = await response.json()

// Manual — parse and authorize the 402 yourself
import { parsePaymentRequiredResponse } from '@haven_ai/sdk'

const apiResponse = await fetch('https://paid-api.example.com/data')
if (apiResponse.status === 402) {
  const paymentRequired = await parsePaymentRequiredResponse(apiResponse)
  const receipt = await haven.authorizeX402(paymentRequired, {
    idempotencyKey: 'paid-api-data-2026-05-22',
  })
  // Retry with BOTH names set to receipt.paymentHeader:
  //   { 'PAYMENT-SIGNATURE': …, 'X-PAYMENT': … }   (v2 name, v1 name)
  console.log(receipt.explorerUrl)
}
```

### Idempotency: what the key guarantees, and what it costs

**Omit `idempotencyKey` and the SDK synthesises one** from the merchant's
resource URL and description, the payee, asset, amount, network, and a
**5-minute time bucket**. Every one of those inputs except the bucket
describes *the product*, so the guarantee is:

> Repeated calls for the same product, at the same price, within the same
> 5-minute bucket are **one payment**.

That is what makes a retried HTTP request safe by default — a dropped
connection or a re-run tool call cannot pay twice.

**The cost is the flip side of the same rule.** The SDK cannot tell a retry
from a *deliberate* second purchase of the same item: both re-fetch the 402
and produce identical key material. So a genuine second purchase inside the
window collapses onto the first payment. When that happens the SDK does not
hand you a fresh authorization — the funds are already spent, and any
authorization it minted would be unfundable. It throws
`X402AlreadySettledError`, carrying the original receipt:

```typescript
import { X402AlreadySettledError } from '@haven_ai/sdk'

try {
  await haven.fetch('https://paid-api.example.com/data')
} catch (err) {
  if (err instanceof X402AlreadySettledError) {
    // The FIRST payment's receipt — real, settled funds.
    console.log(err.receipt.paymentId, err.receipt.txHash)
    // 'settled'      — the delegate was checked on-chain and cannot fund again.
    // 'unverifiable' — no chainRpcs entry for the chain, so it was not checked.
    console.log(err.basis)
  }
}
```

**To buy the same item twice, pass distinct keys** — that is the supported
way to say "this is a new purchase, not a retry":

```typescript
await haven.fetch(url, init, { idempotencyKey: `vpn-renewal:${orderId}` })
```

Configure `chainRpcs` for your chain. Without it the SDK cannot check the
delegate's balance, so an accidental key collision refuses on the weaker
`unverifiable` basis rather than risk issuing an authorization it cannot vouch
for.

**Resuming is not affected by that.** When you are following the documented
resume flow — re-calling after a funding leg confirms, or calling
`resumeAuthorizedX402({ paymentId })` — you named the payment, so an
unverifiable balance lets the resume proceed as before. Only a balance
verified *absent* refuses there. The stricter default applies solely to the
case where two purchases collided on a key you did not choose.

This applies to the **EIP-3009 funding-leg** scheme, which routes money
through the delegate EOA. **erc7710 direct settlement is unaffected**: it has
no funding leg and no delegate balance to exhaust.

For agents that need to inspect the price before paying, use the quote-first
path. `quoteX402()` probes the merchant and parses the HTTP 402 response, but it
does not create a Haven payment, signature, or on-chain transaction.

```typescript
const quote = await haven.quoteX402(
  'https://paid-api.example.com/data',
  undefined,
  { idempotencyKey: 'paid-api-data-2026-05-22' },
)

if (Number(quote.amount) > 0.05) {
  throw new Error(`Price ${quote.amount} ${quote.token} is above the user cap`)
}

const response = await haven.payX402Quote(quote)
const data = await response.json()
```

Merchant-verified x402 retries use the official EIP-3009 `exact` scheme on Base USDC (`base` / `eip155:8453`). Since #2289 `haven.fetch()` sends the payment under **both** wire names with the same value — `PAYMENT-SIGNATURE` (the x402 v2 name) and `X-PAYMENT` (v1) — so a merchant on either version reads it. Haven's older tx-hash proof helper remains exported for Haven-native integrations; it is a different payload that happens to have shared the v2 name, and it is not what `haven.fetch()` sends.

For standard x402, the `x402-wallet` identity is the agent delegate wallet, because that is the wallet that signs and settles the merchant payment. Integrations that scope access by Haven wallet/Safe address should use a Haven-native flow instead of standard merchant x402.

## AI Agent Integration

### Pre-built Tool Definitions

The SDK ships with ready-made tool schemas for Claude and OpenAI:

```typescript
import { HavenClient, havenTools } from '@haven_ai/sdk'
import Anthropic from '@anthropic-ai/sdk'

const haven = new HavenClient({ apiKey, delegateKey })
const anthropic = new Anthropic()

const response = await anthropic.messages.create({
  model: 'claude-opus-4-7',
  tools: havenTools.claude(),  // or havenTools.openai() for OpenAI
  messages: [{ role: 'user', content: 'Pay 5 EURe to 0xabc for API access' }],
})

// Handle tool calls
for (const block of response.content) {
  if (block.type === 'tool_use') {
    const result = await haven.executeTool(block.name, block.input)
    // send result back to the model
  }
}
```

### Available Tools

| Tool | Description |
|------|-------------|
| `make_payment` | Request and sign a payment from the user-controlled account within its on-chain budget |
| `get_payment_status` | Check the status of a payment intent |
| `get_allowances` | Read configured and on-chain budget state, including spent and remaining budget |
| `authorize_x402_payment` | Authorize a policy-limited x402 payment and return a payment header for an HTTP 402 resource |
| `resume_x402_payment` | Resume an authorized x402 payment and return a merchant payment header without creating a duplicate payment |

Use `get_allowances` for allowance, budget, spend-limit, remaining amount, reset-period, or "what can I spend?" questions. Payment tools still require the agent-held delegate key and the on-chain budget delegation; the Haven API key identifies the agent but does not authorize spending by itself.

## Configuration

```typescript
const haven = new HavenClient({
  apiKey: 'sk_agent_xxx',          // required — Haven agent API key
  delegateKey: '0x...',             // optional — enables .pay() and .sign()
  baseUrl: 'http://localhost:3001', // default
  x402Wallet: '0x...',              // optional fallback when no delegate key is configured
  requestTimeout: 30000,           // per-request timeout (ms)
  confirmationTimeout: 90000,      // polling timeout (ms)
  pollingInterval: 3000,           // polling interval (ms)
})
```

## OpenAPI

The backend serves an OpenAPI 3.1 contract at:

- Production: `https://havenbackend-production-8a00.up.railway.app/openapi.json`
- Local development: `http://localhost:3001/openapi.json`

The spec covers the agent-facing payment surface: agents, direct payments,
payment status, x402 authorization, resume-state rehydration, machine-payment
receipts, and transactions. `POST /machine-payments/authorize` (the legacy
internal MPP demo challenge flow) is retired — it now refuses unconditionally
with HTTP 410; use the x402 flow for agent-to-merchant payments. Its security
scheme is deliberate: the Haven API key identifies the agent, but payment
authority still requires an agent-held delegate signature and an on-chain
budget delegation.

## Agent payment state machine

Every payment state returned by Haven includes:

- `phase`: where the Haven-side payment currently is.
- `nextAction`: the stable action an agent should take next.
- `rail`: which payment rail produced the state. Categorical values (`direct`, `x402`, `mpp`) appear on resume-state discriminators; granular values (`mpp_demo`, `mpp_crypto`, `stripe_deposit`, `spt`) appear on response bodies. The `mpp` resume-state shape is a historical read only — the SDK no longer exposes a client method that acts on it (`mpp_demo` is retired, #1328).
- `message`: human-readable guidance for the same state.

The enum values and JSON Schema fragments are exported from `@haven_ai/sdk`:

```typescript
import {
  AgentPaymentNextAction,
  AgentPaymentNextActionSchema,
  AgentPaymentFailureCode,
  AgentPaymentFailureCodeSchema,
  AgentPaymentPhase,
  AgentPaymentPhaseSchema,
  AgentPaymentRail,
  AgentPaymentRailSchema,
} from '@haven_ai/sdk'
```

### Flow diagram

```text
                                ┌─────────────────────────┐
                                │ agent_signature_required│
                                └──────────┬──────────────┘
                                           │  sign_and_submit_payment
                                           ▼
                                ┌─────────────────────────┐
                                │ payment_submitted       │
                                └──────────┬──────────────┘
                                           │  check_status_later
                                           ▼
                                ┌─────────────────────────┐
                                │ payment_confirmed (✔)   │
                                └─────────────────────────┘

  (EIP-3009 bridge only. `funding_sent` is Haven's funding leg confirming —
   value left the treasury and sits on the delegate EOA. `executed` is the
   agent's own merchant retry succeeding; Haven has no phase for the merchant
   leg itself. See the `retry_original_x402_request` row below.)
                                ┌───────────────────────┐
                                │ funding_sent          │
                                └──────────┬────────────┘
                                                     │ retry_original_x402_request (x402, after the
                                                     │   merchant-report grace window — #2145)
                                                     │ none (direct / erc7710)
                                                     ▼
                                          ┌───────────────────────┐
                                          │ executed (✔)          │
                                          └───────────────────────┘

Terminal from any non-confirmed phase:
   rejected → stop_and_tell_user
   failed   → stop_and_tell_user
   expired  → request_again_if_user_still_wants_it

x402 tool-window failures:
   expired funding/quote window → PAYMENT_WINDOW_EXPIRED → re-quote with same idempotency_key
   merchant rejection after funding → MERCHANT_REJECTED_AFTER_FUNDING → haven_sweep_delegate
```

### `phase` reference

| `phase` | Meaning | Terminal? |
|---------|---------|-----------|
| `agent_signature_required` | Haven prepared a payment intent; the agent must sign and submit. | no |
| `payment_submitted` | Haven received the signed payment; the agent should poll for confirmation. | no |
| `payment_confirmed` | Direct payment is confirmed on chain. | yes |
| `user_approval_required` | **No live rail produces it.** Described the retired Safe rail's approval queue; kept in the exported enum for wire compatibility only. A payment outside the budget is now declined outright — see [Payments outside the agent's budget](#payments-outside-the-agents-budget). | n/a |
| `user_execution_required` | **No live rail produces it.** Same retirement as above. | n/a |
| `waiting_for_additional_approvals` | **No live rail produces it.** Same retirement as above. | n/a |
| `funding_sent` | Haven funding leg landed; the agent can continue the merchant/protocol leg. Only the EIP-3009 bridge has a funding leg; erc7710 direct settlement has none. | no |
| `rejected` | The payment was rejected and cannot proceed. | yes |
| `expired` | Payment expired before completion. | yes |
| `failed` | Haven could not complete the payment. | yes |

The merchant settlement leg of x402 (and the MPP retry) is the agent's own request to the merchant — it does not have a Haven `phase`. The payment is `funding_sent` until the agent retries with `X-PAYMENT` (x402) or the MPP proof header; from Haven's perspective the payment becomes `executed` only after the agent successfully resumes.

### `nextAction` reference

| `nextAction` | What the agent should do |
|--------------|--------------------------|
| `sign_and_submit_payment` | Sign with the delegate key and submit the payment to Haven. |
| `check_status_later` | Poll `getPaymentStatus(payment_id)` later. |
| `none` | Stop polling; no more action is needed for this payment id. |
| `wait_for_user_approval` | **No longer produced — nothing maps to it.** Retired with the Safe rail's approval queue; kept in the exported enum for wire compatibility. The SDK's own status mapping now answers `stop_and_tell_user` for the statuses that used to yield this. |
| `wait_for_user_to_complete_payment` | **No longer produced — nothing maps to it.** Same retirement as above. |
| `retry_original_x402_request` | Haven's funding leg confirmed but no merchant response was ever recorded — most often because the process crashed between the funding confirmation and the merchant retry (a 15-minute grace window applies before this fires; a client-reported merchant rejection instead yields `sweep_stranded_funds`). Call `resumeX402Payment()` with the preserved `resumeState`, or rehydrate it first with `getResumeState(payment_id)`. Do not start a new payment for the same purchase. |
| `stop_and_tell_user` | Stop retrying and tell the user the payment failed or was rejected. |
| `request_again_if_user_still_wants_it` | The request expired; ask again only if the user still wants the payment. |
| `payment_window_expired` | The x402 funding/quote window expired. Re-quote the same paid MCP tool call with the same `idempotency_key`, then sign the fresh `payload_hash`. |
| `sweep_stranded_funds` | A funding leg succeeded but the merchant/protocol leg did not settle. Stop retrying and use `haven_sweep_delegate` to recover stranded delegate funds. |

### Machine-readable recovery codes

Hosted MCP and signer tools also return stable `code` values on recoverable x402 failures:

| `code` | Meaning | Agent recovery |
|--------|---------|----------------|
| `PRICE_EXCEEDS_MAX` | The merchant-authoritative x402 price is above the caller's spending cap. No funding transfer was created. | Tell the user the live price exceeded the cap and retry only after they confirm a higher one. |
| `AMBIGUOUS_MAX_AMOUNT` | Both `max_amount` (atomic units) and `max_amount_human` (whole tokens) were sent for one purchase. Nothing was contacted and nothing was spent. | Re-send with exactly one — `max_amount_human` for a cap the user stated in tokens, `max_amount` for an exact atomic figure. |
| `MAX_AMOUNT_UNCONVERTIBLE` | `max_amount_human` could not be converted against this quote's asset — its decimals are unknown to Haven, or the cap has more decimal places than the asset supports. Nothing was spent. | Round the cap to the asset's decimals, or re-send it as an exact atomic `max_amount`. |
| `PAYMENT_WINDOW_EXPIRED` | The funding/quote window closed before `haven_x402_sign_header`, `haven_submit`, or `haven_complete_mcp_tool` could finish. | Re-run `haven_pay_mcp_tool` with the same `idempotency_key`, then sign and complete the fresh quote. Payloads include `retry_with_new_quote: true`. |
| `MERCHANT_REJECTED_AFTER_FUNDING` | Haven's funding leg succeeded, but the merchant rejected the paid retry. | Stop retrying the merchant and call `haven_sweep_delegate` so the user can recover stranded delegate USDC. |

## Payments outside the agent's budget

Haven's policy is the agent's on-chain budget delegation — a period budget, an
optional recipient pin, and an expiry, each enforced by an audited caveat
enforcer at redemption. There is no off-chain rules engine and **no approval
queue**: the queue-and-approve path belonged to the retired Safe rail, which now
answers HTTP 410 at every agent-payment entry point.

If an agent requests a payment outside that policy, Haven **declines it before
any money moves** — during prepare, before anything is written and before the
agent is asked to sign. `POST /payments` answers `403` when no active delegation
authorizes that token and recipient, and `502` when the on-chain caveat check
rejects the amount, recipient or expiry; the x402 authorize path answers `403
delegation_budget_exceeded`. In every case the SDK raises `HavenApiError` and no
`payment_id` exists to poll.

Surface that to the user as a decline, not a wait: **nothing will arrive later.**
The fix is for the wallet owner to grant or raise the budget in Haven, after
which the agent can request the payment again. Do not retry in a loop, and do
not poll `getPaymentStatus()` hoping for an approval.

### Resuming an x402 payment

Resume was triggered by *funding confirmation*, not by an approval, and applied
only to the EIP-3009 bridge — erc7710 direct settlement has no funding leg and
nothing to resume.

> **Resume is reachable again (#2145).** If the agent process crashes after
> Haven's funding leg confirms but before the merchant retry is recorded, a
> later `getPaymentStatus(payment_id)` reports
> `nextAction: 'retry_original_x402_request'` — Haven's funding confirmed but
> the merchant has likely not been paid. Gate on that structured field, not on
> message prose: call `resumeX402Payment()` with the preserved `resumeState`, or
> rehydrate it first via `getResumeState(payment_id)`. Any other `nextAction`
> means the payment is not ready to resume — do not call it speculatively.
>
> Meanwhile: the `payX402*` helpers perform the merchant retry themselves, so
> the ordinary in-flight path never needs resume. Only reach for
> `resumeX402Payment()` after seeing the trigger on a later status check —
> never speculatively, and never as a substitute for a fresh payment.

When the agent used `quoteX402()` / `payX402Quote()`, the thrown
`HavenPaymentStateError` includes a serializable `resumeState`. Persist it with
the MCP session details and pass it back to `resumeX402Payment()`.

If the agent process restarts and only kept the `payment_id`, call
`getResumeState(payment_id)` to rehydrate the stored x402/MPP context from
Haven, then pass that state to the matching resume helper. For POST-based
merchant or MCP calls, rebuild the live request details before retrying; Haven
stores payment context, not the agent's local request stream.

```typescript
let resumeState
try {
  await haven.payX402Quote(quote)
} catch (err) {
  if (err instanceof HavenPaymentStateError && err.resumeState) {
    resumeState = err.resumeState
    console.log(err.paymentId, err.phase, err.nextAction)
    console.log('Funding has not confirmed yet. Save resumeState and poll.')
  }
}

const status = await haven.getPaymentStatus('payment-id')
if (status.nextAction === AgentPaymentNextAction.RetryOriginalX402Request) {
  resumeState ??= await haven.getResumeState(status.paymentId)
  const response = await haven.resumeX402Payment(resumeState)
  const data = await response.json()
}
```

Think of bridged x402 as two separate legs:

- Haven funding leg: the account funds the agent delegate wallet by redeeming
  the budget delegation. Status fields such as `phase`, `nextAction`, and
  `txHash` describe this leg. It is automatic and bounded by the budget — no
  human step.
- Merchant x402 leg: after the funding leg is complete, the agent resumes the
  same payment id and retries the original merchant request with the payment
  header, under both `PAYMENT-SIGNATURE` and `X-PAYMENT`.
  Do not treat a new 402 probe or a new MCP session as a resume.

For manual HTTP stacks, use `resumeAuthorizedX402()` to get the merchant header
without retrying the request for you:

```typescript
const receipt = await haven.resumeAuthorizedX402({
  paymentId: status.paymentId,
  paymentRequired,
  idempotencyKey: 'paid-api-data-2026-05-22',
})

await fetch('https://paid-api.example.com/data', {
  headers: {
    'PAYMENT-SIGNATURE': receipt.paymentHeader!,
    'X-PAYMENT': receipt.paymentHeader!,
  },
})
```

**When YOU make the retry, report the outcome (#2292).** `haven.fetch()` and
the `payX402*` helpers call the merchant themselves and write the evidence or
reconciliation record from what they observed. `resumeAuthorizedX402()` and the
raw MCP/SSE flow below deliberately do not — you hold the header and make the
call — so Haven cannot learn what happened unless you tell it:

```typescript
const response = await fetch('https://paid-api.example.com/data', {
  headers: {
    'PAYMENT-SIGNATURE': receipt.paymentHeader!,
    'X-PAYMENT': receipt.paymentHeader!,
  },
})

await haven.reportX402MerchantOutcome({
  paymentId: status.paymentId,
  outcome: response.ok ? 'accepted' : 'rejected',
  merchantStatus: response.status,
})
```

A `rejected` report writes the same open `merchant_retry_rejected_after_payment`
reconciliation event the built-in retry writes, so the next
`getPaymentStatus()` answers `phase: funded_but_unsettled` /
`nextAction: sweep_stranded_funds` instead of reading as complete for the
fifteen-minute merchant-report grace window. An `accepted` report records the
merchant response so a delivered payment never enters that window at all.

It is evidence, not authority. The funding transaction hash and resource URL are
read from the payment's own record rather than taken from you — they are not
parameters — the call is scoped to your own agent's payments, and it changes no
amount, recipient or status. `outcome` must agree with `merchantStatus`
(`accepted` only for a 2xx), and an acceptance is terminal: a rejection reported
after a recorded merchant response is refused rather than re-flagging a
delivered payment as stranded.

For MCP/SSE x402 tools, keep the same MCP session and JSON-RPC payload where the
merchant requires it: initialize, retain `mcp-session-id`, send the original
`tools/call`, parse the 402 challenge, wait for the funding leg to confirm if
the payment is bridged, then resume with the same `payment_id` and retry the
original `tools/call` with `X-PAYMENT`. Use a stable `idempotencyKey` for the
user intent so fresh merchant quotes or sessions do not become duplicate Haven
payments.

See [`examples/mcp-x402-sse.ts`](./examples/mcp-x402-sse.ts) for a complete
MCP flow with initialize, `mcp-session-id`, JSON-RPC `tools/call`, quote
inspection, saved resume state, and final retry.

## Error Handling

```typescript
import { HavenApiError, HavenPaymentStateError, HavenSigningError, HavenTimeoutError } from '@haven_ai/sdk'

try {
  await haven.pay({ token: 'EURe', amount: '5.00', to: '0xabc...' })
} catch (err) {
  if (err instanceof HavenPaymentStateError) {
    console.log(err.paymentId, err.phase, err.nextAction)
  }
  if (err instanceof HavenApiError) {
    console.log(err.statusCode, err.message) // API returned an error
  }
  if (err instanceof HavenSigningError) {
    console.log(err.message)                 // Signing failed
  }
  if (err instanceof HavenTimeoutError) {
    console.log(err.paymentId)               // Confirmation timed out
  }
}
```

`X402AlreadySettledError` extends `HavenApiError` (status 409) and is the one
error above that is **not** a failure to pay — it reports that the payment it
describes *succeeded*, earlier. Handle it before the generic `HavenApiError`
branch, and treat `err.receipt` as proof of purchase rather than retrying. See
[Idempotency](#idempotency-what-the-key-guarantees-and-what-it-costs).

## License

MIT
