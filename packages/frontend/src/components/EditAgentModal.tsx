'use client'

import { useState, useCallback, useMemo } from 'react'
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
import { truncate } from '@/lib/format'
import { useActiveSigner } from '@/lib/signer'
import { SigningStatus } from './SigningStatus'

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

  // ── Reset ──────────────────────────────────────────────

  const resetForm = useCallback(() => {
    setStep('form')
    setSelectedToken(defaultToken)
    setAmount('')
    setResetTimeMin(1440)
    setExecStatus('signing')
    setExecError(null)
    setTxHash(null)
  }, [defaultToken])

  const handleClose = useCallback(() => {
    resetForm()
    onClose()
  }, [onClose, resetForm])

  // Escape-to-close — mirror backdrop behaviour (disabled during execution).
  useEscapeToClose(open, handleClose, { enabled: step !== 'executing' })

  // ── Execute ────────────────────────────────────────────

  async function handleExecute() {
    if (!publicClient || !signer || !safeDetails || !selectedTokenConfig) return
    if (!amount || Number(amount) <= 0) return

    setStep('executing')
    setExecError(null)

    try {
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

      const threshold = safeDetails.threshold ?? 1

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

      // Save to Haven backend
      setExecStatus('saving')
      await api.post(`/agents/${agent.id}/allowances`, {
          token_address: tokenAddress,
          token_symbol: selectedTokenConfig.symbol,
          allowance_amount: rawAmount.toString(),
          reset_period_min: resetTimeMin,
        })

      setExecStatus(threshold <= 1 ? 'confirmed' : 'proposed')
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--v2-ink)]/50 backdrop-blur-sm">
      <div
        className="absolute inset-0"
        onClick={step !== 'executing' ? handleClose : undefined}
      />
      <div className="relative bg-white border border-[var(--v2-border)] rounded-2xl w-full max-w-lg shadow-[var(--v2-shadow-modal)] max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--v2-border)]">
          <div>
            <h2 className="text-sm font-semibold">Edit Agent: {agent.name}</h2>
            <p className="text-xs text-[var(--v2-ink-3)] mt-0.5">
              {step === 'form' && 'Add or update an agent budget'}
              {step === 'review' && 'Review rule changes'}
              {step === 'executing' && 'Updating rules...'}
              {step === 'done' && 'Agent budget updated'}
            </p>
          </div>
          <button
            onClick={handleClose}
            disabled={step === 'executing' && execStatus !== 'error'}
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
                  <select
                    value={selectedToken}
                    onChange={(e) => setSelectedToken(e.target.value)}
                    className="bg-[var(--v2-surface-2)] border border-[var(--v2-border)] rounded-lg px-3 py-2 text-sm text-[var(--v2-ink)] focus:outline-none focus:border-indigo-500/50"
                  >
                    {availableTokens.map((t) => (
                      <option key={t.symbol} value={t.symbol}>
                        {t.symbol}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Amount"
                    className="bg-[var(--v2-surface-2)] border border-[var(--v2-border)] rounded-lg px-3 py-2 text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-indigo-500/50"
                  />
                  <select
                    value={resetTimeMin}
                    onChange={(e) => setResetTimeMin(Number(e.target.value))}
                    className="bg-[var(--v2-surface-2)] border border-[var(--v2-border)] rounded-lg px-3 py-2 text-sm text-[var(--v2-ink)] focus:outline-none focus:border-indigo-500/50"
                  >
                    {RESET_PERIODS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                {isExistingToken && (
                  <p className="text-[11px] text-amber-400/70">
                    This will replace the existing {selectedToken} budget for this agent.
                  </p>
                )}
              </div>

              <p className="text-[11px] text-[var(--v2-ink-3)] leading-relaxed">
                Payments that exceed this agent budget are queued for your approval in
                the dashboard — no separate threshold to configure.
              </p>

              <div className="flex gap-3">
                <button
                  onClick={handleClose}
                  className="flex-1 text-sm font-medium bg-[var(--v2-surface-2)] hover:bg-[var(--v2-surface-2)] text-[var(--v2-ink)] rounded-xl py-2.5 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => setStep('review')}
                  disabled={!amount || Number(amount) <= 0}
                  className="flex-1 text-sm font-medium bg-[var(--v2-brand)] hover:bg-[var(--v2-brand-strong)] disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl py-2.5 transition-colors"
                >
                  Review
                </button>
              </div>
            </div>
          )}

          {/* ── STEP: Review ──────────────────────────── */}
          {step === 'review' && (
            <div className="space-y-5">
              <div className="bg-[var(--v2-surface)] rounded-xl p-4 border border-[var(--v2-border)] space-y-3">
                <div>
                  <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-1">Agent</p>
                  <p className="text-sm text-[var(--v2-ink)] font-medium">{agent.name}</p>
                </div>
                <div>
                  <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-1">Credential</p>
                  <p className="text-xs font-mono text-[var(--v2-ink-2)]">{truncate(agent.delegate_address!)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-1">
                    {isExistingToken ? 'Updated budget' : 'New budget'}
                  </p>
                  <p className="text-sm text-[var(--v2-ink)]">
                    {amount} {selectedToken}
                    <span className="text-[var(--v2-ink-3)] ml-2">{resetLabel(resetTimeMin)}</span>
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-[11px] text-[var(--v2-ink-3)] uppercase tracking-wide">On-chain action</p>
                <p className="flex items-center gap-2 text-xs text-[var(--v2-ink-2)]">
                  <span className="w-1 h-1 rounded-full bg-indigo-400" />
                  {isExistingToken ? 'Update' : 'Set'} {amount} {selectedToken} budget for {truncate(agent.delegate_address!)} ({resetLabel(resetTimeMin).toLowerCase()})
                </p>
              </div>

              {(safeDetails?.threshold ?? 1) > 1 && (
                <div className="text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/10 rounded-lg px-3 py-2">
                  This account requires {safeDetails?.threshold} of {safeDetails?.owners?.length} approvals. Haven will submit it for approval.
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setStep('form')}
                  className="flex-1 text-sm font-medium bg-[var(--v2-surface-2)] hover:bg-[var(--v2-surface-2)] text-[var(--v2-ink)] rounded-xl py-2.5 transition-colors"
                >
                  Back
                </button>
                <div className="flex-1">
                  <NetworkGate requiredChainId={chainId}>
                    <button
                      onClick={handleExecute}
                      className="w-full text-sm font-medium bg-[var(--v2-brand)] hover:bg-[var(--v2-brand-strong)] text-white rounded-xl py-2.5 transition-colors shadow-[var(--v2-shadow-button)]"
                    >
                      {isExistingToken ? 'Update budget' : 'Add budget'}
                    </button>
                  </NetworkGate>
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
                      {execStatus === 'signing' && 'Awaiting signature...'}
                      {execStatus === 'executing' && 'Submitting update...'}
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
                      className="flex-1 text-sm font-medium bg-[var(--v2-surface-2)] hover:bg-[var(--v2-surface-2)] text-[var(--v2-ink)] rounded-xl py-2.5 transition-colors"
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
                    ? 'Agent budget updated'
                    : 'Update proposed for approval'}
                </p>
                <p className="text-xs text-[var(--v2-ink-3)] mt-1">
                  {amount} {selectedToken} — {resetLabel(resetTimeMin).toLowerCase()}
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
                className="w-full text-sm font-medium bg-[var(--v2-surface-2)] hover:bg-[var(--v2-surface-2)] text-[var(--v2-ink)] rounded-xl py-2.5 transition-colors"
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
