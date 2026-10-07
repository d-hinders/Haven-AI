/**
 * #1591 — the tools/list description payload stays SLIM, permanently.
 *
 * The 2026-08-18 external tester's words: listing/searching tools produced "a
 * very large amount of repeated text". Shared flow guidance lives ONCE in the
 * server `instructions`; descriptions carry purpose, siblings, inputs, output
 * shape, exceptional states — and zero internal issue archaeology.
 */
import { describe, expect, it } from 'vitest'
import { toolDescriptions } from './tools.js'
import { HOSTED_INSTRUCTIONS } from './server.js'

/**
 * The serialized UTF-8 size of every served description before the #1591
 * trim, measured on 2026-08-19. Trimmed result at merge time: 15,568 UTF-8
 * bytes across the surface as it then stood.
 */
const PRE_TRIM_BASELINE_BYTES = 30_609

/**
 * #2292: this ratchet is now a PER-TOOL budget, not an absolute total, and
 * that is a correction rather than a relaxation.
 *
 * The original form was `total <= 0.6 * PRE_TRIM_BASELINE_BYTES` (18,365).
 * A total is the wrong quantity to ratchet on a surface that legitimately
 * grows: the margin it left was slack from the trim, and the tools added
 * since spent it without any description becoming fatter. Measured on
 * `origin/dev@8cdb1cc6`, the surface was **18,354 bytes across 21 tools** —
 * eleven bytes of headroom — so the next tool of any size failed the check
 * whatever its description said. Squeezing a money-path tool's agent-facing
 * text to fit an arithmetic accident is exactly the wrong response, and
 * bumping the constant each time is the ratchet quietly becoming decorative.
 *
 * The property #1591 actually cared about is that descriptions are SLIM —
 * "a very large amount of repeated text" was the tester's complaint — and
 * that is a per-tool property. So the budget is the MEAN served description,
 * pinned SHRINK-ONLY at the exact value the surface had before this tool was
 * added: 18,354 / 21 = **874.0** bytes. #2292's own description is 510 bytes,
 * and adding it moves the mean DOWN to 862.5 — which is the evidence that
 * one more tool was never what this guard existed to stop, and the reason
 * the pin can be the measured value rather than a rounded-up one.
 *
 * Two things this deliberately keeps: the absolute figure is still asserted
 * (as `MAX_MEAN_BYTES * toolCount`), so a fat description still fails on
 * both counts; and the two assertions below — no issue archaeology, no
 * repeated flow boilerplate — are untouched, and they are what actually
 * enforces "not repeated text".
 *
 * **The tradeoff, stated where the next person adding a tool will read it
 * (haven-reviewer, #2292).** A mean with no cap on tool COUNT no longer
 * bounds total `tools/list` context growth. The absolute cap did — that was
 * the point of it, since what an agent pays for is the total it has to read
 * — and a mean permits an unbounded total so long as each addition is small.
 * That is a real loss, accepted knowingly: the absolute form had stopped
 * discriminating (it would have rejected any 22nd tool, however terse, while
 * saying nothing about whether descriptions were bloated), and a guard that
 * fires on the wrong quantity gets its constant bumped until it means
 * nothing. If total context becomes the live concern again, the answer is a
 * SECOND assertion bounding the tool count or the total explicitly — argued
 * on its own evidence — not a silent return to a number nobody re-derived.
 */
