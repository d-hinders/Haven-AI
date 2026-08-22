'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Address, parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useAccount, usePublicClient, useSwitchChain } from 'wagmi'
import {
  allowanceModuleFor,
  RESET_PERIODS,
  type AllowanceSetup,
} from '@/lib/allowance-module'
import { api, getResolvedApiBaseUrl } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'
import { useAuth, type UserSafe } from '@/context/AuthContext'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
import {
  useAgentConnectionSetupStatus,
  type AgentConnectionSetupStatusResponse,
} from '@/hooks/useAgentConnectionSetupStatus'
import { getChainConfig, getExplorerUrl, DEFAULT_CHAIN_ID, SUPPORTED_CHAIN_IDS } from '@/lib/chains'
import { formatAllowanceForToken } from '@/lib/allowance-format'
import { budgetPeriodLabel } from '@/lib/budget-period'
import { isIncompleteMoneyInput, validateMoneyInput } from '@/lib/money-input'
import { getChainTokens } from '@/lib/safe-tx'
import { executeAgentSetup } from '@/lib/agent-setup'
import { isSafeCapableSigner, useActiveSigner } from '@/lib/signer'

// ── Flow types ─────────────────────────────────────────────────────

export type SetupStep = 'details' | 'policy' | 'review' | 'connect'

export type CopyKind = 'prompt' | 'command' | 'manual'

export interface AllowanceEntry {
  tokenSymbol: string
  tokenAddress: Address | null
  decimals: number
  amount: string
  resetTimeMin: number
}

/**
 * Connection-setup wire shapes from the generated API types (#1445). The
 * hand-written copies pinned `status` to a single string literal each
 * (`'awaiting_connection'`, `'connected_local'`) where the spec models the
 * full `AgentConnectionSetupState` — narrower than the API, so a state the
 * backend can legitimately return would not have type-checked here.
 */
export type CreateSetupResponse = ApiSchema<'CreateAgentConnectionSetupResponse'>
type ResolveSetupResponse = ApiSchema<'ResolveAgentConnectionSetupResponse'>
type RegisterSetupResponse = ApiSchema<'RegisterAgentConnectionSetupResponse'>

export interface ManualCredential {
  prompt: string
  apiKey: string
  delegatePrivateKey: `0x${string}`
  delegateAddress: string
}

export interface UseAgentConnectionSetupOptions {
  open: boolean
  onClose: () => void
  safeAddress?: string
  safeId?: string | null
  /** See ConnectAgentModal's prop of the same name. */
  onSetupUpdated?: (info?: { delegateAddress?: string | null }) => void
  /** See ConnectAgentModal's prop of the same name. */
  starterAllowance?: boolean
}

// ── Rail awareness (#1069 / #1070) ─────────────────────────────────

/**
 * #1069: the wallet-approval step is the LEGACY rail's mechanism. A
 * delegation-rail account (Hybrid DeleGator, possibly passkey-only) has no
 * AllowanceModule and may have no connectable EOA — its approval is the
 * budget grant. The connect flow branches the final step on this.
 *
 * Extracted pure so the branch that broke live (#1070: the modal offered
 * "Connect wallet" to a passkey-owned account) is directly unit-testable.
 */
export function isDelegationRailAccount(
  selectedSafe: Pick<UserSafe, 'account_type'> | null | undefined,
  activeSafe: Pick<UserSafe, 'account_type'> | null | undefined,
): boolean {
  return (selectedSafe?.account_type ?? activeSafe?.account_type) === 'delegator_hybrid'
}

/**
 * #1073: on the delegation rail each budget is its own signature, so setup
 * takes exactly ONE. Three tokens would mean three consecutive passkey
 * prompts, and a failure on the second leaves a half-approved agent with no
 * sensible UI. Further tokens are added later from the agent page, one
 * deliberate signature at a time.
 *
 * A delegation budget also refills on a real period boundary; "One-time" (0)
 * has no delegation equivalent, so it is not offered on this rail.
 */
