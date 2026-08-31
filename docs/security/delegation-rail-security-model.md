---
owner: "@d-hinders"
status: current
contract: true
covers:
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/routes/agent-rekey.ts
  - packages/backend/src/modules/agents/rekey-*.ts
  - packages/backend/src/routes/hybrid-accounts.ts
  - packages/backend/src/rails/hybrid-signer-actions.ts
  - packages/backend/src/rails/hybrid-transfers.ts
  - packages/backend/src/infra/repositories/hybrid-signers.ts
  - packages/backend/src/rails/hybrid-account-config.ts
  - packages/backend/src/modules/accounts/mainnet-gate.ts
  - packages/frontend/src/components/AccountSignersCard.tsx
  - packages/frontend/src/hooks/useDelegationBudget.ts
  - packages/frontend/src/hooks/useAgentRekey.ts
  - packages/frontend/src/hooks/useAccountSigners.ts
  - packages/frontend/src/hooks/useDelegationSend.ts
  - packages/frontend/src/lib/hybridAccountOps.ts
  - packages/frontend/src/lib/delegationPasskeySigner.ts
  - packages/frontend/src/lib/signer.ts
  - packages/frontend/src/hooks/useSafeOperationGate.ts
  - packages/frontend/src/components/DelegationSendModal.tsx
  - packages/qa-agent/src/pilot/delegation-budget-spike.ts
