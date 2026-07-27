// The assurance ladder's read path (#975).
//
// ## Why this file exists at all
//
// The verifier used to hardcode `AssuranceLevel.L0`. Replacing that with a read
// of `row.assurance_level` is the whole of #975's remaining slice — and it is
// UNTESTABLE THROUGH BEHAVIOUR while L0 is the only issuable level, because for
// every valid input the two implementations emit the same byte. Mutating the
// receipt back to a hardcoded literal left all 126 route + lib tests green.
//
// So this pins it two ways that do work:
//   1. unit tests on the reader itself, including the levels that are DEFINED
//      but not issuable — the inputs where the two implementations diverge;
//   2. a source-level guard that the receipt does not hardcode a literal level.
//
// Saying "the tests cover this" without (2) would have been a coverage claim
// that a five-second mutation disproves.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assuranceLevelOf } from '../verification.js'
import { AssuranceLevel } from '../schema.js'
import type { VerificationRow } from '../../../infra/repositories/agent-passports.js'

const VERIFICATION_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../verification.ts',
)

const rowWith = (assurance_level: unknown) =>
  ({ agent_id: 'agt_1', assurance_level } as unknown as VerificationRow)

describe('assuranceLevelOf reads the stored level', () => {
  it('returns L0 for the only issuable level', () => {
    expect(assuranceLevelOf(rowWith(0))).toBe(AssuranceLevel.L0)
  })

  it.each([
    ['L1 (reserved — sanctions screening)', 1],
    ['L2 (reserved — ZK-anchored KYC)', 2],
  ])('refuses %s rather than reporting it', (_name, level) => {
    // These are DEFINED in the enum, which is exactly what makes them dangerous:
    // a reader that trusted the enum alone would happily pass them through. The
    // gate is ISSUABLE_ASSURANCE_LEVELS, not enum membership.
    expect(assuranceLevelOf(rowWith(level))).toBeNull()
  })

  it.each([
    ['an unknown level', 99],
    ['a missing column', undefined],
    ['null', null],
  ])('refuses %s', (_name, level) => {
    expect(assuranceLevelOf(rowWith(level))).toBeNull()
  })

  it('does not clamp an unissuable level to L0', () => {
    // The tempting wrong fix. Clamping UNDERSTATES a higher tier, which sounds
    // conservative and is not: a merchant's screening logic branches on this
    // field, so reporting a screened agent as merely governed is a wrong answer
    // presented as a right one.
    expect(assuranceLevelOf(rowWith(1))).not.toBe(AssuranceLevel.L0)
  })
})

describe('the receipt does not hardcode an assurance level', () => {
  // The regression guard for the mutation that behaviour cannot catch. If a
  // future edit puts a literal back, this fails even though every other test
  // still passes.
  it('builds assuranceLevel from the row, not from a literal', () => {
    const src = readFileSync(VERIFICATION_SRC, 'utf8')
    const receiptBlock = src.slice(
      src.indexOf('const receipt: PassportReceipt = {'),
      src.indexOf('issuedAt: now'),
    )
    expect(receiptBlock.length).toBeGreaterThan(100)
    expect(
      receiptBlock,
      'The receipt must carry the level READ from the passport row. Hardcoding ' +
        'AssuranceLevel.Lx is correct only while the agent_passport_level_issuable ' +
        'CHECK pins the column, and it silently misreports the day the ladder widens ' +
        '(#975). Use assuranceLevelOf(row).',
    ).not.toMatch(/assuranceLevel:\s*AssuranceLevel\./)
  })
})
