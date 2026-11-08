import { beforeEach, describe, expect, it } from 'vitest'
import {
  FIRST_AGENT_PAYMENT_JUST_NOW_MS,
  FIRST_AGENT_PAYMENT_PEAK_MAX_AGE_MS,
  firstAgentPaymentAmount,
  firstAgentPaymentWhen,
  hasPlayedFirstAgentPaymentPeak,
  markFirstAgentPaymentPeakPlayed,
  shouldPlayFirstAgentPaymentPeak,
} from '@/lib/first-agent-payment'

/**
 * #4707: the card's three rules.
 *
 * 1. The amount never reads `$0.00` for a sub-cent payment (rule 3) — it falls
 *    back to the token amount, which is the fact the row carries.
 * 2. "just now" comes from the row's own time; an older row says its date.
 * 3. Peak is once per device, never past seven days, and never after the
 *    marker is set.
 */

const PAYMENT = {
  amountHuman: '0.05',
  tokenSymbol: 'USDC',
  usdValue: 0.05,
  eurValue: 0.046,
  sekValue: 0.54,
}

describe('firstAgentPaymentAmount (#4707)', () => {
  it('renders the booked fiat in the viewer currency', () => {
    expect(firstAgentPaymentAmount(PAYMENT, 'USD')).toBe('$0.05')
    expect(firstAgentPaymentAmount(PAYMENT, 'EUR')).toBe('0,05\u00a0€')
    expect(firstAgentPaymentAmount(PAYMENT, 'SEK')).toBe('0,54\u00a0kr')
  })

  it('never reads $0.00 for a sub-cent payment — it uses the token amount', () => {
    const subCent = { ...PAYMENT, amountHuman: '0.001', usdValue: 0.001, eurValue: 0.0009, sekValue: 0.001 }
    expect(firstAgentPaymentAmount(subCent, 'USD')).toBe('0.001 USDC')
    expect(firstAgentPaymentAmount(subCent, 'EUR')).toBe('0.001 USDC')
    expect(firstAgentPaymentAmount(subCent, 'SEK')).toBe('0.001 USDC')
  })

  it('falls back to the token amount when the row was never priced', () => {
    const unpriced = { ...PAYMENT, usdValue: null, eurValue: null, sekValue: null }
    expect(firstAgentPaymentAmount(unpriced, 'USD')).toBe('0.05 USDC')
  })

  it('falls back to the token amount when the viewer currency was not booked', () => {
    const usdOnly = { ...PAYMENT, eurValue: null, sekValue: null }
    expect(firstAgentPaymentAmount(usdOnly, 'EUR')).toBe('0.05 USDC')
    expect(firstAgentPaymentAmount(usdOnly, 'USD')).toBe('$0.05')
  })
})

describe('firstAgentPaymentWhen (#4707)', () => {
  const now = Date.parse('2026-11-08T12:00:00.000Z')

  it('says "just now" for a recent payment', () => {
    expect(firstAgentPaymentWhen('2026-11-08T11:59:00.000Z', now)).toBe('just now')
  })

  it('says the date for a payment older than the window', () => {
    const older = new Date(now - FIRST_AGENT_PAYMENT_JUST_NOW_MS - 60_000).toISOString()
    expect(firstAgentPaymentWhen(older, now)).toBe('8 November 2026')
  })

  it('says nothing for an unparseable instant', () => {
    expect(firstAgentPaymentWhen('not-a-date', now)).toBe('')
  })
})

describe('first agent payment Peak (#4707)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  const now = Date.parse('2026-11-08T12:00:00.000Z')

  it('plays once per device, then never again', () => {
    const confirmedAt = new Date(now - 60_000).toISOString()
    expect(shouldPlayFirstAgentPaymentPeak({ userId: 'user-1', confirmedAt, now })).toBe(true)
    markFirstAgentPaymentPeakPlayed('user-1')
    expect(hasPlayedFirstAgentPaymentPeak('user-1')).toBe(true)
    expect(shouldPlayFirstAgentPaymentPeak({ userId: 'user-1', confirmedAt, now })).toBe(false)
  })

  it('is per user — another user on the same device still gets theirs', () => {
    markFirstAgentPaymentPeakPlayed('user-1')
    const confirmedAt = new Date(now - 60_000).toISOString()
    expect(shouldPlayFirstAgentPaymentPeak({ userId: 'user-2', confirmedAt, now })).toBe(true)
  })

  it('does not play for a payment more than seven days old (owner decision 1)', () => {
    const justInside = new Date(now - FIRST_AGENT_PAYMENT_PEAK_MAX_AGE_MS).toISOString()
    const justOutside = new Date(now - FIRST_AGENT_PAYMENT_PEAK_MAX_AGE_MS - 1).toISOString()
    expect(shouldPlayFirstAgentPaymentPeak({ userId: 'user-1', confirmedAt: justInside, now })).toBe(true)
    expect(shouldPlayFirstAgentPaymentPeak({ userId: 'user-1', confirmedAt: justOutside, now })).toBe(false)
  })

  it('does not play for an unparseable instant', () => {
    expect(shouldPlayFirstAgentPaymentPeak({ userId: 'user-1', confirmedAt: 'nope', now })).toBe(false)
  })
})
