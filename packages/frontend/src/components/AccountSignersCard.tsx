'use client'

/**
 * Backup & recovery signers for a delegation-rail account (#888, epic #836).
 *
 * Outcome-language signer management: see the ways this account can be
 * approved, add a backup (so a lost device isn't a lost account), remove one.
 * The words passkey/EOA/addKey/signer never lead — it's "ways to approve",
 * "this device", "a wallet". Every change is one signature by an existing
 * signer; Haven signs nothing.
 */

import { useMemo, useState } from 'react'
import { isAddress } from 'viem'
import { useAccountSigners } from '@/hooks/useAccountSigners'
import { Card } from './ui/Card'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { useToast } from './ui/Toast'

interface Props {
  agentId: string
  chainId: number
  userEmail: string
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export default function AccountSignersCard({ agentId, chainId, userEmail }: Props) {
  const { signers, busy, ready, enrollBackupPasskey, enrollOwnerWallet, removePasskey } =
    useAccountSigners(agentId, chainId, userEmail)
  const { toast } = useToast()
  const [walletAddr, setWalletAddr] = useState('')
  const [showWallet, setShowWallet] = useState(false)

  const wayCount = useMemo(
    () => (signers ? signers.passkeys.length + (signers.owner_address ? 1 : 0) : 0),
    [signers],
  )

  if (signers === null) return null

  const onlyOneWay = wayCount < 2

  async function handle(result: Promise<{ ok: boolean; reason?: string; message?: string }>, okMsg: string) {
    const r = await result
    if (r.ok) toast.success(okMsg)
    else if (r.reason === 'cancelled') toast.error('Cancelled.')
    else if (r.reason === 'blocked') toast.error(r.message ?? 'That change is not allowed.')
    else toast.error('Something went wrong. Try again.')
  }

  return (
    <Card hover={false} className="mt-6 p-5 md:p-6">
      <div>
        <h2 className="text-base font-semibold text-[var(--v2-ink)]">Backup &amp; recovery</h2>
        <p className="mt-0.5 text-sm text-[var(--v2-ink-muted)]">
          These are the ways this account can be approved. Keep at least two, so a lost device never
          means a lost account.
        </p>
      </div>

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
              <p className="text-sm font-medium text-[var(--v2-ink)]">A connected wallet</p>
              <p className="truncate text-xs text-[var(--v2-ink-muted)]">{shortAddr(signers.owner_address)}</p>
            </div>
          </div>
        ) : null}
        {signers.passkeys.map((pk, i) => (
          <div key={pk.key_id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--v2-ink)]">
                {i === 0 ? 'Face ID / Touch ID' : `Backup ${i}`}
              </p>
              <p className="truncate font-mono text-xs text-[var(--v2-ink-muted)]">{shortAddr(pk.key_id)}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !ready || wayCount < 2}
              onClick={() => void handle(removePasskey(pk.key_id), 'Removed.')}
            >
              Remove
            </Button>
          </div>
        ))}
      </Card.Section>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button disabled={busy || !ready} onClick={() => void handle(enrollBackupPasskey(), 'Backup added.')}>
          {busy ? 'Working…' : 'Add a backup with Face ID / Touch ID'}
        </Button>
        {!signers.owner_address ? (
          <Button variant="ghost" disabled={busy || !ready} onClick={() => setShowWallet((v) => !v)}>
            Or add a wallet
          </Button>
        ) : null}
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
        <p className="mt-3 text-xs text-[var(--v2-ink-muted)]">
          Connect your account owner wallet to change how this account is approved.
        </p>
      ) : null}

      <Card.Section className="mt-4">
        <details className="group">
          <summary className="cursor-pointer list-none text-sm font-medium text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]">
            Lost a device?
          </summary>
          <div className="mt-2 space-y-2 text-sm leading-relaxed text-[var(--v2-ink-muted)]">
            <p>
              Open Haven on a device that still has a working approval — a backup Face ID, or the
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
        </details>
      </Card.Section>
    </Card>
  )
}
