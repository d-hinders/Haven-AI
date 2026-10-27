'use client'

/**
 * The Who can approve section for a delegation-rail account (#888, epic #836).
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
 *
 * #4474 (mockup v9): the card is the section's CONTENT only. Its heading
 * ("Who can approve") and the "All signers in Settings" link live on the page
 * above it (`SectionHeading`, #4475), so the card carries no heading, no intro
 * sentence and no in-card Settings row. Inside: the single-signer warning
 * (owner decision 2026-10-27 — a warning about one section's own content may
 * sit at the top of that section's card), the signer rows as two-line `Row`s,
 * and ONE footer row holding both add actions and the recovery-help link.
 */

import { useCallback, useMemo, useState } from 'react'
import { isAddress } from 'viem'
import { KeyRound, Wallet } from 'lucide-react'
import { useAccountSigners } from '@/hooks/useAccountSigners'
import { Card } from './ui/Card'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Modal } from './ui/Modal'
import { Row } from './ui/Row'
import ConfirmDialog from './ConfirmDialog'
import WalletConnectAction from './WalletConnectAction'
import PasskeyElsewhereHint from './PasskeyElsewhereHint'
import { ApprovalRequiredBanner } from './haven/ApprovalRequiredBanner'
import { Icon } from './ui/Icon'
import { useToast } from './ui/Toast'
import { passkeyRowParts } from '@/lib/passkeyLabels'

interface Props {
  accountAddress: string
  chainId: number
  userEmail: string
}

