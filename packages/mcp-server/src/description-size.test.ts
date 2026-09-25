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
 * task_budget_id branch (+63 bytes). Nothing pre-existing grew. Measured total:
 * 21,994 UTF-8 bytes / 26 tools = 845.9 mean — the mean actually DROPS (875.0 →
 * 845.9) because the two new descriptions are leaner than the surface average, so
 * only the absolute pin needs to move; it moves to the exact measured value,
 * shrink-only from here, same discipline as every prior re-derivation.
 */
const MAX_TOTAL_BYTES = 21_994
// #3329: the mean pin stays the prior shrink-only value (21,000 / 24 = 875.0)
// rather than re-deriving down to this surface's actual (lower) mean — the
// two new descriptions happened to be lean, but the pin's job is a ceiling,
// not a running average of whatever landed most recently.
const MAX_MEAN_BYTES = 875

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
