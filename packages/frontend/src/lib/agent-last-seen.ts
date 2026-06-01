import { timeAgo } from '@/lib/format'

const NO_ACTIVITY_COPY = 'No activity yet'

function parseLastSeenMs(lastSeenAt: string | null | undefined): number | null {
  if (!lastSeenAt) return null
  const ms = new Date(lastSeenAt).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function formatAgentLastActivity(lastSeenAt: string | null | undefined): string {
  const ms = parseLastSeenMs(lastSeenAt)
  if (ms === null) return NO_ACTIVITY_COPY
  return `Last activity ${timeAgo(ms)}`
}

export function formatAgentLastActivityValue(lastSeenAt: string | null | undefined): string {
  const ms = parseLastSeenMs(lastSeenAt)
  if (ms === null) return NO_ACTIVITY_COPY
  return timeAgo(ms)
}

export function formatAgentLastActivityTitle(lastSeenAt: string | null | undefined): string | undefined {
  const ms = parseLastSeenMs(lastSeenAt)
  if (ms === null) return undefined
  return new Date(ms).toLocaleString()
}
