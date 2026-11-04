'use client'

/**
 * Owner send for a delegation-rail account (#1083), two screens since #4641.
 *
 * One signature moves funds account → recipient (sponsored — no gas for the
 * user, and it works even before the account's first on-chain action).
 * Outcome language throughout; a dismissed passkey prompt is a neutral
 * cancel, never an error (#1076/#1085 discipline).
 *
 * ── Details → Review → sent ─────────────────────────────────────────────────
 *
 * The owner approved a Review screen before every send (#4641, mockup canvas
 * "Send 1" to "Send 4"). It is a CONFIRMATION the user reads before the
 * passkey prompt, not an approval hold: nothing queues, and the payment still
 * executes, or reverts on-chain, exactly as today. `send()` keeps its
 * arguments and `hooks/useDelegationSend.ts` is untouched.
 *
 * The step machine follows `components/marketplace/FundMerchantModal.tsx`
 * (`type Step = 'select' | 'review' | 'working' | 'done' | 'error'`). The
 * working state is not a screen here: it is the Review screen with the Send
 * button reading "Sending…" and every dismissal path blocked, because the
 * ceremony starts on Review and a cancel or a failure lands back on it with
 * its message.
 *
 * ── One data owner ──────────────────────────────────────────────────────────
 *
 * `useContacts()` keeps its list per instance (`hooks/useContacts.ts:25`,
 * `:50–52`), so a second instance would never see a contact this dialog saves.
 * The dialog therefore owns the ONE contacts hook and the ONE accounts hook and
 * passes them into `RecipientField`; "Save as contact" writes through that same
 * `addContact`, so a saved contact is in the picker at once.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits, isAddress, parseUnits } from 'viem'
import type { Address } from 'viem'
import { useDelegationSend } from '@/hooks/useDelegationSend'
import { useAccounts } from '@/hooks/useAccounts'
import { useContacts } from '@/hooks/useContacts'
import { getChainTokens, getExplorerUrlOrNull, resolveChainOrNull } from '@/lib/chains'
import { truncate } from '@/lib/format'
import { ApiRequestError } from '@/lib/api'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { DialogActions } from './ui/DialogActions'
import { DialogResult } from './ui/DialogResult'
import { DetailList } from './ui/DetailList'
import { InlineAlert } from './ui/InlineAlert'
import { Monogram } from './ui/Monogram'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { RecipientField, type Recipient } from './RecipientField'
import { Address as AddressText } from './haven'
import WalletConnectAction from './WalletConnectAction'
import PasskeyElsewhereHint from './PasskeyElsewhereHint'

interface Props {
  open: boolean
  onClose: () => void
  accountAddress: string
  chainId: number
  onSent?: () => void
  /**
   * An address to open with (#4641). The field shows the short address and
   * resolves it to a contact or account chip once data loads; focus lands on
   * Amount instead of the To field. The Contacts slice uses it.
   */
  initialRecipient?: string
}

type Step = 'details' | 'review' | 'done'

/** The "Save as contact" row's own state, independent of the send's. */
type SaveState = 'idle' | 'saving' | 'saved' | 'already' | 'error'

/** A message on Review: a cancelled approval is neutral, a failure is not. */
type ReviewMessage = { tone: 'neutral' | 'danger'; message: string }

