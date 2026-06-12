# Haven

Haven is an agentic stablecoin payment wallet. Users create or link a Haven account, add funds to a Haven wallet, and give AI agents constrained spending ability through agent rules and budgets.

Haven is non-custodial smart account software. User funds stay in a user-controlled Safe, shown in product copy as a Haven wallet. Haven helps users configure agent authority, construct payment payloads, relay independently signed transactions, and understand activity. It does not hold user or agent private keys, make API credentials sufficient to spend, or make discretionary transfer decisions.

## Core Model

Agents should not be wallets. They should be payment actors with constrained authority.

```
User -> Haven wallet / Safe (funds and owner authority)
Agent -> Haven credential (identity) + delegate signing key (payment signatures)
Haven -> UI, API, pre-checks, relay, receipts, approval state
Safe AllowanceModule -> On-chain agent budget enforcement
```

API auth is identity. Signature is authority. On-chain module state is enforcement.

## What's in the Repo

This is a TypeScript monorepo:

| Package | Description |
|---|---|
| `packages/backend` | Fastify API for auth, Haven wallets, agents, approvals, payments, x402/MPP demos, receipts, and OpenAPI |
| `packages/frontend` | Next.js dashboard for Haven accounts, Haven wallets, agent rules, connect-agent handoff, approvals, and activity |
| `packages/sdk` | `@haven_ai/sdk` for direct agent integrations, tool definitions, x402/MPP quote/pay/resume helpers, and payment state handling |
| `packages/mcp` | `@haven_ai/mcp` local stdio MCP server that reads a local credential file and signs locally |
| `packages/mcp-server` | `@haven_ai/mcp-server` hosted/keyless Streamable HTTP MCP server that constructs and relays but never signs |
| `packages/signer` | `@haven_ai/signer` local edge signer used with hosted MCP; it holds the delegate key locally and exposes sign-only tools |
| `packages/demo-merchant-mcp` | Internal x402 demo merchant MCP server for Base USDC test purchases and Swedish invoice output |

## Team Docs

- [About Haven](ABOUT_HAVEN.md)
- [Documentation index](docs/README.md) — start here
- [Architecture overview](docs/architecture/00-overview.md)
- [Architecture diagrams](docs/architecture/README.md)
- [Hosted MCP connect flow](docs/architecture/06-hosted-mcp-connect-flow.md)
- [PR Workflow Checklist](docs/contributing/pr-workflow-checklist.md)
- [CASP / MiCA Risk Minimisation Guardrails](docs/regulatory/casp-risk-guardrails.md)

## Prerequisites

