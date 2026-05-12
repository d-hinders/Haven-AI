'use client'

import { useState, useEffect, useCallback } from 'react'
import { type Address } from 'viem'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
import { useSendTransaction, type SendStatus } from '@/hooks/useSendTransaction'
import { useActiveSigner } from '@/lib/signer'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { getChainTokens, type SendParams } from '@/lib/safe-tx'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import { truncate, isValidAddress } from '@/lib/format'
import type { BalanceItem, SafeDetails } from '@/types/transactions'
import type { Contact } from '@/hooks/useContacts'
import NetworkGate from './NetworkGate'
import PasskeyOtherDeviceNotice from './PasskeyOtherDeviceNotice'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { StatusBadge } from '@/components/ui/StatusBadge'
import {
  ApprovalRequiredBanner,
  ExternalDetailsLink,
  TransactionMovement,
} from '@/components/haven'

interface SendSafeOption {
  id: string
  name: string
  address: string
  chainId: number
  isDefault: boolean
}

function SendDetail({
  label,
  value,
  subValue,
  copyValue,
  copyLabel,
  mono = false,
  subMono = false,
}: {
  label: string
  value: string
  subValue?: string
  copyValue?: string
  copyLabel?: string
  mono?: boolean
  subMono?: boolean
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium text-[var(--v2-ink-3)]">{label}</dt>
      <dd className={`mt-1 truncate text-sm font-medium text-[var(--v2-ink)] ${mono ? 'font-mono' : ''}`}>
        {value}
      </dd>
      {subValue && (
        <dd className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <span className={`truncate text-[11px] text-[var(--v2-ink-3)] ${subMono ? 'font-mono' : ''}`}>
            {subValue}
          </span>
          {copyValue && (
            <button
              type="button"
              aria-label={copyLabel ?? `Copy ${label.toLowerCase()}`}
              onClick={() => { void navigator.clipboard?.writeText(copyValue) }}
              className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 8.25V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.25" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 10a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8Z" />
              </svg>
            </button>
          )}
        </dd>
      )}
    </div>
  )
}

function ResultIcon({ tone }: { tone: 'success' | 'warning' | 'danger' }) {
  const toneClass =
    tone === 'success'
      ? 'border-[var(--v2-success)]/20 bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
      : tone === 'warning'
        ? 'border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]'
        : 'border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]'

  return (
    <div className={`mb-5 flex h-14 w-14 items-center justify-center rounded-full border ${toneClass}`}>
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={tone === 'warning' ? 1.5 : 2}>
        {tone === 'success' ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        ) : tone === 'warning' ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        )}
      </svg>
    </div>
  )
}

// ── Props ────────────────────────────────────────────────────────────
interface SendModalProps {
  open: boolean
  onClose: () => void
  safeAddress: string
  safeName?: string
  safeDetails: SafeDetails | null
  balances: BalanceItem[]
  onSuccess?: () => void
  contacts?: Contact[]
  contactsError?: string | null
  resolveAddress?: (address: string) => string | null
  chainId?: number
  safeOptions?: SendSafeOption[]
  selectedSafeOptionId?: string
  onSelectSafeOption?: (safeId: string) => void
  contextLoading?: boolean
  contextError?: string | null
}

