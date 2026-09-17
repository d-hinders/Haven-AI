import { describe, expect, it } from 'vitest'
import { ACTIVE_ACCOUNT_STORAGE_KEY, AUTH_TOKEN_STORAGE_KEY } from '../auth-storage'

/**
 * The one-time storage-key migration (#2913) that carried a returning user's
 * active-account selection off the pre-rename legacy key is removed at
 * #2914: the compatibility window it existed for has closed. A user still
 * holding the stale key loses their remembered account SELECTION (not their
 * account, not their funds) and falls back to the default account on next
 * load.
 */
describe('storage key names', () => {
  it('exports the stable key names the rest of the app imports', () => {
    expect(ACTIVE_ACCOUNT_STORAGE_KEY).toBe('haven_active_account_id')
    expect(AUTH_TOKEN_STORAGE_KEY).toBe('haven_token')
  })
})
