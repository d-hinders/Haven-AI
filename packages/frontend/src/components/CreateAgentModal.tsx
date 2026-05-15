'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
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
import { validateMoneyInput } from '@/lib/money-input'
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
import { buildHandoff, type HandoffInput } from '@/lib/agent-handoff'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { useActiveSigner } from '@/lib/signer'
import { SigningStatus } from './SigningStatus'
import WalletButton from './WalletButton'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import {
  AgentBudgetCard,
  AgentRulesSummary,
  ApprovalRequiredBanner,
  CredentialHandoffCard,
} from './haven'
import { useToast } from './ui/Toast'
import { useFocusTrap } from '@/hooks/useFocusTrap'


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
type AuthorityStatus = 'confirmed' | 'proposed'

interface AuthorityResult {
  status: AuthorityStatus
  txHash: string | null
}

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
  const { toast } = useToast()
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)
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
  // Note: the generated credential secret is no longer revealed early — it is
  // bundled into the credential file shown on the Done step.

  // Form: allowances
  const [allowances, setAllowances] = useState<AllowanceEntry[]>([])
  const [addToken, setAddToken] = useState<string>(tokenOptions[0]?.symbol ?? '')
  const [addAmount, setAddAmount] = useState('')
  const [addAmountError, setAddAmountError] = useState('')
  const [addReset, setAddReset] = useState(1440) // daily

  // Execution
  const [execStatus, setExecStatus] = useState<ExecutionStatus>('checking')
  const [execError, setExecError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [authorityResult, setAuthorityResult] = useState<AuthorityResult | null>(null)
  const [backendSaveFailed, setBackendSaveFailed] = useState(false)

  // Result
  const [createdApiKey, setCreatedApiKey] = useState<string | null>(null)
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null)
  const [copiedHandoff, setCopiedHandoff] = useState(false)
  // True once the user has downloaded or copied the credential file.
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
    setAddAmountError('')
    setAddReset(1440)
    setExecStatus('checking')
    setExecError(null)
    setTxHash(null)
    setAuthorityResult(null)
    setBackendSaveFailed(false)
    setCreatedApiKey(null)
    setCreatedAgentId(null)
    setCopiedHandoff(false)
    setCredentialsSaved(false)
  }, [])

  const handleClose = useCallback(() => {
    if (backendSaveFailed && authorityResult) {
      const confirmed = window.confirm(
        'The agent rules were created in your Haven wallet, but Haven has not saved the agent yet.\n\n' +
        'If you close now, the agent may not appear in Haven. Try finishing the save first.\n\n' +
        'Close anyway?',
      )
      if (!confirmed) return
    }

    // Guard against accidental dismissal of the Done step before the user has
    // saved the credential file. Closing without saving can leave the user
    // with a connected agent that does not have the credential it needs.
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
  }, [backendSaveFailed, authorityResult, step, createdApiKey, credentialsSaved, onClose, resetForm])

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
    if (!tokenOpt) return
    const parsedAmount = validateMoneyInput(addAmount, tokenOpt.decimals, {
      tokenSymbol: tokenOpt.symbol,
    })
    if (!parsedAmount.ok) {
      setAddAmountError(parsedAmount.message)
      return
    }

    // Don't add duplicate tokens
    if (allowances.some((a) => a.tokenSymbol === addToken)) return

    const nextToken = tokenOptions.find(
      (t) =>
        t.symbol !== addToken &&
        !allowances.some((a) => a.tokenSymbol === t.symbol),
    )

    setAllowances((prev) => [
      ...prev,
      {
        tokenSymbol: tokenOpt.symbol,
        tokenAddress: tokenOpt.address,
        decimals: tokenOpt.decimals,
        amount: parsedAmount.amount,
        resetTimeMin: addReset,
      },
    ])
    setAddAmount('')
    setAddAmountError('')
    setAddToken(nextToken?.symbol ?? '')
  }

  function handleRemoveAllowance(symbol: string) {
    setAllowances((prev) => prev.filter((a) => a.tokenSymbol !== symbol))
    if (tokenOptions.some((t) => t.symbol === symbol)) {
      setAddToken(symbol)
    }
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
    setBackendSaveFailed(false)
    setAuthorityResult(null)

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

      let completedAuthority: AuthorityResult
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
        completedAuthority = {
          status: 'confirmed',
          txHash: result.txHash,
        }
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
        completedAuthority = {
          status: 'proposed',
          txHash: safeTxHash,
        }
      }

      // 5. Save agent to Haven backend
      setExecStatus('saving')
      setAuthorityResult(completedAuthority)
      await saveAgentToHaven(completedAuthority)
    } catch (err: unknown) {
      const message = errorMessage(err)
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

  function agentPayload() {
    return {
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
    }
  }

  function errorMessage(err: unknown): string {
    console.error('[Haven] Agent setup error:', err)
    let message = 'Setup failed'
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
    return message
  }

  async function saveAgentToHaven(authority: AuthorityResult) {
    try {
      const agent = await api.post<{ id: string; name: string; api_key: string; delegate_address: string }>(
        '/agents',
        agentPayload(),
      )
      setCreatedApiKey(agent.api_key)
      setCreatedAgentId(agent.id)
      setBackendSaveFailed(false)
      setExecError(null)
      setExecStatus(authority.status)
      setStep('done')
      toast.success('Agent created')
      onCreated(agent)
    } catch (err: unknown) {
      const message = errorMessage(err)
      setBackendSaveFailed(true)
      setAuthorityResult(authority)
      setExecError(message)
      setExecStatus('error')
    }
  }

  async function handleRetryHavenSave() {
    if (!authorityResult) return
    setBackendSaveFailed(false)
    setExecError(null)
    setExecStatus('saving')
    await saveAgentToHaven(authorityResult)
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

  function handleCopyHandoff() {
    const input = getHandoffInput()
    if (!input) return
    const { markdown } = buildHandoff(input)
    copyToClipboard(markdown, setCopiedHandoff)
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
  const addTokenOption = availableTokens.find((t) => t.symbol === addToken)
  const addAmountValidation =
    addAmount && addTokenOption
      ? validateMoneyInput(addAmount, addTokenOption.decimals, {
          tokenSymbol: addTokenOption.symbol,
        })
      : null
  const addAmountMessage =
    addAmountError || (addAmountValidation && !addAmountValidation.ok ? addAmountValidation.message : '')
  const blockReason = deployBlockReason()

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-3 v2-modal-backdrop">
      {/* Backdrop click to close (disabled during execution) */}
      <div
        className="absolute inset-0"
        onClick={step !== 'executing' ? handleClose : undefined}
      />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Create agent" className="relative w-full max-w-xl max-h-[calc(100vh-24px)] overflow-y-auto rounded-[14px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--v2-border)]">
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
          <div className="flex items-center gap-2 px-5 py-2 border-b border-[var(--v2-border)]">
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

        <div className="p-5">
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
            <div className="space-y-4">
              <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-3 shadow-[var(--v2-shadow-card)]">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 7.5A2.25 2.25 0 0 1 6 5.25h12A2.25 2.25 0 0 1 20.25 7.5v9A2.25 2.25 0 0 1 18 18.75H6A2.25 2.25 0 0 1 3.75 16.5v-9Z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12h.01" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[var(--v2-ink-3)]">From Haven wallet</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-[var(--v2-ink)]">{walletName}</p>
                      <span className="rounded-full bg-[var(--v2-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--v2-ink-2)]">
                        {walletNetworkName}
                      </span>
                    </div>
                    {walletDisplayAddress && (
                      <p className="mt-0.5 font-mono text-xs text-[var(--v2-ink-3)]">{truncate(walletDisplayAddress)}</p>
                    )}
                  </div>
                </div>

                {userSafes.length > 1 && (
                  <div className="mt-3">
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
                  </div>
                )}
              </div>

              {/* Current allowances */}
              {allowances.length > 0 && (
                <AgentBudgetCard
                  agentName={name || 'New agent'}
                  walletName={walletName}
                  amount={budgetAmountSummary()}
                  resetPeriod={budgetPeriodSummary()}
                  status="Budget draft"
                  density="compact"
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
              {availableTokens.length > 0 ? (
                <div className="space-y-3 rounded-[10px] border border-dashed border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] text-[var(--v2-ink-3)] uppercase tracking-wide">
                      Add agent budget
                    </p>
                    <p className="text-[11px] text-[var(--v2-ink-3)]">One per token</p>
                  </div>
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
                      type="text"
                      inputMode="decimal"
                      value={addAmount}
                      onChange={(e) => {
                        const value = e.target.value
                        if (/^\d*\.?\d*$/.test(value)) {
                          setAddAmount(value)
                          setAddAmountError('')
                        }
                      }}
                      placeholder="Amount"
                      invalid={Boolean(addAmountMessage)}
                      helperText={addAmountMessage || undefined}
                      className="v2-tabular"
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
                      !addAmountValidation?.ok ||
                      !addTokenOption
                    }
                    className="w-full"
                  >
                    Add budget
                  </Button>
                </div>
              ) : allowances.length > 0 ? (
                <p className="rounded-[10px] bg-[var(--v2-surface)] px-3 py-2 text-xs text-[var(--v2-ink-2)]">
                  All supported tokens for {walletNetworkName} already have budgets. Remove a token budget to change it.
                </p>
              ) : null}

              {allowances.length === 0 && (
                <p className="text-xs text-[var(--v2-ink-3)] text-center py-4">
                  Add at least one agent budget to continue
                </p>
              )}

              <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Payments within budget can run automatically. Anything above the remaining budget waits for your approval, and you can revoke the agent later.
              </p>

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
            <div className="space-y-4">
              {/* ── Credential mode selector ──────────── */}
              <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] text-[var(--v2-ink-3)] uppercase tracking-wide">
                      Agent credential
                    </p>
                    <h3 className="mt-1 text-sm font-semibold text-[var(--v2-ink)]">Create a new Haven credential</h3>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                      Recommended for a new agent. Haven creates it in your browser and shows the credential file after setup.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSwitchKeyMode('generate')}
                    className={`flex-shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                      keyMode === 'generate'
                        ? 'border-[var(--v2-brand)]/30 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
                        : 'border-[var(--v2-border-strong)] bg-white text-[var(--v2-ink)] hover:bg-[var(--v2-surface)]'
                    }`}
                  >
                    {keyMode === 'generate' ? 'Selected' : 'Use this'}
                  </button>
                </div>
              </div>

              <div>
                <button
                  type="button"
                  onClick={() => handleSwitchKeyMode(keyMode === 'existing' ? 'generate' : 'existing')}
                  className="text-xs font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
                >
                  {keyMode === 'existing' ? 'Use a new Haven credential instead' : 'Use an existing credential address instead'}
                </button>

                {keyMode === 'existing' && (
                  <div className="mt-3 rounded-[10px] border border-[var(--v2-border)] bg-white p-3">
                    <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
                      Advanced setup. Enter the public address your agent will use to request payments.
                    </p>
                    <Input
                      value={delegateAddress}
                      onChange={(e) => setDelegateAddress(e.target.value)}
                      placeholder="0x..."
                      className="mt-3 font-mono"
                    />
                    {delegateAddress && !isValidAddress(delegateAddress) && (
                      <p className="mt-2 text-[11px] text-[var(--v2-danger)]">
                        Enter a valid Ethereum address.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <Button
                  variant="ghost"
                  onClick={() => setStep('policy')}
                  className="flex-1"
                >
                  Back
                </Button>
                <Button
                  onClick={() => setStep('review')}
                  disabled={!canProceedKey()}
                  className="flex-1"
                >
                  Review agent rules
                </Button>
              </div>
            </div>
          )}

          {/* ── STEP: Review ──────────────────────────────── */}
          {step === 'review' && (
            <div className="space-y-5">
              <AgentRulesSummary
                title="Review agent rules"
                description="Confirm what this agent can do before you connect it."
                density="compact"
                items={[
                  {
                    label: 'Who can spend',
                    value: name,
                    helper: description || undefined,
                  },
                  {
                    label: 'From wallet',
                    value: `${walletName} on ${walletNetworkName}`,
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
                    helper: 'Agents can still start larger payments, but you approve them manually.',
                  },
                  {
                    label: 'Credential',
                    value: keyMode === 'generate' ? 'Create a new Haven credential' : 'Use an existing credential address',
                    helper: keyMode === 'existing' ? truncate(delegateAddress) : undefined,
                  },
                ]}
              />

              <ApprovalRequiredBanner
                title="Payments above budget need approval"
                density="compact"
                tone="neutral"
              >
                Agents can still initiate payments above the remaining budget, but you will approve them manually before any money moves.
              </ApprovalRequiredBanner>

              {(safeDetails?.threshold ?? 1) > 1 && (
                <ApprovalRequiredBanner title="More approvals needed" density="compact" tone="neutral">
                  This Haven account requires {safeDetails?.threshold} of {safeDetails?.owners?.length} approvals.
                  Haven will submit the agent rules for approval.
                </ApprovalRequiredBanner>
              )}

              {blockReason && (
                <div className="rounded-[10px] border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-xs text-[var(--v2-danger)]">
                  <p>{blockReason}</p>
                  {!signer && (
                    <div className="mt-3">
                      <WalletButton />
                    </div>
                  )}
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
                      disabled={!!blockReason}
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
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center mx-auto ${
                    backendSaveFailed
                      ? 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]'
                      : 'bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]'
                  }`}>
                    {backendSaveFailed ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 1 1-9-9" />
                      </svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    )}
                  </div>
                  <div>
                    <p className={`text-sm font-medium ${backendSaveFailed ? 'text-[var(--v2-warning)]' : 'text-[var(--v2-danger)]'}`}>
                      {backendSaveFailed ? 'Finish saving this agent' : 'Setup failed'}
                    </p>
                    <p className="text-xs text-[var(--v2-ink-2)] mt-1 max-w-xs mx-auto">
                      {backendSaveFailed
                        ? 'The agent rules were created in your Haven wallet, but Haven could not save the agent. Try finishing the save before creating another agent.'
                        : execError}
                    </p>
                    {backendSaveFailed && execError && (
                      <p className="mt-2 text-[11px] text-[var(--v2-ink-3)] max-w-xs mx-auto">
                        {execError}
                      </p>
                    )}
                    {backendSaveFailed && authorityResult?.txHash && (
                      <a
                        href={
                          authorityResult.status === 'confirmed'
                            ? getExplorerUrl(chainId, 'tx', authorityResult.txHash)
                            : `https://app.safe.global/transactions/tx?safe=${getChainConfig(chainId).shortName}:${safeAddress}&id=${authorityResult.txHash}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-block text-xs text-[var(--v2-brand)] underline underline-offset-2 hover:text-[var(--v2-brand-strong)]"
                      >
                        {authorityResult.status === 'confirmed' ? `View on ${getChainConfig(chainId).name} Explorer` : 'View approval request'}
                      </a>
                    )}
                  </div>
                  <div className="flex gap-3 pt-2">
                    {backendSaveFailed ? (
                      <>
                        <Button variant="ghost" onClick={handleClose} className="flex-1">
                          Close
                        </Button>
                        <Button onClick={handleRetryHavenSave} className="flex-1">
                          Finish saving
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button variant="ghost" onClick={() => setStep('review')} className="flex-1">
                          Back
                        </Button>
                        <Button onClick={handleExecute} className="flex-1">
                          Retry
                        </Button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── STEP: Done ────────────────────────────────── */}
          {step === 'done' && (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-success-soft)] text-[var(--v2-success)]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-[var(--v2-ink)]">
                    {execStatus === 'confirmed'
                      ? 'Your agent is ready'
                      : 'Agent rules pending approval'}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
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
                      className="mt-1 inline-block text-xs text-[var(--v2-brand)] underline underline-offset-2 hover:text-[var(--v2-brand-strong)]"
                    >
                      {execStatus === 'confirmed' ? `View on ${getChainConfig(chainId).name} Explorer` : 'View approval request'}
                    </a>
                  )}
                </div>
              </div>

              <AgentBudgetCard
                agentName={name}
                walletName={walletName}
                amount={budgetAmountSummary()}
                resetPeriod={budgetPeriodSummary()}
                status={execStatus === 'confirmed' ? 'Connected' : 'Pending approval'}
                statusTone={execStatus === 'confirmed' ? 'success' : 'warning'}
                density="compact"
              />

              <CredentialHandoffCard
                title="Save the credential file"
                description="Download or copy this file before closing. Your agent needs it to make payments within the rules you set."
                primaryAction={
                  <Button onClick={handleDownloadHandoff} className="w-full">
                    Download file
                  </Button>
                }
                secondaryAction={
                  <Button variant="ghost" onClick={handleCopyHandoff} className="w-full">
                    {copiedHandoff ? 'Copied file' : 'Copy file'}
                  </Button>
                }
                note={generatedPrivateKey ? 'This credential is shown once. Haven cannot show it again after you close this window.' : undefined}
                saved={credentialsSaved}
              />

              <Button
                variant="ghost"
                onClick={handleClose}
                disabled={!credentialsSaved}
                className="w-full"
              >
                Done
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
