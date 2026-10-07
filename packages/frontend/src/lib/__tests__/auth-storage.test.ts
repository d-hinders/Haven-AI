import { describe, expect, it } from 'vitest'
import { LEGACY_ACTIVE_ACCOUNT_STORAGE_KEY, AUTH_TOKEN_STORAGE_KEY } from '../auth-storage'

/**
 * The active-account key is legacy since #3719 retired the global active
 * account: nothing writes or reads it, and logout removes it so a value an
 * earlier build left behind is cleaned up. Its name must stay what earlier
 * builds wrote, or that cleanup would miss it.
 */
describe('storage key names', () => {
  it('exports the stable key names the rest of the app imports', () => {
    expect(LEGACY_ACTIVE_ACCOUNT_STORAGE_KEY).toBe('haven_active_account_id')
    expect(AUTH_TOKEN_STORAGE_KEY).toBe('haven_token')
  })
})
