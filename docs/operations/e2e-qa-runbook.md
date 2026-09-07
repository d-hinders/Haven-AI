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
  - docs/bug-reports/_run-report-template.md
last-verified: "2026-08-28" # #2422: step 3 of the #419 agent-connection procedure hardcoded `npx @haven_ai/connect@alpha` while instructing a tester to run the connector "in that environment" — and this runbook's own `covers:` includes `.github/workflows/qa-dev.yml`, so "that environment" is routinely the DEV backend. Since #2422 the dist-tag is per-deployment (`HAVEN_CONNECTOR_CHANNEL`), so the literal is conditionally wrong exactly where this doc is used; the step now names the package the environment's own setup response returns, and gains the `-y` the real `buildConnectorCommand` emits. Scope: that ONE step ONLY — no other step, env table or expectation in this runbook was re-read or re-verified in this pass. Prior: #2140: two stale queue claims, in different sections. (1) The #420 step 1 contradicted this same file's #420 edge-case note TWELVE LINES BELOW — the step said an over-budget x402 call "queues", the note said the queue died with the Safe rail. The note was right. Its "above remaining but within total coverage" middle band is REMOVED rather than reworded: that band described a top-up from the delegate's own balance, and there is no such leg to queue against. The step now points AT the edge-case note for which refusal each path gives, rather than becoming a fourth copy of the three refusal shapes. (2) The "Already automated" coverage table named the harness invariants as "settle, queue, reject, ..." — the `queue` leg was renamed `over-budget-refused` by #2016 for exactly this reason, so the table promised coverage of an invariant that cannot exist. Corrected to "over-budget refusal (direct and x402)" against `packages/qa-agent/src/scenarios/`; note this row is a GLOSS, not a list of scenario names. A first attempt at it wrote "price rejection", which haven-reviewer caught as a new inaccuracy: `x402-over-budget-rejected` and its erc7710 sibling carry `PRICE_EXCEEDS_MAX` in their header comments as a legacy label, but both drive an OVER-BUDGET call — the agent's own client-side max-price cap is a different check and is not harness-covered, as this file's own chain already records. Why (1) survived is the instructive part: #2082 says it fixed "the forced-edge-case note" and #1992 before it "steps 6 and the #420 edge-case note" — two passes corrected the note without re-reading the step above it. A scoped `last-verified` note is also a record of what a pass did not look at. (3) found by haven-doc-reviewer on THIS pass: #419 step 6 said an over-budget payment "reverts on-chain during gas estimation", unqualified — true for direct payments and the EIP-3009 leg, but NOT for erc7710, the preferred scheme, where #2082 established an off-chain `403 delegation_budget_exceeded` before any chain call. Step 6 explicitly offers "or an x402 call", so a tester forcing one on erc7710 would hunt for a revert reason that does not exist. The same drift again: #1992 revised step 6 for the QUEUE half and #2082 later refined the MECHANISM only in the #420 note below it. Step 6 now points AT that note rather than becoming a third copy. Scope: #420 step 1, the one coverage-table row, and #419 step 6 ONLY; #420 steps 2-3, the rest of the #419 section, the environment tables and the live-spec wiring were NOT re-verified. Prior: #2082: the forced-edge-case note told a tester over-budget "reverts on-chain", which is now only half true — on erc7710 (the preferred scheme) an off-chain remaining-budget pre-check returns HTTP 403 before any chain call, so a tester forcing this case against an erc7710 merchant would see a 403 and not the revert the note promised. The mechanism is now named per path. `PRICE_EXCEEDS_MAX` is untouched — that is the agent's own cap check. Scope: that one note; nothing else re-verified. Prior: #1992: two hand-test steps told the tester an over-budget payment "queues for approval". The approval queue died with the Safe rail (#1986/#1987) — over-budget REVERTS on-chain during gas estimation on the delegation rail, so the old instruction would have had a tester record a failure as a pass. Caught by haven-doc-reviewer. Scope: steps 6 and the #420 edge-case note; the rest of the runbook was NOT re-verified, and its QA-harness prerequisites remain subject to #2011. Prior: #1988: the "Approver add/remove/reuse/passkey logic, last-owner guard" row is DELETED, along with its three backend `covers:` entries. Same reasoning as #1813 below and the #1771 defect it names: the backend half of that flow no longer exists — `safe-owner-tx.ts`, the approver routes and their tests are deleted with the Safe rail — so the row credited coverage of a flow that cannot run. `ManageApprovers.tsx` and its unit tests survive until #1989 removes them, and their `covers:` entries are left for that slice; a passing component test over a 404ing endpoint is not coverage of the behaviour the row claimed. Scope: that row and those three covers entries only; the hand-test steps were NOT re-run. Prior: #1813: removed the "Hosted connect copy, commands, and deep-link behavior" row from "Already automated" and the two `covers:` entries feeding it. Both named tests were deleted with the component they covered — HostedConnectCard lost its only call site when #345 retired CreateAgentModal and has been unreachable since. The row is DELETED rather than repointed because the behaviour it claimed coverage of no longer exists in the product; repointing would have re-created exactly the #1771 defect in the same table — a row crediting coverage that is not there. Scope: this row and the covers list only; the hand-test steps were NOT re-run. Prior: #1720: the per-environment run list is no longer a picker-row list — there is no picker, so per-environment coverage now checks that the CONNECTOR resolves each environment from an identical command, and a deliberately-undetectable environment becomes a case worth running rather than an unreachable one. Step 1 rewritten (nothing to pick; commands must match across environments) and a new step 2 added for confirming which resolution rung fired, renumbering the rest. Other steps and the "Already automated" table NOT re-run. Prior: #1771: corrected the "Already automated" row that credited `hosted-mcp.spec.ts` with mobile-overflow coverage — that test asserted a helper which could not fail inside the app shell and was removed; mobile overflow is covered by `navigation.mobile.spec.ts` under Pixel 5 emulation. Scope of this re-verification: the "Already automated" table only; the hand-test steps were NOT re-run. Prior: #1682: the per-environment run list notes the name-first picker (a row per environment again); steps themselves unchanged. Prior: #1672: noted the collapsed AI-agent picker entry in the per-environment run list; steps themselves unchanged. Prior: #1346 runtime-specific activation + read-only Connect verification re-checked; #1330 Hermes .env credential-reference verification Prior: #2097: the CSV export row (a file this doc `covers:` by exact path) gains the `initiator` column — appended after `fee_sek`, carrying the raw `human | agent | unknown` enum, empty for inbound rows; the `transaction-csv` unit suite covers the new shape. Scope: that row and the CSV column contract only; the hand-test steps were NOT re-run.
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
| CSV export shape + injection guard | unit tests (`transaction-csv`, #2097) — the export gained the `initiator` column (`human` \| `agent` \| `unknown`, empty for inbound/unattributed rows); column count is asserted so the shape is pinned |

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
   note below; on erc7710 it is an off-chain `403` before any chain call, so do not
   expect an on-chain revert reason there. Either way the delegation rail has no
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
payments and the EIP-3009 leg, and since #2082 an off-chain remaining-budget
pre-check returning HTTP 403 `delegation_budget_exceeded`, before any chain
call, on erc7710), `PRICE_EXCEEDS_MAX`, and a merchant that
verifies but doesn't settle (delegate sweep recovery, still live via the #946
EIP-3009 bridge).

## Reporting

Create one uniquely named UTC/run-id report per session from the template.
Record mode and targets, exact command and exit code, pass/fail/skip per check,
evidence and artifact paths, cleanup, and secret review. A required skip makes
the run partial/blocked even if its process exits zero. File concrete bugs as
separate issues.
