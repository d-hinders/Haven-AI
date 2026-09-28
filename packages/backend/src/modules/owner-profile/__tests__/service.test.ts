import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextViesStatus, runViesCheck, shouldTriggerViesCheck, validateCompanyDetailsInput } from '../service.js'
import type { OwnerCompanyDetailsRow } from '../../../infra/repositories/owner-company-details.js'
import * as viesClientModule from '../vies-client.js'
import * as ownerCompanyDetailsRepo from '../../../infra/repositories/owner-company-details.js'

function row(overrides: Partial<OwnerCompanyDetailsRow> = {}): OwnerCompanyDetailsRow {
  return {
    user_id: 'u1',
    legal_name: 'Acme AB',
    country: 'SE',
    org_number: '556677-8899',
    vat_number: 'SE556677889901',
    vies_status: 'valid',
    vies_checked_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('validateCompanyDetailsInput (#3332)', () => {
  it('normalises legal_name (trim, collapse whitespace)', () => {
    const result = validateCompanyDetailsInput({
      legal_name: '  Acme   AB  ',
      country: 'se',
      org_number: '556677-8899',
      vat_number: null,
    })
    expect(result).toEqual({
      ok: true,
      value: { legal_name: 'Acme AB', country: 'SE', org_number: '556677-8899', vat_number: null },
    })
  })

  it('rejects a blank legal name', () => {
    const result = validateCompanyDetailsInput({ legal_name: '   ', country: 'SE', org_number: '1', vat_number: null })
    expect(result).toEqual({ ok: false, error: 'invalid_legal_name' })
  })

  it.each([
    '‮', // RIGHT-TO-LEFT OVERRIDE
    '‪', // LEFT-TO-RIGHT EMBEDDING
    '⁦', // LEFT-TO-RIGHT ISOLATE
    '⁩', // POP DIRECTIONAL ISOLATE
    '\u0080', // a C1 control
    '\u009F', // the last C1 control
  ])('rejects a legal name containing a bidi/C1 control character (%j) (#3332 review minor)', (control) => {
    const result = validateCompanyDetailsInput({
      legal_name: `Acme${control}AB`,
      country: 'SE',
      org_number: '1',
      vat_number: null,
    })
    expect(result).toEqual({ ok: false, error: 'invalid_legal_name' })
  })

  it('rejects a legal name over 200 characters', () => {
    const result = validateCompanyDetailsInput({
      legal_name: 'a'.repeat(201),
      country: 'SE',
      org_number: '1',
      vat_number: null,
    })
    expect(result).toEqual({ ok: false, error: 'invalid_legal_name' })
  })

  it.each(['S', 'SWE', '12', 's3'])('rejects a malformed country %s', (country) => {
    const result = validateCompanyDetailsInput({ legal_name: 'Acme', country, org_number: '1', vat_number: null })
    expect(result).toEqual({ ok: false, error: 'invalid_country' })
  })

  it('rejects a blank org number', () => {
    const result = validateCompanyDetailsInput({ legal_name: 'Acme', country: 'SE', org_number: '  ', vat_number: null })
    expect(result).toEqual({ ok: false, error: 'invalid_org_number' })
  })

  it('rejects an org number over 32 characters', () => {
    const result = validateCompanyDetailsInput({
      legal_name: 'Acme',
      country: 'SE',
      org_number: '1'.repeat(33),
      vat_number: null,
    })
    expect(result).toEqual({ ok: false, error: 'invalid_org_number' })
  })

  it('normalises a VAT number (uppercase, strip internal spaces)', () => {
    const result = validateCompanyDetailsInput({
      legal_name: 'Acme',
      country: 'SE',
      org_number: '1',
      vat_number: 'se 5566 7788 9901',
    })
    expect(result).toEqual({
      ok: true,
      value: { legal_name: 'Acme', country: 'SE', org_number: '1', vat_number: 'SE556677889901' },
    })
  })

  it('empty-string vat_number is treated as absent, not a shape error', () => {
    const result = validateCompanyDetailsInput({ legal_name: 'Acme', country: 'SE', org_number: '1', vat_number: '' })
    expect(result).toEqual({ ok: true, value: { legal_name: 'Acme', country: 'SE', org_number: '1', vat_number: null } })
  })

  it('rejects a VAT number with no valid 2-letter prefix shape', () => {
    const result = validateCompanyDetailsInput({
      legal_name: 'Acme',
      country: 'SE',
      org_number: '1',
      vat_number: '556677889901',
    })
    expect(result).toEqual({ ok: false, error: 'invalid_vat_number' })
  })

  it('accepts a VAT number whose country prefix differs from the address country (deliberate — #3332)', () => {
    const result = validateCompanyDetailsInput({
      legal_name: 'Acme',
      country: 'SE',
      org_number: '1',
      vat_number: 'DE811569869',
    })
    expect(result.ok).toBe(true)
  })
})

describe('shouldTriggerViesCheck / nextViesStatus', () => {
  it('no VAT number: never triggers, status is null', () => {
    const next = { legal_name: 'Acme', country: 'SE', org_number: '1', vat_number: null }
    expect(shouldTriggerViesCheck(null, next)).toBe(false)
    expect(nextViesStatus(null, next)).toBeNull()
  })

  it('a fresh VAT number on a first-ever save triggers and is pending', () => {
    const next = { legal_name: 'Acme', country: 'SE', org_number: '1', vat_number: 'SE556677889901' }
    expect(shouldTriggerViesCheck(null, next)).toBe(true)
    expect(nextViesStatus(null, next)).toBe('pending')
  })

  it('a CHANGED VAT number triggers and resets to pending, even if the old one was valid', () => {
    const previous = row({ vat_number: 'SE556677889901', vies_status: 'valid' })
    const next = { legal_name: 'Acme AB', country: 'SE', org_number: '556677-8899', vat_number: 'DE811569869' }
    expect(shouldTriggerViesCheck(previous, next)).toBe(true)
    expect(nextViesStatus(previous, next)).toBe('pending')
  })

  it('the SAME VAT number does not trigger and keeps the previous status', () => {
    const previous = row({ vat_number: 'SE556677889901', vies_status: 'valid' })
    const next = { legal_name: 'Acme AB Updated', country: 'SE', org_number: '556677-8899', vat_number: 'SE556677889901' }
    expect(shouldTriggerViesCheck(previous, next)).toBe(false)
    expect(nextViesStatus(previous, next)).toBe('valid')
  })
})

/**
 * #3332 review M-B: pins the B1 fix at the ACTUAL call site — through
 * `runViesCheck` itself, the function `writeCompanyDetails` and
 * `triggerManualRecheck` both call — rather than through a hand-derived
 * `viesRequestForVatNumber(...)` result fed straight to `checkVatWithVies`
 * (that only proves the two functions agree with each other, not that
 * `runViesCheck` actually calls `viesRequestForVatNumber` at all).
 *
 * Mutation: replacing `viesRequestForVatNumber(vatNumber)` in `service.ts`'s
 * `runViesCheck` with the pre-B1 shape (`{ countryCode: vatNumber.slice(0, 2),
 * vatNumber }`, prefix left inside `vatNumber` and never mapped GR→EL) turns
 * every assertion below red.
 */
describe('runViesCheck derives the VIES request from the call site (#3332 review M-B)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['SE556703748501', 'SE', '556703748501'],
    ['GR094014201', 'EL', '094014201'],
  ])('%s → checkVatWithVies(%j, %j)', async (vatNumber, expectedCountryCode, expectedBareNumber) => {
    const checkSpy = vi
      .spyOn(viesClientModule, 'checkVatWithVies')
      .mockResolvedValue({ status: 'valid', reason: null })
    vi.spyOn(ownerCompanyDetailsRepo, 'setViesResult').mockResolvedValue(null)

    await runViesCheck('user-1', vatNumber)

    expect(checkSpy).toHaveBeenCalledExactlyOnceWith(expectedCountryCode, expectedBareNumber)
  })
})

