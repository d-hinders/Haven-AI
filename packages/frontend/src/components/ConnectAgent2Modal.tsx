'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Address, parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useAccount, usePublicClient, useSwitchChain } from 'wagmi'
import {
  ALLOWANCE_MODULE_ADDRESS,
  RESET_PERIODS,
  type AllowanceSetup,
} from '@/lib/allowance-module'
import { api, getResolvedApiBaseUrl } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
import {
  useAgentConnectionSetupStatus,
  type AgentConnectionSetupStatusResponse,
} from '@/hooks/useAgentConnectionSetupStatus'
import { getChainConfig, getExplorerUrl, DEFAULT_CHAIN_ID, SUPPORTED_CHAIN_IDS } from '@/lib/chains'
import { formatAllowanceForToken } from '@/lib/allowance-format'
import { truncate } from '@/lib/format'
import { isIncompleteMoneyInput, validateMoneyInput } from '@/lib/money-input'
import { getChainTokens } from '@/lib/safe-tx'
import { executeAgentSetup } from '@/lib/agent-setup'
import { useActiveSigner } from '@/lib/signer'
import WalletButton from './WalletButton'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { StepProgress } from './ui/StepProgress'
import { StatusBadge, type StatusTone } from './ui/StatusBadge'
import {
  AgentBudgetCard,
  AgentRulesSummary,
  ApprovalRequiredBanner,
  WalletIdentityBlock,
} from './haven'

type SetupStep = 'details' | 'account' | 'policy' | 'review' | 'connect'

interface AllowanceEntry {
  tokenSymbol: string
  tokenAddress: Address | null
  decimals: number
  amount: string
  resetTimeMin: number
}

interface CreateSetupResponse {
  setup_id: string
  status: 'awaiting_connection'
  setup_token: string
  expires_at: string
  connector_command: string
  setup_prompt: string
}

interface ResolveSetupResponse {
  setup_id: string
  status: string
  agent: {
    name: string
    description?: string | null
  }
  haven_wallet: {
    name: string
    address: string
    chain_id: number
    network: string
  }
  agent_budget: Array<{
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  }>
  hosted_mcp_url: string
  challenge: {
    id: string
    message: string
    expires_at: string
  }
}

interface RegisterSetupResponse {
  setup_id: string
  agent_id: string
  status: 'connected_local'
  agent_status: 'pending_approval'
  api_key_prefix: string
  api_key_scope: 'setup_pending'
  delegate_address: string
  hosted_mcp_url: string
  next_action: 'return_to_haven_for_wallet_approval'
}

interface ManualCredential {
  prompt: string
  apiKey: string
  delegatePrivateKey: `0x${string}`
  delegateAddress: string
}

interface Props {
  open: boolean
  onClose: () => void
  safeAddress?: string
  safeId?: string | null
  /**
   * Fires after any setup-state change the parent should react to (typically:
   * refresh the agents list). When the on-chain approval has just been
   * recorded, `delegateAddress` is passed so the parent can optimistically
   * suppress the "Unmanaged Delegate" classification — the agent appears
   * on-chain a moment before the `/agents` list flips it from
   * `pending_approval` to `active`.
   */
  onSetupUpdated?: (info?: { delegateAddress?: string | null }) => void
  /**
   * Prefill the policy step with a starter allowance (10 USDC, daily reset)
   * when the form is empty. Used by the first-agent onboarding hand-off so a
   * new user lands in a payment-ready default they can still edit before
   * confirming. Never overwrites allowances the user already added.
   */
  starterAllowance?: boolean
}

const RUNTIME_OPTIONS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex-cli', label: 'Codex CLI' },
  { id: 'codex-desktop', label: 'Codex Desktop' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'vscode-insiders', label: 'VS Code Insiders' },
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'other', label: 'Other agent' },
]

