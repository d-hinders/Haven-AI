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
import { getExplorerUrl } from '@/lib/chains'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { truncate, timeAgo, timeUntil } from '@/lib/format'
import { useActiveSigner } from '@/lib/signer'
import NetworkGate from './NetworkGate'
import PasskeyOtherDeviceNotice from './PasskeyOtherDeviceNotice'

// ── Helpers ──────────────────────────────────────────────────────

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

// ── Status badge ─────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-amber-500/10 text-amber-400',
    approved: 'bg-blue-500/10 text-blue-400',
    rejected: 'bg-red-500/10 text-red-400',
    executed: 'bg-emerald-500/10 text-emerald-400',
    expired: 'bg-zinc-500/10 text-[var(--v2-ink-3)]',
  }
  const isPending = status === 'pending' || status === 'approved'
  const dotColor = status === 'pending' ? 'bg-amber-400' : 'bg-blue-400'
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${styles[status] ?? styles.expired}`}>
      {isPending && (
        <span className="relative inline-flex w-1.5 h-1.5">
          <span className={`absolute inset-0 rounded-full ${dotColor} opacity-60 animate-ping`} />
          <span className={`relative inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} />
        </span>
      )}
      {status}
    </span>
  )
}

// ── Single approval card ─────────────────────────────────────────

