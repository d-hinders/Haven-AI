'use client'

import { useMemo, useState, useCallback, type ReactNode } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useApprovals, type ApprovalRequest } from '@/hooks/useApprovals'
import { useSafeOperationGate, type SafeOperationGate } from '@/hooks/useSafeOperationGate'
import {
  getSafeNonce,
  buildSafeTx,
  signSafeTx,
  executeSafeTx,
  proposeSafeTx,
  getSafeTxHash,
  getChainTokens,
  type SendParams,
} from '@/lib/safe-tx'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import { timeAgo, timeUntil } from '@/lib/format'
import { useActiveSigner } from '@/lib/signer'
import {
  approvalRecipientLabel,
  approvalSourceLabel,
} from '@/lib/approval-labels'
import {
  approvalStatusPresentation,
  isActionableApprovalStatus,
} from '@/lib/payment-status'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import OnchainActionGate from './OnchainActionGate'
import PasskeyOtherDeviceNotice from './PasskeyOtherDeviceNotice'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tooltip } from '@/components/ui/Tooltip'
import {
  ExternalDetailsLink,
  TransactionMovement,
} from '@/components/haven'

function resolveTokenSymbol(address: string, chainId: number): string {
  const lower = address.toLowerCase()
  const tokens = getChainTokens(chainId)
  if (lower === '0x0000000000000000000000000000000000000000') {
    return Object.entries(tokens).find(([, cfg]) => cfg.address === null)?.[0] ?? 'Native'
  }
  for (const [symbol, cfg] of Object.entries(tokens)) {
    if (cfg.address && cfg.address.toLowerCase() === lower) return symbol
  }
  return 'Unknown'
}

function ApprovalDetail({
  label,
  value,
}: {
  label: string
  value: ReactNode
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-[var(--v2-ink-3)]">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium text-[var(--v2-ink)]">{value}</dd>
    </div>
  )
}

