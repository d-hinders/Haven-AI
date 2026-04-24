'use client'

import { useState, useCallback, useEffect } from 'react'
import { usePublicClient, useWalletClient, useAccount } from 'wagmi'
import { type Address, parseUnits, hashTypedData } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import {
  buildAgentSetupTx,
  isModuleEnabled,
  RESET_PERIODS,
  type AllowanceSetup,
} from '@/lib/allowance-module'
import { api } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import RecipientAllowlistEditor, { type RecipientEntry } from './RecipientAllowlistEditor'
import {
  getSafeNonce,
  signSafeTx,
  executeSafeTx,
  proposeSafeTx,
  getChainTokens,
} from '@/lib/safe-tx'
import type { SafeDetails } from '@/types/transactions'
import { truncate, isValidAddress } from '@/lib/format'


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

type KeyMode = 'generate' | 'existing'

interface Props {
  open: boolean
  onClose: () => void
  safeAddress: string
  safeId?: string | null
  safeDetails: SafeDetails | null
  preset?: 'demo' | null
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
  safeId,
  safeDetails,
  preset = null,
  onCreated,
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

  // Step state
  const [step, setStep] = useState<Step>('details')

  // Form: details
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [delegateAddress, setDelegateAddress] = useState('')

  // Delegate key generation
  const [keyMode, setKeyMode] = useState<KeyMode>('generate')
  const [generatedPrivateKey, setGeneratedPrivateKey] = useState<string | null>(null)
  const [keySaved, setKeySaved] = useState(false)
  const [showPrivateKey, setShowPrivateKey] = useState(false)
  const [copiedPrivateKey, setCopiedPrivateKey] = useState(false)

  // Form: allowances
  const [allowances, setAllowances] = useState<AllowanceEntry[]>([])
  const [addToken, setAddToken] = useState<string>(tokenOptions[0]?.symbol ?? '')
  const [addAmount, setAddAmount] = useState('')
  const [addReset, setAddReset] = useState(1440) // daily

  // Form: recipient allowlist
  const [restrictRecipients, setRestrictRecipients] = useState(false)
  const [allowedRecipients, setAllowedRecipients] = useState<RecipientEntry[]>([])

