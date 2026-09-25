/**
 * #3032 (epic #3028 slice 4) — the flip: `HAVEN_REQUEST_VALIDATION` defaults
 * to `enforce`.
 *
 * The default is THE deliverable of the slice: every constrained module is
 * listed in index.ts's `enforcedModules`, the ratchet sits at zeros, and the
 * connector/CLI/dashboard request shapes were proven — so an operator who
 * sets NOTHING gets the gate. `off` and `shadow` stay as the operator kill
 * switches, and a typo still refuses the boot (never a silent fallback to
 * "shadow", which would look like the gate is on when it is misspelled).
 */
import { describe, expect, it } from 'vitest'
import { parseRequestValidationMode } from '../config.js'

describe('parseRequestValidationMode — the #3032 flip', () => {
  it('defaults to enforce when the variable is absent', () => {
    expect(parseRequestValidationMode(undefined)).toBe('enforce')
    expect(parseRequestValidationMode(null)).toBe('enforce')
  })

  it('defaults to enforce when the variable is set but empty', () => {
    // An empty shell value (`HAVEN_REQUEST_VALIDATION=`) is "not configured",
    // not "off" — the same reading the pre-flip parser gave it for `shadow`.
    expect(parseRequestValidationMode('')).toBe('enforce')
    expect(parseRequestValidationMode('   ')).toBe('enforce')
  })

  it('the operator switches still select explicitly', () => {
    expect(parseRequestValidationMode('enforce')).toBe('enforce')
    expect(parseRequestValidationMode('shadow')).toBe('shadow')
    expect(parseRequestValidationMode('off')).toBe('off')
  })

  it('a typo refuses the boot — never a silent fallback', () => {
    // Mutation: return 'shadow' instead of throwing → red. The message names
    // the three values and says the mode change is a restart.
    expect(() => parseRequestValidationMode('enfoce')).toThrow(/must be "off"/)
    expect(() => parseRequestValidationMode('Enforce')).toThrow(/must be "off"/)
  })
})
