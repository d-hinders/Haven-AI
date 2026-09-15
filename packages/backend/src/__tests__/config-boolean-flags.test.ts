import { describe, expect, it } from 'vitest'
import { parseBooleanFlag } from '../config.js'

/**
 * #3015: `HAVEN_HOSTED=TRUE` reached production and read as OFF. Every
 * boolean flag now goes through `parseBooleanFlag`, which accepts exactly the
 * two lowercase literals (plus unset/blank as "never configured") and refuses
 * the boot on anything else, naming the variable and the bytes.
 */
describe('parseBooleanFlag (#3015)', () => {
  it('unset, null, empty and whitespace-only read as false — "never configured"', () => {
    expect(parseBooleanFlag('X', undefined)).toBe(false)
    expect(parseBooleanFlag('X', null)).toBe(false)
    expect(parseBooleanFlag('X', '')).toBe(false)
    expect(parseBooleanFlag('X', '   ')).toBe(false)
  })

  it('accepts the two lowercase literals, trimmed', () => {
    expect(parseBooleanFlag('X', 'true')).toBe(true)
    expect(parseBooleanFlag('X', 'false')).toBe(false)
    expect(parseBooleanFlag('X', ' true ')).toBe(true)
    expect(parseBooleanFlag('X', ' false')).toBe(false)
  })

  it.each(['TRUE', 'True', '1', 'yes', 'on', 'FALSE', '0', 'no', 'off', 'enabled'])(
    'REFUSES %j rather than reading it as off — the prod HAVEN_HOSTED=TRUE incident',
    (raw) => {
      expect(() => parseBooleanFlag('HAVEN_HOSTED', raw)).toThrow(/HAVEN_HOSTED/)
    },
  )

  it('the refusal names the variable, the offending bytes (JSON-stringified so whitespace shows) and both literals', () => {
    let message = ''
    try {
      parseBooleanFlag('CATALOG_DISCOVERY_ENABLED', 'TRUE\t')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('CATALOG_DISCOVERY_ENABLED')
    expect(message).toContain('"TRUE\\t"')
    expect(message).toContain('"true"')
    expect(message).toContain('"false"')
  })
})
