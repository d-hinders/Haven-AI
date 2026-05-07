'use client'

import { useAgentActivity, type AgentStats } from '@/hooks/useAgentActivity'
import { truncate, timeAgo } from '@/lib/format'

// ── Status indicator ─────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const color: Record<string, string> = {
    confirmed: 'bg-emerald-400',
    pending_signature: 'bg-amber-400',
    submitted: 'bg-blue-400',
    failed: 'bg-red-400',
    expired: 'bg-zinc-600',
    pending: 'bg-amber-400',
    approved: 'bg-blue-400',
    rejected: 'bg-red-400',
    executed: 'bg-emerald-400',
  }
  const isPending = status === 'pending' || status === 'pending_signature' || status === 'submitted' || status === 'approved'
  const dot = color[status] ?? 'bg-zinc-600'
  if (isPending) {
    return (
      <span className="relative inline-flex w-1.5 h-1.5">
        <span className={`absolute inset-0 rounded-full ${dot} opacity-60 animate-ping`} />
        <span className={`relative inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
      </span>
    )
  }
  return (
    <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
  )
}

// ── Stats card ───────────────────────────────────────────────────

function StatCard({
  label,
  items,
}: {
  label: string
  items: { token: string; total_spent: string; tx_count: number }[]
}) {
  if (items.length === 0) {
    return (
      <div className="p-3 rounded-lg bg-[var(--v2-surface)] border border-[var(--v2-border)]">
        <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-1">{label}</p>
        <p className="text-xs text-[var(--v2-ink-3)]">No activity</p>
      </div>
    )
  }

  return (
    <div className="p-3 rounded-lg bg-[var(--v2-surface)] border border-[var(--v2-border)]">
      <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-2">{label}</p>
      {items.map((item) => (
        <div key={item.token} className="flex items-center justify-between mb-1 last:mb-0">
          <span className="text-xs text-[var(--v2-ink-2)]">{item.token}</span>
          <div className="text-right">
            <span className="text-xs text-[var(--v2-ink)] font-medium">
              {Number(item.total_spent).toFixed(2)}
            </span>
            <span className="text-[10px] text-[var(--v2-ink-3)] ml-1">
              ({item.tx_count} tx{item.tx_count !== 1 ? 's' : ''})
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────

interface Props {
  agentId: string
  agentName: string
  onClose: () => void
}

export default function AgentActivityFeed({ agentId, agentName, onClose }: Props) {
  const { activity, stats, loading } = useAgentActivity(agentId)

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{agentName}</h3>
          <span className="text-[10px] text-[var(--v2-ink-3)]">Activity</span>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 bg-[var(--v2-surface)] border border-[var(--v2-border)] rounded-lg animate-pulse" />
            ))}
          </div>
          <div className="h-32 bg-[var(--v2-surface)] border border-[var(--v2-border)] rounded-lg animate-pulse" />
        </div>
      )}

      {/* Stats */}
      {!loading && stats && (
        <div className="grid grid-cols-3 gap-2">
          <StatCard label="Today" items={stats.today} />
          <StatCard label="This week" items={stats.this_week} />
          <StatCard label="All time" items={stats.all_time} />
        </div>
      )}

      {/* Pending approvals badge */}
      {!loading && stats && stats.pending_approvals > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/[0.05] border border-amber-500/20">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-amber-400">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span className="text-xs text-amber-400">
            {stats.pending_approvals} payment{stats.pending_approvals !== 1 ? 's' : ''} pending approval
          </span>
        </div>
      )}

      {/* Activity feed */}
      {!loading && (
        <div>
          <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-2">
            Recent Activity
          </p>

          {activity.length === 0 ? (
            <div className="text-center py-6 rounded-lg border border-dashed border-[var(--v2-border)]">
              <p className="text-xs text-[var(--v2-ink-3)]">No activity yet</p>
              <p className="text-[10px] text-[var(--v2-ink-3)] mt-1">
                Your agent&apos;s payments will appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {activity.map((item) => (
                <div
                  key={`${item.type}-${item.id}`}
                  className="flex items-center justify-between p-2.5 rounded-lg hover:bg-[var(--v2-surface)] transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <StatusDot status={item.status} />
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-[var(--v2-ink)] font-medium">
                          {item.amount} {item.token}
                        </span>
                        {item.type === 'approval' && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-400">
                            approval
                          </span>
                        )}
                        {item.source === 'x402' && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-violet-500/10 text-violet-400">
                            x402
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-[var(--v2-ink-3)]">
                        <span>to {truncate(item.to)}</span>
                        {item.x402_resource_url && (
                          <>
                            <span className="text-[var(--v2-ink-3)]">·</span>
                            <span className="max-w-[150px] truncate text-violet-400/60">{item.x402_resource_url}</span>
                          </>
                        )}
                        {item.reason && (
                          <>
                            <span className="text-[var(--v2-ink-3)]">·</span>
                            <span className="max-w-[120px] truncate">{item.reason}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.tx_hash && (
                      <a
                        href={item.explorer_url ?? '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
                      >
                        tx
                      </a>
                    )}
                    <span
                      className="text-[10px] text-[var(--v2-ink-3)]"
                      title={new Date(item.created_at).toLocaleString()}
                    >
                      {timeAgo(item.created_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
