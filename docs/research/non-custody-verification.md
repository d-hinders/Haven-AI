---
owner: "@d-hinders"
status: research
covers:
  - packages/backend/src/rails/allowance-module.ts
  - packages/backend/src/infra/relayer.ts
  - packages/backend/src/rails/execution-rail.ts
  - packages/backend/src/__tests__/non-custody.invariants.test.ts
  - packages/frontend/src/lib/revoke-agent.ts
last-verified: "2026-08-26" # #1993: the #2044 addendum said the three retained spies were "not vacuous" because all three were live exports of `rails/allowance-module.ts`; re-measured, two of them (`computeEffectiveAllowance`, `getLatestBlockTimeSec`) are no longer exported at all, so those spies had gone unfalsifiable a second time. Addendum added recording the removal, the mechanism that makes such decay silent, and the epic-#1440 closing guard that extends #2049's extractor. Scope: the Row 5 spy/structural-proof paragraphs only; the invariants table, Part 2/Phasing and the #2004 paragraph were NOT re-verified in this pass. Prior: #2049: the #2044 addendum called the structural import check the carrier of the deleted spies' capability without stating what it can PARSE — it read named single-quoted clauses only, and eight other import shapes would have left it green. Addendum added recording the AST rewrite, the per-shape mutation evidence and the four blind spots that remain. Scope: the Row 5 structural-proof paragraphs only; the invariants table, Part 2/Phasing and the #2004 paragraph were NOT re-verified in this pass. Prior: #2044: the #1987 addendum said the `not.toHaveBeenCalled()` spies were true by construction; measured, that holds for the three names #1987 DELETED (unfalsifiable — removed) and not for the three the module still exports, which are reachable through the route's transitive import graph and are now mutation-proven red by name. Addendum added. Scope: the Row 5 spy paragraph only; the invariants table, Part 2/Phasing and the #2004 paragraph were NOT re-verified in this pass. Prior: #2004: the Row 5 addendum described the enforcer-correctness gap as OPEN and assigned to #2004 — it is now closed by `non-custody-onchain-enforcer.contract.test.ts`, which probes the deployed enforcers on Base Sepolia; the paragraph is repointed to name both suites, and the narrower `redeemDelegations`-composition gap that genuinely remains is stated in its place. The `covers:` list does not name either contract suite, so the coupling gate could not have caught this. Scope: the Row 5 gap paragraph only; the invariants table and Part 2/Phasing were NOT re-verified in this pass. Prior: #1988: the "control surface already exposed" bullet cited `/user/safes/:id/approvers` in the present tense; that route is deleted with the Safe rail, so the example is repointed. ⚠️ My first repoint invented `GET /user/safes/:safeId`, which does not exist — `routes/user-safes.ts` registers `GET /` and nothing per-id — and `haven-reviewer` caught it: a doc pass fixing a false claim introduced a different one, which is the failure mode the pass exists to prevent. Corrected to the routes that actually serve, and the owner list is now attributed to `/safe/:addr/details`, which is where the approver route read it from anyway. Scope: that bullet. Prior: #1987: the Row 5 addendum named `decideCoverage` as a live symbol the delegation branch merely "never calls" — it is now DELETED, and the spy-based proof it describes went vacuous by construction, so the addendum records the replacement structural assertion and its positive control. Also #1987: re-read after the AllowanceModule EXECUTION half was deleted — the `allowance-module.ts:232` mechanism claim and the References line both named code that no longer exists; both corrected in place with the live delegation-rail equivalent named. The invariants table itself was NOT re-verified in this pass and is left as #1986 wrote it. Prior: #1986: the invariants table rows 4 and 5 re-read against the AllowanceModule retirement — row 5's mechanism ("queued for approval") is legacy-rail-only and gone, and Red Line #4 is now only PARTIALLY proven on the live rail; addendum added naming the gap (#2004, Depends-on into #1991). Rows 1-3 and 6+ unaffected. Part 2/Phasing left alone — its "design proposal" framing is pre-existing drift, not this diff's. Prior: re-verified for #1251 (MPP seam refusal) — no claim here affected
---

# Design — make non-custody provable (CI invariants + "verify your control")

