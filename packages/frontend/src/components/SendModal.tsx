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
import { SigningStatus } from './SigningStatus'

interface SendSafeOption {
  id: string
  name: string
  address: string
  chainId: number
  isDefault: boolean
}

// ── Props ────────────────────────────────────────────────────────────
interface SendModalProps {
  open: boolean
  onClose: () => void
  safeAddress: string
  safeDetails: SafeDetails | null
  balances: BalanceItem[]
  onSuccess?: () => void
  contacts?: Contact[]
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
  safeDetails,
  balances,
  onSuccess,
  contacts = [],
  resolveAddress,
  chainId = 100,
  safeOptions = [],
  selectedSafeOptionId,
  onSelectSafeOption,
  contextLoading = false,
  contextError = null,
}: SendModalProps) {
  const { status, txHash, error, send, reset } = useSendTransaction()
  const signer = useActiveSigner({
    safeAddress: safeAddress ? (safeAddress as Address) : undefined,
    chainId,
  })
  const operationGate = useSafeOperationGate({
    safeAddress: safeAddress ? (safeAddress as Address) : undefined,
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
  const threshold = safeDetails?.threshold ?? 1
  const isMultiSig = threshold > 1
  const gasPaidByLabel =
    signer?.type === 'passkey'
      ? `Haven${gasTokenSymbol ? ` (${gasTokenSymbol})` : ''}`
      : `Your signing wallet${gasTokenSymbol ? ` (${gasTokenSymbol})` : ''}`

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
      setFormError('Invalid Ethereum address')
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

  const handleSelectContact = (contact: Contact) => {
    setRecipient(contact.address)
    setSelectedContactName(contact.name)
    setShowContactPicker(false)
    setContactSearch('')
    setFormError('')
  }

  // ── Don't render if closed ───────────────────────────────────────
  if (!open) return null

  // ── Status labels ────────────────────────────────────────────────
  const statusLabel: Record<SendStatus, string> = {
    idle: '',
    building: 'Preparing transaction...',
    signing:
      signer?.type === 'passkey' ? 'Waiting for Face ID or Touch ID...' : 'Waiting for wallet approval...',
    executing: isMultiSig ? 'Submitting proposal...' : `Confirming on ${getChainConfig(chainId).name}...`,
    confirmed: 'Transaction confirmed!',
    proposed: 'Transaction proposed!',
    error: 'Transaction failed',
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[var(--v2-ink)]/50 backdrop-blur-sm"
        onClick={step === 'executing' ? undefined : onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 bg-white border border-[var(--v2-border)] rounded-xl shadow-[var(--v2-shadow-modal)] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--v2-border)]">
          <h2 className="text-base font-semibold text-[var(--v2-ink)]">
            {step === 'form' && 'Send tokens'}
            {step === 'review' && 'Review transaction'}
            {step === 'executing' && 'Processing'}
            {step === 'result' && (status === 'error' ? 'Failed' : 'Complete')}
          </h2>
          {step !== 'executing' && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1 -mr-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
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
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/10 text-[var(--v2-brand)] font-medium">
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
                              ? 'border-indigo-500/50 bg-indigo-500/10'
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
                                  ? 'bg-indigo-400/15 text-[var(--v2-brand)]'
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
                  ? 'text-red-400 bg-red-400/10 border-red-400/20'
                  : 'text-[var(--v2-ink-2)] bg-[var(--v2-surface)] border-[var(--v2-border)]'
              }`}>
                {contextError
                  ? 'We could not load this account right now. Try again in a moment.'
                  : 'Loading this account’s balances and signing details...'}
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
                          ? 'border-indigo-500/50 bg-indigo-500/10'
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
                <input
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
                  className={`w-full px-4 py-3 pr-16 bg-[var(--v2-surface-2)] border rounded-lg text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:ring-1 transition-colors font-mono ${
                    amountWarning
                      ? 'border-red-400/30 focus:border-red-400/40 focus:ring-red-400/20'
                      : 'border-[var(--v2-border)] focus:border-indigo-500/50 focus:ring-indigo-500/30'
                  }`}
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-[var(--v2-ink-3)]">
                  {selectedToken}
                </span>
              </div>
              {amountWarning && (
                <p className="mt-2 text-xs text-red-400">
                  {amountWarning}
                </p>
              )}
            </div>

            {/* Recipient */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-[var(--v2-ink-2)]">Recipient</label>
                {contacts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => { setShowContactPicker((v) => !v); setContactSearch('') }}
                    className="text-[11px] text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors flex items-center gap-1"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                    </svg>
                    Contacts
                  </button>
                )}
              </div>

              <div className="relative">
                {/* Selected contact badge */}
                {selectedContactName && (
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-indigo-500/10 border border-indigo-500/20 rounded-md">
                      <div className="w-4 h-4 rounded-full bg-indigo-500/20 flex items-center justify-center">
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

                <input
                  type="text"
                  value={recipient}
                  onChange={(e) => {
                    setRecipient(e.target.value)
                    setSelectedContactName(resolveAddress?.(e.target.value) ?? null)
                    setFormError('')
                  }}
                  placeholder="0x..."
                  className="w-full px-4 py-3 bg-[var(--v2-surface-2)] border border-[var(--v2-border)] rounded-lg text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors font-mono"
                />
              </div>

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
                              ? 'border-indigo-500/40 bg-indigo-500/12 text-[var(--v2-brand)]'
                              : 'border-[var(--v2-border)] bg-[var(--v2-surface)] text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)]'
                          }`}
                        >
                          <span className="w-5 h-5 rounded-full bg-indigo-500/15 text-[10px] font-semibold text-[var(--v2-brand)] flex items-center justify-center">
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
                    <input
                      type="text"
                      autoFocus
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                      placeholder="Search contacts..."
                      className="w-full px-3 py-2 bg-[var(--v2-surface-2)] border border-[var(--v2-border)] rounded-md text-xs text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-indigo-500/40"
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
                                ? 'bg-indigo-500/10'
                                : 'hover:bg-[var(--v2-surface-2)]'
                            }`}
                          >
                            <div className="w-7 h-7 rounded-full bg-indigo-500/15 flex items-center justify-center flex-shrink-0">
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
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-[var(--v2-brand)] font-medium">
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
              <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">
                {formError}
              </div>
            )}

            {/* Multi-sig notice */}
            {isMultiSig && (
              <div className="text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/20 rounded-lg px-4 py-3">
                This account requires {threshold} of {safeDetails?.owners.length ?? '?'} approvals.
                Haven will submit your approval as a proposal.
              </div>
            )}

            {/* Continue button */}
            <button
              onClick={handleReview}
              disabled={!amount || !recipient || contextLoading || !!contextError || !safeDetails || signingUnavailable}
              className="w-full py-3 rounded-lg bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-colors shadow-[var(--v2-shadow-button)] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
            >
              Continue
            </button>
          </div>
        )}

        {/* ── STEP 2: Review ──────────────────────────────────────── */}
        {step === 'review' && (
          <div className="p-6 space-y-5">
            <div className="space-y-4 bg-[var(--v2-surface)] rounded-lg p-4 border border-[var(--v2-border)]">
              <div className="flex justify-between items-center">
                <span className="text-xs text-[var(--v2-ink-3)]">Sending</span>
                <span className="text-sm font-medium text-[var(--v2-ink)] font-mono">
                  {amount} {selectedToken}
                </span>
              </div>
              <div className="h-px bg-[var(--v2-surface-2)]" />
              <div className="flex justify-between items-start">
                <span className="text-xs text-[var(--v2-ink-3)]">To</span>
                <div className="text-right">
                  {selectedContactName && (
                    <p className="text-sm font-medium text-[var(--v2-ink)] mb-0.5">{selectedContactName}</p>
                  )}
                  <span className="text-sm text-[var(--v2-ink-2)] font-mono">
                    {truncate(recipient)}
                    <button
                      onClick={() => navigator.clipboard.writeText(recipient)}
                      className="ml-2 text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] transition-colors inline"
                    >
                      <svg className="w-3 h-3 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                      </svg>
                    </button>
                  </span>
                </div>
              </div>
              <div className="h-px bg-[var(--v2-surface-2)]" />
              <div className="flex justify-between items-center">
                <span className="text-xs text-[var(--v2-ink-3)]">From account</span>
                <div className="text-right">
                  {selectedSafeOption && (
                    <p className="text-sm font-medium text-[var(--v2-ink)] mb-0.5">
                      {selectedSafeOption.name}
                    </p>
                  )}
                  <span className="text-sm text-[var(--v2-ink-2)] font-mono">
                    {truncate(safeAddress)}
                  </span>
                </div>
              </div>
              <div className="h-px bg-[var(--v2-surface-2)]" />
              <div className="flex justify-between items-center">
                <span className="text-xs text-[var(--v2-ink-3)]">Network</span>
                <span className="text-sm text-[var(--v2-ink-2)]">{getChainConfig(chainId).name}</span>
              </div>
            </div>

            <p className="text-[11px] text-[var(--v2-ink-3)]">
              Gas paid by {gasPaidByLabel}.
            </p>

            {isMultiSig && (
              <div className="text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/20 rounded-lg px-4 py-3">
                This will propose the transaction. It needs {threshold} of {safeDetails?.owners.length ?? '?'} owner approvals before execution.
              </div>
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
              <button
                onClick={() => setStep('form')}
                className="flex-1 py-3 rounded-lg border border-[var(--v2-border)] text-sm text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors"
              >
                Back
              </button>
              <div className="flex-1">
                <NetworkGate requiredChainId={chainId}>
                  <button
                    onClick={handleConfirm}
                    disabled={signingUnavailable || !signer || !tokenConfig}
                    className="w-full py-3 rounded-lg bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-colors shadow-[var(--v2-shadow-button)] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
                  >
                    {isMultiSig ? 'Approve proposal' : 'Approve and send'}
                  </button>
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
              <div className="absolute inset-0 w-14 h-14 rounded-full border-2 border-transparent border-t-indigo-500 animate-spin" />
            </div>
            <p className="text-sm text-[var(--v2-ink)] mb-1">{statusLabel[status]}</p>
            {status === 'building' ? (
              <p className="text-xs text-[var(--v2-ink-3)]">Reading account status...</p>
            ) : status === 'signing' || status === 'executing' ? (
              <div className="text-xs text-[var(--v2-ink-3)]">
                <SigningStatus signer={signer} stage={status} />
              </div>
            ) : null}
          </div>
        )}

        {/* ── STEP 4: Result ──────────────────────────────────────── */}
        {step === 'result' && (
          <div className="p-6 flex flex-col items-center py-10">
            {status === 'confirmed' && (
              <>
                <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-5">
                  <svg className="w-7 h-7 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <p className="text-base font-semibold text-[var(--v2-ink)] mb-1">Transaction confirmed</p>
                <p className="text-xs text-[var(--v2-ink-3)] mb-5">
                  {amount} {selectedToken} sent to {selectedContactName ?? truncate(recipient)}
                </p>
                {txHash && (
                  <a
                    href={getExplorerUrl(chainId, 'tx', txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors mb-6 flex items-center gap-1"
                  >
                    View on {getChainConfig(chainId).name} Explorer
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                    </svg>
                  </a>
                )}
                <button
                  onClick={handleDone}
                  className="w-full py-3 rounded-lg bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-colors shadow-[var(--v2-shadow-button)]"
                >
                  Done
                </button>
              </>
            )}

            {status === 'proposed' && (
              <>
                <div className="w-14 h-14 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-5">
                  <svg className="w-7 h-7 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-base font-semibold text-[var(--v2-ink)] mb-1">Transaction proposed</p>
                <p className="text-xs text-[var(--v2-ink-3)] mb-2 text-center">
                  {amount} {selectedToken} to {selectedContactName ?? truncate(recipient)}
                </p>
                <p className="text-xs text-[var(--v2-ink-3)] mb-5 text-center">
                  Waiting for {threshold - 1} more approval{threshold - 1 !== 1 ? 's' : ''} to send.
                </p>
                <a
                  href={`https://app.safe.global/transactions/queue?safe=${chainConfig.shortName}:${safeAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors mb-6 flex items-center gap-1"
                >
                  View in Safe{'{Wallet}'}
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                  </svg>
                </a>
                <button
                  onClick={handleDone}
                  className="w-full py-3 rounded-lg bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-colors shadow-[var(--v2-shadow-button)]"
                >
                  Done
                </button>
              </>
            )}

            {status === 'error' && (
              <>
                <div className="w-14 h-14 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-5">
                  <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <p className="text-base font-semibold text-[var(--v2-ink)] mb-1">Transaction failed</p>
                <p className="text-xs text-[var(--v2-ink-3)] mb-6 text-center max-w-xs">
                  {error ?? 'An unexpected error occurred'}
                </p>
                <div className="flex gap-3 w-full">
                  <button
                    onClick={onClose}
                    className="flex-1 py-3 rounded-lg border border-[var(--v2-border)] text-sm text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { reset(); setStep('form') }}
                    className="flex-1 py-3 rounded-lg bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-colors shadow-[var(--v2-shadow-button)]"
                  >
                    Try again
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