// ── Component ────────────────────────────────────────────────────────
export default function SendModal({
  open,
  onClose,
  safeAddress,
  safeName,
  safeDetails,
  balances,
  onSuccess,
  contacts = [],
  contactsError = null,
  resolveAddress,
  chainId = 100,
  safeOptions = [],
  selectedSafeOptionId,
  onSelectSafeOption,
  contextLoading = false,
  contextError = null,
}: SendModalProps) {
  const safeAddressForHooks = safeAddress as Address
  const { status, txHash, error, send, reset } = useSendTransaction({
    safeAddress: safeAddressForHooks,
    chainId,
  })
  const signer = useActiveSigner({
    safeAddress: safeAddressForHooks,
    chainId,
  })
  const operationGate = useSafeOperationGate({
    safeAddress: safeAddressForHooks,
    chainId,
  })
  const blockedByOtherDevice = operationGate.kind === 'passkey_on_other_device'
  const needsConnectedWallet = operationGate.kind === 'no_signer'
  const signingUnavailable = blockedByOtherDevice || needsConnectedWallet

  // Build token list from chain config
  const chainConfig = getChainConfig(chainId)
  const chainTokens = getChainTokens(chainId)
  const tokenList = Object.entries(chainTokens).map(([symbol, cfg]) => ({
    symbol,
    label: symbol,
    sub: cfg.address === null ? 'Native' : symbol,
  }))
  const defaultToken = tokenList[0]?.symbol ?? ''
  // Native gas token (symbol of the token with null address) for the gas-payer label.
  const gasTokenSymbol =
    Object.entries(chainTokens).find(([, cfg]) => cfg.address === null)?.[0] ?? ''

  // Form state
  const [selectedToken, setSelectedToken] = useState<string>(defaultToken)
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [selectedContactName, setSelectedContactName] = useState<string | null>(null)
  const [formError, setFormError] = useState('')
  const [step, setStep] = useState<'form' | 'review' | 'executing' | 'result'>('form')
  const [showContactPicker, setShowContactPicker] = useState(false)
  const [contactSearch, setContactSearch] = useState('')

  // Escape-to-close (disabled during execution so the user can't abandon a
  // signing flow by tapping a key).
  useEscapeToClose(open, onClose, { enabled: step !== 'executing' })

  const filteredContacts = contacts.filter(
    (c) =>
      c.name.toLowerCase().includes(contactSearch.toLowerCase()) ||
      c.address.toLowerCase().includes(contactSearch.toLowerCase()),
  )
  const quickContacts = contacts.slice(0, 3)

  // Get balance for selected token
  const tokenBalance = balances.find(
    (b) => b.symbol.toLowerCase() === selectedToken.toLowerCase(),
  )
  const amountWarning =
    amount && tokenBalance && parseFloat(amount) > parseFloat(tokenBalance.formatted)
      ? `This amount is higher than your available balance of ${tokenBalance.formatted} ${selectedToken}.`
      : ''
  const tokenConfig = chainTokens[selectedToken]
  const selectedSafeOption =
    safeOptions.find((safe) => safe.id === selectedSafeOptionId) ?? null
  const walletName = selectedSafeOption?.name ?? safeName ?? 'Haven wallet'
  const recipientLabel = selectedContactName ?? truncate(recipient)
  const recipientDetailSubValue = selectedContactName ? truncate(recipient) : undefined
  const threshold = safeDetails?.threshold ?? 1
  const isMultiSig = threshold > 1
  const gasPaidByLabel =
    signer?.type === 'passkey'
      ? `Haven${gasTokenSymbol ? ` (${gasTokenSymbol})` : ''}`
      : `Your wallet${gasTokenSymbol ? ` (${gasTokenSymbol})` : ''}`
  const approvalMethodLabel =
    signer?.type === 'passkey'
      ? 'Device approval'
      : signer?.type === 'eoa'
        ? 'Your wallet'
        : 'Approval method'
  const progressHelp =
    status === 'building'
      ? 'Reading account status...'
      : status === 'signing'
        ? signer?.type === 'passkey'
          ? 'Approve this payment with your device.'
          : 'Approve this payment in your wallet.'
        : status === 'executing'
          ? isMultiSig
            ? 'Submitting this payment for approval.'
            : 'Sending this payment from your Haven wallet.'
          : null

  // Reset everything when the modal opens or the selected account changes.
  useEffect(() => {
    if (open) {
      setSelectedToken(defaultToken)
      setAmount('')
      setRecipient('')
      setSelectedContactName(null)
      setFormError('')
      setStep('form')
      setShowContactPicker(false)
      setContactSearch('')
      reset()
    }
  }, [defaultToken, open, reset, safeAddress])

  // Track send status to update step
  useEffect(() => {
    if (status === 'confirmed' || status === 'proposed') {
      setStep('result')
    }
    if (status === 'error') {
      // Stay on executing step to show error with retry
      setStep('result')
    }
  }, [status])

  // ── Validation ───────────────────────────────────────────────────
  const validate = useCallback((): boolean => {
    if (!amount || parseFloat(amount) <= 0) {
      setFormError('Enter an amount greater than 0')
      return false
    }

    if (tokenBalance) {
      const bal = parseFloat(tokenBalance.formatted)
      const amt = parseFloat(amount)
      if (amt > bal) {
        setFormError(`Insufficient balance. You have ${tokenBalance.formatted} ${selectedToken}`)
        return false
      }
    }

    if (!recipient) {
      setFormError('Enter a recipient address')
      return false
    }

    if (!isValidAddress(recipient)) {
      setFormError('Enter a valid wallet address')
      return false
    }

    if (recipient.toLowerCase() === safeAddress.toLowerCase()) {
      setFormError('Cannot send to the same account address')
      return false
    }

    setFormError('')
    return true
  }, [amount, recipient, safeAddress, selectedToken, tokenBalance])

  // ── Actions ──────────────────────────────────────────────────────
  const handleReview = () => {
    if (contextLoading || !safeDetails) {
      setFormError('Account details are still loading. Please wait a moment.')
      return
    }
    if (contextError) {
      setFormError('Could not load this account. Try again in a moment.')
      return
    }
    if (needsConnectedWallet) {
      setFormError('Connect wallet to send from this account.')
      return
    }
    if (validate()) setStep('review')
  }

  const handleConfirm = async () => {
    if (needsConnectedWallet) {
      setFormError('Connect wallet to send from this account.')
      return
    }
    if (blockedByOtherDevice || !signer || !tokenConfig) return

    setStep('executing')

    const params: SendParams = {
      token: selectedToken,
      tokenAddress: tokenConfig.address as Address | null,
      decimals: tokenConfig.decimals,
      amount,
      recipient: recipient as Address,
    }

    await send(params, safeAddress as Address, threshold, signer.address, chainId)
  }

  const handleDone = () => {
    onSuccess?.()
    onClose()
  }

  const handleRequestClose = () => {
    if (step === 'result' && (status === 'confirmed' || status === 'proposed')) {
      handleDone()
      return
    }

    onClose()
  }

  const handleSelectContact = (contact: Contact) => {
    setRecipient(contact.address)
    setSelectedContactName(contact.name)
    setShowContactPicker(false)
    setContactSearch('')
    setFormError('')
  }

  const handleRecipientChange = (value: string) => {
    setRecipient(value)
    setSelectedContactName(resolveAddress?.(value) ?? null)
    setFormError('')
  }

  // ── Don't render if closed ───────────────────────────────────────
  if (!open) return null

  // ── Status labels ────────────────────────────────────────────────
  const statusLabel: Record<SendStatus, string> = {
    idle: '',
    building: 'Preparing payment...',
    signing:
      signer?.type === 'passkey' ? 'Waiting for device approval...' : 'Waiting for wallet approval...',
    executing: isMultiSig ? 'Submitting for approval...' : `Sending on ${getChainConfig(chainId).name}...`,
    confirmed: 'Payment sent',
    proposed: 'Payment submitted',
    error: 'Payment failed',
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 v2-modal-backdrop"
        onClick={step === 'executing' ? undefined : handleRequestClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 max-h-[calc(100vh-2rem)] overflow-y-auto bg-white border border-[var(--v2-border)] rounded-xl shadow-[var(--v2-shadow-modal)]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--v2-border)]">
          <h2 className="text-base font-semibold text-[var(--v2-ink)]">
            {step === 'form' && 'Send payment'}
            {step === 'review' && 'Review payment'}
            {step === 'executing' && 'Processing'}
            {step === 'result' && (status === 'error' ? 'Payment failed' : 'Payment complete')}
          </h2>
          {step !== 'executing' && (
            <button
              onClick={handleRequestClose}
              aria-label="Close"
              className="p-1 -mr-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* ── STEP 1: Form ────────────────────────────────────────── */}
        {step === 'form' && (
          <div className="p-6 space-y-5">
            {safeOptions.length > 0 && (
              <div>
                <label className="block text-xs text-[var(--v2-ink-2)] mb-2">
                  Send from
                </label>
                <div className="space-y-2">
                  {safeOptions.length === 1 && selectedSafeOption ? (
                    <div className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-sm font-medium text-[var(--v2-ink)]">
                          {selectedSafeOption.name}
                        </span>
                        {selectedSafeOption.isDefault && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--v2-brand-soft)] text-[var(--v2-brand)] font-medium">
                            Default
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[11px] text-[var(--v2-ink-3)]">
                          {getChainConfig(selectedSafeOption.chainId).name}
                        </span>
                        <span className="text-[11px] text-[var(--v2-ink-3)] font-mono">
                          {truncate(selectedSafeOption.address)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    safeOptions.map((safe) => {
                      const isSelected = safe.id === selectedSafeOptionId
                      return (
                        <button
                          key={safe.id}
                          type="button"
                          onClick={() => onSelectSafeOption?.(safe.id)}
                          className={`w-full rounded-lg border px-4 py-3 text-left transition-all duration-150 ${
                            isSelected
                              ? 'border-[var(--v2-brand)]/50 bg-[var(--v2-brand-soft)]'
                              : 'border-[var(--v2-border)] bg-[var(--v2-surface)] hover:border-[var(--v2-border-strong)]'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className={`text-sm font-medium ${isSelected ? 'text-[var(--v2-brand)]' : 'text-[var(--v2-ink)]'}`}>
                              {safe.name}
                            </span>
                            {safe.isDefault && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                isSelected
                                  ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
                                  : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)]'
                              }`}>
                                Default
                              </span>
                            )}
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-[11px] text-[var(--v2-ink-3)]">
                              {getChainConfig(safe.chainId).name}
                            </span>
                            <span className="text-[11px] text-[var(--v2-ink-3)] font-mono">
                              {truncate(safe.address)}
                            </span>
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )}

            {(contextLoading || contextError) && (
              <div className={`rounded-lg px-4 py-3 text-xs border ${
                contextError
                  ? 'text-[var(--v2-danger)] bg-[var(--v2-danger-soft)] border-[var(--v2-danger)]/20'
                  : 'text-[var(--v2-ink-2)] bg-[var(--v2-surface)] border-[var(--v2-border)]'
              }`}>
                {contextError
                  ? 'We could not load this account right now. Try again in a moment.'
                  : 'Loading this account’s balances and approval details...'}
              </div>
            )}

            {/* Token selector */}
            <div>
              <label className="block text-xs text-[var(--v2-ink-2)] mb-2">Token</label>
              <div className="grid grid-cols-3 gap-2">
                {tokenList.map((t) => {
                  const bal = balances.find(
                    (b) => b.symbol.toLowerCase() === t.symbol.toLowerCase(),
                  )
                  const isActive = selectedToken === t.symbol
                  return (
                    <button
                      key={t.symbol}
                      onClick={() => { setSelectedToken(t.symbol); setFormError('') }}
                      className={`p-3 rounded-lg border text-left transition-all duration-150 ${
                        isActive
                          ? 'border-[var(--v2-brand)]/50 bg-[var(--v2-brand-soft)]'
                          : 'border-[var(--v2-border)] bg-[var(--v2-surface)] hover:border-[var(--v2-border-strong)]'
                      }`}
                    >
                      <span className={`block text-sm font-medium ${isActive ? 'text-[var(--v2-brand)]' : 'text-[var(--v2-ink)]'}`}>
                        {t.label}
                      </span>
                      <span className="block text-[11px] text-[var(--v2-ink-3)] mt-0.5">
                        {bal ? bal.formatted : '0.00'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Amount */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-[var(--v2-ink-2)]">Amount</label>
                {tokenBalance && (
                  <button
                    onClick={() => setAmount(tokenBalance.formatted)}
                    className="text-[11px] text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
                  >
                    Max: {tokenBalance.formatted}
                  </button>
                )}
              </div>
              <div className="relative">
                <Input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => {
                    const v = e.target.value
                    // Allow numbers and one decimal point
                    if (/^\d*\.?\d*$/.test(v)) {
                      setAmount(v)
                      setFormError('')
                    }
                  }}
                  placeholder="0.00"
                  className={`py-3 pr-16 bg-[var(--v2-surface-2)] rounded-lg font-mono ${
                    amountWarning
                      ? 'border-[var(--v2-danger)]/30 focus:border-[var(--v2-danger)]/40 focus:ring-[var(--v2-danger)]/20'
                      : ''
                  }`}
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-[var(--v2-ink-3)]">
                  {selectedToken}
                </span>
              </div>
              {amountWarning && (
                <p className="mt-2 text-xs text-[var(--v2-danger)]">
                  {amountWarning}
                </p>
              )}
            </div>

            {/* Recipient */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label htmlFor="send-recipient" className="text-xs text-[var(--v2-ink-2)]">Recipient</label>
                {contacts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => { setShowContactPicker((v) => !v); setContactSearch('') }}
                    className="text-[11px] text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors flex items-center gap-1"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                    </svg>
                    Saved recipients
                  </button>
                )}
              </div>

              <div className="relative">
                {/* Selected contact badge */}
                {selectedContactName && (
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-[var(--v2-brand-soft)] border border-[var(--v2-brand)]/20 rounded-md">
                      <div className="w-4 h-4 rounded-full bg-[var(--v2-brand-soft)] flex items-center justify-center">
                        <span className="text-[9px] font-semibold text-[var(--v2-brand)]">
                          {selectedContactName.slice(0, 2).toUpperCase()}
                        </span>
                      </div>
                      <span className="text-xs text-[var(--v2-brand)]">{selectedContactName}</span>
                      <button
                        type="button"
                        onClick={() => { setSelectedContactName(null); setRecipient('') }}
                        className="text-[var(--v2-brand)]/60 hover:text-[var(--v2-brand-strong)] ml-0.5"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )}

                <Input
                  id="send-recipient"
                  type="text"
                  value={recipient}
                  onChange={(e) => handleRecipientChange(e.target.value)}
                  placeholder="Paste address or choose a saved recipient"
                  className="py-3 bg-[var(--v2-surface-2)] rounded-lg font-mono"
                />
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--v2-ink-3)]">
                  This payment will be sent on <span className="font-medium text-[var(--v2-ink-2)]">{chainConfig.name}</span>.
                  Make sure the recipient accepts funds on this network.
                </p>
              </div>

              {contactsError && (
                <div className="mt-3 rounded-lg border border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)] px-3 py-2.5 text-xs leading-relaxed text-[var(--v2-warning)]">
                  Saved recipients could not load. You can still paste a recipient address.
                </div>
              )}

              {!contactsError && contacts.length === 0 && (
                <div className="mt-3 rounded-lg border border-[var(--v2-border)] bg-white px-3 py-3 text-xs leading-relaxed text-[var(--v2-ink-2)] shadow-[var(--v2-shadow-card)]">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span>No saved recipients yet. Add contacts for people or services you pay often.</span>
                    <Button href="/contacts" variant="ghost" size="sm" className="sm:flex-shrink-0">
                      Add contacts
                    </Button>
                  </div>
                </div>
              )}

              {contacts.length > 0 && !showContactPicker && (
                <div className="mt-3">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="text-[11px] text-[var(--v2-ink-3)]">
                      Quick select
                    </p>
                    {contacts.length > quickContacts.length && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowContactPicker(true)
                          setContactSearch('')
                        }}
                        className="text-[11px] text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
                      >
                        Browse all contacts
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {quickContacts.map((contact) => {
                      const isSelected = contact.address.toLowerCase() === recipient.toLowerCase()
                      return (
                        <button
                          key={contact.id}
                          type="button"
                          onClick={() => handleSelectContact(contact)}
                          className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
                            isSelected
                              ? 'border-[var(--v2-brand)]/40 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
                              : 'border-[var(--v2-border)] bg-[var(--v2-surface)] text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)]'
                          }`}
                        >
                          <span className="w-5 h-5 rounded-full bg-[var(--v2-brand-soft)] text-[10px] font-semibold text-[var(--v2-brand)] flex items-center justify-center">
                            {contact.name.slice(0, 2).toUpperCase()}
                          </span>
                          <span className="text-xs font-medium">{contact.name}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {contacts.length > 0 && showContactPicker && (
                <div className="mt-3 rounded-xl border border-[var(--v2-border)] bg-white overflow-hidden">
                  <div className="flex items-center justify-between gap-3 px-3 py-3 border-b border-[var(--v2-border)]">
                    <p className="text-xs font-medium text-[var(--v2-ink)]">
                      Choose a contact
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setShowContactPicker(false)
                        setContactSearch('')
                      }}
                      className="text-[11px] text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] transition-colors"
                    >
                      Close
                    </button>
                  </div>
                  <div className="p-3 border-b border-[var(--v2-border)]">
                    <label htmlFor="saved-recipient-search" className="sr-only">Search saved recipients</label>
                    <input
                      id="saved-recipient-search"
                      type="text"
                      autoFocus
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                      placeholder="Search saved recipients"
                      className="w-full px-3 py-2 bg-[var(--v2-surface-2)] border border-[var(--v2-border)] rounded-md text-xs text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-[var(--v2-brand)]/40"
                    />
                  </div>
                  <div className="max-h-52 overflow-y-auto">
                    {filteredContacts.length === 0 ? (
                      <p className="text-xs text-[var(--v2-ink-3)] text-center py-4">
                        No contacts found
                      </p>
                    ) : (
                      filteredContacts.map((contact) => {
                        const isSelected = contact.address.toLowerCase() === recipient.toLowerCase()
                        return (
                          <button
                            key={contact.id}
                            type="button"
                            onClick={() => handleSelectContact(contact)}
                            className={`w-full flex items-center gap-2.5 px-3 py-3 transition-colors text-left ${
                              isSelected
                                ? 'bg-[var(--v2-brand-soft)]'
                                : 'hover:bg-[var(--v2-surface-2)]'
                            }`}
                          >
                            <div className="w-7 h-7 rounded-full bg-[var(--v2-brand-soft)] flex items-center justify-center flex-shrink-0">
                              <span className="text-[10px] font-semibold text-[var(--v2-brand)]">
                                {contact.name.slice(0, 2).toUpperCase()}
                              </span>
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium text-[var(--v2-ink)] truncate">
                                {contact.name}
                              </p>
                              <p className="text-[10px] text-[var(--v2-ink-3)] font-mono">
                                {contact.address.slice(0, 6)}...{contact.address.slice(-4)}
                              </p>
                            </div>
                            {isSelected && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--v2-brand-soft)] text-[var(--v2-brand)] font-medium">
                                Selected
                              </span>
                            )}
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Error */}
            {blockedByOtherDevice && (
              <PasskeyOtherDeviceNotice />
            )}

            {needsConnectedWallet && (
              <div className="rounded-lg border border-[var(--v2-border)] bg-white px-4 py-3 text-sm text-[var(--v2-ink-2)] shadow-[var(--v2-shadow-card)]">
                Connect wallet to send from this account.
              </div>
            )}

            {formError && (
              <div className="text-sm text-[var(--v2-danger)] bg-[var(--v2-danger-soft)] border border-[var(--v2-danger)]/20 rounded-lg px-4 py-3">
                {formError}
              </div>
            )}

            {/* Multi-sig notice */}
            {isMultiSig && (
              <ApprovalRequiredBanner title="Additional approval required" tone="neutral" density="compact">
                This Haven account needs {threshold} approvals. This payment will be submitted for approval before it can be sent.
              </ApprovalRequiredBanner>
            )}

            {/* Continue button */}
            <Button
              onClick={handleReview}
              disabled={!amount || !recipient || contextLoading || !!contextError || !safeDetails || signingUnavailable}
              className="w-full"
            >
              Continue
            </Button>
          </div>
        )}

        {/* ── STEP 2: Review ──────────────────────────────────────── */}
        {step === 'review' && (
          <div className="p-6 space-y-5">
            <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-[var(--v2-ink-3)]">You are sending</p>
                  <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
                    {amount} {selectedToken}
                  </p>
                </div>
                <StatusBadge tone="neutral">
                  {isMultiSig ? 'Needs approval' : 'Ready to send'}
                </StatusBadge>
              </div>

              <div className="mt-5 rounded-[10px] border border-[var(--v2-border)] bg-white p-4">
                <TransactionMovement from={walletName} to={recipientLabel} />
                <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                  <SendDetail label="Haven wallet" value={walletName} />
                  <SendDetail
                    label="Recipient"
                    value={recipientLabel}
                    subValue={recipientDetailSubValue}
                    copyValue={selectedContactName ? recipient : undefined}
                    copyLabel="Copy recipient address"
                    subMono
                  />
                  <SendDetail label="Network" value={getChainConfig(chainId).name} />
                  <SendDetail label="Approve with" value={approvalMethodLabel} />
                </dl>
              </div>
            </div>

            <p className="text-xs text-[var(--v2-ink-3)]">
              Network fees are paid by {gasPaidByLabel}.
            </p>

            {isMultiSig && (
              <ApprovalRequiredBanner title="Payment will wait for approval" tone="neutral" density="compact">
                This Haven account needs {threshold} approvals. After you approve, the payment will wait for the remaining approval before money moves.
              </ApprovalRequiredBanner>
            )}

            {blockedByOtherDevice && (
              <PasskeyOtherDeviceNotice />
            )}

            {needsConnectedWallet && (
              <div className="rounded-lg border border-[var(--v2-border)] bg-white px-4 py-3 text-sm text-[var(--v2-ink-2)] shadow-[var(--v2-shadow-card)]">
                Connect wallet to send from this account.
              </div>
            )}

            <div className="flex gap-3">
              <Button
                variant="ghost"
                onClick={() => setStep('form')}
                className="flex-1"
              >
                Back
              </Button>
              <div className="flex-1">
                <NetworkGate requiredChainId={chainId}>
                  <Button
                    onClick={handleConfirm}
                    disabled={signingUnavailable || !signer || !tokenConfig}
                    className="w-full"
                  >
                    {isMultiSig ? 'Approve and submit' : 'Approve and send'}
                  </Button>
                </NetworkGate>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 3: Executing ───────────────────────────────────── */}
        {step === 'executing' && (
          <div className="p-6 flex flex-col items-center justify-center py-12">
            {/* Spinner */}
            <div className="relative mb-6">
              <div className="w-14 h-14 rounded-full border-2 border-[var(--v2-border)]" />
              <div className="absolute inset-0 w-14 h-14 rounded-full border-2 border-transparent border-t-[var(--v2-brand)] animate-spin" />
            </div>
            <p className="text-sm text-[var(--v2-ink)] mb-1">{statusLabel[status]}</p>
            {progressHelp && (
              <p className="text-xs text-[var(--v2-ink-3)]">{progressHelp}</p>
            )}
          </div>
        )}

        {/* ── STEP 4: Result ──────────────────────────────────────── */}
        {step === 'result' && (
          <div className="p-6 flex flex-col items-center py-10">
            {status === 'confirmed' && (
              <>
                <ResultIcon tone="success" />
                <p className="text-base font-semibold text-[var(--v2-ink)] mb-1">Payment sent</p>
                <p className="text-xs text-[var(--v2-ink-3)] mb-5 text-center">
                  {amount} {selectedToken} was sent from {walletName} to {recipientLabel}.
                </p>
                {txHash && (
                  <div className="mb-6 flex items-center gap-2 text-xs text-[var(--v2-ink-3)]">
                    <span>Payment receipt</span>
                    <ExternalDetailsLink
                      href={getExplorerUrl(chainId, 'tx', txHash)}
                      label="Open payment externally"
                    />
                  </div>
                )}
                <Button
                  onClick={handleDone}
                  className="w-full"
                >
                  Done
                </Button>
              </>
            )}

            {status === 'proposed' && (
              <>
                <ResultIcon tone="warning" />
                <p className="text-base font-semibold text-[var(--v2-ink)] mb-1">Payment submitted</p>
                <p className="text-xs text-[var(--v2-ink-3)] mb-2 text-center">
                  {amount} {selectedToken} from {walletName} to {recipientLabel}.
                </p>
                <p className="text-xs text-[var(--v2-ink-3)] mb-5 text-center">
                  No money has moved yet. This payment needs {threshold - 1} more approval{threshold - 1 !== 1 ? 's' : ''} before it can be sent.
                </p>
                <a
                  href={`https://app.safe.global/transactions/queue?safe=${chainConfig.shortName}:${safeAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Opens app.safe.global"
                  className="mb-6 inline-flex items-center gap-1 text-xs text-[var(--v2-brand)] transition-colors hover:text-[var(--v2-brand-strong)]"
                >
                  View advanced approval details
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                  </svg>
                </a>
                <Button
                  onClick={handleDone}
                  className="w-full"
                >
                  Done
                </Button>
              </>
            )}

            {status === 'error' && (
              <>
                <ResultIcon tone="danger" />
                <p className="text-base font-semibold text-[var(--v2-ink)] mb-1">Payment was not sent</p>
                <p className="text-xs text-[var(--v2-ink-3)] mb-6 text-center max-w-xs">
                  {error ?? 'Check your approval method, then try again.'}
                </p>
                <div className="flex gap-3 w-full">
                  <Button
                    variant="ghost"
                    onClick={onClose}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => { reset(); setStep('form') }}
                    className="flex-1"
                  >
                    Try again
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
