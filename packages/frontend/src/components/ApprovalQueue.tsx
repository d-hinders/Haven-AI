'use client'

import { useState } from 'react'
import { usePublicClient, useWalletClient, useAccount } from 'wagmi'
import { type Address, hashTypedData } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useApprovals, type ApprovalRequest } from '@/hooks/useApprovals'
import {
  getSafeNonce,
  buildSafeTx,
  signSafeTx,
  executeSafeTx,
  proposeSafeTx,
  getChainTokens,
  type SendParams,
} from '@/lib/safe-tx'
import { getExplorerUrl } from '@/lib/chains'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { truncate, timeAgo, timeUntil } from '@/lib/format'

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
    expired: 'bg-zinc-500/10 text-zinc-500',
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
  chainId = 100,
}: {
  approval: ApprovalRequest
  onApproveAndExecute: (approval: ApprovalRequest) => void
  onReject: (id: string) => void
  executing: boolean
  chainId?: number
}) {
  const isPending = approval.status === 'pending'
  const [confirmReject, setConfirmReject] = useState(false)

  return (
    <div className={`p-4 rounded-xl border transition-all ${
      isPending
        ? 'bg-amber-500/[0.02] border-amber-500/20 hover:border-amber-500/30'
        : 'bg-white/[0.02] border-white/[0.06]'
    }`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
            isPending ? 'bg-amber-500/10 text-amber-400' : 'bg-white/[0.04] text-zinc-500'
          }`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </div>
          <div>
            <p className="text-xs font-medium text-zinc-200">{approval.agent_name}</p>
            <p
              className="text-[10px] text-zinc-600"
              title={new Date(approval.created_at).toLocaleString()}
            >
              {timeAgo(approval.created_at)}
            </p>
          </div>
        </div>
        <StatusBadge status={approval.status} />
      </div>

      {/* Payment details */}
      <div className="bg-black/20 rounded-lg p-3 mb-3 space-y-1.5">
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Amount</span>
          <span className="text-zinc-200 font-medium">
            {approval.amount_human} {approval.token_symbol}
          </span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">To</span>
          <span className="text-zinc-400 font-mono">{truncate(approval.to_address)}</span>
        </div>
        {approval.reason && (
          <div className="flex justify-between text-xs gap-3">
            <span className="text-zinc-500 flex-shrink-0">Reason</span>
            <span
              className="text-zinc-400 max-w-[240px] truncate"
              title={approval.reason}
            >
              {approval.reason}
            </span>
          </div>
        )}
        {isPending && (
          <div className="flex justify-between text-xs">
            <span className="text-zinc-500">Expires</span>
            <span className="text-zinc-600">{timeUntil(approval.expires_at)}</span>
          </div>
        )}
        {approval.tx_hash && (
          <div className="flex justify-between text-xs">
            <span className="text-zinc-500">Tx</span>
            <a
              href={getExplorerUrl(chainId, 'tx', approval.tx_hash!)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 font-mono"
            >
              {truncate(approval.tx_hash)}
            </a>
          </div>
        )}
      </div>

      {/* Actions */}
      {isPending && (
        confirmReject ? (
          <div className="flex items-center gap-2 bg-red-500/[0.04] border border-red-500/20 rounded-lg px-3 py-2">
            <span className="flex-1 text-xs text-zinc-300">
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
              className="px-3 py-1.5 rounded-md text-zinc-400 text-xs font-medium hover:bg-white/[0.04] transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => onApproveAndExecute(approval)}
              disabled={executing}
              className="flex-1 px-3 py-2 rounded-lg bg-gradient-to-r from-emerald-500 to-emerald-600 text-white text-xs font-medium hover:from-emerald-400 hover:to-emerald-500 transition-all disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
            >
              {executing ? 'Executing...' : 'Approve & Execute'}
            </button>
            <button
              onClick={() => setConfirmReject(true)}
              disabled={executing}
              className="px-3 py-2 rounded-lg border border-white/[0.08] text-zinc-400 text-xs font-medium hover:bg-white/[0.04] hover:text-red-400 transition-all disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
            >
              Reject
            </button>
          </div>
        )
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────

export default function ApprovalQueue() {
  const { user, activeSafe } = useAuth()
  const safeAddress = activeSafe?.safe_address ?? null
  const chainId = activeSafe?.chain_id ?? 100
  const { details: safeDetails } = useSafeDetails(safeAddress)
  const { approvals, pendingCount, loading, approve, reject, markExecuted, refetch } = useApprovals()
  const { address: connectedAddress } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const [executing, setExecuting] = useState(false)

  const pendingApprovals = approvals.filter((a) => a.status === 'pending')
  const pastApprovals = approvals.filter((a) => a.status !== 'pending')

  async function handleApproveAndExecute(approval: ApprovalRequest) {
    if (!publicClient || !walletClient || !connectedAddress || !safeAddress || !safeDetails) return

    setExecuting(true)
    try {
      // 1. Mark as approved in backend
      await approve(approval.id)

      // 2. Build and sign Safe transaction
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

      const nonce = await getSafeNonce(publicClient, safeAddress as Address)
      const safeTx = buildSafeTx(sendParams, nonce)
      const signature = await signSafeTx(
        walletClient,
        safeAddress as Address,
        safeTx,
        connectedAddress,
        chainId,
      )

      // 3. Execute or propose
      const threshold = safeDetails.threshold ?? 1
      let txHash: string | undefined

      if (threshold <= 1) {
        const result = await executeSafeTx(
          walletClient,
          publicClient,
          safeAddress as Address,
          safeTx,
          signature,
          connectedAddress,
          chainId,
        )
        txHash = result.txHash
      } else {
        const safeTxHash = hashTypedData({
          domain: { chainId, verifyingContract: safeAddress as Address },
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
      }

      // 4. Record execution
      if (txHash) {
        await markExecuted(approval.id, txHash)
      }

      refetch()
    } catch (err) {
      if (err instanceof Error && !err.message.includes('rejected') && !err.message.includes('denied')) {
        console.error('Approval execution failed:', err)
      }
    } finally {
      setExecuting(false)
    }
  }

  async function handleReject(id: string) {
    try {
      await reject(id)
    } catch (err) {
      console.error('Reject failed:', err)
    }
  }

  if (!safeAddress) return null

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-200">Pending Approvals</h2>
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
            <div key={i} className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-7 h-7 rounded-lg bg-white/[0.04] animate-pulse" />
                <div className="h-3 w-24 bg-white/[0.06] rounded animate-pulse" />
              </div>
              <div className="h-16 bg-white/[0.02] rounded-lg animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && pendingApprovals.length === 0 && (
        <div className="text-center py-8 rounded-xl border border-dashed border-white/[0.06]">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center mx-auto mb-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-emerald-400">
              <path d="M9 12l2 2 4-4" />
              <circle cx="12" cy="12" r="10" />
            </svg>
          </div>
          <p className="text-xs text-zinc-400">You&apos;re all caught up</p>
          <p className="text-[10px] text-zinc-600 mt-1">
            Agent payments that need approval will appear here.
          </p>
        </div>
      )}

      {/* Pending */}
      {pendingApprovals.length > 0 && (
        <div className="space-y-3 mb-6">
          {pendingApprovals.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              onApproveAndExecute={handleApproveAndExecute}
              onReject={handleReject}
              executing={executing}
              chainId={chainId}
            />
          ))}
        </div>
      )}

      {/* Past approvals */}
      {pastApprovals.length > 0 && (
        <div>
          <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-3">History</p>
          <div className="space-y-2">
            {pastApprovals.slice(0, 10).map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]"
              >
                <div className="flex items-center gap-2">
                  <StatusBadge status={a.status} />
                  <span className="text-xs text-zinc-400">
                    {a.amount_human} {a.token_symbol}
                  </span>
                  <span className="text-xs text-zinc-700">to {truncate(a.to_address)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-700">{a.agent_name}</span>
                  <span
                    className="text-[10px] text-zinc-800"
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
