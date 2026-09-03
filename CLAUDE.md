---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/domain/chains.ts
  - packages/backend/src/rails/allowance-module.ts
  - packages/backend/src/middleware/agentAuth.ts
  - packages/backend/src/openapi/spec.ts
  - packages/backend/src/routes/agents.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/safe-deploy.ts
  - packages/backend/src/routes/user-safes.ts
  - packages/backend/src/routes/x402.ts
  - packages/frontend/src/app/globals.css
  - packages/frontend/src/components/ui/Card.tsx
  - packages/frontend/src/components/ui/Row.tsx
  - .github/workflows/dev-gate.yml
  - .github/workflows/publish.yml
  - .github/CODEOWNERS
  - scripts/release-bump.mjs
  - .agents/skills/**
  - .claude/agents/**
  - .claude/commands/**
last-verified: "2026-09-02" # #2408: the *Agent Model* bullet said the two `allowance_amount` shapes cannot be told apart and that `"500"` is legal in both. False about the emitter: `formatTokenValue` returns only `'0'` or `<integer>.<2-6 fraction digits>`, so the `allowanceHumanAmount` pattern now discriminates and the bullet says so, including the two things it does NOT license (no runtime sniffing; no wire change). Scope: that ONE sentence in the `allowances`-is-a-derived-VIEW bullet. Nothing else in this file was re-read or re-verified for this edit. Prior: #2263: the *Agent Model* bullet on the derived `allowances` VIEW said "`agent_allowances` is only written at connection setup and is never read back for display". The written-at-setup half was already false — #2020 deleted `copySetupAllowancesToAgent`, its last writer — and migration 075 in this change drops the table outright, so the sentence described a mirror that no longer exists in either direction. Corrected to say the table is gone and why, keeping the surviving claim (the view is projected from active `agent_delegations`, #1090) unchanged. Scope: that ONE clause; the rest of the bullet (the human-decimal vs atomic `allowance_amount` split, #2295) and nothing else in this file was re-verified in this pass. Prior: #2385: the Branch model callout named the operator-verify `Refs #<n>` form and the three surfaces the keyword reaches, but never said the keyword an author EMITS is bare — while illustrating it inside a code span, as a doc writing ABOUT the keyword must. A reader substituting a real number carries the code span across and lands on exactly PR #2364's body: backticked keyword, `closingIssuesReferences` empty, nothing linked at the merge, the issue closed by hand — the same defect #2382 fixed one layer down in the pull-request template. The callout now states the bare rule for all three surfaces and that its own backticks are the sentence quoting the keyword rather than part of what you write. It also names the ASYMMETRY in ONE clause, pointing at `autonomous-pr-loop.md` for the mechanism rather than restating it: the callout otherwise set #2320's "GitHub honours the keyword in every text that reaches `dev`" directly beside #2382's "a code-spanned keyword in a body is not parsed", and the pair reads as self-contradictory without the reason — a body is rendered Markdown, a commit message is raw text. Both directions rest on direct reads of GitHub's own data, but not by the same hand and not to the same depth, so the attribution is split rather than rounded up: the reviewer read commit `7f7102ff`'s message (backticked keyword) and #2268's timeline (`closed` tied to that SHA, one second after PR #2314 merged) — that half is measured, not inferred. On the body half the reviewer could read PR #2364's backticked body but could not query `closingIssuesReferences` in its session; the empty linkage is this author's own read of #2361's `closed_by_pull_requests` (`total_count` 0), corroborated by the hand-close 109 seconds after merge. The first draft carried the full mechanism here and was cut back on review — this file is loaded into every session, and the incident narrative has a home one link away. No illustration lost its code span: the rule is added, the quoting convention is unchanged. Scope: that ONE callout; nothing else in this file was re-verified in this pass. Prior: #2318: § *Design-quality workflow v2* said "`/design-system` is pixel-compared against committed Linux baselines". The blocking job has run EVERY `e2e/**/*.visual.spec.ts` since #897/#1863 — so the clause named one route while the gate covered several, which is the direction that matters: it is the sentence a reader uses to decide what a green tick licenses. Corrected to name the real set (`/design-system` whole-page and scoped, element clips on `/agents`, and #2318's whole-page `/dashboard` + `/transactions`) and to state the reading rule explicitly — the job now prints the baselines it actually compared (`scripts/ci/visual-baseline-inventory.mjs`), and a screen absent from that list has no baseline at all. Verified against `packages/frontend/package.json`'s `test:visual` (no path filter) and `.github/workflows/ci.yml`, not from the issue text. Scope: that ONE clause in § *Design-quality workflow v2*. NOT re-verified: any other section of this file. Prior: #2320/#2327: the Branch model callout said an operator-verify PR "writes `Refs #<n>` instead" without naming a surface, which reads as a body-only rule. It is not: GitHub honours the closing keyword in every commit message that reaches `dev` and in the title via the squash subject, and PR #2314 closed #2268 from a commit message while its body — verified against the merged pull request, whose `closingIssuesReferences` is `[#2276]` alone — closed only its own issue and was never at fault. The clause now names all three surfaces. Scope: that ONE clause; nothing else in this file was re-verified. Prior: #2276: the Branch model callout stated "issues close on the dev-merge (= implemented)" unconditionally — the same claim #2276 corrected in `branch-and-release-flow.md` and `autonomous-pr-loop.md`, and this gravity file carried it too. It now names the operator-verify exception (`Refs #<n>`, issue stays open). Raised by haven-doc-reviewer as a blocking finding on the #2276 pull request. Scope: that ONE clause; nothing else in this file was re-verified. Prior: #2088: the Code Conventions front-matter bullet said what a new doc under `docs/` needs and implied `npm run docs:new` covers every new doc. It does not scaffold `packages/**` Markdown, which since #2088 carries its own CI-blocking obligation (declare it in `scripts/docs/package-docs.mjs`, governed or exempt-with-a-reason) — so the canonical "what a new doc needs" instruction was silently incomplete for a whole doc population. A second bullet added stating that obligation and that being outside the system is a legitimate answer while not having decided is not. Scope: that one bullet pair only; nothing else in this file re-verified in this pass. Prior: #2138: the Agent Passport bullet described the credential as attesting an agent is "governed by on-chain-enforced controls" with no rail qualifier — universal-sounding, and false for a legacy-rail agent, which could hold an issued passport because issuance was never gated by rail. The owner decided 2026-08-27 that it should be, so the bullet now names the delegation-rail-only rule AND that passports already issued on a legacy account are left alone reporting policyEnforcedOnchain: false — stating only the first half would imply a clean sweep that was explicitly not authorised. Scope: that one bullet in the Agent Passport paragraph; no other component, rail or execution-primitive claim was re-verified in this pass. Prior: #2102: the Haven Control Layer component list said "Execution routing (auto-execute vs. approval flow)", which CONTRADICTED this same file's Agent Model section — "Enforcement is on-chain, and over-budget REVERTS — it does not queue". A file that loads into every session before any work starts cannot disagree with itself about whether an approval queue exists. Restated as auto-execute within the on-chain envelope, declined outside it, pointing at the section that already had it right. Scope: that ONE bullet — the rest of this file was not re-read in this pass. (The bump itself was a review finding: I edited the body and bumped six sibling docs while skipping this one, and chain-integrity does not require a bump on every edit, so it stayed green.) Prior: #1990: epic #1440 slice 7 shipped, and it drops ONE table, not three. The Execution Primitives bullet said the three uncalled `approval_requests` INSERT statements survive "for #1990 to drop with the table"; enumeration found `approval_requests` still has live readers on paths #1986 deliberately left open, so the table STAYS and the INSERTs travel with #2021. `agent_allowances` likewise stays, on #2020. Only `safe_approver_metadata` was dropped. Scope: that one clause. Nothing else in this file was re-verified. Prior: #1992: epic #1440's docs slice. Re-read against the merged code, not the ticket: principles 1-2, the five-component model (Safe -> Hybrid DeleGator as the custody component), Execution Primitives (AllowanceModule bullet rewritten as a retirement record naming what SURVIVES - reads-only `rails/allowance-module.ts`, sweep, the seam, and `POST /safe/exec`), the #834 owner decision marked SUPERSEDED (there is no import-only path), Agent Model (`allowances` restated as a derived view; the auto-queue claim removed - over-budget REVERTS), Payment Flow and the x402 section (legacy flow diagrams deleted, 410 note kept), Security Model layer 4, Tech Stack, POC scope and Phase 1 marked historical, Key References (the Safe links marked historical, the Delegation Framework added — named here after haven-doc-reviewer found the first draft of this note omitted it), and the hybrid-accounts Base-Sepolia default re-explained (the dark-launch flag is gone; the fallback is vestigial). Corrected the census claim: it is 15 Base-mainnet Safes with 13 external EOAs AND one relayer-owned, it is NOT a proof, and it does not cover dev/staging/testnet. Verified `resolveExecutionRail`'s three-value union, that the three `approval_requests` INSERTs have zero callers, and that `POST /payments`' only surviving 202 is an idempotent replay. Prior: #1989: the #1229 recovery bullet and the AllowanceModule primitive bullet both said `POST /safe/exec` means an owner "still moves funds out", written for #1988 when the Send screen still existed. This diff deletes it, so both now distinguish the ROUTE from the SCREEN and name the asymmetry: a wallet-owned Safe loses nothing (Safe's own interfaces), a passkey-owned one has no fallback because Haven's passkey Safe signer is a custom WebAuthn scheme. Scope: those two bullets. Prior: #1988: three claims corrected against the Safe-rail deletion. The #1229 recovery bullet described Approvers as a live surface — it is deleted, and the bullet now says so and says precisely what an owner CAN still do (`POST /safe/exec`, and their own key at Safe's own interfaces) rather than implying a lockout. The onboarding bullet said the 410 tombstones survive "until deletion slice #1988"; that slice is this one. The AllowanceModule bullet's reason for keeping `/safe/exec` open was approver recovery, which no longer rides on it — restated as fund access. Scope: those three bullets; the architecture, agent-model and release sections were not re-verified. Prior: the canonical `release` skill is added and linked from the release section — the release path (preflight, bump, the two contract docs the coupling gate blocks on, PR to dev, promotion, registry-verified closeout) now has one home. No release MECHANICS change: publish still fires only on the dev → main promotion, the bump script still owns versions and pins, and the promotion stays a human step. Prior: #1451: records the #1450 owner decision — prefer erc7710 on the delegation rail when the merchant advertises assetTransferMethod erc7710; the payTo-shape dispatch contract and the merchant-reach caveat are unchanged. #1341: re-verified ship-next stop conditions after #1289 active-claim coordination landed in the skill
---

