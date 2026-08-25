# @haven_ai/qa-agent

Internal QA harness for the Haven **dev environment** (epic #573). Not published.

This is the shared home for the automated QA layers that exercise the *deployed*
dev stack (which the mocked Playwright suite structurally can't):

- **#574** — dev seeding (a QA identity: user + Hybrid account + agent +
  budget delegation).
- **#575** — the deterministic, no-LLM money-flow harness (the deploy-confidence
  core): drives the real SDK/API payment path on **Base Sepolia** against the
  shared dev backend + the dev demo-merchant, asserting the #420 invariants.

## Status

Implemented: the shared **config contract** (`src/config.ts`), the **dev seed**
(`src/seed.ts`, #574 item 1), and the **money-flow harness** (`src/run.ts`, #575)
with the scenarios registered in `SCENARIOS` — three legacy-rail legs plus the
delegation-rail suite. `run.ts` is the source of truth for the list and its
order; the canonical per-scenario table lives in
[`docs/operations/agent-qa.md`](../../docs/operations/agent-qa.md).

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

Scenarios (`src/scenarios/`) — the **legacy-rail** legs, the only ones that still
run the legacy AllowanceModule identity. That identity is **no longer seeded**
(see the Config contract below); these legs consume a credential that predates
the Safe rail's retirement:

| Scenario | #420 invariant | Status |
|---|---|---|
| `within-budget-settle` | A payment inside the allowance settles on-chain + is logged | live |
| `over-budget-queue` | A payment over the allowance is queued (`pending_approval`), never auto-executed | live |
| `x402-over-budget-rejected` | A priced x402 call above the allowance is rejected (`insufficient_funds`), never a signable intent | live |

**x402 settlement is covered on the delegation rail only.** The legacy
`x402-settle` and `x402-sweep-recovery` legs were removed by owner decision —
the delegation rail is the base for every new account, and the legacy rail is
import-only for existing dev-pilot Safes.

This is an **accepted coverage loss, not a deduplication.**
`x402-delegation-3009` / `x402-delegation-3009-sweep` assert the same
merchant-facing invariants but execute different code — `modules/x402/authorize.ts`
dispatches on the rail — so the legacy x402 *execute* branch
(`recordX402Signature` → `executeAllowanceTransfer` → `confirmX402Intent`) now
has no live coverage, only mocked unit tests. Neither kept legacy leg closes
that gap: `within-budget-settle` drives `/payments`, and
`x402-over-budget-rejected` sends no signature so never enters the branch.
Revisit if dev-pilot legacy Safes start carrying real x402 volume.

The three legs above stay because their invariants have no delegation-rail
counterpart (that rail has no approval queue at all — over-budget reverts
on-chain).

The delegation-rail legs are the majority of the suite and are documented, with
their env requirements and skip conditions, in the canonical table in
[`docs/operations/agent-qa.md`](../../docs/operations/agent-qa.md).

> **Infra dependency:** `within-budget-settle` moves real testnet USDC, so the
> dev **relayer** (`RELAYER_PRIVATE_KEY`) must hold Base Sepolia **ETH** for gas —
> it submits the AllowanceModule transfer. A gas-empty relayer surfaces as
> `execution failed: insufficient funds …` (the harness reports the on-chain
> reason, not just a 502). Note the relayer's nonce lane is a known dev
> infrastructure defect (#1533) — a `NONCE_EXPIRED` failure on this leg is that,
> not a money-path regression.

For a clean local checkout, build the workspace SDK before the harness:

```bash
npm ci
npm run build -w packages/sdk
npm run qa:dev -w packages/qa-agent
```

The GitHub workflow performs the SDK build automatically.

## Seed — provision the QA identity (#574)

`npm run seed -w packages/qa-agent` idempotently creates, on **Base Sepolia**: a
QA user → a **Hybrid DeleGator** account (`POST /accounts/hybrid`, counterfactual
and zero transactions) → a `QA Agent` → an owner-signed **budget delegation**. It
then prints the `QA_*` block to set as secrets.

**It seeds no Safe (#2007, epic #1440).** `POST /user/safes` has answered HTTP
410 since #1984 and an `allowance_module` account cannot pay since #1986, so the
seed provisions the delegation rail — the one every new account onboards on. The
dead call had gone unnoticed because it sat behind a reuse branch only a
**fresh** QA account reaches. `packages/backend/src/openapi/qa-seed-routes.test.ts`
now fails if the seed calls a route the API has retired or no longer registers.

Env (all **testnet/dev-only**; the seed never holds the delegate key — pass only
its **address**):

| Env | Meaning |
|---|---|
| `SEED_HAVEN_API_URL` | Dev backend (e.g. `https://havenbackend-dev-8b95.up.railway.app`) |
| `SEED_OWNER_PRIVATE_KEY` | Hybrid account owner EOA — signs the budget delegation off-chain; **needs no ETH** |
| `SEED_DELEGATE_ADDRESS` | The delegate's **address** (not its key) |
| `SEED_PAYMENT_TO` | Recipient for QA payments (→ `QA_PAYMENT_TO`) |
| `SEED_QA_EMAIL` / `SEED_QA_PASSWORD` | QA user credentials |
| `SEED_ALLOWANCE_USDC` | Budget-delegation period budget in USDC (default `5`) |
| `SEED_RESET_MIN` | Budget period length in minutes (default `1440`) |

Both budget names are AllowanceModule-era spellings kept so an existing operator
env keeps working. `SEED_RPC_URL` is no longer read: the seed sends nothing
on-chain and opens no RPC connection.

After it runs, fund the printed **account** address with Base Sepolia test USDC
([Circle faucet](https://faucet.circle.com)).

## Config contract

The harness loads its config from `loadQaConfig()`, the single source of truth
for the `QA_*` env (all **testnet/dev-only**). The seed reads the separate
`SEED_*` env above:

| Env | Meaning |
|---|---|
| `QA_HAVEN_API_URL` | Shared dev backend, hit **directly** (Node→API, no CORS) |
| `QA_AGENT_API_KEY` | Legacy AllowanceModule agent identity (`sk_agent_*`) — **the seed no longer produces one**, see below |
| `QA_DELEGATE_PRIVATE_KEY` | That agent's delegate EOA key — signs locally, testnet-only |
| `QA_PAYMENT_TO` | Recipient for direct-send scenarios |
| `QA_DEMO_MERCHANT_URL` | Dev demo-merchant base URL; required for every merchant round-trip leg |

`loadQaConfig()` fails fast with a clear error listing every missing var.

⚠️ **`QA_AGENT_API_KEY` / `QA_DELEGATE_PRIVATE_KEY` can no longer be obtained.**
They name a legacy AllowanceModule identity, and that rail is retired: no new
Safe can be created (#1984) and an existing one cannot pay (#1986). They are
still *required* by `loadQaConfig()`, and three legs — `within-budget-settle`,
`over-budget-queue`, `x402-over-budget-rejected` — still run against them.
Retiring the two vars and those three legs is tracked separately; every other
leg runs on `QA_DELEGATION_*`, which the seed does produce.

Keep these values in an external dotenv file, source it before a local run, and
store the same five names as encrypted repository secrets for
`.github/workflows/qa-dev.yml`. Never commit the values.

## Scripts

```bash
npm run typecheck -w packages/qa-agent
npm run test -w packages/qa-agent
npm run build -w packages/qa-agent
```