- **Node.js** v18+ — [nodejs.org](https://nodejs.org)
- **Docker Desktop** — [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
- **A browser wallet** (MetaMask, Rabby, etc.) with Gnosis Chain or Base configured

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
| `JWT_SECRET` | Yes | Secret for dashboard auth tokens; use a long random string in production |
| `RPC_URL` | No | Gnosis Chain RPC (default: `https://rpc.gnosischain.com`) |
| `RPC_URL_BASE` | No | Base RPC (default: `https://mainnet.base.org`) |
| `RELAYER_PRIVATE_KEY` | Yes for on-chain execution | EOA private key that pays gas for relayed Safe/module transactions; it cannot access user funds |
| `GNOSISSCAN_API_KEY` | No | Gnosis explorer API key for transaction display |
| `BASESCAN_API_KEY` | No | Base explorer API key when using an Etherscan-style Base source; Base currently defaults to Blockscout for transactions |
| `COINGECKO_API_KEY` | No | Token price lookups |
| `FRONTEND_URL` | No | Backend CORS/link base (default: `http://localhost:3000`) |
| `NEXT_PUBLIC_API_URL` | No | Frontend backend URL override (default through local rewrite: `http://localhost:3001`) |
| `NEXT_PUBLIC_HAVEN_MCP_URL` | No | Hosted MCP URL shown in connect-agent snippets |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | No | WalletConnect project id; injected wallet connectors can still work without it |
| `ANTHROPIC_API_KEY` | No | Only for the optional Claude agent demo script |

**Setting up the relayer wallet:**

The relayer is a throwaway EOA that pays gas for on-chain agent payments. It never has access to user funds — it just submits transactions. Generate one:

```bash
node -e "const{ethers}=require('ethers');const w=ethers.Wallet.createRandom();console.log('Address:',w.address);console.log('Key:',w.privateKey)"
```

Fund the relayer with the native token for each chain you plan to use:
- **Gnosis Chain:** 0.01 xDAI (enough for thousands of transactions)
- **Base:** 0.001 ETH

Put the private key in `RELAYER_PRIVATE_KEY`.

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
3. Log in and connect your browser wallet
4. Select your target network (Gnosis Chain or Base) in the deploy modal
5. Deploy a Safe — confirm the transaction in your wallet
6. You'll land on the dashboard with your Safe address

> **Note:** Deploying a Safe requires native gas tokens. For Gnosis Chain, use [gnosisfaucet.com](https://gnosisfaucet.com). For Base, bridge ETH via [bridge.base.org](https://bridge.base.org).

### 6. Create an agent

1. Go to the **Agents** tab in the dashboard
2. Click **Create Agent**
3. Pick the Haven wallet and network the agent will spend from
4. Set the agent budget: token, amount, and reset period
5. Confirm the Safe transaction in your wallet so the on-chain allowance is created
6. Save the one-time Haven credential when the Done step appears
7. Use **Connect your agent** to add Haven to Claude Code, Cursor, VS Code, Codex CLI, OpenCode, Goose, Amp, or another runtime

The credential contains an agent API key and a delegate signing key. Haven stores only the API-key hash/prefix and never stores the delegate private key. If the API key is exposed or lost, use **Payment credentials** on the agent detail page to rotate it; the new key is shown once and the old key stops working. If the delegate signing key is exposed or lost, pause or revoke the agent and create a new credential path.

## Agent Integration

Most users connect an agent through the dashboard's **Connect your agent** flow. The hosted MCP path sends only the API key to the hosted MCP endpoint; the delegate signing key stays local with the runtime or `@haven_ai/signer`.

Developers can also integrate directly with `@haven_ai/sdk`. The SDK wraps direct payments, quote-first x402/MPP flows, manual approval resume state, and ready-made tool definitions for Claude/OpenAI-style tool calling.

### Install

```bash
npm install @haven_ai/sdk
```

### Direct SDK payment

```typescript
import { HavenClient } from '@haven_ai/sdk'

const haven = new HavenClient({
  apiKey: 'sk_agent_xxx',          // from Haven dashboard
  delegateKey: '0x...',             // delegate signing key held by the agent runtime
  baseUrl: 'http://localhost:3001',
})

const result = await haven.pay({
  token: 'EURe',
  amount: '5.00',
  to: '0xrecipient...',
})

console.log(result.txHash)      // 0x...
console.log(result.explorerUrl) // https://gnosisscan.io/tx/0x... (or basescan.org for Base)
```

### Tool-calling integration

The SDK ships with pre-built tool definitions for Claude and OpenAI:

```typescript
import { HavenClient, havenTools } from '@haven_ai/sdk'

const haven = new HavenClient({ apiKey, delegateKey })

const tools = havenTools.claude() // or havenTools.openai()

// When your model returns a Haven tool call:
const toolCall = { name: 'get_allowances', input: {} }
const result = await haven.executeTool(toolCall.name, toolCall.input)

if (toolCall.name === 'get_allowances') {
  // Use this for budget, remaining amount, reset-period, or "what can I spend?" questions.
}
```

See [`packages/sdk/README.md`](packages/sdk/README.md) for the full SDK reference, payment state machine, x402/MPP helpers, and error handling.

### MCP paths

| Path | Package | Use when | Custody boundary |
|---|---|---|---|
| Hosted MCP | `@haven_ai/mcp-server` + `@haven_ai/signer` | You want one hosted URL across agent runtimes | Hosted server receives API identity only; local signer holds the delegate key |
| Local MCP | `@haven_ai/mcp` | You want a local stdio server beside the agent runtime | Local process reads the credential file and signs locally |
| Direct SDK | `@haven_ai/sdk` | You are writing custom TypeScript agent code | Your runtime holds the delegate key and calls Haven with signed payloads |

## Testing the Payment Flow

After creating an agent, you can test payments several ways:

### Option A: Hosted MCP connection

Use the dashboard's **Connect your agent** Done step. It creates runtime-specific snippets and one-click deep links where supported. The hosted snippets include the API key only; they do not include the delegate signing key. The local signer or runtime secret store handles signing.

### Option B: SDK simulation script

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

### Option C: Claude agent demo

An optional Claude-powered demo that turns a user task into a Haven tool call:

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

Claude receives the task, calls the `make_payment` tool when appropriate, Haven validates the signed request and relays it on-chain, and Claude summarizes the result.

**What this proves:** A real AI agent requested and signed a payment from a Safe within strict on-chain guardrails, without holding keys to the Safe and without understanding blockchain mechanics.

## How It Works

### Architecture

```
Agent runtime
  -> SDK / local MCP / hosted MCP
  -> Haven API (identity, policy mirror, construct, relay, status)
  -> Safe AllowanceModule (on-chain budget enforcement)
  -> Haven wallet / Safe (user funds)
```

1. **Agent** sends a simple payment intent: `{ token: "EURe", amount: "5.00", to: "0x..." }`
2. **Haven** authenticates the API key, loads the Haven wallet and agent budget, and checks the remaining on-chain allowance
3. **Haven** returns a payload hash to sign, or queues a pending approval when the request is outside the remaining budget
4. **Agent/runtime** signs locally with the delegate key; the key never goes to Haven
5. **Haven** verifies the signature and relays the transaction without changing amount, token, recipient, or authority boundary
6. **AllowanceModule** verifies the signature and budget on-chain before tokens move from the Safe

### Payment API (3-step flow)

| Step | Endpoint | What happens |
|---|---|---|
| 1. Create intent | `POST /payments` | Haven validates, checks policy + on-chain allowance, returns hash to sign |
| 2. Sign & submit | `POST /payments/:id/sign` | Agent signs hash, Haven verifies and executes on-chain via relayer |
| 3. Check status | `GET /payments/:id` | Poll until `confirmed` / `failed` |

All endpoints authenticate with `Authorization: Bearer sk_agent_xxx`. Authentication is not payment authority: executable transfers still require the agent-held delegate signature and on-chain Safe/module allowance.

For x402 and MPP, the SDK and MCP tools use quote/pay/resume flows. Standard merchant x402 has two legs: a Haven funding leg constrained by the Haven wallet budget, then an agent merchant leg using the standard `X-PAYMENT` header. Production merchant facilitation, acquiring, fiat/card rails, settlement, swaps, yield, and advice are not current Haven production surfaces.

### Security Model

Independent layers keep the API and signing boundaries separate:

| Layer | What it does | Where it lives |
|---|---|---|
| **Safe smart account** | Multi-owner, threshold signatures, holds all funds | On-chain |
| **AllowanceModule** | Per-token, per-delegate budgets and reset periods | On-chain |
| **Delegate signing key** | Signs payment payloads within the approved allowance | Agent/runtime/user environment |
| **Haven policy mirror** | Pre-checks, approval routing, audit trail, status, and copy | Haven backend |
| **Credential scoping** | API-key identity, prefix display, rotation, and revocation state | Haven backend |

If Haven is compromised, API keys alone cannot sign transactions. A Safe owner can pause or revoke an agent in Haven and can also revoke Safe permissions through Safe-compatible tooling without needing Haven.

### Key Management

| Key | Who holds it | What it can do |
|---|---|---|
| Safe owner key | User wallet/passkey/hardware environment | Full Safe control: deploy, modify permissions, revoke agents |
| Delegate private key | Your agent | Sign payment intents within allowance limits only |
| Agent API key | Your agent | Authenticate with Haven API; no signing ability |
| Hosted MCP bearer token | Agent runtime config | Same API identity role as the agent API key |
| Relayer key | Haven server | Pay gas for independently valid signed transactions; no fund access |

Haven **never** holds Safe owner keys or delegate private keys.

For architecture constraints around custody, transfer-service risk, relaying, x402/merchant demos, fiat/card rails, swaps, and investment advice, use [`docs/regulatory/casp-risk-guardrails.md`](docs/regulatory/casp-risk-guardrails.md) as the required perimeter guardrail.

## API Reference

### Authentication
Agent endpoints use Bearer token auth:
```
Authorization: Bearer sk_agent_xxx
```

Dashboard endpoints use the signed-in user's JWT. The OpenAPI contract is served at [`/openapi.json`](http://localhost:3001/openapi.json).

### Endpoints

| Surface | Auth | Examples |
|---|---|---|
| Dashboard auth | None/JWT | `/auth/signup`, `/auth/login`, `/auth/me` |
| Haven wallets | JWT | `/user/safes`, `/user/safes/deploy`, balances and account views |
| Agents | JWT | `/agents`, `/agents/:id`, `/agents/:id/pause`, `/agents/:id/resume`, `/agents/:id/revoke`, `/agents/:id/rotate-key`, `/agents/:id/allowances` |
| Agent payments | API key | `/payments`, `/payments/:id/sign`, `/payments/:id`, `/payments` |
| Agent info | API key | `/machine-payments/agent`, `/machine-payments/allowances`, `/machine-payments/receipts`, `/machine-payments/:id/status`, resume-state endpoints |
| x402 / MPP demos | API key or protocol challenge | `/x402`, `/demo/x402/*`, `/demo/mpp/*` |
| Activity | JWT | `/agent-activity/*` for payments, approvals, MCP tool calls, pending counts, and last activity |

### Payment intent request

```json
POST /payments
{
  "token": "EURe",
  "amount": "5.00",
  "to": "0xrecipient..."
}
```

When the request exceeds the remaining on-chain allowance, Haven returns `202` with `status: "pending_approval"` and `next_action: "wait_for_user_approval"` instead of a signable hash. The agent should tell the user it is waiting in Haven, then poll payment status or use the SDK/MCP resume helpers after approval.

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
  "tx_hash": "0x...",
  "chain_id": 100,
  "explorer_url": "https://gnosisscan.io/tx/0x..."
}
```

## Available Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start backend + frontend in dev mode |
| `npm run build` | Build SDK, MCP packages, signer, backend, and frontend |
| `npm run test` | Run workspace tests where configured |
| `npm run typecheck` | Run workspace type checks |
| `npm run quality` | Run typecheck, tests, and full build |
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
|-- ABOUT_HAVEN.md             # Product and architecture mental model
|-- docs/                      # architecture, product/UX, contributing, operations, regulatory docs (see docs/README.md)
|-- packages/
|   |-- backend/               # Fastify API, database migrations, Safe/module relaying, OpenAPI
|   |-- frontend/              # Next.js dashboard and connect-agent UX
|   |-- sdk/                   # @haven_ai/sdk
|   |-- mcp/                   # Local stdio MCP server; signs locally from a credential file
|   |-- mcp-server/            # Hosted/keyless Streamable HTTP MCP server
|   |-- signer/                # Local edge signer paired with hosted MCP
|   `-- demo-merchant-mcp/     # Internal x402 merchant MCP demo
|-- .env.example               # Environment variable template
`-- docker-compose.yml         # PostgreSQL for local dev
```

## Supported Networks & Tokens

**Gnosis Chain** (`chainId: 100`)

| Token | Symbol | Decimals | Address |
|---|---|---|---|
| xDAI | xDAI | 18 | Native |
| EURe | EURe | 18 | `0xcB444e90D8198415266c6a2724b7900fb12FC56E` |
| USDC.e | USDC.e | 6 | `0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0` |

**Base** (`chainId: 8453`)

| Token | Symbol | Decimals | Address |
|---|---|---|---|
| ETH | ETH | 18 | Native |
| USDC | USDC | 6 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Tech Stack

- **TypeScript** throughout (backend + frontend)
- **Fastify** — backend API
- **Next.js 15** — frontend dashboard
- **PostgreSQL** — agents, policies, payment intents, approvals, receipts, audit trail
- **Safe SDK + AllowanceModule** — smart account + on-chain spending limits
- **wagmi + viem** — wallet connection + blockchain interaction
- **ethers v6** — backend blockchain operations
- **Model Context Protocol** — local and hosted agent tool connections
- **Tailwind CSS** — styling
- **Gnosis Chain + Base** — supported EVM networks
- **Anthropic SDK** — Claude agent demo

## Contributing — Hosted Setup & Dev Workflow

Haven runs in production on **Vercel** (frontend) and **Railway** (backend + Postgres). The `main` branch auto-deploys to both.

### Repository workflow

All changes go through pull requests — no direct pushes to `main`.

1. Branch off `main` → make your changes
2. Push the branch and open a PR on GitHub
3. CI runs automatically (type-check + build for SDK, backend, frontend)
4. Vercel posts a preview URL as a comment on the PR — click to test the frontend live
5. Once CI is green, the PR author can self-merge
6. Merging to `main` triggers automatic deploys to Vercel + Railway (~2 min)

### Frontend-only changes

The Vercel preview URL points at the **production Railway backend**. You can test most frontend changes directly against the preview URL — no local setup needed beyond the PR.

### Backend changes — test locally first

Vercel previews share the prod backend, so backend changes can't be tested via the PR preview alone. Run the backend locally before opening the PR:

```bash
# 1. Start the local Postgres
npm run docker:up

# 2. In one terminal — run the backend on :3001
npm run dev -w packages/backend

# 3. In another terminal — run the frontend on :3000
#    (set NEXT_PUBLIC_API_URL=http://localhost:3001 in your .env)
npm run dev -w packages/frontend
```

Test the full flow locally, then push and open the PR. Once merged, watch the Railway deploy logs to confirm the change deployed cleanly in prod.

### Inspecting prod

Collaborators have **Viewer** access to the Railway project — you can see services, deploy logs, and runtime logs, but not change env vars. If a deploy fails or behaves unexpectedly:

- **Railway → backend service → Deployments** — build logs and runtime logs
- **Railway → Postgres → Data** — inspect tables (read-only with Viewer role)
- **Vercel previews** — every PR has a preview URL with its own build logs (linked from the PR comment)

If you need an env var changed in Railway or a secret rotated, ping the project owner.

## License

Private — not open source.
