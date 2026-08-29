---
owner: "@d-hinders"
status: current
covers:
  - .nvmrc
  - .env.example
  - docker-compose.yml
  - package.json
  - packages/backend/package.json
  - packages/frontend/package.json
  - packages/sdk/package.json
  - packages/mcp/package.json
  - packages/mcp-server/package.json
  - packages/signer/package.json
  - packages/connect/package.json
  - packages/demo-merchant-mcp/package.json
  - .github/workflows/publish.yml
  - scripts/release-bump.mjs
last-verified: "2026-08-27" # #2105: the agent-payment section claimed a `202`/`pending_approval` could still be returned as "an idempotent replay of an approval row created before the Safe rail was retired". It cannot: #2055 dropped `approval_requests`, so no row is left to replay, and #2105 removed the `202` from the published contract on POST /payments entirely. The sentence told an integrator to keep a dead branch alive and is replaced with the negative statement. Caught by haven-doc-reviewer. Scope: that paragraph; the surrounding sign_data guidance was re-read and is correct (and the spec now agrees with it). Prior: #1992: the non-custody paragraph re-based from Safe to the Hybrid DeleGator + signed-delegation model, and every claim the retirement falsified corrected against source: the Core Model diagram and the "two on-chain policy rails" line, the quickstart (step 5 walked the reader into `POST /safe/deploy`, which answers 410 - it is now the passkey Hybrid flow), the How-It-Works architecture and its 6 numbered steps, the payment-API table, the security-model and key-management tables, the Tech Stack rows, and two code-fence examples: the payment-intent response still showed the LEGACY signing shape (`components.safe`, `nonce`, "raw ECDSA") where the live route returns `signature_scheme: 'eip712_userop'` + `typed_data`, and the over-budget paragraph promised a `202 pending_approval` that no code path can now create. Scope: those sections, plus two the first draft of this note failed to name (haven-doc-reviewer caught the omission): the `RELAYER_PRIVATE_KEY` row in the env-var table ("relayed Safe/module transactions" -> "relayed transactions") and the `packages/backend` / `packages/frontend` rows in the repo table. The REST of the env-var table, the SDK snippets and the token tables were not re-verified. Prior: #1988: the Approvers paragraph and its API-table row described a surface this diff deletes — Haven no longer constructs an owner-change transaction, and the routes 404. Both corrected in place rather than left as a promise; the non-custody framing is strengthened, not softened, because owner management moving entirely to the user's own key IS the non-custody claim. The Safe-inflow row now says the 410s have nothing behind them. Scope: those three places; no other README claim re-verified. Prior: #1702: the delegate-key-loss answer here was the PRE-#1694 one — "pause or revoke the agent and create a new key path". Epic #1694 made a delegation-rail agent's key REPLACEABLE (re-key: same agent, new key, budget remainder and period boundary carried), so the guidance is now split by rail rather than stated as one blanket answer. Found by the cross-epic doc sweep #1702's acceptance criteria asked for, not by the coupling gate — no `covers:` glob connects this file to `routes/agent-rekey.ts`. Scope: that one sentence in the credential paragraph; the rest of the README was not re-verified. Prior: #1328 — /demo/mpp/* retired from the endpoints table
---

# Haven

Haven is an agentic stablecoin payment wallet. Users create or link a Haven account, add funds to a Haven wallet, and give AI agents constrained spending ability through agent rules and budgets.

Haven is non-custodial smart account software. User funds stay in a **user-controlled MetaMask Hybrid DeleGator smart account**, shown in product copy as a Haven wallet. An agent's spending authority is a **delegation you sign** — a budget with audited caveat enforcers (period budget with native refill, optional recipient pin, expiry) that the DelegationManager enforces on-chain at redemption. Haven helps users configure that authority, construct payment payloads, relay independently signed transactions, and understand activity. It does not hold user or agent private keys, make API credentials sufficient to spend, or make discretionary transfer decisions — and it holds no key that can change an account's signer set or redeem a delegation you did not sign.

## Core Model

Agents should not be wallets. They should be payment actors with constrained authority.

