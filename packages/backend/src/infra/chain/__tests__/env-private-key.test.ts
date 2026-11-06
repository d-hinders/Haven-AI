import { describe, expect, it } from 'vitest'
import { stdSerializers } from 'pino'
import { parseEnvPrivateKey } from '../env-private-key.js'

/**
 * #4654: the helper that stands between an env private key and a signer
 * constructor. Its whole job is to refuse a malformed value WITHOUT carrying
 * any part of it into the error, because that error reaches the logs
 * (`infra/relayer-balance-monitor.ts` logs `err.message`;
 * `infra/http-error-handler.ts` logs the whole error, whose pino `err`
 * serializer emits both `message` and the enumerable `value` ethers sets).
 *
 * The sentinel is a 64-hex string, so every malformed form below is a real
 * ethers-echoing input: a quoted value, a `NAME=`-prefixed value, and a value
 * with an internal non-hex character. `MARKER` is the sentinel's first 16
 * characters — the fragment that survives in all three forms, including the one
 * where the non-hex character splits the sentinel in half.
 */
const SENTINEL = 'deadbeef'.repeat(8)
const MARKER = SENTINEL.slice(0, 16)

const ECHOING_FORMS: Array<[string, string]> = [
  ['a quoted value', `"0x${SENTINEL}"`],
  ['a NAME=-prefixed value', `RELAYER_PRIVATE_KEY=0x${SENTINEL}`],
  ['a value with an internal non-hex character', `0x${SENTINEL.slice(0, 32)}zz${SENTINEL.slice(32)}`],
]

/** pino's `err` serializer, not `JSON.stringify` — which returns `{}` for an Error. */
function serialized(err: unknown): string {
  return JSON.stringify(stdSerializers.err(err as Error))
}

describe('parseEnvPrivateKey (#4654)', () => {
  it('accepts a 0x-prefixed 64-hex key unchanged', () => {
    expect(parseEnvPrivateKey('X', `0x${SENTINEL}`)).toBe(`0x${SENTINEL}`)
  })

  it('accepts a key without 0x and returns it 0x-prefixed — a deployed key keeps working', () => {
    expect(parseEnvPrivateKey('X', SENTINEL)).toBe(`0x${SENTINEL}`)
  })

  it('preserves hex casing', () => {
    const mixed = 'AbCdEf0123456789'.repeat(4)
    expect(parseEnvPrivateKey('X', `0x${mixed}`)).toBe(`0x${mixed}`)
  })

  it('trims leading and trailing whitespace, including a newline', () => {
    expect(parseEnvPrivateKey('X', `  \n0x${SENTINEL}\t `)).toBe(`0x${SENTINEL}`)
  })

  it.each(ECHOING_FORMS)('refuses %s, naming the variable and carrying no part of the value', (_label, raw) => {
    let caught: unknown
    try {
      parseEnvPrivateKey('RELAYER_PRIVATE_KEY_8453', raw)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    const err = caught as Error
    expect(err.message).toContain('RELAYER_PRIVATE_KEY_8453')
    expect(serialized(err)).not.toContain(MARKER)
    expect(err.cause).toBeUndefined()
    expect((err as Error & { value?: unknown }).value).toBeUndefined()
  })

  it.each([
    ['an empty value', ''],
    ['a whitespace-only value', '   \n\t '],
    ['a 63-hex value', `0x${SENTINEL.slice(0, 63)}`],
    ['a 65-hex value', `0x${SENTINEL}0`],
    ['an uppercase 0X prefix', `0X${SENTINEL}`],
    ['an undefined value', undefined],
    ['a null value', null],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseEnvPrivateKey('SOME_KEY', raw as string | undefined | null)).toThrow(/SOME_KEY/)
  })

  it('refuses quotes rather than stripping them — a quoted value is a paste accident', () => {
    expect(() => parseEnvPrivateKey('X', `"${SENTINEL}"`)).toThrow(/not a valid private key/)
    expect(() => parseEnvPrivateKey('X', `'0x${SENTINEL}'`)).toThrow(/not a valid private key/)
  })
})
