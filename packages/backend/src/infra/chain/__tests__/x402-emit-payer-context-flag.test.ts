import { describe, expect, it } from 'vitest'
import { readEmitPayerContext } from '../x402-binding-signer.js'

/**
 * #3021: the emit flip is parsed at boot through the #3015 parser. `1` is the
 * documented literal and stays on; `true`/`false` are accepted; unset/blank is
 * off; anything else refuses the boot naming the variable — it used to read
 * as OFF silently, a wire-format flip nobody could see.
 */
describe('readEmitPayerContext (#3021)', () => {
  it('unset / blank is off (never configured)', () => {
    expect(readEmitPayerContext(undefined)).toBe(false)
    expect(readEmitPayerContext(null)).toBe(false)
    expect(readEmitPayerContext('')).toBe(false)
    expect(readEmitPayerContext('  ')).toBe(false)
  })

  it('the documented literal "1" is on; "true"/"false" are accepted', () => {
    expect(readEmitPayerContext('1')).toBe(true)
    expect(readEmitPayerContext('true')).toBe(true)
    expect(readEmitPayerContext('false')).toBe(false)
  })

  it.each(['0', 'on', 'yes', 'TRUE', '1 ', 'enabled'])(
    'REFUSES %j naming the variable, instead of reading it as off',
    (raw) => {
      expect(() => readEmitPayerContext(raw)).toThrow(/X402_EMIT_PAYER_CONTEXT/)
    },
  )
})
