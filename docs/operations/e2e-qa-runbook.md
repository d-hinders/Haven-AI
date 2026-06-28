---
owner: "@d-hinders"
status: current
covers: []  # narrative — no direct code mirror
last-verified: "2026-06-28"
---

# E2E QA runbook — agent connection (#419) & x402 payments (#420)

These two flows are inherently **live**: real agent runtimes, real wallets, real
merchants, on-chain settlement. They can't be fully automated in CI, so this is
the repeatable manual procedure. Where a slice *is* automatable it's noted and
already covered by Playwright — don't re-test those by hand unless investigating
a regression.

> After **every** run, capture findings in a run report under
> [`docs/bug-reports/`](../bug-reports/) using
> [`_run-report-template.md`](../bug-reports/_run-report-template.md). That's the
> feedback loop both checklists call for — it feeds friction/bugs back to the
> coding agent.

## Already automated (don't hand-test for happy path)

| Slice | Coverage |
|---|---|
| Connect-agent modal: create setup → prompt → connected-local → approval screen, no secrets leaked | `e2e/connect-agent-2.spec.ts` |
| Hosted-MCP connect copy/command | `e2e/hosted-mcp.spec.ts` |
| **x402 tx displays in history + opens the per-type detail panel** (#420 UI half) | `e2e/transactions-detail.spec.ts` |
| Approver add/remove/reuse/passkey logic, last-owner guard | unit tests (`ManageApprovers`, `safe-owner-tx`, route tests) |
| CSV export shape + injection guard | unit tests (`transaction-csv`) |

Run them with `pnpm --filter @haven/frontend test:e2e:desktop` (and the unit
suites with `pnpm -r test`).

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
