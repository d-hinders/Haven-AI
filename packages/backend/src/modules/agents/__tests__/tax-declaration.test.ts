/**
 * Pure rule tests for the tax declaration content decision (#3426, wg-tax #5
 * §2.1). No db, no config, no clock — `nowMs` is a parameter, which is what
 * lets the two `validUntil` bounds be pinned exactly.
 *
 * Covered, per the issue's acceptance list:
 * - the closed four-reason vocabulary, each reason the FIRST fact that failed;
 * - VIES dropping after opt-in (`invalid`, `not_verifiable`, `pending`) and
 *   the flag switched off — the gate is AT READ TIME;
 * - `validUntil` is integer ms and double-bounded: never later than
 *   now + window, and never later than `vies_checked_at` + max VIES age;
 * - GR (a Greek `EL…` VAT number with country `GR`) and XI (Northern
   Ireland): `jurisdiction` comes from `country`, NEVER from the VAT prefix.
 */
import { describe, expect, it } from 'vitest'
import {
  resolveTaxDeclaration,
  TAX_DECLARATION_MAX_VIES_AGE_MS,
  TAX_DECLARATION_MAX_WINDOW_MS,
  type TaxDeclarationFacts,
} from '../tax-declaration.js'

const BASE: TaxDeclarationFacts = {
  featureEnabled: true,
  taxDeclarationEnabled: true,
  country: 'SE',
  vat_number: 'SE556677889901',
  vies_status: 'valid',
  vies_checked_at: '2026-09-28T12:00:00.000Z',
  nowMs: Date.parse('2026-09-28T13:00:00.000Z'),
}

describe('resolveTaxDeclaration — the four reasons', () => {
  it('feature flag off → feature_disabled, before every other fact', () => {
    const result = resolveTaxDeclaration({ ...BASE, featureEnabled: false })
    expect(result).toEqual({ available: false, reason: 'feature_disabled' })
  })

  it('opt-in off → disabled, even with VIES valid', () => {
    const result = resolveTaxDeclaration({ ...BASE, taxDeclarationEnabled: false })
    expect(result).toEqual({ available: false, reason: 'disabled' })
  })

  it('no VAT number saved → no_company_details (null and empty string both)', () => {
    expect(resolveTaxDeclaration({ ...BASE, vat_number: null })).toEqual({
      available: false,
      reason: 'no_company_details',
    })
    expect(resolveTaxDeclaration({ ...BASE, vat_number: '' })).toEqual({
      available: false,
      reason: 'no_company_details',
    })
  })

  it('no company-details row at all → no_company_details (country and VIES null)', () => {
    const result = resolveTaxDeclaration({
      ...BASE,
      country: null,
      vat_number: null,
      vies_status: null,
      vies_checked_at: null,
    })
    expect(result).toEqual({ available: false, reason: 'no_company_details' })
  })

  it('VIES dropped to invalid after opt-in → vies_not_valid AT READ TIME', () => {
    const result = resolveTaxDeclaration({ ...BASE, vies_status: 'invalid' })
    expect(result).toEqual({ available: false, reason: 'vies_not_valid' })
  })

  it('VIES dropped to not_verifiable after opt-in → vies_not_valid (an outage is never a declaration)', () => {
    const result = resolveTaxDeclaration({ ...BASE, vies_status: 'not_verifiable' })
    expect(result).toEqual({ available: false, reason: 'vies_not_valid' })
  })

  it('VIES pending (a re-check in flight) → vies_not_valid', () => {
    const result = resolveTaxDeclaration({ ...BASE, vies_status: 'pending', vies_checked_at: null })
    expect(result).toEqual({ available: false, reason: 'vies_not_valid' })
  })

  it('the flag switched off after opt-in → feature_disabled (the flag outranks the opt-in)', () => {
    const result = resolveTaxDeclaration({ ...BASE, featureEnabled: false })
    expect(result).toEqual({ available: false, reason: 'feature_disabled' })
  })

  it('the reason priority is fixed: flag → opt-in → VAT number → VIES', () => {
    expect(
      resolveTaxDeclaration({
        ...BASE,
        featureEnabled: false,
        taxDeclarationEnabled: false,
        vat_number: null,
        vies_status: 'invalid',
      }),
    ).toEqual({ available: false, reason: 'feature_disabled' })
    expect(
      resolveTaxDeclaration({
        ...BASE,
        taxDeclarationEnabled: false,
        vat_number: null,
        vies_status: 'invalid',
      }),
    ).toEqual({ available: false, reason: 'disabled' })
    expect(
      resolveTaxDeclaration({ ...BASE, vat_number: null, vies_status: 'invalid' }),
    ).toEqual({ available: false, reason: 'no_company_details' })
  })
})

