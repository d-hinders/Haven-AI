/**
 * #3609 — the typed, bounded 502 a delegation-rail prepare answers
 * (`prepare-failure.ts`) and the readable revert reason it names
 * (`revertReasonOf`, `refusal-ledger.ts`). Pure: no route, no DB.
 */
import { describe, expect, it } from 'vitest'
import { EstimateGasExecutionError } from 'viem'
import { FAILURE_MESSAGE_MAX_LENGTH } from '../agent-payment-status.js'
import {
  PREPARE_FAILED_ERROR_CODE,
  PREPARE_REVERTED_ERROR_CODE,
  boundedErrorDetails,
  prepareFailureBody,
} from '../prepare-failure.js'
import { REVERT_REASON_MAX_LENGTH, classifyRevertForLedger, revertReasonOf } from '../refusal-ledger.js'

const PERIOD_REASON = 'ERC20PeriodTransferEnforcer:transfer-amount-exceeded'
const PERIOD_HEX =
  '0x08c379a0' +
  '0000000000000000000000000000000000000000000000000000000000000020' +
  '0000000000000000000000000000000000000000000000000000000000000034' +
  '4552433230506572696f645472616e73666572456e666f726365723a7472616e736665722d616d6f756e742d65786365656465' +
  '6400000000000000000000000000'

/**
 * The live prod shape (2026-10-02, `tests` agent): the simulation revert
 * followed by viem's request dump — kilobytes of callData, a paymaster
 * signature and the bundler URL. Padded here to the measured ~6 KB.
 */
const LIVE_DUMP = new Error(
  'Execution reverted with reason: UserOperation reverted during simulation with reason: ' +
    PERIOD_HEX +
    '.\n\nRequest Arguments:\n  callData: 0x5c1c6dcd' +
    'ab'.repeat(2800) +
    '\n  paymasterData: 0x01' +
    'cd'.repeat(80) +
    '\n  url: https://api.pimlico.io/v2/84532/rpc?apikey=pim_SECRETKEY123\n\nVersion: viem@2.54.1',
)

describe('prepareFailureBody (#3609)', () => {
  it('a simulation revert is prepare_reverted: classified, the reason decoded, details bounded', () => {
    const reason = classifyRevertForLedger(LIVE_DUMP)
    expect(reason).toBe('delegation_budget_exceeded')
    const body = prepareFailureBody(LIVE_DUMP, reason, 'infra text')
    expect(body).toMatchObject({
      error_code: PREPARE_REVERTED_ERROR_CODE,
      refusal_reason: 'delegation_budget_exceeded',
      revert_reason: PERIOD_REASON,
    })
    expect(body.error).not.toBe('infra text')
    expect(body.message).toContain(PERIOD_REASON)
    expect(body.message).toMatch(/retrying the same payment reverts again/)
    // The bound: never the ~6 KB dump, never the callData tail.
    expect(body.details!.length).toBeLessThanOrEqual(FAILURE_MESSAGE_MAX_LENGTH + 1)
    expect(body.details).not.toContain('paymasterData')
    expect(JSON.stringify(body).length).toBeLessThan(1500)
  })

  it('not a revert is prepare_failed: the route\'s own error text, no reason fields, details bounded', () => {
    const err = new Error('fetch failed: bundler unreachable (ETIMEDOUT) ' + 'x'.repeat(1000))
    expect(classifyRevertForLedger(err)).toBeNull()
    const body = prepareFailureBody(err, null, 'Delegation-rail authorization failed (bundler or RPC)')
    expect(body).toEqual({
      error: 'Delegation-rail authorization failed (bundler or RPC)',
      error_code: PREPARE_FAILED_ERROR_CODE,
      details: expect.any(String),
    })
    expect(body.details!.length).toBeLessThanOrEqual(FAILURE_MESSAGE_MAX_LENGTH + 1)
    expect(body.details!.endsWith('…')).toBe(true)
  })

  it('redacts vendor credentials BEFORE bounding, so a key inside the kept prefix never survives', () => {
    const err = new Error('POST https://api.pimlico.io/v2/84532/rpc?apikey=pim_SECRETKEY123 failed: timeout')
    const details = boundedErrorDetails(err)
    expect(details).not.toContain('pim_SECRETKEY123')
    expect(details).toContain('timeout')
  })

  it('redacts BEFORE bounding: a key-in-path cut at the bound would otherwise leak its prefix', () => {
    // `redactVendorSecrets` only recognises a path key of 16+ characters. Cut
    // first, a 32-character key straddling the 300-character bound keeps ~12
    // characters — too short to be recognised, so they would ride the
    // response verbatim. Redacted first, the whole key is gone before the cut.
    const key = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
    const prefix = 'x'.repeat(FAILURE_MESSAGE_MAX_LENGTH - 'https://api.pimlico.io/v2/'.length - 12)
    const details = boundedErrorDetails(new Error(`${prefix}https://api.pimlico.io/v2/${key}/rpc failed`))
    expect(details).not.toContain('ABCDEFGHIJ')
  })

  it('a revert with no nameable reason is still prepare_reverted, with revert_reason null', () => {
    const err = new EstimateGasExecutionError(new Error('execution reverted') as never, {} as never)
    const body = prepareFailureBody(err, classifyRevertForLedger(err), 'infra')
    expect(body.error_code).toBe(PREPARE_REVERTED_ERROR_CODE)
    expect(body.refusal_reason).toBe('onchain_revert')
    expect(body.revert_reason).toBeNull()
    expect(body.message).not.toMatch(/\(\)/)
  })
})

describe('revertReasonOf (#3609)', () => {
  it('decodes a hex Error(string) first', () => {
    expect(revertReasonOf(LIVE_DUMP)).toBe(PERIOD_REASON)
    expect(revertReasonOf(new Error('outer', { cause: LIVE_DUMP }))).toBe(PERIOD_REASON)
  })

  it('falls back to a plain-text enforcer error, then an ERC-4337 AA code', () => {
    expect(revertReasonOf(new Error('reverted: TimestampEnforcer:expired-delegation'))).toBe(
      'TimestampEnforcer:expired-delegation',
    )
    expect(revertReasonOf(new Error('UserOperation reverted: AA21 didn\'t pay prefund'))).toBe(
      "AA21 didn't pay prefund",
    )
  })

  it('answers null when nothing is nameable', () => {
    expect(revertReasonOf(new Error('execution reverted'))).toBeNull()
    expect(revertReasonOf(null)).toBeNull()
  })

  it('strips non-printable characters and bounds the length — it is chain text', () => {
    const reason = `Evil\u0000Enforcer\u001b[31m${'z'.repeat(400)}`
    const hex =
      '08c379a0' +
      (32).toString(16).padStart(64, '0') +
      Buffer.byteLength(reason).toString(16).padStart(64, '0') +
      Buffer.from(reason, 'utf8').toString('hex').padEnd(Math.ceil(Buffer.byteLength(reason) / 32) * 64, '0')
    const got = revertReasonOf(new Error(`reason: 0x${hex}`))!
    expect(got).not.toMatch(/[^\x20-\x7e…]/)
    expect(got.length).toBeLessThanOrEqual(REVERT_REASON_MAX_LENGTH + 1)
    expect(got.startsWith('EvilEnforcer[31m')).toBe(true)
  })
})
