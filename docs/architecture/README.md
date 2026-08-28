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
last-verified: "2026-08-28" # #2145: the doc-4 summary row's parenthetical said the resume call "has no reachable trigger" — the trigger is now live (server-derived funded-but-undelivered on the eip3009 bridge), so the row names it instead. Scope: that one table cell; no other row re-verified. Prior: #2097: a doc in the `docs/architecture/0*.md` family it indexes (`05-agent-api-openapi.md`) was re-verified for the same change — the Transaction wire record gains `initiatedBy`; the index's summary table is unchanged. Scope: that family relationship only. Prior: #2121: the doc-4 summary row advertised "approval resume" as a reason to read the x402 doc — that section is gone, so the row now names what replaced it: restart-recovery resume of an AUTHORIZED payment. This is the row #2102 deliberately left alone (it fixed doc-3 beside it because doc 4 had not been fixed yet). Scope: that one table cell; no other row re-verified. Prior: #2102: the doc-3 summary row sold "auto-execute vs over-allowance branches" as a reason to read the payment-sequence doc — the over-allowance branch is the retired queue. Restated as auto-execute within the budget, declined outside it. Scope: that one table cell; no other row re-verified. Prior: #1714 (epic #1717): index re-read against the three architecture docs updated by the catalogue-ingestion lifecycle slice — 00-overview (covers + note), 05-openapi (SI4 ships no contract change) and 10-module-boundaries (catalog module grew lifecycle.ts); every row below still describes its doc. No structural change Prior: last-verified: "2026-08-24" # Prior: last-verified: "2026-08-25" # #1992: "Two policy rails coexist" was false — the AllowanceModule rail is retired, not merely closed to new accounts (#1986 410s, #1987/#1988/#1989 deletions), so the index now says ONE live rail and frames docs 1-5 as a historical baseline. Flagged by the coupling gate as implicated by this slice's edits to docs 1, 2, 3 and 11. Scope: that bullet; the per-doc summary rows were re-read against the docs they point at and none moved. Prior: #1984: "import-only" corrected in the index summary. Every other row re-read against the doc it points at; no summary moved. Prior: #1699: doc 11's one-line summary gains re-anchoring, since that doc now carries a section on it; the index was otherwise re-read row by row against the files it points at and every other summary still describes its doc. No structural change. Prior: #1615: re-verified after SDK module-ownership coverage updates; architecture index unchanged. Prior: #1199 signer-removal recovery clarification
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
| 4 | [x402 Payment Sequence](04-x402-payment-sequence.md) | Standard SDK/local MCP, hosted generic split, hosted paid-MCP three-call fast path, and restart-recovery context rehydration and the #2145 funded-but-undelivered resume trigger. |
| 5 | [Agent API OpenAPI Contract](05-agent-api-openapi.md) | Public OpenAPI surface for non-TypeScript agent integrators and external reviewers. |
| 6 | [Hosted MCP Connect Flow & Edge-Signing Contract](06-hosted-mcp-connect-flow.md) | Topology/custody contract and two-credential split. It predates the one-call signer fast path; use docs 4 and 7 for current x402 orchestration. |
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

- Current registries support **Base (8453)**, **Base Sepolia (84532)**, and
  **Gnosis Chain (100)**. Base is primary production, Base Sepolia is dev/QA,
  and Gnosis remains for existing configured flows. Standard exact-scheme USDC
  x402 supports Base and Base Sepolia.
- **API-key agents only.** (An earlier self-sign / EIP-191 agent path was
  removed — it is no longer part of the codebase.)
- **One live policy rail.** Docs 1–5 primarily describe the
  **legacy AllowanceModule rail**, which is **RETIRED** (#1440): closed to new
  accounts (#1984), HTTP 410 on every payment and x402 entry point (#1986), and
  its machinery deleted (#1987/#1988/#1989). Existing Safe accounts stay
  READABLE but cannot spend, so read those docs as a historical baseline. The
  Smart Sessions **session rail is retired** too (#834): `session_key` accounts
  get HTTP 410 from the payment paths. Every account that can spend runs on the
  **delegation rail** (epic #821, `account_type='delegator_hybrid'`,
  `execution_rail='delegation'`): a MetaMask Hybrid DeleGator smart account whose
  budget is a signed delegation with audited caveat enforcers, redeemed via the
  DelegationManager with no funding leg and no approval queue. Each of docs 1–5
  now carries a scoped delegation-rail branch; the canonical deep docs are
  [`delegation-rail-security-model.md`](../security/delegation-rail-security-model.md),
  [`delegation-rail-vendor-ops.md`](../operations/delegation-rail-vendor-ops.md),
  and the [exit guarantee](../exit/README.md). The delegation rail is **Base-only**;
  Gnosis is not in scope for it.
- These docs and their mapped code are the implementation authority.
  [CLAUDE.md](../../CLAUDE.md) is current repository guidance, but broad claims
  must still be checked against implementation. Safe import does not prove
  ownership on-chain at import time. Delegate keys are locally generated by
  Connect Agent or supplied by the user/agent runtime; they are never generated
  by Haven's backend.
