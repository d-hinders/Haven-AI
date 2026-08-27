---
owner: "@d-hinders"
status: current
covers:
  - packages/*/package.json
  - packages/core/src/index.ts
  - packages/backend/src/domain/chains.ts
  - packages/backend/src/modules/catalog/merchant-catalog.ts
  - packages/backend/src/modules/catalog/catalog-discovery.ts
  - packages/backend/src/modules/catalog/lifecycle.ts
  - packages/backend/src/modules/reporting/**
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/routes/hybrid-accounts.ts
  - packages/backend/src/rails/delegation-rail.ts
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
  - packages/sdk/src/account-reads.ts
  - packages/sdk/src/delegate-sweep.ts
  - packages/sdk/src/haven-api-transport.ts
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/sdk/src/index.ts
  - packages/sdk/src/payment-mappers.ts
  - packages/sdk/src/payment-state.ts
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
  - docs/architecture/11-agent-passport-schema.md
  - docs/regulatory/casp-risk-guardrails.md
last-verified: "2026-08-27" # #2102: External pieces listed "Safe + AllowanceModule — custody and on-chain policy enforcement" UNLABELLED and BEFORE "Hybrid DeleGator — a second account type for new accounts", which is backwards on both counts. Hybrid is now first and named as the account type for every new account; Safe is kept — those accounts still exist and their owners keep on-chain control — but explicitly labelled RETIRED with the closure (#1984) and refusal (#1986) refs. Kept rather than deleted deliberately: removing it would hide a rail whose accounts are still readable. #1992's scope note records that only the rail paragraph and components row were corrected in that pass, which is why this list was still stale. Scope: that one list entry pair. Prior: #2105: the bolded one-line security model re-based off the retired rail. It read `on-chain AllowanceModule state = enforcement for automatic Safe funding`, and #2105 removed the last live copy of that wording from the served OpenAPI contract (`AgentApiKey`'s security-scheme description), which would have left the overview presenting an obsolete formulation as the security model while README.md and doc 05 both carried the corrected one — the #1992 pattern in reverse. The paragraph beneath it is kept and now reads as history rather than as a correction of a live claim. Caught by haven-doc-reviewer. Scope: that line and the paragraph under it; nothing else in the overview re-verified in this pass. Prior: #2055: the approval-queue clause updated (deleted outright, not readable/rejectable) and "approvals" dropped from the PostgreSQL store list. Prior: #1992: the "Haven runs two on-chain policy rails" line was false - the AllowanceModule rail is retired (#1986 410s, #1987/#1988/#1989 deletions), so there is ONE live rail. Corrected, and the backend component one-liner no longer advertises allowances/approvals as live surfaces. Scope: the rail paragraph and the components table row. Prior: #1714 (epic #1717): catalogue ingestion lifecycle added to the catalog module — modules/catalog/lifecycle.ts drives the self-service submission queue (ownership proof → SSRF-hardened probe → re-verification → retention) on the new leader-locked catalogIngest monitor in index.ts; the operator-curated refresh and discovery are unchanged. Prior: #1984: the rail line said the legacy AllowanceModule rail was "import-only" — #1984 closes IMPORT too, so nothing enters it by any route; corrected to closed-to-new-accounts. The rest of the overview re-read against the diff: the delegation rail is still where new accounts are provisioned, and the custody boundary is unchanged. Prior: #1199: signer-removal recovery change re-verified; delegation authority overview unchanged
---

# Haven — Architecture Overview

> Overview only — see the linked docs for detail. Keep this file short.

Haven is non-custodial coordination software between AI agents and money.
Agents request payments through high-level tools; Safe-originated funding and
user payments follow user-approved on-chain authority, while agent-wallet
merchant payments are signed locally and bound to exact payment context. One
line holds the security model:
**API auth = identity, signature = authority, on-chain delegation state =
enforcement.**

That line read `on-chain AllowanceModule state = enforcement for automatic Safe
funding` until #2105, which corrected the last live copy of the old wording in
the served OpenAPI contract and then here. It described the **legacy
AllowanceModule rail**, which is **RETIRED**
(#1440) — closed to new accounts (#1984), fail-closed for spending with HTTP 410
on every payment and x402 entry point (#1986), and its execution machinery
deleted (#1987/#1988/#1989). Existing Safe accounts stay readable; they cannot
spend. The Smart Sessions **session rail is retired** too (#834; accounts still
marked `execution_rail='session_key'` get HTTP 410 from the payment paths).
**Haven runs one live on-chain policy rail**, the
**delegation rail** (epic #821, `account_type='delegator_hybrid'`,
`execution_rail='delegation'`), where the same identity/authority split holds but
enforcement is a signed MetaMask delegation with audited caveat enforcers (period
budget with native refill, optional recipient pin, expiry) redeemed via the
DelegationManager as a sponsored UserOp — funds move account→recipient directly,
with no funding leg and no approval queue. Deep dive:
[`docs/security/delegation-rail-security-model.md`](../security/delegation-rail-security-model.md).

## Components

| Package | One-liner |
|---|---|
| `@haven/backend` | Fastify API: auth, Haven wallets, agents, budgets, payments, x402/MPP, receipts, catalog, reporting (incl. the live Fortnox feed adapter, `modules/reporting/`), and [OpenAPI](05-agent-api-openapi.md). The retired rail’s approval queue was deleted outright by #2055 — routes deregistered, `approval_requests` dropped. |
| `@haven/frontend` | Next.js dashboard: onboarding, wallets, agent rules, approvals, activity, custody/recovery, catalog, and guarded reporting. |
| `@haven_ai/sdk` | TypeScript agent client plus shared signing, x402, sweep, and payment-state primitives used by direct integrations and the MCP/signer packages. |
| `@haven_ai/connect` | Connector CLI: generates the delegate key and API key locally, registers the public signing address/proof and API-key hash, stores local credentials, writes runtime config, and returns the user to Haven to approve the agent's authority (wallet approval on the legacy rail; budget-delegation signature on the delegation rail). |
| `@haven_ai/mcp-server` | Hosted MCP — authenticates the agent API key, constructs unsigned payloads, and relays signed requests; never receives the delegate private signing key. |
| `@haven_ai/signer` | Local edge signer — holds the delegate key, signs only. Funding relay sends `{ payment_id, signature }` to hosted MCP; paid MCP-tool completion can also send a signed, merchant-bound `payment_header` for settlement/evidence. |
| `@haven_ai/mcp` | Fully-local MCP — tool orchestration and signing share one local process, while still using the configured Haven API/relayer and external chain or merchant; **advanced opt-in** (`--local`), not the default. |
| `@haven_ai/cli` | User-authenticated terminal companion for reads and backend-only management; owner-signed on-chain actions remain in the dashboard. |
| `@haven_ai/core` | Shared Haven kernel — pure domain types and helpers used by BOTH the backend and the dashboard so neither re-derives them: address validation, the generated OpenAPI wire types (`api-types.ts`, drift-gated in CI by `npm run check:api-types`, #984), the chain+token registry facts (#986; backend/frontend layer env wiring and viem construction over them), and the machine-payment lifecycle domain (#987). **Private**, never published; private consumers pin it `"*"`. Must stay free of `fastify`/`pg`/`ethers`/`viem` — enforced by the `core-stays-pure` dependency rule (epic #980). |
| `@haven_ai/qa-agent` | Private Base-Sepolia dev harness for deterministic seeded money-flow and merchant round-trip checks; also hosts the experimental ERC-4337 pilot scripts (ADR #719, `src/pilot/` — see the research doc); not published. |
| `@haven_ai/demo-merchant-mcp` | Internal x402 demo merchant — test counterparty, not product. |

## Default topology

**Hosted MCP + local signer is the default.** For supported writable runtimes,
the connector writes a hosted MCP entry (URL + Bearer API key) plus a local
`haven-signer` stdio entry. Current profiles include Claude Code, Codex CLI and
Desktop, Cursor, VS Code/Insiders, Claude Desktop, Hermes Agent, and a manual
fallback. Hermes uses `$HERMES_HOME/config.yaml` plus an owner-only `.env` when
set, otherwise `~/.hermes/config.yaml` plus `.env`; the hosted API key stays in
that `.env` and config references it by name. Hermes loads new MCP servers after
a new session (or a gateway `/restart`).
Fully local MCP exists only behind the explicit `--local` opt-in for Claude
Code and Codex. Details and trade-offs:
[local vs. hosted MCP](08-local-vs-hosted-mcp.md), [edge signer](07-edge-signer.md).

## Connect flow (brief)

Dashboard creates a pending setup → user runs the setup prompt locally →
connector generates both credentials locally, registers proof and public
metadata, stores credentials, and configures the runtime → user approves in
the Haven modal (a wallet approval on the legacy Safe rail; on the delegation
rail the budget-delegation signature itself, which also activates the agent —
#1069/#1076) → the runtime activates its new MCP entry → the agent makes the
read-only `haven_get_agent` and `haven_get_allowances` checks before any
payment. Current contracts:
[hosted MCP connect](06-hosted-mcp-connect-flow.md) and
[edge signer](07-edge-signer.md).

## External pieces

- **Hybrid DeleGator (epic #821)** — the account type for every new account
  (`account_type='delegator_hybrid'`): MetaMask's audited smart account with
  policy as delegations + caveat enforcers. Payments redeem the agent's
  budget delegation via sponsored UserOps (#829); budgets refill natively
  on-chain. See `docs/security/delegation-rail-security-model.md`.
- **Safe + AllowanceModule — RETIRED (epic #1440).** Existing Safe accounts
  remain readable and their owners keep on-chain control, but the rail is
  closed to new accounts (#1984) and refuses every payment path (#1986). It is
  listed here because those accounts still exist, not because anything routes
  to it ([identity & custody](02-identity-and-custody.md)).
- **EAS (Ethereum Attestation Service) — L0 agent passports (epic #970):**
  opt-in, revocable credential attesting an agent's **governance, not
  identity** (issued / governed / revocable), anchored by the gas-only relayer
  on Base Sepolia. Haven's verifier is authoritative for live standing; the
  on-chain anchor is eventually consistent. See
  [agent passport schema](11-agent-passport-schema.md).
- **PostgreSQL** — users, wallets, agents, allowances, payments,
  receipts, catalog/reporting state, and audit records.
- **Base** (8453) is the primary production network; **Base Sepolia** (84532)
  is the dev/QA testnet; **Gnosis Chain** (100) remains supported for existing
  configured Safe flows. Standard merchant x402 is exact-scheme USDC on Base
  and Base Sepolia; delegation-rail accounts settle x402 via ERC-7710 direct
  settlement, with a per-payment EIP-3009 fallback for facilitators without erc7710 support (#946)
  ([x402 sequence](04-x402-payment-sequence.md)).

For trust boundaries and who-talks-to-who, start at
[system context](01-system-context.md).
