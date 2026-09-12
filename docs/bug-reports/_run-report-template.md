---
owner: "@d-hinders"
status: current
covers:
  - docs/operations/e2e-qa-runbook.md
  - docs/operations/agent-qa.md
  - packages/frontend/package.json
  - packages/frontend/playwright.config.ts
  - packages/frontend/playwright.live.config.ts
  - packages/frontend/e2e/**
  - packages/frontend/src/components/ConnectAgentModal.tsx
  - packages/connect/src/**
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/backend/src/rails/sweep.ts
  - packages/backend/src/config.ts
  - packages/sdk/src/sweep.ts
  - packages/qa-agent/**
  - .github/workflows/ci.yml
  - .github/workflows/qa-dev.yml
  - .github/workflows/qa-live.yml
  - .claude/commands/qa-dev.md
  - .claude/commands/qa-explore-ui.md
  - .claude/commands/qa-explore-agent-onboarding.md
last-verified: "2026-09-06"
---

<!--
Per-run QA report.
Copy to `<yyyy-mm-ddThhmmssZ>-<mode>-<flow>-<env>.md` using a slugged UTC
timestamp, or include the CI run id/short SHA so concurrent runs cannot collide.
File concrete bugs as separate GitHub issues and link them here.
Procedures: ../operations/e2e-qa-runbook.md and ../operations/agent-qa.md.
-->

# QA run report — <mode> — <flow> — <environment>

> **Secret-safety rule:** Never paste private keys, API keys, JWTs/cookies,
> setup tokens or token-bearing prompts, credential files, Authorization
> headers, or secret-bearing logs. Record safe prefixes only where necessary,
> plus public addresses, payment IDs, transaction hashes, sanitized URLs, and
> redacted artifacts. Confirm artifacts were checked for secrets before commit.

## Run Metadata

- **Run mode:** mocked Playwright | deployed live Playwright | deterministic `qa:dev` | manual live runtime/merchant | browser exploration
- **Flow/scenarios:**
- **Started / finished (UTC):**
- **Runner:**
- **Exact command:**
- **Process exit code:**
- **Git branch / SHA:** `<branch from dev>` / `<sha>`
- **Frontend URL / build SHA:** `<per-PR preview or localhost>` / `<sha>`
- **Backend URL / deploy SHA:**
- **Merchant URL / version:** `<sanitized hostname>` / `<version>`
- **Chain:** `<name>` (`<chain id>`)
- **Runtime/browser:** `<runtime + version or Playwright project/device>`
- **Package versions:** connect `<version>` · SDK `<version>` · QA harness `<sha/version>`
- **CI workflow/run:** `<link or n/a>`
- **Public QA identity:** user/agent id or safe/delegate address where useful
- **Overall result:** pass | pass with friction | partial/blocked | fail
- **Completeness:** `<passed>/<required> passed · <failed> failed · <skipped> skipped`

A required skipped scenario makes the overall run **partial/blocked**, even when
the harness exits zero. Keep per-check pass/fail/skip separate from process exit
status. Mocked Playwright verifies UI structure and must not claim live
on-chain settlement.

## Preflight

Mark items `n/a` when the selected mode cannot exercise them; mocked Playwright
does not require funded wallets, relayer gas, or live credentials.

- [ ] Dev/testnet only; no production credentials, RPCs, or real funds.
- [ ] Correct frontend, backend, hosted MCP, and merchant targets confirmed.
- [ ] Haven wallet test-token balance and remaining live delegation budget recorded;
      legacy Safe authority is marked n/a.
- [ ] Relayer has testnet gas.
- [ ] Delegate balance recorded when testing x402/recovery.
- [ ] Required local/CI secret names are present without printing values.

## Command And Artifacts

- **Command output summary:** `<test count / scenario count / exit code>`
- **Playwright base URL / project / retries:** `<when applicable>`
- **Artifacts:** `<trace, screenshot, video, HTML report, sanitized log paths>`
- **Default Playwright artifact paths:**
  - `output/playwright/test-results`
  - `output/playwright/html-report`
  - `output/playwright-live/test-results`
  - `output/playwright-live/html-report`
- **Artifact secret review completed:** yes (required before commit)

If the secret review fails, do not commit the report or artifacts. Redact or
remove the affected files first.

Canonical commands:

```sh
# Both gating Playwright projects — desktop + mobile (#1768). This is what CI runs.
npm run test:e2e:gate -w packages/frontend
# One project at a time, while iterating:
npm run test:e2e:desktop -w packages/frontend
npm run test:e2e:mobile -w packages/frontend
npm run test:e2e:live -w packages/frontend
npm run qa:dev -w packages/qa-agent
```

## Agent Connection — When In Scope

| Check | Expected evidence | Result | Actual evidence / notes |
|---|---|---|---|
| Setup prompt | Default flow shows one prompt/command and no private key or API key | pass / fail / skip | |
| Local credentials | Connector creates API and signing credentials locally; backend receives public signing address/proof and API-key hash/prefix | pass / fail / skip | Sanitized paths/registration evidence |
| Runtime wiring | Hosted MCP and local signer entries load, with correct restart/readiness behavior | pass / fail / skip | Runtime/config evidence |
| Delegation budget signature | Correct Haven wallet/network/rules shown; the signed delegation budget executes or the device-signature step is recorded | pass / fail / skip | Signature state/transaction; legacy retired rail = n/a |
| Agent readiness | `haven_get_agent` shows expected readiness and live remaining budget | pass / fail / skip | Readiness/allowance values |
| Named action | Record exact amount/action and expected terminal or approval state | pass / fail / skip | Action/payment ID/status |
| Manual fallback | If tested, one-time warning, explicit acknowledgement, trusted-runtime transfer, and close/reload loss behavior are correct | pass / fail / skip | |

## Money-Flow Scenarios — When In Scope

Record one row per deterministic or manual scenario.

| Scenario | Expected invariant | Result | Payment ID | Status/error code | Funding/settlement/sweep evidence | Notes |
|---|---|---|---|---|---|---|
| within-budget direct settle | Settles and is logged | pass/fail/skip | | | | |
| over-budget direct refusal | Refused by the on-chain caveat enforcer before it becomes signable; never auto-executed (#2016 — there is no approval queue on the delegation rail) | pass/fail/skip | | | Record the enforcer named in the revert reason, not just the 502 | |
| x402 over-budget reject | Rejects with no signable intent, on the EIP-3009 funding leg (#2016). Since #2706 (PR #2719) this is a typed **HTTP 403 `delegation_budget_exceeded`** at a pre-check before any prepare, not the enforcer's 502 — same as the erc7710 row below | pass/fail/skip | | | Record `error_code` and `remaining_atomic`. There is normally NO revert reason to record: the pre-check refuses before the chain is asked. A 502 carrying an enforcer name means the pre-check failed open on a degraded budget read (by design) — record that too, it is a flapping RPC before it is a regression | |
| x402 erc7710 over-budget reject | Rejects with no signable intent on the erc7710 direct-settlement scheme too — HTTP 403 `delegation_budget_exceeded` before a settlement child, an intent row or a relayer-paid delegate deploy exists (#2082). Until then erc7710 did NOT refuse at authorize and the budget was reached only at merchant redemption | pass/fail/skip | | | Record `error_code` and `remaining_atomic`, not just the 403 — a bare 403 is also what a MISSING delegation returns | |
| x402 settle | Funding and merchant settlement complete | pass/fail/skip | | | | |
| x402 sweep recovery | Stranded USDC at or above the sweep floor returns to the originating Haven wallet; dust below the floor is left on the delegate | pass/fail/skip | | | Record actual chain and `below_min`/floor state | |

For a manual live merchant also record:

- Resource hostname, exact amount/atomic amount, asset, network, and merchant
  address.
- Whether merchant settlement occurred.
- Receipt/status evidence and public explorer links.
- Before/after Haven wallet and delegate balances and remaining live delegation
  budget when relevant; legacy Safe authority and AllowanceModule reads are n/a.

UI transaction-detail verification is a separate check. The Playwright
transaction-detail spec uses mocked API data and does not prove a live payment
settled.

## Friction, Bugs, And Infrastructure Failures

Keep product findings separate from test-infrastructure failures such as an
empty relayer or unavailable preview.

| Severity | Type | Step/scenario | Expected | Actual | Reproducibility | Mode/environment | Evidence | Issue | Disposition |
|---|---|---|---|---|---|---|---|---|---|
| | product / test infrastructure / environment | | | | always/intermittent/once | | | | new/known/fixed-retest |

## Cleanup And Residual State

Mark cleanup items `n/a` when the run mode created no live state.

- [ ] Stranded delegate funds were swept or explicitly recorded with owner and
  follow-up.
- [ ] Post-run Haven wallet/delegate balances and remaining live delegation
      budget were captured; legacy Safe authority is marked n/a.
- [ ] Seed/reset requirements for the next run were recorded.
- [ ] Secret review passed; no secrets remain in committed text or artifacts.

A failed secret review blocks committing the report or artifacts.

## Notes For The Coding Agent

<!-- Concrete suggestions or open questions to feed back for improvement. -->
