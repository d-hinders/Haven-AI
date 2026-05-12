'use client'

import { useMemo, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useApprovals, type ApprovalRequest } from '@/hooks/useApprovals'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
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
  approvalReasonLabel,
  approvalRecipientLabel,
  approvalSourceLabel,
} from '@/lib/approval-labels'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import NetworkGate from './NetworkGate'
import PasskeyOtherDeviceNotice from './PasskeyOtherDeviceNotice'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatusBadge } from '@/components/ui/StatusBadge'
import {
  ApprovalRequiredBanner,
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

function statusLabel(status: string): string {
  if (status === 'pending') return 'Needs approval'
  if (status === 'approved') return 'Approved'
  if (status === 'proposed') return 'Submitted'
  if (status === 'rejected') return 'Rejected'
  if (status === 'executed') return 'Sent'
  if (status === 'expired') return 'Expired'
  return status
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' | 'brand' {
  if (status === 'pending') return 'warning'
  if (status === 'approved') return 'brand'
  if (status === 'proposed') return 'brand'
  if (status === 'rejected') return 'danger'
  if (status === 'executed') return 'success'
  return 'neutral'
}

function isActionableStatus(status: string): boolean {
  return status === 'pending' || status === 'approved'
}

function ApprovalDetail({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium text-[var(--v2-ink-3)]">{label}</dt>
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
  actionError?: string | null
}) {
  const actionable = isActionableStatus(approval.status)
  const [confirmReject, setConfirmReject] = useState(false)
  const recipient = approvalRecipientLabel({
    reason: approval.reason,
    source: approval.source,
    x402ResourceUrl: approval.x402_resource_url,
    toAddress: approval.to_address,
  })
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
  const requestCopy =
    approval.status === 'approved'
      ? `${approval.agent_name} asked to send this payment. It is approved, but has not been sent yet.`
      : `${approval.agent_name} asked to send this payment. Nothing moves until you approve it.`

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
              <StatusBadge tone={statusTone(approval.status)}>{statusLabel(approval.status)}</StatusBadge>
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

          <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
            <TransactionMovement from={walletName} to={recipient} />
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <ApprovalDetail label="Agent" value={approval.agent_name} />
              <ApprovalDetail label="Network" value={networkName} />
              <ApprovalDetail label="Haven wallet" value={walletName} />
              <ApprovalDetail label={sourceLabel ? 'Merchant' : 'Recipient'} value={recipient} />
            </dl>
          </div>
        </div>

        <ApprovalRequiredBanner
          title={approval.status === 'approved' ? 'Approved, not sent yet' : 'Approval required'}
          tone="neutral"
          density="compact"
        >
          {approval.status === 'approved'
            ? requiresAdditionalApproval
              ? 'This request still needs to be submitted for the remaining account approvals before the payment can be sent.'
              : 'This request was approved but still needs to be completed before the payment is sent.'
            : approvalReasonLabel({ reason: approval.reason, source: approval.source })}
        </ApprovalRequiredBanner>

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
                <NetworkGate requiredChainId={approval.chain_id}>
                  <Button
                    size="sm"
                    disabled={executing || executionDisabled}
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
                </NetworkGate>
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
  const { details: safeDetails } = useSafeDetails(safeAddress)
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
      actionError={actionError}
    />
  )
}

function ApprovalHistoryRow({ approval }: { approval: ApprovalRequest }) {
  const recipient = approvalRecipientLabel({
    reason: approval.reason,
    source: approval.source,
    x402ResourceUrl: approval.x402_resource_url,
    toAddress: approval.to_address,
  })

  return (
    <div className="grid gap-3 border-b border-[var(--v2-border)] px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={statusTone(approval.status)}>{statusLabel(approval.status)}</StatusBadge>
          <p className="truncate text-sm font-medium text-[var(--v2-ink)]">
            <span className="v2-tabular">{approval.amount_human}</span> {approval.token_symbol}
          </p>
        </div>
        <p className="mt-1 text-xs text-[var(--v2-ink-2)]">
          {approval.agent_name} to {recipient}
        </p>
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
        <div className="h-5 w-28 rounded-full bg-[var(--v2-surface-2)] animate-pulse" />
        <div className="h-3 w-20 rounded bg-[var(--v2-surface-2)] animate-pulse" />
      </div>
      <div className="mt-5 h-8 w-44 rounded bg-[var(--v2-surface-2)] animate-pulse" />
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="h-16 rounded-[10px] bg-[var(--v2-surface)] animate-pulse" />
        <div className="h-16 rounded-[10px] bg-[var(--v2-surface)] animate-pulse" />
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

  const actionableApprovals = approvals.filter((approval) => isActionableStatus(approval.status))
  const pastApprovals = approvals.filter((approval) => !isActionableStatus(approval.status))

  if (loading) {
    return (
      <div className="space-y-3">
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
