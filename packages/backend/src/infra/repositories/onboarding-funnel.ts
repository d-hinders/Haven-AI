import db from '../../db.js'

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

/**
 * The funnel dimensions D1 (#2529) segments by, and the metadata key each one
 * actually reads.
 *
 * The indirection is NOT incidental naming — it is the collision #2522 found
 * and deliberately routed around. `metadata->>'via'` already exists and means
 * which CODE PATH created the record (`'connection_setup'` from the connect
 * flow, absent from `POST /agents`). The agent hand-off marker therefore rides
 * as `handoff_via`. A caller asking for `segment=via` means "the `via=agent`
 * marker the agent pasted", which is `handoff_via`; segmenting by the literal
 * `via` key would answer `connection_setup` for every connect-modal agent and
 * look like a working metric while measuring nothing.
 */
export const FUNNEL_SEGMENTS = {
  via: 'handoff_via',
  run_mode: 'run_mode',
} as const

export type FunnelSegment = keyof typeof FUNNEL_SEGMENTS

export function isFunnelSegment(value: unknown): value is FunnelSegment {
  return typeof value === 'string' && Object.hasOwn(FUNNEL_SEGMENTS, value)
}

/** The bucket a user with no value for the segment key falls into. */
export const UNATTRIBUTED = 'unattributed'

export interface FunnelSegmentGroup {
  value: string
  steps: FunnelStep[]
}

interface SegmentRow {
  value: string
  event: string
  users: string
}

/**
 * Per-step user counts, split by one funnel dimension.
 *
 * **Attribution is per USER, not per event, and that is the whole design.**
 * The segment keys are written by exactly two emissions — `signed_up` carries
 * `handoff_via`, `agent_created` carries `handoff_via` and `run_mode` — so a
 * naive `GROUP BY metadata->>key, event` reports agent-driven signups and then
 * ZERO agent-driven first payments, because `first_payment_settled` carries
 * neither key. That reads as "agents never convert" when it actually means
 * "the later event does not restate the marker". Resolving the value once per
 * user and carrying it across every step is what makes the conversion
 * question answerable at all, which is what the issue asks for.
 *
 * First touch wins on a user with more than one value, matching the `?src=`
 * convention already in `lib/discovery.ts`: the earliest event in the window
 * that carries the key decides.
 *
 * The `id ASC` tiebreak buys STABILITY, not chronology, and the distinction is
 * worth stating because the name suggests otherwise: `onboarding_events.id` is
 * `gen_random_uuid()`, so on an exact `created_at` tie the winner is arbitrary
 * with respect to insertion order — it is simply the SAME arbitrary winner on
 * every call, instead of whatever the plan happens to return. Only an exact
 * timestamp collision on one user reaches this, and both values are then
 * equally true of them.
 *
 * DISTINCT-user semantics are preserved exactly as `queryFunnel` has them —
 * `agent_created` is repeatable, so `COUNT(*)` would over-count multi-agent
 * users into a conversion rate above 100%.
 *
 * Deliberately a SEPARATE query rather than a widened `queryFunnel`: the
 * unsegmented read is the default and stays a two-statement path, and the
 * segmented read is the one that pays for the join.
 */
export async function queryFunnelSegments(
  from: Date,
  to: Date,
  segment: FunnelSegment,
): Promise<FunnelSegmentGroup[]> {
  const key = FUNNEL_SEGMENTS[segment]

  // `key` is bound as a VALUE to the `->>` operator, never interpolated as an
  // identifier — and it is one of two constants from FUNNEL_SEGMENTS either
  // way, since the route rejects anything else before reaching here.
  const result = await db.query<SegmentRow>(
    `WITH windowed AS (
       SELECT id, user_id, event, metadata, created_at
       FROM onboarding_events
       WHERE created_at >= $1 AND created_at < $2
     ),
     attribution AS (
       SELECT DISTINCT ON (user_id) user_id, metadata ->> $3::text AS value
       FROM windowed
       WHERE metadata ->> $3::text IS NOT NULL
       ORDER BY user_id, created_at ASC, id ASC
     )
     SELECT COALESCE(a.value, $4::text)  AS value,
            w.event                      AS event,
            COUNT(DISTINCT w.user_id)::text AS users
     FROM windowed w
     LEFT JOIN attribution a ON a.user_id = w.user_id
     GROUP BY 1, 2`,
    [from, to, key, UNATTRIBUTED],
  )

  const byValue = new Map<string, Map<string, number>>()
  for (const row of result.rows) {
    let counts = byValue.get(row.value)
    if (!counts) {
      counts = new Map<string, number>()
      byValue.set(row.value, counts)
    }
    counts.set(row.event, parseInt(row.users, 10))
  }

  // `unattributed` last, every real value alphabetically before it: the bucket
  // that means "no marker" is the least interesting row and reads as noise at
  // the top of a table.
  const values = [...byValue.keys()].sort((a, b) => {
    if (a === UNATTRIBUTED) return 1
    if (b === UNATTRIBUTED) return -1
    return a.localeCompare(b)
  })

  return values.map((value) => {
    const counts = byValue.get(value) ?? new Map<string, number>()
    return {
      value,
      steps: FUNNEL_ORDER.map((event, idx) => {
        const users = counts.get(event) ?? 0
        const prevUsers = idx > 0 ? (counts.get(FUNNEL_ORDER[idx - 1]) ?? 0) : null
        return {
          event,
          users,
          conversionFromPrev:
            prevUsers != null && prevUsers > 0
              ? Math.round((users / prevUsers) * 1000) / 10
              : null,
        }
      }),
    }
  })
}
