'use client'

import { useState, useCallback } from 'react'
import { usePublicClient, useWalletClient, useAccount } from 'wagmi'
import { type Address, parseUnits, hashTypedData } from 'viem'
import { gnosis } from 'viem/chains'
import {
  buildAgentSetupTx,
  isModuleEnabled,
  RESET_PERIODS,
  type AllowanceSetup,
} from '@/lib/allowance-module'
import {
  getSafeNonce,
  signSafeTx,
  executeSafeTx,
  proposeSafeTx,
  TOKENS,
} from '@/lib/safe-tx'
import type { SafeDetails } from '@/types/transactions'

// ── Helpers ────────────────────────────────────────────────────────

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

const TOKEN_OPTIONS = [
  { symbol: 'xDAI', label: 'xDAI', sub: 'Native', address: TOKENS['xDAI'].address, decimals: TOKENS['xDAI'].decimals },
  { symbol: 'EURe', label: 'EURe', sub: 'Monerium', address: TOKENS['EURe'].address, decimals: TOKENS['EURe'].decimals },
  { symbol: 'USDC.e', label: 'USDC.e', sub: 'Bridged USDC', address: TOKENS['USDC.e'].address, decimals: TOKENS['USDC.e'].decimals },
] as const

interface AllowanceEntry {
  tokenSymbol: string
  tokenAddress: Address | null
  decimals: number
  amount: string
  resetTimeMin: number
}

// ── Types ──────────────────────────────────────────────────────────

type Step = 'details' | 'allowances' | 'review' | 'executing' | 'done'

type ExecutionStatus =
  | 'checking'
  | 'signing'
  | 'executing'
  | 'saving'
  | 'confirmed'
  | 'proposed'
  | 'error'

interface Props {
  open: boolean
  onClose: () => void
  safeAddress: string
  safeDetails: SafeDetails | null
  onCreated: (agent: {
    id: string
    name: string
    api_key: string
    delegate_address: string
  }) => void
}

// ── Component ──────────────────────────────────────────────────────

