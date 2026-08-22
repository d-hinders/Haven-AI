'use client'

/**
 * Backup & recovery signers for a delegation-rail account (#888, epic #836).
 *
 * Outcome-language signer management: see the ways this account can be
 * approved, add a backup (so a lost device isn't a lost account), remove one.
 * The words passkey/EOA/addKey/signer never lead — it's "ways to approve",
 * "this device", "a wallet". Every change is one signature by an existing
 * signer; Haven signs nothing.
 *
 * Account-scoped (#1089) — works from the moment an account exists, with no
 * agent required. This is the single home for backup & recovery; it no
 * longer renders on the agent page.
 */

import { useCallback, useMemo, useState } from 'react'
import { isAddress } from 'viem'
import { CircleHelp } from 'lucide-react'
import { useAccountSigners } from '@/hooks/useAccountSigners'
import { Card } from './ui/Card'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Modal } from './ui/Modal'
import ConfirmDialog from './ConfirmDialog'
import { Icon } from './ui/Icon'
import { useToast } from './ui/Toast'
import { truncateAddress } from '@/components/haven'
import { passkeyRowLabel } from '@/lib/passkeyLabels'

interface Props {
  safeAddress: string
  chainId: number
  userEmail: string
}

export default function AccountSignersCard({ safeAddress, chainId, userEmail }: Props) {
  const {
    signers,
    loadError,
    busy,
    ready,
    passkeyElsewhere,
    enrollBackupPasskey,
    enrollOwnerWallet,
    removePasskey,
    removeOwner,
    reload,
  } = useAccountSigners(safeAddress, chainId, userEmail)
  const { toast } = useToast()
  const [walletAddr, setWalletAddr] = useState('')
  const [showWallet, setShowWallet] = useState(false)
  const [showRecoveryHelp, setShowRecoveryHelp] = useState(false)
  const [showRemoveOwnerConfirm, setShowRemoveOwnerConfirm] = useState(false)
  const [passkeyToRemove, setPasskeyToRemove] = useState<string | null>(null)

  const wayCount = useMemo(
    () => (signers ? signers.passkeys.length + (signers.owner_address ? 1 : 0) : 0),
    [signers],
  )

  // #1153: the backend now permits remove_owner unconditionally, even when
  // it drops the account to a single signer — so the human must see the
  // actual consequence (no recovery, ever) before it happens, not after.
  // Only the drop-to-one case gets the confirmation; removing a wallet that
  // still leaves a backup passkey is ordinary maintenance.
  const removingOwnerLeavesOneSigner = wayCount === 2
  const removingPasskeyLeavesOneSigner = wayCount === 2

  const handle = useCallback(
    async (result: Promise<{ ok: boolean; reason?: string; message?: string }>, okMsg: string) => {
      const r = await result
      if (r.ok) toast.success(okMsg)
      // #1085: neutral, not error — the user changed their mind.
    else if (r.reason === 'cancelled') toast.info('Signature was cancelled.')
      else if (r.reason === 'blocked') toast.error(r.message ?? 'That change is not allowed.')
      else toast.error('Something went wrong. Try again.')
    },
    [toast],
  )

  if (signers === null && !loadError) return null

  const onlyOneWay = wayCount < 2

  return (
    <Card hover={false} className="mt-6 p-5 md:p-6">
      <div>
        <h2 className="text-base font-semibold text-[var(--v2-ink)]">Backup &amp; recovery</h2>
        <p className="mt-0.5 text-sm text-[var(--v2-ink-muted)]">
          These are the ways this account can be approved. Keep at least two, so a lost device never
          means a lost account.
        </p>
      </div>

      {loadError ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3">
          <p className="text-sm text-[var(--v2-ink-2)]">
            Haven could not load how this account is approved.
          </p>
          <Button size="sm" variant="ghost" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : signers ? (
        <>
          {onlyOneWay ? (
            <div className="mt-4 rounded-lg border border-[var(--v2-warning)]/25 bg-[var(--v2-warning-soft)] px-4 py-3 text-sm text-[var(--v2-ink)]">
              This account has only one way to approve. Add a backup now — without it, losing this device
              means losing the account.
            </div>
          ) : null}

          <Card.Section divided className="mt-4">
            {signers.owner_address ? (
              <div className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--v2-ink)]">Wallet</p>
                  <p className="truncate text-xs text-[var(--v2-ink-muted)]">
                    {truncateAddress(signers.owner_address)}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--v2-ink-muted)]">
                    If you remove it, your passkeys become the only ways to approve — and to recover this
                    account.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !ready || wayCount < 2}
                  onClick={() =>
                    removingOwnerLeavesOneSigner
                      ? setShowRemoveOwnerConfirm(true)
                      : void handle(removeOwner(), 'Wallet removed.')
                  }
                >
                  Remove
                </Button>
              </div>
            ) : null}
            {signers.passkeys.map((pk, i) => (
              <div key={pk.key_id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--v2-ink)]">
                    {passkeyRowLabel(pk.created_at, i)}
                  </p>
                  <p className="truncate font-mono text-xs text-[var(--v2-ink-muted)]">
                    {truncateAddress(pk.key_id)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !ready || wayCount < 2}
                  onClick={() =>
                    removingPasskeyLeavesOneSigner
                      ? setPasskeyToRemove(pk.key_id)
                      : void handle(removePasskey(pk.key_id), 'Removed.')
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
          </Card.Section>

          <div className="mt-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={busy || !ready} onClick={() => void handle(enrollBackupPasskey(), 'Backup added.')}>
                {busy ? 'Working…' : 'Add a backup passkey'}
              </Button>
              {!signers.owner_address ? (
                <Button variant="ghost" disabled={busy || !ready} onClick={() => setShowWallet((v) => !v)}>
                  Or add a wallet
                </Button>
              ) : null}
            </div>
            <p className="mt-1.5 text-xs text-[var(--v2-ink-muted)]">
              Approve with Face ID, Touch ID, Windows Hello, or your device PIN.
            </p>
          </div>

          {showWallet && !signers.owner_address ? (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Input
                value={walletAddr}
                onChange={(e) => setWalletAddr(e.target.value)}
                placeholder="Wallet address (0x…)"
                aria-label="Wallet address"
                className="font-mono"
              />
              <Button
                disabled={busy || !ready || !isAddress(walletAddr.trim())}
                onClick={() =>
                  void handle(enrollOwnerWallet(walletAddr.trim()), 'Wallet added as a backup.').then(() => {
                    setWalletAddr('')
                    setShowWallet(false)
                  })
                }
              >
                Add wallet
              </Button>
            </div>
          ) : null}

          {!ready ? (
            // #1097: with passkeys present the optimistic fallback keeps
            // `ready` true, so this state only occurs for owner-only
            // accounts — the wallet really is the blocker.
            <p className="mt-3 text-xs text-[var(--v2-ink-muted)]">
              Connect your account owner wallet to change how this account is approved.
            </p>
          ) : null}
          {ready && passkeyElsewhere ? (
            // #1097: signing works, but the ceremony may hand off to the
            // device that holds the passkey — say so BEFORE the browser's
            // QR dialog surprises them.
            <p className="mt-3 text-xs text-[var(--v2-ink-muted)]">
              This account&apos;s passkey may be on another device — your browser will
              guide you there when you approve.
            </p>
          ) : null}

          <Card.Section className="mt-4">
            <button
              type="button"
              onClick={() => setShowRecoveryHelp(true)}
              className="inline-flex items-center gap-1.5 py-3 text-sm font-medium text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]"
            >
              <Icon icon={CircleHelp} className="h-4 w-4" />
              Lost a device?
            </button>
          </Card.Section>
        </>
      ) : null}

      <Modal
        open={showRecoveryHelp}
        onClose={() => setShowRecoveryHelp(false)}
        title="Lost a device?"
        footer={
          <Button variant="tertiary" onClick={() => setShowRecoveryHelp(false)}>
            Got it
          </Button>
        }
      >
        <div className="space-y-3">
          <p>
            Open Haven on a device that still has a working approval — a backup passkey, or the
            wallet you added. Add a replacement for the device you lost so you&apos;re back to two
            ways to approve, then remove the lost one above.
          </p>
          <p>
            Haven can&apos;t do this for you: every change is approved by a signer you already
            hold. If an account ever has just one way to approve and that&apos;s lost, it can&apos;t
            be recovered — by you or by us. That&apos;s why the backup above matters.{' '}
            <a
              href="https://docs.haven.xyz/product/account-recovery"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
            >
              How recovery works
            </a>
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={showRemoveOwnerConfirm}
        onCancel={() => setShowRemoveOwnerConfirm(false)}
        title="Remove this wallet?"
        onConfirm={() => {
          setShowRemoveOwnerConfirm(false)
          void handle(removeOwner(), 'Wallet removed.')
        }}
        confirmLabel="Remove anyway"
        confirmDisabled={busy || !ready}
        body={
          <div className="space-y-3">
          <p>
            This is the last backup on this account. Removing it leaves a single passkey
            as the only way to approve anything — this account will have no recovery.
          </p>
          <p>
            If you lose that device, you lose access to this account and everything in it. Haven
            can&apos;t get it back for you, and neither can anyone else.
          </p>
          </div>
        }
      />

      <ConfirmDialog
        open={passkeyToRemove !== null}
        onCancel={() => setPasskeyToRemove(null)}
        title="Remove this approval?"
        onConfirm={() => {
          if (!passkeyToRemove) return
          const keyId = passkeyToRemove
          setPasskeyToRemove(null)
          void handle(removePasskey(keyId), 'Removed.')
        }}
        confirmLabel="Remove anyway"
        confirmDisabled={busy || !ready}
        body={
          <div className="space-y-3">
          <p>
            Removing this passkey leaves this account with one way to approve. If that
            remaining way is lost, this account will have no recovery.
          </p>
          <p>
            Haven cannot restore access to this account for you. Make sure you still control the
            remaining way to approve before continuing.
          </p>
          </div>
        }
      />
    </Card>
  )
}
