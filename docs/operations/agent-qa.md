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
last-verified: "2026-08-18" # #1533/#1534: the legacy-rail `x402-settle` and `x402-sweep-recovery` legs removed — x402 coverage is delegation-rail only; the scenario table is now eleven legs (matching the count the prose already claimed). Reviewer correction: this is an ACCEPTED COVERAGE LOSS, not a deduplication — the legacy x402 execute branch now has no live leg; the "sixth scenario" ordinal is replaced by the scenario name so it cannot drift again. Prior: #1530: the preflight now reports every consumable resource before the first leg and refuses to run when one is below floor; the demo-merchant settlement wallet is added to the funding table it was missing from, and its balance is read from the merchant's own /healthz because the address derives from SETTLEMENT_PRIVATE_KEY in the merchant env. No harness credential, target, or scenario semantics change. Prior: #1519: merchant checks authorizationState/balanceOf before submitting, so an already-settled purchase serves the goods instead of 402ing a paid buyer; Troubleshooting gains "a merchant 402 that the chain says was paid". Prior: #1517: merchant faults are reported (and logged) as faults rather than collapsing to "Payment failed"; Troubleshooting now covers three 402 shapes — rejection, fault, bare challenge. Prior: #1516 added the merchant-reason surfacing; #1457: x402-erc7710-hosted added (default topology, hosted MCP + local signer) alongside the SDK leg — the same settlement through HavenClient, asserting the delegate EOA stays unchanged; hosted-topology variant waits on #1456. Prior: re-verified for #1312 (guided catalog purchase QA leg added)
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
| **Demo-merchant settlement wallet** | **Base Sepolia ETH** | **Submits `transferWithAuthorization` / `redeemDelegations`. Derived from the merchant's `SETTLEMENT_PRIVATE_KEY`; NOT the receiving wallet** |

Ordinary payments and sweep recovery do not require delegate gas. The delegate
signs off-chain; the relayer submits both constrained Safe transfers and the
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
  ✓ legacy delegate residual (USDC) 0x1a64…14F1: 0.0 USDC
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

The deterministic harness runs eleven scenarios in order:

