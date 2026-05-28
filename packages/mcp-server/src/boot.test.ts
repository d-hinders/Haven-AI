import { describe, it, expect } from 'vitest'
import { assertHostedEnv, CustodyError } from './boot.js'

describe('assertHostedEnv', () => {
  it('passes when no delegate key is in the environment', () => {
    expect(() => assertHostedEnv({})).not.toThrow()
  })

  it('refuses to boot when HAVEN_DELEGATE_KEY is set', () => {
    expect(() => assertHostedEnv({ HAVEN_DELEGATE_KEY: '0x' + 'a'.repeat(64) })).toThrow(
      CustodyError,
    )
  })

  it('ignores empty/whitespace values (treats as unset)', () => {
    expect(() => assertHostedEnv({ HAVEN_DELEGATE_KEY: '' })).not.toThrow()
    expect(() => assertHostedEnv({ HAVEN_DELEGATE_KEY: '   ' })).not.toThrow()
  })
})