function ApprovalCard({
  approval,
  walletName,
  networkName,
  onApproveAndExecute,
  onReject,
  executing,
  approvalDetailsLoading = false,
  requiresAdditionalApproval = false,
  executionDisabled = false,
  disabledReason,
  showOtherDeviceNotice = false,
  operationGate,
  actionError,
}: {
  approval: ApprovalRequest
  walletName: string
  networkName: string
  onApproveAndExecute: () => void
  onReject: (id: string) => void
  executing: boolean
  approvalDetailsLoading?: boolean
  requiresAdditionalApproval?: boolean
  executionDisabled?: boolean
  disabledReason?: string
  showOtherDeviceNotice?: boolean
  operationGate: SafeOperationGate
  actionError?: string | null
}) {
  const actionable = isActionableApprovalStatus(approval.status)
  const status = approvalStatusPresentation(approval.status)
  const [confirmReject, setConfirmReject] = useState(false)
  const [disclosureOpen, setDisclosureOpen] = useState(false)
  const toggleDisclosure = useCallback(() => setDisclosureOpen((v) => !v), [])
  const isX402 = approval.source === 'x402'
  // For x402, prefer merchant_address (the actual recipient) in the resource-URL label.
  // approvalRecipientLabel already resolves hostname-from-URL; we just make sure the
  // address tooltip shows the merchant, not the funding leg address (to_address).
  const x402ResourceUrl = approval.payment_resource_url ?? approval.x402_resource_url
  const recipient = approvalRecipientLabel({
    reason: approval.reason,
    source: approval.source,
    x402ResourceUrl,
    toAddress: isX402 && approval.merchant_address ? approval.merchant_address : approval.to_address,
  })
  // Tooltip address for the Merchant/Recipient detail: prefer merchant_address for x402
  const recipientTooltipAddress =
    isX402 && approval.merchant_address ? approval.merchant_address : approval.to_address
  const sourceLabel = approvalSourceLabel({
    reason: approval.reason,
    source: approval.source,
  })
  const actionLabel = approvalDetailsLoading
    ? 'Review payment'
    : requiresAdditionalApproval
    ? approval.status === 'approved'
      ? 'Submit for approval'
      : 'Approve and submit'
    : approval.status === 'approved'
      ? 'Complete payment'
      : 'Approve payment'
  const merchantLabel = isX402
    ? approvalRecipientLabel({
        reason: approval.reason,
        source: approval.source,
        x402ResourceUrl,
        toAddress: approval.merchant_address ?? approval.to_address,
      })
    : null
  // Only name the merchant in headline copy when we have something readable
  // (a hostname). For an address-only label, dropping the name reads better
  // than embedding a raw 0x... mid-sentence — the recipient detail row still
  // shows the address.
  const hasNamedMerchant = isX402 && merchantLabel && !merchantLabel.startsWith('0x')
  const requestCopy =
    approval.status === 'approved'
      ? hasNamedMerchant
        ? `Approval saved. Complete the payment so ${approval.agent_name} can pay ${merchantLabel}.`
        : `${approval.agent_name} asked to send this payment. It is approved, but has not been sent yet.`
      : hasNamedMerchant
        ? `${approval.agent_name} wants to pay ${merchantLabel}. Nothing moves until you approve it.`
        : `${approval.agent_name} asked to send this payment. Nothing moves until you approve it.`
  // Show "Where does the money go?" only for x402 rows that have a merchant_address
  const showDisclosure = isX402 && Boolean(approval.merchant_address)
  return (
    <Card
      as="article"
      hover={false}
      className={`overflow-hidden ${actionable ? 'border-[var(--v2-warning)]/25' : ''}`}
    >
      <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              {sourceLabel ? <StatusBadge tone="neutral">{sourceLabel}</StatusBadge> : null}
            </div>
            <p
              className="mt-2 text-xs text-[var(--v2-ink-3)]"
              title={new Date(approval.created_at).toLocaleString()}
            >
              Requested {timeAgo(approval.created_at)}
            </p>
          </div>
          {actionable ? (
            <p className="text-xs text-[var(--v2-ink-3)]">
              Expires {timeUntil(approval.expires_at)}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-5 p-5">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.9fr)] lg:items-start">
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--v2-ink-3)]">Payment request</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
              {approval.amount_human} {approval.token_symbol}
            </p>
            <p className="mt-3 text-sm text-[var(--v2-ink-2)]">
              {requestCopy}
            </p>
          </div>

          {/*
            Sidebar details panel — tinted background only, no border. The
            border-+-grey-+-rounded combo read as a nested card; the bg-surface
            alone is enough to differentiate it from the parent card body.
          */}
          <div className="rounded-[10px] bg-[var(--v2-surface)] p-4">
            <TransactionMovement from={walletName} to={recipient} />
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <ApprovalDetail label="Agent" value={approval.agent_name} />
              <ApprovalDetail label="Network" value={networkName} />
              <ApprovalDetail label="Haven wallet" value={walletName} />
              <ApprovalDetail
                label={sourceLabel ? 'Merchant' : 'Recipient'}
                value={
                  <Tooltip label={recipientTooltipAddress} mono>
                    <span>{recipient}</span>
                  </Tooltip>
                }
              />
            </dl>
          </div>
        </div>

        {showDisclosure ? (
          <Card.Section className="pt-3 pb-3">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 focus-visible:ring-offset-1 rounded-sm"
              aria-expanded={disclosureOpen}
              onClick={toggleDisclosure}
            >
              <svg
                className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${disclosureOpen ? 'rotate-90' : ''}`}
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Where does the money go?
            </button>
            {disclosureOpen ? (
              <div className="mt-3 space-y-3">
                <p className="text-xs text-[var(--v2-ink-2)] leading-relaxed">
                  When you approve, your Haven wallet transfers{' '}
                  <span className="v2-tabular font-medium text-[var(--v2-ink)]">
                    {approval.amount_human} {approval.token_symbol}
                  </span>{' '}
                  to this agent&apos;s own spending wallet. The agent then pays{' '}
                  <span className="font-medium text-[var(--v2-ink)]">{merchantLabel}</span>{' '}
                  directly. The agent only gets to spend within the budget you set — it never
                  has access to your Haven wallet.
                </p>
                <div className="space-y-1.5">
                  <p className="text-xs text-[var(--v2-ink-3)]">
                    Agent spending wallet:{' '}
                    <a
                      href={getExplorerUrl(approval.chain_id, 'address', approval.to_address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="v2-tabular font-medium text-[var(--v2-brand)] hover:underline"
                    >
                      {approval.to_address.slice(0, 6)}&hellip;{approval.to_address.slice(-4)}{' '}
                      <span aria-hidden="true">↗</span>
                    </a>
                  </p>
                  <p className="text-xs text-[var(--v2-ink-3)]">
                    Merchant:{' '}
                    <a
                      href={getExplorerUrl(approval.chain_id, 'address', approval.merchant_address!)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="v2-tabular font-medium text-[var(--v2-brand)] hover:underline"
                    >
                      {approval.merchant_address!.slice(0, 6)}&hellip;{approval.merchant_address!.slice(-4)}{' '}
                      <span aria-hidden="true">↗</span>
                    </a>
                  </p>
                </div>
              </div>
            ) : null}
          </Card.Section>
        ) : null}

        {showOtherDeviceNotice ? <PasskeyOtherDeviceNotice /> : null}

        {actionError ? (
          <div className="rounded-[10px] border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-sm text-[var(--v2-danger)]">
            {actionError}
          </div>
        ) : null}

        {approval.tx_hash ? (
          <div className="flex items-center justify-between rounded-[10px] border border-[var(--v2-border)] bg-white px-3 py-2">
            <span className="text-xs text-[var(--v2-ink-3)]">Payment receipt</span>
            <ExternalDetailsLink
              href={getExplorerUrl(approval.chain_id, 'tx', approval.tx_hash)}
              label="Open payment externally"
            />
          </div>
        ) : null}

        {actionable ? (
          <div className="space-y-3">
            {confirmReject ? (
              <div className="rounded-[10px] border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <p className="flex-1 text-sm text-[var(--v2-danger)]">
                    Reject this payment? The agent will need to request it again.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={executing}
                      onClick={() => {
                        onReject(approval.id)
                        setConfirmReject(false)
                      }}
                    >
                      Reject payment
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={executing}
                      onClick={() => setConfirmReject(false)}
                    >
                      Keep request
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={executing}
                  onClick={() => setConfirmReject(true)}
                >
                  Reject
                </Button>
                <OnchainActionGate
                  requiredChainId={approval.chain_id}
                  operationGate={operationGate}
                  noSignerMessage="Connect a wallet to approve this payment."
                  showNotice={false}
                >
                  {({ disabled }) => (
                  <Button
                    size="sm"
                    disabled={disabled || executing || executionDisabled}
                    onClick={onApproveAndExecute}
                    className="w-full sm:w-auto"
                  >
                    {executing
                      ? requiresAdditionalApproval
                        ? 'Submitting...'
                        : approval.status === 'approved'
                          ? 'Completing...'
                          : 'Approving...'
                      : actionLabel}
                  </Button>
                  )}
                </OnchainActionGate>
              </div>
            )}
            {executionDisabled && disabledReason ? (
              <p className="text-right text-xs text-[var(--v2-ink-3)]">{disabledReason}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  )
}

function ApprovalCardWithContext({
  approval,
  executingApprovalId,
  setExecutingApprovalId,
  approve,
  reject,
  markProposed,
  markExecuted,
  refetch,
}: {
  approval: ApprovalRequest
  executingApprovalId: string | null
  setExecutingApprovalId: (id: string | null) => void
  approve: (id: string) => Promise<unknown>
  reject: (id: string) => Promise<void>
  markProposed: (id: string) => Promise<void>
  markExecuted: (id: string, txHash: string) => Promise<void>
  refetch: () => Promise<void>
}) {
  const { user } = useAuth()
  const safe = useMemo(
    () =>
      user?.safes.find(
        (item) =>
          item.safe_address.toLowerCase() === approval.safe_address.toLowerCase() &&
          item.chain_id === approval.chain_id,
      ) ?? null,
    [approval.chain_id, approval.safe_address, user?.safes],
  )
  const safeAddress = (safe?.safe_address ?? approval.safe_address) as Address
  const chainId = approval.chain_id
  const walletName = safe?.name ?? 'Haven wallet'
  let networkName = `Chain ${chainId}`
  try {
    networkName = getChainConfig(chainId).name
  } catch {
    // Keep the approval actionable even if a new chain label has not landed yet.
  }
  const { details: safeDetails } = useSafeDetails(safeAddress, { chainId })
  const publicClient = usePublicClient({ chainId })
  const signer = useActiveSigner({
    safeAddress,
    chainId,
  })
  const operationGate = useSafeOperationGate({
    safeAddress,
    chainId,
  })
  const passkeyOnOtherDevice = operationGate.kind === 'passkey_on_other_device'
  const executionDisabled = passkeyOnOtherDevice || !publicClient || !signer || !safeDetails
  const disabledReason = passkeyOnOtherDevice
    ? 'Use the device with this Haven account passkey to approve.'
    : !signer
      ? 'Connect your approval method to continue.'
      : !safeDetails
        ? 'Account details are still loading.'
        : undefined
  const executing = executingApprovalId === approval.id
  const [actionError, setActionError] = useState<string | null>(null)
  const requiresAdditionalApproval = (safeDetails?.threshold ?? 1) > 1
  const approvalDetailsLoading = !safeDetails

  async function handleApproveAndExecute() {
    if (executionDisabled || !publicClient || !signer || !safeDetails) return

    setExecutingApprovalId(approval.id)
    setActionError(null)
    let approvalSaved = approval.status === 'approved'
    try {
      if (approval.status !== 'approved') {
        await approve(approval.id)
        approvalSaved = true
      }

      const chainTokens = getChainTokens(chainId)
      const tokenSymbol = resolveTokenSymbol(approval.token_address, chainId)
      const tokenConfig = chainTokens[tokenSymbol]
      if (!tokenConfig) throw new Error(`Unknown token: ${approval.token_symbol}`)

      const sendParams: SendParams = {
        token: tokenSymbol,
        tokenAddress: tokenConfig.address as Address | null,
        decimals: tokenConfig.decimals,
        amount: approval.amount_human,
        recipient: approval.to_address as Address,
      }

      const nonce = await getSafeNonce(publicClient, safeAddress)
      const safeTx = buildSafeTx(sendParams, nonce)
      const signature = await signSafeTx(
        signer,
        safeAddress,
        safeTx,
        chainId,
      )

      const threshold = safeDetails.threshold ?? 1
      let txHash: string | undefined

      if (threshold <= 1) {
        const result = await executeSafeTx(
          signer,
          publicClient,
          safeAddress,
          safeTx,
          signature,
          chainId,
        )
        txHash = result.txHash
      } else {
        const safeTxHash = getSafeTxHash(safeAddress, safeTx, chainId)
        await proposeSafeTx(
          safeAddress,
          safeTx,
          safeTxHash,
          signature,
          signer.address,
          chainId,
        )
        await markProposed(approval.id)
      }

      if (txHash) {
        await markExecuted(approval.id, txHash)
      }

      await refetch()
    } catch (err) {
      if (err instanceof Error && (err.message.includes('rejected') || err.message.includes('denied'))) {
        setActionError(
          approvalSaved
            ? 'Approval saved, but the payment was not sent. You can complete it from this queue.'
            : 'Approval was cancelled. The request is still waiting for your review.',
        )
      } else {
        setActionError(
          approvalSaved
            ? 'Approval saved, but the payment was not sent. Check your wallet or try again.'
            : 'Could not complete the approval. Check your wallet or try again.',
        )
        console.error('Approval execution failed:', err)
      }
      await refetch()
    } finally {
      setExecutingApprovalId(null)
    }
  }

  async function handleReject(id: string) {
    setActionError(null)
    try {
      await reject(id)
    } catch (err) {
      setActionError('Could not reject this request. Try again.')
      console.error('Reject failed:', err)
    }
  }

  return (
    <ApprovalCard
      approval={approval}
      walletName={walletName}
      networkName={networkName}
      onApproveAndExecute={handleApproveAndExecute}
      onReject={handleReject}
      executing={executing}
      approvalDetailsLoading={approvalDetailsLoading}
      requiresAdditionalApproval={requiresAdditionalApproval}
      executionDisabled={executionDisabled}
      disabledReason={disabledReason}
      showOtherDeviceNotice={passkeyOnOtherDevice}
      operationGate={operationGate}
      actionError={actionError}
    />
  )
}

function ApprovalHistoryRow({ approval }: { approval: ApprovalRequest }) {
  const status = approvalStatusPresentation(approval.status)
  const isExecutedX402 = approval.source === 'x402' && approval.status === 'executed'
  const isX402 = approval.source === 'x402'
  const x402ResourceUrl = approval.payment_resource_url ?? approval.x402_resource_url
  const recipient = approvalRecipientLabel({
    reason: approval.reason,
    source: approval.source,
    x402ResourceUrl,
    toAddress: isX402 && approval.merchant_address ? approval.merchant_address : approval.to_address,
  })
  const historyTooltipAddress =
    isX402 && approval.merchant_address ? approval.merchant_address : approval.to_address

  return (
    <div className="grid gap-3 border-b border-[var(--v2-border)] px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          <p className="truncate text-sm font-medium text-[var(--v2-ink)]">
            <span className="v2-tabular">{approval.amount_human}</span> {approval.token_symbol}
          </p>
        </div>
        <p className="mt-1 text-xs text-[var(--v2-ink-2)]">
          {approval.agent_name} to{' '}
          <Tooltip label={historyTooltipAddress} mono>
            <span>{recipient}</span>
          </Tooltip>
        </p>
        {isExecutedX402 ? (
          <p className="mt-1 text-xs text-[var(--v2-ink-2)]">
            Return to your agent and ask it to retry the original x402 request.
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 sm:justify-end">
        <span
          className="text-xs text-[var(--v2-ink-3)]"
          title={new Date(approval.created_at).toLocaleString()}
        >
          {timeAgo(approval.created_at)}
        </span>
        {approval.tx_hash ? (
          <ExternalDetailsLink
            href={getExplorerUrl(approval.chain_id, 'tx', approval.tx_hash)}
            label="Open payment externally"
          />
        ) : null}
      </div>
    </div>
  )
}

function ApprovalSkeleton() {
  return (
    <Card hover={false} className="p-5">
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-28 rounded-full" />
        <Skeleton variant="text" className="h-3 w-20" />
      </div>
      <Skeleton className="mt-5 h-8 w-44" />
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-16 rounded-[10px] bg-[var(--v2-surface)]" />
        <Skeleton className="h-16 rounded-[10px] bg-[var(--v2-surface)]" />
      </div>
    </Card>
  )
}

export default function ApprovalQueue() {
  const {
    approvals,
    loading,
    error,
    approve,
    reject,
    markProposed,
    markExecuted,
    refetch,
  } = useApprovals()
  const [executingApprovalId, setExecutingApprovalId] = useState<string | null>(null)

  const actionableApprovals = approvals.filter((approval) => isActionableApprovalStatus(approval.status))
  const pastApprovals = approvals.filter((approval) => !isActionableApprovalStatus(approval.status))

  if (loading) {
    return (
      <div role="status" aria-busy="true" aria-live="polite" aria-label="Loading approvals" className="space-y-3">
        {[0, 1].map((index) => (
          <ApprovalSkeleton key={index} />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        title="Could not load approvals"
        body={error}
        action={<Button variant="ghost" size="sm" onClick={() => void refetch()}>Try again</Button>}
      />
    )
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Needs review</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-2)]">
              Payments above an agent budget wait here until you approve, complete, or reject them.
            </p>
          </div>
          {actionableApprovals.length > 0 ? (
            <StatusBadge tone="warning">
              <span className="v2-tabular">{actionableApprovals.length}</span> waiting
            </StatusBadge>
          ) : null}
        </div>

        {actionableApprovals.length === 0 ? (
          <EmptyState
            title="No payments need approval"
            body="When an agent asks to spend above its budget, the request will appear here before any money moves."
          />
        ) : (
          <div className="space-y-4">
            {actionableApprovals.map((approval) => (
              <ApprovalCardWithContext
                key={approval.id}
                approval={approval}
                executingApprovalId={executingApprovalId}
                setExecutingApprovalId={setExecutingApprovalId}
                approve={approve}
                reject={reject}
                markProposed={markProposed}
                markExecuted={markExecuted}
                refetch={refetch}
              />
            ))}
          </div>
        )}
      </section>

      {pastApprovals.length > 0 ? (
        <section>
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Recent decisions</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-2)]">
              Submitted, rejected, expired, and sent payment requests.
            </p>
          </div>
          <Card hover={false} className="overflow-hidden">
            {pastApprovals.slice(0, 10).map((approval) => (
              <ApprovalHistoryRow key={approval.id} approval={approval} />
            ))}
          </Card>
        </section>
      ) : null}
    </div>
  )
}