last-verified: "2026-08-26" # #2073: the gate's unrelated-wallet answer gains its own name — `useSafeOperationGate` returns `wrong_wallet` (with both addresses) where #2068 returned `no_signer` for a connected non-owner wallet on a hybrid account. Re-read §6's gate sentences against `hooks/useSafeOperationGate.ts` as changed: "an unrelated wallet stays `no_signer`" was made false by this diff and is rewritten; the security posture is unchanged (every consumer treats `wrong_wallet` as blocked — `isOnchainActionBlocked` is `kind !== 'ready'` — and the state is produced only by the hybrid branch's address compare; the owner on the wrong network stays `no_signer` so wrong-chain guidance keeps precedence). What changes is what the UI says: `OnchainActionGate` renders a message naming both addresses, and the header `WalletButton` renders a "Wrong wallet" pill instead of the normal connected pill, so the header and the action area stop silently disagreeing (the #2072 design-review finding this state exists to close). Mutation-proven: collapsing the `wrong_wallet` return back into `no_signer` turns useSafeOperationGate.test.ts > "owner-only set is WRONG_WALLET for an UNRELATED connected wallet, never ready (#2068/#2073)" and "wrong_wallet is keyed on the ADDRESS alone" red while the #2068 owner-READY and no-wallet no_signer controls stay green; deleting the message branch turns OnchainActionGate.test.tsx's distinct-message and null-default-unreachable tests red; neutralising the pill turns WalletButton.test.tsx > "renders the WRONG WALLET pill" red. App-state rendered evidence: e2e/wallet-signer-offering.spec.ts owner-match/mismatch pair through a real wagmi injected-connector reconnect (no forced props), and the `wrong-wallet` screenshot scenario (both committed viewports). No §6a, §7 or §8 claim was re-tested beyond re-reading for contradiction, and none contradicts. Prior: #2068: the EOA rung of the #1969 precedence is now an ADDRESS match, not a connection check. Re-read the marker-less signer-offering paragraph against `hooks/useDelegationBudget.ts` (`pickSigningPath`), `lib/signer.ts` (`useActiveSigner`) and `hooks/useSafeOperationGate.ts` as changed: "connected EOA when the set names an owner" compared nothing to `owner_address`, so a mixed account with an UNRELATED wallet connected was offered the EOA path and failed at signature verification — the paragraph's "this offers no signer that cannot sign" claim was aspirational for that rung and is now true as written. The rung requires connected address == owner_address (case-insensitive); a non-owner wallet falls to the passkey rung; an owner-only set with a non-owner wallet resolves null (offered-but-failing is worse than absent), and a hydrated set never falls through to the generic connected-EOA branch. The gate's hybrid branch gains the owner-only READY (same address check; unrelated wallet stays no_signer) — the second pre-existing shape #2068 recorded. Mutation-proven both directions: reverting the address check to the boolean shape turns useDelegationBudget.test.tsx > "mixed set + unrelated connected wallet -> passkey, never eoa" and signer.test.ts > "mixed account: an UNRELATED connected wallet never takes the EOA rung (#2068)" red while the #1969 mixed-account regression pin ("a connected EOA still wins when no device marker matches") stays green; reverting the gate's owner-only branch turns useSafeOperationGate.test.ts > "owner-only set is READY when the connected wallet IS the named owner (#2068)" red. No other §6 sentence changes truth value; §6a, §7 and §8 were re-read for contradiction only, and none contradicts. Prior: #1969: §6 gains the marker-less signer-offering paragraph — an owner decision (2026-08-26, recorded on the issue) replacing an implicit refusal. Re-read §6's device-signing sentences against `lib/signer.ts`, `hooks/useSafeOperationGate.ts`, `hooks/useDelegationBudget.ts` and `components/WalletButton.tsx` as changed: `useActiveSigner` now resolves any NON-EMPTY hydrated signer set, mirroring `pickSigningPath`'s exact precedence (marker-matched passkey -> connected EOA when the set names an owner -> any passkey), so display and signing cannot name different answers, mixed accounts keep the connected-EOA path, and the marker-less credential is disclosed via #1952's wallet-menu rendering, which this decision makes reachable in the product. `useSafeOperationGate`'s hybrid branch answers `ready` for a non-empty set (the pre-#1969 `passkey_on_other_device` was a #1097 false blocker for a set that signs cross-device); the legacy-Safe `passkey_on_other_device` stands, and `covers:` gains `hooks/useSafeOperationGate.ts` because the new sentence about that gate is made true or false by that file. Mutation-proven: reverting the `signer.ts` resolution turns `signer.test.ts` > "resolves the hybrid signer for a non-empty set when the device marker is missing (#1969)" red; deleting the precedence mirror turns "mixed account: a connected EOA still wins when no device marker matches (#1969 precedence mirror)" red while the marker-matched and pure-passkey cases stay green; reverting the gate turns the renamed READY gate test red. App-state rendered evidence: `e2e/wallet-signer-offering.spec.ts` reaches BOTH states through real hydration (no forced props, no mocked hook). The #1933 fallback paragraph and every other §6 sentence were re-read and stand; no §6a re-key, meter-carry, threshold, §7 two-signer or §8 settlement claim was re-tested beyond re-reading for contradiction, and none contradicts. Prior: #1868: §6a gains an EIGHTH property — an abandoned post-revoke re-key is recoverable on the owner's explicit signal, never on a clock. Re-read §6a in full against `routes/agent-rekey.ts` and `infra/repositories/agent-rekeys.ts` as changed: the fresh re-key inherits the abandoned row's frozen snapshot AND clocks (so the #1849 measurement-clock property composes rather than being bypassed), the abandonment signal is `stage='abandoned'` only (no time-based reclaim exists — verified by grep, no `NOW() - metered_at` predicate anywhere), adoption is refused when any grant landed after the abandoned revoke (over-grant guard, fail-closed to the empty walk), and a completed re-key's snapshot is never adopted. All four claims mutation-proven in `infra/repositories/__tests__/agent-rekeys.test.ts` (adoptAbandonedCarry block) and `routes/__tests__/agent-rekey-abandon-recovery.test.ts`. The meter-carry and measurement-clock bullets were re-read and stand unchanged; no signer-set, enrolment, removal, threshold, §7 two-signer or §8 settlement claim was re-tested beyond re-reading for contradiction, and none contradicts. Prior: #1937: the AccountSignersCard loadError panel moved from neutral surface/ink-2 tokens to the canonical danger treatment (border-danger/20, --v2-danger-soft, --v2-danger text) — a display/state change with no logic, prop or copy delta, and no §6/§6a/§7 security claim affected: the #1085/#1097 rendering sentences this file covers (dismissed-sheet neutral cancel, hint-not-blocker) are untouched. Scope: that one panel's class strings only. Prior: #1992: the intro parenthesis still called the legacy AllowanceModule path "the only other live rail ... serves existing Safes only". It is RETIRED, not merely closed to new accounts - #1986 fail-closes spending and #1987/#1988/#1989 deleted the machinery - so the delegation rail is the only live rail and every "vs the Safe/session stack" comparison below is a comparison against a retired baseline. Scope: the intro paragraph of the header section. The §1 invariant table was re-read and needs no change (it already frames the session/legacy column as a historical baseline); §§2-7 were NOT re-verified. Prior: #1984: the "the only other live rail is the legacy AllowanceModule path, import-only for existing Safes" parenthesis was overstating what that rail still accepts — import is now 410 as well. Corrected in place; no security claim in the body changes, and the CASP re-basing this doc is the mapping for is slice #1991, deliberately not started here. Prior: Promotion review: re-read §6a against the comment-only useAgentRekey change; the structured-field boundary and #1699/#1849/#1868 security claims stand unchanged. Corrected the property count from six to seven. Prior: #1933: the device-marker SELECTOR moved, so the `covers:` decision recorded below had to be re-taken: `covers:` gains `lib/signer.ts`. #1927 excluded that file on its own test — is a sentence here made true or false by this file — and the answer was no, because `signer.ts` held only the MECHANISM (`hasPasskeyCredentialOnDevice`/`credentialIdFromKeyId`) while the SELECTION lived in `delegationPasskeySigner.ts`. #1933 extracted the duplicated selection into `hybridPasskeyToSignWith` in `lib/signer.ts` and both call sites now use it, so the sentence "the signing ceremony selects the passkey whose credential is actually enrolled on the signing device rather than blindly `passkeys[0]`" — and the `passkeys[0]` fallback sentence after it — are now made true or false BY `signer.ts`. The exclusion reasoning was about WHERE the rule lives, and the rule moved; leaving it in place would have left the doc's central §6 client claim watched by nothing, which is the exact gap #1927 was filed to close. The over-firing objection #1927 raised is real and unresolved rather than refuted — `signer.ts` is a broad utility module (storage keys, the active-signer hook, Safe-capable narrowing) and this gate will now fire on churn this doc does not depend on. That is handled the way `DelegationSendModal.tsx` already is here: coverage is SCOPED, and a change confined to the storage/hook/narrowing half of `signer.ts` is dismissed with one line rather than treated as a doc defect. `delegationPasskeySigner.ts` STAYS covered — it holds the wiring, the empty-signer-set refusal, and the pinned-address property the §6 sentences also assert. The asymmetry the gate had until now was measured, not assumed, and the instrument was proven able to say yes before any zero was believed: on `origin/dev` @ d48622d7, a one-line edit confined to `lib/signer.ts` produced 0 hits for this doc; the positive control, the same edit confined to the already-covered `lib/delegationPasskeySigner.ts`, produced 1 (BLOCKING); and two negative controls (`lib/money-input.ts`, `lib/transaction-csv.ts`) produced 0 each. With `signer.ts` listed, the target run goes 0 -> 1. Prose changed in exactly one place: §6's parenthetical named `lib/delegationPasskeySigner.ts` as "the one place the credential is chosen", which the extraction made false; it now names `hybridPasskeyToSignWith`. Every other §6 device-signing sentence was re-read against the extracted code and stands unchanged, including the fallback paragraph — the fallback is preserved verbatim in behaviour and now carries a named regression test, `lib/__tests__/signer.test.ts` > "keeps passkeys[0] as the fallback when no device marker is present (#1933 — load-bearing, do not delete)", proven by mutation this pass rather than assumed: deleting `?? signers.passkeys[0]` turns that named assertion red (`expected undefined to be '0x0102030405060708'`) along with `delegationPasskeySigner.test.ts` > "falls back to passkeys[0] when no device marker matches", while the two device-marker cases stay green — so the test discriminates the fallback specifically and is not shadowed by the empty-set guard. Scope: §6's device-signing sentences only; no §6a re-key, meter-carry, threshold, §7 two-signer or §8 settlement claim was re-tested beyond re-reading it for contradiction, and none contradicts. Prior: #1927: `covers:` gains `lib/delegationPasskeySigner.ts` — the file that DEFINES the passkey-selection claim, and the correction of a record #1898 got right for the wrong reason. #1898 verified "signing selects the passkey actually enrolled on the signing device, never blindly passkeys[0]" against `pickSigningPath` in `hooks/useDelegationBudget.ts`. The verdict was true; the evidence was for a different claim. `pickSigningPath` chooses the signing PATH — passkey vs EOA vs nothing — and never touches WHICH passkey; the credential is chosen at `lib/delegationPasskeySigner.ts:80-82` (`signers.passkeys.find(...hasPasskeyCredentialOnDevice...) ?? signers.passkeys[0]`), which was uncovered until now. That is the one line a refactor could quietly restore to `passkeys[0]`, breaking recovery from a backup device — the whole point of §6 — with nothing in this doc’s gate able to notice. Re-read §6’s device-signing sentences against the file as merged: the claim holds, and it is now stated more precisely than #1898 left it. Two prose corrections, both from reading the covered file rather than from any behaviour change. (1) The sentence implied `passkeys[0]` is never reached; it IS reached, as the documented fallback when no device marker matches, and the doc now says so and says why that is safe rather than a loophole — the marker is a local `localStorage` hint, so a miss costs a ceremony the authenticator resolves from its own credential lookup, not a wrong signature. Leaving the absolute reading in place would have been the worse trade: the next reader deleting the fallback would have been "complying" with the doc. (2) The *Storage tracks the chain* invariant said the stored signer set is what "the deploy/sign paths rebuild the account config from" — true of the deploy path, and materially incomplete for the client sign path since #891: the account ADDRESS handed to `toMetaMaskSmartAccount` is pinned to the provisioned one and never re-derived from the current set, precisely because the set can have evolved (backup enrolled, key removed) and re-deriving would sign as a different account. The invariant’s security content is unchanged; what changed is that the parenthetical no longer describes a derivation the code deliberately does not do. The selection claim already has a real test guard, and it was proven by mutation this pass, not assumed: replacing lines 80-82 with `const signWith = signers.passkeys[0]` turns `lib/__tests__/delegationPasskeySigner.test.ts` > "signs with the passkey that is enrolled on THIS device, not blindly passkeys[0]" red (expected the backup credential id, received the first-enrolled one), while the other two cases stay green — so the test discriminates the exact behaviour the sentence asserts rather than merely exercising the line. `lib/signer.ts` was considered and deliberately NOT covered, on #1898’s own test — is a sentence here made true or false by this file: it holds `hasPasskeyCredentialOnDevice`/`credentialIdFromKeyId`, mechanism the claim consumes, but the sentence is about the SELECTION, and `signer.ts` is a broad utility module (Safe-capable signer narrowing, the active-signer hook, storage keys) whose ordinary churn carries no claim here; covering it would fire the gate on changes this doc does not depend on, which is how a gate gets waved through. Scope: §6’s device-signing sentences and the *Storage tracks the chain* invariant only; no §6a re-key, meter-carry, threshold, §7 two-signer or §8 settlement claim was re-tested beyond re-reading it for contradiction, and none contradicts. Prior: #1916: `covers:` gains the SIGNER-MANAGEMENT and OWNER-SEND clients — the other half of the gap #1898 opened, and again no prose changed, because nothing here was false; the gate simply could not see the files these claims depend on. Re-read §6's *Management surface (#1081)*, *Owner send (#1083)* and *Recovery invariants* paragraphs against `hooks/useAccountSigners.ts`, `hooks/useDelegationSend.ts` and `lib/hybridAccountOps.ts` as merged. "The frontend now uses the account-scoped surface exclusively (#1089)" is checkable and TRUE of the management surface — `useAccountSigners.ts` is the only frontend caller of `/accounts/hybrid/:address/signers/{prepare,submit}`, and the two surviving `/agents/:id/account-signers` calls (`useDelegationBudget.ts:162`, `useAgentRekey.ts:249`) are READS of the signer set, not signer changes, so they do not contradict it. Invariant 13's client half — every `addKey`/`removeKey`/`transferOwnership` "signed by an existing signer (WebAuthn or EOA)", never Haven — is `signPreparedAccountOp` in `lib/hybridAccountOps.ts`, the single dispatch BOTH surfaces route through: it obeys the server's declared `signature_scheme` verbatim and has a single `if`/else with no third branch, so no client path can sign an op the server did not shape. (The "one implementation … two copies of a spend-authority rule is how they drift apart" sentence above names `rails/hybrid-signer-actions.ts` and is about the BACKEND; this file is the client-side analogue, not the thing that sentence refers to.) §6's owner-send properties hold as written in the client: prepare/submit split, the submit carrying `prep.user_operation` back, and the scheme chosen by the DEVICE (`useDelegationSend.ts:70`). #1085's "a DISMISSED sheet is a neutral cancel, never an error" and #1097's "hint next to the working action, never a false blocker" hold in both hooks — `ready` derives from `pickSigningPath` alone and `passkeyElsewhere` is returned beside it, never folded into the gate. `components/DelegationSendModal.tsx` is covered too, and ONLY for the #1085/#1097 client-rendering claims — worth stating, because the next reader will notice that this file and `AccountSignersCard.tsx` have different §7 status yet share §6 coverage. The reason is that those two sentences say "UI surfaces" in the PLURAL and are rendered in components, not hooks: `DelegationSendModal.tsx:71` is the `toast.info`-not-`toast.error` cancel classification and `:127` the `ready && passkeyElsewhere` hint branch, line for line `AccountSignersCard.tsx:75` / `:206-217`. Before this change the gate caught a mutation flipping cancel from `info` to `error` in one of those files and not the other — for the SAME sentence — which is a gate that half-works on a claim it advertises. Narrowing the plural to one surface was the alternative and is the worse one: the product genuinely does treat a dismissed sheet as a neutral cancel on both, so rewriting the sentence would trade a TRUE claim for a convenient gate. Note what this is NOT: #1898 excluded `ReplaceSigningKeyModal.tsx` because the doc claims NOTHING about it, and covering it would have fired on #1887's pure layout move. The test is not "does the file belong to this feature" but "is a sentence in this doc made true or false by this file" — for `ReplaceSigningKeyModal.tsx` it is not, and for the #1085/#1097 rendering it plainly is. The rest of `DelegationSendModal.tsx` — amount entry, recipient validation, layout — carries no claim here, and a change confined to it should be dismissed with one line rather than treated as a doc defect. NEW gap found doing this, filed not folded (#1927): "signing selects the passkey whose credential is actually enrolled on the signing device rather than blindly `passkeys[0]`" is DEFINED in `lib/delegationPasskeySigner.ts:81-83` and is still uncovered; #1898 verified that sentence against `pickSigningPath`, which chooses the PATH (passkey vs EOA) and never the CREDENTIAL. The sentence is true — the earlier note cited the wrong site for it, and that correction is the point of recording this here. Scope: §6's management/owner-send/recovery-invariant paragraphs and only their client half; no §6a re-key, meter-carry, threshold, §7 two-signer or §8 settlement claim was re-tested beyond re-reading it for contradiction, and none contradicts. Prior: #1849: the meter-carry bullet gains a SIXTH property in §6a — the carry is planned on the clock the remainder was MEASURED on (`agent_rekeys.metered_at`), with the issue-time clock used only to drop a piece the delay outran. Re-read the whole meter-carry bullet against `modules/agents/rekey-carry.ts` and `routes/agent-rekey.ts`: its existing claims were true of the SAME-period case and quietly wrong across a boundary — "anchored inside the old period" named a period the code did not compute, and "either piece may be absent rather than wrong" listed two causes where there are now three. Both are corrected in place, and the direction of the old defect is recorded (under-grant, never over-grant) so the no-refill invariant above it is visibly unaffected. Scope: that bullet only; no signer-set, enrolment, removal, threshold, recovery, revoke-ordering or passport-anchor claim was re-tested beyond re-reading them for contradiction, and none contradicts. Prior: #1898: `covers:` gains the CLIENT half of the device-scheme rule — no prose changed, because nothing here was false; the gate simply could not see the files two claims depend on. Re-read §6 and §6a in full against `hooks/useDelegationBudget.ts` and `hooks/useAgentRekey.ts` as merged by #1902: `pickSigningPath` prefers a passkey marked on THIS device, falls back to a connected owner wallet, then to any passkey — so "selects the passkey actually enrolled on the signing device, never blindly passkeys[0]" and "enrolling a backup wallet never disables the passkey path" both hold as written; `passkeyLikelyElsewhere` is read only into a hint, and the re-key's sole refusal is `no_signer`, so #1097's "never a false blocker" holds too; §6a's fifth property holds in both directions — the hook sends `signature_scheme` on the revoke prepare and branches on the scheme the SERVER resolved. `ReplaceSigningKeyModal.tsx` was considered and deliberately NOT covered: this document claims nothing about its copy or its revoke gate, so listing it would fire the gate on changes no claim here depends on, and a gate that fires on nothing gets waved through. Scope: §6/§6a only, and only their client half — no signer-set, enrolment, removal, threshold, recovery, meter-carry or passport claim was re-tested beyond re-reading for contradiction, and none contradicts. Known remaining gap, filed not folded: `hooks/useAccountSigners.ts`, `hooks/useDelegationSend.ts` and `lib/hybridAccountOps.ts` carry §6's signer-management and owner-send (#1083/#1086) client claims and are still uncovered. Prior: #1699: §6a gains a SIXTH security property — the passport ANCHOR is retired and reissued on a re-key while `standing` never moves. Re-read §6a in full: its opening claim that re-key keeps "the agent's id, name, history and passport" was true of the passport's IDENTITY and false of its on-chain anchor, which until #1699 kept naming the retired delegate EOA (#1847); the word *identity* is now explicit and the gap it papered over is the new bullet. The revoke-before-issue rule is restated one layer up rather than re-derived — same argument, same failure asymmetry. Scope: §6a only; no signer-set, enrolment, removal, threshold, recovery or meter-carry claim was re-tested beyond re-reading them for contradiction, and none contradicts. Prior: #1870: §6a gains a FIFTH security property — the revoke leg is signed by a signer the DEVICE chose, not one the server inferred. Re-read §6 and §6a in full against `routes/agent-rekey.ts` and `rails/hybrid-signer-actions.ts`: §6's "scheme selection is a device decision (`signature_scheme` on the prepare routes)" was TRUE of the delegation routes and FALSE of the re-key revoke, which passed no signer down at all; the claim is now true as written. The new bullet records the refusal ORDERING (409 in prepare, before the revoke) as the security property, not the field. Prior: #1702 (carve-out): §6a gains a FOURTH security property — the budget meter carries amount AND period boundary across a re-key, as the defence against using rotation to refill a budget. Re-read §6 and §6a in full against `modules/agents/rekey-carry.ts` and `routes/agent-rekey.ts` as merged by #1698; every existing claim stands, and the three recorded owner decisions (revoke before issue, meter read AFTER revoke, period carries over) match the code. Scope: §6/§6a only — no signer-set, enrolment, removal, threshold or recovery claim re-tested beyond what #1709 covered the same day. Prior: #1709: pulled in only because the border-token sweep touched `AccountSignersCard.tsx`. That change is a class-string rename (`border-[var(--v2-warning)]/25` -> `border-warning/25`) on one advisory callout — no signer-set, enrolment, removal, threshold, or recovery claim in this document is affected, and the diff for that file contains no logic, prop or copy change. Re-read the signer-management sections against it; they stand unchanged. Scope: that verification only — no other claim re-tested. Prior: #1698: new §6a — agent delegate-key rotation is a DIFFERENT layer from the account signer set, and its loss has the opposite answer (recoverable, because the delegate never held owner authority); revoke-before-issue, non-custody and no-self-rekey recorded as security properties; covers: widened to the re-key surface. Prior: #1679: signers read gains per-credential created_at (read-only timestamp for UI labels) — read/management boundary and every invariant unchanged; the read-surface paragraph updated to match. Prior: #1605: comment-only tense corrections in hybrid-accounts route + migrations 041/043 (stale "until #829/#834" claims) — no executable code, SQL, or boundary moves; every claim in this doc re-read against the diff stands. Prior: #1436: archiving now requires dead budgets as well as a revoked credential (one statement, refusal-only), so "Removed" cannot hide a spendable agent. #1423: revoke-all prepare reconciles crash-window orphans against disabledDelegations() and caps batches at 25; #1400: batch revoke-all — one owner-signed UserOp disables N delegations atomically (BatchDefault); DB write only after the UserOp lands; invariants unchanged. Prior: #1199 passkey/wallet removal two-to-one rule
---