/**
 * #3332 review m1 (captain's decision): a VAT number whose own prefix is not
 * a VIES member country code is accepted and stored (unchanged — this only
 * covers the async CHECK), but `runViesCheck` must never call VIES for it:
 * the result is recorded immediately as `not_verifiable` /
 * `non_member_prefix`, with no transport call at all.
 */
describe('runViesCheck: a non-member VAT prefix skips VIES entirely (#3332 review m1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('US123456789: no VIES call, recorded not_verifiable/non_member_prefix', async () => {
    const checkSpy = vi.spyOn(viesClientModule, 'checkVatWithVies')
    const setResultSpy = vi.spyOn(ownerCompanyDetailsRepo, 'setViesResult').mockResolvedValue(null)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runViesCheck('user-1', 'US123456789')

    expect(checkSpy).not.toHaveBeenCalled()
    expect(setResultSpy).toHaveBeenCalledExactlyOnceWith('user-1', 'not_verifiable', expect.any(String), 'US123456789')
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
    expect(logged).toMatchObject({ status: 'not_verifiable', reason: 'non_member_prefix' })
  })

  it('a member prefix (SE) still calls VIES', async () => {
    const checkSpy = vi.spyOn(viesClientModule, 'checkVatWithVies').mockResolvedValue({ status: 'valid', reason: null })
    vi.spyOn(ownerCompanyDetailsRepo, 'setViesResult').mockResolvedValue(null)

    await runViesCheck('user-1', 'SE556703748501')

    expect(checkSpy).toHaveBeenCalledOnce()
  })
})
