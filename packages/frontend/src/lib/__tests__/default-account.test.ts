import { describe, expect, it } from 'vitest'
import { resolveDefaultAccount } from '../default-account'
import type { SmartAccount } from '@/context/AuthContext'

function account(id: string, isDefault: boolean): SmartAccount {
  return {
    id,
    account_address: `0x${id.padEnd(40, '0')}`,
    chain_id: 8453,
    name: id,
    is_default: isDefault,
  } as SmartAccount
}

describe('resolveDefaultAccount (#3719)', () => {
  it('picks the is_default account even when it is not first', () => {
    const accounts = [account('first', false), account('the-default', true)]
    expect(resolveDefaultAccount(accounts)?.id).toBe('the-default')
  })

  it('falls back to the first account when none is flagged default', () => {
    expect(resolveDefaultAccount([account('a', false), account('b', false)])?.id).toBe('a')
  })

  it('is null with no accounts', () => {
    expect(resolveDefaultAccount([])).toBeNull()
    expect(resolveDefaultAccount(undefined)).toBeNull()
    expect(resolveDefaultAccount(null)).toBeNull()
  })
})
