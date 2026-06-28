'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address, parseUnits } from 'viem'
import {
  buildDeleteAllowanceTx,
  buildSetAllowanceTx,
  RESET_PERIODS,
  type AllowanceInfo,
} from '@/lib/allowance-module'
import ConfirmDialog from './ConfirmDialog'
import { api } from '@/lib/api'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import { formatAllowanceAmount } from '@/lib/allowance-format'
import { isIncompleteMoneyInput, validateMoneyInput } from '@/lib/money-input'
import OnchainActionGate, { OnchainActionNotice } from './OnchainActionGate'
import {
  getSafeNonce,
  signSafeTx,
  executeSafeTx,
  proposeSafeTx,
  getSafeTxHash,
  getChainTokens,
} from '@/lib/safe-tx'
import type { SafeDetails } from '@/types/transactions'
import type { Agent } from '@/hooks/useAgents'
import { useActiveSigner } from '@/lib/signer'
import { SigningStatus } from './SigningStatus'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { useToast } from './ui/Toast'
import { useFocusTrap } from '@/hooks/useFocusTrap'

// ── Types ──────────────────────────────────────────────────────────

type Step = 'form' | 'review' | 'executing' | 'done'
type ExecutionStatus = 'signing' | 'executing' | 'saving' | 'confirmed' | 'proposed' | 'error'

/**
 * `'all'` — default; renders name + description AND budget fields together.
 *   Keeps full backwards-compat with the original Edit flow.
 * `'agent'` — only name + description. Used by the detail-page kebab's
 *   "Edit agent" entry.
 * `'budget'` — only token / amount / reset-period. Used by the detail-page
 *   kebab's "Update budget" entry.
 */
export type EditAgentModalMode = 'all' | 'agent' | 'budget'

interface Props {
  open: boolean
  onClose: () => void
  agent: Agent
  safeAddress: string
  chainId: number
  safeDetails: SafeDetails | null
  existingOnChainAllowances: AllowanceInfo[] | null
  onUpdated: () => void
  mode?: EditAgentModalMode
}

// ── Component ──────────────────────────────────────────────────────

