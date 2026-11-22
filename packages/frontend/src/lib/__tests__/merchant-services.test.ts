import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '@/lib/api'
import {
  classifyDepositAddressError,
  classifySalesActionError,
  isDepositAddressShape,
  ACCOUNT_CAP_REACHED,
  IDEMPOTENCY_KEY_REUSED,
  KEY_NOT_ON_SOURCE,
  MERCHANT_ACCOUNT_ADDRESS_UNAVAILABLE,
  MERCHANT_ACCOUNT_ALREADY_REGISTERED,
  MERCHANT_ACCOUNT_ON_OTHER_NETWORK,
  MERCHANT_SETUP_DETAILS_REQUIRED,
  SOURCE_ACCOUNT_NOT_FOUND,
  SOURCE_HAS_NO_PASSKEY,
  UNSUPPORTED_NETWORK,
  classifyTurnOnError,
  salesCardState,
  type MerchantServicesState,
} from '../merchant-services'

/** A refusal as `ApiRequestError` carries it: a status and a parsed body. */
function refusal(status: number, body: Record<string, unknown>) {
  return Object.assign(new Error(String(body.error ?? 'refused')), { status, body })
}

describe('classifyTurnOnError — the six refusals the dialog must name (#4904)', () => {
  it('maps no such account', () => {
    expect(classifyTurnOnError(refusal(404, { error_code: SOURCE_ACCOUNT_NOT_FOUND }))).toEqual({
      kind: 'source_not_found',
    })
  })

  it('maps no passkey on the existing account', () => {
    expect(classifyTurnOnError(refusal(422, { error_code: SOURCE_HAS_NO_PASSKEY }))).toEqual({
      kind: 'source_has_no_passkey',
    })
  })

  it('maps a passkey that is not on that account', () => {
    expect(classifyTurnOnError(refusal(422, { error_code: KEY_NOT_ON_SOURCE }))).toEqual({
      kind: 'key_not_on_source',
    })
  })

  it('maps the account limit, with the cap when the body carries it', () => {
    expect(classifyTurnOnError(refusal(422, { error_code: ACCOUNT_CAP_REACHED, cap: 10 }))).toEqual({
      kind: 'cap_reached',
      cap: 10,
    })
    expect(classifyTurnOnError(refusal(422, { error_code: ACCOUNT_CAP_REACHED }))).toEqual({
      kind: 'cap_reached',
      cap: null,
    })
  })

  it('maps an unsupported network, with the supported chains when named', () => {
    expect(
      classifyTurnOnError(refusal(400, { error_code: UNSUPPORTED_NETWORK, supported: [8453, 84532] })),
    ).toEqual({ kind: 'unsupported_network', supported: [8453, 84532] })
    expect(classifyTurnOnError(refusal(400, { error_code: UNSUPPORTED_NETWORK }))).toEqual({
      kind: 'unsupported_network',
      supported: [],
    })
  })

  it('maps a merchant account already on another network, with its chain', () => {
    expect(
      classifyTurnOnError(refusal(409, { error_code: MERCHANT_ACCOUNT_ON_OTHER_NETWORK, chain_id: 8453 })),
    ).toEqual({ kind: 'other_network', chainId: 8453 })
    expect(classifyTurnOnError(refusal(409, { error_code: MERCHANT_ACCOUNT_ON_OTHER_NETWORK }))).toEqual({
      kind: 'other_network',
      chainId: null,
    })
  })
})

describe('classifyTurnOnError — the rest of the route’s vocabulary', () => {
  it('maps the missing-fields refusal, naming what was missing', () => {
    expect(
      classifyTurnOnError(refusal(400, { error_code: MERCHANT_SETUP_DETAILS_REQUIRED, missing: ['key_id'] })),
    ).toEqual({ kind: 'setup_details_required', missing: ['key_id'] })
  })

  it('maps the two create-additional refusals the route names', () => {
    expect(classifyTurnOnError(refusal(502, { error_code: MERCHANT_ACCOUNT_ADDRESS_UNAVAILABLE }))).toEqual({
      kind: 'address_unavailable',
    })
    expect(classifyTurnOnError(refusal(409, { error_code: MERCHANT_ACCOUNT_ALREADY_REGISTERED }))).toEqual({
      kind: 'already_registered',
    })
  })

  it('maps a reused idempotency key to "the account already exists", not a retry', () => {
    expect(classifyTurnOnError(refusal(409, { error_code: IDEMPOTENCY_KEY_REUSED }))).toEqual({
      kind: 'already_registered',
    })
  })

  it('maps the money-path rate limit by status when no code is present', () => {
    expect(classifyTurnOnError(refusal(429, { error: 'Too many requests' }))).toEqual({ kind: 'rate_limited' })
  })

  it('passes a code-less 4xx sentence through as bounded detail', () => {
    const long = 'x'.repeat(400)
    const outcome = classifyTurnOnError(refusal(400, { error: long }))
    expect(outcome.kind).toBe('could_not_turn_on')
    if (outcome.kind === 'could_not_turn_on') {
      expect(outcome.detail).toHaveLength(200)
    }
  })

  it('treats no answer and a 5xx as an unknown outcome (a retry is safe)', () => {
    expect(classifyTurnOnError(new Error('network down'))).toEqual({ kind: 'unknown_outcome' })
    expect(classifyTurnOnError(refusal(503, { error: 'unavailable' }))).toEqual({ kind: 'unknown_outcome' })
  })

  it('never reads the sentence to decide: a code wins over a misleading status', () => {
    // A 500 carrying a code is still that code — the route names its refusals.
    expect(classifyTurnOnError(refusal(500, { error_code: SOURCE_HAS_NO_PASSKEY }))).toEqual({
      kind: 'source_has_no_passkey',
    })
  })
})