export default function ConnectAgent2Modal({
  open,
  onClose,
  safeAddress: propSafeAddress,
  safeId: propSafeId,
  onSetupUpdated,
  starterAllowance = false,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  const { user, activeSafe } = useAuth()
  const userSafes = user?.safes ?? []

  // Only wallets on a currently-supported chain can actually run a new agent
  // (the wallet/approval flow is scoped to enabled chains). Offer those in the
  // picker; fall back to all wallets only if the user has none on a supported
  // chain, so the picker is never empty.
  const isSupportedChain = (chainId?: number) =>
    chainId !== undefined && SUPPORTED_CHAIN_IDS.includes(chainId)
  const supportedSafes = userSafes.filter((safe) => isSupportedChain(safe.chain_id))
  const selectableSafes = supportedSafes.length > 0 ? supportedSafes : userSafes

  const initialSafeId =
    propSafeId ??
    userSafes.find((safe) => safe.safe_address.toLowerCase() === propSafeAddress?.toLowerCase())?.id ??
    (isSupportedChain(activeSafe?.chain_id) ? activeSafe?.id : undefined) ??
    selectableSafes.find((safe) => safe.is_default)?.id ??
    selectableSafes[0]?.id ??
    null

  const [selectedSafeId, setSelectedSafeId] = useState<string | null>(initialSafeId)
  const [step, setStep] = useState<SetupStep>('details')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [runtime, setRuntime] = useState('claude-code')
  const [allowances, setAllowances] = useState<AllowanceEntry[]>([])
  const [addToken, setAddToken] = useState('')
  const [addAmount, setAddAmount] = useState('')
  const [addAmountError, setAddAmountError] = useState('')
  const [addReset, setAddReset] = useState(1440)
  const [setup, setSetup] = useState<CreateSetupResponse | null>(null)
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'prompt' | 'command' | 'manual' | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [manualFallbackConfirmed, setManualFallbackConfirmed] = useState(false)
  const [manualCredential, setManualCredential] = useState<ManualCredential | null>(null)
  const [manualCredentialAcknowledged, setManualCredentialAcknowledged] = useState(false)
  const [manualCreating, setManualCreating] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)

  const selectedSafe = userSafes.find((safe) => safe.id === selectedSafeId) ?? null
  const safeAddress = selectedSafe?.safe_address ?? propSafeAddress ?? ''
  const safeId = selectedSafe?.id ?? propSafeId ?? null
  const chainId = selectedSafe?.chain_id ?? activeSafe?.chain_id ?? DEFAULT_CHAIN_ID
  const walletName = selectedSafe?.name ?? activeSafe?.name ?? 'Selected Haven wallet'
  const walletNetworkName = getChainConfig(chainId).name
  const walletDisplayAddress = safeAddress || selectedSafe?.safe_address
  const statusQuery = useAgentConnectionSetupStatus(setup?.setup_id ?? null, {
    enabled: open && Boolean(setup),
  })
  const setupStatus = statusQuery.data
  const manualCredentialNeedsSave = Boolean(manualCredential && !manualCredentialAcknowledged)
  const rawVisibleStatus = cancelled ? 'cancelled' : setupStatus?.status ?? setup?.status
  const visibleStatus = manualCredentialNeedsSave ? 'awaiting_connection' : rawVisibleStatus
  const approvalSafeAddress = setupStatus?.haven_wallet.address ?? safeAddress
  const approvalChainId = setupStatus?.haven_wallet.chain_id ?? chainId
  const approvalWalletLabel = setupStatus?.haven_wallet
    ? `${setupStatus.haven_wallet.name} on ${setupStatus.haven_wallet.network}`
    : walletName
  const { details: safeDetails, loading: safeDetailsLoading } = useSafeDetails(approvalSafeAddress || null, {
    chainId: approvalChainId,
  })
  const operationGate = useSafeOperationGate({
    safeAddress: approvalSafeAddress ? (approvalSafeAddress as Address) : undefined,
    chainId: approvalChainId,
  })
  const publicClient = usePublicClient({ chainId: approvalChainId })
  const signer = useActiveSigner({
    safeAddress: approvalSafeAddress ? (approvalSafeAddress as Address) : undefined,
    chainId: approvalChainId,
  })

  // Detect when a wallet IS connected but to the wrong chain for this approval.
  // In that case `useWalletClient({ chainId: approvalChainId })` returns null, so
  // useSafeOperationGate falls through to `no_signer` — but the real problem is
  // just a network mismatch, not an absent wallet.
  const { address: walletAddress, chain: walletChain } = useAccount()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const isWrongChain = Boolean(
    walletAddress && walletChain && walletChain.id !== approvalChainId && !signer,
  )
  let approvalChainName = 'the required network'
  try { approvalChainName = getChainConfig(approvalChainId).name } catch { /* keep default */ }

  const chainTokens = useMemo(() => getChainTokens(chainId), [chainId])
  const tokenOptions = useMemo(
    () =>
      Object.entries(chainTokens).map(([symbol, cfg]) => ({
        symbol,
        address: cfg.address as Address | null,
        decimals: cfg.decimals,
      })),
    [chainTokens],
  )

  // Initialise the wallet + token selection once, when the modal opens.
  // Reading the latest values via refs (instead of listing them as effect
  // deps) is deliberate: `tokenOptions` changes identity whenever the chosen
  // wallet's chain changes, so depending on it here would re-run this effect
  // and snap the user's wallet choice back to the default mid-selection.
  const initialSafeIdRef = useRef(initialSafeId)
  initialSafeIdRef.current = initialSafeId
  const firstTokenRef = useRef<string>(tokenOptions[0]?.symbol ?? '')
  firstTokenRef.current = tokenOptions[0]?.symbol ?? ''
  const prevOpenRef = useRef(false)

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setSelectedSafeId(initialSafeIdRef.current)
      setAddToken(firstTokenRef.current)
    }
    prevOpenRef.current = open
  }, [open])

  useEffect(() => {
    if (!open) return
    const validSymbols = new Set(tokenOptions.map((token) => token.symbol))
    if (!validSymbols.has(addToken)) setAddToken(tokenOptions[0]?.symbol ?? '')
    setAllowances((prev) => prev.filter((allowance) => validSymbols.has(allowance.tokenSymbol)))
  }, [addToken, open, tokenOptions])

  // First-agent hand-off: seed a starter budget so the policy step is
  // payment-ready by default. Only when the form is empty — user edits win.
  useEffect(() => {
    if (!open || !starterAllowance) return
    const usdc =
      tokenOptions.find((token) => token.symbol === 'USDC') ??
      tokenOptions.find((token) => token.symbol === 'USDC.e')
    if (!usdc) return
    setAllowances((prev) =>
      prev.length > 0
        ? prev
        : [{
            tokenSymbol: usdc.symbol,
            tokenAddress: usdc.address,
            decimals: usdc.decimals,
            amount: '10',
            resetTimeMin: 1440,
          }],
    )
  }, [open, starterAllowance, tokenOptions])

  const resetForm = useCallback(() => {
    setStep('details')
    setName('')
    setDescription('')
    setRuntime('claude-code')
    setAllowances([])
    setAddToken(tokenOptions[0]?.symbol ?? '')
    setAddAmount('')
    setAddAmountError('')
    setAddReset(1440)
    setSetup(null)
    setCreating(false)
    setCreateError(null)
    setCopied(null)
    setCancelled(false)
    setApproving(false)
    setApprovalError(null)
    setManualFallbackConfirmed(false)
    setManualCredential(null)
    setManualCredentialAcknowledged(false)
    setManualCreating(false)
    setManualError(null)
  }, [tokenOptions])

  const handleClose = useCallback(() => {
    if (manualCredentialNeedsSave && typeof window !== 'undefined') {
      const shouldClose = window.confirm(
        'This one-time manual credential will be hidden if you close now. Continue?',
      )
      if (!shouldClose) return
    }
    resetForm()
    onClose()
  }, [manualCredentialNeedsSave, onClose, resetForm])

  useEscapeToClose(open, handleClose, { enabled: !creating && !approving && !manualCreating })

  if (!open) return null

  const hasMultipleSafes = userSafes.length > 1
  const setupSteps: SetupStep[] = hasMultipleSafes
    ? ['details', 'account', 'policy', 'review', 'connect']
    : ['details', 'policy', 'review', 'connect']
  const currentStepIndex = setupSteps.indexOf(step)
  const detailsNextStep = hasMultipleSafes ? 'account' : 'policy'
  const policyBackStep = hasMultipleSafes ? 'account' : 'details'
  const budgetRows = allowances.map((allowance) => ({
    id: allowance.tokenSymbol,
    tokenSymbol: allowance.tokenSymbol,
    amount: allowance.amount,
    period: budgetPeriodLabel(allowance.resetTimeMin),
  }))
  const availableTokens = tokenOptions.filter(
    (token) => !allowances.some((allowance) => allowance.tokenSymbol === token.symbol),
  )
  const addTokenOption = availableTokens.find((token) => token.symbol === addToken)
  const addAmountValidation =
    addAmount && addTokenOption
      ? validateMoneyInput(addAmount, addTokenOption.decimals, { tokenSymbol: addTokenOption.symbol })
      : null
  const addAmountMessage =
    addAmountError ||
    (addAmountValidation && !addAmountValidation.ok && !isIncompleteMoneyInput(addAmount)
      ? addAmountValidation.message
      : '')
  const walletUnavailable = !safeId

  async function handleCreateSetup() {
    if (!safeId) {
      setCreateError('Choose or create a Haven wallet before creating this setup.')
      return
    }
    // Synchronous re-entry guard: `creating` only disables the button on the
    // next render, so a fast double-click would POST twice and orphan the first
    // pending setup. The ref flips immediately, before React commits.
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setCreateError(null)
    try {
      const response = await api.post<CreateSetupResponse>('/agent-connection-setups', {
        name: name.trim(),
        description: description.trim() || undefined,
        safe_id: safeId,
        runtime,
        allowances: allowances.map((allowance) => ({
          token_address:
            allowance.tokenAddress ?? '0x0000000000000000000000000000000000000000',
          token_symbol: allowance.tokenSymbol,
          allowance_amount: parseUnits(allowance.amount, allowance.decimals).toString(),
          reset_period_min: allowance.resetTimeMin,
        })),
      })
      setSetup(response)
      setCancelled(false)
      setStep('connect')
      onSetupUpdated?.()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'We could not create the setup.')
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  function handleAddAllowance() {
    if (!addTokenOption) return
    const parsedAmount = validateMoneyInput(addAmount, addTokenOption.decimals, {
      tokenSymbol: addTokenOption.symbol,
    })
    if (!parsedAmount.ok) {
      setAddAmountError(parsedAmount.message)
      return
    }
    setAllowances((prev) => [
      ...prev,
      {
        tokenSymbol: addTokenOption.symbol,
        tokenAddress: addTokenOption.address,
        decimals: addTokenOption.decimals,
        amount: parsedAmount.amount,
        resetTimeMin: addReset,
      },
    ])
    setAddAmount('')
    setAddAmountError('')
    setAddToken(availableTokens.find((token) => token.symbol !== addTokenOption.symbol)?.symbol ?? '')
  }

  async function copyText(kind: 'prompt' | 'command' | 'manual', value: string) {
    await navigator.clipboard?.writeText(value)
    setCopied(kind)
  }

  async function handleCancelSetup() {
    if (approving || manualCreating) return
    if (!setup) {
      handleClose()
      return
    }
    try {
      await api.post(`/agent-connection-setups/${encodeURIComponent(setup.setup_id)}/cancel`, {})
      setCancelled(true)
      onSetupUpdated?.()
      await statusQuery.refetch()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'We could not cancel this setup.')
    }
  }

  async function handleApproveAgentRules() {
    if (!setup || !setupStatus) return
    const delegateAddress = setupStatus.delegate_address
    const approvalWallet = setupStatus.haven_wallet.address
    const approvalNetwork = setupStatus.haven_wallet.chain_id
    if (!publicClient || !signer || !safeDetails || !delegateAddress) {
      setApprovalError('Haven is still loading the wallet approval details.')
      return
    }

    setApproving(true)
    setApprovalError(null)
    try {
      const setupAllowances: AllowanceSetup[] = setupStatus.agent_budget.map((budget) => ({
        token: budget.token_address as Address,
        tokenSymbol: budget.token_symbol,
        amount: BigInt(budget.allowance_amount),
        resetTimeMin: budget.reset_period_min,
      }))

      const result = await executeAgentSetup({
        signer,
        publicClient,
        safeAddress: approvalWallet as Address,
        delegateAddress: delegateAddress as Address,
        allowances: setupAllowances,
        chainId: approvalNetwork,
        threshold: safeDetails.threshold ?? 1,
      })

      const baseApproval = {
        safe_tx_hash: result.safeTxHash,
        chain_id: approvalNetwork,
        safe_address: approvalWallet,
        allowance_module_address: ALLOWANCE_MODULE_ADDRESS,
        delegate_address: delegateAddress,
      }

      if (result.status === 'proposed') {
        await recordWalletApproval(setup.setup_id, { result: 'proposed', ...baseApproval })
      } else {
        // confirmed or receipt_timeout — both submitted the tx; record the
        // confirmation state so Haven keeps checking on a timeout.
        await recordWalletApproval(setup.setup_id, {
          result: 'confirmed',
          tx_hash: result.txHash,
          confirmation_status: result.status === 'receipt_timeout' ? 'receipt_timeout' : 'confirmed',
          ...baseApproval,
        })
        if (result.status === 'receipt_timeout') {
          setApprovalError(
            `The transaction was submitted but is still confirming. Haven will keep checking ${getExplorerUrl(approvalNetwork, 'tx', result.txHash)}.`,
          )
        }
      }
      await statusQuery.refetch()
      // Pass the delegate so the agents page can suppress the brief
      // "Unmanaged Delegate" window between on-chain landing and the
      // backend status flipping from `pending_approval` → `active`.
      onSetupUpdated?.({ delegateAddress: setupStatus.delegate_address ?? null })
    } catch (err) {
      setApprovalError(approvalErrorMessage(err, signer?.type))
    } finally {
      setApproving(false)
    }
  }

  async function handleCreateManualCredential() {
    if (!setup || !manualFallbackConfirmed) return
    setManualCreating(true)
    setManualError(null)
    try {
      const resolved = await api.post<ResolveSetupResponse>('/agent-connection-setups/resolve', {
        setup_token: setup.setup_token,
        connector_version: 'browser-manual-fallback',
        runtime,
      })
      const delegatePrivateKey = generatePrivateKey()
      const account = privateKeyToAccount(delegatePrivateKey)
      const apiKey = generateBrowserAgentApiKey()
      const proofSignature = await account.signMessage({ message: resolved.challenge.message })
      const registration = await api.post<RegisterSetupResponse>('/agent-connection-setups/register', {
        setup_token: setup.setup_token,
        challenge_id: resolved.challenge.id,
        delegate_address: account.address,
        proof_signature: proofSignature,
        api_key_hash: await sha256Hex(apiKey),
        api_key_prefix: apiKey.slice(0, 12),
        runtime,
        connector_version: 'browser-manual-fallback',
        connector_context: {
          environment_label: 'Manual browser fallback',
          config_target: 'paste-to-agent',
        },
        install_capabilities: {
          can_write_runtime_config: false,
          restart_required: true,
        },
      })

      setManualCredential({
        apiKey,
        delegatePrivateKey,
        delegateAddress: registration.delegate_address,
        prompt: buildManualCredentialPrompt({
          agentName: resolved.agent.name,
          havenWallet: `${resolved.haven_wallet.name} on ${resolved.haven_wallet.network}`,
          budgets: resolved.agent_budget.map((budget) =>
            `${formatAllowanceForToken(budget.allowance_amount, resolved.haven_wallet.chain_id, budget.token_symbol)} ${budget.token_symbol} ${budgetPeriodLabel(budget.reset_period_min)}`,
          ),
          apiKey,
          delegatePrivateKey,
          delegateAddress: registration.delegate_address,
          apiBaseUrl: manualApiBaseUrl(setup.connector_command),
          hostedMcpUrl: registration.hosted_mcp_url || resolved.hosted_mcp_url,
        }),
      })
      setManualCredentialAcknowledged(false)
      onSetupUpdated?.()
    } catch (err) {
      setManualError(err instanceof Error ? err.message : 'We could not create the manual credential.')
    } finally {
      setManualCreating(false)
    }
  }

  async function handleContinueAfterManualCredential() {
    setManualCredentialAcknowledged(true)
    await statusQuery.refetch()
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-3 v2-modal-backdrop">
      <div className="absolute inset-0" onClick={creating || approving || manualCreating ? undefined : handleClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Connect agent 2"
        className="relative w-full max-w-xl max-h-[calc(100vh-24px)] overflow-y-auto overflow-x-hidden rounded-[14px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Connect agent 2</h2>
              <StatusBadge tone="brand">Preview</StatusBadge>
            </div>
            <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
              {headerSubtitle(step, visibleStatus, runtimeIsConfigured(setupStatus?.install_status))}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={creating || approving || manualCreating}
            aria-label="Close"
            className="p-1 -mr-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface-2)] disabled:opacity-20 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="border-b border-[var(--v2-border)] px-5 py-3">
          <StepProgress totalSteps={setupSteps.length} currentStep={Math.max(currentStepIndex, 0)} />
        </div>

        <div className="p-5">
          {step === 'details' && (
            <div className="v2-animate-step-rise space-y-5">
              <div>
                <label htmlFor="connect2-name" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
                  Agent name
                </label>
                <Input
                  id="connect2-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Research Agent"
                />
              </div>
              <div>
                <label htmlFor="connect2-description" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
                  Description <span className="normal-case">(optional)</span>
                </label>
                <textarea
                  id="connect2-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="What does this agent do?"
                  rows={2}
                  className="w-full resize-none rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] px-3 py-2 text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] transition-colors focus:border-[var(--v2-brand)] focus:outline-none focus:ring-2 focus:ring-[var(--v2-brand)]/20"
                />
              </div>
              <div>
                <label htmlFor="connect2-runtime" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
                  Agent environment
                </label>
                <Select
                  id="connect2-runtime"
                  value={runtime}
                  onChange={(event) => setRuntime(event.target.value)}
                >
                  {RUNTIME_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                  Haven will create a local setup prompt for this environment.
                </p>
              </div>
              <Button
                onClick={() => setStep(detailsNextStep)}
                disabled={!name.trim()}
                className="w-full"
              >
                Set agent budget
              </Button>
            </div>
          )}

          {step === 'account' && (
            <div className="v2-animate-step-rise space-y-4">
              <WalletIdentityBlock name={walletName} network={walletNetworkName} address={walletDisplayAddress} />
              <div>
                <label htmlFor="connect2-safe" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
                  Haven wallet
                </label>
                <Select
                  id="connect2-safe"
                  value={selectedSafeId ?? ''}
                  onChange={(event) => setSelectedSafeId(event.target.value)}
                >
                  {selectableSafes.map((safe) => (
                    <option key={safe.id} value={safe.id}>
                      {safe.name}
                    </option>
                  ))}
                </Select>
              </div>
              <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
                The agent can request payments from this Haven wallet within the budget you set next.
              </p>
              <div className="flex gap-3">
                <Button variant="ghost" onClick={() => setStep('details')} className="flex-1">
                  Back
                </Button>
                <Button onClick={() => setStep('policy')} disabled={!selectedSafeId} className="flex-1">
                  Set agent budget
                </Button>
              </div>
            </div>
          )}

          {step === 'policy' && (
            <div className="v2-animate-step-rise space-y-4">
              {allowances.length > 0 && (
                <AgentBudgetCard
                  agentName={name || 'New agent'}
                  budgets={budgetRows}
                  status="Budget draft"
                  density="compact"
                  onRemoveBudget={(row) => {
                    setAllowances((prev) => prev.filter((allowance) => allowance.tokenSymbol !== row.tokenSymbol))
                    setAddToken(row.tokenSymbol)
                    // Clear any stale validation error from the previously
                    // selected token so it doesn't block the re-selected one.
                    setAddAmountError('')
                  }}
                />
              )}

              {availableTokens.length > 0 ? (
                <div className="space-y-3 rounded-[10px] border border-dashed border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">Add agent budget</p>
                    <p className="text-xs text-[var(--v2-ink-3)]">One per token</p>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Select value={addToken} onChange={(event) => { setAddToken(event.target.value); setAddAmountError('') }}>
                      {availableTokens.map((token) => (
                        <option key={token.symbol} value={token.symbol}>
                          {token.symbol}
                        </option>
                      ))}
                    </Select>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={addAmount}
                      onChange={(event) => {
                        const value = event.target.value
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
                    <Select value={addReset} onChange={(event) => setAddReset(Number(event.target.value))}>
                      {RESET_PERIODS.map((period) => (
                        <option key={period.value} value={period.value}>
                          {period.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleAddAllowance}
                    disabled={!addAmount || !addAmountValidation?.ok || !addTokenOption}
                    className="w-full"
                  >
                    Add budget
                  </Button>
                </div>
              ) : allowances.length > 0 ? (
                <p className="rounded-[10px] bg-[var(--v2-surface)] px-3 py-2 text-xs text-[var(--v2-ink-2)]">
                  All supported tokens for {walletNetworkName} already have budgets.
                </p>
              ) : null}

              {allowances.length === 0 && (
                <p className="py-4 text-center text-xs text-[var(--v2-ink-3)]">
                  Add at least one agent budget to continue
                </p>
              )}

              <div className="flex gap-3">
                <Button variant="ghost" onClick={() => setStep(policyBackStep)} className="flex-1">
                  Back
                </Button>
                <Button
                  onClick={() => setStep('review')}
                  disabled={allowances.length === 0}
                  className="flex-1"
                >
                  Review agent rules
                </Button>
              </div>
            </div>
          )}

          {step === 'review' && (
            <div className="v2-animate-step-rise space-y-5">
              <AgentRulesSummary
                title="Review agent rules"
                description="Haven will create a pending setup. The agent creates its key locally after you paste the setup prompt into its environment."
                density="compact"
                items={[
                  { label: 'Who can spend', value: name, helper: description.trim() || undefined },
                  { label: 'From wallet', value: `${walletName} on ${walletNetworkName}` },
                  {
                    label: 'Agent budget',
                    value: (
                      <div className="space-y-1">
                        {allowances.map((allowance) => (
                          <div key={allowance.tokenSymbol}>
                            {allowance.amount} {allowance.tokenSymbol} {budgetPeriodLabel(allowance.resetTimeMin)}
                          </div>
                        ))}
                      </div>
                    ),
                  },
                  {
                    label: 'Approve actions',
                    value: 'Payments above budget',
                    helper: 'Haven will ask you before requests above the remaining budget move money.',
                  },
                ]}
              />

              <ApprovalRequiredBanner title="The spending key stays local" density="compact" tone="neutral">
                The setup prompt lets your agent create the key in its own environment. Haven receives the public signing address only.
              </ApprovalRequiredBanner>

              {createError && (
                <div className="rounded-[10px] border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-xs text-[var(--v2-danger)]">
                  {createError}
                </div>
              )}

              {walletUnavailable && !createError && (
                <div className="rounded-[10px] border border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)] p-3">
                  <p className="text-sm font-semibold text-[var(--v2-ink)]">Haven wallet unavailable</p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                    Create or select a Haven wallet before creating the setup prompt.
                  </p>
                </div>
              )}

              <div className="flex gap-3">
                <Button variant="ghost" onClick={() => setStep('policy')} className="flex-1">
                  Back
                </Button>
                <Button onClick={handleCreateSetup} disabled={creating || walletUnavailable} className="flex-1">
                  {creating ? 'Creating setup...' : 'Create setup prompt'}
                </Button>
              </div>
            </div>
          )}

          {step === 'connect' && setup && (
            <div className="v2-animate-step-rise space-y-5">
              {visibleStatus === 'awaiting_connection' && (
                <WaitingForConnector
                  setup={setup}
                  runtime={runtime}
                  copied={copied}
                  onCopy={copyText}
                  manualFallbackConfirmed={manualFallbackConfirmed}
                  onManualFallbackConfirmedChange={setManualFallbackConfirmed}
                  manualCredential={manualCredential}
                  manualCredentialAcknowledged={manualCredentialAcknowledged}
                  manualCreating={manualCreating}
                  manualError={manualError}
                  onCreateManualCredential={handleCreateManualCredential}
                  onContinueAfterManualCredential={handleContinueAfterManualCredential}
                  loading={statusQuery.loading}
                  error={statusQuery.error}
                  expiresAt={setup.expires_at}
                  onCancel={handleCancelSetup}
                />
              )}

              {visibleStatus === 'connected_local' &&
                !runtimeIsConfigured(setupStatus?.install_status) &&
                !setupStatus?.install_status?.error_code && (
                <FinalizingLocalSetup loading={statusQuery.loading} />
              )}

              {((visibleStatus === 'connected_local' &&
                (runtimeIsConfigured(setupStatus?.install_status) ||
                  setupStatus?.install_status?.error_code)) ||
                visibleStatus === 'awaiting_wallet_approval') && (
                <LocalConnectionReady
                  status={setupStatus}
                  fallbackSetup={setup}
                  walletName={approvalWalletLabel}
                  chainId={approvalChainId}
                  safeDetailsLoading={safeDetailsLoading}
                  safeThreshold={safeDetails?.threshold ?? 1}
                  safeOwnerCount={safeDetails?.owners?.length ?? 1}
                  operationGate={operationGate}
                  publicClientReady={Boolean(publicClient)}
                  signerReady={Boolean(signer)}
                  approving={approving}
                  approvalError={approvalError}
                  onApprove={handleApproveAgentRules}
                  onCancel={handleCancelSetup}
                  isWrongChain={isWrongChain}
                  approvalChainName={approvalChainName}
                  onSwitchChain={() => switchChain({ chainId: approvalChainId })}
                  isSwitchingChain={isSwitchingChain}
                />
              )}

              {visibleStatus === 'approval_in_progress' && (
                <SetupStatusState
                  title="Approval in progress"
                  body="Haven is waiting for wallet approval. The agent cannot spend from the Haven wallet until approval is complete."
                  tone="warning"
                  primaryLabel="Done"
                  onPrimary={handleClose}
                />
              )}

              {visibleStatus === 'proposed' && (
                <SetupStatusState
                  title="Waiting for more approvals"
                  body="The agent rules were proposed for wallet approval. Spending is not active until the remaining approvals are complete."
                  tone="warning"
                  primaryLabel="Done"
                  onPrimary={handleClose}
                />
              )}

              {visibleStatus === 'active' && (
                <SetupStatusState
                  title="Agent rules approved"
                  body={
                    setupStatus?.install_status?.restart_required
                      ? 'Your agent can now spend within budget. Restart the agent so it can load Haven tools.'
                      : "Your agent can now spend within budget. If you haven't already, restart the agent so it loads Haven tools."
                  }
                  tone="success"
                  primaryLabel="Done"
                  onPrimary={handleClose}
                />
              )}

              {visibleStatus === 'expired' && (
                <TerminalSetupState
                  title="Setup prompt expired"
                  body="Create a new setup prompt, then paste the fresh prompt into your agent environment."
                  tone="warning"
                  primaryLabel="Create a new setup"
                  onPrimary={() => {
                    setSetup(null)
                    setStep('review')
                  }}
                  secondaryLabel="Close"
                  onSecondary={handleClose}
                />
              )}

              {visibleStatus === 'cancelled' && (
                <TerminalSetupState
                  title="Setup cancelled"
                  body="This setup can no longer connect an agent. Create a new setup prompt when you are ready."
                  tone="neutral"
                  primaryLabel="Create a new setup"
                  onPrimary={() => {
                    setSetup(null)
                    setCancelled(false)
                    setStep('review')
                  }}
                  secondaryLabel="Close"
                  onSecondary={handleClose}
                />
              )}

              {visibleStatus === 'failed' && (
                <TerminalSetupState
                  title="Setup failed"
                  body={setupStatus?.failure_reason ?? 'Create a new setup prompt and try again.'}
                  tone="danger"
                  primaryLabel="Create a new setup"
                  onPrimary={() => {
                    setSetup(null)
                    setStep('review')
                  }}
                  secondaryLabel="Close"
                  onSecondary={handleClose}
                />
              )}

              {visibleStatus &&
                ![
                  'awaiting_connection',
                  'connected_local',
                  'awaiting_wallet_approval',
                  'approval_in_progress',
                  'proposed',
                  'active',
                  'expired',
                  'cancelled',
                  'failed',
                ].includes(visibleStatus) && (
                  <SetupStatusState
                    title="Setup status updated"
                    body="Haven received a setup status this preview does not recognize yet. Refresh the page or create a new setup if this does not resolve."
                    tone="neutral"
                    primaryLabel="Done"
                    onPrimary={handleClose}
                  />
                )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function WaitingForConnector({
  setup,
  runtime,
  copied,
  onCopy,
  manualFallbackConfirmed,
  onManualFallbackConfirmedChange,
  manualCredential,
  manualCredentialAcknowledged,
  manualCreating,
  manualError,
  onCreateManualCredential,
  onContinueAfterManualCredential,
  loading,
  error,
  expiresAt,
  onCancel,
}: {
  setup: CreateSetupResponse
  runtime: string
  copied: 'prompt' | 'command' | 'manual' | null
  onCopy: (kind: 'prompt' | 'command' | 'manual', value: string) => void
  manualFallbackConfirmed: boolean
  onManualFallbackConfirmedChange: (confirmed: boolean) => void
  manualCredential: ManualCredential | null
  manualCredentialAcknowledged: boolean
  manualCreating: boolean
  manualError: string | null
  onCreateManualCredential: () => void
  onContinueAfterManualCredential: () => void
  loading: boolean
  error: string | null
  expiresAt: string
  onCancel: () => void
}) {
  return (
    <>
      <div className="rounded-[10px] border border-[var(--v2-brand)]/15 bg-[var(--v2-brand-soft)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Connect your agent</h3>
            <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
              Paste this prompt into the agent environment. It includes your approval for the exact local setup actions, creates the key there, and sends Haven only the public signing address.
            </p>
            {runtime === 'codex-desktop' && (
              <p className="mt-2 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Codex Desktop may ask you to approve running the setup command. That is expected.
              </p>
            )}
          </div>
          <StatusBadge tone={loading ? 'neutral' : 'warning'}>{loading ? 'Checking' : 'Waiting'}</StatusBadge>
        </div>
      </div>

      <CopyBlock
        label="Setup prompt"
        value={setup.setup_prompt}
        copied={copied === 'prompt'}
        onCopy={() => onCopy('prompt', setup.setup_prompt)}
      />

      <details className="rounded-[10px] border border-[var(--v2-border)] bg-white p-3 text-xs">
        <summary className="cursor-pointer text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]">
          Command fallback
        </summary>
        <div className="mt-3">
          <CopyBlock
            label="Local command"
            value={setup.connector_command}
            copied={copied === 'command'}
            onCopy={() => onCopy('command', setup.connector_command)}
          />
        </div>
      </details>

      <details className="rounded-[10px] border border-[var(--v2-border)] bg-white p-3 text-xs">
        <summary className="cursor-pointer text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]">
          Manual credential fallback
        </summary>
        <div className="mt-3 space-y-3">
          <p className="leading-relaxed text-[var(--v2-ink-2)]">
            Use this only if the agent cannot run the setup command or store the local connector files. Haven will still receive only the public signing address and API key hash.
          </p>
          <div className="rounded-[10px] border border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)] p-3">
            <p className="font-semibold text-[var(--v2-ink)]">Before creating a manual credential</p>
            <ul className="mt-2 list-disc space-y-1 pl-4 leading-relaxed text-[var(--v2-ink-2)]">
              <li>Use it only in a trusted agent workspace.</li>
              <li>The private signing key lets the agent sign payments within the approved agent budget.</li>
              <li>The API key identifies the agent but cannot spend alone.</li>
              <li>If it may have leaked, pause or revoke the agent in Haven.</li>
              <li>Do not commit it, upload it, or paste it into shared logs.</li>
            </ul>
          </div>
          <label className="flex items-start gap-2 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3 text-[var(--v2-ink-2)]">
            <input
              type="checkbox"
              checked={manualFallbackConfirmed}
              onChange={(event) => onManualFallbackConfirmedChange(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              I understand this fallback shows a one-time private signing key and should only be pasted into a trusted agent workspace.
            </span>
          </label>
          {manualError && (
            <div className="rounded-[10px] border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-[var(--v2-danger)]">
              {manualError}
            </div>
          )}
          {!manualCredential && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCreateManualCredential}
              disabled={!manualFallbackConfirmed || manualCreating}
              className="w-full"
            >
              {manualCreating ? 'Creating manual credential...' : 'Create manual credential'}
            </Button>
          )}
          {manualCredential && (
            <div className="space-y-3">
              <CopyBlock
                label="Manual credential prompt"
                value={manualCredential.prompt}
                copied={copied === 'manual'}
                onCopy={() => onCopy('manual', manualCredential.prompt)}
              />
              {!manualCredentialAcknowledged && (
                <Button onClick={onContinueAfterManualCredential} className="w-full">
                  Continue to wallet approval
                </Button>
              )}
            </div>
          )}
        </div>
      </details>

      <p className="text-xs text-[var(--v2-ink-3)]">
        Expires {formatAbsoluteDate(expiresAt)}. {error ? `Status check failed: ${error}` : 'Haven will update this screen when the local connection finishes.'}
      </p>

      <div className="flex gap-3">
        <Button variant="ghost" onClick={onCancel} className="flex-1">
          Cancel setup
        </Button>
      </div>
    </>
  )
}

function FinalizingLocalSetup({ loading }: { loading: boolean }) {
  return (
    <div className="space-y-4 text-center">
      <div className="flex justify-center">
        <StatusBadge tone="neutral">{loading ? 'Checking' : 'Finishing setup'}</StatusBadge>
      </div>
      <p className="mx-auto max-w-sm text-sm leading-relaxed text-[var(--v2-ink-2)]">
        The connector is finishing local setup. This usually takes a few seconds.
      </p>
    </div>
  )
}

function LocalConnectionReady({
  status,
  fallbackSetup,
  walletName,
  chainId,
  safeDetailsLoading,
  safeThreshold,
  safeOwnerCount,
  operationGate,
  publicClientReady,
  signerReady,
  approving,
  approvalError,
  onApprove,
  onCancel,
  isWrongChain,
  approvalChainName,
  onSwitchChain,
  isSwitchingChain,
}: {
  status: AgentConnectionSetupStatusResponse | null
  fallbackSetup: CreateSetupResponse
  walletName: string
  chainId: number
  safeDetailsLoading: boolean
  safeThreshold: number
  safeOwnerCount: number
  operationGate: ReturnType<typeof useSafeOperationGate>
  publicClientReady: boolean
  signerReady: boolean
  approving: boolean
  approvalError: string | null
  onApprove: () => void
  onCancel: () => void
  /** True when a wallet is connected but to the wrong chain for this approval */
  isWrongChain: boolean
  /** Human-readable name of the chain the approval requires */
  approvalChainName: string
  /** Switch the connected wallet to the approval chain */
  onSwitchChain: () => void
  /** True while a chain-switch is in flight */
  isSwitchingChain: boolean
}) {
  // The pre-approval screen is intentionally calm — single anchor surface, one
  // primary action. The runtime-restart hint used to live here as a separate
  // yellow callout; it now moves to the post-approval `active` SetupStatusState
  // where it's actually actionable. The duplicate "Local connection ready"
  // green callout collapses into a single inline check row inside the summary
  // footer below.
  const install = status?.install_status
  const budgets = status?.agent_budget ?? []
  const displayBudgets = budgets.map((budget) => ({
    id: budget.id ?? budget.token_symbol,
    tokenSymbol: budget.token_symbol,
    amount: formatAllowanceForToken(budget.allowance_amount, chainId, budget.token_symbol),
    period: budgetPeriodLabel(budget.reset_period_min),
  }))
  const agentName = status?.agent.name ?? 'this agent'
  const verifiedAddressShort = status?.delegate_address ? truncate(status.delegate_address) : null
  const approvalBlocked = approvalBlockReason(
    operationGate,
    safeDetailsLoading,
    status,
    publicClientReady,
    signerReady,
    isWrongChain,
    approvalChainName,
  )

  return (
    <>
      <AgentRulesSummary
        title="Approve agent rules"
        description={`You sign to give ${agentName} authority to spend within this budget. Nothing executes outside what you approve here.`}
        density="compact"
        items={[
          {
            label: 'Agent',
            value: status?.agent.name ?? 'New agent',
            helper: status?.agent.description?.trim() || undefined,
          },
          { label: 'From', value: walletName },
          {
            label: 'Budget',
            value: (
              <div className="space-y-1">
                {displayBudgets.length === 0 ? (
                  <span className="text-[var(--v2-ink-3)]">Waiting for budget</span>
                ) : (
                  displayBudgets.map((budget) => (
                    <div key={budget.id}>
                      {budget.amount} {budget.tokenSymbol} {budget.period}
                    </div>
                  ))
                )}
              </div>
            ),
          },
        ]}
        footer={
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[12px] text-[var(--v2-ink-2)]">
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-[var(--v2-success)]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>
                Local connection verified
                {verifiedAddressShort ? ` · ${verifiedAddressShort}` : ''}
              </span>
            </div>
            {(status?.delegate_address || install || safeThreshold > 1) && (
              <details className="group text-[12px]">
                <summary className="flex cursor-pointer list-none items-center gap-1 text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)]">
                  <svg
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Verification details
                </summary>
                <dl className="mt-2 space-y-2 border-l border-[var(--v2-border)] pl-3">
                  {status?.delegate_address && (
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-[var(--v2-ink-3)]">
                        Public address
                      </dt>
                      <dd className="mt-0.5 break-all font-mono text-[11px] text-[var(--v2-ink)]">
                        {status.delegate_address}
                      </dd>
                    </div>
                  )}
                  {install && (
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-[var(--v2-ink-3)]">
                        Runtime setup
                      </dt>
                      <dd className="mt-0.5 text-[12px] text-[var(--v2-ink-2)]">
                        <span className="text-[var(--v2-ink)]">{runtimeStatusLabel(install)}</span>
                        {runtimeStatusHelper(install) ? ` — ${runtimeStatusHelper(install)}` : ''}
                      </dd>
                    </div>
                  )}
                  {safeThreshold > 1 && (
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-[var(--v2-ink-3)]">
                        Approvals required
                      </dt>
                      <dd className="mt-0.5 text-[12px] text-[var(--v2-ink-2)]">
                        {safeThreshold} of {safeOwnerCount}
                      </dd>
                    </div>
                  )}
                </dl>
              </details>
            )}
          </div>
        }
      />

      {approvalBlocked && (
        <div className="rounded-[10px] border border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)] p-3">
          <p className="text-sm font-semibold text-[var(--v2-ink)]">Approval unavailable</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">{approvalBlocked}</p>
          {operationGate.kind === 'no_signer' && isWrongChain && (
            // Wallet is connected but on the wrong chain — offer a one-click switch.
            <Button
              variant="ghost"
              size="sm"
              onClick={onSwitchChain}
              disabled={isSwitchingChain}
              className="mt-3 w-full"
            >
              {isSwitchingChain ? 'Switching network…' : `Switch to ${approvalChainName}`}
            </Button>
          )}
          {operationGate.kind === 'no_signer' && !isWrongChain && (
            // No wallet at all — show the connect button.
            <div className="mt-3">
              <WalletButton />
            </div>
          )}
        </div>
      )}

      {approvalError && (
        <div className="rounded-[10px] border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-xs text-[var(--v2-danger)]">
          {approvalError}
        </div>
      )}

      <div className="flex gap-3">
        <Button variant="ghost" onClick={onCancel} disabled={approving} className="flex-1">
          Cancel setup
        </Button>
        <Button
          onClick={onApprove}
          disabled={Boolean(approvalBlocked) || approving}
          className="flex-1"
        >
          {approving
            ? 'Approving...'
            : safeThreshold > 1
              ? 'Submit approval'
              : 'Approve rules'}
        </Button>
      </div>
      <span className="sr-only">{fallbackSetup.setup_id}</span>
    </>
  )
}

function CopyBlock({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-[var(--v2-ink-3)]">{label}</p>
        <Button variant="ghost" size="sm" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="max-h-48 overflow-auto rounded-md bg-[var(--v2-surface)] p-3 text-left text-xs leading-relaxed text-[var(--v2-ink)] whitespace-pre-wrap break-words">
        {value}
      </pre>
    </div>
  )
}

function TerminalSetupState({
  title,
  body,
  tone,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
}: {
  title: string
  body: string
  tone: StatusTone
  primaryLabel: string
  secondaryLabel: string
  onPrimary: () => void
  onSecondary: () => void
}) {
  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--v2-surface-2)]">
        <StatusBadge tone={tone}>{title.split(' ')[1] ?? 'Setup'}</StatusBadge>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h3>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-[var(--v2-ink-2)]">{body}</p>
      </div>
      <div className="flex gap-3">
        <Button variant="ghost" onClick={onSecondary} className="flex-1">
          {secondaryLabel}
        </Button>
        <Button onClick={onPrimary} className="flex-1">
          {primaryLabel}
        </Button>
      </div>
    </div>
  )
}

function SetupStatusState({
  title,
  body,
  tone,
  primaryLabel,
  onPrimary,
}: {
  title: string
  body: string
  tone: StatusTone
  primaryLabel: string
  onPrimary: () => void
}) {
  return (
    <div className="space-y-4 text-center">
      <div className="flex justify-center">
        <StatusBadge tone={tone}>{title}</StatusBadge>
      </div>
      <p className="mx-auto max-w-sm text-sm leading-relaxed text-[var(--v2-ink-2)]">{body}</p>
      <Button onClick={onPrimary} className="w-full">
        {primaryLabel}
      </Button>
    </div>
  )
}

function headerSubtitle(step: SetupStep, status: string | undefined, runtimeConfigured?: boolean): string {
  if (step === 'connect') {
    if (status === 'connected_local' && !runtimeConfigured) return 'Finishing local setup'
    if (status === 'connected_local' || status === 'awaiting_wallet_approval') return 'Approve the agent rules'
    if (status === 'approval_in_progress' || status === 'proposed') return 'Waiting for approval to land'
    if (status === 'active') return 'Agent rules approved'
    if (status === 'expired') return 'This setup prompt expired'
    if (status === 'cancelled') return 'This setup was cancelled'
    return 'Paste the setup prompt into your agent environment'
  }
  if (step === 'details') return 'Name the agent and choose where it runs'
  if (step === 'account') return 'Choose the Haven wallet this agent can spend from'
  if (step === 'policy') return 'Set agent budget and approval boundaries'
  return 'Review before creating the local setup prompt'
}

function budgetPeriodLabel(mins: number) {
  const label = (RESET_PERIODS.find((period) => period.value === mins)?.label ?? `${mins}m`).toLowerCase()
  if (label === 'one-time') return 'total budget'
  if (label === 'daily') return 'per day'
  if (label === 'weekly') return 'per week'
  if (label === 'monthly') return 'per month'
  return `every ${label}`
}

function formatAbsoluteDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function runtimeStatusLabel(install: AgentConnectionSetupStatusResponse['install_status']): string {
  if (!install) return 'Checking runtime setup'
  if (install.error_code) return 'Needs attention'
  if (install.restart_required && runtimeIsConfigured(install)) return 'Restart ready'
  if (runtimeIsConfigured(install)) return 'Configured'
  if (install.credential_files_written) return 'Credentials stored locally'
  return 'Manual setup needed'
}

function runtimeStatusHelper(install: AgentConnectionSetupStatusResponse['install_status']): string {
  if (!install) return 'Haven is waiting for the connector to report setup status.'
  if (install.error_code === 'local_mcp_ack_required') return 'Haven tools need one-time acknowledgement before this agent can load them.'
  if (install.error_code === 'local_signer_ack_required') return 'Local signing needs one-time acknowledgement before this agent can load Haven tools.'
  if (install.error_code === 'local_mcp_unsupported_node_version') return 'Update Node.js to version 20 or newer, then run the setup command again.'
  if (install.error_code === 'local_mcp_runtime_install_failed') return 'The connector could not install Haven tools locally. Run the setup command again; it uses Haven-owned local storage.'
  if (install.error_code === 'codex_config_invalid') return 'Codex config needs a manual fix before Haven tools can be added.'
  if (install.error_code === 'claude_code_config_failed') return 'Claude Code did not accept the Haven tools entry. Run the setup command inside Claude Code again.'
  if (install.error_code?.startsWith('local_mcp_probe_')) return 'The connector installed Haven tools, but the local check could not load them yet. Run the setup command again.'
  if (install.error_code) return 'The connector stored credentials, but runtime setup needs a manual finish.'
  if (install.restart_required && install.local_mcp_configured && runtimeIsConfigured(install)) return 'After approval, restart the agent normally so it can load Haven tools.'
  if (install.restart_required && install.activation_command_available) return 'The connector prepared a restart command. Use it after approval so this agent can load Haven tools.'
  if (install.restart_required) return 'Restart the agent session after approval so it can load Haven tools.'
  if (runtimeIsConfigured(install)) return 'The agent environment reported Haven tools are configured.'
  if (install.credential_files_written) return 'The connector wrote local credentials. Add Haven to the runtime before using this agent.'
  return 'Use the command fallback or runtime settings to add Haven manually.'
}

function runtimeIsConfigured(install: AgentConnectionSetupStatusResponse['install_status']): boolean {
  if (!install) return false
  if (install.local_mcp_configured && install.local_mcp_acknowledged) return true
  return Boolean(install.hosted_mcp_configured && install.local_signer_configured)
}

function approvalBlockReason(
  gate: ReturnType<typeof useSafeOperationGate>,
  safeDetailsLoading: boolean,
  status: AgentConnectionSetupStatusResponse | null,
  publicClientReady: boolean,
  signerReady: boolean,
  wrongChain = false,
  approvalChainName = 'the required network',
): string | null {
  if (!status) return 'Haven is still loading local connection details.'
  if (!status.delegate_address) return 'Haven is waiting for the public signing address from the local connection.'
  if (safeDetailsLoading) return 'Haven is still loading wallet approval details.'
  if (!publicClientReady) return 'Haven is still connecting to the wallet network.'
  if (gate.kind === 'passkey_on_other_device') return 'Use the device with this Haven wallet passkey to approve agent rules.'
  // Wallet is connected but to the wrong chain — network mismatch, not a missing wallet.
  if (gate.kind === 'no_signer' && wrongChain) {
    return `Your wallet is connected to the wrong network. Switch to ${approvalChainName} to approve agent rules.`
  }
  if (gate.kind === 'no_signer') return 'Connect a wallet or use a passkey on this device to approve agent rules.'
  if (!signerReady) return 'Connect a wallet or use a passkey on this device to approve agent rules.'
  return null
}

async function recordWalletApproval(
  setupId: string,
  payload: {
    result: 'confirmed' | 'proposed'
    tx_hash?: string
    safe_tx_hash: string
    chain_id: number
    safe_address: string
    allowance_module_address: string
    delegate_address: string
    confirmation_status?: 'confirmed' | 'receipt_timeout'
  },
): Promise<AgentConnectionSetupStatusResponse> {
  return api.post<AgentConnectionSetupStatusResponse>(
    `/agent-connection-setups/${encodeURIComponent(setupId)}/wallet-approval`,
    payload,
  )
}

function approvalErrorMessage(err: unknown, signerType?: string): string {
  const message = errorMessage(err)
  if (/user rejected|user denied/i.test(message)) {
    return signerType === 'passkey'
      ? 'Face ID or Touch ID was cancelled.'
      : 'Wallet approval was cancelled.'
  }
  if (message.includes('would revert on-chain')) {
    return 'The wallet approval transaction would fail. Check the Haven wallet network and try again.'
  }
  if (message.includes('Could not verify the transaction')) {
    return 'Network error while preparing wallet approval. Check your connection and try again.'
  }
  return message
}

function errorMessage(err: unknown): string {
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

function generateBrowserAgentApiKey(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure browser crypto is unavailable.')
  }
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  return `sk_agent_${bytesToHex(bytes)}`
}

async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure browser crypto is unavailable.')
  }
  const data = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return bytesToHex(new Uint8Array(digest))
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function manualApiBaseUrl(connectorCommand?: string): string {
  const commandApiUrl = connectorApiBaseUrl(connectorCommand)
  if (commandApiUrl) return commandApiUrl
  const explicit = process.env.NEXT_PUBLIC_API_URL
  if (explicit) return explicit.replace(/\/+$/, '')
  const resolved = getResolvedApiBaseUrl()
  if (/^https?:\/\//.test(resolved)) return resolved.replace(/\/+$/, '')
  if (typeof window !== 'undefined') {
    const path = resolved.startsWith('/') ? resolved : `/${resolved}`
    return `${window.location.origin.replace(/\/+$/, '')}${path}`.replace(/\/+$/, '')
  }
  return resolved
}

function connectorApiBaseUrl(connectorCommand?: string): string | null {
  if (!connectorCommand) return null
  const match = connectorCommand.match(/(?:^|\s)--api(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/)
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value ? value.replace(/\\'/g, "'").replace(/\/+$/, '') : null
}

function buildManualCredentialPrompt(input: {
  agentName: string
  havenWallet: string
  budgets: string[]
  apiKey: string
  delegatePrivateKey: string
  delegateAddress: string
  apiBaseUrl: string
  hostedMcpUrl: string
}): string {
  return [
    `Manual Haven credential for ${input.agentName}`,
    '',
    `Haven wallet: ${input.havenWallet}`,
    `Agent budget: ${input.budgets.length > 0 ? input.budgets.join(', ') : 'No budget configured'}`,
    `Public signing address: ${input.delegateAddress}`,
    '',
    'Add these values only in the trusted agent workspace:',
    `HAVEN_API_KEY=${input.apiKey}`,
    `HAVEN_DELEGATE_KEY=${input.delegatePrivateKey}`,
    `HAVEN_DELEGATE_ADDRESS=${input.delegateAddress}`,
    `HAVEN_API_URL=${input.apiBaseUrl}`,
    `HAVEN_MCP_URL=${input.hostedMcpUrl}`,
    '',
    'Important:',
    '- The private signing key lets the agent sign payments within the approved agent budget.',
    '- The API key identifies the agent but cannot spend alone.',
    '- If this credential may have leaked, pause or revoke the agent in Haven.',
    '- Do not commit it, upload it, paste it into shared logs, or send it to Haven.',
    '',
    'After adding the values, return to Haven and approve the agent rules from the Haven wallet.',
  ].join('\n')
}
