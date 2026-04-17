# @haven-fi/sdk

TypeScript SDK for [Haven](https://github.com/d-hinders/Haven) — agent wallet infrastructure for the autonomous economy.

Haven gives AI agents the ability to hold, send, and receive money within strict, user-defined guardrails. This SDK makes it trivial to integrate Haven payments into any agent.

## Install

```bash
npm install @haven-fi/sdk
```

## Quick Start

```typescript
import { HavenClient } from '@haven-fi/sdk'

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
import { parsePaymentRequired } from '@haven-fi/sdk'

const apiResponse = await fetch('https://paid-api.example.com/data')
if (apiResponse.status === 402) {
  const paymentRequired = parsePaymentRequired(apiResponse)
  const receipt = await haven.authorizeX402(paymentRequired)
  console.log(receipt.explorerUrl)
}
```

Supported x402 networks: `eip155:100` (Gnosis Chain) and `eip155:8453` (Base).

## AI Agent Integration

### Pre-built Tool Definitions

The SDK ships with ready-made tool schemas for Claude and OpenAI:

```typescript
import { HavenClient, havenTools } from '@haven-fi/sdk'
import Anthropic from '@anthropic-ai/sdk'

const haven = new HavenClient({ apiKey, delegateKey })
const anthropic = new Anthropic()

const response = await anthropic.messages.create({
  model: 'claude-opus-4-6',
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
  requestTimeout: 30000,           // per-request timeout (ms)
  confirmationTimeout: 90000,      // polling timeout (ms)
  pollingInterval: 3000,           // polling interval (ms)
})
```

## Error Handling

```typescript
import { HavenApiError, HavenSigningError, HavenTimeoutError } from '@haven-fi/sdk'

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
