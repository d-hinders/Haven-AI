'use client'

import { useState } from 'react'
import { usePublicClient } from 'wagmi'
import type { Address } from 'viem'
import { useAuth, type UserSafe } from '@/context/AuthContext'
import { useSafeApprovers, type Approver } from '@/hooks/useSafeApprovers'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
import { useActiveSigner } from '@/lib/signer'
import { applyApproverChange } from '@/lib/approver-tx'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import { truncate, isValidAddress } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { StatusBadge } from '@/components/ui/StatusBadge'
import ConfirmDialog from '@/components/ConfirmDialog'

export default function ManageApprovers() {
  const { user } = useAuth()
  const safes = user?.safes ?? []

  if (safes.length === 0) {
    return (
      <div className="px-6 py-4">
        <p className="text-sm text-[var(--v2-ink-3)]">
          Link a Haven account to review and manage its approvers.
        </p>
      </div>
    )
  }

  return (
    <div className="divide-y divide-[var(--v2-border)]">
      {safes.map((safe) => (
        <SafeApproversCard key={safe.id} safe={safe} multiple={safes.length > 1} />
      ))}
    </div>
  )
}

function SafeApproversCard({ safe, multiple }: { safe: UserSafe; multiple: boolean }) {
  const safeAddress = safe.safe_address as Address
  const chain = getChainConfig(safe.chain_id)
  const { approvers, loading, error, refetch } = useSafeApprovers(safe.id)
  const publicClient = usePublicClient({ chainId: safe.chain_id })
  const signer = useActiveSigner({ safeAddress, chainId: safe.chain_id })
  const gate = useSafeOperationGate({ safeAddress, chainId: safe.chain_id })

  const [adding, setAdding] = useState(false)
  const [newAddress, setNewAddress] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [pendingRemove, setPendingRemove] = useState<Approver | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const canOperate = gate.kind === 'ready' && Boolean(signer) && Boolean(publicClient)
  const isLastOwner = approvers.length <= 1

  function gateMessage(): string | null {
    if (gate.kind === 'no_signer') return 'Connect the wallet that owns this account, or use your passkey, to manage approvers.'
    if (gate.kind === 'passkey_on_other_device') return 'This account is approved with a passkey on another device. Use that device to manage approvers.'
    return null
  }

  async function handleAdd() {
    const address = newAddress.trim()
    if (!isValidAddress(address)) {
      setActionError('Enter a valid wallet address (0x…).')
      return
    }
    if (approvers.some((a) => a.address.toLowerCase() === address.toLowerCase())) {
      setActionError('That address is already an approver on this account.')
      return
    }
    if (!signer || !publicClient) return

    setBusy(true)
    setActionError(null)
    try {
      await applyApproverChange({
        safeId: safe.id,
        safeAddress,
        chainId: safe.chain_id,
        action: 'add',
        address,
        signer,
        publicClient,
        label: newLabel.trim() || undefined,
        type: 'eoa',
      })
      setAdding(false)
      setNewAddress('')
      setNewLabel('')
      await refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not add the approver.')
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(approver: Approver) {
    if (!signer || !publicClient) return
    setBusy(true)
    setActionError(null)
    try {
      await applyApproverChange({
        safeId: safe.id,
        safeAddress,
        chainId: safe.chain_id,
        action: 'remove',
        address: approver.address,
        signer,
        publicClient,
      })
      setPendingRemove(null)
      await refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not remove the approver.')
    } finally {
      setBusy(false)
    }
  }

  const message = gateMessage()

  return (
    <div className="px-6 py-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--v2-ink)]">
            {multiple ? safe.name : 'Approvers'}
          </p>
          <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
            {chain.name} · {truncate(safe.safe_address)} · threshold 1
          </p>
        </div>
        {!adding && canOperate ? (
          <Button variant="tertiary" size="sm" onClick={() => { setAdding(true); setActionError(null) }}>
            Add approver
          </Button>
        ) : null}
      </div>

      {message ? (
        <div className="mb-3 rounded-lg border border-[var(--v2-warning)]/25 bg-[var(--v2-warning-soft)] px-4 py-3 text-sm text-[var(--v2-ink-2)]">
          {message}
        </div>
      ) : null}

      {error ? (
        <div className="mb-3 rounded-lg border border-[var(--v2-danger)]/25 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-[var(--v2-ink-3)]">Loading approvers…</p>
      ) : (
        <ul className="space-y-2">
          {approvers.map((approver) => (
            <li
              key={approver.address}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--v2-border)] px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--v2-ink)]">
                    {approver.label ?? truncate(approver.address)}
                  </span>
                  <StatusBadge tone={approver.type === 'passkey' ? 'brand' : 'neutral'}>
                    {approver.type === 'passkey' ? 'Passkey' : 'Wallet'}
                  </StatusBadge>
                </div>
                <div className="mt-1 flex items-center gap-3">
                  {approver.label ? (
                    <span className="font-mono text-xs text-[var(--v2-ink-3)]">{truncate(approver.address)}</span>
                  ) : null}
                  <a
                    href={getExplorerUrl(safe.chain_id, 'address', approver.address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
                  >
                    View on explorer
                  </a>
                </div>
              </div>
              {canOperate ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isLastOwner || busy}
                  onClick={() => { setPendingRemove(approver); setActionError(null) }}
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {isLastOwner && !loading && approvers.length === 1 ? (
        <p className="mt-2 text-xs text-[var(--v2-ink-3)]">
          This is the only approver. Add another before you can remove this one — an account must always keep at least one.
        </p>
      ) : null}

      {adding ? (
        <div className="mt-4 space-y-3 rounded-lg border border-dashed border-[var(--v2-border)] p-4">
          <div>
            <label className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
              Approver address
            </label>
            <Input
              value={newAddress}
              onChange={(e) => { setNewAddress(e.target.value); setActionError(null) }}
              placeholder="0x…"
              aria-label="Approver address"
            />
            <p className="mt-1.5 text-xs text-[var(--v2-ink-3)]">
              The wallet address (EOA) to add as an approver on {multiple ? safe.name : 'this account'}.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
              Label <span className="normal-case">(optional)</span>
            </label>
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. Co-founder wallet"
              aria-label="Approver label"
            />
          </div>
          {actionError ? (
            <p className="text-xs text-[var(--v2-danger)]">{actionError}</p>
          ) : null}
          <div className="flex gap-2">
            <Button variant="tertiary" size="sm" disabled={busy} onClick={() => { setAdding(false); setNewAddress(''); setNewLabel(''); setActionError(null) }}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || !newAddress.trim()} onClick={() => void handleAdd()}>
              {busy ? 'Adding…' : 'Add approver'}
            </Button>
          </div>
        </div>
      ) : null}

      {actionError && !adding ? (
        <p className="mt-2 text-xs text-[var(--v2-danger)]">{actionError}</p>
      ) : null}

      <ConfirmDialog
        open={pendingRemove !== null}
        title="Remove approver?"
        body={
          pendingRemove
            ? `${pendingRemove.label ?? truncate(pendingRemove.address)} will no longer be able to approve actions on ${multiple ? safe.name : 'this account'}. This change is signed and executed on ${chain.name}.`
            : ''
        }
        confirmLabel="Remove approver"
        loading={busy}
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => (pendingRemove ? handleRemove(pendingRemove) : Promise.resolve())}
      />
    </div>
  )
}
