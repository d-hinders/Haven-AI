/**
 * #3263 — the classifier that decides whether an outbound send may ever
 * succeed unchanged. Built from real ethers v6 errors, not hand-rolled shapes.
 */
import { makeError } from 'ethers'
import { describe, expect, it } from 'vitest'
import { describeRevert, isDeterministicRevert } from '../deterministic-revert.js'

const callException = (data: string | null) =>
  makeError('execution reverted', 'CALL_EXCEPTION', {
    action: 'estimateGas', data, reason: null, transaction: { to: null, data: '0x' }, invocation: null, revert: null,
  })

describe('isDeterministicRevert (#3263)', () => {
  it('a CALL_EXCEPTION carrying revert data is deterministic', () => {
    expect(isDeterministicRevert(callException('0xc5723b51'))).toBe(true)
    expect(isDeterministicRevert(callException('0x08c379a0' + '00'.repeat(64)))).toBe(true)
  })

  it('a CALL_EXCEPTION with no or empty revert data is NOT — some providers produce that for their own failures', () => {
    expect(isDeterministicRevert(callException(null))).toBe(false)
    expect(isDeterministicRevert(callException('0x'))).toBe(false)
    // Under four bytes is not a selector — the {8,} bound decides here.
    expect(isDeterministicRevert(callException('0x12'))).toBe(false)
    expect(isDeterministicRevert(callException('0x123456'))).toBe(false)
    expect(isDeterministicRevert(callException('0x12345678'))).toBe(true)
  })

  it('transport failures are never deterministic', () => {
    expect(isDeterministicRevert(makeError('could not coalesce error', 'UNKNOWN_ERROR', { error: { code: 30 } }))).toBe(false)
    expect(isDeterministicRevert(makeError('timeout', 'TIMEOUT', { operation: 'send', reason: 'timeout' }))).toBe(false)
    expect(isDeterministicRevert(makeError('server response 500', 'SERVER_ERROR', { request: {} as never }))).toBe(false)
    expect(isDeterministicRevert(new Error('nonce too low'))).toBe(false)
    expect(isDeterministicRevert(null)).toBe(false)
    expect(isDeterministicRevert('CALL_EXCEPTION')).toBe(false)
  })

  it('describeRevert names the action and the 4-byte selector, never the full revert data', () => {
    const long = callException('0x08c379a0' + 'ab'.repeat(64))
    expect(describeRevert(long)).toBe('reverted in estimateGas (revert data 0x08c379a0)')
    expect(describeRevert({})).toBe('reverted in call (revert data unknown)')
  })
})
