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
with the scenarios registered in `SCENARIOS` — three direct money-path legs plus the
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

Scenarios (`src/scenarios/`) — the three direct money-path legs. All three ran
the legacy AllowanceModule identity until #2016 and were **re-based onto the
delegation rail**: since #1986 that account answers HTTP 410 from `POST
/payments` and the x402 path, so two of them were guaranteed red and the third
was passing on the retirement's refusal instead of on the budget check it
exists to prove. The invariants outlived the rail; only the instruments changed.

| Scenario | #420 invariant | Instrument on the delegation rail |
|---|---|---|
| `within-budget-settle` | A payment inside the budget settles on-chain + is logged | `POST /payments` → sign the `eip712_userop` typed data → poll to `confirmed`. Also the suite's **positive control**: the leg that proves the money path can still say YES |
| `over-budget-refused` | A payment over the budget is refused before it becomes signable, never auto-executed | The ERC20PeriodTransferEnforcer reverts during gas estimation → HTTP 502, **no intent row**. Renamed from `over-budget-queue`: the approval QUEUE it asserted does not exist on this rail and no longer exists anywhere |
| `x402-over-budget-rejected` | A priced x402 call above the budget is refused, never a signable intent | The same enforcer, on the **EIP-3009 funding leg** of `POST /x402/authorize` |
| `x402-erc7710-over-budget-rejected` | The same invariant on the **preferred** scheme (#2082) | A fail-fast remaining-budget pre-check in `POST /x402/authorize`'s erc7710 branch → HTTP 403 `delegation_budget_exceeded`, **no settlement child, no intent row, no delegate deploy**. The on-chain enforcer is still the gate; the pre-check only makes the refusal arrive at authorize instead of at merchant redemption |

**A 502 is not proof, and these legs do not treat it as proof.** A bundler
outage, an RPC failure and a policy refusal all produce the same status, so the
two over-budget legs additionally (1) derive their amount from a **live**
enforcer read and refuse to run on a fallback number or an exhausted budget,
(2) require a within-budget request against the same account to still be
offered, and (3) decode the ABI-encoded revert reason and require it to **name
a caveat enforcer** (`lib/revert-reason.ts`). Asserting only the status is the
defect #2016 was filed about.

**The erc7710 gap is closed at authorize, and only at authorize (#2082).**
Until then, `POST /x402/authorize` returned 201 with a signable child
delegation for any amount on erc7710 — so "never turned into a signable intent"
was false on the preferred scheme (verified live 2026-08-25, recorded on #1993
rather than asserted around). The pre-check made the case exist to prove, and
`x402-erc7710-over-budget-rejected` proves it. Its own vacuous-pass guards are
the ones the shape needs: a 403 is ALSO what a missing delegation returns, so
the leg requires `error_code: delegation_budget_exceeded` and requires the
`remaining_atomic` in the refusal to match the budget it derived the request
from.

⚠️ **Still uncovered: the redemption-side revert.** Neither over-budget leg
proves the CHAIN refuses an over-budget redemption — that needs a merchant that
actually attempts one, and none of these legs do. The caveat stack was always
the gate and #2082 did not touch it; what the new leg asserts is WHEN Haven
says no, not whether the chain would have.

**x402 settlement is covered on the delegation rail only.** The legacy
`x402-settle` and `x402-sweep-recovery` legs were removed by owner decision
(#1535). With the legacy rail retired outright (epic #1440) and
`legacy-authorize.ts` deleted (#1987), the execute branch that removal left
uncovered no longer exists — the note is history, not outstanding debt.

The delegation-rail legs are the majority of the suite and are documented, with
their env requirements and skip conditions, in the canonical table in
[`docs/operations/agent-qa.md`](../../docs/operations/agent-qa.md).

> **Infra dependency:** `within-budget-settle` moves real testnet USDC. On the
> delegation rail the redemption is a **sponsored UserOp**, so the dependency is
> the bundler/paymaster (`DELEGATION_RAIL_*`), not the relayer's gas balance —
> a sponsorship or bundler failure surfaces as `execution failed: …` with the
> on-chain reason, not just a 502.

For a clean local checkout, build the workspace SDK before the harness:

```bash
npm ci
npm run build -w packages/sdk
npm run qa:dev -w packages/qa-agent
```

The GitHub workflow performs the SDK build automatically.

## Seed — provision the QA identity (#574)

`npm run seed -w packages/qa-agent` idempotently provisions, on **Base Sepolia**:
a QA user → a **Hybrid DeleGator** account (`POST /accounts/hybrid`,
counterfactual and zero transactions) → a `QA Agent` → an owner-signed **budget
delegation**. It reuses only an active or `pending_approval` agent with the
configured delegate address. If that address belongs to a paused, revoked, or
unknown-status agent, it stops before creating or reusing an agent or granting a
budget delegation; rotate `SEED_DELEGATE_ADDRESS` or deliberately restore the
named agent before retrying. It then prints the `QA_*` block to set as secrets.

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
| `QA_PAYMENT_TO` | Recipient for direct-send scenarios |
| `QA_DEMO_MERCHANT_URL` | Dev demo-merchant base URL; required for every merchant round-trip leg |

`loadQaConfig()` fails fast with a clear error listing every missing var.

`QA_AGENT_API_KEY` and `QA_DELEGATE_PRIVATE_KEY` belonged to the retired
AllowanceModule rail and are intentionally not part of the harness. The seed
prints the `QA_DELEGATION_*` identity used by every payment scenario, so a
freshly seeded dev database can run `qa:dev` without legacy credentials.

Keep these values in an external dotenv file, source it before a local run, and
store the required names as encrypted repository secrets for
`.github/workflows/qa-dev.yml`. Never commit the values.

## Scripts

```bash
npm run typecheck -w packages/qa-agent
npm run test -w packages/qa-agent
npm run build -w packages/qa-agent
```
