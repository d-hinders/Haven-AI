---
owner: "@d-hinders"
status: current
covers:
  - .github/workflows/qa-dev.yml
  - .github/workflows/qa-live.yml
  - packages/qa-agent/**
  - packages/frontend/package.json
  - packages/frontend/playwright.live.config.ts
  - packages/frontend/e2e/fixtures/live-session.ts
  - packages/frontend/e2e/live/**
  - packages/frontend/e2e/connect-agent.spec.ts
  - packages/frontend/e2e/hosted-mcp.spec.ts
  - packages/frontend/e2e/transactions-detail.spec.ts
  - packages/connect/src/**
  - packages/frontend/src/components/haven/__tests__/HostedConnectCard.test.tsx
  - packages/frontend/src/lib/__tests__/hosted-connect.test.ts
  - packages/frontend/src/components/settings/ManageApprovers.tsx
  - packages/frontend/src/components/settings/__tests__/ManageApprovers.test.tsx
  - packages/backend/src/modules/accounts/safe-owner-tx.ts
  - packages/backend/src/modules/accounts/__tests__/safe-owner-tx.test.ts
  - packages/backend/src/routes/__tests__/user-safes-approvers.test.ts
  - packages/frontend/src/lib/transaction-csv.ts
  - packages/frontend/src/lib/__tests__/transaction-csv.test.ts
  - docs/bug-reports/_run-report-template.md
last-verified: "2026-08-22" # #1771: corrected the "Already automated" row that credited `hosted-mcp.spec.ts` with mobile-overflow coverage — that test asserted a helper which could not fail inside the app shell and was removed; mobile overflow is covered by `navigation.mobile.spec.ts` under Pixel 5 emulation. Scope of this re-verification: the "Already automated" table only; the hand-test steps were NOT re-run. Prior: #1682: the per-environment run list notes the name-first picker (a row per environment again); steps themselves unchanged. Prior: #1672: noted the collapsed AI-agent picker entry in the per-environment run list; steps themselves unchanged. Prior: #1346 runtime-specific activation + read-only Connect verification re-checked; #1330 Hermes .env credential-reference verification
---

# E2E QA runbook — agent connection (#419) & x402 payments (#420)

These flows combine mocked Playwright, deterministic Base Sepolia QA, deployed
UI smoke, and manual live exploration. Only the live modes prove real runtime,
wallet, merchant, or on-chain behavior.

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
| Connect-agent modal: create setup → prompt → connected-local → approval screen, no secrets leaked | `e2e/connect-agent.spec.ts` |
| Hosted-MCP agent/allowance/CTA states | `e2e/hosted-mcp.spec.ts` |
| Mobile-viewport layout overflow on the primary authenticated routes | `e2e/navigation.mobile.spec.ts` (Pixel 5 emulation, gates every PR since #1770) |
| Hosted connect copy, commands, and deep-link behavior | `HostedConnectCard.test.tsx`; `hosted-connect.test.ts` |
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

Run per environment: **Claude Code, Claude Desktop, Cursor, VS Code MCP, Hermes
Agent, custom SDK runtime**, plus any others available. (Since #1682 the
dashboard picker is a flat list of product names — Claude Code, Claude Desktop,
Codex, Cowork, Cursor, Hermes Agent, OpenClaw, VS Code, "Not listed / other" —
so a row exists per environment again. The three command-path rows still send
the same flag-free command and the connector detects the runtime it executes
inside, so covering one of them exercises the others' plumbing.)

1. **Create the setup** in the dashboard (Connect agent) and pick the target
   environment. Expect a single paste-able setup prompt; no private key shown.
2. **Run the connector** in that environment (`npx @haven_ai/connect@alpha …` or
   the pasted prompt). Expect: credentials written under `~/.haven/agents/<id>/`,
   hosted MCP + `haven-signer` entries written to that runtime's config, and the
   dashboard advancing to the approval screen. For Hermes, verify its
   `config.yaml` references `MCP_HAVEN_API_KEY` while the matching owner-only
   `.env` holds the value; do not copy secrets into the run report.
3. **Approve, then activate MCP wiring** — approval, not activation, unlocks
   Haven tools. Start a new Claude Code session or fresh Codex CLI session
   (`codex resume --last` is one option); restart Codex Desktop or Claude
   Desktop; let Cursor/VS Code hot-reload; and for Hermes start a new session
   or run `/restart` in Gateway. For Hermes, check `hermes mcp list` shows both
   `haven` and `haven-signer`, then run `hermes mcp test haven`. Install its MCP
   SDK with `pip install mcp` if tools are absent.
4. **Confirm read-only state** — `haven_get_agent` and
   `haven_get_allowances` show identity, readiness, the Haven wallet, and the
   configured budget/live remaining. Do not sign, fund, or create a payment to
   verify setup.
5. **Confirm a basic action** — approve the budget on-chain (wallet/passkey), then
   have the agent do a small allowed action (e.g. a direct `haven_pay` within budget
   or an x402 call). Expect it to settle, or to queue for approval if over budget.

Record per environment: did each of steps 1–5 pass, and any friction.

## #420 — x402 payments, end to end

Run per merchant: **Soundside, the demo merchant, and any additional real
merchants** found.

1. **Settle on-chain** — agent pays an x402-gated call. Within remaining
   allowance it settles; above remaining but within total coverage it queues;
   above remaining plus delegate balance it rejects as insufficient. Confirm
   the expected on-chain or approval result.
2. **Displays correctly in the UI** — the payment appears in Transaction history
   and its detail panel shows the x402 fields (resource host, merchant, amount,
   payment id, on-chain section). *Happy path here is automated
   (`transactions-detail.spec.ts`); hand-check only the real-merchant specifics
   the mock can't cover (actual amount, real merchant address, real tx hash).*
3. **Receipt is logged** — payment evidence is recorded (smart account/delegate,
   merchant, token, amount, chain, x402 resource, tx hash).

Note edge cases worth forcing: over-budget with available total coverage
(queues for approval), above total coverage (rejects as insufficient),
`PRICE_EXCEEDS_MAX`, and a merchant that verifies but doesn't settle
(delegate sweep recovery).

## Reporting

Create one uniquely named UTC/run-id report per session from the template.
Record mode and targets, exact command and exit code, pass/fail/skip per check,
evidence and artifact paths, cleanup, and secret review. A required skip makes
the run partial/blocked even if its process exits zero. File concrete bugs as
separate issues.