export function railBudgetRules(isDelegationAccount: boolean, allowanceCount: number): {
  budgetSlotsFull: boolean
  resetPeriodOptions: ReadonlyArray<(typeof RESET_PERIODS)[number]>
} {
  const budgetSlotsFull = isDelegationAccount && allowanceCount >= 1
  const resetPeriodOptions = isDelegationAccount
    ? RESET_PERIODS.filter((period) => period.value > 0)
    : RESET_PERIODS
  return { budgetSlotsFull, resetPeriodOptions }
}

export type ConnectStepView =
  | { kind: 'waiting_for_connector' }
  | { kind: 'finalizing_local' }
  | { kind: 'delegation_approval'; agentId: string }
  | { kind: 'legacy_approval' }
  | { kind: 'approval_in_progress' }
  | { kind: 'proposed' }
  | { kind: 'active' }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
  | { kind: 'failed' }
  | { kind: 'unknown_status' }
  | null

/**
 * Which body the connect step renders for the current setup status — including
 * the #1069/#1070 rail branch: when the setup is ready for approval, a
 * delegation account approves the budget in-modal (never the legacy Safe
 * wallet-approval, which dead-ends a passkey-only account), and the legacy
 * rail keeps the Safe transaction step.
 */
export function resolveConnectStepView({
  visibleStatus,
  installStatus,
  isDelegationAccount,
  agentId,
}: {
  visibleStatus: string | undefined
  installStatus: AgentConnectionSetupStatusResponse['install_status'] | undefined
  isDelegationAccount: boolean
  agentId: string | null | undefined
}): ConnectStepView {
  if (!visibleStatus) return null
  if (visibleStatus === 'awaiting_connection') return { kind: 'waiting_for_connector' }
  const runtimeConfigured = runtimeIsConfigured(installStatus)
  const installErrored = Boolean(installStatus?.error_code)
  if (visibleStatus === 'connected_local' && !runtimeConfigured && !installErrored) {
    return { kind: 'finalizing_local' }
  }
  const approvalReady =
    (visibleStatus === 'connected_local' && (runtimeConfigured || installErrored)) ||
    visibleStatus === 'awaiting_wallet_approval'
  if (approvalReady) {
    if (isDelegationAccount) {
      // agent_id lands with the register step; polling is a beat behind at
      // most. Never route the user away for it.
      return agentId ? { kind: 'delegation_approval', agentId } : { kind: 'finalizing_local' }
    }
    return { kind: 'legacy_approval' }
  }
  switch (visibleStatus) {
    case 'approval_in_progress':
      return { kind: 'approval_in_progress' }
    case 'proposed':
      return { kind: 'proposed' }
    case 'active':
      return { kind: 'active' }
    case 'expired':
      return { kind: 'expired' }
    case 'cancelled':
      return { kind: 'cancelled' }
    case 'failed':
      return { kind: 'failed' }
    default:
      return { kind: 'unknown_status' }
  }
}

// ── Pure status helpers ────────────────────────────────────────────

export function headerSubtitle(step: SetupStep, status: string | undefined, runtimeConfigured?: boolean): string {
  if (step === 'connect') {
    if (status === 'connected_local' && !runtimeConfigured) return 'Finishing local setup'
    if (status === 'connected_local' || status === 'awaiting_wallet_approval') return 'Approve the agent budget'
    if (status === 'approval_in_progress' || status === 'proposed') return 'Waiting for approval to land'
    // #1394: NOT "Agent rules approved" — the shell ticker already reads
    // "Approved" and the body names the granted authority. Three statements of
    // one fact in one viewport made none of them authoritative. The subtitle's
    // job across this flow is to say what to DO, so here it orients the user in
    // the ending rather than restating the status.
    if (status === 'active') return 'What your agent can do now'
    if (status === 'expired') return 'This setup prompt expired'
    if (status === 'cancelled') return 'This setup was cancelled'
    return 'Paste the setup prompt into your agent environment'
  }
  // #1720: no longer "choose where it runs" — there is nothing to choose.
  // A subtitle that names an action the step does not offer is worse than a
  // vague one, and this was the last place the removed picker still spoke.
  if (step === 'details') return 'Name the agent and describe what it does'
  if (step === 'policy') return 'Set agent budget and approval boundaries'
  return 'Review before creating the local setup prompt'
}

