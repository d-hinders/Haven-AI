import { describe, expect, it } from 'vitest'
import { nextViesStatus, shouldTriggerViesCheck, validateCompanyDetailsInput } from '../service.js'
import type { OwnerCompanyDetailsRow } from '../../../infra/repositories/owner-company-details.js'

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
