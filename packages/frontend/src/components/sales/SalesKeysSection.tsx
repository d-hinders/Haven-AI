'use client'

import { Skeleton } from '@/components/ui/Skeleton'
import { useMerchantKeys } from '@/hooks/useMerchantKeys'

/**
 * The Sales keys section of the Setup tab — the slot #4905 renders into.
 *
 * #4905 builds the key screens (the list by prefix, create with the secret
 * shown once, revoke) and replaces THIS file; the Setup tab mounts it with no
 * props and owns nothing of what is inside. Until then it is read-only and
 * says so: how many keys are active, and that managing them is not here yet.
 * There is no button, because there is nothing for one to do.
 */
export function SalesKeysSection() {
  const { keys, loading, failed } = useMerchantKeys()
  const active = keys.filter((key) => key.revoked_at === null).length

  return (
    <div id="sales-keys" data-testid="sales-keys-section">
      <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Sales keys</h2>
      <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
        Your kit uses a Sales key to report what each payment was for. A key can’t move money, sign, or see anything
        but this account’s sales.
      </p>
      <div className="mt-3 text-sm text-[var(--v2-ink-2)]" data-testid="sales-keys-count">
        {loading ? (
          <Skeleton variant="text" className="h-4 w-32" />
        ) : failed ? (
          <p>Your Sales keys could not load. Your payments are unchanged.</p>
        ) : (
          <p>
            {active === 0 ? 'No active Sales keys' : `${active} active ${active === 1 ? 'key' : 'keys'}`}
          </p>
        )}
      </div>
      <p className="mt-2 text-xs text-[var(--v2-ink-3)]">Creating and revoking Sales keys is coming to this page.</p>
    </div>
  )
}

export default SalesKeysSection
