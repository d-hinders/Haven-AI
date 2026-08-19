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
 * trim, measured on 2026-08-19. The ratchet: stay at least 40% below it.
 * Trimmed result at merge time: 15,568 UTF-8 bytes (49.1% below).
 */
const PRE_TRIM_BASELINE_BYTES = 30_609
const MAX_ALLOWED_BYTES = Math.floor(PRE_TRIM_BASELINE_BYTES * 0.6)

describe('tool description payload (#1591)', () => {
  it(`total served description bytes stay ≥40% under the pre-trim baseline (${PRE_TRIM_BASELINE_BYTES})`, () => {
    const total = Object.values(toolDescriptions).reduce(
      (n, d) => n + Buffer.byteLength(d, 'utf8'),
      0,
    )
    expect(total).toBeLessThanOrEqual(MAX_ALLOWED_BYTES)
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
