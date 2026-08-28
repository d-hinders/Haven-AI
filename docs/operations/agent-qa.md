---
owner: "@d-hinders"
status: current
covers:
  - .env.dev.example
  - .github/workflows/qa-dev.yml
  - .github/workflows/qa-live.yml
  - .github/workflows/dev-gate.yml
  - .claude/commands/qa-dev.md
  - .claude/commands/qa-explore-ui.md
  - packages/qa-agent/**
  - packages/frontend/package.json
  - packages/frontend/e2e/live/**
  - packages/frontend/e2e/fixtures/live-session.ts
  - packages/frontend/playwright.live.config.ts
  - packages/frontend/src/lib/api.ts
  - packages/sdk/src/sweep.ts
  - packages/backend/src/rails/sweep.ts
  - packages/backend/src/config.ts
  - packages/backend/src/routes/machine-payments.ts
  - docs/bug-reports/_run-report-template.md
  - packages/mcp-server/src/x402-expected-wire-contract.test.ts
last-verified: "2026-08-28" # #2140: FIVE stale sites, and the first two are the half #2103 missed. #2103 corrected the two Claude Code prompt copies (`.claude/commands/qa-dev.md`, `qa-explore-ui.md`) and the run-report template; this file carries a duplicate of each prompt for Codex/generic runtimes and neither was updated, so the same instruction was right in one place and wrong in another. (1) Layer 2b step 3 told a LIVE QA agent to expect an over-budget payment to "queue for approval" — a rail that cannot queue, so an agent following it recorded the CORRECT decline as a failure: the #1992 lesson inverted and automated. Rewritten to be ASSERTED on (no settlement, nothing queued, nothing silently spent) and to say the refusal IS the pass. (2) Layer 3 named **approvals** as a surface to explore, in both the brief bullet and the prompt — deleted by #1989, `/approvals` does not route, and #2103 records a run already navigating to the 404 (its own brief hunts "dead ends", so it reports the correct state as a finding). Repointed at the agent detail page and its budget card, matching #2103's wording and observe-only principle. (3)+(4) found by haven-reviewer on THIS pass, in the troubleshooting/funding prose rather than the prompts: the funding prerequisites said the dev relayer "submits the legacy allowance transfers" — `executeAllowanceTransfer` was deleted by #1987 and survives in production only as a decode ABI in `infra/chain/allowance-transfer-verifier.ts`, so the relayer cannot do it; and the same list hedged "for the surviving legacy legs, the Safe" when no scenario drives a legacy identity (#2011 removed the credentials, verified against `packages/qa-agent/src/scenarios/`). (5) the sentence under the funding table said the relayer "submits both constrained Safe transfers and the gasless EIP-3009 USDC sweep" — the table directly above it has no Safe row at all since #2007. Note the recurring shape: this file already documented the deterministic sibling correctly at the `over-budget-refused` scenario row (renamed from `over-budget-queue` by #2016), so several regions of one file disagreed. Scope: the Layer 2b prompt step, the Layer 3 brief bullet and prompt, the sentence under the funding table, and the two troubleshooting funding prerequisites. NOT re-verified: the scenario table itself, the env/credential/secrets tables, the funding table rows, the workflow and gating sections, Layer 1/2a prose, and the dated incident reports. No `/qa-dev` or `/qa-explore-ui` result changes — the harness asserts on `packages/qa-agent/` scenarios, never on this prose. Prior: #2011: the QA harness no longer reads the retired AllowanceModule `QA_AGENT_API_KEY` / `QA_DELEGATE_PRIVATE_KEY` credentials. The config, preflight, seed output, workflow, required-env table, local and Actions examples, and missing-env troubleshooting loop were re-read: every live scenario uses the delegation-rail identity, so a fresh seed produces a complete `qa:dev` environment. Prior: #2012: the QA seed now refuses a same-delegate agent unless its status is active or pending_approval; it names the agent and gives the rotate-or-deliberately-restore remedy, so re-seeding cannot silently restore disabled authority. Re-read the seed, the local-run steps, and the package README. Prior: #2007: the seed is re-based on the DELEGATION RAIL — it no longer deploys a Safe or calls `POST /user/safes` (410 since #1984; an `allowance_module` account also cannot pay since #1986), and instead provisions a Hybrid DeleGator via `POST /accounts/hybrid` plus an owner-signed budget delegation. Re-verified and corrected in this pass: the seed env block (`SEED_RPC_URL` removed — the seed opens no RPC connection), the funding table (owner EOA needs no ETH; "Safe" row becomes the Hybrid account), the "Run the seed locally" step list, the `could not decode result data` troubleshooting entry (replaced by a `410` entry), the operations table's seed row, the "Seeding the delegation-rail identity" section (the seed now produces `QA_DELEGATION_*` itself, so its manual steps are re-framed as a description plus a by-hand recipe), and the `insufficient funds` balance-by-role list (owner ETH no longer required). Prior: #1882: front-matter only — the `last-verified` chain had DROPPED `#1515`. Same shape as `07-edge-signer.md`: the note at `b3627c15` (PR #1517, 2026-08-17) chained but compressed #1516's entry to "added the merchant-reason surfacing", and `#1515` was cited inside the prose it dropped. #1516's original entry is restored verbatim from `b3627c15^` at the chain tail. Nothing in the body was re-verified in this pass. Prior: #1674/#1667: x402-erc7710-fresh-agent is added; #1578: unknown MCP session ids fail closed; #1547/#1450: x402-catalog-guided-purchase is scheme-aware; #1531: out-of-reach documentation added; #1533/#1534: legacy x402 legs removed; #1530: preflight resource reporting added; #1519: merchant settled-purchase handling added; #1517/#1516: merchant fault and reason reporting added; #1457/#1456: hosted erc7710 variant added; #1312: guided catalog purchase QA leg added; #1515: lost-session troubleshooting added.
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
| Seed the QA user, Hybrid account, agent, and budget delegation | Yes | No | First-time setup or identity replacement |
| Deterministic money-flow QA (`qa-dev.yml`) | Yes | Yes | Local debugging or shared repeatable evidence |
| Live deployed-UI smoke (`qa-live.yml`) | Yes | Yes | Verify a Vercel preview against the dev backend |
| Exploratory agent/merchant QA (Layer 2b, `/qa-dev`) | Yes | No | Payment / MCP coverage that needs LLM judgment |
| Browser UI exploration (Layer 3, `/qa-explore-ui`) | Yes | No | Dashboard UX / visual coverage that needs LLM judgment |

Use **GitHub Actions** for the normal shared money-flow run after the identity,
funding, and repository secrets exist. Use a **local run** to provision the
identity, debug failures, or validate changes before pushing them.

`qa-live.yml` is manual only (`workflow_dispatch`) — there is no permanent dev
frontend URL to schedule it against. The money-flow `qa-dev.yml` also runs
**nightly and on each dev deploy**, and a recent green run **gates dev → main**
promotion — see [Automation & gating](#automation--gating).

## Stable dev targets

| Surface | Target |
|---|---|
| Backend | `https://havenbackend-dev-8b95.up.railway.app` |
| Demo merchant | `https://demo-merchant-dev-84e4.up.railway.app` |
| Chain | Base Sepolia (`84532`) |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Frontend | `https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app` — the branch-tracking preview of `dev` (stable hostname, always the newest `dev` build; verified 2026-08-06). ⚠️ never `haven-ai-frontend.vercel.app` (prod alias → prod backend; passkeys are domain-bound), and ⚠️ never the `-git-main-` alias, which is **not** production and currently proxies to the dev backend |

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

`SEED_ALLOWANCE_USDC` and `SEED_RESET_MIN` keep their AllowanceModule-era names
so an existing operator env keeps working; since #2007 they set the **budget
delegation's** period budget and period length. `SEED_RPC_URL` is no longer read
— the seed sends nothing on-chain and opens no RPC connection.

### 3. Fund the required testnet accounts

| Account | Funding | Why |
|---|---|---|
| Owner EOA | **No on-chain funding required** | Signs the budget delegation off-chain. Hybrid provisioning is counterfactual — zero transactions (#2007) |
| Hybrid account | Base Sepolia test USDC | The treasury every QA payment spends from |
| Dev relayer | Base Sepolia ETH | Sponsors the UserOps, including the counterfactual account's first deployment, and gasless sweep recovery |
| Delegate EOA | No on-chain funding required | Signs payment and EIP-3009 sweep authorizations off-chain |
| **Demo-merchant settlement wallet** | **Base Sepolia ETH** | **Submits `transferWithAuthorization` / `redeemDelegations`. Derived from the merchant's `SETTLEMENT_PRIVATE_KEY`; NOT the receiving wallet** |

Ordinary payments and sweep recovery do not require delegate gas. The delegate
signs off-chain; the relayer sponsors the payment UserOps and submits the
gasless EIP-3009 USDC sweep. Keep the dev relayer funded with Base Sepolia ETH.

> **The settlement wallet was missing from this table until
> [#1530](https://github.com/d-hinders/Haven-AI/issues/1530).** On 2026-08-17 it
> ran down to 255 gwei and every x402 leg needing a merchant-side settlement
> failed — with a merchant error that named nothing about gas. It was the first
> link in a five-deep chain and masked four defects behind it; the day went into
> diagnosing the symptom. **The preflight below now checks it on every run**, so
> this row and the enforced check are the same fact rather than two that can
> drift.

The demo merchant must also be configured with:

```text
MERCHANT_CHAIN_ID=84532
MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb
```

The second setting creates the deterministic stranded-balance condition used by
the sweep-recovery scenario.

### Preflight: resources every run consumes (#1530)

Before the first leg, the harness reports every consumable resource and refuses
to run when one is definitively below its floor:

```text
preflight — resources this run consumes:
  ✗ merchant settlement wallet (gas) 0xC03F…22c1: 0.000000255 ETH (0 settlement(s))
      only 0 settlement(s) of gas left — top this wallet up, or every x402 leg
      needing a merchant-side settlement will fail with a merchant error that
      does not name gas (the 2026-08-17 outage)
  ✓ delegation delegate residual (USDC) 0x1a64…14F1: 0.0 USDC
```

Three properties worth knowing, because each was a deliberate choice:

- **It prints on every run, pass or fail.** A balance that is fine today and
  empty next week is visible only as a trend — and the number is most useful in
  the log of a run that was chasing something else.
- **Headroom is stated in units of work**, not wei. `255 gwei` reads as a
  number; `0 settlements` reads as a cause.
- **Unknown is not failure.** An unreachable RPC, or a merchant deployed before
  the readiness endpoint, reports `?` and does not block. A preflight that
  failed the run on its own blind spots would be worse than the silence it
  replaced.

The settlement wallet's balance comes from the **merchant's own `/healthz`**,
because the merchant is the only component that can answer: the address derives
from `SETTLEMENT_PRIVATE_KEY` in the merchant's environment. Nothing is
disclosed by reporting it — the address is already advertised as
`redeemerAddress` in erc7710 challenges, and balances are public on-chain. The
key is never exposed, and never needs to be.

### 4. Run the seed locally

```bash
set -a
source "/secure/path/qa-seed.env"
set +a
npm run seed -w packages/qa-agent
```

The seed is idempotent for an existing **active** or `pending_approval` QA
agent with the configured delegate address:

1. Create or log in to the QA user.
2. Provision or reuse the Base Sepolia **Hybrid DeleGator** account
   (`POST /accounts/hybrid`).
3. Create or reuse the QA agent.
4. Build, owner-sign and activate the USDC **budget delegation**.

If that delegate address instead belongs to a paused, revoked, or unknown-status
agent, the seed stops before it creates or reuses an agent, or grants a budget
delegation. Rotate `SEED_DELEGATE_ADDRESS`, or deliberately restore the named
agent before retrying; a seed run never silently restores authority that an
operator disabled.

It prints the account address and the `QA_*` block for the harness. Fund the
account with Base Sepolia test USDC after the first run.

**It no longer seeds a Safe (#2007, epic #1440).** `POST /user/safes` has
answered HTTP 410 since #1984, and an `allowance_module` account cannot pay at
all since #1986, so the seed provisions the rail the product actually runs on.
The old call was invisible because it sat behind a reuse branch that only a
**fresh** QA account reaches — the exact case a database reset produces, and
`qa-dev` feeds the `qa-freshness` gate on `dev → main`.
`packages/backend/src/openapi/qa-seed-routes.test.ts` now fails if the seed
calls a route the API has retired or no longer registers.

The seed prints all credential-bearing `QA_*` values the harness needs. It does
not print or require `QA_AGENT_API_KEY` or `QA_DELEGATE_PRIVATE_KEY`: those
belonged to the retired AllowanceModule rail, while every live payment scenario
uses the delegation identity.

An API key is shown only when a new agent is created. If the agent already
exists and its key was lost or exposed, rotate it instead of creating duplicate
QA identities.

## Money-flow QA

The deterministic harness runs thirteen scenarios in order:

| Scenario | Expected result |
|---|---|
| `within-budget-settle` | A 0.01 USDC **delegation-rail** payment settles on-chain and has a receipt: `POST /payments` → sign the `eip712_userop` typed data → poll to `confirmed`. Re-based from the legacy raw-hash scheme by #2016. Doubles as the suite's **positive control** — the leg that proves the money path can still say YES, which is what makes the two refusals below mean anything. **Skips** without `QA_DELEGATION_*` |
| `over-budget-refused` | An over-budget payment is refused **before it becomes signable**, by the on-chain caveat enforcer — HTTP 502 with no intent row. Renamed from `over-budget-queue` by #2016: that leg asserted `pending_approval`, and the approval queue was legacy-rail-only and no longer exists anywhere (#1986/#1989). A bare 502 is NOT accepted as proof — the amount is derived from a **live** enforcer read (a fallback reading or an exhausted budget fails the leg rather than passing it), a within-budget request against the same account must still be offered, and the ABI-encoded revert reason must decode to a **named caveat enforcer** |
| `x402-over-budget-rejected` | The same refusal on the x402 **EIP-3009 funding leg**, with the same three discriminators. Re-based by #2016, which found it **passing for the wrong reason**: driven against the retired legacy identity it was satisfied by the rail-retirement 410, and would have passed with over-budget enforcement deleted outright. Its erc7710 sibling below closes what used to be flagged here as a known gap (#2082) |
| `x402-erc7710-over-budget-rejected` | The same refusal on the **preferred** scheme (#2082). Until then the case did not exist to assert: erc7710 authorize returned 201 `pending_signature` WITH `sign_data` for ANY amount, so the #420 invariant's own words ("refused before it becomes signable") were FALSE on the path most payments take — measured live against dev 2026-08-25 and handed to #1993 rather than asserted around. The fail-fast pre-check refuses **HTTP 403 `delegation_budget_exceeded`** with no settlement child, no intent row and no relayer-paid delegate deploy. The discriminators are different from its 3009 sibling's, because the vacuous pass this shape invites is a different one: a bare 403 is ALSO what a MISSING delegation returns, so the leg requires the `error_code` AND requires the refusal's `remaining_atomic` to equal the live budget it derived the over-budget amount from, with a within-budget erc7710 authorize offered first as the control (and its `signature_scheme` checked, so a dispatch regression onto the funding leg cannot pass as this one). **What it does not claim:** that the CHAIN refuses the redemption — the caveat stack was always the gate and #2082 did not touch it; proving the redemption-side revert still needs a merchant that attempts one, and no leg does. Needs `QA_DELEGATION_AGENT_API_KEY`; **skips** without it |
| `x402-delegation-3009` | A **delegation-rail** agent pays an EIP-3009-only merchant through the funding-leg bridge (#946); the evidence row must show `settlement_scheme = eip3009` and the funding transfer going to the delegate EOA, the treasury must decrease, and no residual may sit at or above the 1 USDC sweep floor. **Skips** without `QA_DELEGATION_*` |
| `delegation-lifecycle` | Authority can be TAKEN AWAY: on a **throwaway per-run identity** (funded ~0.006 USDC from the standing delegation identity, then abandoned) — grant → activate (relayer-deploys) → within-budget payment settles → replace leaves **exactly one** active row (the #1053-finding-4 transactional-activate regression) → owner-signed revoke → the same payment shape is refused **403 "no active budget delegation"**, never a 502 (a 502 would mean authority was still offered to the chain). Ephemeral keys, all signing client-side |
| `x402-erc7710-settle` | The delegation rail's PRIMARY x402 path: authorize (payTo = merchant) builds a narrowed child delegation, the delegate signs it, `POST /x402/:id/settle` wraps the header, and the MERCHANT redeems `[child, budget]` on-chain — treasury pays the merchant **directly**, budget metered by the settlement itself (treasury −amount exactly), **delegate EOA untouched** (no funding leg — the #713 stranded-funds class structurally absent). Needs `MERCHANT_X402_ERC7710=1` + `MERCHANT_ERC7710_DELEGATION_MANAGER` on the dev merchant; skips (→ run FAILS under #1066) with that exact remedy when the merchant is 3009-only |
| `x402-erc7710-fresh-agent` | The COLD START (#1674, regression net for #1667): a per-run throwaway identity whose delegate hybrid account is asserted counterfactual on-chain (`getCode` = `0x` before any payment), then the agent's FIRST-EVER payment runs the erc7710 settlement — asserting authorize deployed the account (code exists between authorize and settle, pinning WHERE the deploy happens), the merchant redemption settles treasury→merchant exactly, and the delegate EOA is untouched. Funded per run from the standing identity; same env needs as `x402-erc7710-settle` |
| `x402-erc7710-sdk` | The same settlement through **`HavenClient`** instead of the raw API (#1457). The leg above deliberately excludes the SDK, so it stays green whether or not Haven's own client works; this one drives `settleX402Erc7710()` end to end and asserts the same money proof — treasury −amount exactly, merchant +amount exactly, **delegate EOA unchanged**. That last assertion is the point: a silent reroute to the EIP-3009 bridge would still deliver the goods and still debit the treasury, and would only be visible in the delegate's balance. Needs `QA_DELEGATION_DELEGATE_PRIVATE_KEY` (the SDK signs in-process, unlike the hosted topology). The hosted MCP + local signer variant waits on #1456 |
| `x402-erc7710-hosted` | The same settlement through the **default topology** — hosted MCP + local edge signer, what `npx @haven_ai/connect` installs (#1457). The two legs above cover the raw API and the SDK; neither exercises the hosted boundary, where the server must never hold a delegate key and the signature has to come from the local signer. Asserts the hosted quote **reports** `settlement_scheme: erc7710` (a silent reroute to the 3009 bridge would still deliver the goods), that settle reports **no funding tx**, and that the delegate EOA is unchanged. Signs with `haven_sign` rather than `haven_sign_x402` — the latter builds an EIP-3009 header this scheme has no use for. Ordered right after `x402-hosted-mcp-signer` so a failure is diagnosable against a topology that leg has already shown healthy |
| `x402-delegation-3009-sweep` | The other half of the bridge: a delegation-rail 3009 payment the merchant **verifies but never settles** strands funds on the delegate EOA, and the gasless sweep returns them to the treasury. Needs `MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb` and `SWEEP_MIN_USDC=0` on dev; **skips** rather than fails when either is unset, since a settling merchant is an unmet precondition, not a regression |
| `x402-hosted-mcp-signer` | The **default user topology** (#1154): the DEPLOYED hosted MCP over HTTP plus a local `@haven_ai/signer` edge signer in-process — `haven_pay_mcp_tool` → local `haven_sign_x402` → `haven_settle_mcp_tool` → merchant settles. Asserts the quote is a **v2 (delegation-rail) context** (a v1 quote FAILS the leg: the #1138 seam would have gone untouched), that the signer really signed it, that **both** on-chain legs confirmed as distinct `status = 1` transactions, that the treasury fell, and that the delegate residual is **unchanged** (exact-amount funding nets to zero). Needs `QA_HOSTED_MCP_URL` + `QA_X402_BINDING_SIGNER` on top of `QA_DELEGATION_*`. **Skips** (#1441) when the hosted quote comes back **erc7710-shaped**: #1450's preference rule selects erc7710 whenever the merchant advertises it, and this leg's invariant is the FUNDING-LEG one, so against such a merchant it is unreachable rather than violated. Nothing goes uncovered — hosted erc7710 is `x402-erc7710-hosted`, and `x402-catalog-guided-purchase` is scheme-aware since #1547 (erc7710 expected on dev, the 3009 two-leg proof kept as its fallback shape; same topology, zero residual either way). What this leg alone still covers is the `haven_pay_mcp_tool` ENTRY POINT on the funding path; point it at a merchant that does not advertise erc7710 to exercise that, and note `QA_REQUIRE_ALL_LEGS=1` turns the skip into a run failure |
| `x402-catalog-guided-purchase` | The **GUIDED catalog purchase path** (epic #1305, #1312): resolves a catalog entry via `GET /catalog` (never a hardcoded id), calls `haven_prepare_catalog_purchase(catalog_id, max_amount | max_amount_human)`, then branches on the preflight's `settlement_scheme` (#1547 — the guided prepare runs the #1450 preference): on **erc7710** (expected on dev) it signs via `haven_sign` by **`payment_id`** alone and settles with **only `payment_id` + `signature`** — no `payment_header` (Haven assembles it at settle), money proof inverted (a `funding_tx_hash` is a FAILURE, treasury debit = merchant credit, delegate untouched); on the **eip3009 fallback shape** it signs via `haven_sign_x402` by `payment_id` alone (#1549 — the compact preflight no longer echoes `payment_required`; the signer fetches it by payment_id, and the leg FAILS if the echo reappears) and settles with **only `payment_id` + `signature` + `payment_header`**. Neither shape ever re-sends `merchant_url`/`tool_name`/`arguments`/`mcp_transport` (that re-threading is exactly what the epic exists to eliminate; needing it FAILS the leg, does not soften it). Asserts the preflight is COMPACT, carries the #1308 machine-readable next step and a rail-labeled allowance block, marks the catalog price indicative next to the live amount, and that the settled response carries the #1310 post-purchase allowance block. Buys NordShield VPN Basic (`buy_vpn`/`{plan:"basic"}`) — a SETTLING product; never CloudNest 50 GB, which is dev's verify-without-settle sweep fixture. Same env as `x402-hosted-mcp-signer` (`QA_HOSTED_MCP_URL`, `QA_X402_BINDING_SIGNER`, `QA_DELEGATION_*`, `QA_DEMO_MERCHANT_URL`) — no new secrets. **Skips** (not fails) when no catalog row matches on dev (#1299 seed not applied) or the hosted MCP does not yet expose `haven_prepare_catalog_purchase` (pre-#1306 deploy) |

The harness exits non-zero if any non-skipped scenario fails. **A skip IS a
failure (#1066).** Since every leg's identity is provisioned (#1063) and the
sweep floor is zeroed on dev, the repo variable `QA_REQUIRE_ALL_LEGS=1` is
SET and the *Coverage completeness* step is blocking: a run that skips any
leg goes red and names it. A reappearing skip means a broken precondition —
drained QA treasury, expired credential, a reverted dev env var — never a
missing identity; fix the precondition, don't loosen the gate. To retire a
leg that is genuinely obsolete, delete its scenario file in the SAME PR that
removes the thing it proved (money-path review applies) — the gate must
never be re-loosened to accommodate a leg nobody deleted. Historical note
(#1044): before the flip, skips were a run-page warning and "green" meant
"every EXECUTED leg passed". Its Markdown
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
QA_PAYMENT_TO=<Base Sepolia recipient address>
QA_DEMO_MERCHANT_URL=https://demo-merchant-dev-84e4.up.railway.app

# Delegation-rail identity for the EIP-3009 bridge scenario (#946) — optional.
QA_DELEGATION_AGENT_API_KEY=<testnet delegation-rail agent API key>
QA_DELEGATION_DELEGATE_PRIVATE_KEY=<throwaway Base Sepolia delegate key>

# Hosted-MCP topology (#1154). NEITHER of these is a secret: one is a public
# endpoint, the other a public address. They live here only so the whole harness
# config is one file.
QA_HOSTED_MCP_URL=https://haven-ai-hosted-mcp-dev-25c7.up.railway.app/v1
QA_X402_BINDING_SIGNER=<dev x402 binding-signer address, 0x…>
```

`QA_DEMO_MERCHANT_URL` is technically optional in the config loader, but it is
required to exercise the merchant scenarios. A leading `#` comments out a
variable; do not comment out a required value.

#### Seeding the delegation-rail identity (`x402-delegation-3009`)

**Since #2007 the seed provisions this identity for you** — `npm run seed` ends
by printing `QA_DELEGATION_AGENT_API_KEY` and naming the delegate key to pair
with it. The steps below are kept as the description of what the seed does, and
as the recipe for provisioning a second delegation-rail identity by hand.

The `x402-delegation-3009` scenario uses the delegation-rail identity because
the execution rail is a property of the account. Without the two
`QA_DELEGATION_*` values the scenario **skips** — it never fails the run for
being unconfigured.

That agent must have an **open (unpinned) budget delegation**. A
recipient-pinned budget cannot fund the delegate EOA, and per the owner decision
of 2026-07-15 we do not weaken a pin for interop — so pinned agents are
erc7710-only by design, and pointing this scenario at one produces a legitimate
failure, not a misconfiguration.

What the seed does, and what to repeat by hand for an extra identity (the same
way the 2026-07-18 live proof did):

1. `POST /accounts/hybrid` — a counterfactual Hybrid treasury (zero tx).
2. Create an agent against it with a client-generated delegate EOA; keep that
   private key for `QA_DELEGATION_DELEGATE_PRIVATE_KEY`.
3. Grant an **open** budget delegation (e.g. 2 USDC / 24h, recipient unpinned),
   owner-signed, then activate it — the relayer deploys the treasury, sponsored.
4. Fund the treasury with a little Base Sepolia USDC.

Both scenarios assert more than "the purchase worked". `x402-delegation-3009`
reads the payment evidence back and requires `settlement_scheme = eip3009`,
Haven's own transfer going to the **delegate EOA** rather than the merchant, the
merchant recorded separately from that funding address, and the treasury balance
actually falling. A merchant round-trip alone would pass just as happily over
erc7710, leaving the bridge uncovered — and the address checks alone would pass
for a funding hop that never metered the budget.

`x402-delegation-3009-sweep` covers the other half, and needs two more settings
on the dev stack: `MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb` on the
demo-merchant, and `SWEEP_MIN_USDC=0` on the backend so a QA-sized stranding is
above the sweep floor. Without them it SKIPS with a message naming the missing
setting — a merchant that settles normally is an unmet precondition, not a sweep
regression.

Neither has run live yet. They are unit-covered and typechecked; their first
real run is this seeding step, so treat an initial red as information about the
setup as much as about the code.

#### The hosted-MCP leg (`x402-hosted-mcp-signer`, #1154)

This is the topology **every connect-flow user actually runs**, and until #1154
no scenario touched it: all three x402 legs above build a `HavenClient` with a
`delegateKey`, which is the SDK-direct path — the hosted server's keyless
branch, the Haven-signed expected context, and the signer's verify-then-sign
logic are all bypassed. #1138 was a hard failure of exactly that uncovered path,
and a human driving an agent by hand found it.

It reuses the delegation-rail identity above (same treasury, same delegate key,
same ~0.001 USDC per run) and needs two more values, **neither of which is a
secret**:

| Variable | What it is | Where to get it |
|---|---|---|
| `QA_HOSTED_MCP_URL` | The deployed hosted MCP endpoint, e.g. `https://haven-ai-hosted-mcp-dev-25c7.up.railway.app/v1` | [`dev-environment.md`](dev-environment.md); same value as `HAVEN_HOSTED_MCP_URL` on the dev backend |
| `QA_X402_BINDING_SIGNER` | The Haven binding-signer **address** the edge signer verifies the expected context against | `x402_binding_signer` in a connector-written `signer.json`, or the address derived from the backend's `X402_BINDING_PRIVATE_KEY` |

`QA_X402_BINDING_SIGNER` is deliberately **not** defaulted from the quote. Taking
`auth.signer` out of the very context being authenticated would make the binding
check assert nothing — which is the one property the hosted topology exists to
provide. Absent, the leg skips (and under `QA_REQUIRE_ALL_LEGS=1` that skip is a
red run).

The leg drives the deployed hosted MCP over HTTP and runs `@haven_ai/signer`
**in-process** via `createEdgeSigner`, rather than spawning it as a stdio MCP:
every piece the #1138 bug was in — the keyless branch, the wire shapes, the
binding, the signing — is exercised either way, and stdio adds process plumbing
to a CI leg without adding coverage. Signing goes through the signer's *tool
handler*, not the bare `EdgeSigner` method, so the live quote also passes
through the Zod schema where the #1143 skew surfaced.

**CI build requirement.** `qa-dev.yml` builds `@haven_ai/signer` as well as
`@haven_ai/sdk`: a workspace dep resolves to `packages/signer/dist`, which does
not exist until it is built. Locally, run `npm run build -w packages/signer`
before `npm run qa:dev` — a stale or absent signer `dist` makes the leg die on
an import error, or (worse, if merely stale) refuse the v2 context with a Zod
message about `auth.version`.

Unit coverage for the same seam, which does not need credentials:
`packages/mcp-server/src/x402-expected-wire-contract.test.ts` pins that the
backend's expected-context message and the signer's independent reconstruction
are byte-identical at v1 and v2, drives the v1/v2 binding matrix, and asserts the
tool schema accepts the real hosted quote shape.

#### The guided catalog purchase leg (`x402-catalog-guided-purchase`, #1312)

Epic #1305 shipped the GUIDED entry point — `haven_prepare_catalog_purchase` —
so a coding agent starts from a curated `catalog_id` instead of hand-copying a
`merchant_url`/`tool_name`/`tool_arguments` triple, and finishes without ever
re-threading `payment_required`/`merchant_url`/`tool_name`/`arguments`/
`mcp_transport` between tool calls. #1306–#1310 landed and unit-proved the five
primitives that make that possible, each against mocked collaborators; nothing
had driven them together, live, in the order a real agent runtime calls them.
This leg is that proof, reusing `x402-hosted-mcp-signer`'s topology and
money-proof discipline verbatim (same in-process `@haven_ai/signer`, same
zero-residual delta assertion) but starting from the catalog and asserting the
guided contract end to end. Scheme-aware since #1547 — the guided prepare now
runs the #1450 settlement-scheme preference, so the leg branches on the
preflight's `settlement_scheme`:

- **erc7710 (expected on dev):** the #1308 machine-readable next step points at
  `haven_sign`, signing is by `payment_id` alone, and settle carries
  `payment_id` + `signature` ONLY — **no** `payment_header` (Haven assembles it
  at settle) and no merchant context, making this the one leg that proves
  #1307 rehydration serves the erc7710 scheme. Money proof inverts: a
  `funding_tx_hash` is a FAILURE, treasury debit must equal merchant credit,
  delegate EOA untouched.
- **eip3009 (fallback shape — a merchant not advertising erc7710, or a hosted
  deploy predating #1547):** a compact preflight, signing by
  `payment_id` alone via `haven_sign_x402` (#1549 — the compact response no
  longer echoes `payment_required` and the leg FAILS if it reappears; the
  signer fetches it by payment_id, #1355), and settling with `payment_id` +
  `signature` + `payment_header` alone — proving `haven_settle_mcp_tool`'s
  #1307 rehydration actually serves the merchant context rather than merely
  documenting that it does.

Both shapes assert the #1308 guidance, the rail-labeled allowance block, the
indicative catalog price, and the #1310 post-purchase allowance block.

It needs no new secrets: it reuses the delegation-rail identity and the two
`QA_HOSTED_MCP_URL` / `QA_X402_BINDING_SIGNER` values `x402-hosted-mcp-signer`
already requires. It buys NordShield VPN Basic (`buy_vpn`/`{plan:"basic"}`),
the same settling product `x402-hosted-mcp-signer` uses — **never** CloudNest
50 GB (`buy_cloud_storage`/`{tier:"50gb"}`), which is the demo merchant's
`MERCHANT_SKIP_SETTLE_PRODUCT` verify-without-settle fixture on dev
(`x402-delegation-3009-sweep`'s fixture): funds would strand on the delegate by
design, and this leg's zero-residual assertion would be asserting a lie.

Two skip conditions are specific to this leg, both unmet-precondition, never a
code defect:

- **No matching catalog row.** The leg resolves the catalog_id itself via
  `GET /catalog`, matching by `resource_url`/`tool_name`/`tool_arguments` — it
  never hardcodes a UUID. If the #1299 seed migration
  (`058_demo_merchant_catalog`) has not been applied to the target
  environment, or the QA identity is scoped to a different chain, no row
  matches and the leg skips naming the migration.
- **A fresh deploy that has not picked up #1306 yet.** Since this leg is NEW,
  its very first run against a given dev deploy can predate the merge that
  registers `haven_prepare_catalog_purchase` on the hosted MCP. The leg
  recognizes the MCP SDK's own "tool not found" JSON-RPC error and treats it
  as a deploy-skew skip, not a failure — any OTHER error calling the tool
  (a real refusal, a transport fault) still fails the leg normally.

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
- `QA_PAYMENT_TO`
- `QA_DEMO_MERCHANT_URL`

And, for the two delegation-rail EIP-3009 legs (`x402-delegation-3009`,
`x402-delegation-3009-sweep` — the run skips them, and the Coverage
completeness step warns, when either is absent):

- `QA_DELEGATION_AGENT_API_KEY`
- `QA_DELEGATION_DELEGATE_PRIVATE_KEY`

The hosted-MCP leg (`x402-hosted-mcp-signer`, #1154) needs two more values.
Because neither is secret, the workflow reads repo **variables** first and falls
back to secrets of the same name — set them wherever you prefer, but set them,
or the leg skips and the Coverage completeness step turns that red:

- `QA_HOSTED_MCP_URL`
- `QA_X402_BINDING_SIGNER`

**The delegation-rail QA identity (#1063).** Provisioned 2026-08-05 on the
dev backend: a dedicated QA user owning a Hybrid DeleGator treasury on Base
Sepolia with an **open (unpinned) 5 USDC/day budget delegation**. Open rather
than pinned is structural, not preference: 3009-mode funds the delegate EOA
from the budget, and a recipient-pinned delegation cannot pay the EOA — a
pinned identity would make both legs skip for a third reason. The treasury
holds testnet USDC (~0.9 at provisioning; each leg spends ~0.001/run).

- **Top-up:** send Base Sepolia USDC
  (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) to the treasury address in
  the operator's `~/.haven/qa-delegation.env` (`QA_DELEGATION_TREASURY`) —
  any source works; the budget refills itself daily.
- **Rotation:** the full identity (user credentials, owner key, delegate key,
  API key, treasury address) lives in the operator's
  `~/.haven/qa-delegation.env`. To rotate the delegate key: create a fresh
  agent for the same account (new delegate + API key), update both repo
  secrets, revoke the old agent. To rotate everything: re-provision a fresh
  identity (signup → hybrid account → agent → open-budget grant → activate →
  fund), update the secrets, and update the env file. Never reuse
  `RELAYER_PRIVATE_KEY`, `SETTLEMENT_PRIVATE_KEY`, or any non-QA key.

If the dotenv file contains exactly those five required entries, upload them
with:

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

## Automation & gating

Once the deterministic money-flow harness proved stable when run manually (#575),
`qa-dev.yml` was automated and wired into promotion (#578). The model is
**pre-promotion, not per-PR**: the harness runs on a cadence and produces a
signal; the `dev → main` gate reads that signal instead of re-running the
money-moving harness on every promotion PR (which would burn testnet funds and
need the `QA_*` secrets in a PR-triggered workflow).

**What the gate proves** ([#1030](https://github.com/d-hinders/Haven-AI/issues/1030)) —
it is not just "a run happened recently":

- the newest green `qa-dev` run on `dev` is inside `QA_FRESHNESS_HOURS`
  (default 30h), **and** no money-path file changed between that run's commit
  and the promotion head. Recency is not coverage: a run predating the
  money-path commits never exercised them. The failure names the offending
  files.
- a **money-path `hotfix/* → main` blocks**. `qa-dev.yml` is a black-box
  harness against a *deployed* backend, and a hotfix is deployed nowhere until
  it merges — so a green run on any branch exercised different code. Clearing
  it is an explicit human decision: `qa-override` **with a comment stating what
  you verified**. A hotfix touching no money-path file passes.
- everything unanswerable fails **closed**: no run, unparseable timestamp,
  uncomputable diff, unknown source branch, or a `QA_FRESHNESS_HOURS` that is
  not a positive number.

Logic: [`scripts/ci/qa-freshness.mjs`](../../scripts/ci/qa-freshness.mjs), unit-tested.
Known limit: the run's `headSha` is the branch tip when the run was *triggered*,
which for the nightly cron may be ahead of what dev actually deployed.

### When the money-flow QA runs

| Trigger | Purpose |
|---|---|
| `workflow_dispatch` | Manual run / parity with the local `qa:dev` command. |
| `schedule` (nightly, `17 3 * * *` UTC) | Always have a fresh green signal without anyone triggering it. |
| `repository_dispatch` (`dev-deployed`) | Test exactly what the Railway/Vercel dev deploy just shipped. |

Runs are **serialized** (`concurrency: qa-dev-money-flow`, no cancel) so two
money-moving runs never share the one QA delegate/allowance at once.

### Post-deploy trigger (webhook setup)

Point the dev deploy at GitHub's `repository_dispatch` API so a deploy fires a QA
run. In the **Railway dev backend** (and/or the **Vercel dev project**) add a
deploy/post-deploy hook that runs:

```bash
curl -sf -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GH_DISPATCH_TOKEN" \
  https://api.github.com/repos/d-hinders/Haven-AI/dispatches \
  -d '{"event_type":"dev-deployed"}'
```

`GH_DISPATCH_TOKEN` is a fine-grained PAT (or GitHub App token) with **Actions:
write** on this repo only — store it as a deploy-provider secret, never in the
repo. Firing `dev-deployed` starts the `money-flow` job against the stable dev
targets above.

### Automated failure reporting

On failure, `qa-dev.yml` files a GitHub issue labeled **`qa-failure`** with the
run URL and trigger (or comments on the existing open one, so a flapping chain
doesn't spam new issues). Triage it via [Troubleshooting](#troubleshooting):
re-dispatch to clear a transient testnet/RPC flake, or open a
[`bug-reports/`](../bug-reports/) report for a real regression, then close the
`qa-failure` issue once green.

### The dev → main freshness gate

`dev-gate.yml` adds a **`qa-freshness`** job: a promotion PR (`dev → main`) passes
only if a **successful** `qa-dev.yml` run exists on `dev` **within
`QA_FRESHNESS_HOURS`** (default **30h** — covers one missed nightly). No recent
green run → the gate fails with instructions to dispatch one. Only the
deterministic money-flow harness gates; the LLM-agent layer (2b, #577) and browser
exploration (Layer 3, #579) stay **non-gating**.

Both `qa-freshness` and the branch-source `gate` have been **required status
checks on `main` since 2026-07-27** (`dev-environment.md`). They need the `QA_*`
secrets configured so the scheduled run can go green; a gate that is required
but can never pass blocks every promotion rather than none.

### Flake budget & quarantine policy

Testnet/RPC hiccups must not permanently wedge promotion. Two levers:

- **Retry budget** — each `qa-dev.yml` run retries the whole suite up to
  `QA_MAX_ATTEMPTS` times (default **2**, repo variable) before it's called red.
  Keep it low; each attempt consumes test funds.
- **`qa-override` label** — adding it to a promotion PR **skips** the freshness
  gate (logged as a warning). Use it only to unblock a known-flaky testnet
  hiccup when you've confirmed a recent QA run out-of-band; remove it once a fresh
  green run exists. It is the deliberate quarantine escape hatch, not a routine
  bypass.

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
  -f base_url=https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app
```

The preview must set `NEXT_PUBLIC_HAVEN_ENV=dev`; production builds intentionally
ignore the backend override.

For a local invocation:

```bash
npx playwright install chromium
export PLAYWRIGHT_BASE_URL=https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app
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
> 3. Use direct `haven_pay` for an amount **over** the remaining budget → expect it to be
> **refused before it becomes signable**. Assert all three: no settlement, nothing
> queued or pending approval, and nothing silently spent. The refusal IS the pass —
> the delegation rail has no approval queue, so do not record the decline as a failure.
> 4. Make a priced call **above the max price** → expect a `PRICE_EXCEEDS_MAX` rejection.
> 5. `haven_list_receipts`, then `haven_verify_receipt` on the step-2 payment → expect it verifies.
> Stop at the first failed step. Then write a run report from
> `docs/bug-reports/_run-report-template.md` (per-goal pass/fail + friction) and file
> concrete bugs as issues. This is non-gating exploratory coverage.

## Layer 3 — AI-driven browser exploration (`/qa-explore-ui`, #579)

An LLM agent drives a **real browser** (via **Playwright MCP**, reusing the
existing Chromium/Playwright setup) over the **dev dashboard**, using the agent
session's own model (no `ANTHROPIC_API_KEY` in CI). It adds agentic coverage of
the **UI itself** — layout breakage, horizontal overflow, confusing states, dead
ends, console errors, and secret leakage that fixed-selector specs miss. Like
Layer 2b it is **never a deploy gate**; it is **read-oriented** exploration (no
money movement beyond what the existing testnet flows already cover) that files a
findings report under [`bug-reports/`](../bug-reports/).

- **When to run:** before a promotion, or after a risky change to the dashboard UI — **and on a recurring weekly cadence** as the design system's UX-discovery heartbeat, where each material finding becomes a deduped `/new-task` backlog issue for `/ship-next`. That cadence and its finding→backlog→ship-next loop are specified in [`qa-explore-ui-cadence.md`](qa-explore-ui-cadence.md) (#903).
- **Target:** a **non-production** Vercel deployment (`NEXT_PUBLIC_HAVEN_ENV=dev`)
  re-pointed at the shared dev backend with `?apiBaseUrl=` — same convention as the
  [live UI smoke](#live-deployed-ui-smoke). A production build ignores the override
  (#582/#583), so it must be a dev/preview build.
- **Exploration brief:** visit the dashboard, transactions + detail panel, agents +
  connect-agent modal, and the **agent detail** page including its budget card; look
  for horizontal overflow (the
  `expectNoHorizontalOverflow` invariant in
  `packages/frontend/e2e/fixtures/haven-api.ts`), secret leakage, console errors,
  dead ends, and whether money/authority screens answer the AGENTS.md
  "Money And Risk Clarity" questions.
- **How findings feed back:** the report's *Friction* table and *Notes for the
  coding agent* (and any issues it files) are the loop #419/#420 call for.
- **Claude Code:** run `/qa-explore-ui` ([`.claude/commands/qa-explore-ui.md`](../../.claude/commands/qa-explore-ui.md)).

**Codex / generic runtime (pasteable prompt):**

> You are running exploratory **UI** QA against Haven's **dev** dashboard (testnet /
> Base Sepolia — never prod), read-oriented. Attach a Playwright MCP browser driver
> (`npx @playwright/mcp@latest`, reusing the installed Chromium). Open the given
> **non-production** Vercel URL with `?apiBaseUrl=https://havenbackend-dev-8b95.up.railway.app`
> appended, sign in as the seeded QA user, and confirm the `DEV` badge + real dev data.
> Then explore the dashboard, transactions + detail panel, agents + connect-agent
> modal, and the **agent detail** page including its budget card — **observe only.
> The rule is the rule, not the list: if a control would write, treat it as
> off-limits.** Concretely: do not complete a connect flow, grant / raise / revoke a
> budget, pause / resume / remove an agent, or send a payment (the shared dev
> identity is used by other QA runs). Look for:
> horizontal overflow / broken layout, secret leakage (no keys/JWTs/setup tokens in
> the UI), console errors, dead ends, and whether money/authority screens are clear
> (who can spend, from which wallet, how much, when approval is needed, how to
> pause/revoke). Screenshot key screens.
> Write a findings report from `docs/bug-reports/_run-report-template.md` (surfaces
> visited + a Friction/Bugs table), run the secret review before committing, and file
> concrete UI bugs as issues. This is non-gating exploratory coverage.

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

## What this session cannot see, and what to ask for

An agent session running this harness sees the harness. It does not see the
places most money-flow causes actually live — and it cannot ask for a list it
does not know exists. This section is that list.

It is guidance, not a gate. "Don't state a theory as a diagnosis" is not
checkable, and a gate for it would be ceremony satisfiable without the
thinking ([`autonomous-pr-loop.md`](../contributing/autonomous-pr-loop.md);
CLAUDE.md, *enforce outcomes, never tooling*). What was fixable is that the
request list did not exist.

### Out of reach from an agent session

| Not visible | Lives in |
|---|---|
| Service runtime + deploy logs (backend, demo merchant) | Railway dashboard |
| On-chain transaction and token-transfer history | Basescan |
| Deployed services' env vars, and the addresses they derive to | Railway → Variables |
| Dev wallet balances (settlement, relayer, treasury) | Basescan, or the operator |

A red leg whose cause sits in that column cannot be diagnosed by reading the
harness harder. On 2026-08-17 four mechanisms were proposed in sequence —
serverless sleep, gas drained twice, funding never delivered, a merchant
restart wiping in-memory state — and every one was consistent with part of the
evidence and disproved by an artifact nobody had asked for. A transfer-history
export then settled in minutes what hours of theorising had not.

### Ask for these first, before proposing a mechanism

For a money-flow failure, roughly in this order:

1. **The failing `qa-dev` job log** — the run URL is enough.
2. **The delegate EOA's token-transfer history for the window.** Ask for an
   export, not a screenshot: timestamps and ordering are the evidence, and a
   screenshot usually crops exactly the row that decides between two theories.
3. **The demo merchant's deploy + runtime logs for the same window.** Deploys
   matter as much as runtime lines — the merchant redeploys on every push to
   `dev`, so "did a deploy land mid-run" is a question about the deploy list.
4. **The merchant settlement wallet's address and native balance** — see the
   key rule below. Since [#1530](https://github.com/d-hinders/Haven-AI/issues/1530)
   the preflight reports this before the first leg and refuses to run when it
   is below floor, so for a *fresh* run this is usually already answered in the
   log from item 1; ask when diagnosing an older run, or when the preflight
   itself is what looks wrong.

**The address, never the key.** Ask for the settlement wallet's *address* and
balance; never its `SETTLEMENT_PRIVATE_KEY`. Why disclosing the address costs
nothing is set out under [the preflight](#preflight-resources-every-run-consumes-1530)
and not repeated here. The rule generalises to every secret this harness
touches: names and derived addresses are shareable, values are not (see
[Create the seed environment file](#2-create-the-seed-environment-file)). An
agent must never ask for a key, and an operator must never paste one.

## Troubleshooting

If nothing below matches, the cause may simply be somewhere this session
cannot look — see [What this session cannot see, and what to ask for](#what-this-session-cannot-see-and-what-to-ask-for) for the artifacts to
request before proposing a mechanism.

### `ERR_MODULE_NOT_FOUND ... @haven_ai/sdk/dist/index.js`

Build the workspace SDK:

```bash
npm run build -w packages/sdk
```

### `No compatible payment option found in x402 requirements` (any x402 leg)

First suspect the **SDK resolution**, not the merchant. `packages/qa-agent`
must depend on `"@haven_ai/sdk": "*"` so npm links the **workspace** SDK — an
exact version pin silently flips to the stale **npm registry tarball** the
moment `release:bump` moves the workspace version past the pin, and the
published SDK (built from `main`) can lag dev by weeks. That exact failure hit
the scheduled run on 2026-07-13: the registry matcher predated Base-Sepolia
(`eip155:84532`) support, so the dev merchant's perfectly valid challenge
matched nothing. Verify what qa-agent actually resolves:

```bash
node -e "console.log(require.resolve('@haven_ai/sdk', { paths: ['./packages/qa-agent'] }))"
# must print …/packages/sdk/dist/…, never …/node_modules/@haven_ai/sdk/…
```

If the resolution is right, then check the merchant's 402 challenge itself
(`curl -i -X POST <merchant>/mcp …` — the `accepts` array should advertise
`scheme: exact`, `network: eip155:84532`, the Base-Sepolia USDC address).

### `Missing required QA env`

The dotenv file was not sourced, a variable is commented out, or the shell was
restarted. Source it and verify names without printing values:

```bash
for name in QA_HAVEN_API_URL QA_PAYMENT_TO QA_DEMO_MERCHANT_URL \
            QA_DELEGATION_AGENT_API_KEY QA_DELEGATION_DELEGATE_PRIVATE_KEY \
            QA_HOSTED_MCP_URL QA_X402_BINDING_SIGNER; do
  printenv "$name" >/dev/null && echo "$name: present" || echo "$name: MISSING"
done
```

The last four are optional to the config loader but required for the delegation
and hosted legs; a run with `QA_REQUIRE_ALL_LEGS=1` goes red if any is missing.

### Seed returns `410`

A route the seed calls has been retired. This should be impossible to reach
undiagnosed: `packages/backend/src/openapi/qa-seed-routes.test.ts` fails in CI
when the seed calls a retired or unregistered route. If you see a 410 anyway,
the handler is refusing from its own body without a `retired*()` route marker —
which that guard deliberately cannot see. Read the refusal body; it names the
replacement route.

### `On-chain execution failed` or `insufficient funds`

Check balances by role:

1. Hybrid account: enough test USDC, and budget remaining in the period. No
   harness leg drives a legacy Safe identity — #2011 removed the AllowanceModule
   credentials the config used to read, and no scenario has re-added one.
2. Dev relayer: enough Base Sepolia ETH — it sponsors the UserOps, deploys a
   counterfactual account on its first budget activation, and submits the
   gasless EIP-3009 sweep.
3. Owner: **no ETH needed since #2007.** Reseeding on the delegation rail sends
   nothing on-chain; the owner only signs.

Do not repeatedly rerun a money-moving harness while the cause is unknown; each
run consumes test allowance and test USDC.

### Sweep is skipped after 20 seconds

The merchant did not produce a visible stranded balance. Confirm its Base
Sepolia deployment and `MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb`, then check
for RPC propagation delay.

### Sweep left as dust below the floor

The backend does not create a sweep authorization when the stranded USDC
balance is **below** `SWEEP_MIN_USDC` (default `1`) — recovering dust would cost
more relayer gas than it returns, so it is left on the delegate. The scenario
returns `below_min: true` with the balance and floor. In dev this should not
happen (dev sets `SWEEP_MIN_USDC=0`); if it does, confirm the dev backend's
floor is `0` rather than lowering the prod default.

### An x402 leg fails with `still HTTP 402 after payment`

Read the rest of the line before doing anything else. Since #1516 the leg
appends the merchant's own account of the 402, and the two shapes it
distinguishes have opposite causes:

- **`— merchant said: <reason>`** — the merchant looked at the payment and
  **rejected** it. The reason is the merchant's `PaymentError`; treat it as the
  finding (a reverted settlement tx, an unusable `assetTransferMethod`, an
  invalid payer address). Its settlement wallet and RPC are the usual suspects
  when the reason mentions the chain.
- **`… merchant-side fault (<Class>) … [not a policy rejection]`** — the merchant
  **broke**, it did not refuse. Something that is not a `PaymentError` escaped
  verification or settlement: an RPC failure, a viem error, a bug. The class
  name is the only detail that crosses to the client on purpose; the message
  and stack are in the merchant's own logs, which is where to look next
  ([#1517](https://github.com/d-hinders/Haven-AI/issues/1517)). Nothing about
  the payment is wrong — do not go looking at budgets, delegations or
  signatures until the merchant is healthy.
- **`— merchant re-issued a bare challenge`** — the merchant **rejected
  nothing**. It never associated the `X-PAYMENT` header with the request, which
  means it lost the session or pending-payment record between the challenge and
  the paid retry. That state is in memory
  ([#1515](https://github.com/d-hinders/Haven-AI/issues/1515)), so any container
  restart between the two produces exactly this — including a Railway redeploy,
  which fires on **every push to `dev`**.

  Since #1519 (EIP-3009) and #1515 (erc7710), a restart no longer turns a PAID
  retry into a refusal: the merchant re-derives settle state from the chain —
  `authorizationState` for a 3009 nonce; for erc7710, the settlement child's
  `spentMap` counter read from the **pinned** transfer-amount enforcer, and
  only when that caveat's committed cap equals the price — and serves the goods
  with no second submit when the money already moved. A restart mid-flow now
  costs at most one extra retry; a buyer-charged-and-402'd outcome from this
  cause is a regression, not a known mode.

  The unknown-session half was closed by #1578: a paid retry carrying a
  pre-restart session id now gets **HTTP 404 with JSON-RPC error `-32001`
  ("Session not found")** — BEFORE the payment gate, so no authorization is
  consumed. That response is a session problem, never a payment refusal:
  payment refusals are 402s carrying a reason. The client remedy is to
  re-initialize and retry with the SAME payment header, which then settles
  exactly once. A bare re-challenge from a lost session should no longer
  occur; if one appears, it is a regression, not a known mode.

  Note this is detected by the challenge's `error` reading the x402 default
  `"Payment required"`, **not** by the key being absent: the `PaymentRequired`
  shape always carries an `error`, so a merchant response with no `error` key
  never occurs in practice.

A run that overlaps a dev merge can therefore go red without anything being
wrong with the code. Re-dispatch once the deploy settles before investigating
further.

Do not infer the cause from timing or from which legs failed: legs whose
invariant is "the merchant did *not* settle" (`x402-delegation-3009-sweep`)
**pass** against a merchant that is broken in this way, because a broken
merchant and a deliberately non-settling one look identical to them.

### A merchant 402 that the chain says was paid

Before treating an x402 failure as a money-path defect, **check the chain**. On
2026-08-17 `x402-settle` (since removed — see below) and
`x402-delegation-3009` failed for hours while the
money moved correctly end to end: funding Safe→delegate, then settlement
delegate→merchant, both `Success`, delegate left at zero. Only the merchant's
HTTP status was wrong.

The tell is a `merchant-side fault (ContractFunctionExecutionError)` whose
merchant log shows `ERC20: transfer amount exceeds balance`. That is a
**second** settlement attempt on a delegate the merchant already drained — it
reverts during gas estimation, so it never becomes a transaction and leaves no
trace on-chain. Since #1519 the merchant checks `authorizationState` and
`balanceOf` before submitting and reports both cases in plain language, so this
should not recur; if something like it does, take the funding `tx_hash` from
the QA failure line and look at what follows it on the delegate's ERC-20 tab
before assuming Haven is at fault.

### GitHub warning about actions using Node 20

This runner warning is not a harness failure. The repository uses Node 24 for
project commands; update third-party action versions separately when supported.

## Related documentation

- [`packages/qa-agent/README.md`](../../packages/qa-agent/README.md) — package and scenario details
- [`e2e-qa-runbook.md`](./e2e-qa-runbook.md) — manual agent/merchant coverage
- [`dev-environment.md`](./dev-environment.md) — shared dev topology
- [`promoting-dev-to-main.md`](./promoting-dev-to-main.md) — promotion checks
