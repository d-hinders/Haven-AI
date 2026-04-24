# Haven

Agent-first wallet infrastructure for the autonomous economy. Haven gives AI agents the ability to hold, send, and receive money within strict, user-defined guardrails — without requiring agents to manage private keys or understand blockchain mechanics.

## Core Concept

Agents should not be wallets. They should be **financial actors with constrained authority**. Haven separates the ability to *request* a financial action from the ability to *execute* it, with a policy engine and on-chain enforcement in between.

```
User → Safe (funds / custody)
Haven → Policy engine + orchestration
Agent → Requests payments via simple intents
Safe AllowanceModule → Enforces on-chain spending limits
```

**Non-custodial by design:** Haven never holds private keys. If Haven is fully compromised, an attacker still cannot move user funds.

## What's in the Repo

This is a TypeScript monorepo:

| Package | Description |
|---|---|
| `packages/backend` | Fastify API — auth, agents, payments, Safe integration |
| `packages/frontend` | Next.js dashboard — wallet connect, Safe deploy, agent management |
| `packages/sdk` | `@haven-fi/sdk` — TypeScript SDK for agent payment integration |

## Prerequisites

- **Node.js** v18+ — [nodejs.org](https://nodejs.org)
- **Docker Desktop** — [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
- **A browser wallet** (MetaMask, Rabby, etc.) with Gnosis Chain configured

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/d-hinders/Haven-AI.git
cd Haven-AI
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in the required values:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (default works with Docker) |
| `JWT_SECRET` | Yes | Secret for auth tokens — use a long random string in production |
| `RPC_URL` | Yes | Gnosis Chain RPC (default: `https://rpc.gnosischain.com`) |
| `RELAYER_PRIVATE_KEY` | Yes | Private key of EOA that pays gas for agent payments (see below) |
| `GNOSISSCAN_API_KEY` | No | For transaction display — get from [gnosisscan.io](https://gnosisscan.io/apis) |
| `COINGECKO_API_KEY` | No | For token prices — get from [coingecko.com](https://www.coingecko.com/en/api) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | No | WalletConnect — MetaMask works without it |
| `ANTHROPIC_API_KEY` | No | Only for Claude agent demo (`npm run agent:demo`) |

**Setting up the relayer wallet:**

The relayer is a throwaway EOA that pays gas for on-chain agent payments. It never has access to user funds — it just submits transactions. Generate one:

```bash
node -e "const{ethers}=require('ethers');const w=ethers.Wallet.createRandom();console.log('Address:',w.address);console.log('Key:',w.privateKey)"
```

Send 0.01 xDAI to the printed address (enough for thousands of transactions on Gnosis Chain), then put the private key in `RELAYER_PRIVATE_KEY`.

### 3. Start PostgreSQL

Make sure Docker Desktop is running:

```bash
npm run docker:up
```

### 4. Start the dev servers

```bash
npm run dev
```

- **Frontend** → [http://localhost:3000](http://localhost:3000)
- **Backend API** → [http://localhost:3001](http://localhost:3001)

### 5. Set up your Safe

1. Go to [http://localhost:3000](http://localhost:3000)
2. Click **Get Early Access** → create an account
3. Log in and connect your browser wallet (switch to Gnosis Chain if prompted)
4. Deploy a Safe — confirm the transaction in your wallet
5. You'll land on the dashboard with your Safe address

> **Note:** Deploying a Safe requires a small amount of xDAI for gas. You can bridge DAI from Ethereum or use the [Gnosis Chain faucet](https://gnosisfaucet.com).

### 6. Create an agent

1. Go to the **Agents** tab in the dashboard
2. Click **Create Agent**
3. Choose **Generate new** to create a delegate keypair in-browser, or **Use existing** to provide your own wallet address
4. If you generated a key: **copy and save the private key** — it's shown once and Haven never stores it
5. Add spending limits (token, amount, reset period)
6. Click **Deploy Agent** and confirm in your wallet
7. Save the **API key** and **delegate private key** from the success screen

## SDK — Agent Integration

The `@haven-fi/sdk` package wraps the 3-step payment API into a single function call. This is what developers use to give their agents payment capabilities.

### Install

```bash
npm install @haven-fi/sdk
```

### One-liner payment

```typescript
import { HavenClient } from '@haven-fi/sdk'

const haven = new HavenClient({
  apiKey: 'sk_agent_xxx',          // from Haven dashboard
  delegateKey: '0x...',             // agent's delegate private key
  baseUrl: 'http://localhost:3001',
})

const result = await haven.pay({
  token: 'EURe',
  amount: '5.00',
  to: '0xrecipient...',
})

console.log(result.txHash)      // 0x...
console.log(result.explorerUrl) // https://gnosisscan.io/tx/0x...
```

### AI agent integration

The SDK ships with pre-built tool definitions for Claude and OpenAI:

```typescript
import { HavenClient, havenTools } from '@haven-fi/sdk'
import Anthropic from '@anthropic-ai/sdk'

const haven = new HavenClient({ apiKey, delegateKey })
const anthropic = new Anthropic()

const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  tools: havenTools.claude(),  // ready-made tool schemas
  messages: [{ role: 'user', content: 'Pay 5 EURe to 0xabc for API access' }],
})

// Handle tool calls — one line per tool
for (const block of response.content) {
  if (block.type === 'tool_use') {
    const result = await haven.executeTool(block.name, block.input)
  }
}
```

See [`packages/sdk/README.md`](packages/sdk/README.md) for the full API reference (step-by-step flow, error handling, configuration options).

## Testing the Payment Flow

After creating an agent, you can test payments two ways:

### Option A: Simulation script

Tests the raw API flow — no AI involved:

```bash
# Add to .env:
# AGENT_API_KEY=sk_agent_...    (from step 7 above)
# DELEGATE_PRIVATE_KEY=0x...     (from step 7 above)
# PAYMENT_TO=0x...               (any recipient address)

cd packages/backend
npm run test:payment
```

This creates a payment intent, signs it with the delegate key, submits it, and confirms on-chain. Output includes the Gnosisscan transaction link.

### Option B: Claude AI agent

A real Claude-powered agent that reasons about a task and autonomously decides to make a payment:

```bash
# Add to .env:
# ANTHROPIC_API_KEY=sk-ant-...   (from console.anthropic.com)
# (plus the same AGENT_API_KEY, DELEGATE_PRIVATE_KEY, PAYMENT_TO as above)

cd packages/backend
npm run agent:demo
```

Or with a custom task:

```bash
npm run agent:demo -- "Pay 0.01 EURe to 0xABC... for API access"
```

Claude receives the task, decides a payment is needed, calls the `make_payment` tool, Haven validates and executes it on-chain, and Claude summarizes the result.

**What this proves:** A real AI agent autonomously moved funds from a Safe — within strict policy guardrails, without holding keys to the Safe, and without understanding blockchain mechanics.

## How It Works

### Architecture

```
┌─────────────┐     ┌───────────────────┐     ┌──────────────────┐
│   Agent      │────▶│    Haven API      │────▶│  Gnosis Chain    │
│  (any LLM)  │     │  Policy + Routing │     │                  │
│              │◀────│                   │◀────│  Safe + Module   │
└─────────────┘     └───────────────────┘     └──────────────────┘
```

1. **Agent** sends a simple payment intent: `{ token: "EURe", amount: "5.00", to: "0x..." }`
2. **Haven** validates against policies, checks on-chain allowance, generates the transfer hash
3. **Agent** signs the hash with its delegate private key (locally — Haven never sees the key)
4. **Haven** submits the signed transaction via a gas-paying relayer
5. **AllowanceModule** verifies the signature and spending limit, transfers tokens from the Safe

### Payment API (3-step flow)

| Step | Endpoint | What happens |
|---|---|---|
| 1. Create intent | `POST /payments` | Haven validates, checks policy + on-chain allowance, returns hash to sign |
| 2. Sign & submit | `POST /payments/:id/sign` | Agent signs hash, Haven verifies and executes on-chain via relayer |
| 3. Check status | `GET /payments/:id` | Poll until `confirmed` / `failed` |

All endpoints authenticate with `Authorization: Bearer sk_agent_xxx`.

### Security Model

Four independent layers — all must be compromised for funds to be at risk:

| Layer | What it does | Where it lives |
|---|---|---|
| **Safe smart account** | Multi-owner, threshold signatures, holds all funds | On-chain |
| **AllowanceModule** | Per-token, per-delegate spending limits | On-chain |
| **Haven policy engine** | Recipient allowlists, audit trail, approval thresholds | Off-chain |
| **Credential scoping** | Revocable API keys, time-limited access | Haven backend |

**Worst case:** If Haven is fully compromised, attackers get API keys but **not** delegate private keys — they cannot sign transactions. The Safe owner can revoke all delegates immediately from [Safe{Wallet}](https://app.safe.global) without needing Haven.

### Key Management

| Key | Who holds it | What it can do |
|---|---|---|
| Safe owner key | You (MetaMask) | Full Safe control — deploy, modify modules, revoke agents |
| Delegate private key | Your agent | Sign payment intents within allowance limits only |
| Agent API key | Your agent | Authenticate with Haven API — no signing ability |
| Relayer key | Haven server | Pay gas only — zero fund access |

Haven **never** holds Safe owner keys or delegate private keys.

## API Reference

### Authentication
All agent endpoints use Bearer token auth:
```
Authorization: Bearer sk_agent_xxx
```

### Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/auth/signup` | POST | None | Create user account |
| `/auth/login` | POST | None | Login, returns JWT |
| `/auth/me` | GET | JWT | Current user |
| `/agents` | GET | JWT | List agents |
| `/agents` | POST | JWT | Create agent |
| `/agents/:id` | PUT | JWT | Update agent name/description |
| `/agents/:id/revoke` | POST | JWT | Revoke agent (marks inactive) |
| `/agents/:id/allowances` | POST | JWT | Add/update token allowance |
| `/payments` | POST | API Key | Create payment intent |
| `/payments/:id/sign` | POST | API Key | Submit signature, execute on-chain |
| `/payments/:id` | GET | API Key | Get payment status |
| `/payments` | GET | API Key | List agent's payments |

### Payment intent request

```json
POST /payments
{
  "token": "EURe",
  "amount": "5.00",
  "to": "0xrecipient..."
}
```

### Payment intent response

```json
{
  "payment_id": "uuid",
  "status": "pending_signature",
  "expires_at": "2025-01-01T00:10:00Z",
  "sign_data": {
    "hash": "0x...",
    "components": {
      "safe": "0x...",
      "token": "0x...",
      "to": "0x...",
      "amount": "5000000000000000000",
      "nonce": 1
    },
    "instructions": "Sign the hash with raw ECDSA (not eth_sign)..."
  }
}
```

### Sign and execute

```json
POST /payments/:id/sign
{
  "signature": "0x...65_byte_signature"
}
```

Response on success:
```json
{
  "payment_id": "uuid",
  "status": "confirmed",
  "tx_hash": "0x..."
}
```

## Available Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start backend + frontend in dev mode |
| `npm run build` | Build both packages |
| `npm run docker:up` | Start PostgreSQL container |
| `npm run docker:down` | Stop PostgreSQL container |
| `npm run docker:logs` | Tail PostgreSQL logs |

From `packages/backend/`:

| Command | What it does |
|---|---|
| `npm run test:payment` | Run payment simulation script |
| `npm run agent:demo` | Run Claude agent payment demo |

## Project Structure

```
Haven-AI/
├── .env.example               # Environment variable template
├── docker-compose.yml         # PostgreSQL for local dev
├── packages/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── index.ts           # Fastify server + route registration
│   │   │   ├── db.ts              # PostgreSQL connection pool
│   │   │   ├── db/migrate.ts      # Auto-migration on startup
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts        # JWT auth for dashboard users
│   │   │   │   └── agentAuth.ts   # API key auth for agents
│   │   │   ├── lib/
│   │   │   │   ├── tokens.ts      # Supported tokens (xDAI, EURe, USDC.e)
│   │   │   │   └── allowance-module.ts  # On-chain AllowanceModule interaction
│   │   │   └── routes/
│   │   │       ├── auth.ts        # Signup, login
│   │   │       ├── agents.ts      # Agent CRUD + allowance management
│   │   │       ├── payments.ts    # Payment intent API (create, sign, status)
│   │   │       ├── balances.ts    # Token balance queries
│   │   │       └── ...
│   │   └── scripts/
│   │       ├── test-payment-flow.ts    # Payment simulation script
│   │       └── agent-payment-demo.ts   # Claude AI agent demo
│   ├── sdk/
│   │   ├── src/
│   │   │   ├── index.ts           # Public exports
│   │   │   ├── client.ts          # HavenClient — .pay(), .sign(), .executeTool()
│   │   │   ├── signer.ts          # Raw ECDSA signing (AllowanceModule-compatible)
│   │   │   ├── types.ts           # TypeScript types + error classes
│   │   │   └── tools.ts           # Pre-built tool defs for Claude & OpenAI
│   │   ├── package.json           # @haven-fi/sdk (publishable to npm)
│   │   └── README.md              # SDK documentation
│   └── frontend/
│       └── src/
│           ├── app/                    # Next.js pages
│           ├── components/
│           │   ├── AgentPanel.tsx       # Agent list + management
│           │   ├── CreateAgentModal.tsx # Create agent with key generation
│           │   ├── EditAgentModal.tsx   # Add/update allowances
│           │   └── ...
│           ├── hooks/
│           │   ├── useAgents.ts        # Agent API hooks
│           │   └── useOnChainAllowances.ts  # On-chain allowance sync
│           └── lib/
│               ├── allowance-module.ts # Frontend AllowanceModule integration
│               └── safe-tx.ts          # Safe transaction building + signing
```

## Supported Tokens (Gnosis Chain)

| Token | Symbol | Decimals | Address |
|---|---|---|---|
| xDAI | xDAI | 18 | Native |
| EURe | EURe | 18 | `0xcB444e90D8198415266c6a2724b7900fb12FC56E` |
| USDC.e | USDC.e | 6 | `0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0` |

## Tech Stack

- **TypeScript** throughout (backend + frontend)
- **Fastify** — backend API
- **Next.js 15** — frontend dashboard
- **PostgreSQL** — agents, policies, payment intents, audit trail
- **Safe SDK + AllowanceModule** — smart account + on-chain spending limits
- **wagmi + viem** — wallet connection + blockchain interaction
- **ethers v6** — backend blockchain operations
- **Tailwind CSS** — styling
- **Gnosis Chain** — target network (low gas, EVM-compatible)
- **Anthropic SDK** — Claude agent demo

## License

Private — not open source.
