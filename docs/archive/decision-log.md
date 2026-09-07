---
owner: "@d-hinders"
status: archived
covers: []  # narrative — no direct code mirror
last-verified: "2026-09-07"
---

# Decision Log

Append-only record of the decisions that produced Haven's current rules, newest
first. It exists so [`CLAUDE.md`](../../CLAUDE.md) can state the rule and this
file can carry the chain of issue numbers, superseded owner decisions and
retirement closures behind it. When that file was cut down to an operating
manual (#2639), its history moved here rather than being deleted — with three
deliberate exceptions, named under *Judged obsolete rather than relocated*
below.

Read this for *why a rule is what it is*, or to find a paragraph by issue
number. Read `CLAUDE.md` for what the rule **is** today: where the two differ,
`CLAUDE.md` and the code win. Entries are historical records; a superseded
decision is kept, marked, and never silently rewritten.

Two caveats a reader should carry. Some entries describe code in the present
tense — the surviving `rails/allowance-module.ts` exports, the open routes — and
because this doc is `archived` with `covers: []` it is outside **both** the
coupling gate and the weekly staleness audit, so **nothing re-checks those
sentences when the code moves**; verify against the code before relying on one.
Closing that properly — citing the test behind each such claim, or dating it — is
[#2670](https://github.com/d-hinders/Haven-AI/issues/2670). And the move out of `CLAUDE.md` was not perfectly lossless: three
passages were judged obsolete rather than relocated, and are named where they
belong below.

## Index

| Date | Decision | Refs |
|---|---|---|
| 2026-09-04 | `latest` dist-tag moves onto every release, prereleases included | #2536, #2647 |
| 2026-09-02 | Haven stops rendering legacy Safe accounts at all | #2413 |
| 2026-08-27 | Agent Passport is issued on the delegation rail only | #2138 |
| 2026-08-21 | The independent reviewer pass runs on every PR, full stop | — (rule lives in `CLAUDE.md`) |
| 2026-08-15 | Prefer erc7710 over the EIP-3009 bridge when the merchant advertises it | #1450 |
| 2026-08-14 | Retire the Safe rail entirely — deletion, not a freeze | #1440 |
| 2026-08-14 | Passkey removal aligned with the one-signer policy | #1199, PR #1420 |
| 2026-08-07 | Single-signer accounts are permitted; the ≥2 floor becomes a recommendation | #1153, #908 |
| 2026-07-15 | Recipient-pinned budgets are erc7710-only | — (recorded in `modules/x402/delegation-authorize.ts`) |
| 2026-07-12 | Session rail retired outright; AllowanceModule import-only | #834 (AllowanceModule half superseded) |
| — | Approval-queue history readability waived | #2021, #2055 |
| — | Historical: POC scope and phased roadmap | — |

---

## 2026-09-04 — `latest` follows every release, prerelease included (#2536)

A bare `npm install` / `npx` resolves the `latest` dist-tag and never the
highest version number, so a run of prereleases leaves `latest` behind: this is
how `npx @haven_ai/connect` came to install a build 34 releases old. The owner
decided on 2026-09-04 that a prerelease publish also points `latest` at itself.
The prerelease tag stays, so `@alpha` keeps resolving.

Mechanism and the canonical record:
[`docs/operations/agent-discovery-listings.md`](../operations/agent-discovery-listings.md)
§ *The `latest` dist-tag*.

**Why the release rule says "verify with `npm view`, not a green workflow"
(#2647).** The tag move is a separate `main`-only `promote-tags` job with its
own npm token, because Trusted Publishing authorises `npm publish` and nothing
else. A promotion can therefore be *half green* — published, `latest` unmoved.
The 0.1.35-alpha.0 release published all five packages and failed all five tag
moves with E401. Re-run that one job rather than cutting a new version.

## 2026-09-02 — retirement is deletion, not accommodation (#2413)

Epic #1440 originally promised that legacy Safe accounts and balances stay
**readable**: `GET /user/safes`, rename, re-default, unlink and balances
untouched, a legacy account rendering in full with an inert `RetiredRailNotice`
where the spend action used to be. Three later narrowings ended that, the last
effectively for good:

- **#2020** reversed the `GET /machine-payments/allowances` half — 410 on the
  retired rail.
- **#2055** removed the approval queue's history from transaction, x402 and
  activity reads (owner call on #2021). Evidence rows preserved; approval-executed
  legacy payments no longer appear in history responses.
- **#2413** stopped Haven rendering legacy accounts at all, on the owner
  decision of 2026-09-02. Six list queries — the three account lists, the agent
  list and the two dashboard lists — filter to `account_type =
  'delegator_hybrid'`, so `GET /user/safes` returns no legacy account and the
  agent list returns none of their agents. `RetiredRailNotice` is deleted along
  with every `account_type` branch behind it.

Read the readability promise as history: the rows are untouched and a direct
database query still finds them, but no account, agent or dashboard surface
displays them and nothing on-chain changed. **`GET /transactions` is NOT among
the six** — neither `LIST_BASIC_SAFES_FOR_USER_SQL` nor
`LIST_AGENTS_FOR_TRANSACTION_FILTERS_SQL` carries a rail predicate, so
transaction history still spans every account and agent row and legacy names
still render in that screen's picklists (#2669, found by review after the first
sweep read "no Haven surface" as complete). Dropping the rows outright remains a separate, still-open
decision, blocked on `payment_intents`' RESTRICT foreign key.

## 2026-08-27 — the Agent Passport is delegation-rail only (#2138)

Passport issuance was never gated by rail, so a legacy-rail agent could hold
one — and a retired rail cannot transact, so there is no spending for a contract
to govern. The owner decided on 2026-08-27 that issuance is delegation-rail
only. Passports **already issued** on a legacy account are deliberately left
alone and report `policyEnforcedOnchain: false`; no sweep was authorised.

## 2026-08-21 — the reviewer pass runs on every PR

The one piece of history that is also a live rule, so it is **not** moved here:
the verbatim owner decision stays in [`CLAUDE.md`](../../CLAUDE.md) §
*How shipping is governed*, beside the rule it produced. Recorded here only so
the index is complete.

## 2026-08-15 — prefer erc7710 over the EIP-3009 bridge (#1450)

> **Owner decision (#1450, recorded verbatim):** "Prefer erc7710 whenever the
> account is on the delegation rail and the merchant advertises
> `extra.assetTransferMethod: "erc7710"`; fall back to the EIP-3009 bridge
> otherwise. Decided by the owner in-session 2026-08-15."

The reason is structural, not aesthetic: erc7710 has **no funding leg**, so the
entire stranded-delegate-funds class — hot balances, sweeps, the
delegate-balance monitor, epic #713's reconciliation — is *absent* on the
preferred path rather than something Haven keeps reconciling. Recipient-pinned
budgets were already erc7710-only, so they stop being a special case and become
the ordinary one.

What it does **not** change: the backend still selects the scheme from the
authorize request's payTo shape and clients still say so explicitly with
`settlementScheme` (#1360); and merchants have not caught up — facilitator-side
erc7710 support is still thin, which is why the 3009 bridge stays. What changes
is which scheme a *client* reaches for first when the merchant supports both.
Epic #1450 makes that reachable from the SDK, the local signer and the hosted
MCP tools.

## 2026-08-14 — retire the Safe rail entirely (#1440)

> **Owner decision (2026-08-14, #1440):** *we no longer build on Safe — the
> entire rail is to be retired, not just frozen.*

This superseded the AllowanceModule half of the #834 decision below. There is
no import-only path: import answers 410 like every other inflow, and the rail
cannot spend.

### The closures, in order

- **#1984 shut the INFLOW.** All four Safe inflows answer HTTP 410 —
  `POST /safe/deploy` (passkey-owned), `POST /user/safes/deploy`
  (wallet-owned), `POST /user/safes` (import) and the legacy `PUT /user/safe`
  link. Signup provisions a passkey-owned Hybrid DeleGator unconditionally via
  `POST /accounts/hybrid`; the `NEXT_PUBLIC_DELEGATION_ONBOARDING` dark-launch
  flag of #886 is gone with the fork it used to choose.
- **#1986 shut the SPEND.** An account marked
  `execution_rail='allowance_module'` — or carrying no Safe row at all, which
  resolves the same way — gets HTTP 410 from `POST /payments`,
  `POST /payments/:id/sign`, `POST /x402/authorize`, `POST /x402` and
  `POST /machine-payments/send`, fail-closed with nothing written. The refusal
  precedes the allowance read, so no chain call is made and no intent row is
  written.
- **#1987/#1988/#1989 deleted the machinery.** The AllowanceModule execution
  half and the allowance-nonce coordinator, the legacy x402/MPP orchestration
  and off-chain coverage arithmetic (#1987); the Safe-deploy implementation,
  both deployers, the owner-change builders and the five approver routes
  (#1988); and every legacy Safe screen — Send modal, approval queue,
  Approvers, `/approvals` (#1989).
- **#2259 closed the last activation path.** It deleted
  `POST /agent-connection-setups/:id/wallet-approval` and the status-GET
  reconciliation that also activated an agent from a live on-chain allowance, so
  no Haven path activates a retired-rail agent any more.
- **#2055 removed the approval queue outright.** `routes/approvals.ts` deleted
  and `/approvals` deregistered (404, superseding #1986's readable-and-rejectable
  410 interim); the INSERT helpers died with
  `infra/repositories/approval-requests.ts`; migration 070 dropped the
  `approval_requests` table itself.

### What deliberately survives, and why

This is the half a sweep gets wrong in the direction of overclaiming.

- **`rails/allowance-module.ts`, trimmed to reads-only.** Its three surviving
  exports are not AllowanceModule code at all and each has live consumers —
  the lists below are the ones the retirement enumerated, **not an exhaustive
  census**, and more have been added since (`haven-reviewer` found four on
  2026-09-07: `modules/x402/settlement-sweeper.ts`,
  `infra/chain/redeemed-delegation-scanner.ts`,
  `infra/chain/settlement-transfer-verifier.ts` and `routes/agents.ts`). The
  authoritative roster is the assertion in
  `packages/backend/src/testing/__tests__/mock-factory-exports.guard.test.ts`.
  `getRelayerWallet` → `rails/sweep.ts`; `getTokenBalance` →
  `infra/delegate-balance-monitor.ts`, `modules/mpp/sweep.ts`,
  `modules/mpp/evidence.ts` and `routes/agent-rekey.ts`'s residual-hot-balance
  check; `getProvider` → `infra/chain/ethers-client.ts`,
  `modules/accounts/portfolio.ts` and `safe-details.ts`. `lib/safe-tx.ts`
  survives the same way on the frontend.
- **Sweep machinery** (`POST /machine-payments/sweep/prepare` and `/submit`).
  Sweep moves stranded delegate balances *back* to the user's account; closing
  funds recovery alongside spending would strand exactly the money this
  retirement exists to make safe. It is also shared with the live #946
  EIP-3009 bridge, so it is not residue of the retired rail.
- **`POST /safe/exec`**, owner-signed and relayed for gas only.
- **The typed rail seam** (`rails/execution-rail.ts`), for reversibility.

### Legacy passkey-Safe recovery (#1229) — narrowed by #1989

A passkey Safe is deployed single-owner, threshold 1, so its only recovery was
preventive: a second owner added while the first passkey still worked, via
**Approvers**. That surface is deleted with the rest of the Safe-creation
machinery — Haven neither signs nor now constructs an owner change.

What this does and does not mean. `POST /safe/exec` stays **open**, so any
owner-signed Safe transaction — moving funds out included — still executes, and
a passkey already enrolled as an on-chain owner still authorises there against
the Safe's live owner list (the `credential_id` field migration 056 made
possible). **What #1989 removed is the SCREEN, not the route**, and that
distinction decides who is actually self-served: the legacy Send modal is
deleted, so nothing in the dashboard composes an arbitrary Safe transfer any
more. A **wallet-owned** Safe loses nothing real — its owner signs at Safe's own
interfaces. A **passkey-owned** Safe has no such fallback, because Haven's
passkey Safe signer is a custom WebAuthn scheme Safe's interfaces do not
understand: the signing plumbing survives in `lib/safe-tx.ts` and
`POST /safe/exec`, but no product surface drives it.

Accepted as a narrowing because the epic's census found **no passkey-owned
Safe** — stated here rather than glossed, because "the route is open" is not the
same as "the user can do it".

**What the census is, exactly:** an enumeration of the 15 Haven-deployed Safes
on **Base mainnet**, current as of the deletion merges — 13 distinct external
owner EOAs plus **one relayer-owned Safe** (`0xa0e9…0eb9`, wound down as its own
step, #1985). It is **not a proof** and it does **not** cover the dev, staging
or testnet populations (the epic separately counted 7 dust Safes on Base Sepolia
and 1 Gnosis pilot import). The population can only shrink, since
`POST /safe/deploy` has answered 410 since #1984 — but "can only shrink" is not
"is empty". Where a Safe *is* owned by an external EOA, that owner adds or
removes owners directly through Safe's own interfaces with their own key —
Haven must never be the only path to that, and is not. A lost passkey with no
backup remains unrecoverable **on-chain**, by the user and by Haven, exactly as
before. User-facing wording:
[`docs/product/account-recovery.md`](../product/account-recovery.md).

### Historical Safe references

Retained because they are where an EOA owner of a legacy Safe manages it
independently of Haven, and for reading the retired code:
[Safe docs](https://docs.safe.global),
[Safe modules](https://docs.safe.global/advanced/smart-account-modules),
[Safe guards](https://docs.safe.global/advanced/smart-account-guards).

## 2026-08-14 — passkey removal aligned with the one-signer policy (#1199)

#1153 relaxed the ≥2-signer floor on `remove_owner` but deliberately scoped
itself to that action, leaving `remove_passkey` with its own inline floor. The
asymmetry was recorded as an open question and closed by PR #1420 on
2026-08-14, taking option 1 on the issue: **match `remove_owner`**.

Both actions now refuse exactly one thing — the removal that would leave the
account with **no signer at all** — mirroring the `CannotRemoveLastSigner`
invariant the account enforces on-chain
(`packages/backend/src/rails/hybrid-signer-actions.ts`). There is no Haven-side
≥2 floor on either action, on any chain.

`CLAUDE.md` carried the pre-#1420 sentence ("`remove_passkey` still refuses to
drop below two, on every chain") for 24 days after this landed. It survived
because `hybrid-signer-actions.ts` was not in that file's `covers:` list; #2639
corrected the sentence and added the file.

## 2026-08-07 — single-signer accounts are permitted (#1153)

> **Owner decision (2026-08-07, recorded verbatim on #1153):** "convert this
> from a block to a warning instead, the user should be able to move to a one
> signer set up."

Haven's own ≥2-signer floor was a *gate* under #908 and became a **post-funding
recommendation**, because a wall at onboarding blocked the one-Face-ID flow at
the moment a user has nothing at risk. Nothing refuses a single-signer account
now: not provisioning, not grant activation, not `remove_owner`.
`modules/accounts/mainnet-gate.ts` classifies
(`needsBackupSignerRecommendation`) rather than gates, and
`user_safes.single_signer_waiver_at` (migration 046) is recorded as history,
required for nothing.

The consequence is delivered where a human can read it: the dashboard requires
an explicit confirmation naming what is lost before it calls. An
`acknowledge_single_signer` flag was rejected on the issue — it is still a block
to any non-UI caller, which is the thing being removed.

The account itself still enforces ≥**1** signer on-chain
(`CannotRemoveLastSigner`); dropping to zero bricks the account rather than
merely making it unrecoverable, which is a different guard and was never
relaxed.

## 2026-07-15 — recipient-pinned budgets are erc7710-only

3009-mode structurally requires an **open (unpinned) budget**: a
recipient-pinned delegation cannot fund the agent EOA. Rather than special-case
it, pinned agents are erc7710-only
(`modules/x402/delegation-authorize.ts`). Owner decision, 2026-07-15.

## 2026-07-12 — session rail retired outright (#834)

> **Owner decision (#834, recorded verbatim) — SUPERSEDED for the
> AllowanceModule half:** "Legacy AllowanceModule stays as an IMPORT-ONLY path
> for existing Safes (dev-pilot); no new accounts get it. Sweep machinery and
> the delegate-balance monitor stay while any funding-leg rail lives. Session
> rail retired outright — zero external customers, retirement not migration.
> Decided by the owner in-session 2026-07-12."

**Superseded by the owner decision of 2026-08-14 (#1440)** for the
AllowanceModule half only. The sweep and delegate-balance-monitor clause
**still stands** and is why both survive — the #946 EIP-3009 bridge is a live
funding-leg rail. The session-rail clause is unchanged.

The Smart Sessions / ERC-7579 session-key rail is retired outright: its backend
modules are deleted, and accounts still marked `execution_rail='session_key'`
get HTTP 410 (fail-closed, nothing written) from `POST /payments` and the x402
machine-payment path. The session-rail `agent_recipients` table and route were
dropped in #880, dead after this retirement.

Reference for the retired rail:
[Rhinestone Smart Sessions](https://docs.rhinestone.dev/home/concepts/session-keys).

## Judged obsolete rather than relocated (#2639)

Three passages of the pre-#2639 `CLAUDE.md` were **not** carried into either
file, recorded here so each omission is a decision rather than an accident.

1. *"Legacy AllowanceModule records remain readable only; Haven offers no
   re-onboard, pause/resume, re-key, or revoke controls for them. Owners manage
   any remaining Safe permission outside Haven where they have access;
   replacement agents use the live delegation flow."* Obsolete since #2413: no
   account, agent or dashboard surface renders a legacy account or its agents, so a list of
   controls Haven declines to offer for them describes a screen that does not
   exist. The surviving half — an EOA owner manages their Safe at Safe's own
   interfaces — is stated under #1440 above.
2. The `## Architecture — Five Components` section — the component diagram, the
   *Haven Control Layer* responsibility list and the *Protocol Adapters* list.
   An operating manual states the live architecture, which the delegation-rail
   paragraph does. The nearest live equivalent is
   [`docs/architecture/01-system-context.md`](../architecture/01-system-context.md),
   which `CLAUDE.md` now links — but read it knowing what it is and is not: it
   carries the **trust boundaries** well, its decomposition is by deployed
   component (web app / hosted MCP / backend / relayer / local signer) rather
   than by the *Haven Control Layer* / *Protocol Adapters* split this section
   used, and its primary diagram is flagged in that doc as the RETIRED
   baseline. Named by `haven-reviewer`, because "the component model is
   maintained there" was more than the target supports. Named here because haven-reviewer found it
   dropped rather than declared, which is a different thing from dropped.
3. The `private: true` workspace-pin rationale in full (the `mcp-server`
   misclassification narrative and the npm-version-dependent `npm ci`
   mechanism). The rule and its dividing line are in `CLAUDE.md`; the full
   reasoning is in [`scripts/README.md`](../../scripts/README.md), which
   `CLAUDE.md` links, and in `docs/regulatory/casp-changelog/2026-08-17-1526.md`.

## Approval-queue history readability waived (#2021 / #2055)

The #2021 owner decision waived queue-history readability, which is what let
#2055 delete the routes and drop the table. The no-DELETE-first foreign-key
discipline preserved every evidence row.

## The `agent_allowances` mirror is gone (#2020 / #2263)

The `allowances` array on an agent has been a derived **view** since #1090,
projected from the agent's active `agent_delegations` rows. The
`agent_allowances` table was a mirror of it: #2020 deleted its last writer
(`copySetupAllowancesToAgent`) and #2263's migration 075 dropped the table
itself, so there is no mirror left to be out of step with the view.

**The two `allowance_amount` shapes.** The field on the derived view is
human-decimal (`rails/delegation-budget-view.ts` builds it with
`formatTokenValue`); the identically named field on the connect-setup schemas is
atomic. The OpenAPI spec names them apart as `allowanceHumanAmount` /
`allowanceAtomicAmount` (#2295) and, since #2408, **tells them apart**:
`formatTokenValue` emits only `"0"` or `<integer>.<2–6 fraction digits>`, so the
human pattern is `^(0|[0-9]+\.[0-9]{2,6})$` and rejects an atomic `"500"`. `"0"`
is the one value both shapes share, and it is genuinely the same number in both.

Two things this does **not** license: a consumer must never *sniff* the shape at
runtime — the discrimination is an assertion about one known emitter, not a
property of the string — and nothing on the wire changed. The pattern is a guard
that catches an emitter drifting to atomic, which is what #2392 measured
slipping through.

## Base became the runtime default, not only the documented one (#990)

`DEFAULT_CHAIN_ID` in `@haven_ai/core` is the single home for it. Migration
`034_base_default_chain` set the `user_safes`, `payment_intents` and
`approval_requests` column defaults to Base for future rows — existing rows keep
their stored chain, so a live Gnosis Safe stays on Gnosis. A guard test flags
new bare numeric chain fallbacks in the shapes it covers (`??` / `||` including
quoted, default bindings, ternaries, `if (!x) x =` conditional assignment, SQL
`COALESCE`, and trailing call/SQL args for the unambiguous Base ids), widened by
#1046, which also line-scoped the allowlist and extended the scan to
`packages/core`. It is a partial net whose limits are documented in the guard
itself, not a closed guarantee.

Two deliberate exceptions survive. `routes/hybrid-accounts.ts` still defaults to
Base **Sepolia** (`chain_id ?? 84532`) — a leftover of the #745 dark-launch
wiring, **not** a live dark launch: #1984 removed
`NEXT_PUBLIC_DELEGATION_ONBOARDING` and onboarding is unconditional, so callers
pass the chain explicitly and the fallback is vestigial. And
`HAVEN_DEPLOY_CHAIN_IDS` (#679) separately scopes which chains a deployment will
*serve* — a default is what you get when you say nothing; the served set is what
you may ask for.

## The closing keyword reaches three surfaces (#2276 / #2320 / #2382)

Why `CLAUDE.md`'s branch-model callout says to write the closing keyword
**bare**, on the body, the title and the commit messages alike.

- **#2276** — PR #2272 merged with `Closes` in its body and closed
  [#2268](https://github.com/d-hinders/Haven-AI/issues/2268), the very issue
  three separate written promises said would stay open. `Closes` is a GitHub
  keyword, not prose.
- **#2320** — PR #2314, which introduced the close guard, had a blameless body
  (it closed only its own issue, #2276) and closed #2268 **again**, from a
  commit message that merely *described* the original incident. GitHub honours
  the keyword in every commit message that reaches the default branch, and via
  the squash subject in the pull-request title. The guard reads all three.
- **#2382** — the opposite failure: a code span suppresses the keyword in a
  rendered **body** but not in a raw **commit message**. PR #2364 carried a
  backticked keyword, `closingIssuesReferences` was empty, nothing linked at the
  merge, and the issue was closed by hand. So the two surfaces fail in opposite
  directions and **bare** is the only form that behaves the same everywhere.

Mechanism and the incidents in full:
[`docs/contributing/autonomous-pr-loop.md`](../contributing/autonomous-pr-loop.md).

## Design-quality workflow v2 — what each gate learned (#904)

- **Visual regression (#2318, #2635).** The clause once said "`/design-system`
  is pixel-compared", while the job had run every `e2e/**/*.visual.spec.ts`
  since #897/#1863 — the direction that matters, because it is the sentence a
  reader uses to decide what a green tick licenses. #2318 named the real set and
  made the job print the baselines it actually compared
  (`scripts/ci/visual-baseline-inventory.mjs`); a screen absent from that list
  has no baseline at all. #2635 then **removed** the whole-page `/design-system`
  capture: it dominated the job's failure history — 5 of a 12-failure sample as
  first counted, 7 of 12 when review re-derived it — and it failed on **diff
  magnitude**, stable diffs of 1% to 23% of the image on branches unrelated to
  the page, which is non-determinism no timeout closes.
- **Rendered review (#2636).** "A finding from either pass pauses auto-merge"
  was a blanket rule; it now pauses on `blocking` or `should-fix` and not on a
  `nit`, and the evidence capture narrowed to three triggers. Corrected in
  `CLAUDE.md` *before* #2639 rather than during it, on `haven-doc-reviewer`'s
  reasoning: #2639's acceptance criteria forbid changing any rule's meaning, so
  a stale sentence left standing would have been faithfully relocated into the
  new operating manual rather than corrected — locking the error in.
- **Design-system coupling (#898, #1023).** Blocking on every PR with a sticky
  comment explaining the finding.
- **Cold-agent QA (#2538).** The weekly `qa-explore-ui` cadence gained a second
  scenario pointing the other way — a fresh agent given only a dev URL, scored
  on whether it can get its user set up. Both are owner-armed Routines, never CI
  jobs; the cold one additionally *cannot* be a CI job, because an agent inside
  this repository's own runner is not cold and its discovery score would stop
  meaning what it says.

## Historical — the POC scope and success criteria

The original Safe-rail POC feature set, delivered and since re-based. Items 2,
6, 7 and 9 describe flows that are now retired (see #1440 above): Safe
import/linking answers 410, the legacy Send screen and the Safe
owner-management surface are deleted, and per-token AllowanceModule allowances
are no longer the policy primitive. Read it as what was proven, not as what to
build.

1. User account creation and authentication
2. Safe import / linking on Gnosis Chain (users bring an existing Safe)
3. Dashboard with linked Safes and consolidated balances
4. Inbound/outbound transaction history
5. Token balance view with main balance denomination
6. Manual transaction sending (connected wallet signing)
7. Agent creation with per-token on-chain allowances
8. Agent credential (API key) generation and management
9. Safe owner management (minimal in current UI)
10. Contact naming / address book
11. x402 payment authorization (agent encounters 402, Haven handles payment)

> **Success criterion, as written:** A developer can sign up, link a Safe, fund
> it, create an agent with on-chain allowances, and have that agent
> autonomously pay for an x402-enabled API call — all through a clean,
> intuitive interface.

## Historical — the phased roadmap

**Phase 1: Core wallet infrastructure (POC)** — delivered, then re-based.
Agent identity and credentials, and the API for agent auth and payments, stand.
Two items were retired by #1440 and replaced rather than completed: on-chain
allowance enforcement via the Safe AllowanceModule with an over-limit auto-queue
(enforcement is now the delegation's caveat enforcers, and over-budget reverts
rather than queueing), and Safe transaction construction and execution (the
account redeems a signed delegation via sponsored UserOps).

**Phase 2: Protocol integration** — x402 client support (shipped), Stripe MPP
integration, category-based policies, receipt/proof management, micropayment
batching.

**Phase 3: Platform and ecosystem** — multi-chain support, merchant-side payment
acceptance, third-party SDK, multi-agent coordination, fiat ↔ crypto bridging.

Category-based, protocol-based and per-hour-rate agent policies belong to Phase
2 and are not implemented today.
