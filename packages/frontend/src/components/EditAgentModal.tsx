'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address, parseUnits } from 'viem'
import {
  buildSetAllowanceTx,
  RESET_PERIODS,
  type AllowanceInfo,
} from '@/lib/allowance-module'
import { api } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import NetworkGate from './NetworkGate'
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
import { useFocusTrap } from '@/hooks/useFocusTrap'

// ── Types ──────────────────────────────────────────────────────────

type Step = 'form' | 'review' | 'executing' | 'done'
type ExecutionStatus = 'signing' | 'executing' | 'saving' | 'confirmed' | 'proposed' | 'error'

interface Props {
  open: boolean
  onClose: () => void
  agent: Agent
  safeAddress: string
  safeDetails: SafeDetails | null
  existingOnChainAllowances: AllowanceInfo[] | null
  onUpdated: () => void
}

// ── Component ──────────────────────────────────────────────────────

export default function EditAgentModal({
  open,
  onClose,
  agent,
  safeAddress,
  safeDetails,
  existingOnChainAllowances,
  onUpdated,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)
  const { activeSafe } = useAuth()
  const chainId = activeSafe?.chain_id ?? 100
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

  // Wagmi
  const publicClient = usePublicClient({ chainId })
  const signer = useActiveSigner({
    safeAddress: safeAddress as Address,
    chainId,
  })

  // Tokens already configured on-chain for this delegate
  const existingTokenAddrs = useMemo(() => {
    const set = new Set<string>()
    if (existingOnChainAllowances) {
      for (const a of existingOnChainAllowances) {
        set.add(a.token.toLowerCase())
      }
    }
    // Also include DB allowances as fallback
    for (const a of agent.allowances) {
      set.add(a.token_address.toLowerCase())
    }
    return set
  }, [existingOnChainAllowances, agent.allowances])

  // Available tokens = all tokens (can add new or update existing)
  const availableTokens = tokenOptions

  const selectedTokenConfig = tokenOptions.find((t) => t.symbol === selectedToken)
  const tokenAddress = selectedTokenConfig?.address ?? '0x0000000000000000000000000000000000000000'
  const isExistingToken = existingTokenAddrs.has(tokenAddress.toLowerCase())
  const trimmedName = agentName.trim()
  const trimmedDescription = agentDescription.trim()
  const detailsChanged =
    trimmedName !== agent.name ||
    trimmedDescription !== (agent.description ?? '')
  const hasBudgetInput = amount.trim().length > 0
  const budgetChanged = hasBudgetInput && Number(amount) > 0
  const hasInvalidBudget = hasBudgetInput && !budgetChanged
  const canReview = trimmedName.length > 0 && !hasInvalidBudget && (detailsChanged || budgetChanged)

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
        const rawAmount = parseUnits(amount, selectedTokenConfig.decimals)
        const token = (selectedTokenConfig.address ?? '0x0000000000000000000000000000000000000000') as Address

        // Build Safe tx
        const nonce = await getSafeNonce(publicClient, safeAddress as Address)
        const safeTx = buildSetAllowanceTx(
          agent.delegate_address as Address,
          token,
          rawAmount,
          resetTimeMin,
          nonce,
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
        if (short) message = short
      }
      if (message.includes('User rejected') || message.includes('user rejected') || message.includes('User denied')) {
        setExecError(
          signer?.type === 'passkey'
            ? 'Face ID or Touch ID was cancelled'
            : 'Transaction rejected in wallet',
        )
      } else {
        setExecError(message)
      }
      setExecStatus('error')
    }
  }

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
            <h2 className="text-sm font-semibold">Edit Agent: {agent.name}</h2>
            <p className="text-xs text-[var(--v2-ink-3)] mt-0.5">
              {step === 'form' && 'Update agent details or budget'}
              {step === 'review' && 'Review rule changes'}
              {step === 'executing' && 'Updating rules...'}
              {step === 'done' && 'Agent updated'}
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
              <div className="space-y-4 rounded-[10px] border border-[var(--v2-border)] bg-white p-4 shadow-[var(--v2-shadow-card)]">
                <div>
                  <label className="block text-[11px] text-[var(--v2-ink-3)] mb-1.5 uppercase tracking-wide">
                    Agent name
                  </label>
                  <Input
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    placeholder="e.g. Research Agent"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--v2-ink-3)] mb-1.5 uppercase tracking-wide">
                    Description <span className="normal-case text-[var(--v2-ink-3)]">(optional)</span>
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

              {/* Existing allowances summary */}
              {existingOnChainAllowances && existingOnChainAllowances.length > 0 && (
                <div>
                  <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-2">
                    Current agent budgets
                  </p>
                  <div className="space-y-1">
                    {existingOnChainAllowances.map((a) => {
                      const sym = tokenSymbolFromAddr(a.token, chainId)
                      const dec = tokenDecimalsFromAddr(a.token, chainId)
                      return (
                        <div key={a.token} className="flex items-center justify-between text-xs p-2 bg-[var(--v2-surface)] rounded-lg border border-[var(--v2-border)]">
                          <span className="text-[var(--v2-ink)] font-medium">{sym}</span>
                          <span className="text-[var(--v2-ink-3)]">{formatAmountShort(a.amount, dec)} / {resetLabel(a.resetTimeMin).toLowerCase()}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Add / update allowance */}
              <div className="space-y-3 p-4 bg-[var(--v2-surface)] rounded-xl border border-dashed border-[var(--v2-border)]">
                <p className="text-[11px] text-[var(--v2-ink-3)] uppercase tracking-wide">
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
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Amount"
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
                {isExistingToken && (
                  <p className="text-[11px] text-[var(--v2-ink-2)]">
                    This will replace the existing {selectedToken} budget for this agent.
                  </p>
                )}
                {hasInvalidBudget && (
                  <p className="text-[11px] text-[var(--v2-danger)]">
                    Enter a budget amount greater than zero, or leave the amount blank to edit details only.
                  </p>
                )}
              </div>

              <p className="text-[11px] text-[var(--v2-ink-3)] leading-relaxed">
                Payments that exceed this agent budget are queued for your approval in
                the dashboard — no separate threshold to configure.
              </p>

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
                  <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-1">Agent</p>
                  <p className="text-sm text-[var(--v2-ink)] font-medium">{trimmedName}</p>
                  {trimmedDescription ? (
                    <p className="mt-1 text-xs text-[var(--v2-ink-2)]">{trimmedDescription}</p>
                  ) : null}
                </div>
                {detailsChanged && (
                  <div>
                    <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-1">Details</p>
                    <p className="text-xs text-[var(--v2-ink-2)]">Name and description will update in Haven.</p>
                  </div>
                )}
                {budgetChanged && (
                  <div>
                    <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-1">
                      {isExistingToken ? 'Updated budget' : 'New budget'}
                    </p>
                    <p className="text-sm text-[var(--v2-ink)]">
                      {amount} {selectedToken}
                      <span className="text-[var(--v2-ink-3)] ml-2">{resetLabel(resetTimeMin)}</span>
                    </p>
                  </div>
                )}
              </div>

              {budgetChanged && (
                <div className="space-y-2">
                  <p className="text-[11px] text-[var(--v2-ink-3)] uppercase tracking-wide">Wallet rule change</p>
                  <p className="flex items-center gap-2 text-xs text-[var(--v2-ink-2)]">
                    <span className="w-1 h-1 rounded-full bg-[var(--v2-brand)]" />
                    {isExistingToken ? 'Update' : 'Set'} {amount} {selectedToken} budget for this agent ({resetLabel(resetTimeMin).toLowerCase()})
                  </p>
                </div>
              )}

              {budgetChanged && (safeDetails?.threshold ?? 1) > 1 && (
                <div className="text-xs text-[var(--v2-warning)] bg-[var(--v2-warning-soft)] border border-[var(--v2-warning)]/20 rounded-lg px-3 py-2">
                  This account requires {safeDetails?.threshold} of {safeDetails?.owners?.length} approvals. Haven will submit it for approval.
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
                  {budgetChanged ? (
                    <NetworkGate requiredChainId={chainId}>
                      <Button
                        onClick={handleExecute}
                        className="w-full"
                      >
                        {isExistingToken ? 'Update budget' : 'Add budget'}
                      </Button>
                    </NetworkGate>
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
                  <div className="w-10 h-10 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin mx-auto" />
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
                  <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center mx-auto">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm text-red-400 font-medium">Update failed</p>
                    <p className="text-xs text-[var(--v2-ink-3)] mt-1 max-w-xs mx-auto">{execError}</p>
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button
                      onClick={() => setStep('review')}
                      className="flex-1 text-sm font-medium bg-white border border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)] text-[var(--v2-ink)] rounded-xl py-2.5 transition-colors"
                    >
                      Back
                    </button>
                    <button
                      onClick={handleExecute}
                      className="flex-1 text-sm font-medium bg-[var(--v2-brand)] hover:bg-[var(--v2-brand-strong)] text-white rounded-xl py-2.5 transition-colors"
                    >
                      Retry
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── STEP: Done ────────────────────────────── */}
          {step === 'done' && (
            <div className="space-y-5">
              <div className="text-center py-4">
                <div className="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-3">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
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
                    ? `${amount} ${selectedToken} — ${resetLabel(resetTimeMin).toLowerCase()}`
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
                    {execStatus === 'confirmed' ? 'View on Explorer' : 'View in Safe{Wallet}'}
                  </a>
                )}
              </div>
              <button
                onClick={handleClose}
                className="w-full text-sm font-medium bg-white border border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)] text-[var(--v2-ink)] rounded-xl py-2.5 transition-colors"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
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

function formatAmountShort(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0'
  const str = raw.toString().padStart(decimals + 1, '0')
  const intPart = str.slice(0, str.length - decimals) || '0'
  const fracPart = str.slice(str.length - decimals)
  const trimmed = fracPart.replace(/0+$/, '').padEnd(2, '0').slice(0, 4)
  return `${intPart}.${trimmed}`
}