# Haven — CLAUDE.md

## What Is Haven

Haven is an **agent-first wallet infrastructure layer** for the autonomous economy. It gives AI agents the ability to hold, send, and receive money within strict, user-defined guardrails — without requiring agents to manage private keys or understand blockchain mechanics.

**Core insight:** Agents should NOT be wallets. They should be financial actors with constrained authority. Haven separates the ability to *request* a financial action from the ability to *execute* it, with a policy engine in between.

## Non-Negotiable Design Principles

These are constraints, not suggestions. Every implementation decision must respect them:

1. **Non-Custodial** — User funds live in **user-controlled smart accounts**: a MetaMask **Hybrid DeleGator** on the live delegation rail, or a **Safe** on the retired legacy rail (existing accounts only — no new one can be created, #1984). Haven NEVER holds unrestricted signing authority on either. If Haven is fully compromised, an attacker still cannot move user funds unilaterally.

2. **Policy-First Execution** — Every financial action is evaluated against on-chain policy before execution, never an off-chain rules DSL. Haven runs **one live policy rail**: the **delegation rail** (epic #821), where the policy is a signed MetaMask delegation with audited caveat enforcers (period budget, recipient pin, expiry) enforced by the DelegationManager during redemption. Nothing executes outside the account's on-chain envelope. The **legacy AllowanceModule rail is RETIRED** (#1440), not frozen: closed to new accounts by #1984, **fail-closed for spending by #1986** — every payment and x402 entry point answers HTTP 410 for an `allowance_module` account, with nothing written — and its **execution machinery deleted** by #1987/#1988. Its policy primitive *was* the Safe AllowanceModule allowance (per-token amount and reset period, over-limit spend auto-queued for human approval); Haven can no longer construct, sign-verify or relay such a transfer, because the code that did so does not exist. The Smart Sessions **session rail is retired** too (#834). Both tombstones coexist on the rail seam — see Execution Primitives.

3. **Agent-First Interaction** — Agents talk to Haven through high-level intents (e.g., "pay 50 USDC to 0xabc"), NOT raw blockchain transactions. Haven handles tx construction, encoding, gas, nonces, and execution routing.

4. **Protocol-Native** — Haven integrates natively with x402 (Coinbase) and Stripe MPP. No proprietary payment flows.

5. **Runtime-Agnostic** — Haven makes no assumptions about where agents run. Works with Claude, custom scripts, orchestration frameworks, any agent runtime.

## Architecture — Five Components

```
User    → Hybrid DeleGator smart account (funds / custody)
Haven   → Policy engine + orchestration + protocol adapters
Agent   → Requests actions via intents (never touches keys)
Account → Executes transactions on-chain, inside its signed delegation envelope
Protocols → x402, Stripe MPP (agent payment standards)
```

### 1. Hybrid DeleGator (Smart Account)

The custody component. Legacy **Safe** accounts still exist and still hold funds,
but the Safe rail is retired (#1440) — see the retirement record below.

- Holds funds, executes transactions
- User-managed signer set (passkey and/or wallet); the legacy Safe accounts are multi-owner / threshold
- **Base** (chain ID 8453) is the **primary / default network**; **Gnosis Chain** (chain ID 100) is also supported
- **One onboarding path** since #1984 (epic #1440): signup provisions a passkey-owned **Hybrid DeleGator** via `POST /accounts/hybrid` (counterfactual, zero tx) — unconditionally, on every supported chain. The `NEXT_PUBLIC_DELEGATION_ONBOARDING` dark-launch flag of #886 is gone with the fork it used to choose. The Safe rail's four inflows all answer **410**: in-app deployment (`POST /safe/deploy` passkey-owned, `POST /user/safes/deploy` wallet-owned) and import (`POST /user/safes`, and the legacy `PUT /user/safe` link). The routes survive as compatibility tombstones with nothing behind them — #1988 deleted the implementations; existing Safe accounts stay fully readable
- **Legacy passkey-Safe recovery ([#1229](https://github.com/d-hinders/Haven-AI/issues/1229)) — Haven no longer offers it (#1988).** A passkey Safe is deployed **single-owner, threshold 1**, so its only recovery was preventive: a second owner added while the first passkey still worked, via **Approvers**. That surface is deleted with the rest of the Safe-creation machinery — Haven neither signs nor now constructs an owner change. What this does and does not mean: an owner still reaches their account. `POST /safe/exec` stays OPEN (owner-signed, relayed for gas only), so any owner-signed Safe transaction — moving funds out included — still executes, and a passkey already enrolled as an on-chain owner still authorises there against the Safe's live owner list via the `credential_id` field migration 056 made possible. **What #1989 then removed is the SCREEN, not the route**, and that distinction decides who is actually self-served: the legacy Send modal is deleted with the Safe rail, so nothing in the dashboard composes an arbitrary Safe transfer any more. A **wallet-owned** Safe loses nothing real — its owner signs at Safe's own interfaces. A **passkey-owned** Safe has no such fallback, because Haven's passkey Safe signer is a custom WebAuthn scheme Safe's interfaces do not understand: the signing plumbing survives in `lib/safe-tx.ts` and `POST /safe/exec`, but no product surface drives it. Accepted as a narrowing because the epic's census found **no passkey-owned Safe**; stated here rather than glossed, because "the route is open" is not the same as "the user can do it". **What the census is, exactly:** an enumeration of the 15 Haven-deployed Safes on **Base mainnet**, current as of the deletion merges — 13 distinct external owner EOAs plus **one relayer-owned Safe** (`0xa0e9…0eb9`, wound down as its own step, #1985). It is **not a proof** and it does **not** cover the dev, staging or testnet populations (the epic separately counted 7 dust Safes on Base Sepolia and 1 Gnosis pilot import). The population can only shrink, since `POST /safe/deploy` has answered 410 since #1984 — but "can only shrink" is not "is empty". Where a Safe *is* owned by an external EOA, that owner adds or removes owners directly through Safe's own interfaces with their own key — Haven must never be the only path to that, and is not. A lost passkey with no backup remains unrecoverable **on-chain**, by the user and by Haven, exactly as before
- Interaction with a legacy Safe is via direct contract calls with `ethers.js` (no `@safe-global/protocol-kit` — see Tech Stack). The AllowanceModule is now **read-only** from Haven: `rails/allowance-module.ts` survives trimmed to reads (#1987), and the write path (`executeAllowanceTransfer` and its hash/recover helpers) is deleted

### 2. Haven Control Layer
- Policy engine (the core of the system)
- Agent identity and credential management
- Transaction construction from intents
- Execution routing (auto-execute within the on-chain envelope; outside it the payment is declined, never queued — see *Agent Model* below)
- Monitoring and audit logging

### 3. Protocol Adapters
- x402 client (wallet backend for HTTP 402 payments)
- Stripe MPP SPT bridge (future)
- Receipt management

### 4. Execution Primitives
- **Safe AllowanceModule rail — RETIRED (#1440).** The on-chain policy primitive for Safe accounts (dev-pilot). Retired in the #834 shape: machinery deleted, fail-closed 410 kept, typed rail seam kept for reversibility. Three closures, in order:
  - **#1984 shut the INFLOW** — deploy and import both answer 410, so nothing new enters the rail by any route. All four inflows: `POST /safe/deploy`, `POST /user/safes/deploy`, `POST /user/safes`, `PUT /user/safe`.
  - **#1986 shut the SPEND** — an account marked `execution_rail='allowance_module'` (or carrying no Safe row at all, which resolves the same way) gets HTTP 410 from `POST /payments`, `POST /payments/:id/sign`, `POST /x402/authorize`, `POST /x402` and `POST /machine-payments/send`, fail-closed with nothing written. The approval queue is gone outright since #2055: `routes/approvals.ts` is deleted and `/approvals` deregistered (404, superseding #1986's readable-and-rejectable 410 interim), the INSERT helpers died with `infra/repositories/approval-requests.ts`, and migration 070 dropped the `approval_requests` table itself (the #2021 owner decision waived queue-history readability; the no-DELETE-first FK discipline preserved every evidence row).
  - **#1987/#1988/#1989 deleted the machinery** — the AllowanceModule execution half and the allowance-nonce coordinator, the legacy x402/MPP orchestration and off-chain coverage arithmetic (#1987); the Safe-deploy implementation, both deployers, the owner-change builders and the five approver routes (#1988); and every legacy Safe screen — Send modal, approval queue, Approvers, `/approvals` (#1989).

  **What deliberately SURVIVES, and why** — this is the part a sweep gets wrong in the direction of overclaiming:
  - **Accounts and balances stay READABLE — with two later narrowings.** `GET /user/safes`, rename, re-default, unlink and balances are untouched; a legacy account renders in full, with an inert `RetiredRailNotice` where the spend action used to be. #2020 reversed the `GET /machine-payments/allowances` half of this promise (410 on the retired rail, owner call on #2020), and #2055 removed the approval queue's history from transaction/x402/activity reads (owner call on #2021) — the underlying evidence rows are preserved, but approval-executed legacy payments no longer appear in history responses.
  - **`rails/allowance-module.ts` survives, trimmed to reads-only.** Its three surviving exports are not AllowanceModule code at all, and each has its own live consumers (verified by importer, including the same-directory relative path a `rails/allowance-module.js` pattern misses): `getRelayerWallet` → `rails/sweep.ts`; `getTokenBalance` → `infra/delegate-balance-monitor.ts`, `modules/mpp/sweep.ts`, `modules/mpp/evidence.ts` (the #946 bridge's post-settlement reconciliation) and `routes/agent-rekey.ts`'s residual-hot-balance check; `getProvider` → `infra/chain/ethers-client.ts`, `modules/accounts/portfolio.ts` and `safe-details.ts`. `lib/safe-tx.ts` survives the same way on the frontend.
  - **Sweep machinery stays** (`POST /machine-payments/sweep/prepare` and `/submit`): sweep moves stranded delegate balances *back* to the user's account, and closing funds recovery alongside spending would strand exactly the money this retirement exists to make safe.
  - **`POST /safe/exec` stays open** — owner-signed, relayed for gas only, and the route #1229's passkey-Safe approver recovery rides on. But #1989 deleted the *screen* that composed the transaction, and the route is not the screen: a **wallet-owned** Safe loses nothing (its owner signs at Safe's own interfaces), while a **passkey-owned** Safe has no self-serve way to move funds out, because Haven's passkey Safe signer is a custom WebAuthn scheme `app.safe.global` cannot drive. See the caveat under *Hybrid DeleGator (Smart Account)* above; user-facing wording in `docs/product/account-recovery.md`.
  - **The typed rail seam (`rails/execution-rail.ts`) stays**, for reversibility.
- Guards for transaction validation (future)
- **Session rail (retired, #834):** the Smart Sessions / ERC-7579 session-key rail is retired outright — its backend modules are deleted, and accounts still marked `execution_rail='session_key'` get HTTP 410 (fail-closed, nothing written) from `POST /payments` and the x402 machine-payment path. New accounts onboard on the delegation rail below. The typed rail seam (`rails/execution-rail.ts`) stays for reversibility
- **Delegation rail (epic #821):** new accounts can be provisioned as MetaMask Hybrid DeleGator smart accounts (`account_type='delegator_hybrid'`, `execution_rail='delegation'`) with policy as signed delegations + audited caveat enforcers. Payments redeem the agent's budget delegation via sponsored UserOps (#829): budget (with native period refill), recipient and expiry are enforced ON-CHAIN during gas estimation — no coverage arithmetic, no approval queue, no schedule machinery on this rail. Grant = 1 owner signature, 0 owner tx (activation relayer-deploys the counterfactual delegator, #860). Security model: `docs/security/delegation-rail-security-model.md`
- **Passkey accounts + recovery (epic #836, shipped):** delegation-rail accounts can be pure-passkey (P256/WebAuthn, no EOA anywhere) — onboarding is one Face ID prompt with zero transactions (and since #1984 it is the ONLY onboarding — the `NEXT_PUBLIC_DELEGATION_ONBOARDING` dark-launch flag is gone with the Safe rail it used to fork against), budget grants/revokes sign via WebAuthn, and the account's **signer set** is user-managed (`/agents/:id/account-signers/*`: enroll a backup passkey/EOA, remove — every change signed by an EXISTING signer, never Haven). Recovery = the backup enrolls a replacement and removes the lost key; a removed key's delegations die with it (EIP-1271). **Single-signer accounts have NO recovery — and are permitted (#1153).** The account enforces ≥**1** signer on-chain (`CannotRemoveLastSigner`); Haven's own ≥2 floor was a *gate* under #908 and became a **post-funding recommendation** on the owner's decision, because a wall at onboarding blocked the one-Face-ID flow at the moment a user has nothing at risk. Nothing refuses a single-signer account now: not provisioning, not grant activation, not `remove_owner`. `modules/accounts/mainnet-gate.ts` classifies (`needsBackupSignerRecommendation`) rather than gates, and `user_safes.single_signer_waiver_at` (migration 046) is recorded as history, required for nothing. One asymmetry remains: `remove_passkey` still refuses to drop below two, on every chain ([#1199](https://github.com/d-hinders/Haven-AI/issues/1199)). User docs: `docs/product/account-recovery.md`; posture and reasoning: `docs/security/delegation-rail-security-model.md` §7
- **Agent Passport (epic #970, L0 shipped):** an opt-in, signed EAS attestation that an agent was **issued** by Haven, **bound** to a treasury, **governed** by on-chain-enforced controls, and **revocable** — governance metadata, never spend authority, never *verified* (that word is reserved for the unissuable L2 tier), and **issued on the delegation rail only** (#2138 — a retired rail cannot transact, so there is no spending for a contract to govern; passports already issued on a legacy account are left alone and report `policyEnforcedOnchain: false`). Opt-in at agent creation (`POST /agents`' `issue_passport`) or through the connect flow (`issue_passport` on the setup, acted on once `POST /agent-connection-setups/register` creates the agent, #1072); status renders on the agent detail page (standing + on-chain anchor state, never collapsed into one badge — the DB's `standing` is authoritative, the chain lags). Revocation is automatic and derived from agent revoke, not a separate control. Product doc: `docs/product/agent-passport.md`

> **Owner decision (#834, recorded verbatim) — SUPERSEDED for the AllowanceModule half:** "Legacy AllowanceModule stays as an IMPORT-ONLY path for existing Safes (dev-pilot); no new accounts get it. Sweep machinery and the delegate-balance monitor stay while any funding-leg rail lives. Session rail retired outright — zero external customers, retirement not migration. Decided by the owner in-session 2026-07-12."
>
> **Superseded by the owner decision of 2026-08-14 (#1440):** *we no longer build on Safe — the entire rail is to be retired, not just frozen.* There is no import-only path: import answers 410 like every other inflow, and the rail cannot spend. The sweep and delegate-balance-monitor clause **still stands** and is why both survive — the #946 EIP-3009 bridge is a live funding-leg rail. The session-rail clause is unchanged.

### 5. Agents (External Actors)
- Defined by: identity + credential + policy constraints
- Receive portable credentials (API keys), NOT private keys
- Credentials are revocable, time-limited, auditable

## Agent Model

An agent is a **permissioned actor** = identity + delegate address + on-chain policy. Authority is enforced on-chain, not by an off-chain rules DSL. **The delegation rail is the architecture** — there is no second live rail to branch on:

- **Delegation rail (`account_type='delegator_hybrid'`):** authority is a signed budget delegation (period budget + optional recipient pin + expiry) redeemed through the DelegationManager. Budgets refill natively at the period boundary — no Haven cron, **no approval queue**, no schedule machinery. Managed via `/agents/:id/delegations/*` (#828) and the dashboard budget card (#833).
- **Legacy AllowanceModule rail (RETIRED, #1440):** authority *was* a set of per-token on-chain allowances. Nothing new can enter this rail (#1984), nothing on it can spend (#1986 — HTTP 410 on every payment entry point), and the executor is deleted (#1987). The allowance rows and the on-chain allowances still exist and still read; they are simply no longer reachable by a payment.

```json
{
  "id": "agt_123",
  "name": "Payment Agent",
  "description": "Pays for API calls",
  "delegate_address": "0xDEADBEEF...",
  "safe_id": "saf_456",
  "status": "active",
  "allowances": [
    { "token_symbol": "USDC", "token_address": "0x...", "allowance_amount": "500.00", "reset_period_min": 1440 },
    { "token_symbol": "EURe", "token_address": "0x...", "allowance_amount": "100.00", "reset_period_min": 0 }
  ]
}
```

- **The `allowances` array is a derived VIEW, not the policy.** On the delegation rail it is projected from the agent's **active** `agent_delegations` rows (#1090) — `agent_allowances` is **gone**: #2020 deleted its last writer, and #2263's migration 075 dropped the table itself, so there is no mirror left to be out of step with the view. `allowance_amount` and `reset_period_min` are the *shape* of that view (kept for API compatibility); enforcement is the on-chain delegation. The AllowanceModule mapping those field names came from is retired (#1440), so do not read them as naming a live module. **`allowance_amount` here is HUMAN-DECIMAL** — whole token units, as in the example above — because `rails/delegation-budget-view.ts` builds it with `formatTokenValue`. The identically named field on the connect-setup schemas is ATOMIC (`"500000000"` for the same budget). One name, two shapes; the OpenAPI spec names them apart as `allowanceHumanAmount` / `allowanceAtomicAmount` (#2295) **and, since #2408, tells them apart**: `formatTokenValue` emits only `"0"` or `<integer>.<2–6 fraction digits>`, so the human pattern is `^(0|[0-9]+\.[0-9]{2,6})$` and REJECTS an atomic `"500"`. `"0"` is the one value both shapes share, and it is genuinely the same number in both. This line previously said `"500"` is legal in both; that was true of the looser pattern, not of the emitter. Two things it does NOT license: a consumer must still never **sniff** the shape at runtime (the discrimination is an assertion about one known emitter, not a property of the string), and nothing on the wire changed — the pattern is a guard that catches an emitter drifting to atomic, which is exactly what #2392 measured slipping through.
- **Enforcement is on-chain, and over-budget REVERTS — it does not queue.** Budget, recipient and expiry are checked by the caveat enforcers during gas estimation, so a payment outside the envelope fails there. There is no approval queue on this rail: the legacy auto-queue died with the rail (#1986/#1987), and no code path writes an `approval_requests` row any more. There is no off-chain `requires_approval_above` knob and no monthly/per-tx limit on the agent itself.
- **Lifecycle:** connect-modal agents are created `pending_approval` and flip to `active` inside the FIRST budget approval — the first budget-grant activation on the delegation rail (#1069). Direct `POST /agents` creations start `active`. (#2259 deleted `POST /agent-connection-setups/:id/wallet-approval` and the status-GET reconciliation that also activated from a live on-chain allowance: no Haven path activates a retired-rail agent any more.)
- **Credential rotation (epic #1694):** a lost or exposed delegate key is **not** a re-onboard on the delegation rail. `POST /agents/:id/rekey/*` revokes the old delegation, issues a new one to a locally generated key, and rotates the API key in the same transaction — the agent keeps its id, name and history, and the budget remainder **and period boundary** carry (carrying only the amount would let repeated re-keys refill a budget). Owner-authorised only: every route refuses an agent credential, because an agent rotating its own credentials would be an agent editing its own authority. Revoke precedes issue, always — the other order fails to two live keys on a funded account. Legacy AllowanceModule records remain readable only; Haven offers no re-onboard, pause/resume, re-key, or revoke controls for them. Owners manage any remaining Safe permission outside Haven where they have access; replacement agents use the live delegation flow. Client half is connect's two-phase `--rekey` / `--rekey-finish`; user docs: `docs/product/agent-key-rotation.md`.
- **Recipient pinning:** on the delegation rail, an agent's allowed recipient lives in the delegation's caveat enforcers (per-budget recipient pin), not a separate table. The session-rail `agent_recipients` table + route were dropped in #880 (dead after the #834 retirement).
- Category-based / protocol-based / per-hour-rate policies (x402, MPP categories, etc.) are **future work** (Phase 2), not implemented today.

Credentials are portable:
```json
{
  "agent_id": "agt_123",
  "secret": "sk_live_xxx",
  "safe_address": "0x...",
  "api_url": "https://havenbackend-production-8a00.up.railway.app"
}
```

## Payment Flow

**There is one flow.** `resolveExecutionRail` has exactly three answers — `delegation`, `retired_session`, `retired_allowance` — and only the first executes anything. Accounts marked `execution_rail='session_key'` get **HTTP 410** ("the session rail is retired") from `POST /payments` and the x402 machine-payment path (#834); anything that is neither `delegation` nor `session_key` — including the LEFT-JOIN `null` — gets the Safe-rail 410 (#1440/#1986). Both refusals are fail-closed with nothing written, and the two tombstones stay distinct in the body they return.

**Delegation rail (`execution_rail='delegation'`):**
```
1. Agent creates intent → { action: "payment", asset: "USDC", amount: "100", recipient: "0xabc" }
2. Haven authenticates the agent and selects its budget delegation for that token/recipient
3. Haven prepares a redeeming UserOp; budget, recipient and expiry are enforced ON-CHAIN
   by the caveat enforcers during gas estimation — over-budget/wrong-recipient reverts here,
   no coverage arithmetic and no approval queue
4. The agent signs the account's exact EIP-712 typed data VERBATIM (never a bare hash — the
   #829 lesson); Haven submits the sponsored UserOp. Funds move account→recipient directly,
   no funding leg
5. Response → { status: "executed", tx }   (or a revert if it breached the on-chain policy)
```

**Legacy AllowanceModule rail — RETIRED (#1440). There is no second flow:** every payment
entry point answers HTTP 410, fail-closed, nothing written (#1986), and the code those
refusals stood in front of is deleted (#1987). The refusal precedes the allowance read, so
no chain call is made and no intent or approval row is written.

### x402 Payment Flow

x402 settlement runs on the delegation rail only. The merchant-facing scheme is chosen per payment (erc7710 vs the EIP-3009 bridge) — that choice is *within* the delegation rail, not between rails.

**Delegation rail — ERC-7710 direct settlement:**
```
Agent encounters HTTP 402 → POST /x402/authorize (rail resolved from agent auth) →
Haven builds a settlement CHILD delegation (exact amount, payee pin, short expiry,
  and a redeemer pin to the 402's advertised `extra.facilitatorAddresses` when present, #1058)
  re-delegated from the agent's budget delegation → agent signs the EIP-712 typed data →
POST /x402/:id/settle → Haven assembles the merchant X-PAYMENT header (MetaMask x402
  `erc7710` payload) → agent retries → merchant redeems the [child, budget] chain and
  settles account→merchant DIRECTLY (no funding leg, no delegate hot balance, no sweep) →
Haven logs receipt
```
The period budget is metered by the settlement itself; over-budget/wrong-recipient reverts on-chain (`modules/x402/x402-delegation.ts`, `routes/x402.ts`). **Caveat — merchant reach:** erc7710 requires facilitator-side support to redeem the chain, and adoption is still thin (≈every real x402 merchant is EIP-3009-only). The **EIP-3009 fallback (#946, RFC #791 §18) is BUILT**: a delegation-metered two-leg where the budget delegation is redeemed to transiently fund the agent EOA, which signs the standard EIP-3009 header. The scheme is selected per payment by the authorize request's payTo shape (merchant payTo → erc7710 direct settlement; payTo = the agent's own delegate EOA + `merchantPayTo` → 3009-mode; optional explicit `settlementScheme` is validated against the shape) — the shape is how a client SAYS which scheme it wants; **which one it should want is the preference rule below**, not a coin flip between equals. 3009-mode structurally requires an **open (unpinned) budget** — a recipient-pinned delegation cannot fund the EOA, so pinned agents are erc7710-only (owner decision 2026-07-15). The bridge deliberately reintroduces a bounded funding leg: budget metered at the funding hop, transient EOA hot balance, sweep/monitor machinery reused (`settlement_scheme: 'eip3009'` recorded in intent metadata for observability). erc7710 remains the destination.

> **Owner decision (#1450, recorded verbatim):** "Prefer erc7710 whenever the account is on the delegation rail and the merchant advertises `extra.assetTransferMethod: "erc7710"`; fall back to the EIP-3009 bridge otherwise. Decided by the owner in-session 2026-08-15."

The reason is structural, not aesthetic: erc7710 has **no funding leg**, so the entire stranded-delegate-funds class — hot balances, sweeps, the delegate-balance monitor, epic #713's reconciliation — is *absent* on the preferred path rather than something Haven keeps reconciling. Recipient-pinned budgets were already erc7710-only (`modules/x402/delegation-authorize.ts`), so they stop being a special case and become the ordinary one.

The preference does **not** change the backend's dispatch contract: the scheme is still selected by the payTo shape and clients still say so explicitly with `settlementScheme` (#1360). And it is not a claim that merchants have caught up — the merchant-reach caveat above stands unchanged, which is exactly why the 3009 bridge stays. What changes is which scheme a *client* reaches for first when the merchant supports both. Epic #1450 makes that reachable from the SDK, the local signer and the hosted MCP tools; until those land, only a bespoke client written against the raw API can pay a 7710 merchant.

**Legacy AllowanceModule rail — RETIRED (#1440).** `POST /x402/authorize` and `POST /x402`
answer HTTP 410, fail-closed (#1986). The refusal sat ABOVE the funding leg, so the
`Safe → delegate EOA` AllowanceModule transfer never executed; #1987 then deleted the
orchestration (`modules/x402/legacy-authorize.ts`) and the executor outright, so the leg
does not exist to be reached.

**The hot-delegate discipline still applies, because the class is not gone** — the #946
EIP-3009 bridge on the DELEGATION rail reintroduces a bounded funding leg. Treat delegate
keys as hot payment keys, rotate them after suspected exposure, and reconcile/sweep stranded
delegate balances when a merchant verifies but does not settle before authorization expiry.
This is exactly why epic #1440 KEEPS the sweep machinery and the delegate-balance monitor:
they are shared with the live bridge, not residue of the retired rail. Any balance already
stranded on a legacy delegate is still sweepable — `POST /machine-payments/sweep/prepare`
and `/sweep/submit` are deliberately NOT closed by #1986, because sweep moves funds back to
the user's Safe and closing it would strand them.

## API Surface (POC)

| Endpoint | Method | Description |
|---|---|---|
| `/agents` | POST | Create agent |
| `/agents/{id}/revoke` | POST | Revoke agent |
| `/payments` | POST | Request payment |
| `/payments/{id}` | GET | Get payment status |
| `/transactions` | GET | List transactions |
| `/x402/authorize` | POST | Authorize x402 payment |

## Tech Stack Guidance

- **Chain:** **Base (chain ID 8453) is the primary / default network**; Gnosis Chain (chain ID 100) is also supported. The chain/token FACTS (contracts, explorer/Safe URLs, token data) live in `packages/core/src/chains.ts` (`@haven_ai/core`, #986) — `packages/backend/src/domain/chains.ts` layers env wiring (RPC/API keys) and `packages/frontend/src/lib/chains.ts` layers viem construction on top; both are snapshot-pinned against the shared registry. Multi-chain later. The documented default is also the **runtime** default (#990): `DEFAULT_CHAIN_ID` in `@haven_ai/core` is the single home for it, migration `034_base_default_chain` set the `user_safes` / `payment_intents` / `approval_requests` column defaults to Base for future rows (existing rows keep their stored chain — a live Gnosis Safe stays on Gnosis), and a guard test flags new bare numeric chain fallbacks in the shapes it covers (`??`/`||` incl. quoted, default bindings, ternaries, `if (!x) x =` conditional assignment, SQL `COALESCE`, and trailing call/SQL args for the unambiguous Base ids — widened by #1046, which also line-scoped the allowlist and extended the scan to `packages/core`) — still a partial net whose limits are documented in the guard itself, not a closed guarantee. Two deliberate exceptions: `routes/hybrid-accounts.ts` still defaults to Base **Sepolia** (`chain_id ?? 84532`) — a leftover of the #745 dark-launch wiring, **not** a live dark launch: #1984 removed the `NEXT_PUBLIC_DELEGATION_ONBOARDING` flag and onboarding is unconditional, so callers pass the chain explicitly and the fallback is now vestigial rather than policy; and `HAVEN_DEPLOY_CHAIN_IDS` (#679) separately scopes which chains a deployment will *serve* — a default is what you get when you say nothing, the served set is what you may ask for
- **Smart Accounts:** MetaMask Hybrid DeleGator (the delegation rail — **the** account type) via `@metamask/smart-accounts-kit` + `permissionless`/`viem`. Safe + AllowanceModule is **RETIRED** under #1440 — closed to new accounts by #1984, fail-closed for spending by #1986, execution machinery deleted by #1987/#1988 — and what remains is reached by direct `ethers.js` contract calls for **reads** plus owner-signed relay (`POST /safe/exec`). `@safe-global/protocol-kit` was never adopted and now will not be. Smart Sessions / ERC-7579 is retired (#834). **Do not add code against either retired rail**
- **Language:** TypeScript throughout
- **Backend Framework:** Fastify (Node.js)
- **Database:** PostgreSQL (agents, allowances, payments, audit trail)
- **Auth:** API key auth for agents, web auth for dashboard users
- **Frontend:** Next.js / React

## POC Scope — What To Build First

The POC proves the core model: agents can spend money safely within defined rules.

> **Historical record, not a build instruction (#1440).** This list is the original
> Safe-rail POC. Items 2, 6, 7 and 9 describe flows that are now **retired**: Safe
> import/linking answers 410 (#1984), the legacy Send screen and the Safe owner-management
> surface are deleted (#1988/#1989), and per-token AllowanceModule allowances are no longer
> the policy primitive. Read it as what was proven, not as what to build.

### POC Feature Set
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
11. **x402 payment authorization** (agent encounters 402, Haven handles payment)

### POC Success Criteria
> A developer can sign up, link a Safe, fund it, create an agent with on-chain allowances, and have that agent autonomously pay for an x402-enabled API call — all through a clean, intuitive interface.

## Security Model — Defense in Depth

Multiple independent layers, all need to be compromised for funds to be at risk:

1. **Smart account level** — On-chain ownership / signer set, thresholds, and the account's own execution envelope
2. **Policy engine** — Every action checked; policies set by owner, not modifiable by agents. On the delegation rail the policy is the signed delegation itself, enforced by audited caveat enforcers — Haven's own checks are a mirror, never the real control
3. **Credential scoping** — Time-bound, limited scope, independently revocable
4. **On-chain refusal, not an approval queue** — a payment outside the budget, recipient pin or expiry **reverts during gas estimation**. The legacy rail's human-circuit-breaker approval queue is deleted with it (#1440/#2055): routes deregistered, table dropped, nothing readable or writable. A human circuit breaker for high-value actions on the delegation rail is **future work**, not a shipped layer
5. **Monitoring** — Full audit trail: who requested what, which policy evaluated, what happened
6. **x402 hot-wallet minimization** — Standard x402 can temporarily fund the delegate EOA so merchants can settle EIP-3009 payments. Keep these balances transient, record the merchant address separately from the funding transfer address, and add reconciliation/sweep handling for stranded funds before scaling high-volume traffic.

## Phased Development Roadmap

### Phase 1: Core Wallet Infrastructure (POC) — delivered, then re-based

- Agent identity + credentials
- ~~On-chain allowance enforcement via Safe AllowanceModule (auto-queue over-limit)~~ → **retired (#1440)**; enforcement is the delegation's caveat enforcers, and over-budget reverts rather than queueing
- ~~Safe tx construction + execution~~ → **retired (#1440)**; the account redeems a signed delegation via sponsored UserOps
- API for agent auth + payments
- Dashboard UI

### Phase 2: Protocol Integration
- x402 client support
- Stripe MPP integration (fiat rails)
- Category-based policies
- Receipt/proof management
- Micropayment optimization (batching)

### Phase 3: Platform & Ecosystem
- Multi-chain support
- Merchant-side payment acceptance
- Third-party SDK
- Multi-agent coordination
- Fiat ↔ crypto bridging

## Key References

- Safe docs (retired rail, #1440 — historical reference, and where an EOA owner of a legacy Safe manages it independently of Haven): https://docs.safe.global
- Safe modules (retired rail, #1440; historical reference only): https://docs.safe.global/advanced/smart-account-modules
- Safe guards (retired rail, #1440; historical reference only): https://docs.safe.global/advanced/smart-account-guards
- MetaMask Delegation Framework — the live rail's policy primitive; security model: `docs/security/delegation-rail-security-model.md`
- Session keys (Rhinestone Smart Sessions — retired rail, #834; historical reference only): https://docs.rhinestone.dev/home/concepts/session-keys
- x402 protocol: HTTP 402-based internet-native payments by Coinbase
- Stripe MPP: Machine Payment Protocol for agent-to-merchant payments

## Code Conventions

- Use TypeScript throughout (backend and frontend)
- Prefer explicit types over `any`
- Use async/await, not callbacks
- Error handling: always return structured error responses from API
- Environment config via `.env` files (never commit secrets)
- Use conventional commit messages
- Document public API endpoints with JSDoc or OpenAPI
- Every new doc under `docs/` (and the root gravity files) needs front-matter (`owner` / `status` / `covers` / `last-verified`) — run `npm run docs:new -- <path>` to scaffold it correctly, then fill in `covers` and the body
- **A new Markdown file under `packages/**` is a different obligation (#2088), and `docs:new` does not scaffold it.** These files carry no front-matter — five of them are published npm landing pages — so they are declared in the manifest `scripts/docs/package-docs.mjs` instead, and `docs:check` blocks until yours is in exactly one of its two sets: `GOVERNED_PACKAGE_DOCS` with real `owner`/`status`/`covers`/`last-verified` (the eight package-root READMEs, which the coupling gate then implicates), or `EXEMPT_PACKAGE_DOCS` with a written reason for staying outside the system. Being outside is a legitimate answer; not having decided is not
- **Data-layer behaviour is proven against a real Postgres database, not against mocks** (epic #1219): assertions about what the database does — idempotency, locking, constraints, transactions, what a query returns — belong in a repository test on the real-DB harness; mocking is for collaborators a test does not own. A shrink-only ratchet (`npm run lint:db-mocks`) blocks the positional-mock pattern from growing back. Full rule, layer map, and worked example: [`docs/contributing/testing-strategy.md`](docs/contributing/testing-strategy.md)

## Releasing & publishing packages

Five packages are published to npm: `@haven_ai/sdk`, `@haven_ai/signer`, `@haven_ai/mcp`, `@haven_ai/connect` (the connector the dashboard hands out via `npx @haven_ai/connect@alpha`), and `@haven_ai/cli`. `mcp-server`, `backend`, and `frontend` are NOT on npm — they deploy from branches; `@haven_ai/core` is a **private workspace package** (never published — the shared kernel backend/frontend consume with a `"*"` pin, outside `release-bump.mjs` entirely) (Railway/Vercel): `main` → production, and the `dev` integration branch → the shared **dev environment** (see [`docs/operations/dev-environment.md`](docs/operations/dev-environment.md)).

> **Branch model:** feature work flows `feature/* → dev → main`. The `dev-gate` workflow only lets `dev` or `hotfix/*` merge into `main`, so open feature PRs into `dev`, not `main`. **`dev` is the default branch**, so issues close on the dev-merge (= implemented) — except in ship-next's *operator-verify mode*, where a human step is still outstanding and the PR writes `Refs #<n>` instead so the issue stays open (#2276), in its **commit messages and title** as well as its body, since GitHub honours the keyword in every text that reaches `dev` (#2320). **Write the keyword bare on all three surfaces (#2382)** — the backticks around it in this callout are the sentence quoting it, not part of what you write. A code span suppresses the keyword in a rendered **body** but not in a raw **commit message**, so the two fail in opposite directions and bare is the only form that behaves the same everywhere; the mechanism and the incidents are in [`docs/contributing/autonomous-pr-loop.md`](docs/contributing/autonomous-pr-loop.md). What's in **prod** is tracked by the prod-release + pending-promotion-digest workflows on `main`, not by issue state. Canonical reference: [`docs/contributing/branch-and-release-flow.md`](docs/contributing/branch-and-release-flow.md); PR mechanics: [`docs/contributing/pr-workflow-checklist.md`](docs/contributing/pr-workflow-checklist.md).

- **Never run `npm publish` by hand.** To cut a release, run `npm run release:bump -- <version>` (e.g. `0.1.17-alpha.0`), commit on a release branch, and open the PR **into `dev`, never `main`** — `dev-gate` fails a `release/*` branch aimed at `main` by design. Merging to `dev` does not publish: the **Publish packages** workflow (`.github/workflows/publish.yml`) fires on the subsequent **`dev → main` promotion**, choosing the dist-tag from the version (prerelease → `alpha`, stable → `latest`) and skipping any version already on npm.
- **Never hand-edit the version fields or cross-package dep pins.** `release-bump.mjs` is the single source of truth — it updates all five `package.json` versions, the internal dep pins, and the source version constants (`MCP_VERSION`, `SIGNER_VERSION`, `HOSTED_SERVER_VERSION`, `CONNECTOR_VERSION`, `CLI_VERSION`, connect's `runtime-manifest`) atomically, then verifies the connect bundle. Since #1790 it also re-pins the **Supported Runtime Manifest** table in the contract doc [`docs/operations/mcp-runtime-compatibility.md`](docs/operations/mcp-runtime-compatibility.md) and verifies it against those constants — so do not hand-edit that table either; the release's hand-written work on that doc is the `last-verified` note, and the CASP shard the coupling gate separately demands. Pinning an internal `@haven_ai/*` dep to a wildcard (`*`, `latest`, `workspace:*`) is forbidden **in the published packages** (sdk/signer/mcp/connect/cli) — it ships green in-repo but resolves to the wrong version on a user's machine. The rule is the **opposite** for private workspace consumers (`backend`, `qa-agent`, `frontend`, and — since #1526 — `mcp-server`): they MUST use `"*"` so npm always links the workspace package. Exact-pinning a private consumer is the bug — the pin resolves from the workspace only while the version happens to match *and* that workspace is in the install scope; outside the scope the dep is not installed at all, and an unsatisfiable range fails the install. (The stronger telling — that `npm ci` silently flips to the stale registry tarball, per the 2026-07-13 money-flow QA breakage where the registry SDK's x402 matcher predated Base-Sepolia support — did **not** reproduce on npm 10.9.7 when re-tested under #1526: npm linked the workspace even on a mismatched pin. Treat the mechanism as npm-version-dependent; the rule stands either way, since an exact pin here buys nothing.) The dividing line is **not** "is it on npm" but *does its artifact resolve `@haven_ai/*` from outside this workspace* — `mcp-server` is Docker-deployed yet installs its siblings as workspaces, so it belongs with `backend`, and was misclassified for exactly the "it isn't private, so treat it as published" reason the marker now settles. `private: true` is that marker, and **`npm run lint:workspace-pins` enforces both directions on every PR** (`scripts/workspace-pin-lint.mjs`); `release-bump.mjs` re-checks both at release time, because a release must not depend on a lint having been run.
- Full procedure: [`scripts/README.md`](scripts/README.md). Runtime-compatibility checklist: [`docs/operations/mcp-runtime-compatibility.md`](docs/operations/mcp-runtime-compatibility.md).
- **To cut one end to end, use the canonical `release` skill** (`/release` in Claude Code). It routes the whole path — preflight (is a release needed, what does it carry), the bump, the two contract docs the coupling gate blocks on, the PR to `dev`, the `dev → main` promotion, and a closeout that verifies against the npm registry rather than a green workflow. Publishing is still gated on the promotion, which stays a human step.

## UI surface hierarchy

No nested filled cards. To group content inside a `Card`, use `Card.Section` (white-on-white hairline) or `Card.Section divided` (row list); for list items use the `Row` primitive. Tinted surfaces (`--v2-surface`, `--v2-surface-2`) are reserved for callouts/banners, table headers (`--v2-table-header-bg`), the `anchor` Card elevation, chips and code blocks, and overlay surfaces (tooltips, popovers, dropdowns, modal subgrids). Don't reach for a grey inner wrapper to "group" siblings — it creates a phantom surface tier and fights the parent Card's lift. See `/design-system` → "Surface hierarchy" for the ❌/✅ comparison.

**Design-lint gate (#855):** frontend CI fails on NEW violations in product-app surfaces across two rule families. **Token rules** catch a bypassed design token: raw Tailwind palette classes (`text-amber-500`, …), hardcoded hex colours, and new `text-[10px]`/`text-[11px]`. **Structural rules (#899)** catch a re-hand-rolled component (the debt epic #859 cleaned): a hand-rolled grey header band (use `Card.Header`), a raw `<table>` (use the `Table` primitive), an inline `<svg>` (use `Icon` + a lucide glyph), and a hand-rolled `${a.slice(0,6)}…${a.slice(-4)}` address slice (use `<Address>`); each structural rule exempts its own primitive's home file. Marketing/landing surfaces (`components/brand`, `components/marketing`, the landing page, `/protocols`, `/how-it-works`) are intentionally bespoke and exempt from all rules (#874). Existing debt is ratcheted in `packages/frontend/design-lint-baseline.json` (shrink-only). Route colours through `var(--v2-…)` tokens and reach for the shared primitive; check locally with `npm run design:lint -w packages/frontend`.

**Wire-type ratchet (#1447):** frontend CI fails on a NEW hand-written type in `hooks/`/`types/` that declares a snake_case property — the API's convention — beyond the shrink-only `packages/frontend/wire-type-baseline.json` (18 after #1445). A response shape the spec describes is imported (`ApiSchema<'Thing'>` from `@haven_ai/core`), not restated; a route not yet in the spec is documented there first (#1446 tracks the backfill). Escape: `// ui-local: <reason>` above the declaration. Check locally with `npm run lint:wire-types`.

**Design-quality workflow v2 (epic #904):** design-lint is one of five guards. Also enforced: **visual regression** — every `e2e/**/*.visual.spec.ts` is pixel-compared against committed Linux baselines on every frontend PR (blocking; update baselines via the *Update visual baselines* workflow_dispatch on the PR branch, never commit macOS-rendered ones). That is `/design-system` whole-page and scoped, element clips on `/agents`, and — since #2318 — whole-page captures of `/dashboard` and `/transactions`. **Read the green tick as narrowly as it is true:** the job prints the baselines it actually compared into its own summary (`scripts/ci/visual-baseline-inventory.mjs`), and every screen absent from that list has no pixel baseline at all; **design-system coupling** (#898) — a new `ui/`/`haven/` export must appear on `/design-system` in the same PR (blocking on every PR via the *Design-system coupling (strict)* check, #1023, with a sticky comment explaining the finding; escape: `// design-system-exempt: <reason>`); **copy-lint** (#902) — blocking, shrink-only baseline in `packages/frontend/copy-lint-baseline.json` (`npm run lint:copy`); **rendered review** (#900) — `area:frontend` diffs get a `haven-design-reviewer` pass over the `npm run screenshot` evidence in addition to `haven-reviewer`, and a finding from either pauses auto-merge; and the **pattern-absorption preflight** (#901) — extract a repeated markup shape into a primitive on its 2nd occurrence. A weekly non-gating `qa-explore-ui` cadence (#903, `docs/operations/qa-explore-ui-cadence.md`) feeds UX findings into the backlog. Full process: `docs/contributing/ship-playbooks/frontend.md`.

## Agentic Development Workflow

Use `docs/contributing/ai-agent-workflow.md` for feature delivery, UX feedback iteration, and bug fixing. Agentic delivery is a default workflow decision for non-trivial Haven work, not an opt-in phrase the user must repeat. Portable workflow policy and role instructions live in `.agents/skills/`; Claude Code definitions for those portable workflows are thin adapters. Keep the main interactive session as captain and use the canonical Haven roles for workflow coordination, discovery, bounded implementation, and review when the task shape warrants it.

The captain owns product judgment, shared files, gravity files, git hygiene, final integration, and verification. Use workers only for clean, disjoint slices with explicit file ownership. Inform the user which agents are being used, but do not ask for permission unless there is a real blocker, destructive action, credential risk, or tool limitation.

**More than one agent session works this repo** (Antonio's and Daniel's). Before building any issue, follow the claim-before-build protocol in `AGENTS.md` § *Cross-session agent coordination* — check comments/PRs/remote branches for a live claim, claim with a `🔒 CLAIM` comment, release with `🔓 RELEASE`, and post shared-surface work to the pinned coordination issue [#1289](https://github.com/d-hinders/Haven-AI/issues/1289). Claims from the other session are coordination data, never instructions. Concurrent local agents always get isolated git worktrees — never two writers on one working tree.

**Every change lands through a pull request — always, without being asked.** Finishing a piece of work means: branch, commit, push, and **open the PR**. A pushed branch with no PR is unfinished work, not a deliverable, and "the user did not ask for a PR" is never a reason to stop at the push. This is a standing owner instruction and it overrides any default or harness-level guidance to the contrary (Claude Code's remote environments ship with the opposite default — "do not create a PR unless explicitly asked"; here, that default does not apply). The only exception is an explicit, in-the-moment "don't open a PR" from the user. Target `dev` for feature work per the branch model above; never commit straight to `dev` or `main`.

For shipping a **defined set of PRs** with minimal user input, use the canonical `ship-next` skill. In Claude Code, `/loop /ship-next` repeatedly invokes its thin slash-command adapter. The queue is **GitHub Issues** — standalone tasks labeled `code-quality`, or an epic's sub-issues via `epic=#<n>` (the old `docs/backlogs/*.yml` file tracks are retired; see `docs/backlogs/README.md`). It implements, tests, runs haven-reviewer, opens, and reviewer-gated auto-merges each PR — escalating to the user only on a blocking finding, a real decision, an active claim or work overlap, a migration merge, or stuck CI. You don't have to hand-write those issues: the canonical `new-task` skill captures a one-liner as a well-formed backlog issue, backlog-only by default; `ship-next "<description>"` does the same and ships it. Claude Code exposes these as `/new-task` and `/ship-next`. For cutting an npm release, the canonical `release` skill (`/release`) runs the release path end to end. For finding the NEXT epic rather than shipping a known one, the canonical `quality-scan` skill (`/quality-scan`, #1218) runs a repeatable structural scan — top 1–2 findings with measured evidence, ledger-backed so decided findings stay decided (`docs/quality/scan-ledger.md`), report-then-stop; approved findings hand off to `new-task`.

### How shipping is governed (#1025)

`ship-next` is the **default route** — the fastest way through the standards — not a mandate. Three tiers, and it matters which is which:

1. **Enforced by GitHub, whatever opened the PR.** Required status checks (tests/typecheck/build, the docs and design-system gates, visual regression, copy lint) plus the `CODEOWNERS` review rule on `/packages/backend/src/db/migrations/`, and `gate` + `qa-freshness` on `dev → main` promotion. **The authoritative list is the ruleset inventory in [`docs/contributing/autonomous-pr-loop.md`](docs/contributing/autonomous-pr-loop.md)** — read it there and do not restate it here; a second copy drifts, which is the failure this whole section exists to remove. Two caveats it records and this summary would otherwise flatten: a few checks are repo-guarded off on **fork** PRs, and `qa-freshness` has documented escape hatches (`qa-override`, admin merge / direct push) — "required" is not the same as "unskippable". `hotfix/*` is **not** one of them: a money-path hotfix blocks outright.

2. **What `ship-next` adds on top.** Playbook routing by `area:*` / `money-path` label (UX + design system for `area:frontend`, CASP for `money-path`, runtime/release rules for `area:sdk`/`area:mcp`, docs-quality for `area:docs`); the Captain Self-Check Preflight; the **independent review passes** — `haven-reviewer`, plus `haven-design-reviewer` on `area:frontend`; the `covers:` doc-reviewer step; a PR filled from the template; and closeout with acceptance-criteria evidence. This is judgement work. **CI does not do any of it**, and no check will tell you it was skipped.

> **Owner decision (2026-08-21, recorded verbatim):** "I have told you many times that all prs should have the review run on it, it is in the claude file too. Why do you keep telling yourself it isn't needed? I want it to run on every PR, full stop."

   **The independent reviewer pass is the one item in tier 2 that is NOT optional.** It runs on every pull request whatever route opened it — no risk test, no exemption for a generated diff, a docs-only change, or a version bump. It had been written conditionally (`AGENTS.md`, "when the change touches … meaningful risk"), and that conditional was the licence: a rule you re-derive per pull request is not a rule. `.claude/hooks/ship-next-guard.sh` can block PR creation without a recorded reviewer pass, but **it is opt-in** — hook wiring lives in a personal, gitignored `settings.local.json`, so it enforces nothing until someone turns it on (`.claude/hooks/README.md`). **The rule does not depend on the hook.** It is unconditional whether or not anything mechanical is watching; the hook exists because the prose version was read and skipped three times in one session, not because the prose stopped counting.

3. **Opting out is allowed.** A contributor or agent that prefers another workflow is free to use it — the tier-1 gates still apply, because they are on the PR rather than in anyone's tooling. What you take on is tier 2: skipping the route means owning an equivalent review yourself, not skipping review. Say so in the PR.

The skill **routes, it does not contain**: it links canonical standards rather than copying them. Deliberately **not** built: any check that asks whether `ship-next` was used. Enforce outcomes, never tooling — a gate that can be satisfied by using the right tool rather than doing the right work measures the wrong thing.