/**
 * **Re-derived at the measured value — round 3 of #3126, second custody
 * merge (2026-09-19) — the #2292 move, stated where the pin itself demands
 * it.** The 874.0 pin first broke on `dev`, not on this branch: #3125
 * rewrote `listReceipts.behavior` (+145 UTF-8 bytes of receipt provenance
 * wording), which landed through the round-2 custody merge of dev c0ae079f
 * and was re-derived at 20,978 / 24 (commit 3cbfe426). The second custody
 * merge of dev 2018100c then carried #3146's SDK description rewrites into
 * the composed surface: `listReceipts.behavior` gained the pagination
 * contract sentence (Page envelope, total, hasMore, nextCursor),
 * `getAllowances.behavior` gained the per-entry field enumeration, and
 * `getAgent` was trimmed to match — net +22 bytes (20,978 → 21,000, mean
 * 874.083 → 875.0), again invisible on dev because the mcp-server checks
 * job surface-skips SDK-only changes, and exposed here on the first
 * mcp-server-touching PR since. Neither remedy besides re-derivation
 * applies: there is no overclaim to trim — the new wording states each
 * tool's real output shape (#3146's deliverable) and this branch's own
 * `haven_check_funds` description sits below the mean — and the constant
 * cannot stay while the tree the PR must merge into already exceeds it. So
 * the pin moves to the exact measured mean of THIS surface, 21,000 / 24,
 * and stays shrink-only from here; the absolute assertion stays the integer
 * total so the two can never disagree.
 *
 * **Re-derived again for #3329 (2026-09-25): two new tools, haven_open_task_budget**
 * **and haven_close_task_budget.** Trimmed to the leanest description each still
 * carries its full behavior contract in (505 and 316 bytes — both well below the
 * mean), and `haven_submit`'s description gained one sentence naming the
 * task_budget_id branch (measured 606 → 780 bytes, +174). Nothing else
 * pre-existing grew: base total across the prior 24 tools was 20,999; +505 +316
 * +174 = 21,994 across 26 tools. Measured total: 21,994 UTF-8 bytes / 26 tools =
 * 845.9 mean — the mean actually DROPS (875.0 → 845.9) because the two new
 * descriptions are leaner than the surface average, so only the absolute pin
 * needs to move; it moves to the exact measured value, shrink-only from here,
 * same discipline as every prior re-derivation.
 *
 * **Re-derived at the measured value — round 4, #3277 (2026-09-26).** The
 * direct-payment results now name the byte-free signing handoff, and the
 * copy that names it is required, not decorative: `haven_pay` gained the
 * handoff + refusal-recovery sentence (+80), and the shared `send`
 * description's signing claim was corrected (#3277 criterion 5 — it claimed
 * every signer refuses a hash-mismatching payload, true only of a current
 * signer; the honest wording states the older signer's on-chain rejection
 * instead, +43). Hand-trimming the recovery instruction to fit would cut
 * the exact text the issue mandates agents read, and no overclaim remains
 * to trim. So the pin moves to the exact measured mean of THIS surface,
 * 21,178 / 24 (≈882.42), and stays shrink-only from here.
 *
 * **Re-derived for the composed surface — round 5, #3277 rebased onto
 * #3354 (2026-09-26).** The rebase composes dev's #3329 surface (26 tools,
 * 21,994 bytes) with this branch's required #3277 copy, and NEITHER
 * parent's pin survives: this branch's required #3277 copy costs +179
 * UTF-8 bytes net on the composed surface (the hosted `haven_send` /
 * `haven_pay` handoff and refusal-recovery copy, plus the shared `send`
 * description's corrected signing claim — required copy; hand-trimming
 * it would cut the exact text the issue mandates agents read), putting
 * the measured composed total at exactly 22,173
 * UTF-8 bytes across 26 tools. The mean moves the other way:
 * 22,173 / 26 = 852.81, BELOW the 875.0 ceiling — the two lean budget
 * descriptions more than absorb this branch's copy — so the mean pin
 * stays HELD at 875 with #3329's rationale (the pin is a ceiling, not a
 * running average of whatever landed most recently; re-deriving it down
 * to 852.81 would make it one, and would tighten nothing the ceiling
 * does not already enforce), and only the absolute pin moves, to the
 * exact measured value of the composed surface, shrink-only from here.
 *
 * **Re-derived — round 6, #3418 (2026-09-28).** `haven_verify_receipt`'s
 * shared description was rewritten to stop telling agents to fetch receipts
 * with the history tool (the exact defect #3418 fixes — it sent every agent
 * down the crash path) and to carry the corrected honesty contract instead:
 * the signed-bundle source, the `not_a_signed_receipt` answer for a list
 * row, the `not_verifiable_offline` branch, and the
 * settlement-not-proven rule. Hand-trimming further would cut the exact
 * text the issue mandates agents read (the same call as rounds 4-5), so
 * the absolute pin moves to the exact measured value of this surface,
 * 22,340 UTF-8 bytes across 26 tools, shrink-only from here. The mean
 * pin stays HELD at 875: 22,340 / 26 = 859.23, still below the ceiling.
 *
 * **Re-derived — round 7, #3420 (2026-09-28).** `haven_get_payment_status`'s
 * shared description now carries the two facts this issue mandates agents
 * read: the additive `delivered` field (when the merchant answered) and the
 * new terminal `delivered_unverified` state (stop, no poll) — required copy;
 * hand-trimming it would cut exactly the state vocabulary the issue sends
 * agents to match on (+76 UTF-8 bytes). The measured total is exactly
 * 22,416 bytes across 26 tools, so the absolute pin moves to that value,
 * shrink-only from here. The mean pin stays HELD at 875:
 * 22,416 / 26 = 862.15, still below the ceiling.
 *
 * **Re-derived — round 7, #3419 (2026-09-28).** The task-budget results that
 * hand off to `haven_sign { task_budget_id }` now carry the
 * `signer_compatibility` recovery notice (the #3277 pattern on the
 * `task_budget_id` form), and both task-budget descriptions' Returns name it
 * — the issue mandates agents see the field before an old signer strips the
 * argument and answers the generic signing error. That sentence costs +170
 * UTF-8 bytes net (the hosted `haven_open_task_budget` /
 * `haven_close_task_budget` Returns copy); hand-trimming it would cut either
 * the mandated field name or the #3329 sign-and-relay instructions it sits
 * beside — the same call as rounds 4-6. Two independent round-7 derivations
 * converged on this composed surface: #3420's additive-field paragraph above
 * (the `haven_get_payment_status` shared description) and this notice touch
 * disjoint descriptions, so their deltas add over the same round-6 base —
 * 22,340 + 76 + 170 — and the merged-tree 26-tool census measures exactly
 * 22,586 UTF-8 bytes; the absolute pin moves to that measured value,
 * shrink-only from here. The mean pin stays HELD at 875: 22,586 / 26 =
 * 868.69, still below the ceiling.
 *
 * **Shrunk — #3475 (2026-09-29).** `haven_report_settlement_evidence` now
 * also takes an eip3009 merchant settlement, so its shared description drops
 * the "an erc7710 payment's" scoping and "confirm the payment" (an eip3009
 * payment is already confirmed; the hash is recorded beside it): −11 UTF-8
 * bytes. Measured total 22,575 across 26 tools; the absolute pin follows it
 * down. The mean pin stays HELD at 875: 22,575 / 26 = 868.27.
 *
 * **Re-derived — round 8, #3464 (2026-09-29).** Four descriptions must now
 * name the canonical allowance-block key set — remainingAtomic /
 * remainingDisplay / resetPeriodMin / tokenSymbol / tokenAddress, the names
 * `haven_get_agent`'s rows report — AND mark the snake_case spellings
 * deprecated with the removal window stated: `haven_settle_mcp_tool`,
 * `haven_complete_mcp_tool`, the shared `getPaymentStatus` behavior the
 * hosted status tool composes, and the catalog-preflight paragraph inside
 * `haven_prepare_catalog_purchase`. The issue mandates exactly this copy in
 * exactly these descriptions; the leanest version that still enumerates the
 * five canonical keys and the five deprecated ones costs +1,195 UTF-8 bytes
 * net (22,586 → 23,781 across the same 26 tools; #3475's disjoint −11 above
 * makes the merged-tree measure 23,770), and the enumeration IS the
 * mandated content — no duplication or overclaim remains to trim. So the
 * absolute pin moves to the exact measured value of this surface,
 * 23,770 UTF-8 bytes across 26 tools, shrink-only from here; and the mean
 * pin moves too, because 23,770 / 26 = 914.23 sits ABOVE the held 875
 * ceiling and a pin above the tree it guards is the exact failure rounds
 * 2-3 named ("the constant cannot stay while the tree the PR must merge
 * into already exceeds it"). Re-derived at the measured mean, shrink-only
 * from here.
 *
 * **Re-derived — round 9, #3476 (2026-09-29).** `haven_pay_x402_quote` gains
 * an `allowance` block (the plain-HTTP sibling of the catalog preflight's
 * budget visibility), and its description carries one lean clause naming the
 * field and its degraded read (+213 UTF-8 bytes on that one description,
 * 1,926 → 2,139): an agent reading tools/list learns the block exists before
 * its first pay, the same field-naming obligation every additive response
 * field on this surface has carried. No overclaim remains to trim — the
 * clause states the shape and the degraded read and nothing else. Measured
 * total 23,983 across the same 26 tools; the absolute pin moves to that
 * exact value, shrink-only from here. The mean pin moves too: 23,983 / 26 =
 * 922.42 sits above round 8's 914.24, and the same round-8 rule applies (the
 * constant cannot stay while the tree the PR must merge into already
 * exceeds it) — re-derived at the measured mean, shrink-only from here.
 *
 * **Re-derived — round 10, #3475 follow-up (2026-09-30, review round 1
 * wording).** The shared `haven_report_settlement_evidence` description now
 * says `settlement_tx_hash` is optional and that omitting it SUCCEEDS AS A
 * NO-OP — nothing checked, nothing recorded, no network call — rather than
 * refusing, per review round 1's S3 (an agent following next_tool /
 * next_arguments verbatim must never get an error for doing exactly that).
 * The same field-naming obligation round 9 states applies:
 * `haven_report_x402_outcome` can now name this tool as the next step
 * before it knows whether the merchant returned a hash at all, and an agent
 * reading tools/list needs to know a bare `payment_id` call is well-formed
 * and what it does (+140 UTF-8 bytes on that one description). No overclaim
 * remains to trim. Measured total 24,123 across the same 26 tools; the
 * absolute pin moves to that exact value, shrink-only from here. The mean
 * pin moves too: 24,123 / 26 = 927.81 sits above round 9's 922.42, and the
 * same rule applies — re-derived at the measured mean, shrink-only from
 * here.
 *
 * **Re-derived — round 11, #3495 (2026-09-30).** The direct-payment
 * description (`PAY_DESCRIPTION`, shared by `haven_pay`) now documents the
 * compact-by-default contract this issue built: `idempotency_key` in the
 * returned shape, that it is generated when omitted, and the
 * `include_signing_payload=true` same-key re-run that restores the relay
 * pair — replacing the old unconditional "re-sign with { payload_hash,
 * typed_data_b64 } from the result" sentence, which was no longer true. Same
 * tool count (26) — this is a reword, not a new tool. Measured total 24,452;
 * the absolute pin moves to that exact value, shrink-only from here. The
 * mean pin moves too: 24,452 / 26 = 940.4615… sits above round 10's 927.81,
 * and the same rule applies — re-derived at the measured mean, shrink-only
 * from here.
 *
 * **Re-derived — round 12, #3495 review round 2 (2026-09-30).**
 * `PAY_DESCRIPTION` (`haven_pay`) named only `SIGN_CONTEXT_REFUSED` /
 * `sign_context_unavailable` as the opt-in trigger — review round 2 caught
 * that a currently-published signer's OWN transport-failure/malformed/404
 * fallback (`fallback: 'typed_data_b64'`, any code) never sets that backend
 * code, so an agent whose signer refused that way had no route named in this
 * description at all. The sentence now names both trigger shapes (+95 UTF-8
 * bytes on that one description: was 24,452 total / 940.4615 mean, now
 * 24,547 / 944.1153…). Same tool count (26) — a reword, not a new tool.
 * Measured total 24,547; the absolute pin moves to that exact value,
 * shrink-only from here. The mean pin moves too: 24,547 / 26 = 944.1153… sits
 * above round 11's 940.47, and the same rule applies — re-derived at the
 * measured mean, shrink-only from here.
 */
