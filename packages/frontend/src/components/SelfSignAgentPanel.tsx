'use client'

import { useState, useEffect, useCallback } from 'react'
import { parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { useAuth } from '@/context/AuthContext'
import { useSelfSignAgents, type SelfSignAgent } from '@/hooks/useSelfSignAgents'
import { RESET_PERIODS } from '@/lib/allowance-module'
import { getChainTokens } from '@/lib/safe-tx'
import { truncate, isValidAddress } from '@/lib/format'
import RecipientAllowlistEditor, { type RecipientEntry } from './RecipientAllowlistEditor'

// ── Local types ────────────────────────────────────────────────────

interface AllowanceEntry {
  tokenSymbol: string
  tokenAddress: string
  decimals: number
  amount: string
  resetTimeMin: number
}

type Step = 'details' | 'allowances' | 'review'
type KeyMode = 'generate' | 'existing'

// ── Icons ──────────────────────────────────────────────────────────

function KeyIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="M21 2l-9.6 9.6M15.5 7.5L19 11l3-3-3.5-3.5" />
    </svg>
  )
}

function PlusIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  )
}

function CopyIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  )
}

function ShieldIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function CloseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function resetLabel(mins: number) {
  return RESET_PERIODS.find((p) => p.value === mins)?.label ?? `${mins}m`
}

// ── Create Modal ───────────────────────────────────────────────────

function CreateSelfSignModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (data: {
    name: string
    description?: string
    delegate_address: string
    safe_id?: string
    restrict_recipients?: boolean
    allowed_recipients?: { address: string; label?: string }[]
    allowances?: {
      token_address: string
      token_symbol: string
      allowance_amount: string
      reset_period_min: number
    }[]
  }) => Promise<void>
}) {
  const { activeSafe } = useAuth()
  const chainId = activeSafe?.chain_id ?? 100
  const chainTokens = getChainTokens(chainId)
  const tokenOptions = Object.entries(chainTokens).map(([symbol, cfg]) => ({
    symbol,
    address: cfg.address ?? '0x0000000000000000000000000000000000000000',
    decimals: cfg.decimals,
  }))

  // Step
  const [step, setStep] = useState<Step>('details')

  // Details
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [keyMode, setKeyMode] = useState<KeyMode>('generate')
  const [delegateAddress, setDelegateAddress] = useState('')
  const [generatedPrivateKey, setGeneratedPrivateKey] = useState<string | null>(null)
  const [keySaved, setKeySaved] = useState(false)
  const [showPrivateKey, setShowPrivateKey] = useState(false)
  const [copiedPrivateKey, setCopiedPrivateKey] = useState(false)

  // Allowances
  const [allowances, setAllowances] = useState<AllowanceEntry[]>([])
  const [addToken, setAddToken] = useState(tokenOptions[0]?.symbol ?? '')
  const [addAmount, setAddAmount] = useState('')
  const [addReset, setAddReset] = useState(1440)

  // Recipients
  const [restrictRecipients, setRestrictRecipients] = useState(false)
  const [allowedRecipients, setAllowedRecipients] = useState<RecipientEntry[]>([])

  // Submit
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Key generation ─────────────────────────────────────

  const handleGenerateKey = useCallback(() => {
    const pk = generatePrivateKey()
    const addr = privateKeyToAddress(pk)
    setGeneratedPrivateKey(pk)
    setDelegateAddress(addr)
    setKeySaved(false)
    setShowPrivateKey(false)
    setCopiedPrivateKey(false)
  }, [])

  function handleSwitchKeyMode(mode: KeyMode) {
    setKeyMode(mode)
    setDelegateAddress('')
    setGeneratedPrivateKey(null)
    setKeySaved(false)
    setShowPrivateKey(false)
    setCopiedPrivateKey(false)
    if (mode === 'generate') handleGenerateKey()
  }

  useEffect(() => {
    if (keyMode === 'generate' && !generatedPrivateKey) handleGenerateKey()
  }, [keyMode, generatedPrivateKey, handleGenerateKey])

  function copyToClipboard(text: string, setter: (v: boolean) => void) {
    navigator.clipboard.writeText(text)
    setter(true)
    setTimeout(() => setter(false), 2000)
  }

  // ── Details validation ─────────────────────────────────

  function canProceedDetails() {
    if (!name.trim()) return false
    if (!isValidAddress(delegateAddress)) return false
    if (keyMode === 'generate' && !keySaved) return false
    return true
  }

  // ── Allowances ─────────────────────────────────────────

  function handleAddAllowance() {
    const tokenOpt = tokenOptions.find((t) => t.symbol === addToken)
    if (!tokenOpt || !addAmount || Number(addAmount) <= 0) return
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

  const availableTokens = tokenOptions.filter(
    (t) => !allowances.some((a) => a.tokenSymbol === t.symbol),
  )

  // ── Submit ─────────────────────────────────────────────

  async function handleSubmit() {
    setLoading(true)
    setError(null)
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim() || undefined,
        delegate_address: delegateAddress,
        safe_id: activeSafe?.id,
        restrict_recipients: restrictRecipients,
        allowed_recipients: restrictRecipients
          ? allowedRecipients.map((r) => ({ address: r.address, label: r.label || undefined }))
          : [],
        allowances: allowances.map((a) => ({
          token_address: a.tokenAddress,
          token_symbol: a.tokenSymbol,
          allowance_amount: parseUnits(a.amount, a.decimals).toString(),
          reset_period_min: a.resetTimeMin,
        })),
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create agent')
      setLoading(false)
    }
  }

  // ── Render ─────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative bg-[#0e0e0e] border border-white/[0.08] rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold">New Self-Sign Agent</h2>
            <p className="text-xs text-zinc-600 mt-0.5">
              {step === 'details' && 'Agent identity and delegate key'}
              {step === 'allowances' && 'Configure spending limits'}
              {step === 'review' && 'Review and create'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 -mr-1 rounded-md text-zinc-700 hover:text-zinc-400 hover:bg-white/[0.04] transition-colors"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Step indicators */}
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
              {i < 2 && <div className="w-8 h-px bg-white/[0.06]" />}
            </div>
          ))}
        </div>

        <div className="p-6">

          {/* ── STEP 1: Details ───────────────────────────── */}
          {step === 'details' && (
            <div className="space-y-5">
              <div>
                <label className="block text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wide">Agent name</label>
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

              {/* Key mode selector */}
              <div>
                <label className="block text-[11px] text-zinc-500 mb-2 uppercase tracking-wide">Delegate key</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['generate', 'existing'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => handleSwitchKeyMode(mode)}
                      className={`relative p-3 rounded-xl border text-left transition-all ${
                        keyMode === mode
                          ? 'border-indigo-500/50 bg-indigo-500/5'
                          : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.12]'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                          keyMode === mode ? 'border-indigo-400' : 'border-zinc-700'
                        }`}>
                          {keyMode === mode && <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />}
                        </div>
                        <span className={`text-xs font-medium ${keyMode === mode ? 'text-zinc-200' : 'text-zinc-400'}`}>
                          {mode === 'generate' ? 'Generate new' : 'Use existing'}
                        </span>
                      </div>
                      <p className="text-[10px] text-zinc-600 ml-5.5 pl-0.5">
                        {mode === 'generate' ? 'Haven creates a keypair for you' : 'Provide your own wallet address'}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Generate mode */}
              {keyMode === 'generate' && generatedPrivateKey && (
                <div className="space-y-3">
                  <div>
                    <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">Delegate address</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs font-mono text-zinc-400 bg-white/[0.03] rounded-lg px-3 py-2 truncate">
                        {delegateAddress}
                      </code>
                      <button
                        onClick={() => copyToClipboard(delegateAddress, () => {})}
                        className="flex-shrink-0 text-zinc-700 hover:text-zinc-400 transition-colors p-1"
                      >
                        <CopyIcon size={13} />
                      </button>
                    </div>
                  </div>

                  <div className="bg-amber-400/5 border border-amber-400/15 rounded-xl p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400 flex-shrink-0">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                      <p className="text-[11px] text-amber-400 uppercase tracking-wide font-medium">Private key — save this now</p>
                    </div>
                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                      Generated in your browser and never stored by Haven. Your agent needs this key to sign requests.
                      If you lose it you&apos;ll need to revoke this agent and create a new one.
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

                  <button
                    onClick={handleGenerateKey}
                    className="text-[11px] text-zinc-700 hover:text-zinc-400 transition-colors"
                  >
                    Generate a different key
                  </button>
                </div>
              )}

              {/* Existing mode */}
              {keyMode === 'existing' && (
                <div className="space-y-2">
                  <input
                    value={delegateAddress}
                    onChange={(e) => setDelegateAddress(e.target.value)}
                    placeholder="0x..."
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all"
                  />
                  {delegateAddress && !isValidAddress(delegateAddress) && (
                    <p className="text-[11px] text-red-400">Invalid Ethereum address</p>
                  )}
                  <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2.5">
                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                      Enter the public address of the wallet your agent will use for signing.
                      Haven will never ask for or store the private key.
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

          {/* ── STEP 2: Allowances ────────────────────────── */}
          {step === 'allowances' && (
            <div className="space-y-5">
              {/* Existing allowances */}
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
                          <path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add allowance form */}
              {availableTokens.length > 0 && (
                <div className="space-y-3 p-4 bg-white/[0.02] rounded-xl border border-dashed border-white/[0.08]">
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Add spending limit</p>
                  <div className="grid grid-cols-3 gap-2">
                    <select
                      value={addToken}
                      onChange={(e) => setAddToken(e.target.value)}
                      className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50"
                    >
                      {availableTokens.map((t) => (
                        <option key={t.symbol} value={t.symbol}>{t.symbol}</option>
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
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={handleAddAllowance}
                    disabled={!addAmount || Number(addAmount) <= 0 || !availableTokens.some((t) => t.symbol === addToken)}
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

          {/* ── STEP 3: Review ────────────────────────────── */}
          {step === 'review' && (
            <div className="space-y-5">
              <div className="bg-white/[0.03] rounded-xl p-4 border border-white/[0.06] space-y-3">
                <div>
                  <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">Agent</p>
                  <p className="text-sm text-zinc-200 font-medium">{name}</p>
                  {description && <p className="text-xs text-zinc-500 mt-0.5">{description}</p>}
                </div>
                <div>
                  <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">Delegate address</p>
                  <p className="text-xs font-mono text-zinc-400">
                    {truncate(delegateAddress)}
                    {keyMode === 'generate' && (
                      <span className="text-indigo-400/60 ml-2 font-sans">(generated)</span>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">Spending limits</p>
                  <div className="space-y-1">
                    {allowances.map((a) => (
                      <div key={a.tokenSymbol} className="flex items-center justify-between text-xs">
                        <span className="text-zinc-300">{a.amount} {a.tokenSymbol}</span>
                        <span className="text-zinc-600">{resetLabel(a.resetTimeMin)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {restrictRecipients && (
                  <div>
                    <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">Recipient allowlist</p>
                    {allowedRecipients.length > 0 ? (
                      <div className="space-y-1">
                        {allowedRecipients.map((r) => (
                          <div key={r.address} className="text-xs text-zinc-400">
                            {r.label
                              ? <span>{r.label} <span className="font-mono text-zinc-600">({truncate(r.address)})</span></span>
                              : <span className="font-mono">{truncate(r.address)}</span>}
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
                <div>
                  <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">Authentication</p>
                  <p className="text-xs text-zinc-500">EIP-191 personal_sign — no API key stored</p>
                </div>
              </div>

              {error && (
                <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">
                  {error}
                </p>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setStep('allowances')}
                  disabled={loading}
                  className="flex-1 text-sm font-medium bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-30 text-zinc-300 rounded-xl py-2.5 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={loading}
                  className="flex-1 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl py-2.5 transition-colors"
                >
                  {loading ? 'Creating…' : 'Create Agent'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Agent Card ─────────────────────────────────────────────────────

function AgentCard({
  agent,
  onRevoke,
  onDelete,
}: {
  agent: SelfSignAgent
  onRevoke: () => void
  onDelete: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isActive = agent.status === 'active'

  function copyAddress() {
    navigator.clipboard.writeText(agent.delegate_address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={`bg-white/[0.02] border rounded-xl p-5 hover:border-white/[0.1] transition-all space-y-3 ${isActive ? 'border-white/[0.06]' : 'border-white/[0.04] opacity-60'}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${isActive ? 'bg-indigo-500/10 text-indigo-400' : 'bg-white/[0.04] text-zinc-600'}`}>
            <ShieldIcon size={17} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-zinc-200 truncate">{agent.name}</h3>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${
                isActive ? 'bg-emerald-500/10 text-emerald-400' : agent.status === 'revoked' ? 'bg-red-500/10 text-red-400' : 'bg-zinc-800 text-zinc-500'
              }`}>
                {agent.status}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-zinc-800/80 text-zinc-500 flex-shrink-0">
                self-sign
              </span>
            </div>
            {agent.safe_name && (
              <p className="text-xs text-zinc-500 mt-0.5"><span className="text-zinc-600">Account:</span> {agent.safe_name}</p>
            )}
            {agent.description && (
              <p className="text-xs text-zinc-600 mt-0.5">{agent.description}</p>
            )}
          </div>
        </div>
      </div>

      {/* Delegate address */}
      <div className="bg-zinc-800/40 rounded-lg px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[10px] text-zinc-600 mb-0.5 uppercase tracking-wide">Delegate</p>
            <p className="font-mono text-xs text-zinc-400">{agent.delegate_address}</p>
          </div>
          <button
            onClick={copyAddress}
            className="p-1.5 rounded text-zinc-600 hover:text-zinc-300 transition-colors flex-shrink-0"
            title="Copy address"
          >
            {copied ? <span className="text-emerald-400 text-xs">✓</span> : <CopyIcon />}
          </button>
        </div>
      </div>

      {/* Auth info */}
      <div className="flex items-center gap-1.5 text-xs text-zinc-600">
        <ShieldIcon size={12} />
        <span>Authenticates via EIP-191 personal_sign — no API key stored</span>
      </div>

      {/* Recipient restriction */}
      {isActive && agent.restrict_recipients && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-indigo-500/5 border border-indigo-500/10 rounded-lg">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-indigo-400 flex-shrink-0">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span className="text-[10px] text-indigo-400">
            Restricted to {agent.allowed_recipients?.length ?? 0} allowed recipient{(agent.allowed_recipients?.length ?? 0) !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Spending limits */}
      {isActive && agent.allowances.length > 0 && (
        <div>
          <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1.5">Spending limits</p>
          <div className="space-y-1">
            {agent.allowances.map((a) => (
              <div key={a.token_address} className="flex items-center justify-between bg-zinc-800/40 rounded-lg px-3 py-1.5 text-xs">
                <span className="text-zinc-300 font-medium">{a.token_symbol}</span>
                <span className="text-zinc-500 font-mono">
                  {a.allowance_amount}
                  {a.reset_period_min > 0 && (
                    <span className="text-zinc-700"> / {resetLabel(a.reset_period_min).toLowerCase()}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      {isActive && (
        <div className="flex items-center gap-2 pt-3 border-t border-white/[0.05]">
          {confirmRevoke ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500">Revoke agent?</span>
              <button onClick={() => { onRevoke(); setConfirmRevoke(false) }} className="text-red-400 hover:text-red-300 font-medium transition-colors">Yes</button>
              <button onClick={() => setConfirmRevoke(false)} className="text-zinc-600 hover:text-zinc-400 transition-colors">No</button>
            </div>
          ) : (
            <button onClick={() => setConfirmRevoke(true)} className="text-xs text-zinc-600 hover:text-amber-400 transition-colors">Revoke</button>
          )}
          <span className="text-zinc-800">|</span>
          {confirmDelete ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500">Delete?</span>
              <button onClick={() => { onDelete(); setConfirmDelete(false) }} className="text-red-400 hover:text-red-300 font-medium transition-colors">Yes</button>
              <button onClick={() => setConfirmDelete(false)} className="text-zinc-600 hover:text-zinc-400 transition-colors">No</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────

export default function SelfSignAgentPanel() {
  const {
    agents,
    loading,
    error,
    fetchAgents,
    createAgent,
    revokeAgent,
    deleteAgent,
  } = useSelfSignAgents()

  const [showCreate, setShowCreate] = useState(false)

  useEffect(() => {
    fetchAgents()
  }, [fetchAgents])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <ShieldIcon size={16} />
            <h2 className="text-sm font-semibold">Self-Sign Agents</h2>
          </div>
          <p className="text-xs text-zinc-500 max-w-md">
            Agents that authenticate by signing requests with their Ethereum private key.
            No API key is stored — identity is proven cryptographically.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white text-black rounded-lg font-medium hover:bg-zinc-200 transition-colors flex-shrink-0"
        >
          <PlusIcon />
          New Agent
        </button>
      </div>

      {/* How it works */}
      <div className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/40">
        <p className="text-xs font-medium text-zinc-400 mb-2 flex items-center gap-1.5">
          <KeyIcon size={13} />
          How self-sign authentication works
        </p>
        <ol className="text-xs text-zinc-500 space-y-1 list-decimal list-inside">
          <li>Register the agent&apos;s Ethereum address and spending limits here</li>
          <li>The agent signs each API request with that wallet&apos;s private key</li>
          <li>Backend recovers the signer address from the EIP-191 signature</li>
          <li>If it matches the registered address → request is authorized</li>
        </ol>
        <div className="mt-3 pt-3 border-t border-zinc-800">
          <p className="text-xs text-zinc-600 font-mono">Headers required per request:</p>
          <div className="mt-1 space-y-0.5 font-mono text-xs text-zinc-500">
            <p>X-Agent-Address: 0x...</p>
            <p>X-Agent-Signature: 0x... (EIP-191)</p>
            <p>X-Agent-Timestamp: 1714000000 (Unix seconds)</p>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {/* Agent list */}
      {loading ? (
        <div className="text-sm text-zinc-500 py-8 text-center">Loading agents…</div>
      ) : agents.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-zinc-800 rounded-xl">
          <ShieldIcon size={24} />
          <p className="mt-3 text-sm text-zinc-500">No self-sign agents yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Create one to let an Ethereum wallet authenticate without an API key
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onRevoke={() => revokeAgent(agent.id)}
              onDelete={() => deleteAgent(agent.id)}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateSelfSignModal
          onClose={() => setShowCreate(false)}
          onCreate={createAgent}
        />
      )}
    </div>
  )
}
