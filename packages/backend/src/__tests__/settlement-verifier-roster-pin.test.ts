// #2680 slice-2 guard — pins architecture/04-x402-payment-sequence.md's
// settlement-verifier check roster: the doc says the verifier "requires ALL
// of" a seven-clause shape list (checks 1–7) plus "a check 8, and it is the
// only one about WHICH payment rather than what shape it had" — the #2094
// delegation-hash check — and that skipping it degrades to "checks 1–7
// exactly as before". Pinned against settlement-transfer-verifier.ts, where
// checks 1–8 are enumerated as numbered bold docstring list items and check 8
// additionally carries its own "## Check 8 — WHICH…" heading.
//
// Mutation-proven for #2680: appending a ninth numbered item reddens the
// count; deleting the Check 8 heading or the hashDelegation call reddens the
// identity assertions; restoring the file turns it green, byte-identical.
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

  it('enumerates exactly checks 1..8 as numbered bold list items', () => {
    // The docstring's check roster: every check site is a "* N. **…" item.
    const nums = [...src.matchAll(/^\s*\*\s+(\d+)\.\s+\*\*/gm)].map((m) => m[1])
    expect(nums.length).toBe(8)
    expect([...nums].sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
  })

  it('check 8 is the WHICH-payment delegation-hash check with a checks-1..7 degrade', () => {
    expect(src).toMatch(/## Check 8 — WHICH delegation was redeemed/)
    // Re-hash of the emitted struct with the framework's own hasher, compared
    // against the stored delegation_hash (the doc's check-8 paragraph).
    expect(src).toMatch(/hashDelegation/)
    expect(src).toMatch(/delegation_hash/)
    // The doc's "can never turn a genuine settlement into a refusal" clause:
    expect(src).toMatch(/verdict is checks 1–7/)
  })
})