  // Execution
  const [execStatus, setExecStatus] = useState<ExecutionStatus>('checking')
  const [execError, setExecError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  // Result
  const [createdApiKey, setCreatedApiKey] = useState<string | null>(null)
  const [copiedApiKey, setCopiedApiKey] = useState(false)
  const [copiedDoneKey, setCopiedDoneKey] = useState(false)

  // Wagmi
  const { address: connectedAddress } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  // ── Reset ──────────────────────────────────────────────

  const resetForm = useCallback(() => {
    setStep('details')
    setName('')
    setDescription('')
    setDelegateAddress('')
    setKeyMode('generate')
    setGeneratedPrivateKey(null)
    setKeySaved(false)
    setShowPrivateKey(false)
    setCopiedPrivateKey(false)
    setAllowances([])
    setAddToken(tokenOptions[0]?.symbol ?? '')
    setAddAmount('')
    setAddReset(1440)
    setRestrictRecipients(false)
    setAllowedRecipients([])
    setExecStatus('checking')
    setExecError(null)
    setTxHash(null)
    setCreatedApiKey(null)
    setCopiedApiKey(false)
    setCopiedDoneKey(false)
  }, [])

  const handleClose = useCallback(() => {
    resetForm()
    onClose()
  }, [onClose, resetForm])

  // Escape-to-close — allow closing in all steps except while an on-chain
  // action is actively in flight (mirrors the backdrop-click behaviour).
  useEscapeToClose(open, handleClose, {
    enabled: !(step === 'executing' && execStatus !== 'error'),
  })

  // Apply demo preset when the modal opens with preset='demo'
  useEffect(() => {
    if (!open || preset !== 'demo') return
    // Pick a USDC-flavored token if available, else first non-native
    const usdc =
      tokenOptions.find((t) => t.symbol.toUpperCase().startsWith('USDC')) ??
      tokenOptions.find((t) => t.address !== null) ??
      tokenOptions[0]
    if (!usdc) return

    const privateKey = generatePrivateKey()
    const address = privateKeyToAddress(privateKey)
    setName('Demo Research Agent')
    setDescription('Pre-configured for x402 API access — 10 USDC/day')
    setKeyMode('generate')
    setGeneratedPrivateKey(privateKey)
    setDelegateAddress(address)
    setKeySaved(true)
    setAllowances([
      {
        tokenSymbol: usdc.symbol,
        tokenAddress: usdc.address,
        decimals: usdc.decimals,
        amount: '10',
        resetTimeMin: 1440,
      },
    ])
    setStep('review')
    // Intentionally only reruns when open/preset change; tokenOptions is derived from chainId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preset])

  // ── Key Generation ─────────────────────────────────────

  function handleGenerateKey() {
    const privateKey = generatePrivateKey()
    const address = privateKeyToAddress(privateKey)
    setGeneratedPrivateKey(privateKey)
    setDelegateAddress(address)
    setKeySaved(false)
    setShowPrivateKey(false)
  }

  function handleSwitchKeyMode(mode: KeyMode) {
    setKeyMode(mode)
    setDelegateAddress('')
    setGeneratedPrivateKey(null)
    setKeySaved(false)
    setShowPrivateKey(false)
    setCopiedPrivateKey(false)
    if (mode === 'generate') {
      handleGenerateKey()
    }
  }

  // ── Step: Details ──────────────────────────────────────

  function canProceedDetails() {
    if (!name.trim()) return false
    if (!isValidAddress(delegateAddress)) return false
    if (keyMode === 'generate' && !keySaved) return false
    return true
  }

  // ── Step: Allowances ───────────────────────────────────

  function handleAddAllowance() {
    const tokenOpt = tokenOptions.find((t) => t.symbol === addToken)
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
        chainId,
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
          chainId,
        )
        setTxHash(result.txHash)
      } else {
        // Multi-sig: propose
        setExecStatus('executing')
        const safeTxHash = hashTypedData({
          domain: {
            chainId,
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
          chainId,
        )
        setTxHash(safeTxHash)
      }

      // 5. Save agent to Haven backend
      setExecStatus('saving')
      const agent = await api.post<{ id: string; name: string; api_key: string; delegate_address: string }>('/agents', {
          name: name.trim(),
          description: description.trim() || undefined,
          delegate_address: delegateAddress,
          safe_id: safeId || undefined,
          restrict_recipients: restrictRecipients,
          allowed_recipients: restrictRecipients ? allowedRecipients : [],
          allowances: allowances.map((a) => ({
            token_address:
              a.tokenAddress ?? '0x0000000000000000000000000000000000000000',
            token_symbol: a.tokenSymbol,
            allowance_amount: parseUnits(a.amount, a.decimals).toString(),
            reset_period_min: a.resetTimeMin,
          })),
        })
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

  // ── Copy helpers ───────────────────────────────────────

  function copyToClipboard(text: string, setter: (v: boolean) => void) {
    navigator.clipboard.writeText(text)
    setter(true)
    setTimeout(() => setter(false), 2000)
  }

  // Generate key on first open if in generate mode and no key yet
  useEffect(() => {
    if (open && keyMode === 'generate' && !generatedPrivateKey && step === 'details') {
      handleGenerateKey()
    }
    // handleGenerateKey is stable (no deps); we intentionally only react to modal open/mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, keyMode, generatedPrivateKey, step])

  // ── Render ─────────────────────────────────────────────

  if (!open) return null

  const availableTokens = tokenOptions.filter(
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
            aria-label="Close"
            className="p-1 -mr-1 rounded-md text-zinc-700 hover:text-zinc-400 hover:bg-white/[0.04] disabled:opacity-20 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
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

              {/* ── Delegate key mode selector ──────────── */}
              <div>
                <label className="block text-[11px] text-zinc-500 mb-2 uppercase tracking-wide">
                  Delegate key
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => handleSwitchKeyMode('generate')}
                    className={`relative p-3 rounded-xl border text-left transition-all ${
                      keyMode === 'generate'
                        ? 'border-indigo-500/50 bg-indigo-500/5'
                        : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.12]'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                        keyMode === 'generate' ? 'border-indigo-400' : 'border-zinc-700'
                      }`}>
                        {keyMode === 'generate' && (
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                        )}
                      </div>
                      <span className={`text-xs font-medium ${
                        keyMode === 'generate' ? 'text-zinc-200' : 'text-zinc-400'
                      }`}>
                        Generate new
                      </span>
                    </div>
                    <p className="text-[10px] text-zinc-600 ml-5.5 pl-0.5">
                      Haven creates a keypair for you
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSwitchKeyMode('existing')}
                    className={`relative p-3 rounded-xl border text-left transition-all ${
                      keyMode === 'existing'
                        ? 'border-indigo-500/50 bg-indigo-500/5'
                        : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.12]'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                        keyMode === 'existing' ? 'border-indigo-400' : 'border-zinc-700'
                      }`}>
                        {keyMode === 'existing' && (
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                        )}
                      </div>
                      <span className={`text-xs font-medium ${
                        keyMode === 'existing' ? 'text-zinc-200' : 'text-zinc-400'
                      }`}>
                        Use existing
                      </span>
                    </div>
                    <p className="text-[10px] text-zinc-600 ml-5.5 pl-0.5">
                      Provide your own wallet address
                    </p>
                  </button>
                </div>
              </div>

              {/* ── Generate mode ───────────────────────── */}
              {keyMode === 'generate' && generatedPrivateKey && (
                <div className="space-y-3">
                  {/* Generated address */}
                  <div>
                    <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">
                      Delegate address
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs font-mono text-zinc-400 bg-white/[0.03] rounded-lg px-3 py-2 truncate">
                        {delegateAddress}
                      </code>
                      <button
                        onClick={() => copyToClipboard(delegateAddress, () => {})}
                        className="flex-shrink-0 text-zinc-700 hover:text-zinc-400 transition-colors p-1"
                        title="Copy address"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Private key — critical save area */}
                  <div className="bg-amber-400/5 border border-amber-400/15 rounded-xl p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400 flex-shrink-0">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                      <p className="text-[11px] text-amber-400 uppercase tracking-wide font-medium">
                        Private key — save this now
                      </p>
                    </div>
                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                      This key is generated in your browser and will never be stored by Haven.
                      Your agent needs this key to sign transactions. If you lose it, you&apos;ll need to
                      revoke this agent and create a new one.
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs font-mono text-zinc-300 bg-black/30 rounded-lg px-3 py-2 break-all select-all">
                        {showPrivateKey
                          ? generatedPrivateKey
                          : `${generatedPrivateKey.slice(0, 10)}${'•'.repeat(32)}${generatedPrivateKey.slice(-6)}`}
                      </code>
                      <div className="flex flex-col gap-1 flex-shrink-0">
                        <button
                          onClick={() => setShowPrivateKey(!showPrivateKey)}
                          className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors px-2 py-1"
                        >
                          {showPrivateKey ? 'Hide' : 'Show'}
                        </button>
                        <button
                          onClick={() => copyToClipboard(generatedPrivateKey, setCopiedPrivateKey)}
                          className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors px-2 py-1"
                        >
                          {copiedPrivateKey ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                    </div>

                    {/* Save confirmation checkbox */}
                    <label className="flex items-start gap-2.5 cursor-pointer group pt-1">
                      <div className="relative mt-0.5 flex-shrink-0">
                        <input
                          type="checkbox"
                          checked={keySaved}
                          onChange={(e) => setKeySaved(e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="w-4 h-4 rounded border-2 border-zinc-700 peer-checked:border-indigo-500 peer-checked:bg-indigo-500 transition-all flex items-center justify-center">
                          {keySaved && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </div>
                      </div>
                      <span className="text-[11px] text-zinc-400 group-hover:text-zinc-300 transition-colors leading-relaxed">
                        I have securely saved this private key and understand it cannot be recovered
                      </span>
                    </label>
                  </div>

                  {/* Regenerate button */}
                  <button
                    onClick={handleGenerateKey}
                    className="text-[11px] text-zinc-700 hover:text-zinc-400 transition-colors"
                  >
                    Generate a different key
                  </button>
                </div>
              )}

              {/* ── Existing mode ──────────────────────── */}
              {keyMode === 'existing' && (
                <div className="space-y-2">
                  <input
                    value={delegateAddress}
                    onChange={(e) => setDelegateAddress(e.target.value)}
                    placeholder="0x..."
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all"
                  />
                  {delegateAddress && !isValidAddress(delegateAddress) && (
                    <p className="text-[11px] text-red-400">
                      Invalid Ethereum address
                    </p>
                  )}
                  <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2.5">
                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                      Enter the public address of the wallet your agent will use for signing.
                      Make sure your agent has access to this wallet&apos;s private key — Haven will
                      never ask for it or store it.
                    </p>
                  </div>
                </div>
              )}

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

              {/* Recipient allowlist */}
              <div className="pt-2 border-t border-white/[0.06]">
                <RecipientAllowlistEditor
                  enabled={restrictRecipients}
                  onToggle={setRestrictRecipients}
                  recipients={allowedRecipients}
                  onChange={setAllowedRecipients}
                />
              </div>

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
                    {keyMode === 'generate' && (
                      <span className="text-indigo-400/60 ml-2 font-sans">(generated)</span>
                    )}
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
                {restrictRecipients && (
                  <div>
                    <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">
                      Recipient allowlist
                    </p>
                    {allowedRecipients.length > 0 ? (
                      <div className="space-y-1">
                        {allowedRecipients.map((r) => (
                          <div key={r.address} className="text-xs text-zinc-400">
                            {r.label ? (
                              <span>{r.label} <span className="font-mono text-zinc-600">({truncate(r.address)})</span></span>
                            ) : (
                              <span className="font-mono">{truncate(r.address)}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-amber-400/70">
                        Restriction enabled but no recipients added — agent won&apos;t be able to send to anyone
                      </p>
                    )}
                  </div>
                )}
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
                        ? getExplorerUrl(chainId, 'tx', txHash)
                        : `https://app.safe.global/transactions/tx?safe=${getChainConfig(chainId).shortName}:${safeAddress}&id=${txHash}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-400 hover:text-indigo-300 underline underline-offset-2 mt-1 inline-block"
                  >
                    {execStatus === 'confirmed' ? `View on ${getChainConfig(chainId).name} Explorer` : 'View in Safe{Wallet}'}
                  </a>
                )}
              </div>

              {/* Agent credentials — combined section */}
              <div className="bg-amber-400/5 border border-amber-400/15 rounded-xl p-4 space-y-4">
                <div className="flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400 flex-shrink-0">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <p className="text-[11px] text-amber-400 uppercase tracking-wide font-medium">
                    Agent credentials — save {generatedPrivateKey ? 'both' : 'this'} now
                  </p>
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  Your agent needs {generatedPrivateKey ? 'both of these credentials' : 'this API key'} to operate through Haven.
                  {generatedPrivateKey ? ' Neither' : ' This key'} will be shown again.
                </p>

                {/* API Key */}
                {createdApiKey && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] text-zinc-600 uppercase tracking-wide">
                      API Key
                      <span className="normal-case text-zinc-700 ml-1">— authenticates with Haven</span>
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs font-mono text-zinc-300 bg-black/30 rounded-lg px-3 py-2 break-all">
                        {createdApiKey}
                      </code>
                      <button
                        onClick={() => copyToClipboard(createdApiKey, setCopiedApiKey)}
                        className="flex-shrink-0 text-xs text-indigo-400 hover:text-indigo-300 transition-colors px-2 py-2"
                      >
                        {copiedApiKey ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Delegate Private Key (only if generated) */}
                {generatedPrivateKey && (
                  <div className="space-y-1.5 pt-2 border-t border-amber-400/10">
                    <p className="text-[10px] text-zinc-600 uppercase tracking-wide">
                      Delegate Private Key
                      <span className="normal-case text-zinc-700 ml-1">— signs transactions</span>
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs font-mono text-zinc-300 bg-black/30 rounded-lg px-3 py-2 break-all">
                        {generatedPrivateKey}
                      </code>
                      <button
                        onClick={() => copyToClipboard(generatedPrivateKey, setCopiedDoneKey)}
                        className="flex-shrink-0 text-xs text-indigo-400 hover:text-indigo-300 transition-colors px-2 py-2"
                      >
                        {copiedDoneKey ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Usage hint */}
              {generatedPrivateKey && (
                <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2.5">
                  <p className="text-[11px] text-zinc-600 leading-relaxed">
                    <span className="text-zinc-500 font-medium">Next step:</span> Add both credentials
                    to your agent&apos;s environment variables. The API key goes in{' '}
                    <code className="text-zinc-500">AGENT_API_KEY</code> and the private key in{' '}
                    <code className="text-zinc-500">DELEGATE_PRIVATE_KEY</code>.
                  </p>
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
