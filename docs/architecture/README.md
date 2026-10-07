---
owner: "@d-hinders"
status: current
covers:
  - docs/architecture/0*.md
  - docs/architecture/1*.md
  - docs/archive/connect-agent-2-*.md
  - docs/research/**
  - packages/core/src/chains.ts
  - packages/backend/src/domain/chains.ts
  - packages/frontend/src/lib/chains.ts
  - packages/backend/src/middleware/agentAuth.ts
  - packages/connect/src/runtime.ts
  - packages/backend/src/modules/fee/fee-module.ts
  - packages/backend/src/middleware/safe-inflow-retired.ts
last-verified: "2026-10-07"
---

# Haven — Architecture

Internal engineering reference for how identity, custody, and authority flow
through Haven. Numbered docs describe current implementation unless a row is
explicitly marked as design/scaffold. Where Mermaid is present, markdown source
is canonical; exported PNG and SVG files are convenience artifacts.

| # | Document | Use when |
|---|---|---|
| 0 | [Architecture Overview](00-overview.md) | First stop — the whole stack at a glance: components, default topology, connect flow, external pieces. |
| 1 | [System Context](01-system-context.md) | Onboarding, security reviews, "who talks to who" questions. Shows trust boundaries. |
| 2 | [Identity & Custody Map](02-identity-and-custody.md) | Reasoning about blast radius — what is held by user, Haven, agent, and on-chain. |
| 3 | [Payment Execution Sequence](03-payment-sequence.md) | Tracing a payment from API call to on-chain settlement; auto-execute within the budget, declined outside it. |
| 4 | [x402 Payment Sequence](04-x402-payment-sequence.md) | Delegation-rail x402 (erc7710 direct settlement and the EIP-3009 bridge), hosted generic split, hosted paid-MCP three-call fast path, restart-recovery context rehydration, the #2145 funded-but-undelivered resume trigger and the #2290 signing leg that makes it actionable, task budgets (#3329) and sub-agent budgets (#3330). Its SDK/local MCP AllowanceModule flow is kept as retired history. |
| 5 | [Agent API OpenAPI Contract](05-agent-api-openapi.md) | Public OpenAPI surface for non-TypeScript agent integrators and external reviewers. |
| 6 | [Hosted MCP Connect Flow & Edge-Signing Contract](06-hosted-mcp-connect-flow.md) | Topology/custody contract and two-credential split, the dashboard connect flow, and the hosted direct-payment and x402 tool chains (paid-MCP fast path and the decomposed path, EIP-3009 and erc7710). Doc 4 holds the x402 authority boundaries; doc 7 the signer. |
| 7 | [Edge Signer](07-edge-signer.md) | The local component that holds the delegate key and signs — its form (signer core + local stdio MCP), the pay/x402 orchestration, and custody invariants. |
| 8 | [Local vs Hosted MCP](08-local-vs-hosted-mcp.md) | Topology and deployment trade-offs for default hosted MCP + edge signer versus advanced fully-local MCP. Use doc 7 for the current signer tool list and x402 fast path. |
| 9 | [Rail-agnostic Fee Module](09-fee-module.md) | Current disabled zero-fee backend scaffold plus future per-rail settlement design; no fee transfer executes today. |
| 10 | [Module Boundaries](10-module-boundaries.md) | Deciding where new backend code goes, or reviewing a change that moves it. Target module structure and the dependency rules CI enforces (epic #980). |
| 11 | [L0 Agent Passport — EAS schema](11-agent-passport-schema.md) | Working on agent identity: what L0 attests (governance, not identity), the schema fields, the dual address binding, the zero-address sentinel, the revocation model and re-anchoring after a re-key — Haven's verifier decides, the chain is an eventually-consistent anchor (epic #970). |

The detailed Connect Agent 2 contract and its rollout closeout were point-in-time
artifacts for shipping that feature; they now live in
[`docs/archive/`](../archive/README.md) for reference:
[pairing contract](../archive/connect-agent-2-local-key-pairing.md) and
[rollout closeout](../archive/connect-agent-2-rollout-closeout.md).
The current connect mechanism is covered by docs 6 (hosted MCP connect flow) and
7 (edge signer).

Forward-looking investigations (not current architecture) live in
[`docs/research/`](../research/) — e.g.
[smart-account-native x402 settlement](../research/x402-smart-account-settlement.md),
the spike to remove the delegate funding leg, and the
[ERC-4337 pilot rig](../research/erc4337-pilot-rig.md) (ADR #719: session-key
policy layer — rig, one-owner-tx migration recipe, and policy-enforcement
suite; superseded — the session rail it piloted is retired, #834).

## Regenerating exports

Where a doc contains Mermaid, its markdown is the source of truth. Regenerate
PNG/SVG after editing when the Mermaid CLI is available:

```sh
# Needs a headless Chromium; run where one is available.
for f in docs/architecture/[0-9]*-*.md; do
  base="${f%.md}"
  npx -y @mermaid-js/mermaid-cli@latest -i "$f" -o "$base.png" -b transparent
  npx -y @mermaid-js/mermaid-cli@latest -i "$f" -o "$base.svg" -b transparent
done
# mmdc appends -1, -2, ... per diagram. Single-diagram files drop the suffix;
# multi-diagram files (e.g. 04) keep -1/-2.
( cd docs/architecture
  for base in $(ls *-1.png 2>/dev/null | sed 's/-1\.png$//'); do
    [ -e "${base}-2.png" ] && continue
    mv "${base}-1.png" "${base}.png"; mv "${base}-1.svg" "${base}.svg"
  done )
```

## Scope notes

- Haven's networks are **Base (8453)**, primary production, and **Base
  Sepolia (84532)**, dev/QA. Gnosis Chain (100) is not a Haven network
  (owner, 2026-10-05; #3632); the registries still carry it as history-only:
  historical rows render through it, but the backend's supported set is Base
  and Base Sepolia and chain 100 has no RPC path (epic #3634). Standard
  exact-scheme USDC x402 supports Base and Base Sepolia.
  Re-verified against `packages/core/src/chains.ts`,
  `packages/backend/src/domain/chains.ts` and
  `packages/frontend/src/lib/chains.ts` on 2026-10-07.
- **API-key agents only.** (An earlier self-sign / EIP-191 agent path was
  removed — it is no longer part of the codebase.)
- **One live policy rail.** Docs 1–3 lead with the
  **legacy AllowanceModule rail**, which is **RETIRED** (#1440) — the closure
  sequence is in the [decision log](../archive/decision-log.md#2026-08-14--retire-the-safe-rail-entirely-1440). Existing Safe rows stay readable to a
  direct database query — though no account, agent or dashboard surface displays them —
  and cannot spend through Haven's retired payment/API paths. Any
  residual AllowanceModule permission may remain on-chain, outside Haven, until
  the Safe owner revokes it externally, so read those diagrams and sequences as a historical baseline; docs 4 and 5 describe the live surface and mark their retired-rail passages in place. The
  Smart Sessions **session rail is retired** too (#834): `session_key` accounts
  get HTTP 410 from the payment paths. Every account that can spend runs on the
  **delegation rail** (epic #821, `account_type='delegator_hybrid'`,
  `execution_rail='delegation'`): a MetaMask Hybrid DeleGator smart account whose
  budget is a signed delegation with audited caveat enforcers, redeemed via the
  DelegationManager — direct payments and erc7710 x402 with no funding leg, the
  EIP-3009 x402 fallback funding the delegate first — and no approval queue.
  Each of docs 1–5
  now carries a scoped delegation-rail branch; the canonical deep docs are
  [`delegation-rail-security-model.md`](../security/delegation-rail-security-model.md),
  [`delegation-rail-vendor-ops.md`](../operations/delegation-rail-vendor-ops.md),
  and the [exit guarantee](../exit/README.md). The delegation rail is **Base-only**;
  Gnosis is not in scope for it.
- Re-verified 2026-09-21 (weekly docs audit #3206, at dev `7f17c9f3`): the
  index above, the scope notes and every linked doc, archive file and research
  note were checked to still exist and describe what their rows say. The
  intervening commits touched covered code (`connect/src/runtime.ts`,
  `agentAuth.ts`, the chains registries) and sibling architecture docs, but no
  claim in this file changed meaning.
- Re-verified 2026-10-07 (weekly docs audit #3645, at dev `009bd611`). Changed:
  rows 4 and 6 now describe what docs 04 and 06 actually hold (doc 06 has
  documented the paid-MCP fast path since #702, so "predates" was stale; doc
  04's live content is the delegation-rail x402 sections and the task/sub-agent
  budgets); the "One live policy rail"
  bullet scopes the legacy baseline to docs 1–3; the chain line names the
  history-only status of chain 100; the Safe-import sentence says import is
  closed (410). Re-checked without change: every index row's target and the
  rest of the scope notes.
- These docs and their mapped code are the implementation authority.
  [CLAUDE.md](../../CLAUDE.md) is current repository guidance, but broad claims
  must still be checked against implementation. Safe import is closed with the
  Safe rail (#1984): the import routes answer HTTP 410 to an authenticated
  caller. Delegate keys are locally generated by
  Connect Agent or supplied by the user/agent runtime; they are never generated
  by Haven's backend.