> Status: **design proposal.** Forward-looking; no implementation yet. Turns the
> [CASP/MiCA guardrails](../regulatory/casp-risk-guardrails.md) from prose into
> (a) automated checks that *prove* the perimeter on every PR and (b) a user-
> facing surface that *shows* it. No new authority, no fund movement, no
> regulatory exposure — it strengthens the existing non-custodial model by
> making it demonstrable.

## Why this, and why now

Haven's custody-critical controls are **already on-chain**: the Safe
AllowanceModule enforced per-token amount and reset period keyed by
`(safe, delegate, token)`, and `executeAllowanceTransfer` was authorised by the
**delegate's signature** — the relayer only paid gas.

> ⚠️ **#1987 (epic #1440): that mechanism no longer exists in the codebase.**
> `executeAllowanceTransfer` — with `generateTransferHash`, `recoverSigner` and
> the allowance-nonce coordinator — was **deleted** with the AllowanceModule
> rail's execution half; the line reference this paragraph used to carry
> (`allowance-module.ts:232`) is gone. The file survives as **reads only**, and
> the equivalent live claim is the delegation rail's: an agent's authority is a
> signed delegation whose budget, recipient and expiry are enforced ON-CHAIN by
> audited caveat enforcers during redemption, and the relayer still only pays
> gas. The historical statement is kept above because the invariants table below
> is written against it; read it as the rail's *former* mechanism.
The model is sound. The gap is **demonstrability**: the guardrails doc asks us to
"maintain evidence that Haven does not control funds" (§ of the same name) and to
keep the property "if Haven's backend disappeared, the Safe would still be
revocable on-chain" — but nothing *enforces* that evidence over time, and the
user can't *see* it.

This proposal closes that gap on two fronts.

## Current state (grounded)

What the codebase shows today:

- **No key storage.** No `private_key` / `seed` / `mnemonic` / `secret_key`
  column exists in any migration. ✅
- **Two server signers, neither able to spend.** The relayer
  ([`relayer.ts`](../../packages/backend/src/infra/relayer.ts):27) pays gas; it is
  not a Safe owner or an allowance delegate. Since #974 there is a second:
  [`modules/passport/receipt.ts`](../../packages/backend/src/modules/passport/receipt.ts)
  signs L0 passport verification receipts. It is a **message signer only** — no
  provider, no `sendTransaction`, and a dedicated key
  (`PASSPORT_RECEIPT_SIGNING_KEY`) that is never the relayer's, because its
  address is *published* for merchants to pin. Every other `new Wallet` is in
  tests. The invariant is unchanged in substance — neither signer can move value
  — but it is now an explicit two-name allow-list rather than a count, so adding
  a third is a decision someone has to make on purpose.
- **Agent secret is identity, hashed at rest.** `agents.api_key_hash` +
  `api_key_prefix` exist; a legacy plaintext `agents.api_key` column lingers
  (nullable). Per policy, "API auth is identity, signature is authority" — but
  the plaintext column should be fully retired.
- **Control surface already exposed.** `/safe/:addr/details` (owners,
  threshold), `GET /user/safes` (the caller's linked accounts), on-chain
  allowances, and the agents API already return everything a "verify your
  control" view needs. (`/user/safes/:id/approvers` was on this list until
  #1988 deleted it with the Safe rail. The owner list it served is still
  readable — from `/safe/:addr/details`, which is where it always came from:
  the approver route read `getOwners()` too and merely decorated the result.)

These facts are true *now* — the point of Part 1 is to keep them true.

## Part 1 — CI invariants that prove the perimeter

A small suite that runs on every PR (a dedicated `non-custody.invariants.test.ts`
plus one structural script), each check mapped to a guardrail line. A failure
blocks merge and points at the guardrail it would break.

