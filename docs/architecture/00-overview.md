---
owner: "@d-hinders"
status: current
covers:
  - packages/*/package.json
  - packages/backend/src/lib/chains.ts
  - packages/backend/src/lib/merchant-catalog.ts
  - packages/backend/src/lib/catalog-discovery.ts
  - packages/backend/src/lib/reporting/**
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/backend/src/routes/demo-mpp.ts
  - packages/backend/src/routes/reporting.ts
  - packages/backend/src/routes/catalog.ts
  - packages/connect/src/api.ts
  - packages/connect/src/args.ts
  - packages/connect/src/key.ts
  - packages/connect/src/runtime-manifest.ts
  - packages/connect/src/runtime-registry.ts
  - packages/connect/src/config-writers.ts
  - packages/connect/src/runtime-install.ts
  - packages/connect/src/runtime.ts
  - packages/connect/src/signer-runtime.ts
  - packages/connect/src/storage.ts
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/index.ts
  - packages/frontend/src/app/**
  - packages/frontend/src/lib/chains.ts
  - packages/frontend/src/hooks/useReporting.ts
  - packages/frontend/src/hooks/useAccounting.ts
  - packages/cli/src/**
  - packages/qa-agent/src/**
  - packages/sdk/src/client.ts
  - packages/sdk/src/index.ts
  - packages/sdk/src/types.ts
  - packages/sdk/src/tool-descriptions.ts
  - packages/sdk/src/x402.ts
  - packages/sdk/src/sweep.ts
  - packages/mcp/src/cli.ts
  - packages/mcp/src/server.ts
  - packages/mcp/src/credentials.ts
  - packages/mcp/src/tools.ts
  - packages/mcp-server/src/boot.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/tools.ts
  - packages/signer/src/core.ts
  - packages/signer/src/tools.ts
  - packages/demo-merchant-mcp/src/**
  - docs/architecture/01-system-context.md
  - docs/architecture/02-identity-and-custody.md
  - docs/architecture/04-x402-payment-sequence.md
  - docs/architecture/05-agent-api-openapi.md
  - docs/architecture/06-hosted-mcp-connect-flow.md
  - docs/architecture/07-edge-signer.md
  - docs/architecture/08-local-vs-hosted-mcp.md
  - docs/regulatory/casp-risk-guardrails.md
last-verified: "2026-07-02"
---

# Haven — Architecture Overview

> Overview only — see the linked docs for detail. Keep this file short.

Haven is non-custodial coordination software between AI agents and money.
Agents request payments through high-level tools; Safe-originated funding and
user payments follow user-approved on-chain authority, while agent-wallet
merchant payments are signed locally and bound to exact payment context. One
line holds the security model:
**API auth = identity, signature = authority, on-chain AllowanceModule state =
enforcement for automatic Safe funding.**

## Components

| Package | One-liner |
|---|---|
| `@haven/backend` | Fastify API: auth, Haven wallets/Safes, agents, allowances, approvals, payments, x402/MPP, receipts, catalog, reporting, and [OpenAPI](05-agent-api-openapi.md). |
| `@haven/frontend` | Next.js dashboard: onboarding, wallets, agent rules, approvals, activity, custody/recovery, catalog, and guarded reporting. |
| `@haven_ai/sdk` | TypeScript agent client plus shared signing, x402, sweep, and payment-state primitives used by direct integrations and the MCP/signer packages. |
| `@haven_ai/connect` | Connector CLI: generates the delegate key and API key locally, registers the public signing address/proof and API-key hash, stores local credentials, writes runtime config, and returns the user to Haven for wallet approval. |
| `@haven_ai/mcp-server` | Hosted MCP — authenticates the agent API key, constructs unsigned payloads, and relays signed requests; never receives the delegate private signing key. |
| `@haven_ai/signer` | Local edge signer — holds the delegate key, signs only. Funding relay sends `{ payment_id, signature }` to hosted MCP; paid MCP-tool completion can also send a signed, merchant-bound `payment_header` for settlement/evidence. |
| `@haven_ai/mcp` | Fully-local MCP — tool orchestration and signing share one local process, while still using the configured Haven API/relayer and external chain or merchant; **advanced opt-in** (`--local`), not the default. |
| `@haven_ai/cli` | User-authenticated terminal companion for reads and backend-only management; owner-signed on-chain actions remain in the dashboard. |
| `@haven_ai/qa-agent` | Private Base-Sepolia dev harness for deterministic seeded money-flow and merchant round-trip checks; also hosts the experimental ERC-4337 pilot scripts (ADR #719, `src/pilot/` — see the research doc); not published. |
| `@haven_ai/demo-merchant-mcp` | Internal x402 demo merchant — test counterparty, not product. |

## Default topology

**Hosted MCP + local signer is the default.** For supported writable runtimes,
the connector writes a hosted MCP entry (URL + Bearer API key) plus a local
`haven-signer` stdio entry. Current profiles include Claude Code, Codex CLI and
Desktop, Cursor, VS Code/Insiders, Claude Desktop, and a manual fallback.
Fully local MCP exists only behind the explicit `--local` opt-in for Claude
Code and Codex. Details and trade-offs:
[local vs. hosted MCP](08-local-vs-hosted-mcp.md), [edge signer](07-edge-signer.md).

## Connect flow (brief)

Dashboard creates a pending setup → user runs the setup prompt locally →
connector generates both credentials locally, registers proof and public
metadata, stores credentials, and configures the runtime → user approves the
on-chain agent rules in Haven → the agent can pay. Current contracts:
[hosted MCP connect](06-hosted-mcp-connect-flow.md) and
[edge signer](07-edge-signer.md).

## External pieces

- **Safe + AllowanceModule** — custody and on-chain policy enforcement
  ([identity & custody](02-identity-and-custody.md)).
- **PostgreSQL** — users, wallets, agents, allowances, payments, approvals,
  receipts, catalog/reporting state, and audit records.
- **Base** (8453) is the primary production network; **Base Sepolia** (84532)
  is the dev/QA testnet; **Gnosis Chain** (100) remains supported for existing
  configured Safe flows. Standard merchant x402 is exact-scheme USDC on Base
  and Base Sepolia ([x402 sequence](04-x402-payment-sequence.md)).

For trust boundaries and who-talks-to-who, start at
[system context](01-system-context.md).
