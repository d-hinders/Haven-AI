---
owner: "@d-hinders"
status: research
covers:
  - packages/qa-agent/src/pilot/**
  - docs/research/erc4337-pilot-rig.md
last-verified: "2026-07-02"
---

# Session-key policy pilot — report & Stage 2 go/no-go (#724)

Closeout for the [ADR #719](https://github.com/d-hinders/Haven-AI/issues/719)
Stage 1 pilot. The four build slices are done and live-verified on Base
Sepolia: the [ERC-4337 rig](erc4337-pilot-rig.md) (#720), the one-owner-tx
migration (#721), Haven's policy shape as Smart Sessions with a six-case
enforcement suite (#722), and the gasless payment + rail comparison (#723).
This note answers the ADR's open questions and makes the recommendation.

**Recommendation: conditional GO for Stage 2** (gradual, opt-in per-account
migration) — the pilot proved the load-bearing claims, and the residual risks
are all *nameable and bounded* rather than unknowns. The conditions are listed
in [§8](#8-recommendation--conditional-go). Nothing here changes a production
code path; Stage 2 is its own epic, greenlit by this report.

## TL;DR — what the pilot proved

| ADR claim | Verdict | Evidence |
|---|---|---|
| Policy roadmap fits on-chain with **zero own Solidity** | ✅ mostly — one gap | #722 mapping table below |
| Migration is **one owner tx**, additive, no singleton swap | ✅ proven live | #721 migration tx, additive check passed |
| Enforcement actually **stops** violations on-chain | ✅ proven both directions | #722 six-case suite |
| Gasless via **paymaster**, no relayer, real per-agent budgets | ✅ proven | #723 sponsored UserOps + sponsorship policies |
| **Concurrency** without single-EOA nonce serialization | ✅ proven | #723 concurrent 2D-nonce probe |
| **Non-custody** line holds on the new rail | ✅ by design, copy review pending | [§5](#5-casp--non-custody-framing) |
| x402 EIP-1271 settlement composes | ⏳ **not yet** — #452 track | [§6](#6-x402-convergence) |

## 1. Policy expressiveness

Haven's policy vocabulary maps onto Smart Sessions policies with **no custom
Solidity** — the central bet of the ADR. What fit, verified by the #722
enforcement suite (each rule proven to *stop* a violation, not just to encode):

| Haven policy | Smart Sessions expression | Status |
|---|---|---|
| recipient allowlist | UniversalActionPolicy ParamRule `EQUAL` on `to` | ✅ enforced |
| per-tx cap | ParamRule `LESS_THAN_OR_EQUAL` on `amount` | ✅ enforced |
| cumulative spend limit | `isLimited` + `usage.limit` (sums across uses) | ✅ enforced |
| time bound / expiry | TimeFramePolicy (userOp policy) | ✅ enforced |
| revoke / kill switch | owner tx `getRemoveSessionAction` | ✅ enforced |
| session-key binding | OwnableValidator (threshold 1) | ✅ enforced |

**Two honest gaps, both with a Stage 2 path — neither is a blocker:**

1. **No native refill period.** This is the one real mismatch with the
   AllowanceModule, whose defining feature is "N USDC, refills every M
   minutes." Smart Sessions' `usage.limit` is a **lifetime cumulative** per
   session, not a resetting bucket. Two mappings without own Solidity:
   **session rotation** (short `validUntil` + a periodic owner/executor
   re-enable that mints a fresh budget) or accept a lifetime cap per session
   and rotate on exhaustion. A resetting-allowance *policy contract* would be
   own Solidity — the thing the ADR set out to avoid. **Stage 2 must pick the
   rotation mechanism**; recommendation is scheduled session rotation driven by
   the backend as an executor action, since it also bounds blast radius.
2. **One recipient per session.** ParamRules AND together, so one session = one
   allowlisted recipient. An N-address allowlist = N parallel sessions (cheap;
   sessions are just config) or a custom policy. This fits x402 per-merchant
   scoping naturally and is only clumsy for a general human contact book —
   acceptable for the agent-spend ICP.

**Category-based rules** (merchant categories, MPP) still need an off-chain
component, honestly labeled a UX guardrail (Stage 0 framing) — Smart Sessions
gates on `target + selector + calldata params`, not semantic categories. This
matches the ADR's expectation; it is not a regression.

## 2. Vendor & operational model

The new operational dependency — a **bundler + paymaster** — is the main cost
of this decision, exactly as the ADR flagged.

- **Pilot choice: Pimlico** (one URL for bundler + paymaster + gas oracle,
  best Safe/7579 docs, standard `eth_sendUserOperation` + sponsorship so
  lock-in is low). Alchemy/Biconomy are comparable; self-hosted (Alto) is the
  escape hatch if vendor terms change. See [rig doc](erc4337-pilot-rig.md) for
  the full decision matrix.
- **Client SDK: `permissionless` + `viem`**, contained today as a viem-only
  island in the private `qa-agent` package. **Stage 2 question the pilot
  deliberately did not decide:** whether the production `@haven_ai/sdk` grows a
  viem dependency or wraps UserOp construction behind the backend. The
  backend-wrap option keeps the customer SDK surface unchanged and is the
  recommended default to evaluate first.
- **Per-agent gas budgets (#717) are solved structurally, not bolted on.**
  Paymaster **sponsorship policies** enforce per-policy spend caps, per-sender
  limits, and time windows; an exhausted budget **declines at sponsorship
  time** (`prepareUserOperation` fails, no chain write, no gas spent) — a
  clean retryable client error instead of a drained shared relayer. One policy
  per agent or per tier. Vendor-specific mechanics; equivalent knobs exist at
  Alchemy/Biconomy, and a self-hosted paymaster owns them directly.

**New ops surface to own in Stage 2:** a bundler/paymaster account and its
API-key credential (the bundler URL *is* a secret — it embeds the key), the
sponsorship-policy configuration per agent/tier, and vendor-availability
monitoring (a bundler outage stalls migrated-account payments — the unmigrated
relayer rail is the fallback during the staged rollout).

## 3. Performance & cost vs the current rail

From the #723 comparison (`pilot:compare`), same shape both rails:

- **Latency/gas:** a session-key UserOp carries 4337 overhead (validation +
  paymaster) versus a direct AllowanceModule `executeAllowanceTransfer`. This
  is a real per-payment gas premium, paid by the paymaster rather than the
  relayer — the cost moves, it does not vanish. Quantify the exact premium at
  Stage 2 volume against sponsorship pricing; for the pilot's purposes it is
  "same order, with a knowable markup," not a surprise.
- **Concurrency is the decisive win.** The relayer rail serializes on a single
  EOA nonce (the #692/#718 race): concurrent payments retry or fail. The
  session rail assigns **consecutive 2D nonces up front** and a bundler
  includes all of them — the concurrent probe lands three simultaneous
  payments that the single-EOA rail structurally cannot. For an agent-spend
  product this is the throughput ceiling lifting.
- **Ledger unchanged:** every confirmed payment emits the same rail-agnostic
  `machine-payment-evidence` JSON (`rail`, `tx_hash`, `chain_id`,
  `payer_address`, `settlement_address`, …), proving the audit/accounting shape
  survives the rail swap — important for the bookkeeping-feed moat.

## 4. Gnosis v1.3.0 compatibility

**Docs-level assessment (pilot is Base-first by product priority; no Gnosis
run was in scope).** The risk is concrete and named in the ADR: our Gnosis
singleton is **SafeL2 v1.3.0**, whereas Base/Base Sepolia run the **v1.4.1
generation** the pilot used. Safe7579 attaches via `enableModule` +
`setFallbackHandler` (no singleton migration), and the adapter targets the
ERC-7579 surface rather than a specific Safe version — so the migration recipe
*should* port. But this is unverified: v1.3.0 fallback-handler and module
semantics differ enough that **a dedicated Gnosis pilot run is a Stage 2
prerequisite before migrating any Gnosis account.** Base migrates first
regardless; Gnosis waits on its own verification.

## 5. CASP / non-custody framing

**The "Haven never holds spending authority" line holds on the new rail by
construction** — arguably more provably than today:

- The **session key stays customer-side** — the same key-custody story as the
  delegate today; Haven never holds it.
- **Policies are owner-signed and live on-chain** in the session config. Haven
  cannot widen them; a compromised Haven backend cannot move funds outside the
  session's on-chain limits (a genuine improvement over AllowanceModule, where
  the delegate can pay *any* recipient and submission is permissionless — the
  ADR's structural motivation).
- The **paymaster pays gas only** — it holds no spending authority over user
  funds and cannot redirect a payment; it can only decline to sponsor.

**Copy/regulatory review required before external language (not a code
blocker).** New surface area for the reviewers who owned #491/#613: "session
key," "paymaster / sponsored gas," and "policy bound on-chain" must be
described without implying Haven custodies funds, sponsors *value* (vs gas), or
acts as a PSP. The substance is compliant by design; the vocabulary is new and
needs the same care as prior CASP copy work. The **non-custody CI invariants
must extend to the new path** when Stage 2 builds it (the ADR says so; make it
an explicit Stage 2 acceptance gate).

## 6. x402 convergence

**Open — this is the one ADR claim the pilot did not close, by design.** The
ADR's biggest payoff (retiring #713 delegate in-flight exposure) depends on
**EIP-1271 x402 settlement**: USDC FiatToken v2.2 accepting the Safe's
contract-wallet signature so the **Safe pays the merchant directly**, deleting
the hot-EOA transit window. That is the **#452 / ERC-7710 track**, still a
prototype, and its core unknown — **x402 facilitator support for EIP-1271
settlement** — is unresolved. The session-key policy rail (this pilot) and the
smart-account-native settlement rail (#452) are **composable but independent**:
policy enforcement lands now; the in-flight-exposure win lands only when #452
proves facilitator support. **Stage 2 shape:** sequence the policy-rail
migration first (its value — enforcement, concurrency, gas budgets — stands
alone), and fold in EIP-1271 settlement when #452 clears. Do not block the
policy migration on the settlement prototype.

## 7. Findings carried forward (integration gotchas)

Recorded so Stage 2 doesn't re-pay for them — full detail in the
[rig doc](erc4337-pilot-rig.md):

- **initializeAccount routes through the Safe**, not the adapter directly (the
  adapter's ERC-2771 HandlerContext authenticates only via the fallback path;
  a direct call reverts, surfaced as GS013).
- **ERC-7484 registry gating was disabled** for the pilot — no attestation
  exists for this Smart Sessions deployment on Base Sepolia, so any
  `threshold > 0` reverts the install. **Stage 2 must verify attestation
  coverage per chain/module version, or run an own attester**, before
  re-enabling this defense-in-depth layer for production.
- **Session-key signatures are EIP-191, not the raw userOpHash** — the
  OwnableValidator recovers over the personal-sign digest. Signing the raw hash
  returns SIG_VALIDATION_FAILED with *every policy passing*, which reads as a
  policy bug but isn't. Fixed in `session-rail.ts` (PR #731); a generic
  OwnableValidator gotcha worth a Stage 2 SDK comment.
- **ABI pinned to the deployed Safe7579 v1.0.2 artifact**, which has diverged
  from the adapter repo's `main` — do not "refresh" the ABI without confirming
  what the canonical address actually runs.

## 8. Recommendation — conditional GO

**Proceed to Stage 2** (gradual, opt-in per-account migration; AllowanceModule
+ relayer remain for unmigrated accounts; retire them only at Stage 3). The
pilot de-risked every load-bearing claim; the remaining work is bounded
engineering and review, not open research. **Conditions to satisfy inside
Stage 2, before any production account migrates:**

1. **Decide the refill mechanism** (§1) — recommend scheduled session rotation
   as a backend executor action; it also bounds blast radius.
2. **Verify ERC-7484 attestation coverage** on Base (mainnet) for the pinned
   Smart Sessions module, or stand up an own attester, then re-enable registry
   gating (§7).
3. **CASP copy + non-custody CI review** for the session-key/paymaster
   vocabulary; extend the non-custody invariants to the new path as an
   acceptance gate (§5).
4. **Pick the SDK integration shape** — evaluate backend-wrapped UserOp
   construction first, to keep the customer SDK surface stable (§2).
5. **Own the vendor dependency** — bundler/paymaster account, per-agent
   sponsorship policies, credential handling, and availability monitoring with
   the relayer rail as staged fallback (§2).
6. **Keep #452 decoupled** — migrate the policy rail on its own value; fold in
   EIP-1271 settlement (and the #713 in-flight-exposure win) when #452 clears
   (§6).

**Gnosis** migrates only after its own v1.3.0 + Safe7579 verification run (§4).

**What would flip this to no-go:** a Stage 2 discovery that the refill gap
*requires* own Solidity after all (re-introducing the audited-custom-contract
cost the ADR rejected), or #452 proving EIP-1271 x402 settlement is
unsupported by facilitators *and* the in-flight-exposure risk being judged
unacceptable without it. Neither is indicated by the pilot.

## References

- ADR: [#719](https://github.com/d-hinders/Haven-AI/issues/719) — session-key policy layer
- Rig & build decisions: [erc4337-pilot-rig.md](erc4337-pilot-rig.md) (#720–#723)
- x402 smart-account settlement: [#452](https://github.com/d-hinders/Haven-AI/issues/452) (ERC-7710 / EIP-1271)
- Retired-by-convergence: #713 (in-flight exposure), #717 (gas abuse), #718 (nonce coordination)