| # | Invariant | Check | Guardrail |
|---|---|---|---|
| 1 | No key/seed storage | Scan all migrations + entity types for `private_key\|seed\|mnemonic\|secret_key` column names → must be empty | Red Line #1/#2; "no private key storage table" |
| 2 | No plaintext key material at rest | Assert agent secrets are stored hashed; fail if a new column matches a secret-value pattern without `_hash` | Red Line #3 |
| 3 | No server signer capable of spending | Static check: the env-derived `new Wallet(` sites in `src/` (excluding tests) are EXACTLY `infra/relayer.ts` and `modules/passport/receipt.ts` — an exhaustive allow-list, so a third is a deliberate decision. Assert the relayer address is never written as a Safe owner or allowance `delegate`, and that the receipt signer stays message-only (no provider, no `sendTransaction`, never the relayer key) | "no signer capable of spending"; Hard Invariants |
| 4 | Authn ≠ authz on spend paths | Contract test: payment / relay endpoints reject a request that is authenticated (valid bearer) but carries no delegate/owner signature | Red Line #3; "Separate Authentication From Authorisation" |
| 5 | On-chain is the final gate | Test that an over-allowance payment is queued for approval, never silently settled — i.e. the DB is not the only limit | Red Line #4 |
| 6 | No discretionary mutation in relay | Test that the relay path does not alter recipient/amount/token/route after signature | "Treat Relaying As Non-Discretionary" |
| 7 | No lock-in | Assert a revoke path exists that produces a user-signed on-chain tx (not a Haven-only DB flip), and that allowances are readable from chain without Haven | Red Line #10 |

Plus a **machine-readable version of the "Payment-Related Merge Checklist"**: a
CI step that requires payment/agent/Safe/SDK/relayer PRs to tick the checklist
(label or template gate), so the human review the doc already mandates is
recorded, not implicit.

**Value:** every future PR now *proves* the non-custodial claims instead of
relying on reviewer memory — exactly the "maintain evidence" the doc asks for,
and the strongest possible answer to a CASP perimeter question. Zero UX, zero
fund movement.

### Safe / AllowanceModule rail retirement (#1986, epic #1440) — what rows 4 and 5 now mean

> **Read this before rows 4 and 5 above.** Both were written against the legacy
> AllowanceModule rail, and #1986 fail-closes that rail: every payment entry
> point answers HTTP 410 for an `allowance_module` account. A rail that cannot
> spend cannot demonstrate "only a valid signature releases a transfer", so the
> three contract suites (`non-custody-authz`, `non-custody-onchain-gate`,
> `non-custody-relay`) were **re-based onto the delegation rail** rather than
> converted into refusal assertions — a proof that can only say no is not a
> proof.

