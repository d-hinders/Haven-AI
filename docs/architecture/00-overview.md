# Haven — Architecture Overview

> Overview only — see the linked docs for detail. Keep this file short.

Haven is the policy layer between AI agents and money: agents request
payments through high-level tools, Haven enforces the user's on-chain budget,
and a Safe smart account executes. One line holds the whole security model:
**API auth = identity, signature = authority, on-chain AllowanceModule state =
enforcement.**

## Components

| Package | One-liner |
|---|---|
| `@haven/backend` | Fastify API: auth, Haven wallets/Safes, agents, allowances, approvals, payments, x402/MPP, receipts, [OpenAPI](05-agent-api-openapi.md). |
| `@haven/frontend` | Next.js dashboard: onboarding, wallets, agent rules, approvals, activity. |
| `@haven_ai/sdk` | TypeScript SDK; the single core for construction, signing, and payment state. Everything else is a thin shell over it. |
| `@haven_ai/connect` | Connector CLI (Connect Agent 2): one-shot provisioning — generates the delegate key locally, registers only the public address, writes runtime config, hands back to the dashboard for approval. |
| `@haven_ai/mcp-server` | Hosted, keyless MCP — constructs and relays payments; never holds the key. |
| `@haven_ai/signer` | Local edge signer — holds the delegate key, signs only. Only `{ payment_id, signature }` crosses to the hosted server. |
| `@haven_ai/mcp` | Fully-local MCP — the whole loop on one machine; **advanced opt-in** (`--local`), not the default. |
| `@haven_ai/demo-merchant-mcp` | Internal x402 demo merchant — test counterparty, not product. |

## Default topology

**Hosted MCP + local signer, for every runtime.** The connector writes a
hosted MCP entry (URL + Bearer API key) plus a local `haven-signer` stdio
entry for all supported agent environments (Claude Code, Codex, Cursor,
VS Code, Claude Desktop). Local MCP exists only behind the explicit `--local`
opt-in for Claude Code and Codex. Details and trade-offs:
[local vs. hosted MCP](08-local-vs-hosted-mcp.md), [edge signer](07-edge-signer.md).

## Connect flow (brief)

Dashboard creates a pending setup → user pastes one prompt into their agent →
connector pairs, generates the key locally, configures the runtime → user
approves the on-chain budget in Haven → the agent can pay. Full contract:
[Connect Agent 2 local-key pairing](../archive/connect-agent-2-local-key-pairing.md).

## External pieces

- **Safe + AllowanceModule** — custody and on-chain policy enforcement
  ([identity & custody](02-identity-and-custody.md)).
- **PostgreSQL** — agents, allowances, payments, audit trail.
- **Gnosis Chain** (POC custody, chain 100) and **Base** (x402 USDC
  settlement) ([x402 sequence](04-x402-payment-sequence.md)).

For trust boundaries and who-talks-to-who, start at
[system context](01-system-context.md).