export default function AccountSignersCard({ accountAddress, chainId, userEmail }: Props) {
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
  } = useAccountSigners(accountAddress, chainId, userEmail)
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
    else if (r.reason === 'cancelled') toast.info('Approval was cancelled.')
      else if (r.reason === 'blocked') toast.error(r.message ?? 'That change is not allowed.')
      else toast.error('Something went wrong. Try again.')
    },
    [toast],
  )

  if (signers === null && !loadError) return null

  const onlyOneWay = wayCount < 2
  // #4474: the warning names the KIND of the one signer, so a wallet-only
  // account is never told about a passkey it does not have.
  const onlyOneWayTitle = signers?.owner_address
    ? 'Only one wallet can approve this account'
    : 'Only one passkey can approve this account'
  // #4474: removing the last signer is refused on-chain anyway
  // (`CannotRemoveLastSigner`), so Remove is ABSENT rather than disabled while
  // one signer remains — a disabled Remove on the only row reads as a broken
  // control. With two or more, every row can be removed (down to one).
  const canRemove = wayCount >= 2

  return (
    // #4166: the section's heading lives on the page above this card.
    // #4307: the card reads warning first (the one thing that asks for
    // action), then the signers, then their actions.
    // #4474: the Settings link moved up to the heading row, and the two add
    // actions plus "Lost a device?" share ONE divided footer row.
    <Card hover={false} className="p-5 md:p-6">
      {loadError ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3">
          <p className="text-sm text-[var(--v2-danger)]">
            Haven could not load how this account is approved.
          </p>
          <Button size="sm" variant="ghost" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : signers ? (
        <>
          {/* #4474: the one-signer warning LEADS the card — it is the one
              thing here that asks for action. It qualifies this section's own
              rows, so it stays inside the card rather than in the page's
              banner slot (owner decision 2026-10-27, design-system.md
              § Detail-page section rule). */}
          {onlyOneWay ? (
            <ApprovalRequiredBanner tone="warning" density="compact" title={onlyOneWayTitle}>
              If you lose it, you lose the account and the money in it. Add a backup now.
            </ApprovalRequiredBanner>
          ) : null}

          <Card.Section divided className="mt-4">
            {signers.owner_address ? (
              <div>
                <Row
                  leading={<Icon icon={Wallet} className="h-4 w-4" />}
                  leadingTone="neutral"
                  title="Browser wallet"
                  subtitle={
                    /* #3845: never promise passkeys the account does not have. */
                    signers.passkeys.length > 0
                      ? 'If you remove it, your passkeys become the only ways to approve — and to recover this account.'
                      : "This wallet is the only way to approve this account, so it can't be removed until you add a backup."
                  }
                  /* #4474: `Row`'s subtitle is a single-line `truncate` by
                     default, which clipped this consequence sentence to ~37
                     characters at 390px — and it is the sentence that says why
                     Remove is dangerous, so a clipped one is a safety-copy
                     loss, not cosmetics. `whitespace-normal` wins over
                     `truncate`'s `nowrap` (Tailwind emits whitespace utilities
                     after `truncate`); the row is `items-center`, so the
                     leading icon stays centred against the taller body. */
                  subtitleClassName="whitespace-normal"
                  trailing={
                    canRemove ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || !ready}
                        onClick={() =>
                          removingOwnerLeavesOneSigner
                            ? setShowRemoveOwnerConfirm(true)
                            : void handle(removeOwner(), 'Wallet removed.')
                        }
                      >
                        Remove
                      </Button>
                    ) : undefined
                  }
                  density="flush"
                  className="py-3"
                />
                {/* #3825: no address by default, but revealable here — this
                    card asks the user to connect THE owner wallet, and they
                    must be able to tell which one without leaving the task
                    (#3825 design review). */}
                <details className="pb-3">
                  <summary className="cursor-pointer rounded-sm text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80">
                    Show address
                  </summary>
                  <p className="mt-1 break-all font-mono text-xs text-[var(--v2-ink-2)]">{signers.owner_address}</p>
                </details>
              </div>
            ) : null}
            {signers.passkeys.map((pk, i) => {
              // #4474: the split form — the kind on line 1, "Added {date}" on
              // line 2. The ordinal appears only when there is more than one
              // passkey to tell apart; `passkeyRowLabel` derives its one-line
              // string from the same source.
              const parts = passkeyRowParts(pk.created_at, i, signers.passkeys.length)
              return (
                <Row
                  key={pk.key_id}
                  leading={<Icon icon={KeyRound} className="h-4 w-4" />}
                  leadingTone="neutral"
                  title={parts.kind}
                  subtitle={parts.added ?? undefined}
                  trailing={
                    canRemove ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || !ready}
                        onClick={() =>
                          removingPasskeyLeavesOneSigner
                            ? setPasskeyToRemove(pk.key_id)
                            : void handle(removePasskey(pk.key_id), 'Removed.')
                        }
                      >
                        Remove
                      </Button>
                    ) : undefined
                  }
                  density="flush"
                  className="py-3"
                />
              )
            })}
          </Card.Section>

          {/* #4474: ONE footer row — both add actions and the recovery-help
              link, divided from the rows above. The helper line ("Approve
              with your passkey…") is gone: the button names the passkey, and
              the screen-lock anchor was subtext the mockup dropped. */}
          <Card.Section divided className="mt-4">
            <div className="flex flex-wrap items-center gap-3 py-3">
              <Button
                variant={onlyOneWay ? 'primary' : 'ghost'}
                disabled={busy || !ready}
                onClick={() => void handle(enrollBackupPasskey(), 'Backup added.')}
              >
                <Icon icon={KeyRound} className="h-4 w-4" />
                {busy ? 'Working…' : 'Add a backup passkey'}
              </Button>
              {!signers.owner_address ? (
                <Button variant="ghost" disabled={busy || !ready} onClick={() => setShowWallet((v) => !v)}>
                  <Icon icon={Wallet} className="h-4 w-4" />
                  Add a wallet
                </Button>
              ) : null}
              <button
                type="button"
                onClick={() => setShowRecoveryHelp(true)}
                className="ml-auto rounded-sm text-sm font-medium text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                Lost a device?
              </button>
            </div>
          </Card.Section>

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
            <div className="mt-3 space-y-2">
              <p className="text-xs text-[var(--v2-ink-3)]">
                Connect your account owner wallet to change how this account is approved.
              </p>
              {/* #3812: connect or switch in place (the header pill is gone since #3825). */}
              {!loadError ? <WalletConnectAction /> : null}
            </div>
          ) : null}
          {ready && passkeyElsewhere ? (
            // #1097: signing works, but the ceremony may hand off to the
            // device that holds the passkey — say so BEFORE the browser's
            // QR dialog surprises them.
            <PasskeyElsewhereHint className="mt-3" />
          ) : null}
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
              href="https://github.com/d-hinders/Haven-AI/blob/dev/docs/product/account-recovery.md"
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
