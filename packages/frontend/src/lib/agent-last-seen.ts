import { timeAgo } from '@/lib/format'

const NOT_CONNECTED_COPY = 'Not connected yet'

function parseLastSeenMs(lastSeenAt: string | null | undefined): number | null {
  if (!lastSeenAt) return null
  const ms = new Date(lastSeenAt).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function formatAgentLastSeen(lastSeenAt: string | null | undefined): string {
  const ms = parseLastSeenMs(lastSeenAt)
  if (ms === null) return NOT_CONNECTED_COPY
  return `Last seen ${timeAgo(ms)}`
}

export function formatAgentLastSeenValue(lastSeenAt: string | null | undefined): string {
  const ms = parseLastSeenMs(lastSeenAt)
  if (ms === null) return NOT_CONNECTED_COPY
  return timeAgo(ms)
}

export function formatAgentLastSeenTitle(lastSeenAt: string | null | undefined): string | undefined {
  const ms = parseLastSeenMs(lastSeenAt)
  if (ms === null) return undefined
  return new Date(ms).toLocaleString()
}
