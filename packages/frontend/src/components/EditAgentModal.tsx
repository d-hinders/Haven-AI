'use client'

import { useState, useCallback, useMemo } from 'react'
import { usePublicClient, useWalletClient, useAccount } from 'wagmi'
import { type Address, parseUnits, hashTypedData } from 'viem'
import { gnosis } from 'viem/chains'
import {
  buildSetAllowanceTx,
  RESET_PERIODS,
  type AllowanceInfo,
} from '@/lib/allowance-module'
import RecipientAllowlistEditor, { type RecipientEntry } from './RecipientAllowlistEditor'
import {
  getSafeNonce,
  signSafeTx,
  executeSafeTx,
  proposeSafeTx,
  TOKENS,
} from '@/lib/safe-tx'
import type { SafeDetails } from '@/types/transactions'
import type { Agent } from '@/hooks/useAgents'

// ── Helpers ────────────────────────────────────────────────────────

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

const TOKEN_OPTIONS = [
  { symbol: 'xDAI', label: 'xDAI', sub: 'Native', address: TOKENS['xDAI'].address, decimals: TOKENS['xDAI'].decimals },
  { symbol: 'EURe', label: 'EURe', sub: 'Monerium', address: TOKENS['EURe'].address, decimals: TOKENS['EURe'].decimals },
  { symbol: 'USDC.e', label: 'USDC.e', sub: 'Bridged USDC', address: TOKENS['USDC.e'].address, decimals: TOKENS['USDC.e'].decimals },
] as const

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
  const [step, setStep] = useState<Step>('form')

  // Form state
  const [selectedToken, setSelectedToken] = useState<string>('EURe')
  const [amount, setAmount] = useState('')
  const [resetTimeMin, setResetTimeMin] = useState(1440)
  const [approvalThreshold, setApprovalThreshold] = useState('')

  // Recipient allowlist state
  const [restrictRecipients, setRestrictRecipients] = useState(agent.restrict_recipients ?? false)
  const [allowedRecipients, setAllowedRecipients] = useState<RecipientEntry[]>(
    (agent.allowed_recipients ?? []).map((r) => ({ address: r.address, label: r.label ?? undefined })),
  )
  const [recipientsSaving, setRecipientsSaving] = useState(false)
  const [recipientsSaved, setRecipientsSaved] = useState(false)

  // Execution
  const [execStatus, setExecStatus] = useState<ExecutionStatus>('signing')
  const [execError, setExecError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  // Wagmi
  const { address: connectedAddress } = useAccount()
  const publicClient = usePublicClient({ chainId: gnosis.id })
  const { data: walletClient } = useWalletClient({ chainId: gnosis.id })

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
  const availableTokens = TOKEN_OPTIONS

  const selectedTokenConfig = TOKEN_OPTIONS.find((t) => t.symbol === selectedToken)
  const tokenAddress = selectedTokenConfig?.address ?? '0x0000000000000000000000000000000000000000'
  const isExistingToken = existingTokenAddrs.has(tokenAddress.toLowerCase())

  // ── Reset ──────────────────────────────────────────────

  const resetForm = useCallback(() => {
    setStep('form')
    setSelectedToken('EURe')
    setAmount('')
    setResetTimeMin(1440)
    setApprovalThreshold('')
    setRestrictRecipients(agent.restrict_recipients ?? false)
    setAllowedRecipients(
      (agent.allowed_recipients ?? []).map((r) => ({ address: r.address, label: r.label ?? undefined })),
    )
    setRecipientsSaving(false)
    setRecipientsSaved(false)
    setExecStatus('signing')
    setExecError(null)
    setTxHash(null)
  }, [])

  const handleClose = useCallback(() => {
    resetForm()
    onClose()
  }, [onClose, resetForm])

  // ── Execute ────────────────────────────────────────────

  async function handleExecute() {
    if (!publicClient || !walletClient || !connectedAddress || !safeDetails || !selectedTokenConfig) return
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
        walletClient,
        safeAddress as Address,
        safeTx,
        connectedAddress,
      )

      const threshold = safeDetails.threshold ?? 1

      if (threshold <= 1) {
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

      // Save to Haven backend
      setExecStatus('saving')
      const response = await fetch(`/api/agents/${agent.id}/allowances`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('haven_token')}`,
        },
        body: JSON.stringify({
          token_address: tokenAddress,
          token_symbol: selectedTokenConfig.symbol,
          allowance_amount: rawAmount.toString(),
          reset_period_min: resetTimeMin,
          approval_threshold: approvalThreshold && Number(approvalThreshold) > 0
            ? parseUnits(approvalThreshold, selectedTokenConfig.decimals).toString()
            : null,
        }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Failed to save allowance' }))
        throw new Error(body.error ?? 'Failed to save allowance')
      }

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
        setExecError('Transaction rejected in wallet')
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        className="absolute inset-0"
        onClick={step !== 'executing' ? handleClose : undefined}
      />
      <div className="relative bg-[#0e0e0e] border border-white/[0.08] rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold">Edit Agent: {agent.name}</h2>
            <p className="text-xs text-zinc-600 mt-0.5">
              {step === 'form' && 'Add or update a spending limit'}
              {step === 'review' && 'Review on-chain changes'}
              {step === 'executing' && 'Updating on-chain...'}
              {step === 'done' && 'Allowance updated'}
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

        <div className="p-6">
          {/* ── STEP: Form ─────────────────────────────── */}
          {step === 'form' && (
            <div className="space-y-5">
              {/* Existing allowances summary */}
              {existingOnChainAllowances && existingOnChainAllowances.length > 0 && (
                <div>
                  <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-2">
                    Current on-chain allowances
                  </p>
                  <div className="space-y-1">
                    {existingOnChainAllowances.map((a) => {
                      const sym = tokenSymbolFromAddr(a.token)
                      const dec = tokenDecimalsFromAddr(a.token)
                      return (
                        <div key={a.token} className="flex items-center justify-between text-xs p-2 bg-white/[0.03] rounded-lg border border-white/[0.06]">
                          <span className="text-zinc-300 font-medium">{sym}</span>
                          <span className="text-zinc-500">{formatAmountShort(a.amount, dec)} / {resetLabel(a.resetTimeMin).toLowerCase()}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Add / update allowance */}
              <div className="space-y-3 p-4 bg-white/[0.02] rounded-xl border border-dashed border-white/[0.08]">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wide">
                  {isExistingToken ? 'Update spending limit' : 'Add new spending limit'}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <select
                    value={selectedToken}
                    onChange={(e) => setSelectedToken(e.target.value)}
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
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Amount"
                    className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50"
                  />
                  <select
                    value={resetTimeMin}
                    onChange={(e) => setResetTimeMin(Number(e.target.value))}
                    className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50"
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
                    This will replace the existing {selectedToken} allowance on-chain
                  </p>
                )}

                {/* Approval threshold */}
                <div className="pt-2 border-t border-white/[0.06]">
                  <label className="block text-[11px] text-zinc-500 mb-1.5">
                    Approval threshold (optional)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={approvalThreshold}
                      onChange={(e) => setApprovalThreshold(e.target.value)}
                      placeholder={`e.g. 10`}
                      className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50"
                    />
                    <span className="text-xs text-zinc-600">{selectedToken}</span>
                  </div>
                  <p className="text-[10px] text-zinc-700 mt-1">
                    Payments above this amount require your approval in the dashboard.
                    Leave empty for no approval requirement.
                  </p>
                </div>
              </div>

              {/* Recipient allowlist */}
              <div className="p-4 bg-white/[0.02] rounded-xl border border-dashed border-white/[0.08]">
                <RecipientAllowlistEditor
                  enabled={restrictRecipients}
                  onToggle={setRestrictRecipients}
                  recipients={allowedRecipients}
                  onChange={setAllowedRecipients}
                />
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={async () => {
                      setRecipientsSaving(true)
                      setRecipientsSaved(false)
                      try {
                        await fetch(`/api/agents/${agent.id}`, {
                          method: 'PUT',
                          headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${localStorage.getItem('haven_token')}`,
                          },
                          body: JSON.stringify({
                            restrict_recipients: restrictRecipients,
                            allowed_recipients: restrictRecipients ? allowedRecipients : [],
                          }),
                        })
                        setRecipientsSaved(true)
                        setTimeout(() => setRecipientsSaved(false), 2000)
                      } catch {
                        // ignore
                      } finally {
                        setRecipientsSaving(false)
                      }
                    }}
                    disabled={recipientsSaving}
                    className="text-xs font-medium text-indigo-400 hover:text-indigo-300 disabled:opacity-50 transition-colors"
                  >
                    {recipientsSaving ? 'Saving...' : recipientsSaved ? 'Saved!' : 'Save recipients'}
                  </button>
                  <p className="text-[10px] text-zinc-700">
                    Recipients are saved to Haven (no on-chain tx needed)
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleClose}
                  className="flex-1 text-sm font-medium bg-white/[0.06] hover:bg-white/[0.1] text-zinc-300 rounded-xl py-2.5 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => setStep('review')}
                  disabled={!amount || Number(amount) <= 0}
                  className="flex-1 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl py-2.5 transition-colors"
                >
                  Review
                </button>
              </div>
            </div>
          )}

          {/* ── STEP: Review ──────────────────────────── */}
          {step === 'review' && (
            <div className="space-y-5">
              <div className="bg-white/[0.03] rounded-xl p-4 border border-white/[0.06] space-y-3">
                <div>
                  <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">Agent</p>
                  <p className="text-sm text-zinc-200 font-medium">{agent.name}</p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">Delegate</p>
                  <p className="text-xs font-mono text-zinc-400">{truncate(agent.delegate_address!)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">
                    {isExistingToken ? 'Update allowance' : 'New allowance'}
                  </p>
                  <p className="text-sm text-zinc-200">
                    {amount} {selectedToken}
                    <span className="text-zinc-600 ml-2">{resetLabel(resetTimeMin)}</span>
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wide">On-chain action</p>
                <p className="flex items-center gap-2 text-xs text-zinc-400">
                  <span className="w-1 h-1 rounded-full bg-indigo-400" />
                  {isExistingToken ? 'Update' : 'Set'} {amount} {selectedToken} allowance for {truncate(agent.delegate_address!)} ({resetLabel(resetTimeMin).toLowerCase()})
                </p>
              </div>

              {(safeDetails?.threshold ?? 1) > 1 && (
                <div className="text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/10 rounded-lg px-3 py-2">
                  Multi-sig Safe ({safeDetails?.threshold}/{safeDetails?.owners?.length}) — this will be proposed for co-signer approval.
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setStep('form')}
                  className="flex-1 text-sm font-medium bg-white/[0.06] hover:bg-white/[0.1] text-zinc-300 rounded-xl py-2.5 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleExecute}
                  className="flex-1 text-sm font-medium bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-400 hover:to-violet-500 text-white rounded-xl py-2.5 transition-all shadow-lg shadow-indigo-500/20"
                >
                  {isExistingToken ? 'Update Allowance' : 'Add Allowance'}
                </button>
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
                    <p className="text-sm text-zinc-200 font-medium">
                      {execStatus === 'signing' && 'Sign in your wallet...'}
                      {execStatus === 'executing' && 'Executing on-chain...'}
                      {execStatus === 'saving' && 'Saving to Haven...'}
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
                    <p className="text-sm text-red-400 font-medium">Update failed</p>
                    <p className="text-xs text-zinc-600 mt-1 max-w-xs mx-auto">{execError}</p>
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

          {/* ── STEP: Done ────────────────────────────── */}
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
                    ? 'Allowance updated successfully'
                    : 'Update proposed for approval'}
                </p>
                <p className="text-xs text-zinc-500 mt-1">
                  {amount} {selectedToken} — {resetLabel(resetTimeMin).toLowerCase()}
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

// ── Token helpers (local) ─────────────────────────────────────────

function tokenSymbolFromAddr(addr: string): string {
  const lower = addr.toLowerCase()
  if (lower === '0x0000000000000000000000000000000000000000') return 'xDAI'
  for (const [symbol, cfg] of Object.entries(TOKENS)) {
    if (cfg.address && cfg.address.toLowerCase() === lower) return symbol
  }
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function tokenDecimalsFromAddr(addr: string): number {
  const lower = addr.toLowerCase()
  if (lower === '0x0000000000000000000000000000000000000000') return 18
  for (const cfg of Object.values(TOKENS)) {
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
