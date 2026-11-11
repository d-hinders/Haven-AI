'use client'

/**
 * The money-action launcher (#4642) — Send and Receive, and the account
 * question they ask first.
 *
 * The dashboard owned this whole machine: `openHeroAction` /
 * `handleActionAccountSelected`, the `pickerAction` / `sendOpen` /
 * `hasOpenedReceive` / `actionAccountId` state, the selected account and its
 * `useAccountOperationGate`, and the three dialog mounts. Contacts needs the
 * same machine to send from a contact row, and a second copy of it is exactly
 * the duplication the design system forbids — so it lives here once and both
 * surfaces consume it.
 *
 * The mounts travel with the hook (`dialogs`) rather than being re-declared by
 * each caller: a caller that mounted `DelegationSendModal` itself would be the
 * third copy of the guard below, and the guard is the part that matters.
 *
 * ── The null-chain rule (#4642) ─────────────────────────────────────────────
 *
 * An account with no resolved `chain_id` cannot sign a send. The dashboard's
 * mount guard already skipped the dialog for it, but the account picker listed
 * every account as clickable, so choosing one set `sendOpen` and rendered
 * nothing — a silent dead end. The picker now renders such an account as a
 * non-interactive `Row` (see `DashboardActionPickerModal`), and `canSend` lets
 * a caller disable its own Send affordance when NO account can sign.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Address } from 'viem'
import DashboardActionPickerModal from '@/components/DashboardActionPickerModal'
import ReceiveDialog from '@/components/ReceiveDialog'
import DelegationSendModal from '@/components/DelegationSendModal'
import { useAccountOperationGate } from '@/hooks/useAccountOperationGate'
import { resolveDefaultAccount } from '@/lib/default-account'
import type { SmartAccount } from '@/context/AuthContext'

export type MoneyAction = 'receive' | 'send'

export interface MoneyActionLauncher {
  /**
   * Open Receive or Send. With more than one account the picker asks which
   * account first, exactly as the dashboard does; with one it opens directly.
   * `recipient` presets the Send dialog's To field (the Contacts slice).
   */
  openAction: (action: MoneyAction, options?: { recipient?: string }) => void
  /** Open Receive for a named account — the "Add funds" rows. */
  openReceiveForAccount: (accountId: string) => void
  /** True once Receive has been opened this session — the hero's deposit hint. */
  hasOpenedReceive: boolean
  /** The selected account's passkey lives on another device. */
  requiresOtherDevice: boolean
  /** The account the next money action would run on. */
  selectedAccount: SmartAccount | null
  /** True when at least one account can sign a send (address AND chain). */
  canSend: boolean
  /**
   * #4705: true when Receive has this account's money covered — it is open
   * on the account, or it already showed an arrival there that the caller has
   * not yet consumed. Calling it consumes that arrival. The dashboard asks it
   * on every funded read, so its funds toast (#4704) stays silent for money
   * the dialog announced, even when the dashboard's own poll sees it later.
   */
  receiveCovers: (accountId: string) => boolean
  /** The picker, Receive and Send mounts. Render once per page. */
  dialogs: ReactNode
}

