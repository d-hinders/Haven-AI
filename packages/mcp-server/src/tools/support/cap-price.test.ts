import { describe, expect, it } from 'vitest'
import { AgentPaymentFailureCode, AgentPaymentNextAction } from '@haven_ai/sdk'

import { assertWithinMaxAmount } from './cap-price.js'
import { normalizeError } from './errors.js'

// #2975: both cap refusals used to throw plain HavenError, which normalizeError
// serialises WITHOUT next_action — the only two refusals in this module that
// broke the "every payment tool response carries next_action" promise. These
// tests pin the wire shape the agent actually reads.
describe('assertWithinMaxAmount wire shape (#2975)', () => {
  function refusal(fn: () => void) {
    try {
      fn()
    } catch (err) {
      return normalizeError(err)
    }
    throw new Error('expected a refusal')
  }

  it('PRICE_EXCEEDS_MAX carries stop_and_tell_user and retry_with_new_quote', () => {
    const payload = refusal(() => assertWithinMaxAmount('1500000', '1000000', 'USDC', '1 USDC'))
    expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
    expect(payload.statusCode).toBe(400)
    expect(payload.next_action).toBe(AgentPaymentNextAction.StopAndTellUser)
    expect(payload.retry_with_new_quote).toBe(true)
    expect(payload.message).toContain('1 USDC (= 1000000 atomic)')
  })

  it('INVALID_MAX_AMOUNT carries stop_and_tell_user', () => {
    const payload = refusal(() => assertWithinMaxAmount('1500000', '1.5', 'USDC'))
    expect(payload.code).toBe('INVALID_MAX_AMOUNT')
    expect(payload.statusCode).toBe(400)
    expect(payload.next_action).toBe(AgentPaymentNextAction.StopAndTellUser)
    expect(payload.retry_with_new_quote).toBeUndefined()
  })

  it('a cap at or above the authorized amount passes silently', () => {
    expect(() => assertWithinMaxAmount('1000000', '1000000', 'USDC')).not.toThrow()
    expect(() => assertWithinMaxAmount('1000000', undefined, 'USDC')).not.toThrow()
  })
})
