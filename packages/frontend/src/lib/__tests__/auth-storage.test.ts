import { describe, expect, it } from 'vitest'
import {
  ACTIVE_ACCOUNT_STORAGE_KEY,
  AUTH_TOKEN_STORAGE_KEY,
  LEGACY_ACTIVE_SAFE_STORAGE_KEY,
  migrateActiveAccountStorageKey,
} from '../auth-storage'

/**
 * The one-time storage-key migration (#2913). The active-account selection
 * moved from `haven_active_safe_id` to `haven_active_account_id`; localStorage
 * does not rename keys, so the migration reads the old key, writes the new one
 * and removes the old — otherwise every returning user silently loses their
 * selected account on deploy. The legacy read (this module's only
 * `haven_active_safe_id` reference) is removed at #2914 together with the
 * migration.
 */
describe('migrateActiveAccountStorageKey (#2913)', () => {
  it('migrates the legacy key: new written, old removed, selection preserved', () => {
    localStorage.setItem(LEGACY_ACTIVE_SAFE_STORAGE_KEY, 'acc-1')

    migrateActiveAccountStorageKey(['acc-1', 'acc-2'])

    expect(localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY)).toBe('acc-1')
    expect(localStorage.getItem(LEGACY_ACTIVE_SAFE_STORAGE_KEY)).toBeNull()
  })

  it('does nothing when the new key is already authoritative', () => {
    localStorage.setItem(ACTIVE_ACCOUNT_STORAGE_KEY, 'acc-2')
    localStorage.setItem(LEGACY_ACTIVE_SAFE_STORAGE_KEY, 'acc-1')

    migrateActiveAccountStorageKey(['acc-1', 'acc-2'])

    expect(localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY)).toBe('acc-2')
    // Idempotent cleanup: the leftover legacy key is dropped either way.
    expect(localStorage.getItem(LEGACY_ACTIVE_SAFE_STORAGE_KEY)).toBeNull()
  })

  it('ignores a stale legacy pointer that matches no account', () => {
    localStorage.setItem(LEGACY_ACTIVE_SAFE_STORAGE_KEY, 'acc-deleted')

    migrateActiveAccountStorageKey(['acc-1', 'acc-2'])

    expect(localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(LEGACY_ACTIVE_SAFE_STORAGE_KEY)).toBeNull()
  })

  it('leaves storage untouched when there is no legacy key', () => {
    localStorage.setItem(ACTIVE_ACCOUNT_STORAGE_KEY, 'acc-1')

    migrateActiveAccountStorageKey(['acc-1'])

    expect(localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY)).toBe('acc-1')
    expect(localStorage.getItem(LEGACY_ACTIVE_SAFE_STORAGE_KEY)).toBeNull()
  })
})

// Both key constants must stay exported names the rest of the app imports —
// AUTH_TOKEN_STORAGE_KEY predates this migration and is seeded by the capture
// harness (SEED_STORAGE_KEYS).
describe('storage key names (#2913)', () => {
  it('uses the renamed key with the legacy name retained only for the migration', () => {
    expect(ACTIVE_ACCOUNT_STORAGE_KEY).toBe('haven_active_account_id')
    expect(LEGACY_ACTIVE_SAFE_STORAGE_KEY).toBe('haven_active_safe_id')
    expect(AUTH_TOKEN_STORAGE_KEY).toBe('haven_token')
  })
})