| Scenario | Expected result |
|---|---|
| `within-budget-settle` | A 0.1 USDC payment settles on-chain and has a receipt |
| `over-budget-queue` | An over-budget payment queues for approval and does not execute |
| `x402-over-budget-rejected` | An unaffordable x402 request is rejected before a signable intent |
| `x402-delegation-3009` | A **delegation-rail** agent pays an EIP-3009-only merchant through the funding-leg bridge (#946); the evidence row must show `settlement_scheme = eip3009` and the funding transfer going to the delegate EOA, the treasury must decrease, and no residual may sit at or above the 1 USDC sweep floor. **Skips** without `QA_DELEGATION_*` |
| `delegation-lifecycle` | Authority can be TAKEN AWAY: on a **throwaway per-run identity** (funded ~0.006 USDC from the standing delegation identity, then abandoned) — grant → activate (relayer-deploys) → within-budget payment settles → replace leaves **exactly one** active row (the #1053-finding-4 transactional-activate regression) → owner-signed revoke → the same payment shape is refused **403 "no active budget delegation"**, never a 502 (a 502 would mean authority was still offered to the chain). Ephemeral keys, all signing client-side |
| `x402-erc7710-settle` | The delegation rail's PRIMARY x402 path: authorize (payTo = merchant) builds a narrowed child delegation, the delegate signs it, `POST /x402/:id/settle` wraps the header, and the MERCHANT redeems `[child, budget]` on-chain — treasury pays the merchant **directly**, budget metered by the settlement itself (treasury −amount exactly), **delegate EOA untouched** (no funding leg — the #713 stranded-funds class structurally absent). Needs `MERCHANT_X402_ERC7710=1` + `MERCHANT_ERC7710_DELEGATION_MANAGER` on the dev merchant; skips (→ run FAILS under #1066) with that exact remedy when the merchant is 3009-only |
| `x402-erc7710-sdk` | The same settlement through **`HavenClient`** instead of the raw API (#1457). The leg above deliberately excludes the SDK, so it stays green whether or not Haven's own client works; this one drives `settleX402Erc7710()` end to end and asserts the same money proof — treasury −amount exactly, merchant +amount exactly, **delegate EOA unchanged**. That last assertion is the point: a silent reroute to the EIP-3009 bridge would still deliver the goods and still debit the treasury, and would only be visible in the delegate's balance. Needs `QA_DELEGATION_DELEGATE_PRIVATE_KEY` (the SDK signs in-process, unlike the hosted topology). The hosted MCP + local signer variant waits on #1456 |
| `x402-erc7710-hosted` | The same settlement through the **default topology** — hosted MCP + local edge signer, what `npx @haven_ai/connect` installs (#1457). The two legs above cover the raw API and the SDK; neither exercises the hosted boundary, where the server must never hold a delegate key and the signature has to come from the local signer. Asserts the hosted quote **reports** `settlement_scheme: erc7710` (a silent reroute to the 3009 bridge would still deliver the goods), that settle reports **no funding tx**, and that the delegate EOA is unchanged. Signs with `haven_sign` rather than `haven_sign_x402` — the latter builds an EIP-3009 header this scheme has no use for. Ordered right after `x402-hosted-mcp-signer` so a failure is diagnosable against a topology that leg has already shown healthy |
| `x402-delegation-3009-sweep` | The other half of the bridge: a delegation-rail 3009 payment the merchant **verifies but never settles** strands funds on the delegate EOA, and the gasless sweep returns them to the treasury. Needs `MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb` and `SWEEP_MIN_USDC=0` on dev; **skips** rather than fails when either is unset, since a settling merchant is an unmet precondition, not a regression |
| `x402-hosted-mcp-signer` | The **default user topology** (#1154): the DEPLOYED hosted MCP over HTTP plus a local `@haven_ai/signer` edge signer in-process — `haven_pay_mcp_tool` → local `haven_sign_x402` → `haven_settle_mcp_tool` → merchant settles. Asserts the quote is a **v2 (delegation-rail) context** (a v1 quote FAILS the leg: the #1138 seam would have gone untouched), that the signer really signed it, that **both** on-chain legs confirmed as distinct `status = 1` transactions, that the treasury fell, and that the delegate residual is **unchanged** (exact-amount funding nets to zero). Needs `QA_HOSTED_MCP_URL` + `QA_X402_BINDING_SIGNER` on top of `QA_DELEGATION_*`. **Skips** (#1441) when the hosted quote comes back **erc7710-shaped**: #1450's preference rule selects erc7710 whenever the merchant advertises it, and this leg's invariant is the FUNDING-LEG one, so against such a merchant it is unreachable rather than violated. Nothing goes uncovered — hosted erc7710 is `x402-erc7710-hosted`, hosted 3009 is `x402-catalog-guided-purchase` (same topology, both on-chain legs, zero residual). What this leg alone still covers is the `haven_pay_mcp_tool` ENTRY POINT on the funding path; point it at a merchant that does not advertise erc7710 to exercise that, and note `QA_REQUIRE_ALL_LEGS=1` turns the skip into a run failure |
| `x402-catalog-guided-purchase` | The **GUIDED catalog purchase path** (epic #1305, #1312): resolves a catalog entry via `GET /catalog` (never a hardcoded id), calls `haven_prepare_catalog_purchase(catalog_id, max_amount | max_amount_human)`, signs with the local edge signer by **`payment_id`** (#1355 — the harness also sends `payment_required`, exercising the pre-#1355 fallback path alongside the new context-fetched one), then settles with `haven_settle_mcp_tool` using **only `payment_id` + `signature` + `payment_header`** — never re-sending `merchant_url`/`tool_name`/`arguments`/`mcp_transport` (that re-threading is exactly what the epic exists to eliminate; needing it FAILS the leg, does not soften it). Asserts the preflight is COMPACT, carries the #1308 machine-readable next step and a rail-labeled allowance block, marks the catalog price indicative next to the live amount, and that the settled response carries the #1310 post-purchase allowance block. Buys NordShield VPN Basic (`buy_vpn`/`{plan:"basic"}`) — a SETTLING product; never CloudNest 50 GB, which is dev's verify-without-settle sweep fixture. Same env as `x402-hosted-mcp-signer` (`QA_HOSTED_MCP_URL`, `QA_X402_BINDING_SIGNER`, `QA_DELEGATION_*`, `QA_DEMO_MERCHANT_URL`) — no new secrets. **Skips** (not fails) when no catalog row matches on dev (#1299 seed not applied) or the hosted MCP does not yet expose `haven_prepare_catalog_purchase` (pre-#1306 deploy) |

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
QA_AGENT_API_KEY=<testnet QA agent API key>
QA_DELEGATE_PRIVATE_KEY=<throwaway Base Sepolia delegate key>
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
variable; do not write `# QA_AGENT_API_KEY=...`.

#### Seeding the delegation-rail identity (`x402-delegation-3009`)

The `x402-delegation-3009` scenario needs a **second agent**, because the
execution rail is a property of the account: no header makes the seeded legacy AllowanceModule agent
exercise the delegation rail. Without the two `QA_DELEGATION_*` values the
scenario **skips** — it never fails the run for being unconfigured.

That agent must have an **open (unpinned) budget delegation**. A
recipient-pinned budget cannot fund the delegate EOA, and per the owner decision
of 2026-07-15 we do not weaken a pin for interop — so pinned agents are
erc7710-only by design, and pointing this scenario at one produces a legitimate
failure, not a misconfiguration.

Provision it the same way the 2026-07-18 live proof did:

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
guided contract end to end: a compact preflight, the #1308 machine-readable
next step, a rail-labeled allowance block, signing by `payment_id` (#1355 —
`payment_required` rides along as the pre-#1355 fallback), and settling with `payment_id` + `signature` +
`payment_header` alone — proving `haven_settle_mcp_tool`'s #1307 rehydration
actually serves the merchant context rather than merely documenting that it
does.

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
- `QA_AGENT_API_KEY`
- `QA_DELEGATE_PRIVATE_KEY`
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

Like the branch-source gate, `qa-freshness` is **advisory until added to `main`'s
required status checks** in branch protection. It needs the `QA_*` secrets
configured (so the scheduled run can go green) before it's enforced.

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
> 3. Use direct `haven_pay` for an amount **over** the remaining budget → expect
> it to queue for approval, not execute.
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
  connect-agent modal, and approvals; look for horizontal overflow (the
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
> modal, and approvals — **observe only; do not connect an agent, approve/reject, or
> send a payment** (the shared dev identity is used by other QA runs). Look for:
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

## Troubleshooting

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
for name in QA_HAVEN_API_URL QA_AGENT_API_KEY QA_DELEGATE_PRIVATE_KEY QA_PAYMENT_TO QA_DEMO_MERCHANT_URL \
            QA_DELEGATION_AGENT_API_KEY QA_DELEGATION_DELEGATE_PRIVATE_KEY \
            QA_HOSTED_MCP_URL QA_X402_BINDING_SIGNER; do
  printenv "$name" >/dev/null && echo "$name: present" || echo "$name: MISSING"
done
```

The last four are optional to the config loader but required for the delegation
and hosted legs; a run with `QA_REQUIRE_ALL_LEGS=1` goes red if any is missing.

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

  The bare-challenge shape above is still reachable, for the OTHER half of the
  lost state: an unknown MCP **session id**. That is a plain re-challenge with
  no money moved, so re-dispatching is the whole remedy.

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