export default function CreateAgentModal({
  open,
  onClose,
  safeAddress,
  safeDetails,
  onCreated,
}: Props) {
  // Step state
  const [step, setStep] = useState<Step>('details')

  // Form: details
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [delegateAddress, setDelegateAddress] = useState('')

  // Form: allowances
  const [allowances, setAllowances] = useState<AllowanceEntry[]>([])
  const [addToken, setAddToken] = useState<string>(TOKEN_OPTIONS[2].symbol) // default USDC.e
  const [addAmount, setAddAmount] = useState('')
  const [addReset, setAddReset] = useState(1440) // daily

  // Execution
  const [execStatus, setExecStatus] = useState<ExecutionStatus>('checking')
  const [execError, setExecError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  // Result
  const [createdApiKey, setCreatedApiKey] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState(false)

  // Wagmi
  const { address: connectedAddress } = useAccount()
  const publicClient = usePublicClient({ chainId: gnosis.id })
  const { data: walletClient } = useWalletClient({ chainId: gnosis.id })

  // ── Reset ──────────────────────────────────────────────

  const resetForm = useCallback(() => {
    setStep('details')
    setName('')
    setDescription('')
    setDelegateAddress('')
    setAllowances([])
    setAddToken(TOKEN_OPTIONS[2].symbol)
    setAddAmount('')
    setAddReset(1440)
    setExecStatus('checking')
    setExecError(null)
    setTxHash(null)
    setCreatedApiKey(null)
    setCopiedKey(false)
  }, [])

  const handleClose = useCallback(() => {
    resetForm()
    onClose()
  }, [onClose, resetForm])

  // ── Step: Details ──────────────────────────────────────

  function canProceedDetails() {
    return (
      name.trim().length > 0 && isValidAddress(delegateAddress)
    )
  }

  // ── Step: Allowances ───────────────────────────────────

  function handleAddAllowance() {
    const tokenOpt = TOKEN_OPTIONS.find((t) => t.symbol === addToken)
    if (!tokenOpt || !addAmount || Number(addAmount) <= 0) return

    // Don't add duplicate tokens
    if (allowances.some((a) => a.tokenSymbol === addToken)) return

    setAllowances((prev) => [
      ...prev,
      {
        tokenSymbol: tokenOpt.symbol,
        tokenAddress: tokenOpt.address,
        decimals: tokenOpt.decimals,
        amount: addAmount,
        resetTimeMin: addReset,
      },
    ])
    setAddAmount('')
  }

  function handleRemoveAllowance(symbol: string) {
    setAllowances((prev) => prev.filter((a) => a.tokenSymbol !== symbol))
  }

  function resetLabel(mins: number) {
    return RESET_PERIODS.find((p) => p.value === mins)?.label ?? `${mins}m`
  }

  // ── Step: Execute ──────────────────────────────────────

  async function handleExecute() {
    if (!publicClient || !walletClient || !connectedAddress || !safeDetails)
      return

    setStep('executing')
    setExecError(null)

    try {
      // 1. Check if module is enabled
      setExecStatus('checking')
      const moduleEnabled = await isModuleEnabled(
        publicClient,
        safeAddress as Address,
      )

      // 2. Build the setup allowances
      const setupAllowances: AllowanceSetup[] = allowances.map((a) => ({
        token: (a.tokenAddress ?? '0x0000000000000000000000000000000000000000') as Address,
        tokenSymbol: a.tokenSymbol,
        amount: parseUnits(a.amount, a.decimals),
        resetTimeMin: a.resetTimeMin,
      }))

      // 3. Get nonce and build batched tx
      const nonce = await getSafeNonce(publicClient, safeAddress as Address)
      const safeTx = buildAgentSetupTx(
        safeAddress as Address,
        delegateAddress as Address,
        setupAllowances,
        !moduleEnabled,
        nonce,
      )

      // 4. Sign
      setExecStatus('signing')
      const signature = await signSafeTx(
        walletClient,
        safeAddress as Address,
        safeTx,
        connectedAddress,
      )

      const threshold = safeDetails.threshold ?? 1

      if (threshold <= 1) {
        // Single-owner: execute directly
        setExecStatus('executing')
        const result = await executeSafeTx(
          walletClient,
          publicClient,
          safeAddress as Address,
          safeTx,
          signature,
          connectedAddress,
        )
        setTxHash(result.txHash)
      } else {
        // Multi-sig: propose
        setExecStatus('executing')
        const safeTxHash = hashTypedData({
          domain: {
            chainId: gnosis.id,
            verifyingContract: safeAddress as Address,
          },
          types: {
            SafeTx: [
              { name: 'to', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'data', type: 'bytes' },
              { name: 'operation', type: 'uint8' },
              { name: 'safeTxGas', type: 'uint256' },
              { name: 'baseGas', type: 'uint256' },
              { name: 'gasPrice', type: 'uint256' },
              { name: 'gasToken', type: 'address' },
              { name: 'refundReceiver', type: 'address' },
              { name: 'nonce', type: 'uint256' },
            ],
          },
          primaryType: 'SafeTx',
          message: {
            to: safeTx.to,
            value: safeTx.value,
            data: safeTx.data,
            operation: safeTx.operation,
            safeTxGas: safeTx.safeTxGas,
            baseGas: safeTx.baseGas,
            gasPrice: safeTx.gasPrice,
            gasToken: safeTx.gasToken,
            refundReceiver: safeTx.refundReceiver,
            nonce: safeTx.nonce,
          },
        })
        await proposeSafeTx(
          safeAddress as Address,
          safeTx,
          safeTxHash,
          signature,
          connectedAddress,
        )
        setTxHash(safeTxHash)
      }

      // 5. Save agent to Haven backend
      setExecStatus('saving')
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('haven_token')}`,
        },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          delegate_address: delegateAddress,
          allowances: allowances.map((a) => ({
            token_address:
              a.tokenAddress ?? '0x0000000000000000000000000000000000000000',
            token_symbol: a.tokenSymbol,
            allowance_amount: parseUnits(a.amount, a.decimals).toString(),
            reset_period_min: a.resetTimeMin,
          })),
        }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Failed to save agent' }))
        throw new Error(body.error ?? 'Failed to save agent')
      }

      const agent = await response.json()
      setCreatedApiKey(agent.api_key)
      setExecStatus(threshold <= 1 ? 'confirmed' : 'proposed')
      setStep('done')
      onCreated(agent)
    } catch (err: unknown) {
      console.error('[Haven] Agent setup error:', err)

      // Extract the most useful error message from viem's nested error chain
      let message = 'Setup failed'
      if (err instanceof Error) {
        message = err.message
        // viem wraps contract errors — dig into the cause chain
        let cause = (err as { cause?: unknown }).cause
        while (cause instanceof Error) {
          if (cause.message) message = cause.message
          cause = (cause as { cause?: unknown }).cause
        }
        // Also check for shortMessage (viem-specific)
        const short = (err as { shortMessage?: string }).shortMessage
        if (short) message = short
      }

      if (message.includes('User rejected') || message.includes('user rejected') || message.includes('User denied')) {
        setExecError('Transaction rejected in wallet')
      } else {
        setExecError(message)
      }
      setExecStatus('error')
    }
  }

  // ── Render ─────────────────────────────────────────────

  if (!open) return null

  const availableTokens = TOKEN_OPTIONS.filter(
    (t) => !allowances.some((a) => a.tokenSymbol === t.symbol),
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      {/* Backdrop click to close (disabled during execution) */}
      <div
        className="absolute inset-0"
        onClick={step !== 'executing' ? handleClose : undefined}
      />
      <div className="relative bg-[#0e0e0e] border border-white/[0.08] rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold">Create Agent</h2>
            <p className="text-xs text-zinc-600 mt-0.5">
              {step === 'details' && 'Agent identity and delegate key'}
              {step === 'allowances' && 'Configure spending limits'}
              {step === 'review' && 'Review and deploy on-chain'}
              {step === 'executing' && 'Deploying on-chain...'}
              {step === 'done' && 'Agent created'}
            </p>
          </div>
          <button
            onClick={handleClose}
            disabled={step === 'executing' && execStatus !== 'error'}
            className="text-zinc-700 hover:text-zinc-400 disabled:opacity-20 disabled:cursor-not-allowed transition-colors p-1 -mr-1"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Step indicators */}
        {step !== 'executing' && step !== 'done' && (
          <div className="flex items-center gap-2 px-6 py-3 border-b border-white/[0.04]">
            {(['details', 'allowances', 'review'] as const).map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    s === step
                      ? 'bg-indigo-500 text-white'
                      : ['details', 'allowances', 'review'].indexOf(step) > i
                        ? 'bg-indigo-500/20 text-indigo-400'
                        : 'bg-white/[0.04] text-zinc-600'
                  }`}
                >
                  {i + 1}
                </div>
                {i < 2 && (
                  <div className="w-8 h-px bg-white/[0.06]" />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="p-6">
          {/* ── STEP: Details ─────────────────────────────── */}
          {step === 'details' && (
            <div className="space-y-5">
              <div>
                <label className="block text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wide">
                  Agent name
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Research Agent"
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all"
                />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wide">
                  Description <span className="normal-case text-zinc-700">(optional)</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this agent do?"
                  rows={2}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all resize-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wide">
                  Delegate address (EOA)
                </label>
                <input
                  value={delegateAddress}
                  onChange={(e) => setDelegateAddress(e.target.value)}
                  placeholder="0x..."
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all"
                />
                <p className="text-[11px] text-zinc-700 mt-1.5">
                  The public address of the EOA that will act as the agent&apos;s spending key. You hold the private key.
                </p>
                {delegateAddress && !isValidAddress(delegateAddress) && (
                  <p className="text-[11px] text-red-400 mt-1">
                    Invalid Ethereum address
                  </p>
                )}
              </div>
              <button
                onClick={() => setStep('allowances')}
                disabled={!canProceedDetails()}
                className="w-full text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl py-2.5 transition-colors"
              >
                Next: Spending Limits
              </button>
            </div>
          )}

          {/* ── STEP: Allowances ──────────────────────────── */}
          {step === 'allowances' && (
            <div className="space-y-5">
              {/* Current allowances */}
              {allowances.length > 0 && (
                <div className="space-y-2">
                  {allowances.map((a) => (
                    <div
                      key={a.tokenSymbol}
                      className="flex items-center justify-between p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
                    >
                      <div>
                        <span className="text-sm text-zinc-200 font-medium">
                          {a.amount} {a.tokenSymbol}
                        </span>
                        <span className="text-xs text-zinc-600 ml-2">
                          {resetLabel(a.resetTimeMin)}
                        </span>
                      </div>
                      <button
                        onClick={() => handleRemoveAllowance(a.tokenSymbol)}
                        className="text-zinc-700 hover:text-red-400 transition-colors"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v6M14 11v6" />
                          <path d="M9 6V4h6v2" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add allowance form */}
              {availableTokens.length > 0 && (
                <div className="space-y-3 p-4 bg-white/[0.02] rounded-xl border border-dashed border-white/[0.08]">
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wide">
                    Add spending limit
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    <select
                      value={addToken}
                      onChange={(e) => setAddToken(e.target.value)}
                      className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50"
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
                      value={addAmount}
                      onChange={(e) => setAddAmount(e.target.value)}
                      placeholder="Amount"
                      className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50"
                    />
                    <select
                      value={addReset}
                      onChange={(e) => setAddReset(Number(e.target.value))}
                      className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50"
                    >
                      {RESET_PERIODS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={handleAddAllowance}
                    disabled={
                      !addAmount ||
                      Number(addAmount) <= 0 ||
                      !availableTokens.some((t) => t.symbol === addToken)
                    }
                    className="w-full text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 rounded-lg py-2 transition-colors"
                  >
                    + Add limit
                  </button>
                </div>
              )}

              {allowances.length === 0 && (
                <p className="text-xs text-zinc-600 text-center py-4">
                  Add at least one spending limit to continue
                </p>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setStep('details')}
                  className="flex-1 text-sm font-medium bg-white/[0.06] hover:bg-white/[0.1] text-zinc-300 rounded-xl py-2.5 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => setStep('review')}
                  disabled={allowances.length === 0}
                  className="flex-1 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl py-2.5 transition-colors"
                >
                  Next: Review
                </button>
              </div>
            </div>
          )}

          {/* ── STEP: Review ──────────────────────────────── */}
          {step === 'review' && (
            <div className="space-y-5">
              {/* Summary card */}
              <div className="bg-white/[0.03] rounded-xl p-4 border border-white/[0.06] space-y-3">
                <div>
                  <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">
                    Agent
                  </p>
                  <p className="text-sm text-zinc-200 font-medium">{name}</p>
                  {description && (
                    <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
                  )}
                </div>
                <div>
                  <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">
                    Delegate
                  </p>
                  <p className="text-xs font-mono text-zinc-400">
                    {truncate(delegateAddress)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">
                    Spending limits
                  </p>
                  <div className="space-y-1">
                    {allowances.map((a) => (
                      <div
                        key={a.tokenSymbol}
                        className="flex items-center justify-between text-xs"
                      >
                        <span className="text-zinc-300">
                          {a.amount} {a.tokenSymbol}
                        </span>
                        <span className="text-zinc-600">
                          {resetLabel(a.resetTimeMin)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* What will happen */}
              <div className="space-y-2">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wide">
                  On-chain actions (single transaction)
                </p>
                <div className="space-y-1 text-xs text-zinc-400">
                  <p className="flex items-center gap-2">
                    <span className="w-1 h-1 rounded-full bg-indigo-400" />
                    Enable AllowanceModule on Safe (if needed)
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="w-1 h-1 rounded-full bg-indigo-400" />
                    Add {truncate(delegateAddress)} as delegate
                  </p>
                  {allowances.map((a) => (
                    <p key={a.tokenSymbol} className="flex items-center gap-2">
                      <span className="w-1 h-1 rounded-full bg-indigo-400" />
                      Set {a.amount} {a.tokenSymbol} allowance ({resetLabel(a.resetTimeMin).toLowerCase()})
                    </p>
                  ))}
                </div>
              </div>

              {(safeDetails?.threshold ?? 1) > 1 && (
                <div className="text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/10 rounded-lg px-3 py-2">
                  Multi-sig Safe ({safeDetails?.threshold}/{safeDetails?.owners?.length}) — this will be proposed for co-signer approval.
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setStep('allowances')}
                  className="flex-1 text-sm font-medium bg-white/[0.06] hover:bg-white/[0.1] text-zinc-300 rounded-xl py-2.5 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleExecute}
                  className="flex-1 text-sm font-medium bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-400 hover:to-violet-500 text-white rounded-xl py-2.5 transition-all shadow-lg shadow-indigo-500/20"
                >
                  Deploy Agent
                </button>
              </div>
            </div>
          )}

          {/* ── STEP: Executing ───────────────────────────── */}
          {step === 'executing' && (
            <div className="py-8 text-center space-y-4">
              {execStatus !== 'error' ? (
                <>
                  <div className="w-10 h-10 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin mx-auto" />
                  <div>
                    <p className="text-sm text-zinc-200 font-medium">
                      {execStatus === 'checking' && 'Checking module status...'}
                      {execStatus === 'signing' && 'Sign in your wallet...'}
                      {execStatus === 'executing' && 'Executing on-chain...'}
                      {execStatus === 'saving' && 'Saving agent...'}
                    </p>
                    <p className="text-xs text-zinc-600 mt-1">
                      {execStatus === 'signing'
                        ? 'Approve the transaction in your connected wallet'
                        : 'This may take a moment'}
                    </p>
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
                    <p className="text-sm text-red-400 font-medium">
                      Setup failed
                    </p>
                    <p className="text-xs text-zinc-600 mt-1 max-w-xs mx-auto">
                      {execError}
                    </p>
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button
                      onClick={() => setStep('review')}
                      className="flex-1 text-sm font-medium bg-white/[0.06] hover:bg-white/[0.1] text-zinc-300 rounded-xl py-2.5 transition-colors"
                    >
                      Back
                    </button>
                    <button
                      onClick={handleExecute}
                      className="flex-1 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl py-2.5 transition-colors"
                    >
                      Retry
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── STEP: Done ────────────────────────────────── */}
          {step === 'done' && (
            <div className="space-y-5">
              <div className="text-center py-4">
                <div className="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-3">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-zinc-200">
                  {execStatus === 'confirmed'
                    ? 'Agent deployed successfully'
                    : 'Agent proposed for approval'}
                </p>
                {txHash && (
                  <a
                    href={
                      execStatus === 'confirmed'
                        ? `https://gnosisscan.io/tx/${txHash}`
                        : `https://app.safe.global/transactions/tx?safe=gno:${safeAddress}&id=${txHash}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-400 hover:text-indigo-300 underline underline-offset-2 mt-1 inline-block"
                  >
                    {execStatus === 'confirmed' ? 'View on Gnosisscan' : 'View in Safe{Wallet}'}
                  </a>
                )}
              </div>

              {/* API Credential */}
              {createdApiKey && (
                <div className="bg-amber-400/5 border border-amber-400/15 rounded-xl p-4 space-y-2">
                  <p className="text-[11px] text-amber-400 uppercase tracking-wide font-medium">
                    Agent API Key — save this now
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    This key is shown once. Give it to your agent for Haven API access.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono text-zinc-300 bg-black/30 rounded-lg px-3 py-2 break-all">
                      {createdApiKey}
                    </code>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(createdApiKey)
                        setCopiedKey(true)
                        setTimeout(() => setCopiedKey(false), 2000)
                      }}
                      className="flex-shrink-0 text-xs text-indigo-400 hover:text-indigo-300 transition-colors px-2 py-2"
                    >
                      {copiedKey ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={handleClose}
                className="w-full text-sm font-medium bg-white/[0.06] hover:bg-white/[0.1] text-zinc-300 rounded-xl py-2.5 transition-colors"
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