**Row 4 (Red Line #3) — still proven, on the live rail.** The delegation-rail
cases assert that an authenticated request with no signature, a
shape-invalid signature, or a signature the account rejects on-chain never
releases a payment, and the positive control in the same run shows a correct
signature does. **Scope limit, stated:** the suite proves Haven *forwards* the
account's verdict; it does not prove the delegate smart account's
`validateUserOp` itself rejects a non-delegate signature, which is on-chain
code behind the mocked bundler seam.

**Row 5 (Red Line #4) — PARTIALLY proven, and the gap is filed.** The row's
described mechanism — *"an over-allowance payment is queued for approval"* — is
**legacy-rail-only and no longer exists**. The delegation rail has no approval
queue at all: an out-of-policy redemption reverts on-chain during bundler gas
estimation, enforced by the caveat enforcers. What the re-based suite proves is
that Haven performs **no off-chain coverage arithmetic** on that rail and
forwards a rejection verbatim with nothing written.

> ⚠️ **#1987 — how that first half is proven CHANGED, because the original
> proof went vacuous.** #1986 asserted it with `not.toHaveBeenCalled()` spies
> on `computeEffectiveAllowance` / `getTokenAllowance` / `decideCoverage`. That
> was a real behavioural claim while `routes/payments.ts` still imported those
> functions and chose a branch at runtime. #1987 deleted the legacy branch, and
> deleted `decideCoverage` (with `domain/payment-coverage.ts`) outright — so
> the route imports none of them and the spies became **true by construction**:
> a guard matching the empty set, which would pass just as happily if the
> payment route were deleted. Measured rather than assumed — re-adding a banned
> import turned the new check red while every old spy stayed green. The claim
> is now asserted **structurally**, over the payment route's parsed import
> bindings, with a positive control proving the extractor can say yes before a
> "no" is allowed to count. See
> [`casp-changelog/2026-08-24-1987.md`](../regulatory/casp-changelog/2026-08-24-1987.md).

> 🔎 **#2044 — the "true by construction" verdict was right about three of
> those spies and too strong about the rest, and the difference is measurable.**
> The suite mocked six names from `rails/allowance-module.js`. Three of them —
> `generateTransferHash`, `recoverSigner`, `executeAllowanceTransfer` — had been
> deleted by #1987, so the mock factory invented functions production does not
> have and the suite asserted nobody called them: **unfalsifiable**, since no
> production edit can re-add a call to a function that is gone. Those three are
> removed, along with the `executeAllowanceTransfer` assertion; their capability
> is carried by the structural import check above, which names all three and was
> mutation-proven to go red on a rail-resurrection edit. The three that remain
> (`computeEffectiveAllowance`, `getTokenAllowance`, `getLatestBlockTimeSec`)
> are **not** vacuous: `routes/payments.ts` imports nothing from that module
> directly, but the module is on the route's transitive graph via
> `modules/mpp/index.ts` → `modules/mpp/allowances.ts`, so the mock is live and
> each spy was mutation-proven to redden its own named assertion. They are a
> supporting guard, not the proof. See
> [`casp-changelog/2026-08-25-2044.md`](../regulatory/casp-changelog/2026-08-25-2044.md).

> ⚠️ **#1993 — the same defect regrew inside #2044's own fix, and this is what
> it teaches.** #2044 kept three spies on the argument that all three were still
> live exports of `rails/allowance-module.js`. A later retirement slice shrank
> that module to shared chain infrastructure plus the legacy wallet-approval
> read (`getProvider`, `getRelayerWallet`, `getTokenAllowance`,
> `getTokenBalance`, `getTokensForDelegate`), and **two of the three —
> `computeEffectiveAllowance` and `getLatestBlockTimeSec` — stopped being
> exports**. `vi.mock` replaces the module wholesale, so nothing failed: the
> factory silently re-invented them and the suite went on asserting nobody
> called functions that do not exist. Unfalsifiable again, by the same
> mechanism, seventeen days later. Both are removed; **`getTokenAllowance` is
> the one survivor** and keeps its mutation-proven ordering claim. The lesson is
> not "re-check the list" but that **a spy set pinned to another module's export
> surface goes stale silently whenever that module shrinks** — a mock factory
> treats a missing export as a new function, not an error, so the decay has no
> alarm. Both names stay in the structural check's banned list, where an
> assertion CAN fail on them.
>
> The same slice adds the epic's closing structural guard,
> `routes/__tests__/retired-rail-routing.guard.test.ts` — five AST rules over
> the backend tree asserting nothing routes to the retired rail (deleted module
> referenced again in any literal shape; retired execution symbol bound or
> re-exported; a payment ENTRY POINT reaching even the reads-only survivor; a
> deregistered route prefix re-mounted; the rail-decision union re-widened with
> a live allowance answer). It **extends** #2049's extractor rather than
> copying it: `parseImportFacts()` moved into a shared
> `routes/__tests__/helpers/import-facts.ts` that both suites consume, gaining
> two buckets. Every rule ships a fixture positive control proving the detector
> can say YES, plus a negative control proving a clean delegation-rail file
> trips none — and each rule is separately mutation-proven. One of those
> mutations came from review rather than from the author: a dynamic
> `import()` of a deleted module from a backend file that is not a pinned entry
> point passed the first version of every rule, measured, so rule 1 was widened
> from static specifiers to every code string literal. What the guard cannot
> see is enumerated in its own file. See
> [`casp-changelog/2026-08-26-1993.md`](../regulatory/casp-changelog/2026-08-26-1993.md).

> 🔧 **#2049 — that structural check parsed ONE import shape out of nine; it now
> parses the module's import structure.** #2044 made this assertion
> load-bearing, so its reach is the red line's reach. Measured against every
> shape a reintroduction could take, the old extractor — a regex over
> `import { … } from '…'` — caught named, aliased and multi-line clauses and
> missed eight: namespace import, dynamic `import()` (destructured or whole),
> a computed dynamic specifier, `createRequire(…)('…')`, `export { … } from`,
> `export * from`, side-effect `import '…'`, and a named clause in **double**
> quotes — plus, orthogonal to clause form, a query-suffixed specifier
> (`…/allowance-module.js?bust=1`), which Node's ESM loader resolves to the
> same module. It now parses `routes/payments.ts` with the TypeScript parser and
> asserts five ordered rules — no banned name bound, none re-exported, no
> static reference to a retired-rail module in any clause form, none named in
> any runtime `import()`/`require()`, and no computed dynamic specifier on this
> route at all. Each of the nine shapes was mutation-proven to redden **its own
> named line** — ten in all, confirmed landed by diff before each colour was read; an
> unrelated edit on the payment path SURVIVED, 6/6 green. The instrument is
> proven too: the parser is split from the file read and a fixture control
> exercises every fact bucket — including the two (`reexports`, computed
> `import()`) the real route never fills — with each bucket's collection
> mutation-proven able to redden that control. Parsing keeps the
> property the regex existed for: comments are not AST nodes, so prose naming a
> retired symbol still cannot make it red. **Still not seen, and named in the
> assertion's own comment:** transitive reach through an allowed module (the
> `modules/mpp/allowances.ts` path above — the retained spies carry a
> transitive *call*), other payment surfaces, arithmetic re-implemented inline
> with no import at all, `eval`/`new Function` indirection, and a directory-index specifier (not currently expressible — every banned module is a file). See
> [`casp-changelog/2026-08-25-2049.md`](../regulatory/casp-changelog/2026-08-25-2049.md).

> ✅ **#2004 — the enforcer half is now proven too, and Row 5 is no longer
> only partial.** What the suite above still does not prove, and structurally
> cannot from a backend unit test, is that the enforcers revert correctly:
> `prepareDelegationPayment` is the mocked network seam, so it can only show
> Haven *forwards* the chain's verdict, never that the verdict is right. That
> gap — filed as #2004 and wired as a `Depends on` into
> [#1991](https://github.com/d-hinders/Haven-AI/issues/1991) — is closed by a
> second suite, and the two must be read together:
> [`non-custody-onchain-gate.contract.test.ts`](../../packages/backend/src/routes/__tests__/non-custody-onchain-gate.contract.test.ts)
> proves Haven does no arithmetic of its own, and
> [`non-custody-onchain-enforcer.contract.test.ts`](../../packages/backend/src/routes/__tests__/non-custody-onchain-enforcer.contract.test.ts)
> proves the verdict refuses what it claims to. The second compiles a
> delegation with Haven's real caveat compiler and `eth_call`s each **deployed**
> enforcer at Haven's pinned Base Sepolia address: over-budget reverts
> `ERC20PeriodTransferEnforcer:transfer-amount-exceeded`, wrong-recipient
> reverts `AllowedCalldataEnforcer:invalid-calldata`, and expired reverts
> `TimestampEnforcer:expired-delegation` — each paired with an in-policy
> positive control on the same enforcer, because three refusals alone would
> pass against an enforcer that refuses everything. Key-less and testnet-only:
> `beforeHook` is reachable by an unsigned, unmined `eth_call`, nothing is
> broadcast or funded, and every chain id but Base Sepolia is refused. See
> [`casp-changelog/2026-08-25-2004.md`](../regulatory/casp-changelog/2026-08-25-2004.md).

**Still not proven in-repo, and it is a narrower claim than the one #2004
closed:** that the DelegationManager executes the full caveat stack, *in
order*, during a real `redeemDelegations`. Each enforcer's own verdict on
Haven's own terms is now proven; their composition is not. Closing it needs a
deployed and funded testnet delegator plus a signature — operator-held keys,
outside an automated suite. The honest standing claim for that remainder is the
live evidence ([#1450](https://github.com/d-hinders/Haven-AI/issues/1450)'s
mainnet canary, which settled real value through this exact stack, and the #820
Base Sepolia matrix), **not** "we prove it on every PR".

### Session-key rail extension (#736, ADR #719 Stage 2)

> **Historical (#834):** the session rail is retired and the modules named
> below are deleted. Invariants 5–10 live on in their delegation-rail
> equivalents — see the mapping table in
> [`delegation-rail-security-model.md`](../security/delegation-rail-security-model.md).

The ERC-4337 rail (Safe7579 + Smart Sessions) kept the same perimeter —
Haven constructs, the customer signs — and `non-custody.invariants.test.ts`
pinned the specific mechanisms:

| # | Invariant | Pin |
|---|---|---|
| 5 | The Safe "owner" the rail derives accounts from cannot sign | `watchOnlyOwner` in `session-rail.ts` — every owner sign method bound to a loud refusal |
| 6 | No viem key-derived signer server-side | `privateKeyToAccount` (and mnemonic/HD variants) absent from production `src/` |
| 7 | Session UserOps carry client signatures only | `submitSessionTransfer` takes the signature as an argument; nothing in the rail produces one |
| 8 | Session config is owner-signed, never relayer-submitted | `session-policies.ts` / `session-rotation.ts` / `execution-rail.ts` are signer-free and never reference the relayer |
| 9 | The bundler credential has one auditable choke point | `SESSION_RAIL_BUNDLER_URL` read only in `execution-rail.ts` |
| 10 | The paymaster sponsors gas, never value | Wired as a sponsorship client only; no token-paymaster surface |

## Part 2 — "Verify your control" (dashboard)

A surface (a tab, or a section on the account/settings page) that shows the user,
per Safe, that **they** control it — composed almost entirely from endpoints that
already exist.

What it shows:

- **Owners & threshold** (`/safe/:addr/details`) — "These keys control this Safe.
  Haven is not an owner and cannot sign for it."
- **Enabled modules** — the AllowanceModule, labelled as the on-chain spend
  control. (Small addition: surface module list if `/safe/:addr/details` doesn't
  already.)
- **Per-agent on-chain allowances** — delegate, token, amount, spent, reset —
  read from chain, each marked **🔒 on-chain enforced**.
- **Honest scope labels** — amount/token/reset/delegate = 🔒 on-chain;
  recipient = **ⓘ not constrained on-chain today** (the `to` in
  `executeAllowanceTransfer` is arbitrary). Truthful, and the right home for the
  optional recipient-pinning enhancement later.
- **"What Haven cannot do"** — a short, plain-language panel derived from the
  Hard Invariants (cannot move funds unilaterally, holds no keys, cannot expand
  allowances without your signature, cannot block you).

Actions (all user-authority, already supported):

- **Revoke agent on-chain** — the existing user-signed revoke flow
  ([`revoke-agent.ts`](../../packages/frontend/src/lib/revoke-agent.ts)),
  surfaced here as the circuit breaker.
- **Open in Safe\{Wallet\}** — a deep link to the user's Safe in the official
  Safe UI, proving "Haven is replaceable infrastructure" (Red Line #10) in one
  click.

**Value:** turns the guardrails into a *trust feature* a prospect or auditor can
see, and matches the doc's Product Copy Rules ("you can revoke agent access
through your Safe"). New backend work is minimal — mostly composition + a deep
link + honest labels.

## What this is NOT

- Not new authority, not a new signer, not fund movement.
- Not recipient/expiry on-chain enforcement — that's a separate *optional*
  enhancement (a Safe Guard / session-key) with real UX cost; this proposal only
  *labels* the current boundary honestly.
- Not a legal opinion — engineering evidence that supports the existing position.

## Phasing

- **P0 — CI invariants (Part 1).** Pure value, no UX, no risk. Lands the
  evidence the guardrails ask for and protects it forever.
- **P1 — "Verify your control" view (Part 2).** Composition over existing
  endpoints + the Safe\{Wallet\} deep link + honest labels.
- **P2 — (optional) verifiable receipts** — overlaps the bookkeeping audit trail
  ([#462](https://github.com/d-hinders/Haven-AI/issues/462)); a signed
  per-payment proof bundle the user verifies independently.

## Open questions

1. Does `/safe/:addr/details` already return enabled modules, or is that the one
   small backend addition for Part 2?
2. Retire the legacy plaintext `agents.api_key` column entirely (invariant #2)
   as part of P0, or track separately?
3. CI checklist gate: PR-template checkbox vs a Danger-style automated check on
   changed paths?

## References

- [`casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md) — the source of every invariant above.
- [`allowance-module.ts`](../../packages/backend/src/rails/allowance-module.ts) — on-chain allowance READ. (The relayer-gas-only transfer it also held was deleted by #1987; see the addendum above.)
- [`02-identity-and-custody.md`](../architecture/02-identity-and-custody.md) — the custody model this makes provable.
