# @haven_ai/qa-agent

Internal QA harness for the Haven **dev environment** (epic #573). Not published.

This is the shared home for the automated QA layers that exercise the *deployed*
dev stack (which the mocked Playwright suite structurally can't):

- **#574** — dev seeding (a QA identity: user + Safe + agent + on-chain allowance).
- **#575** — the deterministic, no-LLM money-flow harness (the deploy-confidence
  core): drives the real SDK/API payment path on **Base Sepolia** against the
  shared dev backend + the dev demo-merchant, asserting the #420 invariants.

## Status

Implemented: the shared **config contract** (`src/config.ts`), the **dev seed**
(`src/seed.ts`, #574 item 1), and the **money-flow harness** (`src/run.ts`, #575)
with all five scenarios registered: within-budget settle, over-budget queue,
x402 over-budget rejection, x402 settle, and delegate sweep recovery. The sweep
scenario waits for the stranded balance to become visible and reports whether
the merchant precondition was missing or recovery actually failed (#684).

⚠️ The seed's **on-chain steps are not exercised in CI** (no funded testnet
wallets there). Run it locally against funded Base Sepolia accounts. The
money-flow harness itself runs both locally and through the manual GitHub Actions
workflow. See the canonical operator runbook:
[`docs/operations/agent-qa.md`](../../docs/operations/agent-qa.md).

## Money-flow harness — `qa:dev` (#575)

`npm run qa:dev -w packages/qa-agent` drives the real Haven payment path on **Base
Sepolia** against the shared dev backend using the seeded QA identity, asserts the
#420 invariants (no LLM, fixed inputs), prints a per-scenario pass/fail + a run
report, and **exits non-zero on any failure**. It reads the `QA_*` env (see
[the config table below](#config-contract)). A manual `workflow_dispatch` job
([`.github/workflows/qa-dev.yml`](../../.github/workflows/qa-dev.yml)) runs it in
CI from the `QA_*` Actions secrets.

Scenarios (`src/scenarios/`):

| Scenario | #420 invariant | Status |
|---|---|---|
| `within-budget-settle` | A payment inside the allowance settles on-chain + is logged | live |
| `over-budget-queue` | A payment over the allowance is queued (`pending_approval`), never auto-executed | live |
| `x402-over-budget-rejected` | A priced x402 call above the allowance is rejected (`insufficient_funds`), never a signable intent | live |
| `x402-settle` | A within-budget x402 call settles end-to-end via the demo-merchant round-trip (fund delegate → EIP-3009 → settle) | live |
| `x402-sweep-recovery` | A verify-without-settle balance is reclaimed from the delegate to the Safe | live; requires merchant skip-settle config + delegate gas |

> **Infra dependency:** `within-budget-settle` moves real testnet USDC, so the
> dev **relayer** (`RELAYER_PRIVATE_KEY`) must hold Base Sepolia **ETH** for gas —
> it submits the AllowanceModule transfer. A gas-empty relayer surfaces as
> `execution failed: insufficient funds …` (the harness reports the on-chain
> reason, not just a 502). The direct-transfer sweep also requires the delegate
> EOA to hold a small amount of Base Sepolia ETH.

For a clean local checkout, build the workspace SDK before the harness:

```bash
npm ci
npm run build -w packages/sdk
npm run qa:dev -w packages/qa-agent
```

The GitHub workflow performs the SDK build automatically.

## Seed — provision the QA identity (#574)

`npm run seed -w packages/qa-agent` idempotently creates, on **Base Sepolia**: a
QA user → an EOA-owned Safe → the on-chain spend gate (enable AllowanceModule +
addDelegate + setAllowance, submitted by the owner EOA) → a `QA Agent`. It then
prints the `QA_*` block to set as secrets.

Env (all **testnet/dev-only**; the seed never holds the delegate key — pass only
its **address**):

| Env | Meaning |
|---|---|
| `SEED_HAVEN_API_URL` | Dev backend (e.g. `https://havenbackend-dev-8b95.up.railway.app`) |
| `SEED_OWNER_PRIVATE_KEY` | QA Safe owner EOA — signs and submits the Safe deploy + allowance setup; needs Base Sepolia ETH |
| `SEED_DELEGATE_ADDRESS` | The delegate's **address** (not its key) |
| `SEED_PAYMENT_TO` | Recipient for QA payments (→ `QA_PAYMENT_TO`) |
| `SEED_QA_EMAIL` / `SEED_QA_PASSWORD` | QA user credentials |
| `SEED_ALLOWANCE_USDC` | USDC allowance (default `5`) |
| `SEED_RESET_MIN` | Allowance reset window in minutes (default `1440`) |
| `SEED_RPC_URL` | Base Sepolia RPC (default `https://sepolia.base.org`) |

After it runs, fund the printed **Safe** address with Base Sepolia test USDC
([Circle faucet](https://faucet.circle.com)).

## Config contract

Both the seed step and the harness load their config from `loadQaConfig()`, the
single source of truth for the `QA_*` env (all **testnet/dev-only**):

| Env | Meaning |
|---|---|
| `QA_HAVEN_API_URL` | Shared dev backend, hit **directly** (Node→API, no CORS) |
| `QA_AGENT_API_KEY` | QA agent identity (`sk_agent_*`) |
| `QA_DELEGATE_PRIVATE_KEY` | QA delegate EOA key — signs locally, testnet-only |
| `QA_PAYMENT_TO` | Recipient for direct-send scenarios |
| `QA_DEMO_MERCHANT_URL` | Dev demo-merchant base URL; required for the full five-scenario run |

`loadQaConfig()` fails fast with a clear error listing every missing var.

Keep these values in an external dotenv file, source it before a local run, and
store the same five names as encrypted repository secrets for
`.github/workflows/qa-dev.yml`. Never commit the values.

## Scripts

```bash
npm run typecheck -w packages/qa-agent
npm run test -w packages/qa-agent
npm run build -w packages/qa-agent
```
