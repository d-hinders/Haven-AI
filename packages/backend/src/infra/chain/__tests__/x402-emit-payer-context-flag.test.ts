import { afterEach, describe, expect, it, vi } from 'vitest'
import { readEmitPayerContext } from '../x402-binding-signer.js'

const silent = { warn: () => {}, info: () => {} }

/**
 * #3021: the emit flip is parsed at boot through the #3015 parser. `1` is the
 * documented literal and stays on; `true`/`false` are accepted; unset/blank is
 * off; anything else refuses the boot naming the variable — it used to read
 * as OFF silently, a wire-format flip nobody could see.
 */
describe('readEmitPayerContext (#3021)', () => {
  it('unset / blank is off (never configured)', () => {
    expect(readEmitPayerContext(undefined, silent)).toBe(false)
    expect(readEmitPayerContext(null, silent)).toBe(false)
    expect(readEmitPayerContext('', silent)).toBe(false)
    expect(readEmitPayerContext('  ', silent)).toBe(false)
  })

  it('the documented literal "1" is on (trimmed, warned once); "true"/"false" are accepted', () => {
    const warn = vi.fn()
    expect(readEmitPayerContext('1', { warn, info: () => {} })).toBe(true)
    expect(readEmitPayerContext(' 1 ', { warn, info: () => {} })).toBe(true)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0][0])).toMatch(/compatibility spelling/)
    expect(readEmitPayerContext('true', silent)).toBe(true)
    expect(readEmitPayerContext('false', silent)).toBe(false)
  })

  it.each(['0', 'on', 'yes', 'TRUE', 'enabled'])(
    'REFUSES %j naming the variable AND the accepted set including "1", instead of reading it as off',
    (raw) => {
      expect(() => readEmitPayerContext(raw, silent)).toThrow(/X402_EMIT_PAYER_CONTEXT[\s\S]*"1"/)
    },
  )
})

// #3023 review: the parser alone does not prove the flag is WIRED to the two
// emit gates — inverting both gates left every test green. Load the module
// fresh per value and assert what the helpers actually emit.
describe('the parsed flag gates both emit helpers (#3021)', () => {
  const agent = { id: 'agent-1', delegate_address: '0xABCDEF0000000000000000000000000000000001' }

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.restoreAllMocks()
  })

  async function load(value: string | undefined) {
    vi.resetModules()
    if (value === undefined) vi.stubEnv('X402_EMIT_PAYER_CONTEXT', '')
    else vi.stubEnv('X402_EMIT_PAYER_CONTEXT', value)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    return import('../x402-binding-signer.js')
  }

  it.each(['1', 'true'])('%j → both helpers emit the payer identity', async (value) => {
    const mod = await load(value)
    expect(mod.x402PayerContextFields(agent)).toEqual({
      payerDelegate: agent.delegate_address.toLowerCase(),
      payerAgentId: agent.id,
    })
    expect(mod.x402PayerWireFields(agent)).toEqual({
      payer_delegate: agent.delegate_address.toLowerCase(),
      payer_agent_id: agent.id,
    })
  })

  it.each([undefined, 'false'])('%j → both helpers emit nothing (the pre-#1690 v2 wire)', async (value) => {
    const mod = await load(value)
    expect(mod.x402PayerContextFields(agent)).toEqual({})
    expect(mod.x402PayerWireFields(agent)).toEqual({})
  })

  it('"true" logs the on-state at boot; unset logs nothing', async () => {
    await load('true')
    expect(console.info).toHaveBeenCalledWith(expect.stringMatching(/X402_EMIT_PAYER_CONTEXT is on/))
    vi.restoreAllMocks()
    await load(undefined)
    expect(console.info).not.toHaveBeenCalled()
  })
})
