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

## Try it live — zero setup

Haven hosts a demo endpoint you can hit immediately after creating an agent:

```typescript
import { HavenClient } from '@haven_ai/sdk'

const haven = new HavenClient({
  apiKey: process.env.HAVEN_API_KEY!,       // from Haven dashboard
  delegateKey: process.env.DELEGATE_KEY!,   // agent's delegate private key
  baseUrl: 'https://havenbackend-production-8a00.up.railway.app', // hosted Haven, or your self-hosted URL
})

// haven.fetch handles 402 → pay → retry automatically
const response = await haven.fetch(
  'https://havenbackend-production-8a00.up.railway.app/demo/x402/data',
)
const data = await response.json()

console.log(data.message)     // "You paid! Here's your demo data."
console.log(data.fact)        // a fun fact about the agent economy
console.log(data.explorerUrl) // link to the on-chain payment tx
```

Tell your agent:
> "Use Haven to fetch `https://havenbackend-production-8a00.up.railway.app/demo/x402/data` and show me what came back."

The agent will pay a tiny amount (~0.01 EURe on Gnosis Chain), receive the demo payload, and you'll see the payment in your Haven dashboard activity feed — no local server or extra config required.

## Supported Networks & Tokens

| Network | CAIP-2 | Tokens |
|---------|--------|--------|
| Gnosis Chain | `eip155:100` | EURe, USDC.e, xDAI |
| Base | `eip155:8453` | USDC, ETH |

## Step-by-Step API

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

Haven natively supports the [x402](https://x402.org) payment protocol. When an API returns HTTP 402, the SDK evaluates the challenge against the agent's approved limits, uses the configured delegate key for the required signature, and retries automatically:

```typescript
// Automatic — fetch() intercepts 402, pays, and retries.
// Use a stable idempotencyKey when one user intent may need manual approval.
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
  // Retry with { 'X-PAYMENT': receipt.paymentHeader }
  console.log(receipt.explorerUrl)
}
```

Merchant-verified x402 retries use the official EIP-3009 `exact` scheme on Base USDC (`base` / `eip155:8453`) and send the payment as `X-PAYMENT`. Haven's older tx-hash proof helper remains exported for Haven-native integrations, but `haven.fetch()` does not send `PAYMENT-SIGNATURE`.

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
| `make_payment` | Request and sign a payment from the user-controlled Safe within approved limits |
| `get_payment_status` | Check the status of a payment intent or approval request |
| `authorize_x402_payment` | Authorize a policy-limited x402 payment and return a payment header for an HTTP 402 resource |
| `resume_x402_payment` | Resume an approved x402 payment and return a merchant payment header without creating a duplicate approval |

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

## Payments above the on-chain allowance

Haven's policy lives on the Safe AllowanceModule (token, amount, reset period).
If an agent requests a payment above the remaining allowance, Haven does **not**
reject it — it returns HTTP 202 with `status: 'pending_approval'`, a
`payment_id`, `phase`, and `next_action`, then queues it for the wallet owner
to approve in the dashboard.

Surface that to the user: the payment isn't dead, it's waiting for a human to
sign off. Check `getPaymentStatus(payment_id)` or the `get_payment_status`
tool later instead of retrying in a tight loop.

For x402, approval resume is explicit. If `authorizeX402()` or `haven.fetch()`
throws `HavenPaymentStateError` with `nextAction: 'wait_for_user_approval'`,
stop and tell the user the request is waiting in Haven. Do not loop. After the
user approves, call `getPaymentStatus(payment_id)`. When Haven reports
`nextAction: 'retry_original_x402_request'`, call `resumeX402Payment()` with the
same user-intent idempotency key and the original x402 details.

```typescript
try {
  await haven.pay({ token: 'USDC', amount: '500', to: '0xabc...' })
} catch (err) {
  if (err instanceof HavenPaymentStateError && err.nextAction === 'wait_for_user_approval') {
    console.log(err.paymentId, err.phase, err.nextAction)
    console.log('Queued for owner approval — visible in the Haven dashboard.')
  }
}

const status = await haven.getPaymentStatus('approval-or-payment-id')
if (status.nextAction === 'retry_original_x402_request') {
  const response = await haven.resumeX402Payment({
    paymentId: status.paymentId,
    url: 'https://paid-api.example.com/data',
    paymentRequired,
    idempotencyKey: 'paid-api-data-2026-05-22',
  })
  const data = await response.json()
}
```

For manual HTTP stacks, use `resumeAuthorizedX402()` to get the merchant header
without retrying the request for you:

```typescript
const receipt = await haven.resumeAuthorizedX402({
  paymentId: status.paymentId,
  paymentRequired,
  idempotencyKey: 'paid-api-data-2026-05-22',
})

await fetch('https://paid-api.example.com/data', {
  headers: { 'X-PAYMENT': receipt.paymentHeader! },
})
```

For MCP/SSE x402 tools, keep the same MCP session and JSON-RPC payload where the
merchant requires it: initialize, retain `mcp-session-id`, send the original
`tools/call`, parse the 402 challenge, wait for approval if needed, then resume
with the same `payment_id` and retry the original `tools/call` with
`X-PAYMENT`. Use a stable `idempotencyKey` for the user intent so fresh merchant
quotes or sessions do not become duplicate Haven approval requests.

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

## License

MIT