// `install_status` is required on the status response, but callers hold it as
// `setupStatus?.install_status` — hence the explicit `| undefined`. The body
// already guarded for it; only the type was pretending otherwise (#1445).
export function runtimeIsConfigured(
  install: AgentConnectionSetupStatusResponse['install_status'] | undefined,
): boolean {
  if (!install) return false
  if (install.local_mcp_configured && install.local_mcp_acknowledged) return true
  return Boolean(install.hosted_mcp_configured && install.local_signer_configured)
}

export function approvalBlockReason(
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
  if (gate.kind === 'passkey_on_other_device') return 'Use the device with this Haven wallet passkey to approve the agent budget.'
  // Wallet is connected but to the wrong chain — network mismatch, not a missing wallet.
  if (gate.kind === 'no_signer' && wrongChain) {
    return `Your wallet is connected to the wrong network. Switch to ${approvalChainName} to approve the agent budget.`
  }
  if (gate.kind === 'no_signer') return 'Connect a wallet or use a passkey on this device to approve the agent budget.'
  if (!signerReady) return 'Connect a wallet or use a passkey on this device to approve the agent budget.'
  return null
}

export function approvalErrorMessage(err: unknown, signerType?: string): string {
  const message = errorMessage(err)
  if (/user rejected|user denied/i.test(message)) {
    return signerType === 'passkey'
      ? 'The passkey prompt was cancelled.'
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

export function errorMessage(err: unknown): string {
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

// ── Manual credential helpers ──────────────────────────────────────

export function generateBrowserAgentApiKey(): string {
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

export function manualApiBaseUrl(connectorCommand?: string): string {
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

export function connectorApiBaseUrl(connectorCommand?: string): string | null {
  if (!connectorCommand) return null
  const match = connectorCommand.match(/(?:^|\s)--api(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/)
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value ? value.replace(/\\'/g, "'").replace(/\/+$/, '') : null
}

export function buildManualCredentialPrompt(input: {
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
    'After adding the values, return to Haven and approve the budget from the Haven wallet.',
  ].join('\n')
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

// ── The flow hook ──────────────────────────────────────────────────

/**
 * State machine + async orchestration for the connect-agent flow (#989).
 *
 * Everything ConnectAgentModal decides lives here; the modal itself is
 * composition/layout only. Flow logic is therefore testable without
 * rendering the modal — the two live defects this extraction answers
 * (#1069/#1070) were both flow-logic bugs invisible to render-level tests.
 */
export function useAgentConnectionSetup({
  open,
  onClose,
  safeAddress: propSafeAddress,
  safeId: propSafeId,
  onSetupUpdated,
  starterAllowance = false,
}: UseAgentConnectionSetupOptions) {
  const { user, activeSafe } = useAuth()
  const userSafes = useMemo(() => user?.safes ?? [], [user?.safes])

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
  const [localMcp, setLocalMcp] = useState(false)
  const [issuePassport, setIssuePassport] = useState(false)
  const [allowances, setAllowances] = useState<AllowanceEntry[]>([])
  const [addAmount, setAddAmount] = useState('')
  const [addAmountError, setAddAmountError] = useState('')
  const [addReset, setAddReset] = useState(1440)
  const [setup, setSetup] = useState<CreateSetupResponse | null>(null)
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [copied, setCopied] = useState<CopyKind | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [manualPathRevealed, setManualPathRevealed] = useState(false)
  const [manualFallbackConfirmed, setManualFallbackConfirmed] = useState(false)
  const [manualCredential, setManualCredential] = useState<ManualCredential | null>(null)
  const [manualCredentialAcknowledged, setManualCredentialAcknowledged] = useState(false)
  const [manualCreating, setManualCreating] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)

  const selectedSafe = userSafes.find((safe) => safe.id === selectedSafeId) ?? null
  const safeAddress = selectedSafe?.safe_address ?? propSafeAddress ?? ''
  const safeId = selectedSafe?.id ?? propSafeId ?? null
  const chainId = selectedSafe?.chain_id ?? activeSafe?.chain_id ?? DEFAULT_CHAIN_ID
  // #1069: branch the final step on the account's rail — see
  // isDelegationRailAccount.
  const isDelegationAccount = isDelegationRailAccount(selectedSafe, activeSafe)
  const walletName = selectedSafe?.name ?? activeSafe?.name ?? 'Selected Haven wallet'
  const walletNetworkName = getChainConfig(chainId).name
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
  const activeSigner = useActiveSigner({
    safeAddress: approvalSafeAddress ? (approvalSafeAddress as Address) : undefined,
    chainId: approvalChainId,
  })
  // #1079: this surface signs SAFE transactions; a delegator_passkey cannot.
  // The narrowed view keeps every downstream call type-honest — on delegation
  // accounts these controls are hidden, so null here renders the same
  // no-signer state as before.
  const signer = isSafeCapableSigner(activeSigner) ? activeSigner : null

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
  const prevOpenRef = useRef(false)

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setSelectedSafeId(initialSafeIdRef.current)
    }
    prevOpenRef.current = open
  }, [open])

  useEffect(() => {
    if (!open) return
    const validSymbols = new Set(tokenOptions.map((token) => token.symbol))
    setAllowances((prev) => prev.filter((allowance) => validSymbols.has(allowance.tokenSymbol)))
  }, [open, tokenOptions])

  // #1377 B: the flow takes exactly ONE budget, in USDC — the token select and
  // the add-then-continue two-step are gone. The pinned token:
  const budgetToken =
    tokenOptions.find((token) => token.symbol === 'USDC') ??
    tokenOptions.find((token) => token.symbol === 'USDC.e') ??
    tokenOptions[0]

  // The draft budget derives LIVE from the amount/reset inputs. `allowances`
  // stays the single source handleCreateSetup maps to the wire (via the same
  // validateMoneyInput -> parsed.amount value the old Add-button path stored),
  // so the setup payload is byte-identical to the add-then-continue flow.
  useEffect(() => {
    if (!budgetToken) return
    const parsed = addAmount
      ? validateMoneyInput(addAmount, budgetToken.decimals, { tokenSymbol: budgetToken.symbol })
      : null
    setAllowances(
      parsed?.ok
        ? [{
            tokenSymbol: budgetToken.symbol,
            tokenAddress: budgetToken.address,
            decimals: budgetToken.decimals,
            amount: parsed.amount,
            resetTimeMin: addReset,
          }]
        : [],
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- budgetToken is
    // recreated per render; its identity is fully captured by these scalars.
  }, [addAmount, addReset, budgetToken?.symbol, budgetToken?.address, budgetToken?.decimals])

  // First-agent hand-off: seed a starter budget so the policy step is
  // payment-ready by default. Only when the form is empty — user edits win.
  useEffect(() => {
    if (!open || !starterAllowance || !budgetToken) return
    setAddAmount((prev) => (prev === '' ? '10' : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, starterAllowance, budgetToken?.symbol])

  const resetForm = useCallback(() => {
    setStep('details')
    setName('')
    setDescription('')
    setLocalMcp(false)
    setIssuePassport(false)
    setAllowances([])
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
    setManualPathRevealed(false)
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

  const hasMultipleSafes = userSafes.length > 1
  const setupSteps: SetupStep[] = ['details', 'policy', 'review', 'connect']
  const currentStepIndex = setupSteps.indexOf(step)
  const { resetPeriodOptions } = railBudgetRules(isDelegationAccount, allowances.length)
  const addAmountValidation =
    addAmount && budgetToken
      ? validateMoneyInput(addAmount, budgetToken.decimals, { tokenSymbol: budgetToken.symbol })
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
        local_mcp: localMcp ? true : undefined,
        allowances: allowances.map((allowance) => ({
          token_address:
            allowance.tokenAddress ?? '0x0000000000000000000000000000000000000000',
          token_symbol: allowance.tokenSymbol,
          allowance_amount: parseUnits(allowance.amount, allowance.decimals).toString(),
          reset_period_min: allowance.resetTimeMin,
        })),
        issue_passport: issuePassport || undefined,
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

  function handleAddAmountChange(value: string) {
    if (/^\d*\.?\d*$/.test(value)) {
      setAddAmount(value)
      setAddAmountError('')
    }
  }

  async function copyText(kind: CopyKind, value: string) {
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
        allowance_module_address: allowanceModuleFor(approvalNetwork),
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

  async function handleDelegationApproved() {
    if (!setupStatus) return
    await statusQuery.refetch()
    onSetupUpdated?.({ delegateAddress: setupStatus.delegate_address ?? null })
  }

  async function handleCreateManualCredential() {
    if (!setup || !manualFallbackConfirmed) return
    setManualCreating(true)
    setManualError(null)
    try {
      const resolved = await api.post<ResolveSetupResponse>('/agent-connection-setups/resolve', {
        setup_token: setup.setup_token,
        connector_version: 'browser-manual-fallback',
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

  function switchToApprovalChain() {
    switchChain({ chainId: approvalChainId })
  }

  function restartFromReview(options?: { clearCancelled?: boolean }) {
    setSetup(null)
    if (options?.clearCancelled) setCancelled(false)
    setStep('review')
  }

  return {
    // Shell
    step,
    setStep,
    setupStepCount: setupSteps.length,
    currentStepIndex,
    headerSubtitleText: headerSubtitle(step, visibleStatus, runtimeIsConfigured(setupStatus?.install_status)),
    busy: creating || approving || manualCreating,
    handleClose,
    // Details step
    name,
    setName,
    description,
    setDescription,
    localMcp,
    setLocalMcp,
    // Wallet selection
    hasMultipleSafes,
    selectableSafes,
    selectedSafeId,
    setSelectedSafeId,
    walletName,
    walletNetworkName,
    walletUnavailable,
    // Policy step
    allowances,
    resetPeriodOptions,
    addAmount,
    addAmountMessage,
    addAmountValidation,
    budgetToken,
    addReset,
    setAddReset,
    issuePassport,
    setIssuePassport,
    handleAddAmountChange,
    // Review step
    creating,
    createError,
    handleCreateSetup,
    // Rail awareness (#1069/#1070)
    isDelegationAccount,
    // Connect step
    setup,
    setupStatus,
    statusLoading: statusQuery.loading,
    statusError: statusQuery.error,
    awaitingConnectionStage: statusQuery.awaitingConnectionStage,
    visibleStatus,
    connectView: resolveConnectStepView({
      visibleStatus,
      installStatus: setupStatus?.install_status,
      isDelegationAccount,
      agentId: setupStatus?.agent_id ?? null,
    }),
    copied,
    copyText,
    manualPathRevealed,
    setManualPathRevealed,
    manualFallbackConfirmed,
    setManualFallbackConfirmed,
    manualCredential,
    manualCredentialAcknowledged,
    manualCreating,
    manualError,
    handleCreateManualCredential,
    handleContinueAfterManualCredential,
    handleCancelSetup,
    restartFromReview,
    // Approval (legacy rail)
    approvalWalletLabel,
    approvalChainId,
    safeDetailsLoading,
    safeThreshold: safeDetails?.threshold ?? 1,
    safeOwnerCount: safeDetails?.owners?.length ?? 1,
    operationGate,
    publicClientReady: Boolean(publicClient),
    signerReady: Boolean(signer),
    approving,
    approvalError,
    handleApproveAgentRules,
    // Approval (delegation rail)
    handleDelegationApproved,
    // Wrong-chain recovery (#1070)
    isWrongChain,
    approvalChainName,
    switchToApprovalChain,
    isSwitchingChain,
  }
}

export type AgentConnectionSetupFlow = ReturnType<typeof useAgentConnectionSetup>
