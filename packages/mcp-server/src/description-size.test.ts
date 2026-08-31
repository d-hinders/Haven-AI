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
 */
const MAX_MEAN_BYTES = 874

describe('tool description payload (#1591)', () => {
  it(`served descriptions average ≤${MAX_MEAN_BYTES} UTF-8 bytes (pre-trim total was ${PRE_TRIM_BASELINE_BYTES})`, () => {
    const sizes = Object.values(toolDescriptions).map((d) => Buffer.byteLength(d, 'utf8'))
    const total = sizes.reduce((n, size) => n + size, 0)
    const mean = total / sizes.length
    expect(mean).toBeLessThanOrEqual(MAX_MEAN_BYTES)
    // The same bound stated absolutely, so the two can never disagree.
    expect(total).toBeLessThanOrEqual(MAX_MEAN_BYTES * sizes.length)
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
