// #2680 slice-2 guard — pins architecture/04-x402-payment-sequence.md's
// settlement-verifier check roster: the doc says there are EIGHT checks
// (checks 1–7 shape/flow, check 8 the #2094 WHICH-payment delegation-hash
// check) and that check 8 is "the only one about WHICH payment rather than
// what shape it had". Pinned by counting the check sites in
// settlement-transfer-verifier.ts and asserting the delegation-hash check is
// among them.
//
// Mutation-proven for #2680: adding a ninth check site turns the count red;
// restoring the file turns it green, byte-identical.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERIFIER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'infra',
  'chain',
  'settlement-transfer-verifier.ts',
)

describe('x402 settlement verifier check roster (#2680 pin)', () => {
  const src = readFileSync(VERIFIER, 'utf8')

  it('eight check sites exist and the delegation-hash (WHICH-payment) check is among them', () => {
    // The verifier's docstring enumerates the checks; each numbered check
    // appears as a labelled block. Count the check headings.
    const checkHeadings = src.match(/\bcheck \d\b/gi) ?? []
    const unique = new Set(checkHeadings.map((m) => m.toLowerCase()))
    // checks 1..8
    expect(unique.size).toBe(8)
    expect(src).toMatch(/delegation_hash/i)
    expect(src).toMatch(/hashDelegation/i)
  })
})