export function useMoneyActionLauncher({
  accounts,
  onSent,
  onConnectFirstAgent,
}: {
  accounts: SmartAccount[]
  /** Called after a send settles — the dashboard refreshes its figures. */
  onSent?: () => void
  /**
   * #4705: passed to Receive as its first-deposit primary, "Connect your
   * first agent". Pass it only when this page can open Connect agent and no
   * agent exists yet.
   */
  onConnectFirstAgent?: () => void
}): MoneyActionLauncher {
  const defaultAccount = useMemo(() => resolveDefaultAccount(accounts), [accounts])

  const [pickerAction, setPickerAction] = useState<MoneyAction | null>(null)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [hasOpenedReceive, setHasOpenedReceive] = useState(false)
  const [actionAccountId, setActionAccountId] = useState<string | null>(null)
  // The contact a Send was opened from (#4642). Cleared on close so a later
  // Send from the dashboard never inherits a stale recipient.
  const [sendRecipient, setSendRecipient] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (actionAccountId && accounts.some((account) => account.id === actionAccountId)) return
    setActionAccountId(defaultAccount?.id ?? null)
  }, [actionAccountId, defaultAccount?.id, accounts])

  const selectedAccount =
    accounts.find((account) => account.id === actionAccountId) ?? defaultAccount ?? null
  const actionGate = useAccountOperationGate({
    accountAddress: selectedAccount?.account_address as Address | undefined,
    chainId: selectedAccount?.chain_id,
  })
  const requiresOtherDevice = actionGate.kind === 'passkey_on_other_device'

  // A send signs on a network, so an account without a resolved chain cannot
  // be the one it runs on.
  const canSend = accounts.some(
    (account) => account.chain_id != null && Boolean(account.account_address),
  )

  const openAction = useCallback(
    (action: MoneyAction, options?: { recipient?: string }) => {
      // No accounts: the money card renders "Create Haven account" instead of
      // these buttons, so this is unreachable from the UI; do nothing rather
      // than open a dialog about nothing.
      if (accounts.length === 0) return

      if (action === 'send') setSendRecipient(options?.recipient)

      if (accounts.length > 1) {
        setPickerAction(action)
        return
      }

      setActionAccountId(defaultAccount?.id ?? null)
      if (action === 'receive') {
        setHasOpenedReceive(true)
        setReceiveOpen(true)
      }
      if (action === 'send') setSendOpen(true)
    },
    [accounts.length, defaultAccount?.id],
  )

  const handleActionAccountSelected = useCallback(
    (accountId: string) => {
      setActionAccountId(accountId)
      if (pickerAction === 'receive') {
        setHasOpenedReceive(true)
        setReceiveOpen(true)
      }
      if (pickerAction === 'send') setSendOpen(true)
      setPickerAction(null)
    },
    [pickerAction],
  )

  const openReceiveForAccount = useCallback((accountId: string) => {
    setActionAccountId(accountId)
    setHasOpenedReceive(true)
    setReceiveOpen(true)
  }, [])

  // #4705: what Receive is showing, and the arrivals it announced. Refs, not
  // state: the dashboard reads them from its overview effect, and a change
  // here must not re-run that effect.
  const receiveShowingRef = useRef<string | null>(null)
  const receiveAnnouncedRef = useRef<Set<string>>(new Set())
  const handleReceiveShowing = useCallback((accountId: string | null) => {
    receiveShowingRef.current = accountId
  }, [])
  const handleReceiveArrived = useCallback((accountId: string) => {
    receiveAnnouncedRef.current.add(accountId)
  }, [])
  const receiveCovers = useCallback((accountId: string) => {
    const announced = receiveAnnouncedRef.current.delete(accountId)
    return announced || receiveShowingRef.current === accountId
  }, [])

  const closeSend = useCallback(() => {
    setSendOpen(false)
    setSendRecipient(undefined)
  }, [])

  const dialogs = (
    <>
      <DashboardActionPickerModal
        open={pickerAction !== null}
        action={pickerAction ?? 'receive'}
        accounts={accounts}
        onClose={() => setPickerAction(null)}
        onSelect={handleActionAccountSelected}
      />

      <ReceiveDialog
        open={receiveOpen}
        account={selectedAccount}
        // #4167: with several accounts the dialog's card is a picker, so a
        // wrong pre-pick is one switch away; one account renders no card.
        accounts={accounts}
        onClose={() => setReceiveOpen(false)}
        onConnectFirstAgent={onConnectFirstAgent}
        onShowingAccountChange={handleReceiveShowing}
        onArrived={handleReceiveArrived}
      />

      {/*
        Mount the send modal only while open so its wallet hooks
        (useDelegationSend backs wagmi wallet-client subscriptions) don't run
        in the background on every view — the same pattern the account detail
        page uses. Needs an account with a resolved chain: the delegation send
        signs on a network.
      */}
      {sendOpen && selectedAccount?.account_address && selectedAccount.chain_id != null && (
        <DelegationSendModal
          open
          onClose={closeSend}
          accountAddress={selectedAccount.account_address}
          chainId={selectedAccount.chain_id}
          initialRecipient={sendRecipient}
          onSent={onSent}
        />
      )}
    </>
  )

  return {
    openAction,
    openReceiveForAccount,
    hasOpenedReceive,
    requiresOtherDevice,
    selectedAccount,
    canSend,
    receiveCovers,
    dialogs,
  }
}