describe('resolveTaxDeclaration — the §2.1 content', () => {
  it('returns exactly the five unsigned fields', () => {
    const result = resolveTaxDeclaration(BASE)
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(Object.keys(result.declaration).sort()).toEqual(
      ['jurisdiction', 'taxId', 'taxableStatus', 'validUntil', 'version'].sort(),
    )
    expect(result.declaration.version).toBe('x402-tax-1')
    expect(result.declaration.taxableStatus).toBe('TAXABLE_PERSON')
    expect(result.declaration.jurisdiction).toBe('SE')
    expect(result.declaration.taxId).toBe('SE556677889901')
  })

  it('validUntil is integer ms bounded by now + window when the VIES check is fresh', () => {
    // A check completed NOW: the window bound (now + 24h) is strictly less
    // than the VIES-age bound (checked + 24h = now + 24h minus epsilon... in
    // fact EQUAL territory), so pin the check exactly at now and expect the
    // lesser of the two — checked_at + age, which cannot exceed now + window.
    const checkedAtMs = BASE.nowMs
    const result = resolveTaxDeclaration({
      ...BASE,
      vies_checked_at: new Date(checkedAtMs).toISOString(),
    })
    expect(result.available).toBe(true)
    if (!result.available) return
    const byWindow = BASE.nowMs + TAX_DECLARATION_MAX_WINDOW_MS
    const byVies = checkedAtMs + TAX_DECLARATION_MAX_VIES_AGE_MS
    expect(result.declaration.validUntil).toBe(Math.min(byWindow, byVies))
    expect(Number.isInteger(result.declaration.validUntil)).toBe(true)
  })

  it('validUntil never exceeds vies_checked_at + max VIES age, even with a fresh now', () => {
    const checkedAtMs = Date.parse(BASE.vies_checked_at as string)
    const result = resolveTaxDeclaration({
      ...BASE,
      nowMs: checkedAtMs + 1000, // one second after the check — now+window is much later
    })
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.declaration.validUntil).toBe(checkedAtMs + TAX_DECLARATION_MAX_VIES_AGE_MS)
    expect(result.declaration.validUntil).toBeLessThanOrEqual(checkedAtMs + TAX_DECLARATION_MAX_VIES_AGE_MS)
  })

  it('validUntil takes the LESSER bound: an old check caps it below now + window', () => {
    const checkedAtMs = Date.parse(BASE.vies_checked_at as string)
    const result = resolveTaxDeclaration({
      ...BASE,
      nowMs: checkedAtMs + TAX_DECLARATION_MAX_VIES_AGE_MS - 60_000, // one minute of freshness left
    })
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.declaration.validUntil).toBe(checkedAtMs + TAX_DECLARATION_MAX_VIES_AGE_MS)
    expect(result.declaration.validUntil).toBeLessThan(BASE.nowMs + TAX_DECLARATION_MAX_WINDOW_MS)
  })

  it('validUntil is an integer even on fractional millisecond inputs', () => {
    const result = resolveTaxDeclaration({ ...BASE, nowMs: BASE.nowMs + 0.5 })
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(Number.isInteger(result.declaration.validUntil)).toBe(true)
  })
})

describe('resolveTaxDeclaration — jurisdiction from country, never the VAT prefix', () => {
  it('a Greek VAT number (EL… prefix) with country GR declares GR', () => {
    const result = resolveTaxDeclaration({ ...BASE, country: 'GR', vat_number: 'EL123456789' })
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.declaration.jurisdiction).toBe('GR')
    expect(result.declaration.taxId).toBe('EL123456789')
  })

  it('a Northern Irish VAT number (XI… prefix) declares the saved country, not XI-derived', () => {
    const result = resolveTaxDeclaration({ ...BASE, country: 'GB', vat_number: 'XI123456789' })
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.declaration.jurisdiction).toBe('GB')
    expect(result.declaration.taxId).toBe('XI123456789')
  })

  it('the VAT prefix and country disagreeing never leaks into jurisdiction', () => {
    // An EU group registered for VAT in a member state that is not its seat
    // (the owner-company-details doc's own example): country says where the
    // buyer is established, the VAT prefix says where the number was issued.
    const result = resolveTaxDeclaration({ ...BASE, country: 'SE', vat_number: 'DE123456789' })
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.declaration.jurisdiction).toBe('SE')
    expect(result.declaration.taxId).toBe('DE123456789')
  })
})