function ApprovalCard({
  approval,
  onApproveAndExecute,
  onReject,
  executing,
  executionDisabled = false,
  showOtherDeviceNotice = false,
  chainId = 100,
}: {
  approval: ApprovalRequest
  onApproveAndExecute: () => void
  onReject: (id: string) => void
  executing: boolean
  executionDisabled?: boolean
  showOtherDeviceNotice?: boolean
  chainId?: number
}) {
  const isPending = approval.status === 'pending'
  const [confirmReject, setConfirmReject] = useState(false)

  return (
    <div className={`p-4 rounded-xl border transition-all ${
      isPending
        ? 'bg-amber-500/[0.02] border-amber-500/20 hover:border-amber-500/30'
        : 'bg-[var(--v2-surface)] border-[var(--v2-border)]'
    }`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
            isPending ? 'bg-amber-500/10 text-amber-400' : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'
          }`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </div>
          <div>
            <p className="text-xs font-medium text-[var(--v2-ink)]">{approval.agent_name}</p>
            <p
              className="text-[10px] text-[var(--v2-ink-3)]"
              title={new Date(approval.created_at).toLocaleString()}
            >
              {timeAgo(approval.created_at)}
            </p>
          </div>
        </div>
        <StatusBadge status={approval.status} />
      </div>

      {/* Payment details */}
      <div className="bg-[var(--v2-surface)] rounded-lg p-3 mb-3 space-y-1.5">
        <div className="flex justify-between text-xs">
          <span className="text-[var(--v2-ink-3)]">Amount</span>
          <span className="text-[var(--v2-ink)] font-medium">
            {approval.amount_human} {approval.token_symbol}
          </span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-[var(--v2-ink-3)]">To</span>
          <span className="text-[var(--v2-ink-2)] font-mono">{truncate(approval.to_address)}</span>
        </div>
        {approval.reason && (
          <div className="flex justify-between text-xs gap-3">
            <span className="text-[var(--v2-ink-3)] flex-shrink-0">Reason</span>
            <span
              className="text-[var(--v2-ink-2)] max-w-[240px] truncate"
              title={approval.reason}
            >
              {approval.reason}
            </span>
          </div>
        )}
        {isPending && (
          <div className="flex justify-between text-xs">
            <span className="text-[var(--v2-ink-3)]">Expires</span>
            <span className="text-[var(--v2-ink-3)]">{timeUntil(approval.expires_at)}</span>
          </div>
        )}
        {approval.tx_hash && (
          <div className="flex justify-between text-xs">
            <span className="text-[var(--v2-ink-3)]">Tx</span>
            <a
              href={getExplorerUrl(chainId, 'tx', approval.tx_hash!)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] font-mono"
            >
              {truncate(approval.tx_hash)}
            </a>
          </div>
        )}
      </div>

      {/* Actions */}
      {isPending && (
        <div className="space-y-3">
          {showOtherDeviceNotice && (
            <PasskeyOtherDeviceNotice />
          )}
          {confirmReject ? (
            <div className="flex items-center gap-2 bg-red-500/[0.04] border border-red-500/20 rounded-lg px-3 py-2">
              <span className="flex-1 text-xs text-[var(--v2-ink)]">
                Reject this payment? The agent will be notified.
              </span>
              <button
                onClick={() => { onReject(approval.id); setConfirmReject(false) }}
                disabled={executing}
                className="px-3 py-1.5 rounded-md bg-red-500 hover:bg-red-400 text-white text-xs font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
              >
                Reject
              </button>
              <button
                onClick={() => setConfirmReject(false)}
                disabled={executing}
                className="px-3 py-1.5 rounded-md text-[var(--v2-ink-2)] text-xs font-medium hover:bg-[var(--v2-surface-2)] transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <NetworkGate requiredChainId={chainId}>
                  <button
                    onClick={onApproveAndExecute}
                    disabled={executing || executionDisabled}
                    aria-label="Approve & Execute"
                    className="w-full px-3 py-2 rounded-lg bg-[var(--v2-success)] text-white text-xs font-medium hover:bg-emerald-600 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-success)]/30"
                  >
                    {executing ? 'Approving...' : 'Approve payment'}
                  </button>
                </NetworkGate>
              </div>
              <button
                onClick={() => setConfirmReject(true)}
                disabled={executing}
                className="px-3 py-2 rounded-lg border border-[var(--v2-border)] text-[var(--v2-ink-2)] text-xs font-medium hover:bg-[var(--v2-surface-2)] hover:text-red-400 transition-all disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ApprovalCardWithContext({
  approval,
  executingApprovalId,
  setExecutingApprovalId,
  approve,
  reject,
  markExecuted,
  refetch,
}: {
  approval: ApprovalRequest
  executingApprovalId: string | null
  setExecutingApprovalId: (id: string | null) => void
  approve: (id: string) => Promise<unknown>
  reject: (id: string) => Promise<void>
  markExecuted: (id: string, txHash: string) => Promise<void>
  refetch: () => Promise<void>
}) {
  const { user } = useAuth()
  const safe = useMemo(
    () =>
      user?.safes.find(
        (item) => item.safe_address.toLowerCase() === approval.safe_address.toLowerCase(),
      ) ?? null,
    [approval.safe_address, user?.safes],
  )
  const safeAddress = (safe?.safe_address ?? approval.safe_address) as Address
  const chainId = safe?.chain_id ?? 100
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
  const executionDisabled = operationGate.kind === 'passkey_on_other_device'
  const executing = executingApprovalId === approval.id

  async function handleApproveAndExecute() {
    if (executionDisabled || !publicClient || !signer || !safeDetails) return

    setExecutingApprovalId(approval.id)
    try {
      await approve(approval.id)

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
      }

      if (txHash) {
        await markExecuted(approval.id, txHash)
      }

      await refetch()
    } catch (err) {
      if (err instanceof Error && !err.message.includes('rejected') && !err.message.includes('denied')) {
        console.error('Approval execution failed:', err)
      }
    } finally {
      setExecutingApprovalId(null)
    }
  }

  async function handleReject(id: string) {
    try {
      await reject(id)
    } catch (err) {
      console.error('Reject failed:', err)
    }
  }

  return (
    <ApprovalCard
      approval={approval}
      onApproveAndExecute={handleApproveAndExecute}
      onReject={handleReject}
      executing={executing}
      executionDisabled={executionDisabled}
      showOtherDeviceNotice={executionDisabled}
      chainId={chainId}
    />
  )
}

// ── Main component ───────────────────────────────────────────────

export default function ApprovalQueue() {
  const { approvals, pendingCount, loading, approve, reject, markExecuted, refetch } = useApprovals()
  const [executingApprovalId, setExecutingApprovalId] = useState<string | null>(null)

  const pendingApprovals = approvals.filter((a) => a.status === 'pending')
  const pastApprovals = approvals.filter((a) => a.status !== 'pending')

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Pending Approvals</h2>
          {pendingCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-amber-500/20 text-amber-400">
              {pendingCount}
            </span>
          )}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="bg-[var(--v2-surface)] border border-[var(--v2-border)] rounded-xl p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-7 h-7 rounded-lg bg-[var(--v2-surface-2)] animate-pulse" />
                <div className="h-3 w-24 bg-[var(--v2-surface-2)] rounded animate-pulse" />
              </div>
              <div className="h-16 bg-[var(--v2-surface)] rounded-lg animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && pendingApprovals.length === 0 && (
        <div className="text-center py-8 rounded-xl border border-dashed border-[var(--v2-border)]">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center mx-auto mb-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-emerald-400">
              <path d="M9 12l2 2 4-4" />
              <circle cx="12" cy="12" r="10" />
            </svg>
          </div>
          <p className="text-xs text-[var(--v2-ink-2)]">You&apos;re all caught up</p>
          <p className="text-[10px] text-[var(--v2-ink-3)] mt-1">
            Agent payments that need approval will appear here.
          </p>
        </div>
      )}

      {/* Pending */}
      {pendingApprovals.length > 0 && (
        <div className="space-y-3 mb-6">
          {pendingApprovals.map((a) => (
            <ApprovalCardWithContext
              key={a.id}
              approval={a}
              executingApprovalId={executingApprovalId}
              setExecutingApprovalId={setExecutingApprovalId}
              approve={approve}
              reject={reject}
              markExecuted={markExecuted}
              refetch={refetch}
            />
          ))}
        </div>
      )}

      {/* Past approvals */}
      {pastApprovals.length > 0 && (
        <div>
          <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-3">History</p>
          <div className="space-y-2">
            {pastApprovals.slice(0, 10).map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between p-3 rounded-lg bg-[var(--v2-surface)] border border-[var(--v2-border)]"
              >
                <div className="flex items-center gap-2">
                  <StatusBadge status={a.status} />
                  <span className="text-xs text-[var(--v2-ink-2)]">
                    {a.amount_human} {a.token_symbol}
                  </span>
                  <span className="text-xs text-[var(--v2-ink-3)]">to {truncate(a.to_address)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-[var(--v2-ink-3)]">{a.agent_name}</span>
                  <span
                    className="text-[10px] text-[var(--v2-ink-3)]"
                    title={new Date(a.created_at).toLocaleString()}
                  >
                    {timeAgo(a.created_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
