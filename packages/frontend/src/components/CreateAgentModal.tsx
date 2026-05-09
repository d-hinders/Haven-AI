'use client'

import { useState, useCallback, useEffect } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address, parseUnits } from 'viem'
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
import NetworkGate from './NetworkGate'
import {
  getSafeNonce,
  signSafeTx,
  executeSafeTx,
  proposeSafeTx,
  getSafeTxHash,
  getChainTokens,
} from '@/lib/safe-tx'
import { truncate, isValidAddress } from '@/lib/format'
import { buildHandoff, buildDotenv, type HandoffInput } from '@/lib/agent-handoff'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { useActiveSigner } from '@/lib/signer'
import { SigningStatus } from './SigningStatus'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import {
  AgentBudgetCard,
  AgentRulesSummary,
  ApprovalRequiredBanner,
  RiskExplainer,
  WalletIdentityBlock,
} from './haven'


interface AllowanceEntry {
  tokenSymbol: string
  tokenAddress: Address | null
  decimals: number
  amount: string
  resetTimeMin: number
}

// ── Types ──────────────────────────────────────────────────────────

type Step = 'details' | 'policy' | 'key' | 'review' | 'executing' | 'done'

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
  /**
   * Initial Safe selection. May be omitted when the modal is opened from a
   * surface that isn't bound to a single Safe (e.g. the dashboard guide). In
   * that case we fall back to activeSafe → default Safe → first Safe.
   */
  safeAddress?: string
  safeId?: string | null
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
  safeAddress: propSafeAddress,
  safeId: propSafeId,
  preset = null,
  onCreated,
}: Props) {
  const { user, activeSafe } = useAuth()
  const userSafes = user?.safes ?? []

  // Resolve the initial selection. Prop > activeSafe > default > first.
  const initialSafeId =
    propSafeId ??
    userSafes.find((s) => s.safe_address.toLowerCase() === propSafeAddress?.toLowerCase())?.id ??
    activeSafe?.id ??
    userSafes.find((s) => s.is_default)?.id ??
    userSafes[0]?.id ??
    null

  const [selectedSafeId, setSelectedSafeId] = useState<string | null>(initialSafeId)

  // Keep the selection in sync if the modal is reopened with a different prop.
  useEffect(() => {
    if (!open) return
    setSelectedSafeId(initialSafeId)
    // Only when the modal opens or the initial id changes — derived from props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSafeId])

  const selectedSafe =
    userSafes.find((s) => s.id === selectedSafeId) ?? null
  const safeAddress = selectedSafe?.safe_address ?? propSafeAddress ?? ''
  const safeId = selectedSafe?.id ?? propSafeId ?? null
  const chainId = selectedSafe?.chain_id ?? activeSafe?.chain_id ?? 100

  // Self-fetch Safe details from the selected Safe so the modal owns its
  // execution context — caller doesn't need to refetch when the user picks a
  // different Safe.
  const { details: safeDetails } = useSafeDetails(safeAddress || null)

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
  // Note: the generated private key is no longer revealed on step 1 — it's
  // bundled into the handoff file shown on the Done step. So no per-step
  // save gate, show/hide, or copy-state here.

  // Form: allowances
  const [allowances, setAllowances] = useState<AllowanceEntry[]>([])
  const [addToken, setAddToken] = useState<string>(tokenOptions[0]?.symbol ?? '')
  const [addAmount, setAddAmount] = useState('')
  const [addReset, setAddReset] = useState(1440) // daily

  // Execution
  const [execStatus, setExecStatus] = useState<ExecutionStatus>('checking')
  const [execError, setExecError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  // Result
  const [createdApiKey, setCreatedApiKey] = useState<string | null>(null)
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null)
  const [copiedApiKey, setCopiedApiKey] = useState(false)
  const [copiedDoneKey, setCopiedDoneKey] = useState(false)
  const [copiedEnv, setCopiedEnv] = useState(false)
  const [showRawCreds, setShowRawCreds] = useState(false)
  // True once the user has downloaded the handoff file or copied the .env.
  // Used to gate close-without-saving on the Done step — see handleClose.
  const [credentialsSaved, setCredentialsSaved] = useState(false)

  // Wagmi
  const publicClient = usePublicClient({ chainId })
  const signer = useActiveSigner({
    safeAddress: safeAddress ? (safeAddress as Address) : undefined,
    chainId,
  })

  // ── Reset ──────────────────────────────────────────────

  const resetForm = useCallback(() => {
    setStep('details')
    setName('')
    setDescription('')
    setDelegateAddress('')
    setKeyMode('generate')
    setGeneratedPrivateKey(null)
    setAllowances([])
    setAddToken(tokenOptions[0]?.symbol ?? '')
    setAddAmount('')
    setAddReset(1440)
    setExecStatus('checking')
    setExecError(null)
    setTxHash(null)
    setCreatedApiKey(null)
    setCreatedAgentId(null)
    setCopiedApiKey(false)
    setCopiedDoneKey(false)
    setCopiedEnv(false)
    setShowRawCreds(false)
    setCredentialsSaved(false)
  }, [])

  const handleClose = useCallback(() => {
    // Guard against accidental dismissal of the Done step before the user has
    // saved the credentials. The agent is already on-chain at this point, but
    // the API key (and a generated delegate private key, if any) cannot be
    // shown again — closing without saving leaves the user with an active
    // but uncallable agent that they can only recover by revoking and
    // recreating.
    if (step === 'done' && createdApiKey && !credentialsSaved) {
      const confirmed = window.confirm(
        'You haven\'t saved the agent credentials yet.\n\n' +
        'The Haven credential cannot be shown again. ' +
        'If you close this dialog now, the agent may be connected but unable to make requests. ' +
        'You would need to revoke it and create a new one.\n\n' +
        'Close anyway?',
      )
      if (!confirmed) return
    }
    resetForm()
    onClose()
  }, [step, createdApiKey, credentialsSaved, onClose, resetForm])

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
  }

  function handleSwitchKeyMode(mode: KeyMode) {
    setKeyMode(mode)
    setDelegateAddress('')
    setGeneratedPrivateKey(null)
    if (mode === 'generate') {
      handleGenerateKey()
    }
  }

  // ── Step: Details ──────────────────────────────────────

  function canProceedDetails() {
    return name.trim().length > 0
  }

  function canProceedKey() {
    return isValidAddress(delegateAddress)
  }

  // ── Step: Review ──────────────────────────────────────
  //
  // Reasons the Deploy button cannot fire. Used to disable the button AND
  // surface the concrete blocker so the user isn't staring at a dead control.
  // (Silent guard in handleExecute was masking backend/wallet outages — this
  // moves the visibility forward.)

  function deployBlockReason(): string | null {
    if (!signer) return 'Connect a wallet or use a passkey on this device to approve this change.'
    if (!publicClient) return 'No RPC client for this chain. Refresh the page.'
    if (!safeDetails)
      return 'Account details are still loading — or the Haven backend is unreachable. Make sure it is running on port 3001.'
    return null
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

  function budgetPeriodLabel(mins: number) {
    const label = resetLabel(mins).toLowerCase()
    if (label === 'one-time') return 'total budget'
    if (label === 'daily') return 'per day'
    if (label === 'weekly') return 'per week'
    if (label === 'monthly') return 'per month'
    return `every ${label}`
  }

  function budgetLine(a: AllowanceEntry) {
    return `${a.amount} ${a.tokenSymbol} ${budgetPeriodLabel(a.resetTimeMin)}`
  }

  function budgetAmountSummary() {
    if (allowances.length === 0) return 'No budget set'
    if (allowances.length === 1) {
      const [a] = allowances
      return `${a.amount} ${a.tokenSymbol}`
    }
    return `${allowances.length} budgets set`
  }

  function budgetPeriodSummary() {
    if (allowances.length === 0) return 'Add at least one token budget'
    if (allowances.length === 1) return budgetPeriodLabel(allowances[0].resetTimeMin)
    return allowances.map((a) => budgetLine(a)).join(' • ')
  }

  const walletName = selectedSafe?.name ?? activeSafe?.name ?? 'Selected Haven wallet'
  const walletNetworkName = getChainConfig(chainId).name
  const walletDisplayAddress = safeAddress || selectedSafe?.safe_address

  // ── Step: Execute ──────────────────────────────────────

  async function handleExecute() {
    if (!publicClient || !signer || !safeDetails)
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
        signer,
        safeAddress as Address,
        safeTx,
        chainId,
      )

      const threshold = safeDetails.threshold ?? 1

      if (threshold <= 1) {
        // Single-owner: execute directly
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
        // Multi-sig: propose
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

      // 5. Save agent to Haven backend
      setExecStatus('saving')
      const agent = await api.post<{ id: string; name: string; api_key: string; delegate_address: string }>('/agents', {
          name: name.trim(),
          description: description.trim() || undefined,
          delegate_address: delegateAddress,
          safe_id: safeId || undefined,
          allowances: allowances.map((a) => ({
            token_address:
              a.tokenAddress ?? '0x0000000000000000000000000000000000000000',
            token_symbol: a.tokenSymbol,
            allowance_amount: parseUnits(a.amount, a.decimals).toString(),
            reset_period_min: a.resetTimeMin,
          })),
        })
      setCreatedApiKey(agent.api_key)
      setCreatedAgentId(agent.id)
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

  // ── Copy helpers ───────────────────────────────────────

  function copyToClipboard(text: string, setter: (v: boolean) => void) {
    navigator.clipboard.writeText(text)
    setter(true)
    setTimeout(() => setter(false), 2000)
  }

  // ── Handoff artefact helpers ──────────────────────────
  //
  // Assembled lazily on-click from the form state + the values that came back
  // with the `/agents` response. Nothing persists — reload and it's gone,
  // same one-time-view guarantee as the raw credential copy buttons.

  function getHandoffInput(): HandoffInput | null {
    if (!createdApiKey || !createdAgentId) return null
    // Embed the deployed API + app URLs in the handoff so the external agent
    // talks to the right host. Without this, the SDK falls back to localhost.
    const apiBaseUrl =
      process.env.NEXT_PUBLIC_API_URL ||
      (typeof window !== 'undefined' ? window.location.origin : undefined)
    const appBaseUrl =
      typeof window !== 'undefined' ? window.location.origin : undefined
    return {
      agent: {
        id: createdAgentId,
        name: name.trim(),
        description: description.trim() || undefined,
        delegateAddress: delegateAddress,
        safeAddress: safeAddress,
        safeName: activeSafe?.name,
        chainId,
      },
      policy: {
        allowances: allowances.map((a) => ({
          tokenSymbol: a.tokenSymbol,
          amount: a.amount,
          resetPeriodMin: a.resetTimeMin,
        })),
      },
      credentials: {
        apiKey: createdApiKey,
        delegatePrivateKey: generatedPrivateKey,
      },
      apiBaseUrl,
      appBaseUrl,
    }
  }

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    // Release the object URL on the next tick so the click handler has fired.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  function handleDownloadHandoff() {
    const input = getHandoffInput()
    if (!input) return
    const { markdown, filename } = buildHandoff(input)
    triggerDownload(
      new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
      filename,
    )
    setCredentialsSaved(true)
  }

  function handleCopyEnv() {
    const input = getHandoffInput()
    if (!input) return
    const dotenv = buildDotenv(input)
    copyToClipboard(dotenv, setCopiedEnv)
    setCredentialsSaved(true)
  }

  // Generate a key the first time the user reaches the Key step in 'generate'
  // mode. We don't pre-generate on open anymore — the key isn't asked for
  // until step 3, so doing it earlier just creates noise the user might never
  // need (they could pick 'existing' first).
  useEffect(() => {
    if (open && keyMode === 'generate' && !generatedPrivateKey && step === 'key') {
      handleGenerateKey()
    }
    // handleGenerateKey is stable (no deps); we intentionally only react to modal open/mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, keyMode, generatedPrivateKey, step])

  // When the user picks a different Safe in step 2, the chain may change, so
  // the supported-token list changes too. Reset the in-progress add-token to
  // a valid option and drop any allowances that reference tokens not on the
  // new chain (rare in practice, but cleaner than letting them silently fail
  // at execute time).
  useEffect(() => {
    if (!open) return
    const validSymbols = new Set(tokenOptions.map((t) => t.symbol))
    if (!validSymbols.has(addToken)) {
      setAddToken(tokenOptions[0]?.symbol ?? '')
    }
    setAllowances((prev) => prev.filter((a) => validSymbols.has(a.tokenSymbol)))
    // chainId changes when selectedSafeId changes — that's our trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chainId])

  // ── Render ─────────────────────────────────────────────

  if (!open) return null

  const availableTokens = tokenOptions.filter(
    (t) => !allowances.some((a) => a.tokenSymbol === t.symbol),
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 v2-modal-backdrop">
      {/* Backdrop click to close (disabled during execution) */}
      <div
        className="absolute inset-0"
        onClick={step !== 'executing' ? handleClose : undefined}
      />
      <div className="relative bg-white border border-[var(--v2-border)] rounded-2xl w-full max-w-lg shadow-[var(--v2-shadow-modal)] max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--v2-border)]">
          <div>
            <h2 className="text-sm font-semibold">Connect agent</h2>
            <p className="text-xs text-[var(--v2-ink-3)] mt-0.5">
              {step === 'details' && "Name the agent you'll connect"}
              {step === 'policy' && 'Set agent budget — token, amount, frequency'}
              {step === 'key' && 'Choose the credential the agent will use'}
              {step === 'review' && 'Review agent rules before connecting'}
              {step === 'executing' && 'Connecting agent...'}
              {step === 'done' && 'Add your Haven credential to your agent'}
            </p>
          </div>
          <button
            onClick={handleClose}
            disabled={step === 'executing' && execStatus !== 'error'}
            aria-label="Close"
            className="p-1 -mr-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface-2)] disabled:opacity-20 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Step indicators */}
        {step !== 'executing' && step !== 'done' && (
          <div className="flex items-center gap-2 px-6 py-3 border-b border-[var(--v2-border)]">
            {(['details', 'policy', 'key', 'review'] as const).map((s, i, arr) => (
              <div key={s} className="flex items-center gap-2">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    s === step
                      ? 'bg-indigo-500 text-white'
                      : arr.indexOf(step as typeof arr[number]) > i
                        ? 'bg-indigo-500/20 text-[var(--v2-brand)]'
                        : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'
                  }`}
                >
                  {i + 1}
                </div>
                {i < arr.length - 1 && (
                  <div className="w-8 h-px bg-[var(--v2-surface-2)]" />
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
                <label className="block text-[11px] text-[var(--v2-ink-3)] mb-1.5 uppercase tracking-wide">
                  Agent name
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Research Agent"
                  className="w-full bg-[var(--v2-surface-2)] border border-[var(--v2-border)] rounded-xl px-4 py-2.5 text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-[var(--v2-brand)]/50 focus:bg-[var(--v2-surface-2)] transition-all"
                />
                <p className="text-[10px] text-[var(--v2-ink-3)] mt-1.5">
                  Use the name of the agent you&apos;ll connect to Haven, such as your Claude assistant or research workflow.
                </p>
              </div>
              <div>
                <label className="block text-[11px] text-[var(--v2-ink-3)] mb-1.5 uppercase tracking-wide">
                  Description <span className="normal-case text-[var(--v2-ink-3)]">(optional)</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this agent do?"
                  rows={2}
                  className="w-full bg-[var(--v2-surface-2)] border border-[var(--v2-border)] rounded-xl px-4 py-2.5 text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-[var(--v2-brand)]/50 focus:bg-[var(--v2-surface-2)] transition-all resize-none"
                />
              </div>

              <Button
                onClick={() => setStep('policy')}
                disabled={!canProceedDetails()}
                className="w-full"
              >
                Set agent budget
              </Button>
            </div>
          )}

          {/* ── STEP: Rules ──────────────────────────────── */}
          {step === 'policy' && (
            <div className="space-y-5">
              <WalletIdentityBlock
                name={walletName}
                network={walletNetworkName}
                address={walletDisplayAddress}
              />

              {/* Account picker — only when the user has more than one account */}
              {userSafes.length > 1 && (
                <div>
                  <label className="block text-[11px] text-[var(--v2-ink-3)] mb-1.5 uppercase tracking-wide">
                    Haven wallet
                  </label>
                  <Select
                    value={selectedSafeId ?? ''}
                    onChange={(e) => setSelectedSafeId(e.target.value)}
                  >
                    {userSafes.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} — {truncate(s.safe_address)} ({getChainConfig(s.chain_id).name})
                      </option>
                    ))}
                  </Select>
                  <p className="text-[10px] text-[var(--v2-ink-3)] mt-1.5">
                    The agent can only spend from this Haven wallet.
                  </p>
                </div>
              )}

              {/* Current allowances */}
              {allowances.length > 0 && (
                <AgentBudgetCard
                  agentName={name || 'New agent'}
                  walletName={walletName}
                  amount={budgetAmountSummary()}
                  resetPeriod={budgetPeriodSummary()}
                  status="Budget draft"
                >
                  <div className="space-y-2">
                    {allowances.map((a) => (
                      <div
                        key={a.tokenSymbol}
                        className="flex items-center justify-between gap-3 rounded-lg border border-[var(--v2-border)] bg-white px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-[var(--v2-ink)] v2-tabular">
                            {budgetLine(a)}
                          </p>
                          <p className="text-xs text-[var(--v2-ink-2)]">
                            Requests above the remaining budget wait for approval.
                          </p>
                        </div>
                        <button
                          onClick={() => handleRemoveAllowance(a.tokenSymbol)}
                          aria-label={`Remove ${a.tokenSymbol} budget`}
                          className="flex-shrink-0 rounded-md p-1 text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-danger-soft)] hover:text-[var(--v2-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
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
                </AgentBudgetCard>
              )}

              {/* Add allowance form */}
              {availableTokens.length > 0 && (
                <div className="space-y-3 p-4 bg-[var(--v2-surface)] rounded-xl border border-dashed border-[var(--v2-border)]">
                  <p className="text-[11px] text-[var(--v2-ink-3)] uppercase tracking-wide">
                    Add agent budget
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    <Select
                      value={addToken}
                      onChange={(e) => setAddToken(e.target.value)}
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
                      value={addAmount}
                      onChange={(e) => setAddAmount(e.target.value)}
                      placeholder="Amount"
                    />
                    <Select
                      value={addReset}
                      onChange={(e) => setAddReset(Number(e.target.value))}
                    >
                      {RESET_PERIODS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleAddAllowance}
                    disabled={
                      !addAmount ||
                      Number(addAmount) <= 0 ||
                      !availableTokens.some((t) => t.symbol === addToken)
                    }
                    className="w-full"
                  >
                    Add budget
                  </Button>
                </div>
              )}

              {allowances.length === 0 && (
                <p className="text-xs text-[var(--v2-ink-3)] text-center py-4">
                  Add at least one agent budget to continue
                </p>
              )}

              <RiskExplainer
                items={[
                  'The agent can make payments automatically while it stays within the budget.',
                  'Requests above the remaining budget wait for your approval before any money moves.',
                  'You can pause or revoke the agent later from its detail page.',
                ]}
              />

              <div className="flex gap-3">
                <Button
                  variant="ghost"
                  onClick={() => setStep('details')}
                  className="flex-1"
                >
                  Back
                </Button>
                <Button
                  onClick={() => setStep('key')}
                  disabled={allowances.length === 0}
                  className="flex-1"
                >
                  Review credential
                </Button>
              </div>
            </div>
          )}

          {/* ── STEP: Key ─────────────────────────────────── */}
          {step === 'key' && (
            <div className="space-y-5">
              {/* ── Credential mode selector ──────────── */}
              <div>
                <label className="block text-[11px] text-[var(--v2-ink-3)] mb-2 uppercase tracking-wide">
                  Agent credential
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => handleSwitchKeyMode('generate')}
                    className={`relative p-3 rounded-xl border text-left transition-all ${
                      keyMode === 'generate'
                        ? 'border-indigo-500/50 bg-indigo-500/5'
                        : 'border-[var(--v2-border)] bg-[var(--v2-surface)] hover:border-[var(--v2-border-strong)]'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                        keyMode === 'generate' ? 'border-indigo-400' : 'border-[var(--v2-border-strong)]'
                      }`}>
                        {keyMode === 'generate' && (
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                        )}
                      </div>
                      <span className={`text-xs font-medium ${
                        keyMode === 'generate' ? 'text-[var(--v2-ink)]' : 'text-[var(--v2-ink-2)]'
                      }`}>
                        Create credential
                      </span>
                    </div>
                    <p className="text-[10px] text-[var(--v2-ink-3)] ml-5.5 pl-0.5">
                      Best for a new agent
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSwitchKeyMode('existing')}
                    className={`relative p-3 rounded-xl border text-left transition-all ${
                      keyMode === 'existing'
                        ? 'border-indigo-500/50 bg-indigo-500/5'
                        : 'border-[var(--v2-border)] bg-[var(--v2-surface)] hover:border-[var(--v2-border-strong)]'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                        keyMode === 'existing' ? 'border-indigo-400' : 'border-[var(--v2-border-strong)]'
                      }`}>
                        {keyMode === 'existing' && (
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                        )}
                      </div>
                      <span className={`text-xs font-medium ${
                        keyMode === 'existing' ? 'text-[var(--v2-ink)]' : 'text-[var(--v2-ink-2)]'
                      }`}>
                        Use existing address
                      </span>
                    </div>
                    <p className="text-[10px] text-[var(--v2-ink-3)] ml-5.5 pl-0.5">
                      Advanced setup
                    </p>
                  </button>
                </div>
              </div>

              {/* ── Generate mode ───────────────────────── */}
              {keyMode === 'generate' && generatedPrivateKey && (
                <div className="space-y-3">
                  <div>
                    <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-1">
                      Credential address
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs font-mono text-[var(--v2-ink-2)] bg-[var(--v2-surface)] rounded-lg px-3 py-2 truncate">
                        {delegateAddress}
                      </code>
                      <button
                        onClick={() => copyToClipboard(delegateAddress, () => {})}
                        className="flex-shrink-0 text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] transition-colors p-1"
                        title="Copy address"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <div className="bg-[var(--v2-surface)] border border-[var(--v2-border)] rounded-lg px-3 py-2.5 flex items-start gap-2">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--v2-ink-3)] flex-shrink-0 mt-0.5">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                    <p className="text-[11px] text-[var(--v2-ink-3)] leading-relaxed">
                      A new credential was created in your browser. Haven never sees the secret.
                    </p>
                  </div>

                  <button
                    onClick={handleGenerateKey}
                    className="text-[11px] text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] transition-colors"
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
                    className="w-full bg-[var(--v2-surface-2)] border border-[var(--v2-border)] rounded-xl px-4 py-2.5 text-sm font-mono text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-[var(--v2-brand)]/50 focus:bg-[var(--v2-surface-2)] transition-all"
                  />
                  {delegateAddress && !isValidAddress(delegateAddress) && (
                    <p className="text-[11px] text-red-400">
                      Invalid Ethereum address
                    </p>
                  )}
                  <div className="bg-[var(--v2-surface)] border border-[var(--v2-border)] rounded-lg px-3 py-2.5">
                    <p className="text-[11px] text-[var(--v2-ink-3)] leading-relaxed">
                      Enter the public address your agent will use to request payments.
                      Keep the matching secret outside Haven.
                    </p>
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setStep('policy')}
                  className="flex-1 text-sm font-medium bg-white border border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)] text-[var(--v2-ink)] rounded-xl py-2.5 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => setStep('review')}
                  disabled={!canProceedKey()}
                  className="flex-1 text-sm font-medium bg-[var(--v2-brand)] hover:bg-[var(--v2-brand-strong)] disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl py-2.5 transition-colors"
                >
                  Review agent rules
                </button>
              </div>
            </div>
          )}

          {/* ── STEP: Review ──────────────────────────────── */}
          {step === 'review' && (
            <div className="space-y-5">
              <AgentRulesSummary
                title="Review agent rules"
                description="Confirm what this agent can do before you connect it."
                items={[
                  {
                    label: 'Who can spend',
                    value: name,
                    helper: description || 'This agent can request payments using its Haven credential.',
                  },
                  {
                    label: 'From wallet',
                    value: `${walletName} on ${walletNetworkName}`,
                    helper: 'The agent can only use this Haven wallet.',
                  },
                  {
                    label: 'Agent budget',
                    value: (
                      <div className="space-y-1">
                        {allowances.map((a) => (
                          <div key={a.tokenSymbol}>{budgetLine(a)}</div>
                        ))}
                      </div>
                    ),
                    helper: 'Payments within the remaining budget can happen automatically.',
                  },
                  {
                    label: 'Credential',
                    value: keyMode === 'generate' ? 'Create a new Haven credential' : 'Use an existing credential address',
                    helper:
                      keyMode === 'generate'
                        ? 'The credential is created in your browser and shown after setup.'
                        : `Credential address: ${truncate(delegateAddress)}`,
                  },
                ]}
              />

              <ApprovalRequiredBanner>
                Requests above the remaining agent budget wait for your approval before any money moves.
              </ApprovalRequiredBanner>

              {(safeDetails?.threshold ?? 1) > 1 && (
                <ApprovalRequiredBanner title="More approvals needed">
                  This Haven account requires {safeDetails?.threshold} of {safeDetails?.owners?.length} approvals.
                  Haven will submit the agent rules for approval.
                </ApprovalRequiredBanner>
              )}

              {deployBlockReason() && (
                <div className="rounded-[10px] border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-xs text-[var(--v2-danger)]">
                  {deployBlockReason()}
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  variant="ghost"
                  onClick={() => setStep('key')}
                  className="flex-1"
                >
                  Back
                </Button>
                <div className="flex-1">
                  <NetworkGate requiredChainId={chainId} autoSwitch>
                    <Button
                      onClick={handleExecute}
                      disabled={!!deployBlockReason()}
                      className="w-full"
                    >
                      Connect agent
                    </Button>
                  </NetworkGate>
                </div>
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
                    <p className="text-sm text-[var(--v2-ink)] font-medium">
                      {execStatus === 'checking' && 'Checking module status...'}
                      {execStatus === 'signing' && 'Awaiting signature...'}
                      {execStatus === 'executing' && 'Submitting to chain...'}
                      {execStatus === 'saving' && 'Saving agent...'}
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
                    <p className="text-sm text-red-400 font-medium">
                      Setup failed
                    </p>
                    <p className="text-xs text-[var(--v2-ink-3)] mt-1 max-w-xs mx-auto">
                      {execError}
                    </p>
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

          {/* ── STEP: Done ────────────────────────────────── */}
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
                    ? 'Your agent is ready'
                    : 'Agent rules pending approval'}
                </p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-[var(--v2-ink-2)]">
                  {execStatus === 'confirmed'
                    ? 'Add the Haven credential to your agent so it can make payments within your rules.'
                    : 'After the approval is complete, add the Haven credential to your agent.'}
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
                    {execStatus === 'confirmed' ? `View on ${getChainConfig(chainId).name} Explorer` : 'View approval request'}
                  </a>
                )}
              </div>

              <AgentBudgetCard
                agentName={name}
                walletName={walletName}
                amount={budgetAmountSummary()}
                resetPeriod={budgetPeriodSummary()}
                status={execStatus === 'confirmed' ? 'Connected' : 'Pending approval'}
                statusTone={execStatus === 'confirmed' ? 'success' : 'warning'}
              >
                <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
                  Requests above the remaining budget will wait for your approval before any money moves.
                </p>
              </AgentBudgetCard>

              {/* Handoff card — one artefact, everything the dev needs */}
              <div className="bg-amber-400/5 border border-amber-400/15 rounded-xl p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400 flex-shrink-0 mt-0.5">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <div>
                    <p className="text-[11px] text-amber-400 uppercase tracking-wide font-medium">
                      Agent credential — save this now
                    </p>
                    <p className="text-[11px] text-[var(--v2-ink-3)] leading-relaxed mt-0.5">
                      One file with your Haven credential, agent budget, and SDK quickstart.
                      {generatedPrivateKey ? ' Secrets cannot be shown again.' : ''}
                    </p>
                  </div>
                </div>

                {/* Primary: download the markdown handoff */}
                <button
                  onClick={handleDownloadHandoff}
                  className="w-full flex items-center justify-center gap-2 bg-[var(--v2-brand)] hover:bg-[var(--v2-brand-strong)] text-white text-sm font-medium rounded-lg py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download credential file (.md)
                </button>

                {/* Secondary: copy as .env */}
                <button
                  onClick={handleCopyEnv}
                  className="w-full flex items-center justify-center gap-1.5 text-xs font-medium text-[var(--v2-ink)] bg-white hover:bg-[var(--v2-surface)] border border-[var(--v2-border-strong)] rounded-lg py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
                  title="Copy just the environment variables for pasting into .env"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  {copiedEnv ? 'Copied!' : 'Copy as .env'}
                </button>

                {/* Tertiary: raw credentials disclosure (collapsed by default) */}
                <details
                  className="group"
                  open={showRawCreds}
                  onToggle={(e) => setShowRawCreds((e.currentTarget as HTMLDetailsElement).open)}
                >
                  <summary className="text-[11px] text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] cursor-pointer select-none inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 rounded">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="transition-transform group-open:rotate-90">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    Show raw credentials
                  </summary>
                  <div className="mt-3 space-y-3">
                    {createdApiKey && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide">
                          API Key
                          <span className="normal-case text-[var(--v2-ink-3)] ml-1">— authenticates with Haven</span>
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 text-xs font-mono text-[var(--v2-ink)] bg-[var(--v2-surface)] rounded-lg px-3 py-2 break-all">
                            {createdApiKey}
                          </code>
                          <button
                            onClick={() => copyToClipboard(createdApiKey, setCopiedApiKey)}
                            className="flex-shrink-0 text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors px-2 py-2"
                          >
                            {copiedApiKey ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                      </div>
                    )}
                    {generatedPrivateKey && (
                      <div className="space-y-1.5 pt-2 border-t border-amber-400/10">
                        <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide">
                          Credential private key
                          <span className="normal-case text-[var(--v2-ink-3)] ml-1">— signs transactions</span>
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 text-xs font-mono text-[var(--v2-ink)] bg-[var(--v2-surface)] rounded-lg px-3 py-2 break-all">
                            {generatedPrivateKey}
                          </code>
                          <button
                            onClick={() => copyToClipboard(generatedPrivateKey, setCopiedDoneKey)}
                            className="flex-shrink-0 text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors px-2 py-2"
                          >
                            {copiedDoneKey ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </details>
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