# Delegation rail — security model & exit story (epic #821, gate G4)

Design doc for issue #824. The delegation stack (Hybrid DeleGator accounts +
MetaMask Delegation Framework) changes Haven's security model in three ways
the Safe/session stack did not have; this doc names them, maps every existing
non-custody invariant to its delegation-rail equivalent, fixes the custody
semantics of the delegation object itself, and specifies the independent exit
story with an acceptance test. (Since #834 the Smart Sessions **session rail
is retired** — `session_key` accounts get HTTP 410 from the payment paths —
so the "Safe/session stack" comparisons below are the mapping's historical
baseline. **The legacy AllowanceModule path is now retired too (#1440), so the
delegation rail is the only live rail** — nothing can enter it (#1984), nothing
on it can spend (#1986, HTTP 410 fail-closed on every payment and x402 entry
point), and its execution machinery is deleted (#1987/#1988/#1989). Existing
Safe accounts remain readable, and `POST /safe/exec` remains open for
owner-signed execution relayed for gas; neither is a policy rail. Read every
"vs the Safe/session stack" comparison below as a comparison against a
**retired** baseline, not a live alternative.) The implementation issues are #831 (CI
invariants) and #832 (exit tool); this doc is their contract.

Contracts in scope (Base Sepolia; mainnet addresses pinned at #825): 
DelegationManager `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`, the Hybrid
DeleGator implementation behind `toMetaMaskSmartAccount`, and the caveat
enforcers referenced below — all Consensys Diligence-audited (Aug 2024 / Apr
2025), deployed immutable, and forkable. Spike evidence:
[`delegation-budget-rail-spike.md`](../research/delegation-budget-rail-spike.md).

## 1. What changes vs the Safe/session stack

1. **UUPS upgradeability.** A Hybrid DeleGator is a UUPS proxy whose upgrade
   authority is the account's **own signers** — not Haven, not MetaMask. This
   is a new surface (the Safe proxy pattern had owner-controlled masterCopy
   semantics, but our stack never exercised it). Consequence: "who can
   upgrade" becomes part of the custody perimeter and must be provable.
2. **Authority is a held object, not account state.** A Smart Sessions grant
   lives in account storage; a delegation is a **signed message the agent
   holds**. Different theft model: exfiltrating a delegation (plus the
   delegate key) is sufficient to spend — but only within the caveat stack.
3. **The exit story loses Safe{Wallet}.** Haven's CASP/GTM line — "inspect
   and revoke everything without us" — was demonstrable via a mature
   third-party UI. On this stack it must be **rebuilt and demonstrated**
   (§4) before any external user touches the rail.

## 2. Invariant mapping (implemented — `non-custody.invariants.test.ts`, #831)

Every invariant in `non-custody.invariants.test.ts` maps as follows. "CI"
means a named check in the delegation-rail invariant suite; nothing is
dropped.

| # | Session/legacy invariant (baseline; session rail retired, #834) | Delegation-rail equivalent | Enforcement |
|---|---|---|---|
| 1 | No private-key/seed columns in the schema | Unchanged, plus: **no delegation-signing key columns** | CI (schema scan) |
| 2 | Agent secrets stored hashed | Unchanged | CI (existing) |
| 3 | Exactly one server-side signer: the gas-only relayer | **Zero** value-bearing server signers on this rail (no relayer leg exists); the sponsorship credential is the only vendor secret | CI (signer-construction scan scoped to the delegation rail) |
| 4 | No server-side key generation | Unchanged — delegate keys and account owners are client-generated | CI (existing, extended to delegation modules) |
| 5 | Session-rail owner is watch-only (refuses to sign) | Account interactions use a **watch-only owner**; Haven never holds a DeleGator signer | CI (watch-only pattern scan) |
| 6 | No viem key-based signers server-side | Unchanged, extended to `smart-accounts-kit` call sites | CI |
| 7 | UserOps submitted with caller-provided signature only | Redemptions submitted with **client-signed** UserOp/tx only; the backend constructs and relays, never signs | CI (the #737 pattern, delegation flavor) |
| 8 | Session-config modules signer-free | Delegation lifecycle modules (grant/replace/revoke construction, #827/#828) are **signer-free and relayer-free**: they build payloads and typed data, never sign | CI (module import/AST scan) |
| 9 | Bundler credential read in exactly one place | Unchanged (one choke point; `redactVendorSecrets` on every error surface) | CI (existing) |
| 9a | *(new, #1061)* **Redaction covers the shapes vendors actually use** | `redactVendorSecrets` catches `apikey=`/`api_key=`/`api-key=`/`key=`/`token=`/`secret=` query params, URL basic-auth (`https://user:pass@host`), and key-in-path segments (`/rpc/<token>`, `/v2/<token>`) — not just the one `apikey=` spelling | Unit tests on the redactor |
| 10 | Paymaster has no value-transfer surface | Unchanged — sponsorship pays gas only; proven in the spike (agent key held zero ETH and zero USDC) | CI + spike evidence |
| 11 | *(new)* **No upgrade path from Haven code** | Haven's codebase contains no call site that can reach the account's UUPS upgrade function; upgrade authority = account signers only | CI (ABI/selector scan for `upgradeToAndCall` against DeleGator targets) |
| 12 | *(new)* **Delegations are client-signed only** | No Haven code path calls `signDelegation`/EIP-712 delegation signing with a server-held key (pilot scripts with throwaway testnet keys excepted, path-scoped) | CI (import + call-site scan) |
| 13 | *(new, #888)* **Signer changes are client-signed only** | Enrolling/removing a backup signer (`addKey`/`removeKey`/`transferOwnership`) is PREPARED by Haven and signed by an EXISTING account signer; the submit step pins the DB sync to the signed calldata. Haven holds no key that can change an account's signer set. Since #1081 this is one shared implementation reached by both the agent-scoped and account-scoped routes | CI (shared-core + both-routes + config-loader scan) |

**Monitored-not-enforced:** enforcer/manager *contract immutability* is a
property of the deployed bytecode, not our code — covered by pinning exact
addresses with audit provenance (#825) and the #826 tripwires (framework repo
activity, alternative 7710 implementations), not by CI.

**Passport attestations (#970) — a new relayer use, still not value-bearing:**
the L0 agent-passport anchor (`modules/passport/attestation.ts`) is the one place
the relayer signs something other than gas on a user-authorised transaction —
it submits EAS `attest`/`revoke` calls with Haven as issuer. That is governance
metadata, not spend authority: the transaction targets the pinned EAS contract
only, carries zero value, encodes no transfer, and involves no user key,
delegation, or allowance (a test pins the target and the zero value). It does
not add a value-bearing server signer, so invariant 3 stands. See
[11-agent-passport-schema](../architecture/11-agent-passport-schema.md).

**Relayer gas budgets (#717) — an availability control on the same signer:**
every relayer-paid operation (deploys, execs, allowance transfers, sweeps)
runs a per-identity window budget before the relayer signs (over-cap → 429,
the intent/sweep left retryable, never burned) and records its submitted txs
with receipt gas numbers (`relayer_gas_events`) for attribution. Direction of
failure is the OPPOSITE of the money-path gates and deliberate: a database
error fails **open**, because this guard protects the shared gas sponsor's
availability while funds stay caveat-gated on-chain regardless — failing
closed would let a DB hiccup take down the very operations it exists to keep
up.

## 3. Delegation custody semantics (#828's contract)

**Where the signed delegation lives:** the agent receives it through the
existing credential channel (same trust envelope as the agent API key).
Haven stores a copy server-side for reconstruction, revocation targeting and
observability. It is **not** key material — but it is spend-enabling in
combination with the delegate key, so it is stored with the same care as
`api_key_hash`-class data: encrypted at rest, never logged, never in error
surfaces.

**Leak analysis:**

| Compromised | Attacker gets | Bounded by |
|---|---|---|
| Delegation object alone | Nothing — redemption requires the delegate key's signature | — |
| Delegate key alone | Nothing beyond existing agent-credential risk — no delegation, no authority | — |
| Both (agent fully compromised) | Spend **within the caveat stack**: ≤ period budget per period, only to pinned recipients, until expiry or revocation | `MultiTokenPeriodEnforcer` + `allowedCalldata` + `Timestamp`; owner kill-switch `disableDelegation` |
| Haven fully compromised | Constructs malicious payloads but **cannot sign** grants, redemptions, or upgrades (invariants 3/5/7/11/12); worst case = denial of service | The perimeter this doc exists to prove |

Blast radius on full agent compromise is therefore **identical in kind** to
the retired session rail's (one period's budget per recipient) — with
revocation one `disableDelegation` away.

**Batch revocation (#1400):** `POST /agents/:id/delegations/revoke-all`
prepares ONE UserOp batching a `disableDelegation` call per pending/active
delegation (`prepareCalls`, `ExecutionMode.BatchDefault` — atomic: all
disable or none do). The owner signs that UserOp exactly as a single revoke;
Haven still cannot sign it (invariant 3 unchanged). Fail-closed ordering: the
DB rows flip to `revoked` only AFTER the UserOp lands, so a crash window can
leave on-chain-disabled rows still marked active (a directionally safe
surplus — a later redemption attempt reverts on-chain), never the reverse.
Because `disableDelegation` is NOT idempotent (`AlreadyDisabled` revert) and
the batch is atomic, the prepare step reconciles that window (#1423): it reads
`disabledDelegations(hash)` for every candidate, heals already-disabled rows
to `revoked`, and drops them from the batch — a failed read degrades to the
full batch rather than blocking revocation. A heal marks a row revoked
WITHOUT an owner signature, so a false positive would defeat the kill switch
— therefore reads are pinned to `finalized` (no reorg transients), a hash
counts as disabled only when TWO consecutive reads agree, and every heal is
logged distinctly from an owner-signed revoke. A persistently lying RPC
endpoint remains outside this control's threat model — the same endpoint
already sits under gas estimation and submission on this rail. The same
heal-or-prepare check guards the per-hash revoke route (409 "Already
revoked … reconciled" instead of an eternal 502). Batches are capped at 25
calls (422 pointing at per-hash revocation beyond it), with a coarse
pre-read ceiling of 100 so an over-cap agent cannot burn unbounded RPC reads
either. An empty batch is a 409
(`Nothing to revoke`), which callers treat as already-done. The
per-delegation revoke and the kill-switch story above are unchanged.

**Archiving cannot hide a live agent (#1436).** "Removed" is a promise about
spending, so the database enforces it: `ARCHIVE_AGENT_SQL` requires
`status='revoked'` **and** `NOT EXISTS` any `pending`/`active` row in
`agent_delegations`, in one statement. Revoking flips only the agent's status —
it never touches delegations — so before this, revoke+archive through the API
(bypassing the dashboard's revoke-all-first ordering) could file an agent under
Removed while its budget stayed redeemable on-chain. The refusal names the
remedy that applies (`revoke-all` for live budgets, "revoke first" for a live
credential) rather than one generic 409. Legacy AllowanceModule agents hold no
rows in that table, so the guard passes for them and their teardown remains the
on-chain revoke path. The guard only ever REFUSES: it grants nothing, signs
nothing, and touches no chain.

**Credential revocation closes new grant lifecycle steps (#2025).** An agent
already revoked at request entry cannot build or activate a fresh delegation:
both routes refuse before constructing a budget, parsing an owner signature,
deploying an account, or changing delegation state. The build and activation
database transactions re-check the lifecycle row before their writes, so a
revoke that races the initial read cannot create a new pending or active record
(it may still do preliminary activation work before the later lock). Of the ten
owner-scoped lifecycle callers, only build and activate are guarded; the list
read, account-signer read/prepare/submit, revoke-all prepare/submit, and
per-hash revoke prepare/submit remain deliberately exempt for audit, recovery,
and removal of authority already issued. This is deliberately not a replacement
for the owner signature or the on-chain caveats, which remain the authority and
enforcement.

## 4. Exit story — design + acceptance test (#832's contract)

**Claim to keep true:** *a user can enumerate and revoke every authority on
their account, and recover control of the account itself, without Haven.*

Design (minimum viable, in order of preference):

1. **A statically hostable, open-source exit page** (no Haven backend): connect
   the account's owner (passkey or EOA) → enumerate delegations Haven has
   issued for the account (from public inputs: the account address + the
   published caveat/enforcer addresses; delegations are off-chain objects, so
   enumeration uses redemption events + `disabledDelegations` reads for state,
   and Haven's published delegation-format doc for decoding) → one-click
   `disableDelegation` per row → signer management (add/remove passkey/EOA).
2. **A documented manual path** (published in Haven's public docs): the same
   two operations via a block explorer with the DelegationManager ABI — exact
   contract addresses, function names, and argument construction, written for
   a technically competent user.

**Honest limitation to document:** off-chain delegations that Haven issued but
never surfaced cannot be *discovered* by a third party until first redemption
— the exit page therefore also renders Haven's attested list when available,
but the **revocation guarantee never depends on Haven**: `disableDelegation`
works on any delegation the user can reconstruct, and rotating/removing the
compromised delegate signer (or in the worst case moving funds out — the
account's signers always can) is the universal backstop.

**Acceptance test (verbatim from #824, verified in #832):** a person holding
only their account credentials (passkey/EOA) and Haven's *public* docs — no
Haven session, no Haven support — (a) enumerates the active authorities on a
Base Sepolia test account, and (b) executes `disableDelegation` and confirms
further redemption fails. Recorded as a walkthrough with tx links.

## 5. Copy rules (per `copy-guidelines.md` + the #736 formulation bank)

- MAY say: "your money stays in your own account", "budgets are enforced by
  public, audited contracts — we can't override them", "you can revoke your
  agent's budget yourself, even without Haven — here's how" (link §4).
- MUST NOT say: "audit-ready", "your keys never leave your device" (passkey
  platform semantics vary), anything implying Haven holds/controls funds, or
  "MetaMask wallet" (the account uses MetaMask's *contracts*, not the wallet
  product).
- The exit path is a **published feature**, referenced from the dashboard
  ("your exit path") — not fine print.

## 6. Recovery & the signer-set model (shipped, epic #836)

The interim single-passkey stance is retired — recovery shipped.

**The model.** An account's authority is its **signer set**: one or more passkeys
(P256) and/or one EOA owner. Any enrolled signer can add or remove others
(`addKey` / `removeKey` / `transferOwnership` on the Hybrid). A **backup signer
is the entire recovery story**: lose the device holding your primary passkey,
and the backup removes the lost one and enrols a replacement. The user-facing
walkthrough is [account-recovery.md](../product/account-recovery.md); the
independent-of-Haven path is [exit/README.md](../exit/README.md).

**Owner send (#1083) rides the same op discipline:** an owner-initiated
transfer from the treasury is a sponsored account op the OWNER signs —
prepare/submit split, the submitted UserOperation pinned to the re-derived
transfer calldata, scheme chosen by the device (#1086), and no Haven-held key
anywhere (invariants 5/7/12/13 unchanged). Sponsorship pays gas only; the
transfer itself is bounded by nothing but the owner's signature, which is the
point — it is the owner's own money.

**The signer set is symmetric (#1087, #1199):** enrolling an EOA owner is not
a one-way door — `remove_owner` encodes `transferOwnership(address(0))` through
the same prepare/submit path and returns the account to passkey-only. Removing
a passkey uses that same shared path and is subject to the same recovery rule.
Either removal is refused before any op is prepared when it would leave the
account with **no** signer — the account itself refuses that on-chain. A removal
that leaves exactly ONE signer is **permitted** on any chain: the dashboard
names the consequence and asks for confirmation, and the API does not refuse
(see §7 for the decision).

**Recovery invariants (non-custody preserved through recovery):**

- **Haven can never change an account's signer set.** Every `addKey`/`removeKey`/
  `transferOwnership` is prepared by Haven and **signed by an existing signer**
  (WebAuthn or EOA). Haven holds no key that can add, remove, or use a signer —
  invariant 13, CI-enforced.
- **The account enforces ≥1 signer on-chain** (`CannotRemoveLastSigner`, proven
  in the #884 spike), and that is the only hard floor. Haven mirrored a **≥2**
  refusal in the API until #1153 turned it into a recommendation. Both signer
  removal actions now permit an informed two-to-one transition: the UI names
  the no-recovery consequence before calling, while the API preserves no
  stricter policy gate.
- **Storage tracks the chain, not the reverse.** The stored signer set (which the
  deploy path rebuilds the account config from, and which the client sign path
  reads for the *credential* only — the account **address** is pinned, never
  re-derived from it, #891) is synced only *after* the
  on-chain op confirms, and the submit step **pins the sync to the signed
  calldata** — the DB can never record a signer the owner didn't actually sign.
  (#985 moved `Executor` out of `infra/repositories/hybrid-signers.ts` into the
  shared `infra/transaction.ts`; that is a declaration site, not a behaviour —
  the queries, their ordering and the post-confirmation sync are unchanged.)
- **UUPS upgrade authority stays with the signers** (invariant 11); recovery
  changes signers, never the implementation.

**Read surface (#1079).** The signer set is additionally readable at account
level via `GET /accounts/hybrid/:address/signers` — owner-scoped (dashboard
JWT + ownership check on `user_safes`) and returning **public-key material
plus per-credential enrollment time** (`key_id`, P256 x/y, owner address, and
`created_at` since #1679 — a timestamp the UI uses to label rows
"Passkey · added {date}"; nothing secret, nothing spend-enabling). It powers
login-time signer resolution and the account-level recovery card. It is a
read: no route lets Haven — or this endpoint's caller — change a signer set
without an existing signer's signature (invariant 13 unchanged).

**Management surface (#1081).** Signer changes are reachable the same two ways:
agent-scoped (`/agents/:id/account-signers/{prepare,submit}`, #888) and
account-scoped (`POST /accounts/hybrid/:address/signers/{prepare,submit}`), the
latter so an account with **zero agents** can enrol its second signer before
anything else exists — which is when the backup-signer recommendation
(#908→#1153) matters most.
**The frontend now uses the account-scoped surface exclusively (#1089):**
`AccountSignersCard` is the single home for backup & recovery, rendered on the
account page for any `delegator_hybrid` account — including one with zero
agents — and no longer duplicated on the agent page. The agent-scoped route
stays live server-side (it is the same shared implementation below, just
resolved differently) but has no remaining frontend caller.
The two surfaces differ only in how the account is resolved: agent lookup
versus an owner-scoped `(address, chain)` lookup on `user_safes`. Authority
rules, the last-signer refusal (§7), the calldata encoding and the signed-op
matching
are **one implementation** (`rails/hybrid-signer-actions.ts`), because two copies
of a spend-authority rule is how they drift apart. Invariant 13 is asserted
against that shared core and against both routes reaching it. Client-side, the
signing ceremony selects the passkey whose credential is actually enrolled on
the signing device rather than blindly `passkeys[0]`, so recovery with a backup
key works from the backup device (`hybridPasskeyToSignWith` in `lib/signer.ts` —
since #1933 the one place the credential is chosen, called by
`lib/delegationPasskeySigner.ts`, which inlined a second copy of the rule until
then; `pickSigningPath` in `hooks/useDelegationBudget.ts`
chooses the *path*, passkey versus EOA, and never the credential). `passkeys[0]`
survives as the fallback for the case where **no** device marker matches — a
cleared or never-written marker — and that fallback is safe rather than a
loophole: the marker is a local hint, so the worst it costs is a ceremony the
authenticator resolves from its own credential lookup, and no wrong-account
signature is reachable either way because the account address handed to the kit
is **pinned** to the one provisioning derived, never re-derived from the current
signer set (#891). UI surfaces treat a
DISMISSED signing sheet as a neutral cancel, never an error (#1085) — a user
changing their mind is not a failure mode. Scheme selection is
likewise a **device** decision, never an account-shape decision: a mixed
account (EOA owner *and* passkeys) accepts either signer on-chain, so the
client requests the scheme it can actually produce (`signature_scheme` on the
prepare routes, validated server-side against the real signer set) — enrolling
a backup wallet never disables the passkey path. When no enrolled passkey is
marked on the current device, the client still requests the passkey scheme
(the browser's cross-device WebAuthn flow is a real signing path) and the UI
shows an informational "may be on another device" hint next to the working
action rather than a false blocker (#1097) — availability copy must never
overstate what is actually gated.

**Marker-less signer *offering* is a recorded decision, not an implicit
refusal (#1969, owner decision 2026-08-26).** Until #1969, the dashboard's
active-signer resolution contradicted everything above: `useActiveSigner`
(`lib/signer.ts`) refused to return a passkey signer unless a device marker
matched, so a marker-less user (new device or browser profile; cleared site
data followed by re-login — the signer-set blob re-hydrates from the
owner-scoped read while markers are written only at enrolment; or a passkey
enrolled from another device) saw a wallet-connection CTA in the header while
every signing surface in this section worked, and `useSafeOperationGate`
simultaneously blocked gated actions for the same state. The decision:
`useActiveSigner` resolves any **non-empty** hydrated signer set, mirroring
`pickSigningPath`'s precedence exactly — marker-matched passkey → connected
EOA when the connected wallet **is** the set's named owner (#2068) → any
passkey — so a mixed account keeps
signing with its connected owner wallet and only the pure-passkey marker-less
case changed; the fallback credential is **disclosed** in the wallet menu
(#1952's rendering, reachable since this decision) before any ceremony. This
offers no signer that cannot sign: the set is the account's on-chain-enrolled
signers, selection draws only from that account+chain-scoped set, and device
availability — the one unknown — is answered by the ceremony itself.
**That sentence was aspirational until #2068 made the EOA rung honest:**
both `pickSigningPath` and the #1969 mirror read "a wallet is connected" as
satisfying the EOA rung whenever the set named an owner, without comparing
the connected **address** to `owner_address` — so a mixed account with an
unrelated wallet connected was offered a signer whose signature the account
rejects at verification time. The rung now requires the connected address to
equal the named owner (case-insensitive); a non-owner wallet falls through
to the passkey rung, and for an **owner-only** set — where there is no
passkey to fall to — the resolution is `null`: a signer offered but failing
at signature time is worse than absent. A hydrated set with a NON-OWNER
wallet connected never reaches the generic connected-EOA return (which
otherwise serves accounts without a hydrated set — legacy Safes,
pre-hydration renders); the owner-matched case deliberately re-uses that
same shared return, and it is correct there because the address was just
proven equal to `owner_address`.
Refusing (the pre-#1969 status quo) was declined as incoherent with the
#1097 rule above and with shipped signing behaviour; offering **silently**
was declined per #1952's design record. `useSafeOperationGate`'s hybrid
branch now answers `ready` for a non-empty set for the same reason, and —
since #2068 — for an owner-only set exactly when the connected wallet is
the named owner (the same address check; an unrelated wallet stays blocked,
and since #2073 that block has its own name: the gate answers
`wrong_wallet`, carrying both addresses, rather than folding the mismatch
into `no_signer`. The distinct kind changes what the UI *says* — the header
wallet pill and the action-area caption name the mismatch instead of asking
the user to connect the wallet they already connected — and never what may
*sign*: every consumer treats it as blocked, `wrong_wallet` is produced
only by the hybrid branch's address compare, and the owner on the wrong
network deliberately stays `no_signer` so the wrong-chain guidance keeps
precedence); `passkey_on_other_device` remains the legacy-Safe answer,
where the block is real because the stored signer metadata a Safe passkey
needs is genuinely absent from the device.

**The honest limit, stated plainly:** a **single-signer account has no recovery**
— if its only signer is lost, the account is unreachable by the user *and* by
Haven. This is inherent to self-custody, not a Haven policy. Mitigation is
structural: onboarding nudges a backup, the account itself refuses removal of
its last signer, and the dashboard requires an explicit confirmation before an
informed two-to-one transition. Copy never promises recovery Haven cannot
deliver.

### 6a. Agent delegate-key rotation — a DIFFERENT layer (#1698, epic #1694)

Everything above is about the **account's signer set**: the passkeys and EOA
owners that sign delegations. An **agent's delegate key** — the key that
*redeems* delegations — is a separate layer, and its loss has the opposite
answer, for a reason worth stating rather than leaving implicit.

The delegate never held owner authority. It holds only what a signed
delegation grants it, and that grant is revocable by the account owner. So a
lost or exposed delegate key is **recoverable**, where a lost sole account
signer is not: the owner revokes the old delegation and issues a new one to a
new delegate, keeping the agent's id, name, history and passport IDENTITY.
That is `POST /agents/:id/rekey…` (`routes/agent-rekey.ts`), and it is the
reason the "no recovery" limit above is scoped to the *signer set* rather than
to keys in general.

The word *identity* is load-bearing and was added in #1699, because the
unqualified "keeps its passport" was read as "the attestation is untouched" and
that is not what happens — see the re-anchoring property below.

Eight properties of that flow belong in this document because they are
security properties, not implementation detail:

- **Revoke precedes issue, always.** Both halves are on-chain and
  owner-signed, so partial failure is possible either way, and the two
  orderings fail differently. Revoke-then-issue fails to *the agent has no
  authority* — recoverable, and the right posture when a key is lost, since a
  lost key is already inert. Issue-then-revoke fails to *two simultaneously
  live keys* on a funded account, which nothing recovers by retrying. The
  ordering is enforced by a stage machine AND by CHECK constraints on
  `agent_rekeys`, so it holds across the several requests the flow spans.
- **The budget meter carries across the rotation — amount AND period
  boundary.** A re-key is not a way to refill a budget. The remainder frozen by
  the revoke is issued as a **carry** grant, anchored inside the old period and
  expiring at the old boundary — or at the old grant's own expiry, if that
  falls first — paired with a **steady** grant starting at that same instant on
  the original budget and cadence (`modules/agents/rekey-carry.ts`). Either
  piece may be absent rather than wrong: a fully spent period yields no carry,
  and a grant that dies at or before the boundary yields no steady. The two
  never overlap, so total spend before the boundary is capped at the remainder
  and every later period is the original grant untouched. Carrying only the
  *amount* is the bypass this
  defends against: each re-key would restart the clock, so an agent on a daily
  budget could be handed its remainder hourly — the period is half the grant,
  and dropping it turns a rate limit into a tally. The defence composes rather
  than being separately checked, which is why it holds for repeats: re-keying a
  carry grant reads a grant whose boundary is that same instant, so no number
  of re-keys inside one period can sum to more than the original budget. Two
  refusals belong to the same invariant — a remainder larger than the granted
  budget is refused rather than clamped, and a remaining-budget reading that
  did not come from the chain is refused rather than carried, because
  `readRemainingBudget` falls back to the FULL budget on a failed read and
  carrying that fallback would hand the new key a fresh full period.
- **The carry is planned on the clock the remainder was MEASURED on, and only
  dropped on the clock it is issued on.** A re-key spans several requests with
  an owner signature in the middle, so the meter reading and the issue can fall
  in different budget periods. The remainder is a fact about the period the
  revoke froze it in and means nothing in any other, so `planCarry` takes both
  clocks: `agent_rekeys.metered_at` anchors the boundary and every classification
  (expired, dormant, live), while the issue-time clock is used for exactly one
  thing — dropping a piece whose window the delay has already outrun, rather than
  asking the owner to sign a grant that can never redeem (#1849). Before this the
  route passed the issue clock for both, which could not over-grant — the
  remainder is still a ceiling — but silently *under*-granted: an owner who
  finished after a boundary had a spent period's remainder charged against a
  fresh one, at worst leaving an agent on zero for a period it was owed a full
  budget in. A missing `metered_at` is refused (409) rather than defaulted to
  now, because that default is precisely the defect. This is why "either piece
  may be absent rather than wrong" has a third cause alongside a fully spent
  period and a grant that dies at the boundary; every drop is reported to the
  owner with the window that closed named, so an absent grant is explained
  rather than merely missing.
- **An abandoned post-revoke re-key is recoverable — on the owner's explicit
  signal, never on a clock** (#1868). Abandoning a re-key that got past the
  revoke leaves the agent with no authority (the delegations are already
  retired on-chain), and until #1868 it also *forfeited* the frozen carry: a
  fresh re-key found nothing to revoke and walked to `metered` with an empty
  snapshot, so recovery was a manual owner re-grant that could not preserve
  the period boundary. Now the fresh re-key **inherits** the abandoned row's
  frozen measurement — snapshot, `revoked_at`, `metered_at` and the revoke tx
  wholesale (`adoptAbandonedCarry`), so the carry arithmetic stays anchored to
  the clock the remainder was measured on (the property above) and the period
  still cannot be refilled by rotating. Three guards keep this from failing
  open. The **abandonment signal is the owner's explicit abandon call**
  (`stage='abandoned'`), never elapsed time: a merely slow re-key still holds
  the unique in-flight slot, so a successor cannot even open, and there is
  deliberately no `NOW() - metered_at` predicate anywhere — a timeout that
  guessed wrong on a live re-key would fail open where the wedge failed
  closed. Adoption is **refused when any grant was made after the abandoned
  revoke** (the abandoned re-key's own inert `pending` rows excepted — they
  can never activate), because a manual re-grant spent in the same period plus
  the old remainder would exceed the original budget; the refusal falls back
  to the empty walk, which is the fail-closed direction. And a **completed**
  re-key's snapshot is never adopted — its carry was already issued. The
  in-flight 409 also names the `new_delegate_address` the parked re-key is
  bound to, so an interrupted owner resumes against the key the flow actually
  holds rather than the one they last typed.
- **Non-custody is unchanged.** The new keypair is generated on the target
  machine and Haven receives only its public address. Nothing in the flow
  accepts, stores or transports private key material, and a design that
  "restores" a key to a new host is out of scope by owner decision — refused,
  not built.
- **An agent can never re-key itself.** Authorisation is the account owner
  through the dashboard; an agent presenting its own credential is refused
  explicitly. An agent rotating its own credentials would be an agent editing
  its own authority.
- **The revoke is signed by a signer the DEVICE chose, not one the server
  guessed** (#1870). §6's rule — scheme selection is a device decision, never
  an account-shape decision — reads as though it always held across the prepare
  routes. It did not hold here: the re-key's revoke prepare passed no signer to
  the account, so the underlying default inferred the EOA owner whenever one
  existed. On a mixed account that is a guess, and a costly one, because the
  UserOp's verification gas is estimated against a dummy signature sized for
  the inferred signer — a WebAuthn signature is several hundred bytes where an
  EOA's is 65. The route now resolves `signature_scheme` through the same
  `rails/hybrid-signer-actions.ts` core §6 describes, passes the choice down,
  and reports the resolved scheme back so the client branches instead of
  guessing. **The refusal ordering is the security property**, not the field: a
  scheme the account cannot sign is refused `409` in the *prepare* step, which
  writes nothing and leaves the re-key at `preflight`. That is deliberate under
  the revoke-precedes-issue rule above — a failure after the revoke is the
  expensive direction, so a new way to fail must land before it.

- **The passport ANCHOR is retired and reissued, and standing never moves**
  (#1699). An EAS attestation is immutable and `PASSPORT_SCHEMA`'s first field
  is `address agentEoa`, so there is no mutable-anchor option: the moment the
  rotation completes, the live attestation names a key the agent no longer
  holds. Re-key therefore revokes it and issues a new one naming the new key —
  and the same revoke-before-issue rule applies for the same reason, one layer
  up. Minting first would leave TWO live credentials for one agent, one of them
  naming a retired key, and a partial failure would make that permanent;
  revoking first fails to *this agent has no passport right now*, which is
  recoverable. The window between them is real, and it is reported as
  `re_anchoring` rather than hidden — never as `anchored`, which would tell a
  merchant a credential is current when the address it names cannot spend.

  **What does NOT move is `standing`.** It derives from `agents.status`
  (`modules/passport/revocation.ts`), which a re-key never writes, so no chain
  failure in this path can cost an agent its standing — the worst available
  outcome is a stale anchor that keeps retrying. That is the two-layer split of
  §epic #970 doing the job it was built for: the DB is authoritative and the
  anchor is eventually consistent, and re-anchoring is the case that makes the
  distinction observable rather than theoretical. The queue is the invariant
  "the attestation names an address the agent no longer uses", so a re-key
  whose process died before enqueuing anything is still picked up.

  Passport remains governance metadata, never spend authority: nothing in this
  property grants, withholds or delays what an agent may spend.

One consequence the owner should hear before starting: re-key retires the key
that could **sweep** any residual balance on the old delegate EOA, so the
preflight reads that balance and refuses until the owner says what happened to
it. After the rotation it is unrecoverable — by the user and by Haven alike —
in the same structural sense as the single-signer limit above.

## 7. Two signers: a recommendation, not a gate (#1153)

**This section previously recorded a launch GATE.** It said no mainnet
delegation-rail account could operate below two enrolled signers without a
recorded waiver, and `modules/accounts/mainnet-gate.ts` enforced exactly that at
provisioning, at grant activation, and at owner removal.

**It no longer does. Owner decision, 2026-08-07, verbatim:**

> "This is too hard, create a issue where this requirement is changed from
> being a hard one, to a soft recommendation of adding a backup, but this
> recommendation should only be displayed to the user after they have funded
> the account. I do not want users to have this in their face directly at
> onboarding."

and, on owner removal:

> "convert this from a block to a warning instead, the user should be able to
> move to a one signer set up."

**What this does and does not change.** It does not make single-signer accounts
safer, and it does not lower the risk stated in §6: such an account has **no
recovery**, and losing the device loses the funds with no path back through
Haven or anyone else. That is now a risk the user may take. What changed is
*when and how* they are told: after funding, when there is something to
protect, instead of as a wall in the first minute — where it blocked the
one-Face-ID, zero-transaction onboarding this rail exists to offer, at the
moment the user has nothing at risk and no context for what a backup protects.

**The mechanism now:**

- **Provisioning and grant activation do not consider signer count.** A
  single-signer account may be created on a value-bearing chain and may receive
  a budget.
- **`remove_owner` and `remove_passkey` succeed** in dropping a value-bearing
  account to one signer. The dashboard requires an explicit confirmation
  naming the consequence before it calls; an API-level acknowledgement flag
  was rejected on #1153 because it would still be a block to any non-UI caller,
  which is the thing being removed.
- **The recommendation is delivered after funding**, and only when the account
  is genuinely below two signers — recommending a backup to someone who has one
  teaches them to ignore the banner.
- **`needsBackupSignerRecommendation`** replaces `signerFloorError`. Same
  condition, no refusal: it answers "would this account benefit from a backup",
  and the fail-closed chain classification stays because over-recommending on
  an unknown chain is harmless while staying quiet on a real one is not.
  Since #1205 the predicate has its production call site: the session safes
  payload (`/auth/me`, login) carries the computed answer
  (`needs_backup_recommendation`) plus `value_bearing_chain`, mapped by
  `sessionSafePayload` in the same module — so the dashboard's banner branches
  on the server's classification instead of re-deriving chain semantics
  client-side.
- **The waiver column survives as history, not as an unblock.**
  `user_safes.single_signer_waiver_at` (migration 046) is still written when an
  acknowledgement is sent, and nothing requires it to proceed. It no longer
  silences the recommendation either — it never made an account recoverable; it
  only recorded that someone had been told once, and the risk is ongoing.

**What did NOT relax:** the account still refuses to remove its *last* signer.
That is a different rule — it mirrors an invariant the account enforces
on-chain, and dropping to zero signers bricks the account rather than merely
making it unrecoverable.
- **Activation is atomic** (#1061): retiring the previously ACTIVE grant for a
  `(token, recipient)` slot and activating the new one run in **one
  transaction**. As two independent statements, a failure between them left the
  slot with zero active grants — every payment 403s while the old grant is still
  perfectly valid on-chain, i.e. a self-inflicted outage with no on-chain cause.
  It is now replace-and-activate or neither. This is availability hardening, not
  a custody change: neither statement can create authority the owner did not
  sign.

Two honest limits of the mechanism (review-noted): the signer count is
**DB-sourced** — an owner can change the signer set directly on-chain without
Haven's sync, so the floor protects the owner from themselves rather than
proving on-chain state (the on-chain `CannotRemoveLastSigner` guard is the
hard backstop). And a provisioning-time EOA owner is **not signature-verified**
— the floor counts enrolled signers, it cannot prove each is usable (the zero
address, which provably is NOT a signer, is rejected at every entry point).

The dashboard now delivers the recovery recommendation after funding, and both
two-to-one signer-removal paths require an explicit consequence confirmation.
The API deliberately has no waiver or acknowledgement gate: it permits those
informed transitions while the account's on-chain last-signer guard remains the
hard backstop.

## 8. x402 dual-scheme settlement — the EIP-3009 interop bridge (#946)

The rail settles x402 two ways, selected per payment (`routes/x402.ts`):

- **erc7710 direct settlement (default & destination, #830):** the settlement
  redeems the budget delegation itself — enforcers run at every payment,
  against every merchant; no funding leg, no hot balance, no sweep.
- **EIP-3009 fallback (temporary interop bridge, #946 / RFC #791 §18):** for
  facilitators that cannot redeem a delegation chain. The budget delegation is
  redeemed with `to = the agent's own delegate EOA` (a sponsored UserOp the
  agent signs — the same prepare/submit split as any redemption), then the EOA
  signs a standard EIP-3009 header client-side and the facilitator settles
  EOA→merchant.

What the bridge deliberately gives up, for 3009 payments only — and the
compensating controls:

1. **A transient hot balance returns** on the delegate EOA between funding and
   settlement. Bounded: the funding is the exact payment amount; the header's
   forward validity window is capped SDK-side (merchant-requested timeout
   clamped to ≤600 s, plus a 300 s settlement margin — ≤900 s total, #1256:
   the margin is what lets the header clear the facilitator's
   `validBefore ≥ now + maxTimeoutSeconds` verify rule after the funding leg
   confirms; without it every purchase against a ≥300 s-timeout merchant
   failed structurally); the delegate-balance monitor
   covers delegation-rail agents; the rail-agnostic sweep route recovers
   residuals to the **treasury Hybrid** (`agent.safe_address`), with the
   0.01 USDC recoverability floor and sub-floor residuals visible in the ledger.
2. **Budget meters at the funding hop, not at settlement.** Verify-without-
   settle strands the amount on the EOA → sweep reconciles it; the budget
   consumption is honest (funds genuinely left the treasury).
3. **The merchant hop has no on-chain policy.** This is why 3009-mode
   structurally requires an **open (unpinned) budget**: a recipient-pinned
   delegation cannot fund the EOA (the pin locks `transfer(to,…)` to the
   merchant), and the server only funds via delegations whose caveats permit
   the EOA as recipient. **Pinned agents are erc7710-only** (owner decision
   2026-07-15, recorded on #946) — a pin is never weakened for interop.

Non-custody is unchanged: the agent signs both legs client-side (the funding
UserOp's typed data and the 3009 header); Haven prepares and relays, holds no
key, and sponsorship can pay gas but never move value. The scheme is recorded
per intent (`machine_metadata.settlement_scheme`) so 3009-mode usage is
auditable and its retirement measurable.

Hardening shipped with #961: the per-agent hourly x402 cap now guards the
delegation branch too (every authorize costs a sponsored bundler estimation,
so the cap is sponsorship-cost protection on the #717 surface — placed after
the idempotent-replay lookup so recovery retries are never rate-limited);
one-shot authorize+execute is refused loudly (a signature over
not-yet-prepared state can never be valid); and idempotent replays resume
with the ORIGINAL reconstructed signing payload rather than re-running
estimations — the stored intent, not a fresh prepare, is the source of truth
for what the agent signs.

### 8.1 The settlement child — verified signer, honest bearer semantics (#1061)

Two properties of the erc7710 settlement leg, corrected in #1061:

- **The settle signature is verified against the delegate key, not merely
  shape-checked.** `POST /x402/:id/settle` recovers the signer from the child
  delegation's EIP-712 typed data and refuses anything that is not the agent's
  `delegate_address` — with a `400`, *before* the intent status flips, so the
  intent stays signable and the client can re-sign the same payload. Previously
  any hex (`0x0` included) passed the shape check and burned the intent, turning
  a client-side signing bug into an unrecoverable payment. This is the
  authentication/authorisation split enforced concretely: the bearer token
  identifies the agent, the recovered delegate signature is what authorises.
  Unlike `payments.ts`, the child's typed data is fully known server-side, so
  the check is possible here.
- **The child is a bearer instrument, and the doc says so.** It is issued to
  `ANY_BENEFICIARY`; the redeemer *caveat* is the constraint that would narrow
  it, and no live path populates it yet (`requirements.extra` is not parsed —
  [#1058](https://github.com/d-hinders/Haven-AI/issues/1058)). The real
  guarantee is therefore the caveat stack, not the recipient: exact amount,
  payee-pinned, ≤600 s expiry. Worst case on a leaked child is "the merchant is
  paid without delivering" for that one quoted amount — the leak-analysis table
  in §3 is unchanged, since redeeming still cannot exceed those bounds.