/**
 * **Re-derived — round 13, #3501 union with #3495 (2026-10-01 merge).** Both
 * changes grew from the same round-10 base: this branch (#3501) adds
 * `haven_get_agent`'s budget-visibility figures — `taskBudgets[]` rows gain
 * `spentAtomic`, `remainingAtomic`, `remainingDisplay` (what the chain will
 * still allow through an open task budget) and the `remainingIsFromChain`
 * honesty flag — and `haven_get_allowances` names where task budgets live
 * (+351 UTF-8 bytes across those two descriptions, compressed once: the
 * clauses state the fields, the degraded read, and nothing else — an agent
 * reading tools/list learns the fields exist before it attempts a payment a
 * spent-out task budget will refuse, the same field-naming obligation rounds
 * 9/10 recorded for additive response fields. No overclaim remains to trim),
 * while dev's #3495 rewords the direct-payment description (rounds 11/12
 * above). The union tree re-measures at 24,898 across the same 26 tools —
 * 24,547 + the 351 bytes this branch adds, exactly — so the absolute pin
 * moves to that exact value, shrink-only from here. The mean pin moves too:
 * 24,898 / 26 = 957.6154 sits above round 12's 944.12, and the same rule
 * applies — re-derived at the measured mean, shrink-only from here.
 *
 * **Re-derived — round 14, #3529 (2026-10-01).** The shared
 * `haven_report_settlement_evidence` nextActionGuidance must name the new
 * refusal code before an agent meets it: a reason-bearing refusal (the
 * backend's relayed `reason`, #3475's evidence contract) now answers
 * `SETTLEMENT_NOT_RECORDED` instead of `DELIVERED_UNSETTLED`, and the
 * guidance says what that means — funding confirmed, this hash not accepted,
 * the reason carried verbatim — while the `DELIVERED_UNSETTLED` line is
 * reworded to the honest-for-every-case form (+185 UTF-8 bytes on that one
 * description). No overclaim remains to trim: the added lines name the code,
 * the field, and the do-not-retry, exactly the shape rounds 9/10 recorded
 * for additive response vocabulary. Measured total 25,083 across the same 26
 * tools; the absolute pin moves to that exact value, shrink-only from here.
 * The mean pin moves too: 25,083 / 26 = 964.7308 sits above round 13's
 * 957.62, and the same rule applies — re-derived at the measured mean,
 * shrink-only from here.
 */
