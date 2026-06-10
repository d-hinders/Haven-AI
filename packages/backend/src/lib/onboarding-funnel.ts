import db from '../db.js'

export type FunnelEvent =
  | 'signed_up'
  | 'safe_deployed'
  | 'safe_imported'
  | 'agent_created'
  | 'allowance_granted'
  | 'safe_funded'
  | 'first_payment_settled'

export interface FunnelStep {
  event: FunnelEvent
  users: number
  conversionFromPrev: number | null
}

export interface FunnelRow {
  event: string
  users: string
}

/**
 * Fire-and-forget funnel event. Never throws, never blocks the caller.
 * Uses ON CONFLICT DO NOTHING so one-time events (signed_up, safe_funded,
 * first_payment_settled) are deduplicated by the partial unique index on
 * (user_id, event). Repeatable events (agent_created, allowance_granted,
 * safe_deployed, safe_imported) always insert a new row.
 */
export function emitFunnelEvent(
  userId: string,
  event: FunnelEvent,
  metadata?: Record<string, unknown>,
): void {
  // Async IIFE so that synchronous errors (e.g. db unavailable) are also
  // swallowed without escaping to the caller's stack frame.
  void (async () => {
    try {
      await db.query(
        `INSERT INTO onboarding_events (user_id, event, metadata)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, event, metadata != null ? JSON.stringify(metadata) : null],
      )
    } catch {
      // Swallow — funnel telemetry must never break product flows
    }
  })()
}

const FUNNEL_ORDER: FunnelEvent[] = [
  'signed_up',
  'safe_deployed',
  'safe_imported',
  'agent_created',
  'allowance_granted',
  'safe_funded',
  'first_payment_settled',
]

/**
 * Returns per-step user counts for a date range.
 * Counts distinct users that have reached each step (have at least one event
 * of that type within the window). TTFP is the median interval from signed_up
 * to first_payment_settled for users who completed both steps.
 */
export async function queryFunnel(from: Date, to: Date): Promise<{
  steps: FunnelStep[]
  medianTtfpMs: number | null
}> {
  const result = await db.query<FunnelRow>(
    `SELECT event, COUNT(DISTINCT user_id)::text AS users
     FROM onboarding_events
     WHERE created_at >= $1 AND created_at < $2
     GROUP BY event`,
    [from, to],
  )

  const countByEvent = new Map<string, number>()
  for (const row of result.rows) {
    countByEvent.set(row.event, parseInt(row.users, 10))
  }

  const steps: FunnelStep[] = FUNNEL_ORDER.map((event, idx) => {
    const users = countByEvent.get(event) ?? 0
    const prevUsers = idx > 0 ? (countByEvent.get(FUNNEL_ORDER[idx - 1]) ?? 0) : null
    return {
      event,
      users,
      conversionFromPrev: prevUsers != null && prevUsers > 0
        ? Math.round((users / prevUsers) * 1000) / 10
        : null,
    }
  })

  const ttfpResult = await db.query<{ median_ms: string | null }>(
    `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
       ORDER BY EXTRACT(EPOCH FROM (fp.created_at - su.created_at)) * 1000
     )::text AS median_ms
     FROM onboarding_events su
     JOIN onboarding_events fp
       ON fp.user_id = su.user_id
      AND fp.event = 'first_payment_settled'
     WHERE su.event = 'signed_up'
       AND su.created_at >= $1
       AND su.created_at < $2`,
    [from, to],
  )

  const medianMs = ttfpResult.rows[0]?.median_ms
  return {
    steps,
    medianTtfpMs: medianMs != null ? Math.round(parseFloat(medianMs)) : null,
  }
}
