export const AUTH_TOKEN_STORAGE_KEY = 'haven_token'
export const ACTIVE_ACCOUNT_STORAGE_KEY = 'haven_active_account_id'

/**
 * The pre-#2913 key the active-account selection was stored under. Read only
 * by the one-time migration below; removed at #2914 together with the
 * migration itself.
 */
export const LEGACY_ACTIVE_SAFE_STORAGE_KEY = 'haven_active_safe_id'

/**
 * One-time migration of the active-account selection (#2913).
 *
 * The storage key was renamed from `haven_active_safe_id` to
 * `haven_active_account_id`. localStorage does not rename keys by itself, so
 * without this step every returning user would silently lose their selected
 * account on deploy and fall back to the default account.
 *
 * Runs on every boot and is idempotent: it does something only while the new
 * key is absent and the legacy key is present. Selection is validated against
 * the provided account list, so a stored id that no longer matches any
 * account is neither migrated nor kept — the caller falls back to the
 * default account exactly as it would with no stored selection. The legacy
 * key is removed after a successful write so the migration retires itself;
 * the legacy read (this function) is the last `haven_active_safe_id`
 * reference in the frontend and goes away at #2914.
 */
export function migrateActiveAccountStorageKey(
  accountIds: ReadonlyArray<string>,
): void {
  if (typeof window === 'undefined') return
  if (window.localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY) !== null) {
    // New key already authoritative — drop the legacy leftover if any, then
    // stop. Removal is a no-op when nothing is there.
    window.localStorage.removeItem(LEGACY_ACTIVE_SAFE_STORAGE_KEY)
    return
  }

  const legacyValue = window.localStorage.getItem(LEGACY_ACTIVE_SAFE_STORAGE_KEY)
  if (legacyValue === null) return

  if (!accountIds.includes(legacyValue)) {
    // Stale pointer (account removed since the last visit): clear the legacy
    // key but do not carry the dead value into the new one.
    window.localStorage.removeItem(LEGACY_ACTIVE_SAFE_STORAGE_KEY)
    return
  }

  window.localStorage.setItem(ACTIVE_ACCOUNT_STORAGE_KEY, legacyValue)
  window.localStorage.removeItem(LEGACY_ACTIVE_SAFE_STORAGE_KEY)
}
