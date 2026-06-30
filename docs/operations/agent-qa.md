---
owner: "@d-hinders"
status: current
covers:
  - .env.dev.example
  - .github/workflows/qa-dev.yml
  - .github/workflows/qa-live.yml
  - .claude/commands/qa-dev.md
  - packages/qa-agent/**
  - packages/frontend/package.json
  - packages/frontend/e2e/live/**
  - packages/frontend/e2e/fixtures/live-session.ts
  - packages/frontend/playwright.live.config.ts
  - packages/frontend/src/lib/api.ts
  - packages/sdk/src/sweep.ts
  - packages/backend/src/lib/sweep.ts
  - packages/backend/src/config.ts
  - packages/backend/src/routes/machine-payments.ts
  - docs/bug-reports/_run-report-template.md
last-verified: "2026-07-01"
---

# Agent QA — run the automated QA layers against dev

This is the canonical operator runbook for Haven's automated QA against the
shared **dev environment**. It covers initial provisioning, local runs, GitHub
Actions runs, funding, expected results, and troubleshooting.

All money-flow QA uses **Base Sepolia (`84532`) and test USDC only**. Never use
production credentials, a mainnet RPC, or real funds.

## Which path should I use?

| Operation | Local terminal | GitHub Actions | When to use it |
|---|---:|---:|---|
| Seed the QA user, Safe, allowance, and agent | Yes | No | First-time setup or identity replacement |
| Deterministic money-flow QA (`qa-dev.yml`) | Yes | Yes | Local debugging or shared repeatable evidence |
| Live deployed-UI smoke (`qa-live.yml`) | Yes | Yes | Verify a Vercel preview against the dev backend |
| Exploratory agent/merchant QA | Yes | No | Coverage that needs human or LLM judgment |

Use **GitHub Actions** for the normal shared money-flow run after the identity,
funding, and repository secrets exist. Use a **local run** to provision the
identity, debug failures, or validate changes before pushing them.

Neither workflow is scheduled or a merge gate today; both are manually
dispatched with `workflow_dispatch`.

## Stable dev targets

| Surface | Target |
|---|---|
| Backend | `https://havenbackend-dev-8b95.up.railway.app` |
| Demo merchant | `https://demo-merchant-dev-84e4.up.railway.app` |
| Chain | Base Sepolia (`84532`) |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Frontend | The current Vercel preview URL; there is no permanent dev frontend URL |

The seed and money-flow harness are Node processes that call the backend
directly. They do not depend on browser CORS. The live UI smoke drives a real
browser and uses the guarded `?apiBaseUrl`/local-storage override described
under [Live deployed-UI smoke](#live-deployed-ui-smoke).

## One-time setup

### 1. Prepare a clean `dev` checkout

The repository requires Node 24:

```bash
git fetch origin
git switch dev
git pull --ff-only
node --version
npm ci
npm run build -w packages/sdk
```

The SDK build is required because `packages/qa-agent` imports the workspace SDK
through `packages/sdk/dist/index.js`. The GitHub workflow performs this build
automatically.

If another branch has unresolved conflicts, do not reset it just to run QA.
Create a clean worktree from `origin/dev` instead:

```bash
git worktree add --detach .worktrees/qa-dev origin/dev
cd .worktrees/qa-dev
npm ci
npm run build -w packages/sdk
```

### 2. Create the seed environment file

Keep credential files outside the repository. Example
`/secure/path/qa-seed.env`:

```bash
SEED_HAVEN_API_URL=https://havenbackend-dev-8b95.up.railway.app
SEED_RPC_URL=https://sepolia.base.org
SEED_OWNER_PRIVATE_KEY=<throwaway Base Sepolia owner key>
SEED_DELEGATE_ADDRESS=<address derived from the QA delegate key>
SEED_PAYMENT_TO=<Base Sepolia recipient address>
SEED_QA_EMAIL=<dedicated dev QA user email>
SEED_QA_PASSWORD=<dedicated dev QA user password>
SEED_ALLOWANCE_USDC=5
SEED_RESET_MIN=1440
```

The seed accepts the delegate **address**, not its private key. Haven must never
receive or store the owner or delegate private key.

### 3. Fund the required testnet accounts

| Account | Funding | Why |
|---|---|---|
| Owner EOA | Base Sepolia ETH | Submits the Safe deployment and owner-approved allowance setup |
| Safe | Base Sepolia test USDC | Source of the QA agent allowance and payments |
| Dev relayer | Base Sepolia ETH | Submits Allowance Module transfers and gasless sweep recovery |
| Delegate EOA | No on-chain funding required | Signs payment and EIP-3009 sweep authorizations off-chain |

Ordinary payments and sweep recovery do not require delegate gas. The delegate
signs off-chain; the relayer submits both constrained Safe transfers and the
gasless EIP-3009 USDC sweep. Keep the dev relayer funded with Base Sepolia ETH.

The demo merchant must also be configured with:

```text
MERCHANT_CHAIN_ID=84532
MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb
```

The second setting creates the deterministic stranded-balance condition used by
the sweep-recovery scenario.

### 4. Run the seed locally

```bash
set -a
source "/secure/path/qa-seed.env"
set +a
npm run seed -w packages/qa-agent
```

The seed is idempotent:

1. Create or log in to the QA user.
2. Deploy or reuse the Base Sepolia Safe.
3. Enable the Allowance Module and configure the delegate allowance.
4. Create or reuse the QA agent.

It prints the Safe address and the `QA_*` block for the harness. Fund the Safe
with Base Sepolia test USDC after its first deployment.

An API key is shown only when a new agent is created. If the agent already
exists and its key was lost or exposed, rotate it instead of creating duplicate
QA identities.

## Money-flow QA

The deterministic harness runs five scenarios in order:

| Scenario | Expected result |
|---|---|
| `within-budget-settle` | A 0.1 USDC payment settles on-chain and has a receipt |
| `over-budget-queue` | An over-budget payment queues for approval and does not execute |
| `x402-over-budget-rejected` | An unaffordable x402 request is rejected before a signable intent |
| `x402-settle` | A small x402 payment settles through the dev demo merchant |
| `x402-sweep-recovery` | Verify-without-settle strands a small, under-cap USDC balance, then a gasless sweep returns it to the Safe |

The harness exits non-zero if any non-skipped scenario fails. Its Markdown
scenario table is an evidence starter, not a complete report: copy it into
[`_run-report-template.md`](../bug-reports/_run-report-template.md) and add run
metadata, exact command and exit code, preflight, artifacts, public evidence,
cleanup, and secret review.

See epic #573. Build order: **#574 (foundation) → #575 (deterministic money-flow,
Node→API) → #576 (live UI smoke, browser) →** then the non-gating exploratory
layers (#577 LLM-agent, #579 browser exploration), with automation/gating last
(#578). Deterministic layers (#575/#576) are repeatable promotion signals; the LLM layers
are non-gating coverage that file run reports under
[`bug-reports/`](../bug-reports/).

### Required harness environment

Keep `/secure/path/qa-run.env` outside the repository:

```bash
QA_HAVEN_API_URL=https://havenbackend-dev-8b95.up.railway.app
QA_AGENT_API_KEY=<testnet QA agent API key>
QA_DELEGATE_PRIVATE_KEY=<throwaway Base Sepolia delegate key>
QA_PAYMENT_TO=<Base Sepolia recipient address>
QA_DEMO_MERCHANT_URL=https://demo-merchant-dev-84e4.up.railway.app
```

`QA_DEMO_MERCHANT_URL` is technically optional in the config loader, but it is
required to exercise all five scenarios. A leading `#` comments out a variable;
do not write `# QA_AGENT_API_KEY=...`.

### Run locally

```bash
set -a
source "/secure/path/qa-run.env"
set +a
npm run qa:dev -w packages/qa-agent
```

Environment files are not loaded automatically. Source the file again after
editing it or after opening a new terminal.

### Configure GitHub Actions

The repository needs these encrypted Actions secrets:

- `QA_HAVEN_API_URL`
- `QA_AGENT_API_KEY`
- `QA_DELEGATE_PRIVATE_KEY`
- `QA_PAYMENT_TO`
- `QA_DEMO_MERCHANT_URL`

If the dotenv file contains exactly those five entries, upload them with:

```bash
gh secret set -f "/secure/path/qa-run.env" --repo d-hinders/Haven-AI
gh secret list --repo d-hinders/Haven-AI
```

The delegate key authorizes testnet payments and sweeps. Only upload a
throwaway, allowance-capped Base Sepolia key. Anyone able to modify and run a
workflow with access to repository secrets may be able to use that key in the
runner. Rotate exposed credentials and never reuse them outside QA.

### Run from GitHub

CLI:

```bash
gh workflow run qa-dev.yml \
  --repo d-hinders/Haven-AI \
  --ref dev

gh run list \
  --repo d-hinders/Haven-AI \
  --workflow qa-dev.yml \
  --limit 1
```

Inspect a run:

```bash
gh run view <run-id>
gh run view <run-id> --log-failed
```

GitHub UI:

1. Open **Actions**.
2. Select **QA — money-flow (dev)**.
3. Choose **Run workflow**.
4. Select the `dev` branch and run it.

Secrets should appear as `***` in logs. The workflow checks out `dev`, installs
dependencies, builds the SDK, and executes the same harness as the local
command.

## Live deployed-UI smoke

The live smoke is read-only. It logs the seeded QA user into the dev backend and
checks that a deployed frontend can load real dashboard data.

Required Actions secrets:

- `QA_HAVEN_API_URL`
- `QA_USER_EMAIL`
- `QA_USER_PASSWORD`

Run it against the current non-production Vercel preview:

```bash
gh workflow run qa-live.yml \
  --repo d-hinders/Haven-AI \
  --ref dev \
  -f base_url=https://<current-preview>.vercel.app
```

The preview must set `NEXT_PUBLIC_HAVEN_ENV=dev`; production builds intentionally
ignore the backend override.

For a local invocation:

```bash
npx playwright install chromium
export PLAYWRIGHT_BASE_URL=https://<current-preview>.vercel.app
export QA_HAVEN_API_URL=https://havenbackend-dev-8b95.up.railway.app
export QA_USER_EMAIL=<dedicated dev QA user email>
export QA_USER_PASSWORD=<dedicated dev QA user password>
npm run test:e2e:live -w packages/frontend
```

GitHub uploads the Playwright report, screenshots, video, and trace as a
seven-day artifact when the run completes.

## Layer 2b — exploratory agent QA (`/qa-dev`, #577)

An LLM agent drives **natural-language payment goals** through the **real Haven
MCP** with the dev QA credentials, using the agent session's own model (no
`ANTHROPIC_API_KEY` in CI), and files a run report under
[`bug-reports/`](../bug-reports/). It exercises the live tool surface + runtime
wiring the deterministic harness (2a) can't. Because the tester is an LLM, it is
**never a deploy gate** — #575/#576 are repeatable checks, while 2b is
exploratory.

- **When to run:** before a promotion, or after a risky change to the payment / MCP surface.
- **How findings feed back:** the report's *Friction* and *Notes for the coding agent* sections (and any issues it files) are the loop #419/#420 call for.
- **Claude Code:** run `/qa-dev` ([`.claude/commands/qa-dev.md`](../../.claude/commands/qa-dev.md)).

**Codex / generic runtime (pasteable prompt):**

> You are running exploratory QA against Haven's **dev** environment (testnet / Base
> Sepolia, capped QA delegate — never prod). Using the already-connected Haven MCP
> (or connect with `npx @haven_ai/connect@alpha --setup <QA setup token> --api <dev backend URL>`):
> 1. `haven_get_agent` + `haven_get_allowances` — confirm the dev QA agent and note the live remaining budget.
> 2. Pay the demo-merchant x402 call **within** budget (`haven_pay_x402`) → expect settlement + a receipt.
> 3. Use direct `haven_pay` for an amount **over** the remaining budget → expect
> it to queue for approval, not execute.
> 4. Make a priced call **above the max price** → expect a `PRICE_EXCEEDS_MAX` rejection.
> 5. `haven_list_receipts`, then `haven_verify_receipt` on the step-2 payment → expect it verifies.
> Stop at the first failed step. Then write a run report from
> `docs/bug-reports/_run-report-template.md` (per-goal pass/fail + friction) and file
> concrete bugs as issues. This is non-gating exploratory coverage.

## Reading results and filing bugs

- `PASS`: the asserted invariant held.
- `SKIP`: a prerequisite was absent. For sweep recovery, this commonly
  means the merchant did not leave a stranded balance; confirm
  `MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb`.
- `FAIL`: the invariant was exercised and failed.
- Process exit `1`: at least one scenario failed; this is expected behavior for
  a red gate, not a workflow configuration failure.
- Process exit `2`: required `QA_*` configuration is missing.

A required skipped scenario makes the overall report partial/blocked even
though the harness can exit zero. Copy the generated table into the full report
template and file a GitHub issue for a reproducible failure. Include the Actions
run URL and transaction/payment identifiers, but never API or private keys.

## Troubleshooting

### `ERR_MODULE_NOT_FOUND ... @haven_ai/sdk/dist/index.js`

Build the workspace SDK:

```bash
npm run build -w packages/sdk
```

### `Missing required QA env`

The dotenv file was not sourced, a variable is commented out, or the shell was
restarted. Source it and verify names without printing values:

```bash
for name in QA_HAVEN_API_URL QA_AGENT_API_KEY QA_DELEGATE_PRIVATE_KEY QA_PAYMENT_TO QA_DEMO_MERCHANT_URL; do
  printenv "$name" >/dev/null && echo "$name: present" || echo "$name: MISSING"
done
```

### Seed returns `could not decode result data`

The public Base Sepolia RPC can briefly return stale state immediately after a
Safe deployment. The seed is idempotent; retry it. If this repeats, set
`SEED_RPC_URL` to a dedicated Base Sepolia provider.

### `On-chain execution failed` or `insufficient funds`

Check balances by role:

1. Safe: enough test USDC and remaining allowance.
2. Dev relayer: enough Base Sepolia ETH for allowance transfers.
3. Owner: enough Base Sepolia ETH only when reseeding or changing the allowance.

Do not repeatedly rerun a money-moving harness while the cause is unknown; each
run consumes test allowance and test USDC.

### Sweep is skipped after 20 seconds

The merchant did not produce a visible stranded balance. Confirm its Base
Sepolia deployment and `MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb`, then check
for RPC propagation delay.

### Sweep is parked for manual recovery

The backend does not create a sweep authorization when the stranded USDC
balance exceeds `SWEEP_MAX_USDC` (default `1`). Record the returned
`parked: true`, balance, and cap in the run report; stop automated recovery and
assign explicit manual follow-up. Do not raise the cap during a QA run merely
to make the scenario pass.

### GitHub warning about actions using Node 20

This runner warning is not a harness failure. The repository uses Node 24 for
project commands; update third-party action versions separately when supported.

## Related documentation

- [`packages/qa-agent/README.md`](../../packages/qa-agent/README.md) — package and scenario details
- [`e2e-qa-runbook.md`](./e2e-qa-runbook.md) — manual agent/merchant coverage
- [`dev-environment.md`](./dev-environment.md) — shared dev topology
- [`promoting-dev-to-main.md`](./promoting-dev-to-main.md) — promotion checks
