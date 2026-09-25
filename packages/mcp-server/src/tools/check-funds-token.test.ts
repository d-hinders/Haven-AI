/**
 * #3213 — haven_check_funds accepts the token SYMBOL every other hosted read
 * hands the agent, and its refusals name the remedy that works.
 *
 * Characterization of the three live calls the 2026-09-21 quality scan
 * recorded (report §3 D1): `{}` → the schema names `token`; `{ token }`
 * alone → the no-cap refusal names the CHECK, never a paid merchant call;
 * `{ token: "USDC", max_amount_human }` → resolved through the agent's own
 * allowance for USDC (one backend read, then the coverage read with the
 * ADDRESS), so the answer carries the same `token` string the agent sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  AGENT_ALLOWANCES_RESPONSE,
  clearCalls,
  fail,
  handlers,
  installSharedFixtureLifecycle,
  ok,
  recordedCalls,
  stubFetch,
} from '../test-support/hosted-mcp.js'

installSharedFixtureLifecycle()
beforeEach(() => clearCalls())
afterEach(() => vi.unstubAllGlobals())

const USDC = AGENT_ALLOWANCES_RESPONSE.allowances[0].token_address
const COVERAGE = {
  covered: true,
  chain_id: 8453,
  token_address: USDC,
  token_symbol: 'USDC',
  checked_amount_atomic: '1000',
  budget_remaining_atomic: '7500',
}

function coverageRoutes(allowances: unknown = AGENT_ALLOWANCES_RESPONSE) {
  stubFetch({
    'GET /machine-payments/allowances': { status: 200, body: allowances },
    'GET /machine-payments/balance-coverage': { status: 200, body: COVERAGE },
  })
}

describe('haven_check_funds: the token argument (#3213)', () => {
  it('no arguments → the schema refusal names token (unchanged)', async () => {
    coverageRoutes()
    const result = fail(await handlers().haven_check_funds({}))
    expect(result.code).toBe('INVALID_INPUT')
    expect(result.message).toContain('token')
    expect(recordedCalls()).toEqual([])
  })

  it('token alone → the no-cap refusal names the check, never a paid merchant call', async () => {
    coverageRoutes()
    const result = fail(await handlers().haven_check_funds({ token: 'USDC' }))
    expect(result.code).toBe('INVALID_INPUT')
    expect(result.message).toContain('sufficiency check')
    expect(result.message).toContain('max_amount_human')
    expect(result.message).not.toMatch(/paid merchant call|merchant was contacted/i)
    expect(result.next_action).toBe('stop_and_tell_user')
    expect(recordedCalls()).toEqual([])
  })

  it('a symbol resolves through the agent\'s own allowance and the coverage read gets the ADDRESS', async () => {
    coverageRoutes()
    const result = ok<{ token: string; token_address: string; covered: boolean; checked_amount: string }>(
      await handlers().haven_check_funds({ token: 'usdc', max_amount_human: '0.001' }),
    )
    expect(result.data.covered).toBe(true)
    expect(result.data.token).toBe('USDC')
    expect(result.data.token_address).toBe(USDC)
    expect(result.data.checked_amount).toBe('0.001')
    const calls = recordedCalls().map((c) => new URL(c.url))
    expect(calls.map((u) => u.pathname)).toEqual([
      '/machine-payments/allowances',
      '/machine-payments/balance-coverage',
    ])
    expect(calls[1].searchParams.get('token')).toBe(USDC)
    expect(calls[1].searchParams.get('amount_atomic')).toBe('1000')
  })

  it('an address skips the allowance read entirely (the #3126 path is unchanged)', async () => {
    coverageRoutes()
    ok(await handlers().haven_check_funds({ token: USDC, max_amount_human: '0.001' }))
    expect(recordedCalls().map((c) => new URL(c.url).pathname)).toEqual(['/machine-payments/balance-coverage'])
  })

  it('a symbol no allowance carries → refused with the ADDRESS as the remedy, never atomic units', async () => {
    coverageRoutes()
    const result = fail(await handlers().haven_check_funds({ token: 'DAI', max_amount_human: '1' }))
    expect(result.code).toBe('INVALID_INPUT')
    expect(result.message).toContain('"DAI" is not the symbol of any allowance')
    expect(result.message).toContain(`USDC (${USDC})`)
    expect(result.message).toContain('0x contract address')
    expect(result.message).not.toContain('atomic units')
    expect(result.next_action).toBe('retry_with_explicit_context')
    expect(result.next_tool_name).toBe('haven_get_allowances')
    expect(recordedCalls().map((c) => new URL(c.url).pathname)).toEqual(['/machine-payments/allowances'])
  })

  it('a symbol two allowances carry → refused naming both addresses', async () => {
    const twice = {
      ...AGENT_ALLOWANCES_RESPONSE,
      allowances: [
        AGENT_ALLOWANCES_RESPONSE.allowances[0],
        { ...AGENT_ALLOWANCES_RESPONSE.allowances[0], id: 'allowance-2', token_address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' },
      ],
    }
    coverageRoutes(twice)
    const result = fail(await handlers().haven_check_funds({ token: 'USDC', max_amount_human: '1' }))
    expect(result.code).toBe('INVALID_INPUT')
    expect(result.message).toContain('names 2 allowances')
    expect(result.message).toContain('0x036cbd53842c5426634e7929541ec2318f3dcf7e')
    expect(result.next_tool_name).toBe('haven_get_allowances')
    expect(recordedCalls().map((c) => new URL(c.url).pathname)).toEqual(['/machine-payments/allowances'])
  })

  it('an ADDRESS the registry cannot convert keeps the atomic-units remedy (that is the case it is for)', async () => {
    coverageRoutes()
    const unknown = '0x' + '9'.repeat(40)
    const result = fail(await handlers().haven_check_funds({ token: unknown, max_amount_human: '1' }))
    expect(result.code).toBe('MAX_AMOUNT_UNCONVERTIBLE')
    expect(result.message).toContain(unknown)
    expect(result.message).toContain('atomic units')
    expect(recordedCalls()).toEqual([])
  })
})