export default function EditAgentModal({
  open,
  onClose,
  agent,
  safeAddress,
  chainId,
  safeDetails,
  existingOnChainAllowances,
  onUpdated,
  mode = 'all',
}: Props) {
  const showAgentFields = mode === 'all' || mode === 'agent'
  const showBudgetFields = mode === 'all' || mode === 'budget'
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)
  const chainTokens = getChainTokens(chainId)
  const tokenOptions = Object.entries(chainTokens).map(([symbol, cfg]) => ({
    symbol,
    label: symbol,
    sub: cfg.address === null ? 'Native' : symbol,
    address: cfg.address as Address | null,
    decimals: cfg.decimals,
  }))
  const defaultToken = tokenOptions[0]?.symbol ?? ''

  const [step, setStep] = useState<Step>('form')

  // Form state
  const [agentName, setAgentName] = useState(agent.name)
  const [agentDescription, setAgentDescription] = useState(agent.description ?? '')
  const [selectedToken, setSelectedToken] = useState<string>(defaultToken)
  const [amount, setAmount] = useState('')
  const [resetTimeMin, setResetTimeMin] = useState(1440)

  // Execution
  const [execStatus, setExecStatus] = useState<ExecutionStatus>('signing')
  const [execError, setExecError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  // Per-row remove flow — independent of the add/update form. We keep the
  // pending-removal token in state so the confirm dialog can address the
  // user with the specific token name before any on-chain call happens.
  const [pendingRemoval, setPendingRemoval] = useState<{
    token: Address
    symbol: string
  } | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)

  // Wagmi
  const publicClient = usePublicClient({ chainId })
  const signer = useActiveSigner({
    safeAddress: safeAddress as Address,
    chainId,
  })
  const operationGate = useSafeOperationGate({
    safeAddress: safeAddress as Address,
    chainId,
  })
  const budgetApprovalMessage = 'Connect a wallet to update this agent budget.'
  const { toast } = useToast()

  // Tokens already configured on-chain for this delegate, matched by both
  // address and symbol so native-token entries (where one side stores the
  // ERC-20 wrapper address and the other stores the native sentinel) still
  // resolve as "existing".
  const existingTokenKeys = useMemo(() => {
    const addrs = new Set<string>()
    const symbols = new Set<string>()
    if (existingOnChainAllowances) {
      for (const a of existingOnChainAllowances) {
        addrs.add(a.token.toLowerCase())
      }
    }
    for (const a of agent.allowances) {
      if (a.token_address) addrs.add(a.token_address.toLowerCase())
      if (a.token_symbol) symbols.add(a.token_symbol)
    }
    return { addrs, symbols }
  }, [existingOnChainAllowances, agent.allowances])

  // Available tokens = all tokens (can add new or update existing)
  const availableTokens = tokenOptions

  const selectedTokenConfig = tokenOptions.find((t) => t.symbol === selectedToken)
  const tokenAddress = selectedTokenConfig?.address ?? '0x0000000000000000000000000000000000000000'
  // Match by either address or symbol — handles the native-token edge case
  // where the saved record uses a different sentinel/address shape than the
  // current token config. In `'budget'` mode the modal was opened from the
  // detail page's "Update budget" kebab entry, so the user's mental model
  // is "update" regardless of token choice — bias the label accordingly.
  const matchesExistingByAddr = existingTokenKeys.addrs.has(tokenAddress.toLowerCase())
  const matchesExistingBySymbol = existingTokenKeys.symbols.has(selectedToken)
  const isExistingToken =
    matchesExistingByAddr ||
    matchesExistingBySymbol ||
    (mode === 'budget' && agent.allowances.length > 0)
  const trimmedName = agentName.trim()
  const trimmedDescription = agentDescription.trim()
  const detailsChanged =
    trimmedName !== agent.name ||
    trimmedDescription !== (agent.description ?? '')
  const hasBudgetInput = amount.trim().length > 0
  const budgetValidation =
    hasBudgetInput && selectedTokenConfig
      ? validateMoneyInput(amount, selectedTokenConfig.decimals, {
          tokenSymbol: selectedTokenConfig.symbol,
        })
      : null
  const budgetDisplayAmount = budgetValidation?.ok ? budgetValidation.amount : amount
  const budgetChanged = budgetValidation?.ok ?? false
  const hasInvalidBudget = hasBudgetInput && !budgetChanged
  // Keep gating on hasInvalidBudget, but don't flash error styling while the
  // user is mid-keystroke on values like "0." that are merely incomplete.
  const showBudgetError = hasInvalidBudget && !isIncompleteMoneyInput(amount)
  // Step-gate logic per mode:
  //   'agent'  — name is required, budget is hidden, so we just need details to differ.
  //   'budget' — budget is required, name/description is hidden.
  //   'all'    — either change is enough, name still required.
  const canReview =
    mode === 'budget'
      ? !hasInvalidBudget && budgetChanged
      : trimmedName.length > 0 &&
        !hasInvalidBudget &&
        (detailsChanged || (showBudgetFields && budgetChanged))

  // ── Reset ──────────────────────────────────────────────

  const resetForm = useCallback(() => {
    setStep('form')
    setAgentName(agent.name)
    setAgentDescription(agent.description ?? '')
    setSelectedToken(defaultToken)
    setAmount('')
    setResetTimeMin(1440)
    setExecStatus('signing')
    setExecError(null)
    setTxHash(null)
  }, [agent.description, agent.name, defaultToken])

  useEffect(() => {
    if (open) resetForm()
  }, [open, resetForm])

  const handleClose = useCallback(() => {
    resetForm()
    onClose()
  }, [onClose, resetForm])

  // Escape-to-close — mirror backdrop behaviour (disabled during execution).
  useEscapeToClose(open, handleClose, { enabled: step !== 'executing' })

  // ── Execute ────────────────────────────────────────────

  async function handleExecute() {
    if (!canReview) return
    if (budgetChanged && (!publicClient || !signer || !safeDetails || !selectedTokenConfig)) return

    setExecStatus(budgetChanged ? 'signing' : 'saving')
    setStep('executing')
    setExecError(null)

    try {
      let threshold = safeDetails?.threshold ?? 1

      if (budgetChanged && selectedTokenConfig && publicClient && signer && safeDetails) {
        const parsedAmount = validateMoneyInput(amount, selectedTokenConfig.decimals, {
          tokenSymbol: selectedTokenConfig.symbol,
        })
        if (!parsedAmount.ok) {
          setExecError(parsedAmount.message)
          setExecStatus('error')
          return
        }
        const rawAmount = parseUnits(parsedAmount.amount, selectedTokenConfig.decimals)
        const token = (selectedTokenConfig.address ?? '0x0000000000000000000000000000000000000000') as Address

        // Build Safe tx
        const nonce = await getSafeNonce(publicClient, safeAddress as Address)
        const safeTx = buildSetAllowanceTx(
          agent.delegate_address as Address,
          token,
          rawAmount,
          resetTimeMin,
          nonce,
          chainId,
        )

        // Sign
        setExecStatus('signing')
        const signature = await signSafeTx(
          signer,
          safeAddress as Address,
          safeTx,
          chainId,
        )

        threshold = safeDetails.threshold ?? 1

        if (threshold <= 1) {
          setExecStatus('executing')
          const result = await executeSafeTx(
            signer,
            publicClient,
            safeAddress as Address,
            safeTx,
            signature,
            chainId,
          )
          setTxHash(result.txHash)
        } else {
          setExecStatus('executing')
          const safeTxHash = getSafeTxHash(safeAddress as Address, safeTx, chainId)
          await proposeSafeTx(
            safeAddress as Address,
            safeTx,
            safeTxHash,
            signature,
            signer.address,
            chainId,
          )
          setTxHash(safeTxHash)
        }

        // Save budget to Haven backend
        setExecStatus('saving')
        await api.post(`/agents/${agent.id}/allowances`, {
            token_address: tokenAddress,
            token_symbol: selectedTokenConfig.symbol,
            allowance_amount: rawAmount.toString(),
            reset_period_min: resetTimeMin,
          })
      } else {
        setExecStatus('saving')
      }

      if (detailsChanged) {
        await api.put(`/agents/${agent.id}`, {
          name: trimmedName,
          description: trimmedDescription,
        })
      }

      setExecStatus(budgetChanged && threshold > 1 ? 'proposed' : 'confirmed')
      setStep('done')
      onUpdated()
    } catch (err: unknown) {
      console.error('[Haven] Edit agent error:', err)
      let message = 'Update failed'
      if (err instanceof Error) {
        message = err.message
        let cause = (err as { cause?: unknown }).cause
        while (cause instanceof Error) {
          if (cause.message) message = cause.message
          cause = (cause as { cause?: unknown }).cause
        }
        const short = (err as { shortMessage?: string }).shortMessage
        // Skip shortMessage for generic RPC failures — the underlying message is more useful.
        if (short && !short.includes('RPC Request failed')) message = short
      }
      if (message.includes('User rejected') || message.includes('user rejected') || message.includes('User denied')) {
        setExecError(
          signer?.type === 'passkey'
            ? 'Face ID or Touch ID was cancelled'
            : 'Transaction rejected in wallet',
        )
      } else if (
        message.includes('RPC Request failed') ||
        message.includes('fetch failed') ||
        message.includes('Failed to fetch') ||
        message.includes('NetworkError')
      ) {
        setExecError('Could not reach the network. Check your connection and try again.')
      } else {
        setExecError(message)
      }
      setExecStatus('error')
    }
  }

  // ── Remove a single token allowance ────────────────────

  const confirmRemoval = useCallback(async () => {
    if (!pendingRemoval) return
    if (!publicClient || !signer || !safeDetails) {
      toast.error('Connect a wallet to remove this budget.')
      return
    }

    setIsRemoving(true)
    try {
      const nonce = await getSafeNonce(publicClient, safeAddress as Address)
      const safeTx = buildDeleteAllowanceTx(
        agent.delegate_address as Address,
        pendingRemoval.token,
        nonce,
        chainId,
      )

      const signature = await signSafeTx(
        signer,
        safeAddress as Address,
        safeTx,
        chainId,
      )

      const threshold = safeDetails.threshold ?? 1
      if (threshold <= 1) {
        await executeSafeTx(
          signer,
          publicClient,
          safeAddress as Address,
          safeTx,
          signature,
          chainId,
        )
      } else {
        const safeTxHash = getSafeTxHash(safeAddress as Address, safeTx, chainId)
        await proposeSafeTx(
          safeAddress as Address,
          safeTx,
          safeTxHash,
          signature,
          signer.address,
          chainId,
        )
      }

      // Mirror the on-chain removal in Haven's DB. Encode the token address
      // explicitly to keep native-token sentinels safe.
      await api.delete(
        `/agents/${agent.id}/allowances/${encodeURIComponent(pendingRemoval.token)}`,
      )

      toast.success(`${pendingRemoval.symbol} budget removed`)
      setPendingRemoval(null)
      onUpdated()
    } catch (err) {
      console.error('[Haven] Remove allowance error:', err)
      const message = err instanceof Error ? err.message : 'Could not remove budget.'
      toast.error(message.length > 120 ? 'Could not remove budget.' : message)
    } finally {
      setIsRemoving(false)
    }
  }, [
    agent.delegate_address,
    agent.id,
    chainId,
    onUpdated,
    pendingRemoval,
    publicClient,
    safeAddress,
    safeDetails,
    signer,
    toast,
  ])

  // ── Render ─────────────────────────────────────────────

  if (!open) return null

  function resetLabel(mins: number) {
    return RESET_PERIODS.find((p) => p.value === mins)?.label ?? `${mins}m`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 v2-modal-backdrop">
      <div
        className="absolute inset-0"
        onClick={step !== 'executing' ? handleClose : undefined}
      />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Edit agent" className="relative bg-white border border-[var(--v2-border)] rounded-2xl w-full max-w-lg shadow-[var(--v2-shadow-modal)] max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--v2-border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--v2-ink)]">
              {mode === 'budget' ? 'Update budget' : 'Edit agent'}
            </h2>
            <p className="mt-1 text-sm text-[var(--v2-ink-3)]">
              {step === 'form' &&
                (mode === 'budget'
                  ? 'Change the budget you let this agent spend.'
                  : mode === 'agent'
                    ? 'Rename the agent or change its description.'
                    : 'Update agent details or budget.')}
              {step === 'review' && 'Review the change before confirming.'}
              {step === 'executing' && 'Updating…'}
              {step === 'done' && 'Updated successfully.'}
            </p>
          </div>
          <button
            onClick={handleClose}
            disabled={step === 'executing' && execStatus !== 'error'}
            aria-label="Close"
            className="text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] disabled:opacity-20 disabled:cursor-not-allowed transition-colors p-1 -mr-1"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="p-6">
          {/* ── STEP: Form ─────────────────────────────── */}
          {step === 'form' && (
            <div className="space-y-5">
              {showAgentFields && (
                <div className="space-y-4 rounded-[10px] border border-[var(--v2-border)] bg-white p-4 shadow-[var(--v2-shadow-card)]">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-[var(--v2-ink-3)]">
                      Agent name
                    </label>
                    <Input
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      placeholder="e.g. Research Agent"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-[var(--v2-ink-3)]">
                      Description <span className="text-[var(--v2-ink-3)]">(optional)</span>
                    </label>
                    <textarea
                      value={agentDescription}
                      onChange={(e) => setAgentDescription(e.target.value)}
                      placeholder="What does this agent do?"
                      rows={2}
                      className="w-full bg-[var(--v2-surface-2)] border border-[var(--v2-border)] rounded-[10px] px-4 py-2.5 text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-[var(--v2-brand)]/50 focus:bg-[var(--v2-surface-2)] transition-all resize-none"
                    />
                  </div>
                </div>
              )}

              {/* Existing allowances summary */}
              {showBudgetFields && existingOnChainAllowances && existingOnChainAllowances.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium text-[var(--v2-ink-3)]">
                    Current agent budgets
                  </p>
                  <div className="space-y-1">
                    {existingOnChainAllowances.map((a) => {
                      const sym = tokenSymbolFromAddr(a.token, chainId)
                      const dec = tokenDecimalsFromAddr(a.token, chainId)
                      return (
                        <div
                          key={a.token}
                          className="flex items-center justify-between gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] p-2 text-xs"
                        >
                          <span className="font-medium text-[var(--v2-ink)]">{sym}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-[var(--v2-ink-3)]">
                              {formatAmountShort(a.amount, dec, sym)} / {resetLabel(a.resetTimeMin).toLowerCase()}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setPendingRemoval({ token: a.token as Address, symbol: sym })
                              }
                              disabled={isRemoving}
                              aria-label={`Remove ${sym} budget`}
                              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-danger-soft)] hover:text-[var(--v2-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-danger)]/30 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <svg
                                aria-hidden="true"
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Add / update allowance */}
              {showBudgetFields && (
              <div className="space-y-3 p-4 rounded-xl border border-dashed border-[var(--v2-border)]">
                <p className="text-xs font-medium text-[var(--v2-ink-3)]">
                  {isExistingToken ? 'Update agent budget' : 'Add new agent budget'}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <Select
                    value={selectedToken}
                    onChange={(e) => setSelectedToken(e.target.value)}
                  >
                    {availableTokens.map((t) => (
                      <option key={t.symbol} value={t.symbol}>
                        {t.symbol}
                      </option>
                    ))}
                  </Select>
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => {
                      const value = e.target.value
                      if (/^\d*\.?\d*$/.test(value)) setAmount(value)
                    }}
                    placeholder="Amount"
                    invalid={showBudgetError}
                    helperText={showBudgetError && budgetValidation && !budgetValidation.ok ? budgetValidation.message : undefined}
                    className="v2-tabular"
                  />
                  <Select
                    value={resetTimeMin}
                    onChange={(e) => setResetTimeMin(Number(e.target.value))}
                  >
                    {RESET_PERIODS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </div>
                {(matchesExistingByAddr || matchesExistingBySymbol) && (
                  <p className="text-xs text-[var(--v2-ink-2)]">
                    This will replace the existing {selectedToken} budget for this agent.
                  </p>
                )}
                {showBudgetError && (
                  <p className="text-xs text-[var(--v2-danger)]">
                    Enter a budget amount greater than zero, or leave the amount blank to edit details only.
                  </p>
                )}
              </div>
              )}

              {showBudgetFields && (
                <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
                  Payments that exceed this agent budget are queued for your approval in
                  the dashboard — no separate threshold to configure.
                </p>
              )}

              {/* Hint when nothing has changed yet — explains why the
                  Review button is disabled. Important in 'agent' mode where
                  there's no budget field to discover. */}
              {!canReview && !hasInvalidBudget ? (
                <p className="text-xs text-[var(--v2-ink-3)]">
                  {mode === 'budget'
                    ? 'Enter a new budget amount to continue.'
                    : mode === 'agent'
                      ? 'Edit the name or description to continue.'
                      : 'Make a change to continue.'}
                </p>
              ) : null}

              <div className="flex gap-3">
                <Button
                  variant="ghost"
                  onClick={handleClose}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => setStep('review')}
                  disabled={!canReview}
                  className="flex-1"
                >
                  Review changes
                </Button>
              </div>
            </div>
          )}

          {/* ── STEP: Review ──────────────────────────── */}
          {step === 'review' && (
            <div className="space-y-5">
              <div className="bg-[var(--v2-surface)] rounded-xl p-4 border border-[var(--v2-border)] space-y-3">
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">Agent</p>
                  <p className="text-sm font-medium text-[var(--v2-ink)]">{trimmedName}</p>
                  {trimmedDescription ? (
                    <p className="mt-1 text-xs text-[var(--v2-ink-2)]">{trimmedDescription}</p>
                  ) : null}
                </div>
                {showAgentFields && detailsChanged && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">Details</p>
                    <p className="text-xs text-[var(--v2-ink-2)]">Name and description will update in Haven.</p>
                  </div>
                )}
                {showBudgetFields && budgetChanged && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">
                      {isExistingToken ? 'Updated budget' : 'New budget'}
                    </p>
                    <p className="text-sm text-[var(--v2-ink)]">
                      {budgetDisplayAmount} {selectedToken}
                      <span className="ml-2 text-[var(--v2-ink-3)]">{resetLabel(resetTimeMin)}</span>
                    </p>
                  </div>
                )}
              </div>

              {showBudgetFields && budgetChanged && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-[var(--v2-ink-3)]">Wallet rule change</p>
                  <p className="flex items-center gap-2 text-xs text-[var(--v2-ink-2)]">
                    <span className="w-1 h-1 rounded-full bg-[var(--v2-brand)]" />
                    {isExistingToken ? 'Update' : 'Set'} {budgetDisplayAmount} {selectedToken} budget for this agent ({resetLabel(resetTimeMin).toLowerCase()})
                  </p>
                </div>
              )}

              {budgetChanged && (safeDetails?.threshold ?? 1) > 1 && (
                <div className="text-xs text-[var(--v2-warning)] bg-[var(--v2-warning-soft)] border border-[var(--v2-warning)]/20 rounded-lg px-3 py-2">
                  This account requires {safeDetails?.threshold} of {safeDetails?.owners?.length} approvals. Haven will submit it for approval.
                </div>
              )}

              {/* Render the gate notice above the Cancel/Confirm row so the
                  caption doesn't push the Confirm button out of line with
                  the Back button (which would happen if the gate rendered
                  it inline inside the flex-1 wrapper). */}
              {budgetChanged ? (
                <OnchainActionNotice
                  operationGate={operationGate}
                  noSignerMessage={budgetApprovalMessage}
                />
              ) : null}

              <div className="flex gap-3">
                <Button
                  variant="ghost"
                  onClick={() => setStep('form')}
                  className="flex-1"
                >
                  Back
                </Button>
                <div className="flex-1">
                  {budgetChanged ? (
                    <OnchainActionGate
                      requiredChainId={chainId}
                      operationGate={operationGate}
                      noSignerMessage={budgetApprovalMessage}
                      showNotice={false}
                    >
                      {({ disabled }) => (
                      <Button
                        onClick={handleExecute}
                        disabled={disabled || !publicClient || !signer || !safeDetails || !selectedTokenConfig}
                        className="w-full"
                      >
                        {isExistingToken ? 'Update budget' : 'Add budget'}
                      </Button>
                      )}
                    </OnchainActionGate>
                  ) : (
                    <Button
                      onClick={handleExecute}
                      className="w-full"
                    >
                      Save details
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── STEP: Executing ───────────────────────── */}
          {step === 'executing' && (
            <div className="py-8 text-center space-y-4">
              {execStatus !== 'error' ? (
                <>
                  <div className="w-10 h-10 border-2 border-[var(--v2-brand)] border-t-transparent rounded-full animate-spin mx-auto" />
                  <div>
                    <p className="text-sm text-[var(--v2-ink)] font-medium">
                      {execStatus === 'signing' && (budgetChanged ? 'Awaiting signature...' : 'Saving changes...')}
                      {execStatus === 'executing' && 'Submitting budget update...'}
                      {execStatus === 'saving' && 'Saving to Haven...'}
                    </p>
                    <div className="text-xs text-[var(--v2-ink-3)] mt-1">
                      {execStatus === 'signing' ? (
                        <SigningStatus signer={signer} stage="signing" />
                      ) : execStatus === 'executing' ? (
                        <SigningStatus signer={signer} stage="executing" />
                      ) : (
                        'This may take a moment'
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--v2-danger-soft)]">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--v2-danger)]">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[var(--v2-danger)]">Update failed</p>
                    <p className="mx-auto mt-1 max-w-xs text-xs text-[var(--v2-ink-3)]">{execError}</p>
                  </div>
                  <div className="flex gap-3 pt-2">
                    <Button variant="ghost" onClick={() => setStep('review')} className="flex-1">
                      Back
                    </Button>
                    <Button onClick={handleExecute} className="flex-1">
                      Retry
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── STEP: Done ────────────────────────────── */}
          {step === 'done' && (
            <div className="space-y-5">
              <div className="text-center py-4">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--v2-success-soft)]">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--v2-success)]">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-[var(--v2-ink)]">
                  {execStatus === 'confirmed'
                    ? 'Agent updated'
                    : 'Budget update proposed for approval'}
                </p>
                <p className="text-xs text-[var(--v2-ink-3)] mt-1">
                  {budgetChanged
                    ? `${budgetDisplayAmount} ${selectedToken} — ${resetLabel(resetTimeMin).toLowerCase()}`
                    : 'Name and description saved'}
                </p>
                {txHash && (
                  <a
                    href={
                      execStatus === 'confirmed'
                        ? getExplorerUrl(chainId, 'tx', txHash)
                        : `https://app.safe.global/transactions/tx?safe=${getChainConfig(chainId).shortName}:${safeAddress}&id=${txHash}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] underline underline-offset-2 mt-1 inline-block"
                  >
                    {execStatus === 'confirmed' ? 'View on Explorer' : 'View pending approval'}
                  </a>
                )}
              </div>
              <Button variant="ghost" onClick={handleClose} className="w-full">
                Done
              </Button>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingRemoval !== null}
        onCancel={() => (isRemoving ? undefined : setPendingRemoval(null))}
        onConfirm={() => void confirmRemoval()}
        title={pendingRemoval ? `Remove ${pendingRemoval.symbol} budget?` : 'Remove budget?'}
        body="This stops the agent from spending this token. You can add it back any time."
        confirmLabel="Remove budget"
        loading={isRemoving}
      />
    </div>
  )
}

// ── Token helpers (local) ─────────────────────────────────────────

function tokenSymbolFromAddr(addr: string, cId: number): string {
  const lower = addr.toLowerCase()
  const tokens = getChainTokens(cId)
  if (lower === '0x0000000000000000000000000000000000000000') {
    return Object.entries(tokens).find(([, cfg]) => cfg.address === null)?.[0] ?? 'Native'
  }
  for (const [symbol, cfg] of Object.entries(tokens)) {
    if (cfg.address && cfg.address.toLowerCase() === lower) return symbol
  }
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function tokenDecimalsFromAddr(addr: string, cId: number): number {
  const lower = addr.toLowerCase()
  const tokens = getChainTokens(cId)
  if (lower === '0x0000000000000000000000000000000000000000') return 18
  for (const cfg of Object.values(tokens)) {
    if (cfg.address && cfg.address.toLowerCase() === lower) return cfg.decimals
  }
  return 18
}

function formatAmountShort(raw: bigint, decimals: number, symbol: string): string {
  return formatAllowanceAmount(raw.toString(), decimals, { symbol })
}
