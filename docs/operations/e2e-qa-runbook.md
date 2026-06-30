---
owner: "@d-hinders"
status: current
covers:
  - .github/workflows/qa-dev.yml
  - .github/workflows/qa-live.yml
  - packages/qa-agent/**
  - packages/frontend/e2e/live/**
  - packages/frontend/e2e/connect-agent-2.spec.ts
  - packages/frontend/e2e/hosted-mcp.spec.ts
  - packages/frontend/e2e/transactions-detail.spec.ts
  - packages/connect/src/runtime-manifest.ts
  - packages/frontend/src/components/settings/ManageApprovers.tsx
  - packages/frontend/src/components/settings/__tests__/ManageApprovers.test.tsx
  - packages/backend/src/lib/safe-owner-tx.ts
  - packages/backend/src/lib/__tests__/safe-owner-tx.test.ts
  - packages/frontend/src/lib/transaction-csv.ts
  - packages/frontend/src/lib/__tests__/transaction-csv.test.ts
last-verified: "2026-06-30"
---

# E2E QA runbook — agent connection (#419) & x402 payments (#420)

These flows are inherently **live**: real agent runtimes, real wallets, real
merchants, and on-chain settlement. Haven now automates the deterministic
money-flow invariants and deployed-UI smoke through manual GitHub Actions
workflows; environment-specific runtime and merchant exploration remains manual.

Start with the canonical
[`agent-qa.md`](./agent-qa.md) operator runbook for provisioning, funding,
secrets, local commands, GitHub dispatch commands, and troubleshooting. Use this
document for the remaining exploratory checklist.

> After **every** run, capture findings in a run report under
> [`docs/bug-reports/`](../bug-reports/) using
> [`_run-report-template.md`](../bug-reports/_run-report-template.md). That's the
> feedback loop both checklists call for — it feeds friction/bugs back to the
> coding agent.

## Already automated (don't hand-test for happy path)

| Slice | Coverage |
|---|---|
| Base Sepolia money-flow invariants: settle, queue, reject, x402 settle, sweep recovery | `packages/qa-agent`; local `npm run qa:dev -w packages/qa-agent` or Actions `qa-dev.yml` |
| Unmocked login/dashboard smoke against a Vercel preview + dev backend | `packages/frontend/e2e/live`; local `test:e2e:live` or Actions `qa-live.yml` |
| Connect-agent modal: create setup → prompt → connected-local → approval screen, no secrets leaked | `e2e/connect-agent-2.spec.ts` |
| Hosted-MCP connect copy/command | `e2e/hosted-mcp.spec.ts` |
| **x402 tx displays in history + opens the per-type detail panel** (#420 UI half) | `e2e/transactions-detail.spec.ts` |
| Approver add/remove/reuse/passkey logic, last-owner guard | unit tests (`ManageApprovers`, `safe-owner-tx`, route tests) |
| CSV export shape + injection guard | unit tests (`transaction-csv`) |

Run the regular mocked frontend suite with:

```bash
npm run test:e2e -w packages/frontend
```

Do not substitute mocked browser coverage for the live money-flow or deployed-UI
workflows.

## #419 — Agent connection, end to end

Run per environment: **Claude Code, Claude Desktop, Cursor, VS Code MCP, custom
SDK runtime**, plus any others available.

1. **Create the setup** in the dashboard (Connect agent) and pick the target
   environment. Expect a single paste-able setup prompt; no private key shown.
2. **Run the connector** in that environment (`npx @haven_ai/connect@alpha …` or
   the pasted prompt). Expect: credentials written under `~/.haven/agents/<id>/`,
   hosted MCP + `haven-signer` entries written to that runtime's config, and the
   dashboard advancing to the approval screen.
3. **Confirm MCP wiring** — the Haven tools appear in the runtime (restart only
   if the runtime needs it; CLI runtimes pick them up in-session). `haven_get_agent`
   returns identity + readiness.
4. **Confirm allowances are visible** — `haven_get_allowances` (or `haven_get_agent`)
   shows the configured budget and live remaining.
5. **Confirm a basic action** — approve the budget on-chain (wallet/passkey), then
   have the agent do a small allowed action (e.g. a direct `haven_pay` within budget
   or an x402 call). Expect it to settle, or to queue for approval if over budget.

Record per environment: did each of steps 1–5 pass, and any friction.

## #420 — x402 payments, end to end

Run per merchant: **Soundside, the demo merchant, and any additional real
merchants** found.

1. **Settle on-chain** — agent pays an x402-gated call. Expect direct settlement
   within budget, or a queued approval when over. Confirm the on-chain transfer.
2. **Displays correctly in the UI** — the payment appears in Transaction history
   and its detail panel shows the x402 fields (resource host, merchant, amount,
   payment id, on-chain section). *Happy path here is automated
   (`transactions-detail.spec.ts`); hand-check only the real-merchant specifics
   the mock can't cover (actual amount, real merchant address, real tx hash).*
3. **Receipt is logged** — payment evidence is recorded (smart account/delegate,
   merchant, token, amount, chain, x402 resource, tx hash).

Note edge cases worth forcing: over-budget (queues for approval),
`PRICE_EXCEEDS_MAX`, and a merchant that verifies but doesn't settle
(delegate sweep recovery).

## Reporting

One run report per session in `docs/bug-reports/` from the template. Summarize
pass/fail per checklist item and file any concrete bug as its own issue.