/**
 * **Re-derived — round 14, #3518 (2026-10-01).** A new hosted tool joins the
 * surface — `haven_get_task_budget`, the read-by-id a close refusal's
 * "re-check the budget's status" points at — and two descriptions grow to
 * name the new visibility fields: `haven_get_agent`'s rows now carry their
 * lifecycle `status` + `isExpired` (a closing budget must be visible AS
 * closing, not vanish), and `haven_get_allowances` names `delegationHash` /
 * `recipientAddress` (null = open) / `merchantId` / `reservedHavenAtomic` —
 * the scope fields that let an agent holding two budgets for one token name
 * the merchant-locked one BEFORE paying, and the Haven-side reservation
 * figure reported beside (never folded into) the on-chain remaining. The
 * clauses state the fields and their degraded read and nothing else — the
 * same field-naming obligation rounds 9/10 recorded for additive response
 * fields; no overclaim remains to trim. Measured on this tree: 25,716 UTF-8
 * bytes across 27 tools; the absolute pin moves to that exact value,
 * shrink-only from here. The mean pin is HELD without moving: 25,716 / 27 =
 * 952.44 sits BELOW round 13's 957.62 ceiling — the new tool's lean
 * description plus the additive clauses land under it.
 *
 * **Re-derived — round 14, #3506 (agent-completes sub-budgets).** The agent
 * can now complete a sub-budget itself, which needs two additive facts an
 * agent only learns from `tools/list`: `haven_get_agent` carries
 * `pendingSubBudgetSignatures[]` (the rows awaiting ITS signature, each with
 * its `haven_sign` next step), and `haven_submit` accepts `sub_budget_id`
 * beside `payment_id` / `task_budget_id` (exactly one). +144 UTF-8 bytes
 * across those two descriptions, compressed to one clause each (the field
 * name and where the id goes; the response carries the rest as next-step
 * fields) — the same field-naming obligation rounds 9/10/13 recorded for
 * additive response fields and a new accepted argument. Same tool count (26).
 * 24,898 + 144 = 25,042, measured, so the absolute pin moves to that exact
 * value, shrink-only from here; the mean moves with it (25,042 / 26 =
 * 963.1538…, pinned at the two-decimal ceiling).
 *
 * **Re-derived — round 14, #3529 (2026-10-01).** The shared
 * `haven_report_settlement_evidence` nextActionGuidance must name the new
 * refusal code before an agent meets it: a reason-bearing refusal (the
 * backend's relayed `reason`, #3475's evidence contract) now answers
 * `SETTLEMENT_NOT_RECORDED` instead of `DELIVERED_UNSETTLED`, and the
 * guidance says what that means — funding confirmed, this hash not accepted,
 * the reason carried verbatim — while the `DELIVERED_UNSETTLED` line is
 * reworded to the honest-for-every-case form (+185 UTF-8 bytes on that one
 * description). No overclaim remains to trim: the added lines name the code,
 * the field, and the do-not-retry, exactly the shape rounds 9/10 recorded
 * for additive response vocabulary.
 *
 * **Re-derived — round 15, #3506 ∪ #3529 union tree (2026-10-01 rebase).**
 * Both round-14 changes grew from the same round-13 base on disjoint
 * descriptions: this branch (#3529) grew the shared
 * `haven_report_settlement_evidence` nextActionGuidance by 185 bytes, while
 * dev's #3506 added 144 bytes across `haven_get_agent` and `haven_submit`.
 * The union tree re-measures at 25,227 across the same 26 tools — 25,042 +
 * 185 = 25,227, exactly — so the absolute pin moves to that exact value,
 * shrink-only from here. The mean pin moves too: 25,227 / 26 = 970.2692
 * sits above both round-14 pins, and the same rule applies — re-derived at
 * the measured mean, shrink-only from here.
 *
 * **Re-derived — round 16, #3518 ∪ (#3506 ∪ #3529) integration tree
 * (2026-10-01 merge).** The two round-14 branches meet here on disjoint
 * descriptions: #3518's round-14 grew FROM the same round-13 base and joins
 * the union with its new hosted tool (`haven_get_task_budget`, 26 → 27) plus
 * the visibility clauses on `haven_get_agent` / `haven_get_allowances`,
 * while dev's round-15 union carries #3506 + #3529's additions on the other
 * descriptions. The three-way union re-measures at 26,045 UTF-8 bytes across
 * 27 tools, measured on the merged tree (not derived arithmetically — the
 * sentence-level unions on `haven_get_agent` overlap both branches), so the
 * absolute pin moves to that exact value, shrink-only from here. The mean
 * pin: 26,045 / 27 = 964.6296…, pinned at the two-decimal ceiling (964.63)
 * — below round 15's 970.27 because the 27th tool joins the denominator,
 * and the stricter of the two holds; shrink-only still applies.
 *
 * **Shrunk — round 17, #3518 review.** The `haven_get_task_budget` and
 * `haven_get_agent` descriptions stopped claiming the agent read lists every
 * task budget (it lists live rows only). Measured 26,029 bytes / 27 tools;
 * both pins ratchet down to the measured values.
 *
 * **Re-derived — round 18, #3723 (2026-10-07).** A 28th hosted description
 * joins (`haven_get_receipt`, described from the shared `getReceipt`
 * fragment) and `haven_verify_receipt`'s fragment grows to name it, so the
 * shrink-only round-17 total cannot hold and is RE-DERIVED at the measured
 * value — a new round, not a loosening: 26,903 UTF-8 bytes across 28 tools,
 * measured on the #3723 tree (round 17 base 26,029 + 874). The mean pin:
 * 26,903 / 28 = 960.8214…, pinned at the two-decimal ceiling (960.83) —
 * stricter than round 17's 964.04 because the 28th tool joins the
 * denominator and the new description is short; the stricter of the two
 * holds, shrink-only from here.
 */
