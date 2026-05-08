# @haven_ai/sdk

TypeScript SDK for [Haven](https://github.com/d-hinders/Haven-AI) — agent wallet infrastructure for the autonomous economy.

Haven gives AI agents the ability to hold, send, and receive money within strict, user-defined guardrails. This SDK makes it trivial to integrate Haven payments into any agent.

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

Haven natively supports the [x402](https://x402.org) payment protocol. When an API returns HTTP 402, Haven evaluates the payment against policy, executes from the Safe, and retries automatically:

```typescript
// Automatic — fetch() intercepts 402, pays, and retries
const response = await haven.fetch('https://paid-api.example.com/data')
const data = await response.json()

// Manual — parse and authorize the 402 yourself
import { parsePaymentRequiredResponse } from '@haven_ai/sdk'

const apiResponse = await fetch('https://paid-api.example.com/data')
if (apiResponse.status === 402) {
  const paymentRequired = await parsePaymentRequiredResponse(apiResponse)
  const receipt = await haven.authorizeX402(paymentRequired)
  console.log(receipt.explorerUrl)
}
```

Supported x402 networks: `eip155:100` (Gnosis Chain) and `eip155:8453` (Base).

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
| `make_payment` | Send a payment from the Haven-managed Safe wallet |
| `get_payment_status` | Check the status of a previously initiated payment |
| `authorize_x402_payment` | Pay for an HTTP 402 resource via the x402 protocol |

## Configuration

```typescript
const haven = new HavenClient({
  apiKey: 'sk_agent_xxx',          // required — Haven agent API key
  delegateKey: '0x...',             // optional — enables .pay() and .sign()
  baseUrl: 'http://localhost:3001', // default
  x402Wallet: '0x...',              // optional — sent as x402-wallet for wallet-scoped resources
  requestTimeout: 30000,           // per-request timeout (ms)
  confirmationTimeout: 90000,      // polling timeout (ms)
  pollingInterval: 3000,           // polling interval (ms)
})
```

## Payments above the on-chain allowance

Haven's policy lives entirely on the Safe AllowanceModule (token, amount,
reset period). If an agent requests a payment above the remaining allowance,
Haven does **not** reject it — it returns HTTP 202 with `status: 'pending_approval'`
and queues it for the wallet owner to approve in the dashboard.

Surface that to the user: the payment isn't dead, it's waiting for a human to
sign off. Don't retry — the same request would just queue another approval.

```typescript
try {
  await haven.pay({ token: 'USDC', amount: '500', to: '0xabc...' })
} catch (err) {
  if (err instanceof HavenApiError && err.statusCode === 202) {
    // err.body.payment_id, err.body.remaining, err.body.requested
    console.log('Queued for owner approval — visible in the Haven dashboard.')
  }
}
```

## Error Handling

```typescript
import { HavenApiError, HavenSigningError, HavenTimeoutError } from '@haven_ai/sdk'

try {
  await haven.pay({ token: 'EURe', amount: '5.00', to: '0xabc...' })
} catch (err) {
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