```
User   -> Haven wallet / Hybrid DeleGator (funds and signer authority)
Agent  -> Haven credential (identity) + delegate signing key (payment signatures)
Haven  -> UI, API, pre-checks, relay, receipts, status
Signed delegation + caveat enforcers -> On-chain agent budget enforcement
```

API auth is identity. Signature is authority. On-chain delegation state is enforcement.

Haven runs **one live on-chain policy rail**: the **delegation rail** (epic #821).
Funds move account→recipient directly — no funding leg, **no approval queue**, and a
payment outside the budget, recipient pin or expiry **reverts during gas estimation**
rather than queueing for a human.

The **legacy Safe + AllowanceModule rail is RETIRED** (epic #1440), not frozen: no account
can be created or imported on it (#1984, four inflows answer HTTP 410), no account on it
can spend (#1986, HTTP 410 on every payment and x402 entry point), and its execution
machinery is deleted (#1987/#1988/#1989). Existing Safe accounts stay **fully readable** —
balances, tokens, agents and history all render. The Smart Sessions session rail is
likewise retired (#834). See
[`docs/security/delegation-rail-security-model.md`](docs/security/delegation-rail-security-model.md),
[`docs/product/account-recovery.md`](docs/product/account-recovery.md) for what a legacy
Safe owner can still do, and your non-custody [exit path](docs/exit/README.md).

## What's in the Repo

This is a TypeScript monorepo:

| Package | Description |
|---|---|
| `packages/backend` | Fastify API for auth, Haven wallets, agents, payments, x402/MPP, receipts, the Fortnox reporting feed, and OpenAPI (the legacy approval queue is gone entirely — its route was deregistered and its table dropped by #2055) |
| `packages/frontend` | Next.js dashboard for Haven accounts, Haven wallets, agent rules, connect-agent handoff, and activity |
| `packages/sdk` | `@haven_ai/sdk` for direct agent integrations, tool definitions, x402/MPP quote/pay/resume helpers, and payment state handling |
| `packages/mcp` | `@haven_ai/mcp` local stdio MCP server that reads a local credential file and signs locally |
| `packages/mcp-server` | `@haven_ai/mcp-server` hosted/keyless Streamable HTTP MCP server that constructs and relays but never signs |
| `packages/signer` | `@haven_ai/signer` local edge signer used with hosted MCP; it holds the delegate key locally and exposes sign-only tools |
| `packages/cli` | `@haven_ai/cli` terminal-native, scriptable parallel to the dashboard (login, reads, backend-only management) |
| `packages/demo-merchant-mcp` | Internal x402 demo merchant MCP server for Base USDC test purchases and Swedish invoice output |
| `packages/qa-agent` | Internal QA harness for the dev environment: deterministic money-flow scenarios and dev seeding (not published) |

## Team Docs

- [About Haven](ABOUT_HAVEN.md)
- [Documentation index](docs/README.md) — start here
- [Architecture overview](docs/architecture/00-overview.md)
- [Architecture diagrams](docs/architecture/README.md)
- [Hosted MCP connect flow](docs/architecture/06-hosted-mcp-connect-flow.md)
- [PR Workflow Checklist](docs/contributing/pr-workflow-checklist.md)
- [CASP / MiCA Risk Minimisation Guardrails](docs/regulatory/casp-risk-guardrails.md)

## Prerequisites

- **Node.js 24 (LTS)** — pinned in [`.nvmrc`](.nvmrc); CI and the
  Docker images run the same major. (The published agent-runtime packages
  declare a lower `engines` floor, `>=22` — see
  [mcp-runtime-compatibility](docs/operations/mcp-runtime-compatibility.md#where-the-node-floor-is-enforced).) With [`nvm`](https://github.com/nvm-sh/nvm)
  or [`fnm`](https://github.com/Schniz/fnm), run `nvm use` / `fnm use` in the repo
  root to match it automatically (otherwise `npm install` warns `EBADENGINE`).
- **Docker Desktop** (for local hosting) — [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
- **A browser wallet** (MetaMask, Rabby, etc.) with Gnosis Chain or Base configured — optional: signup uses a passkey, and a wallet is only needed if you want to enrol one as an account signer

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
| `RELAYER_PRIVATE_KEY` | Yes for on-chain execution | EOA private key that pays gas for relayed transactions; it cannot access user funds |
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

### 5. Create your Haven account

1. Go to [http://localhost:3000](http://localhost:3000)
2. Click **Get Early Access** → create an account
3. Pick your network, then **create the account with a passkey** — one Face ID / Touch ID prompt
4. You'll land on the dashboard with your Haven wallet address

> **One onboarding path, no transaction.** Signup provisions a counterfactual passkey-owned
> **Hybrid DeleGator** (`POST /accounts/hybrid`) — zero transactions and no gas, so no faucet
> is needed to get an address. You need native gas tokens only if you later send from the
> account yourself. Creating or importing a **Safe** is retired (#1984) and answers HTTP 410;
> there is no deploy modal.

### 6. Create an agent

1. Go to the **Agents** tab in the dashboard
2. Click **Create Agent**
3. Pick the Haven wallet and network the agent will spend from
4. Set the agent budget: token, amount, and reset period
5. Sign the budget delegation with your passkey or wallet — one signature, no transaction for you to pay for
6. Save the one-time Haven credential when the Done step appears
7. Use **Connect your agent** to add Haven to Claude Code, Cursor, VS Code, Codex CLI, OpenCode, Goose, Amp, or another runtime

The credential contains an agent API key and a delegate signing key. Haven stores only the API-key hash/prefix and never stores the delegate private key. If the API key is exposed or lost, use **Payment credentials** on the agent detail page to rotate it; the new key is shown once and the old key stops working. If the **delegate signing key** is exposed or lost, a delegation-rail agent is **re-keyed**, not replaced: the same agent gets a new signing key and a new API key, keeping its id, name, history and the remainder of its budget — see [Replacing an agent's signing key](docs/product/agent-key-rotation.md). Legacy AllowanceModule agents have no signed delegation to revoke and re-issue, so those are paused or revoked and re-onboarded.

## Agent Integration

Most users connect an agent through the dashboard's **Connect your agent** flow. The hosted MCP path sends only the API key to the hosted MCP endpoint; the delegate signing key stays local with the runtime or `@haven_ai/signer`.

Developers can also integrate directly with `@haven_ai/sdk`. The SDK wraps direct payments, quote-first x402/MPP flows, and ready-made tool definitions for Claude/OpenAI-style tool calling.

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

**What this proves:** A real AI agent requested and signed a payment from a user-controlled smart account within strict on-chain guardrails, without holding keys to the account and without understanding blockchain mechanics.

## How It Works

### Architecture

```
Agent runtime
  -> SDK / local MCP / hosted MCP
  -> Haven API (identity, policy mirror, construct, relay, status)
  -> Signed delegation + caveat enforcers (on-chain budget enforcement)
  -> Haven wallet / Hybrid DeleGator (user funds)
```

1. **Agent** sends a simple payment intent: `{ token: "EURe", amount: "5.00", to: "0x..." }`
2. **Haven** authenticates the API key, loads the Haven wallet, and selects the agent's budget delegation for that token and recipient
3. **Haven** prepares a redeeming UserOperation and returns the account's exact EIP-712 typed data to sign
4. **Agent/runtime** signs locally with the delegate key; the key never goes to Haven
5. **Haven** submits the sponsored UserOperation without changing amount, token, recipient, or authority boundary
6. **The caveat enforcers** check budget, recipient and expiry **on-chain during gas estimation** — anything outside the envelope reverts there. Funds move account→recipient directly, with no funding leg

### Payment API (3-step flow)

| Step | Endpoint | What happens |
|---|---|---|
| 1. Create intent | `POST /payments` | Haven validates, selects the budget delegation, returns typed data to sign |
| 2. Sign & submit | `POST /payments/:id/sign` | Agent signs the typed data, Haven verifies and submits the sponsored UserOperation |
| 3. Check status | `GET /payments/:id` | Poll until `confirmed` / `failed` |

All endpoints authenticate with `Authorization: Bearer sk_agent_xxx`. Authentication is not payment authority: executable transfers still require the agent-held delegate signature and the on-chain delegation it redeems against.

An account on the **retired** Safe rail (`execution_rail='allowance_module'`) gets **HTTP 410** from all of these, fail-closed with nothing written (#1986).

For x402 and MPP, the SDK and MCP tools use quote/pay/resume flows. The preferred merchant scheme is **ERC-7710 direct settlement** — one leg, account→merchant, no funding hop. Where a merchant's facilitator cannot redeem a delegation chain (still most of them today), the **EIP-3009 bridge** (#946) transiently funds the agent EOA from the budget delegation so it can sign a standard `X-PAYMENT` header; that path deliberately reintroduces a bounded funding leg, which is why the sweep and delegate-balance monitoring machinery is kept. Production merchant facilitation, acquiring, fiat/card rails, settlement, swaps, yield, and advice are not current Haven production surfaces.

### Security Model

Independent layers keep the API and signing boundaries separate:

| Layer | What it does | Where it lives |
|---|---|---|
| **Hybrid DeleGator smart account** | User-managed signer set (passkey and/or wallet), holds all funds | On-chain |
| **Signed delegation + caveat enforcers** | Per-agent period budget with native refill, optional recipient pin, expiry — checked at redemption | On-chain |
| **Delegate signing key** | Signs payment payloads within the delegated budget | Agent/runtime/user environment |
| **Haven policy mirror** | Pre-checks, audit trail, status, and copy — a mirror, never the real spend control | Haven backend |
| **Credential scoping** | API-key identity, prefix display, rotation, and revocation state | Haven backend |

If Haven is compromised, API keys alone cannot sign transactions. An account owner can pause or revoke an agent in Haven, and can revoke the underlying on-chain authority directly without needing Haven — see the [independent exit path](docs/exit/README.md).

Approver (Safe owner) management is **retired** (#1988/#1989, epic #1440). Haven never signed an owner change and no longer constructs one: the backend routes and the Settings surface are both deleted. Owners of a legacy Safe manage its owner set directly through Safe's own interfaces with their own key — which was always true, and is the reason removing Haven's builder takes nothing away that Haven was the only source of. `POST /safe/exec` stays open, so an owner-signed Safe transaction is still relayed for gas — but **#1989 also deleted the screen that composed one**, and the route is not the screen. A **wallet-owned** Safe loses nothing (sign at [app.safe.global](https://app.safe.global)); a **passkey-owned** Safe currently has **no self-serve way to move funds out**, because Haven's passkey Safe signer is a custom WebAuthn scheme Safe's own interfaces cannot drive. The epic's Base-mainnet census found no passkey-owned Safe, which is why this was accepted as a narrowing — but a census is not a proof and it does not cover non-mainnet accounts. Full user-facing wording: [`docs/product/account-recovery.md`](docs/product/account-recovery.md).

### Key Management

| Key | Who holds it | What it can do |
|---|---|---|
| Account signer (passkey / wallet) | User device or wallet/hardware environment | Full account control: add or remove signers, grant and revoke agent budgets. On a legacy Safe, the equivalent is the Safe owner key |
| Delegate private key | Your agent | Sign payment intents within the delegated budget only |
| Agent API key | Your agent | Authenticate with Haven API; no signing ability |
| Hosted MCP bearer token | Agent runtime config | Same API identity role as the agent API key |
| Relayer key | Haven server | Pay gas for independently valid signed transactions; no fund access |

Haven **never** holds account signer keys, Safe owner keys, or delegate private keys.

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
| Haven wallets | JWT | `/user/safes` (list/rename/re-default/unlink), balances and account views. Creating or importing a Safe is **retired** — `/user/safes` POST, `/user/safes/deploy`, `/safe/deploy` and `PUT /user/safe` all answer 410 (#1984), with the implementations behind them deleted (#1988); new accounts come from `/accounts/hybrid` |
| Agents | JWT | `/agents`, `/agents/:id`, `/agents/:id/pause`, `/agents/:id/resume`, `/agents/:id/revoke`, `/agents/:id/rotate-key`, `/agents/:id/allowances` |
| Agent payments | API key | `/payments`, `/payments/:id/sign`, `/payments/:id`, `/payments` |
| Agent info | API key | `/machine-payments/agent`, `/machine-payments/allowances`, `/machine-payments/receipts`, `/machine-payments/:id/status`, resume-state endpoints |
| x402 | API key or protocol challenge | `/x402` (the legacy internal `mpp_demo` flow at `/demo/mpp/*` and `POST /machine-payments/authorize` is retired — the latter now refuses with HTTP 410, #1328) |
| Activity | JWT | `/agent-activity/*` for payments, MCP tool calls, and last activity |

### Payment intent request

```json
POST /payments
{
  "token": "EURe",
  "amount": "5.00",
  "to": "0xrecipient..."
}
```

**Sign `sign_data.typed_data` verbatim, never the bare `hash`.** The account validates the typed data, not the 4337 hash; `@haven_ai/sdk` and the MCP signer do this for you.

There is **no over-budget approval queue** on the delegation rail. A request outside the budget, recipient pin or expiry **reverts during on-chain gas estimation** — it does not become a pending approval. There is **no `202` on this route**: #2055 dropped the `approval_requests` table, so no row is left to replay, and #2105 removed the response from the published contract. Do not keep a `pending_approval` branch alive.

### Payment intent response

```json
{
  "payment_id": "uuid",
  "status": "pending_signature",
  "expires_at": "2025-01-01T00:10:00Z",
  "sign_data": {
    "hash": "0x...",
    "signature_scheme": "eip712_userop",
    "typed_data": { "domain": {}, "types": {}, "primaryType": "PackedUserOperation", "message": {} },
    "components": {
      "account": "0x...",
      "token": "0x...",
      "to": "0x...",
      "amount": "5000000000000000000"
    },
    "instructions": "Sign sign_data.typed_data with your delegate key using EIP-712 (signTypedData)..."
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
| `npm run build` | Build SDK, connect, MCP packages, signer, CLI, backend, and frontend |
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
|   |-- backend/               # Fastify API, database migrations, relaying, OpenAPI
|   |-- frontend/              # Next.js dashboard and connect-agent UX
|   |-- sdk/                   # @haven_ai/sdk
|   |-- mcp/                   # Local stdio MCP server; signs locally from a credential file
|   |-- mcp-server/            # Hosted/keyless Streamable HTTP MCP server
|   |-- signer/                # Local edge signer paired with hosted MCP
|   |-- cli/                   # @haven_ai/cli terminal parallel to the dashboard
|   |-- demo-merchant-mcp/     # Internal x402 merchant MCP demo
|   `-- qa-agent/              # Internal QA harness (not published)
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
- **PostgreSQL** — agents, policies, payment intents, receipts, audit trail
- **Safe + AllowanceModule** — legacy rail, **retired** (#1440): reads and owner-signed relay only, no `@safe-global/protocol-kit`
- **MetaMask smart-accounts-kit + permissionless** — Hybrid DeleGator delegation rail
- **wagmi + viem** — wallet connection + blockchain interaction
- **ethers v6** — backend blockchain operations
- **Model Context Protocol** — local and hosted agent tool connections
- **Tailwind CSS** — styling
- **Gnosis Chain + Base** — supported EVM networks
- **Anthropic SDK** — Claude agent demo

## Contributing — Hosted Setup & Dev Workflow

Haven runs in production on **Vercel** (frontend) and **Railway** (backend + Postgres). Two long-lived branches deploy: **`dev`** auto-deploys to the shared **dev environment**, and **`main`** auto-deploys to **production**. The five published npm packages (`@haven_ai/sdk`, `signer`, `mcp`, `connect`, `cli`) are also published automatically from `main` on a version bump — see [Releasing npm packages](#releasing-npm-packages). For the dev environment's setup and env vars, see [`docs/operations/dev-environment.md`](docs/operations/dev-environment.md).

### Repository workflow

All changes go through pull requests — no direct pushes to `main` or `dev`. Feature work flows `feature/* → dev → main`; the **`dev-gate`** workflow only lets `dev` or `hotfix/*` merge into `main`.

1. Branch off `dev` → make your changes
2. Push the branch and open a PR **into `dev`** on GitHub
3. CI runs automatically (type-check + build per surface: SDK, CLI, backend, frontend, MCP, connect, signer)
4. Vercel posts a preview URL as a comment on the PR — click to test the frontend live
5. Once CI is green, the PR can merge into `dev` and auto-deploys to the dev environment
6. **Promote `dev → main`** with a separate PR (the only normal path into `main`); merging triggers automatic production deploys to Vercel + Railway (~2 min). Emergency fixes can use a `hotfix/*` branch straight into `main`.

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

### Releasing npm packages

The five npx-installed packages — `@haven_ai/sdk`, `@haven_ai/signer`, `@haven_ai/mcp`, `@haven_ai/connect`, `@haven_ai/cli` — are published to npm automatically. **You never run `npm publish` by hand.**

```bash
# 1. Bump all published packages atomically (versions, cross-package pins,
#    and source version constants) and verify the connect bundle.
npm run release:bump -- <new-version>   # e.g. 0.1.17-alpha.0

# 2. Commit on a release branch and open the PR into `dev` — NOT `main`.
#    `dev-gate` only lets `dev` or `hotfix/*` into `main`, so a release/*
#    branch aimed at `main` fails by design. Get it green, merge to `dev`.

# 3. Promote `dev → main` (a merge commit, never a squash). Publishing fires
#    on THIS step, not on the dev merge — the promotion stays a human step.
```

On the promotion to `main`, the **Publish packages** workflow (`.github/workflows/publish.yml`) rebuilds `dist` in dependency order and publishes only the packages whose `package.json` version is not yet on npm. The dist-tag is derived from the version: a prerelease like `0.1.17-alpha.0` publishes under `--tag alpha`, a stable `0.2.0` under `latest`. The connector install command the dashboard hands out is pinned to `@alpha`, so the prerelease line is what real users get.

- **Trigger model:** version bump = the gate. npm rejects republishing an existing version, so a normal (non-bump) commit is a no-op.
- **Auth:** [npm Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers) — there is **no `NPM_TOKEN` secret**. The workflow grants the job `id-token: write` and upgrades npm to ≥ 11.5.1; npm then authenticates the short-lived GitHub Actions OIDC token against a *trusted publisher* configured per package on npm (pointing at `d-hinders/Haven-AI` + workflow `publish.yml`). Nothing to leak or rotate, and it's exempt from the 2FA one-time-password prompt that blocks token-based publishes.
- **Provenance:** Trusted Publishing auto-generates a signed [sigstore provenance](https://docs.npmjs.com/generating-provenance-statements) statement. npm rejects the upload (`E422`) unless each `package.json` declares a `repository.url` (with the monorepo `directory`) matching the repo — each published package must carry this.
- **Adding a new published package?** Before its first release, (1) configure a trusted publisher for it on npm (package → Settings → Trusted Publisher → GitHub Actions: `d-hinders` / `Haven-AI` / `publish.yml`), and (2) give its `package.json` a `repository` block. Skipping either makes the first publish fail — on auth (`EOTP`/OIDC) or provenance (`E422`) respectively.
- **Failure isolation (#1159):** one package's publish failure does not abort the others — every package is attempted, the run summary reports each outcome (published / skipped / failed), and the job fails at the end naming the failures. Before this, a failure early in the list silently skipped everything after it.
- **Not published this way:** `mcp-server` (Docker → Railway), `backend`, and `frontend` (Vercel/Railway) deploy from branches directly — `main` to production and `dev` to the shared dev environment.
- Full details, the dist-wipe rationale, and a manual fallback live in [`scripts/README.md`](scripts/README.md).

## License

Private — not open source.