const MAX_TOTAL_BYTES = 26_903
// Mean pin: round 18 (block above): 26,903 / 28 = 960.8214…, pinned at the
// two-decimal ceiling (960.83). Shrink-only from here.
const MAX_MEAN_BYTES = 960.83

describe('tool description payload (#1591)', () => {
  it(`served descriptions average ≤${MAX_MEAN_BYTES} UTF-8 bytes (pre-trim total was ${PRE_TRIM_BASELINE_BYTES})`, () => {
    const sizes = Object.values(toolDescriptions).map((d) => Buffer.byteLength(d, 'utf8'))
    const total = sizes.reduce((n, size) => n + size, 0)
    const mean = total / sizes.length
    expect(mean).toBeLessThanOrEqual(MAX_MEAN_BYTES)
    // The same bound stated absolutely against the integer total, so the two
    // can never disagree (and no float rounding can split them).
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES)
  })

  it('no agent-visible description or instruction contains internal issue archaeology (#N)', () => {
    // The history is for maintainers — it lives in code comments, and a
    // Codex/GPT agent burning context on "#1308" learns nothing from it.
    // Allowlist NOTHING (the AC's words).
    //
    // #3497: the rule now also covers response PROSE (guidance reason /
    // signer_compatibility check / strict-input messages) — enforced as a
    // source scan over src/tools/** in `response-prose.test.ts`, which is
    // where the live run's leaks ("(#1455)", "(#1547)", "predating #3271")
    // actually lived. This file keeps guarding what it always has.
    const offenders = Object.entries(toolDescriptions)
      .filter(([, description]) => /#\d+/.test(description))
      .map(([name]) => name)
    expect(offenders).toEqual([])
    expect(/#\d+/.test(HOSTED_INSTRUCTIONS)).toBe(false)
  })

  it('the shared flow guidance lives in the instructions, not repeated per description', () => {
    // Spot-pins for the moved guidance: the signing litany and the expiry
    // rule appear ONCE (instructions), and the phrases that used to open
    // nearly every description are gone from all of them.
    expect(HOSTED_INSTRUCTIONS).toContain('pass JUST { payment_id }')
    expect(HOSTED_INSTRUCTIONS).toContain('re-run the same tool with the SAME')
    const repeatOffenders = Object.entries(toolDescriptions)
      .filter(([, d]) => d.includes('FOLLOW THE STRUCTURED FIELDS FIRST'))
      .map(([name]) => name)
    expect(repeatOffenders).toEqual([])
  })
})
