'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import ConfirmDialog from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/Button'
import { DetailList, type DetailListItem } from '@/components/ui/DetailList'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useToast } from '@/components/ui/Toast'
import { useOptionalAuth } from '@/context/AuthContext'
import { salesKeyLabel, useMerchantKeys } from '@/hooks/useMerchantKeys'
import { timeAgo } from '@/lib/format'
import type { SalesKey } from '@/lib/sales'
import { CreateSalesKeyDialog } from './CreateSalesKeyDialog'

/** The documented limits of a Sales key (docs/security/merchant-key-limits.md). */
const LIMITS_HREF = 'https://github.com/d-hinders/Haven-AI/blob/dev/docs/security/merchant-key-limits.md'

const shortDate = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(iso))

/**
 * The Sales keys section of the Setup tab (#4905, approved on #4894): the
 * account's keys by prefix, **Create Sales key**, and a revoke per live key.
 *
 * - **List**: a `DetailList` (trailing actions) — prefix, who created it and
 *   when, last used, a `Revoked` badge once revoked. The secret is never here:
 *   the API returns the prefix only.
 * - **Create**: `CreateSalesKeyDialog`, mounted only while open so closing
 *   drops the secret with it.
 * - **Revoke**: `ConfirmDialog`, then a toast and a re-read.
 */
export function SalesKeysSection() {
  const { keys, loading, failed, create, revoke } = useMerchantKeys()
  const userId = useOptionalAuth()?.user?.id ?? null
  const { toast } = useToast()
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<SalesKey | null>(null)
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  // The list is the caller's own keys (the route lists by the session's user), so an
  // unknown user id (auth not read yet) reads as "you", never "someone else".
  const by = (id: string | null) => (userId === null || id === null || id === userId ? 'you' : 'someone else')

  const confirmRevoke = async () => {
    if (revoking === null) return
    setRevokeBusy(true)
    setRevokeError(null)
    try {
      await revoke(revoking.id)
      toast.success('Key revoked.')
      setRevoking(null)
    } catch {
      setRevokeError('Haven could not revoke the key. It still works. Try again.')
    } finally {
      setRevokeBusy(false)
    }
  }

  const items: DetailListItem[] = keys.map((key) => {
    const revoked = key.revoked_at !== null
    return {
      label: salesKeyLabel(key.key_prefix),
      value: (
        <span className="flex flex-wrap items-center gap-2">
          <span>
            Created by {by(key.created_by)}, {shortDate(key.created_at)}
          </span>
          {revoked ? <StatusBadge tone="danger">Revoked</StatusBadge> : null}
        </span>
      ),
      helper: revoked
        ? `Revoked by ${by(key.revoked_by)}, ${shortDate(key.revoked_at as string)}`
        : key.last_used_at
          ? `Last used ${timeAgo(key.last_used_at)}`
          : 'Never used',
      actions: revoked ? undefined : (
        <Button variant="ghost" size="sm" onClick={() => {
            setRevokeError(null)
            setRevoking(key)
          }}>
          Revoke
        </Button>
      ),
    }
  })

  return (
    <div id="sales-keys" data-testid="sales-keys-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Sales keys</h2>
          <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
            Your kit uses a Sales key to report what each payment was for. A key can’t move money, sign, or see
            anything but this account’s sales.{' '}
            <a
              href={LIMITS_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
            >
              What a key can do
            </a>
          </p>
        </div>
        <Button size="sm" variant="ghost" leadingIcon={Plus} className="shrink-0" onClick={() => setCreating(true)}>
          Create Sales key
        </Button>
      </div>

      <div className="mt-3" data-testid="sales-keys-list">
        {loading && keys.length === 0 ? (
          <Skeleton variant="text" className="h-4 w-48" />
        ) : failed && keys.length === 0 ? (
          <p className="text-sm text-[var(--v2-ink-2)]">Your Sales keys could not load. Your payments are unchanged.</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-[var(--v2-ink-2)]">
            No Sales keys yet. Your kit needs one to report what each payment was for.
          </p>
        ) : (
          <DetailList items={items} />
        )}
      </div>

      {creating ? <CreateSalesKeyDialog create={create} onClose={() => setCreating(false)} /> : null}

      <ConfirmDialog
        open={revoking !== null}
        onCancel={() => {
          if (revokeBusy) return
          setRevokeError(null)
          setRevoking(null)
        }}
        onConfirm={confirmRevoke}
        title={`Revoke ${revoking ? salesKeyLabel(revoking.key_prefix) : ''}?`}
        body="Your kit stops being able to report sales with this key straight away. Payments still arrive and count; they show with no product until your kit has a new key."
        confirmLabel="Revoke key"
        busyLabel="Revoking…"
        loading={revokeBusy}
        error={revokeError ? <InlineAlert>{revokeError}</InlineAlert> : undefined}
      />
    </div>
  )
}

export default SalesKeysSection
