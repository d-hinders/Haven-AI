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
  - packages/frontend/src/lib/transaction-csv.ts
  - packages/frontend/src/lib/__tests__/transaction-csv.test.ts
  - packages/backend/src/domain/csv.ts
  - packages/backend/src/domain/__tests__/csv.test.ts
  - packages/backend/src/modules/transactions/csv-export.ts
  - packages/backend/src/modules/transactions/__tests__/csv-export.test.ts
  - packages/backend/src/routes/__tests__/transactions-export-csv.test.ts
  - docs/bug-reports/_run-report-template.md
last-verified: "2026-09-11"
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
| Base Sepolia money-flow invariants: settle, over-budget refusal (direct and x402), x402 settle, funded-but-undelivered crash/resume recovery, sweep recovery | `packages/qa-agent`; local `npm run qa:dev -w packages/qa-agent` or Actions `qa-dev.yml` |
| Unmocked login/dashboard smoke against a Vercel preview + dev backend | `packages/frontend/e2e/live`; local `test:e2e:live` or Actions `qa-live.yml` |
| Connect-agent modal for delegation accounts: create setup → prompt → connected-local → budget-approval screen, no secrets leaked | `e2e/connect-agent.spec.ts` |
| Hosted-MCP agent/allowance/CTA states | `e2e/hosted-mcp.spec.ts` |
| Mobile-viewport layout overflow on the primary authenticated routes | `e2e/navigation.mobile.spec.ts` (Pixel 5 emulation, gates every PR since #1770) |
| Dialog/overlay layout overflow **at a mobile viewport** | `e2e/receive-modal.mobile.spec.ts` (Pixel 5, #1797). The three desktop callers of `measureDialogOverflow` run only at 1280px, where a dialog is least likely to overflow |
| **x402 tx displays in history + opens the per-type detail panel** (#420 UI half) | `e2e/transactions-detail.spec.ts` |
| CSV export shape + injection guard | backend unit tests (`domain/__tests__/csv.test.ts` for RFC 4180 quoting and formula-injection neutralisation, `modules/transactions/__tests__/csv-export.test.ts` for the column contract) plus the route test `routes/__tests__/transactions-export-csv.test.ts`. #2871 moved generation server-side, so the frontend `transaction-csv` test no longer covers either property — it is down to the filename and the download shim. The `initiator` column (#2097 — `human` \| `agent` \| `unknown`, empty for inbound/unattributed rows) survives the move; column order is asserted against `TRANSACTION_CSV_COLUMNS` so the shape stays pinned |

Run the regular mocked frontend suite with:

```bash
npm run test:e2e -w packages/frontend
```

Do not substitute mocked browser coverage for the live money-flow or deployed-UI
workflows.

## #419 — Agent connection, end to end

Run per environment: **Claude Code, Claude Desktop, Cursor, VS Code MCP, Hermes
Agent, custom SDK runtime**, plus any others available.

Since [#1720](https://github.com/d-hinders/Haven-AI/issues/1720) this list is
**no longer a picker-row list** — there is no picker, and the dashboard emits a
byte-identical command for every environment. That changes what per-environment
coverage is FOR. It is no longer checking that a row sends the right flag;
it is checking that the connector, given the same command everywhere, resolves
each environment correctly on its own. That is the riskier half, so the list
gets longer rather than shorter: an environment where detection is expected to
fail (a plain terminal driving a desktop app) is now a case worth running
deliberately, not an unreachable one.

1. **Create the setup** in the dashboard (Connect agent). There is nothing to
   pick — expect a single paste-able setup prompt with no runtime question
   anywhere in the flow, and no private key shown. The command must be
   identical to the one the previous environment's run produced.
2. **Confirm resolution, per environment.** In the connector's output, check
   which rung resolved the runtime — detection, an agent self-report, or the
   installed-client prompt (#1719). In an environment where nothing is
   detectable and stdin is not a TTY, expect a refusal naming `--runtime`
   values and NO side effects, then re-run once with `--runtime <name>`. The
   dashboard cannot show this failure (it fires before Haven is contacted), so
   the connector's output is the only evidence — the waiting screen's recovery
   block now says so.
3. **Run the connector for a delegation account** in that environment (`npx -y <connector_package> …`,
   where `<connector_package>` is the value that environment's own setup response returns — since
   #2422 the dist-tag is per-deployment (`HAVEN_CONNECTOR_CHANNEL`) and `@alpha` only in
   production — or the pasted prompt). Expect: credentials written under `~/.haven/agents/<id>/`,
   hosted MCP + `haven-signer` entries written to that runtime's config, and the
   dashboard advancing to the delegation budget-approval screen. For Hermes, verify its
   `config.yaml` references `MCP_HAVEN_API_KEY` while the matching owner-only
   `.env` holds the value; do not copy secrets into the run report.
4. **Approve, then activate MCP wiring** — approval, not activation, unlocks
   Haven tools. Start a new Claude Code session or fresh Codex CLI session
   (`codex resume --last` is one option); restart Codex Desktop or Claude
   Desktop; let Cursor/VS Code hot-reload; and for Hermes start a new session
   or run `/restart` in Gateway. For Hermes, check `hermes mcp list` shows both
   `haven` and `haven-signer`, then run `hermes mcp test haven`. Install its MCP
   SDK with `pip install mcp` if tools are absent.
5. **Confirm read-only state** — `haven_get_agent` and
   `haven_get_allowances` show identity, readiness, the Haven wallet, and the
   configured budget/live remaining. Do not sign, fund, or create a payment to
   verify setup.
6. **Confirm a basic action** — approve the delegation budget in the modal, then
   have the agent do a small allowed action (e.g. a direct `haven_pay` within budget
   or an x402 call). Expect it to settle. An over-budget payment is **refused before
   it becomes signable**, by a different mechanism per path — see the #420 edge-case
   note below; on BOTH x402 schemes it is an off-chain `403` before the redemption
   (erc7710 since #2082, the EIP-3009 leg since #2706), so do not expect an
   on-chain revert reason on either. Either way the delegation rail has no
   approval queue (#1440), so a queued approval is a FAILURE here, not an expected
   outcome.

Record per environment: did each of steps 1–6 pass, and any friction.

## #420 — x402 payments, end to end

Run per merchant: **Soundside, the demo merchant, and any additional real
merchants** found.

1. **Settle on-chain** — agent pays an x402-gated call. Within the remaining budget
   it settles; over it, the payment is **refused** — never queued. There is no
   "above remaining but within total coverage" middle band: that band described a
   top-up from the delegate's own balance, and on the delegation rail there is no
   such leg to queue against. Confirm either the expected on-chain settlement or the
   refusal — the edge-case note below says which refusal each path gives.
2. **Displays correctly in the UI** — the payment appears in Transaction history
   and its detail panel shows the x402 fields (resource host, merchant, amount,
   payment id, on-chain section). *Happy path here is automated
   (`transactions-detail.spec.ts`); hand-check only the real-merchant specifics
   the mock can't cover (actual amount, real merchant address, real tx hash).*
3. **Receipt is logged** — payment evidence is recorded (smart account/delegate,
   merchant, token, amount, chain, x402 resource, tx hash).

Note edge cases worth forcing: over-budget (**refused before it becomes
signable** — the approval queue died with the Safe rail, #1440 — though by
different mechanisms per path: an on-chain gas-estimation revert on direct
payments only, and an off-chain remaining-budget pre-check returning HTTP 403
`delegation_budget_exceeded` before the REDEMPTION on **both** x402 schemes —
erc7710 since #2082, the EIP-3009 leg since #2706 (PR #2719), so on a healthy
budget read neither x402 path produces a revert reason to record. The pre-check
is itself an `eth_call` against the enforcer's storage, so what it precedes is
the redemption, not every chain call. Both pre-checks FAIL OPEN on a degraded read,
and there the schemes differ: on the 3009 leg you get the enforcer's 502 after
all, so a 502 there is a flapping RPC before it is a regression (see
agent-qa.md's #2511 entry); on erc7710, which prepares nothing, you get
`201 pending_signature` WITH `sign_data` — a signable over-budget intent, the
#1993 shape, and the one outcome here worth escalating rather than
retrying), `PRICE_EXCEEDS_MAX`, and a merchant that
verifies but doesn't settle (delegate sweep recovery, still live via the #946
EIP-3009 bridge).

## Reporting

Create one uniquely named UTC/run-id report per session from the template.
Record mode and targets, exact command and exit code, pass/fail/skip per check,
evidence and artifact paths, cleanup, and secret review. A required skip makes
the run partial/blocked even if its process exits zero. File concrete bugs as
separate issues.