describe('salesCardState', () => {
  const off: MerchantServicesState = {
    enabled: false,
    enabled_at: null,
    disabled_at: null,
    merchant_account: null,
  }
  const account = {
    id: 'account-sales',
    account_address: '0x5555555555555555555555555555555555555555',
    chain_id: 8453,
    name: 'Sales',
    created_at: '2026-05-04T09:00:00.000Z',
  }

  it('is loading until the read answers', () => {
    expect(salesCardState('loading', null)).toBe('loading')
  })

  it('is error when the read failed, never a silent off', () => {
    expect(salesCardState('error', null)).toBe('error')
  })

  it('distinguishes never-on from off: only off has an account to keep', () => {
    expect(salesCardState('ready', off)).toBe('never_on')
    expect(salesCardState('ready', { ...off, merchant_account: account })).toBe('off')
  })

  it('is on when the setting is on', () => {
    expect(salesCardState('ready', { ...off, enabled: true, merchant_account: account })).toBe('on')
  })
})

describe('classifyDepositAddressError and isDepositAddressShape (#4954)', () => {
  const err = (status: number | undefined, body: Record<string, unknown> = {}) => ({ status, body })

  it.each([
    ['INVALID_DEPOSIT_ADDRESS', 400, 'invalid'],
    ['DEPOSIT_ADDRESS_IS_OWN', 409, 'own_address'],
    ['DEPOSIT_ADDRESS_ALREADY_REGISTERED', 409, 'already_registered'],
    ['DEPOSIT_ADDRESS_RETIRED', 409, 'already_retired'],
    ['DEPOSIT_ADDRESS_NOT_FOUND', 404, 'not_found'],
    ['MERCHANT_ACCOUNT_REQUIRED', 409, 'sales_off'],
  ])('maps %s by its code, whatever the sentence', (code, status, kind) => {
    expect(classifyDepositAddressError(err(status, { error_code: code, error: 'reworded' }))).toEqual({ kind })
  })

  it('a code-less 4xx is the route sentence, bounded; 429 is the rate limit', () => {
    expect(classifyDepositAddressError(err(422, { error: '  Not today.  ' }))).toEqual({ kind: 'refused', detail: 'Not today.' })
    expect(classifyDepositAddressError(err(422, { error: 'x'.repeat(500) }))).toEqual({ kind: 'refused', detail: 'x'.repeat(200) })
    expect(classifyDepositAddressError(err(422))).toEqual({ kind: 'refused', detail: null })
    expect(classifyDepositAddressError(err(429))).toEqual({ kind: 'rate_limited' })
  })

  it('no answer or a 5xx is an unknown outcome, never a refusal', () => {
    expect(classifyDepositAddressError(new Error('network'))).toEqual({ kind: 'unknown_outcome' })
    expect(classifyDepositAddressError(err(503, { error: 'down' }))).toEqual({ kind: 'unknown_outcome' })
  })

  it('accepts a 20-byte hex address, trimmed, in any case, and nothing else', () => {
    expect(isDepositAddressShape(' 0x3c9e5a1b7d2f4e60a8b1c3d5e7f9a0b2c4d6e8f0 ')).toBe(true)
    expect(isDepositAddressShape('0x3C9E5A1B7D2F4E60A8B1C3D5E7F9A0B2C4D6E8F0')).toBe(true)
    expect(isDepositAddressShape('3c9e5a1b7d2f4e60a8b1c3d5e7f9a0b2c4d6e8f0')).toBe(false)
    expect(isDepositAddressShape('0x3c9e5a1b7d2f4e60a8b1c3d5e7f9a0b2c4d6e8f')).toBe(false)
    expect(isDepositAddressShape('0x3c9e5a1b7d2f4e60a8b1c3d5e7f9a0b2c4d6e8fg')).toBe(false)
  })
})

describe('classifySalesActionError — a Sales action whose answer was lost (#5038)', () => {
  const err = (status: number | undefined, body: Record<string, unknown> = {}) => ({ status, body })

  it('no status or a 5xx is an unknown outcome: the action may have committed', () => {
    expect(classifySalesActionError(new TypeError('Failed to fetch'))).toEqual({ kind: 'unknown_outcome' })
    expect(classifySalesActionError(undefined)).toEqual({ kind: 'unknown_outcome' })
    expect(classifySalesActionError(err(500))).toEqual({ kind: 'unknown_outcome' })
    expect(classifySalesActionError(err(502, { error: 'unavailable' }))).toEqual({ kind: 'unknown_outcome' })
  })

  it('a 429 is the rate limit', () => {
    expect(classifySalesActionError(err(429))).toEqual({ kind: 'rate_limited' })
  })

  it('another 4xx is a refusal that did not commit, with the route sentence bounded', () => {
    expect(classifySalesActionError(err(409, { error: 'no account' }))).toEqual({
      kind: 'refused',
      status: 409,
      detail: 'no account',
    })
    expect(classifySalesActionError(err(422, { error: '  Not today.  ' }))).toEqual({
      kind: 'refused',
      status: 422,
      detail: 'Not today.',
    })
    expect(classifySalesActionError(err(422, { error: 'x'.repeat(500) }))).toEqual({
      kind: 'refused',
      status: 422,
      detail: 'x'.repeat(200),
    })
    expect(classifySalesActionError(err(400))).toEqual({ kind: 'refused', status: 400, detail: null })
  })

  it('falls back to the error message when the body carries no sentence', () => {
    expect(classifySalesActionError(new ApiRequestError('Turn merchant services on', 409))).toEqual({
      kind: 'refused',
      status: 409,
      detail: 'Turn merchant services on',
    })
  })
})
