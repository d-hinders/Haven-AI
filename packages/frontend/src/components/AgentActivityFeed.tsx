'use client'

import { useAgentActivity, type AgentStats } from '@/hooks/useAgentActivity'

// ── Helpers ──────────────────────────────────────────────────────

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

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
  return (
    <span className={`inline-block w-1.5 h-1.5 rounded-full ${color[status] ?? 'bg-zinc-600'}`} />
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
      <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
        <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">{label}</p>
        <p className="text-xs text-zinc-700">No activity</p>
      </div>
    )
  }

  return (
    <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
      <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-2">{label}</p>
      {items.map((item) => (
        <div key={item.token} className="flex items-center justify-between mb-1 last:mb-0">
          <span className="text-xs text-zinc-400">{item.token}</span>
          <div className="text-right">
            <span className="text-xs text-zinc-200 font-medium">
              {Number(item.total_spent).toFixed(2)}
            </span>
            <span className="text-[10px] text-zinc-700 ml-1">
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
            className="text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <h3 className="text-sm font-semibold text-zinc-200">{agentName}</h3>
          <span className="text-[10px] text-zinc-700">Activity</span>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 bg-white/[0.02] border border-white/[0.06] rounded-lg animate-pulse" />
            ))}
          </div>
          <div className="h-32 bg-white/[0.02] border border-white/[0.06] rounded-lg animate-pulse" />
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
          <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-2">
            Recent Activity
          </p>

          {activity.length === 0 ? (
            <div className="text-center py-6 rounded-lg border border-dashed border-white/[0.06]">
              <p className="text-xs text-zinc-700">No activity yet</p>
            </div>
          ) : (
            <div className="space-y-1">
              {activity.map((item) => (
                <div
                  key={`${item.type}-${item.id}`}
                  className="flex items-center justify-between p-2.5 rounded-lg hover:bg-white/[0.02] transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <StatusDot status={item.status} />
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-zinc-300 font-medium">
                          {item.amount} {item.token}
                        </span>
                        {item.type === 'approval' && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-400">
                            approval
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-zinc-700">
                        <span>to {truncate(item.to)}</span>
                        {item.reason && (
                          <>
                            <span className="text-zinc-800">·</span>
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
                        className="text-[10px] text-indigo-400 hover:text-indigo-300"
                      >
                        tx
                      </a>
                    )}
                    <span className="text-[10px] text-zinc-800">
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