export default function DelegationSendModal({
  open,
  onClose,
  accountAddress,
  chainId,
  onSent,
  initialRecipient,
}: Props) {
  const { busy, loaded, loadError, reload, ready, passkeyElsewhere, send } = useDelegationSend(accountAddress, chainId)
  const { accounts } = useAccounts()
  // ONE contacts instance for the whole dialog (#4641) — see the header.
  const { contacts, loading: contactsLoading, error: contactsError, addContact } = useContacts()

  const tokens = useMemo(
    () =>
      Object.entries(getChainTokens(chainId))
        .filter(([, cfg]) => cfg.address !== null)
        .map(([symbol, cfg]) => ({ symbol, address: cfg.address as Address, decimals: cfg.decimals })),
    [chainId],
  )
  const [tokenSymbol, setTokenSymbol] = useState(tokens[0]?.symbol ?? '')
  const token = tokens.find((t) => t.symbol === tokenSymbol) ?? tokens[0]

  const [step, setStep] = useState<Step>('details')
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState<Recipient | null>(null)
  const [message, setMessage] = useState<ReviewMessage | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  // The send's own in-flight flag. `useDelegationSend`'s `busy` is the same
  // fact, but a local one is what the dismissal guards and the button label
  // read, so a test can hold a send open without reaching into the hook.
  const [sending, setSending] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedName, setSavedName] = useState('')

  const amountRef = useRef<HTMLInputElement>(null)
  const presetRef = useRef(initialRecipient)

  // Closing and reopening starts fresh (#4641 lifecycle): Details, no recipient
  // beyond the preset, empty amount, no error or result, empty contact name.
  // Both callers mount the dialog only while open, but the reset must not
  // depend on that — so it runs on CLOSE, not on open. Resetting on open would
  // race `RecipientField`'s own preset resolution: child effects run first, so
  // the field would resolve the preset and the parent would then wipe it.
  useEffect(() => {
    if (open) return
    setStep('details')
    setAmount('')
    setRecipient(null)
    setMessage(null)
    setTxHash(null)
    setSending(false)
    setSaveName('')
    setSaveState('idle')
    setSaveError(null)
    setSavedName('')
  }, [open])

  // A change of `initialRecipient` while open re-seeds the recipient — and only
  // the recipient: the amount the user typed stays. The functional update keeps
  // a chip the field has ALREADY resolved to the new preset (its effect runs
  // before this one) instead of clearing it again.
  useEffect(() => {
    if (!open) return
    if (presetRef.current === initialRecipient) return
    presetRef.current = initialRecipient
    const next = (initialRecipient ?? '').toLowerCase()
    setRecipient((current) => (current && current.address.toLowerCase() === next ? current : null))
    setStep('details')
    setMessage(null)
  }, [initialRecipient, open])

  const sendingAccount = accounts.find((a) => a.account_address.toLowerCase() === accountAddress.toLowerCase())
  const fromName = sendingAccount?.name ?? truncate(accountAddress)
  const chainName = resolveChainOrNull(chainId)?.name ?? 'this network'

  const amountAtomic = useMemo(() => {
    if (!token || !amount.trim() || Number(amount) <= 0) return null
    try {
      return parseUnits(amount.trim(), token.decimals).toString()
    } catch {
      return null
    }
  }, [amount, token])

  // The SIGNED amount, not the typed string — the same `formatUnits(atomic)`
  // read `FundMerchantModal` shows on its own review step.
  const amountDisplay = amountAtomic && token ? formatUnits(BigInt(amountAtomic), token.decimals) : ''
  const recipientValid = recipient !== null && isAddress(recipient.address)
  const canReview = recipientValid && amountAtomic !== null
  const working = sending || busy
  const saving = saveState === 'saving'
  // Today's gate, unchanged: the signer must be reachable and nothing may be in
  // flight. Recipient and amount are already settled by the time Review shows.
  const canSend = ready && !busy && !sending
  const showSaveRow = step === 'done' && recipient?.kind === 'new' && !contactsLoading
  const explorerUrl = txHash ? getExplorerUrlOrNull(chainId, 'tx', txHash) : null

  async function handleSend() {
    if (!token || !amountAtomic || !recipient) return
    setMessage(null)
    setSending(true)
    try {
      const result = await send({
        tokenAddress: token.address,
        to: recipient.address as Address,
        amountAtomic,
      })
      if (result.ok) {
        setTxHash(result.txHash)
        setStep('done')
        onSent?.()
      } else if (result.reason === 'cancelled') {
        setMessage({ tone: 'neutral', message: 'Approval was cancelled.' })
      } else {
        setMessage({
          tone: 'danger',
          message: result.message ?? 'Haven could not send this payment. Try again.',
        })
      }
    } finally {
      setSending(false)
    }
  }

  async function handleSaveContact() {
    if (!recipient) return
    const name = saveName.trim()
    // A blank name is refused inline, before any API call.
    if (name === '') {
      setSaveError('Enter a name to save this contact.')
      return
    }
    setSaveError(null)
    setSaveState('saving')
    try {
      await addContact(name, recipient.address)
      setSavedName(name)
      setSaveState('saved')
    } catch (err) {
      // A 409 is the backend saying this address is already saved — a fact, not
      // a failure (`packages/backend/src/routes/contacts.ts:62`).
      if (err instanceof ApiRequestError && err.status === 409) {
        setSaveState('already')
      } else {
        setSaveState('error')
        setSaveError('Haven could not save this contact. Try again.')
      }
    }
  }

  // Every screen puts its actions in `Modal`'s footer (#4641 § Footer). A
  // two-screen dialog takes the equal-halves `DialogActions` pair; the success
  // screen has one action, so it renders a full-width primary instead.
  const footer =
    step === 'details' ? (
      <DialogActions className="w-full">
        <Button variant="ghost" onClick={onClose} className="flex-1">
          Cancel
        </Button>
        <Button
          onClick={() => {
            setMessage(null)
            setStep('review')
          }}
          disabled={!canReview}
          className="flex-1"
        >
          Review
        </Button>
      </DialogActions>
    ) : step === 'review' ? (
      <DialogActions className="w-full">
        <Button
          variant="ghost"
          onClick={() => {
            setMessage(null)
            setStep('details')
          }}
          className="flex-1"
          disabled={working}
        >
          Back
        </Button>
        <Button onClick={() => void handleSend()} disabled={!canSend} className="flex-1">
          {working ? 'Sending…' : message ? 'Try again' : `Send ${amountDisplay} ${token?.symbol ?? ''}`.trim()}
        </Button>
      </DialogActions>
    ) : (
      <Button variant="ghost" onClick={onClose} className="w-full" disabled={saving}>
        Done
      </Button>
    )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send"
      footer={footer}
      // A signature or a contact save in flight disables every way out
      // together — the ✕, the backdrop and Escape — or the ✕ becomes the one
      // unguarded exit.
      closeButtonDisabled={working || saving}
      closeOnEscape={!working && !saving}
      closeOnBackdrop={!working && !saving}
      // With a preset recipient the To field already holds a chip, so focus
      // belongs on Amount; without one it lands on the To field (the body's
      // first focusable).
      initialFocusRef={initialRecipient ? amountRef : undefined}
      panelTestId="delegation-send-modal"
    >
      {step === 'details' && (
        <div className="space-y-4">
          <p className="text-sm text-[var(--v2-ink-2)]">From {fromName}</p>

          <RecipientField
            label="To"
            value={recipient}
            onChange={setRecipient}
            presetAddress={initialRecipient}
            chainId={chainId}
            excludeAddress={accountAddress}
            accounts={accounts}
            contacts={contacts}
            contactsLoading={contactsLoading}
            contactsError={contactsError}
          />

          <div className="space-y-1.5">
            <label htmlFor="send-amount" className="block text-xs font-medium text-[var(--v2-ink-3)]">
              Amount
            </label>
            <div className="flex gap-2">
              <Input
                id="send-amount"
                ref={amountRef}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                className="v2-tabular"
                rightAction={
                  <span className="text-xs font-medium text-[var(--v2-ink-3)]">{token?.symbol}</span>
                }
              />
              {/* Both Haven networks list one sendable token (USDC), so the
                  token Select only appears when a chain lists more than one. */}
              {tokens.length > 1 ? (
                <Select
                  value={tokenSymbol}
                  onChange={(e) => setTokenSymbol(e.target.value)}
                  aria-label="Token"
                  className="w-28 shrink-0"
                >
                  {tokens.map((t) => (
                    <option key={t.symbol} value={t.symbol}>
                      {t.symbol}
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>
          </div>

          <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
            No network fee. You review the payment before you approve it.
          </p>
        </div>
      )}

      {step === 'review' && recipient && token && (
        <div className="space-y-5">
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--v2-ink-3)]">You&apos;re sending</p>
            <p className="v2-tabular text-2xl font-semibold text-[var(--v2-ink)]">
              {amountDisplay} {token.symbol}
            </p>
          </div>

          <DetailList
            items={[
              {
                label: 'To',
                value: (
                  <span className="flex items-start gap-2">
                    <Monogram name={recipient.name ?? recipient.address} size="xs" decorative />
                    <span className="min-w-0">
                      <span className="block">{recipient.name ?? 'New address'}</span>
                      {/* Owner decisions, 2026-11-04. Your own account is checked by
                          its name, so its short address is enough, the full one a
                          hover or tap away. Everything else, a saved contact included,
                          shows the FULL address grouped for comparing, because
                          lookalike scam addresses match the exact characters a short
                          form keeps. */}
                      <span
                        data-testid="review-recipient-address"
                        className="mt-0.5 block text-xs font-normal text-[var(--v2-ink-3)]"
                      >
                        {recipient.name && recipient.kind === 'account' ? (
                          <AddressText value={recipient.address} />
                        ) : (
                          <AddressText value={recipient.address} grouped />
                        )}
                      </span>
                    </span>
                  </span>
                ),
              },
              { label: 'From', value: fromName },
              { label: 'Network', value: chainName },
              { label: 'Network fee', value: 'None. Haven covers it.' },
            ]}
          />

          <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
            A sent payment can&apos;t be reversed. You approve it on the next step.
          </p>

          {message ? (
            message.tone === 'danger' ? (
              <InlineAlert>{message.message}</InlineAlert>
            ) : (
              <p className="text-xs text-[var(--v2-ink-2)]">{message.message}</p>
            )
          ) : null}

          {loadError ? (
            <p className="text-xs text-[var(--v2-ink-3)]">
              Haven could not load how this account approves.{' '}
              <button type="button" className="underline" onClick={() => void reload()}>
                Try again
              </button>
            </p>
          ) : null}
          {loaded && !ready ? (
            // #1097: with the signer set loaded, this is only reachable for
            // owner-only accounts (the optimistic passkey fallback keeps
            // `ready` true otherwise) — the wallet really is the blocker.
            <div className="space-y-2">
              <p className="text-xs text-[var(--v2-ink-3)]">Connect your account owner wallet to send.</p>
              {/* #3812: connect or switch in place (the header pill is gone since #3825). */}
              <WalletConnectAction />
            </div>
          ) : null}
          {ready && passkeyElsewhere ? (
            // #1097: hint on a WORKING send — the ceremony may hand off to the
            // device that holds the passkey.
            <PasskeyElsewhereHint />
          ) : null}
        </div>
      )}

      {step === 'done' && recipient && token && (
        <div className="space-y-4">
          <DialogResult
            state="success"
            title={`${amountDisplay} ${token.symbol} sent`}
            description={`To ${recipient.name ?? truncate(recipient.address)} on ${chainName}.`}
          >
            {explorerUrl ? (
              <p>
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-[var(--v2-brand)] hover:underline"
                >
                  View transaction
                </a>
              </p>
            ) : null}
          </DialogResult>

          {showSaveRow ? (
            <div className="space-y-2 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
              <p className="text-xs font-medium text-[var(--v2-ink-2)]">Save this address as a contact?</p>
              {saveState === 'saved' ? (
                <p className="text-xs text-[var(--v2-ink-2)]">Saved as {savedName}</p>
              ) : saveState === 'already' ? (
                <p className="text-xs text-[var(--v2-ink-2)]">Already saved</p>
              ) : (
                <>
                  <label htmlFor="send-contact-name" className="sr-only">
                    Contact name
                  </label>
                  <Input
                    id="send-contact-name"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    placeholder="Name"
                  />
                  {saveError ? <InlineAlert>{saveError}</InlineAlert> : null}
                  <Button size="sm" onClick={() => void handleSaveContact()} disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  )
}
