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

  it('refuses a string level rather than treating it as unissuable', () => {
    // Set.has is identity-based: '0' would not match 0. Coercion guards a
    // driver/type change turning every lookup into a refusal.
    expect(assuranceLevelOf(rowWith('0'))).toBe(AssuranceLevel.L0)
    expect(assuranceLevelOf(rowWith('1'))).toBeNull()
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace', '  '],
    ['a non-numeric string', 'L0'],
    ['an object', {}],
    ['a boolean', false],
  ])('refuses %s rather than defaulting it to L0', (_name, raw) => {
    // Every one of these coerces to 0 under a bare `Number()`, and 0 is
    // issuable — so each is a way to silently report an ABSENT level as
    // "governed by Haven". Two of them (null, '') actually shipped in earlier
    // drafts of this function and were caught here.
    expect(assuranceLevelOf(rowWith(raw))).toBeNull()
  })

  it('does not clamp an unissuable level to L0', () => {
    // The tempting wrong fix. Clamping UNDERSTATES a higher tier, which sounds
    // conservative and is not: a merchant's screening logic branches on this
    // field, so reporting a screened agent as merely governed is a wrong answer
    // presented as a right one.
    expect(assuranceLevelOf(rowWith(1))).not.toBe(AssuranceLevel.L0)
  })
})

describe('the receipt is built from the row, not from a literal', () => {
  // The regression guard for the mutation that behaviour cannot catch.
  //
  // The FIRST version of this guard sliced only the receipt object literal and
  // asserted it did not match /assuranceLevel:\s*AssuranceLevel\./ — a purely
  // NEGATIVE test, and review evaded it in one line by hoisting
  // `const hardcoded = AssuranceLevel.L0` above the slice, and again by writing
  // a bare `0`. Both left all 134 tests green. A negative assertion only ever
  // excludes the spelling you thought of.
  //
  // So this asserts POSITIVELY over the whole function: the receipt must bind
  // the field to the computed identifier, and that identifier must come from
  // `assuranceLevelOf(row)`. Any hardcode — literal, hoisted const, bare
  // number — fails one of the two.
  const buildReceiptSource = () => {
    const src = readFileSync(VERIFICATION_SRC, 'utf8')
    const start = src.indexOf('export async function buildReceipt')
    const end = src.indexOf('export async function verifyPassport')
    const body = src.slice(start, end)
    // Guard the guard: if either anchor moves, this must fail loudly rather
    // than assert over an empty string.
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(body.length).toBeGreaterThan(200)
    return body
  }

  it('derives the level from the row via assuranceLevelOf', () => {
    expect(buildReceiptSource()).toMatch(/const\s+assuranceLevel\s*=\s*assuranceLevelOf\(\s*row\s*\)/)
  })

  it('passes that computed value to the receipt, not a literal', () => {
    const body = buildReceiptSource()
    // Shorthand `assuranceLevel,` or explicit `assuranceLevel: assuranceLevel`.
    expect(body).toMatch(/assuranceLevel(,|:\s*assuranceLevel\b)/)
    // ...and nothing in the whole function may name an enum member or a bare
    // number for this field. This is what the hoisted-const mutation evaded.
    expect(
      body,
      'buildReceipt must not name an AssuranceLevel member. Hardcoding is correct only ' +
        'while agent_passport_level_issuable pins the column, and silently misreports the ' +
        'day the ladder widens (#975). Use assuranceLevelOf(row).',
    ).not.toMatch(/AssuranceLevel\.L\d/)
    expect(body).not.toMatch(/assuranceLevel:\s*\d/)
  })
})
