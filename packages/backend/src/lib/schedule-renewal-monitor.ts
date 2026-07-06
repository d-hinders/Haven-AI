/**
 * Schedule-renewal notifications (#803): the dashboard banner (#770) is
 * pull-based — the owner must happen to visit the agent page. This monitor
 * pushes: an hourly scan over every session-rail agent with an enabled
 * budget-schedule window, notifying when renewal is due.
 *
 * Edge-triggered (the #777 pattern), never per-scan spam — at most TWO
 * notifications per window:
 *   1. when the window transitions into renewal_due (≤2 periods left),
 *   2. once more when the LAST period starts.
 * A renewed window (new from_period/count) starts a fresh episode. State is
 * per-process (resets on redeploy — an acceptable at-most-once re-ping).
 *
 * Channel: Slack-compatible `{ text }` webhook. `SCHEDULE_RENEWAL_WEBHOOK_URL`
 * with fallback to `DELEGATE_ALERT_WEBHOOK_URL` (one ops channel by default);
 * both unset = log-only. Best-effort: a failed post never affects the scan.
 * No email channel exists in the backend today — when one lands, this is the
 * single seam to extend.
 *
 * Copy rule (#736): outcome language only — "budget", "renew", never
 * session/permission jargon.
 */

import pool from '../db.js'
import { periodIndexAt } from './session-rotation.js'

/** The banner threshold (#770) — keep the two surfaces in agreement. */
export const RENEWAL_DUE_PERIODS = 2

export interface RenewalCandidate {
  agentId: string
  agentName: string
  fromPeriod: number
  periodCount: number
  resetPeriodMin: number
}

export interface RenewalReport {
  candidates: RenewalCandidate[]
  scannedAt: string
}

/** Session-rail agents with an enabled window + their period length. */
export async function scanRenewalCandidates(): Promise<RenewalReport> {
  const result = await pool.query<{
    agent_id: string
    agent_name: string
    session_schedule_from_period: number
    session_schedule_period_count: number
    reset_period_min: number
  }>(
    `SELECT a.id AS agent_id, a.name AS agent_name,
            a.session_schedule_from_period, a.session_schedule_period_count,
            MIN(al.reset_period_min) AS reset_period_min
     FROM agents a
     JOIN user_safes us ON us.id = a.safe_id AND us.execution_rail = 'session_key'
     JOIN agent_allowances al ON al.agent_id = a.id AND al.reset_period_min > 0
     WHERE a.status = 'active'
       AND a.session_schedule_from_period IS NOT NULL
       AND a.session_schedule_period_count IS NOT NULL
     GROUP BY a.id, a.name, a.session_schedule_from_period, a.session_schedule_period_count`,
  )
  return {
    candidates: result.rows.map((row) => ({
      agentId: row.agent_id,
      agentName: row.agent_name,
      fromPeriod: row.session_schedule_from_period,
      periodCount: row.session_schedule_period_count,
      resetPeriodMin: row.reset_period_min,
    })),
    scannedAt: new Date().toISOString(),
  }
}

/** Which notification stage a window episode has reached. */
export type RenewalStage = 'due' | 'last'

export interface RenewalNotifyState {
  /** `${agentId}:${fromPeriod}:${periodCount}` → highest stage notified. */
  episodes: Map<string, RenewalStage>
}

export function newRenewalNotifyState(): RenewalNotifyState {
  return { episodes: new Map() }
}

function episodeKey(c: RenewalCandidate): string {
  return `${c.agentId}:${c.fromPeriod}:${c.periodCount}`
}

function agentUrl(agentId: string): string {
  const base = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '')
  return base ? `${base}/agents/${agentId}` : `/agents/${agentId}`
}

/**
 * Pure notification decision: which messages this scan sends, and the next
 * state. At most two per episode — the due-transition and the last period.
 */
export function computeRenewalNotifications(
  report: RenewalReport,
  state: RenewalNotifyState,
  nowSec: number,
): { messages: string[]; nextState: RenewalNotifyState } {
  const messages: string[] = []
  const nextEpisodes = new Map<string, RenewalStage>()

  for (const c of report.candidates) {
    const currentPeriod = periodIndexAt(nowSec, c.resetPeriodMin)
    const lastPeriod = c.fromPeriod + c.periodCount - 1
    const remaining = lastPeriod - currentPeriod + 1
    if (currentPeriod < c.fromPeriod || remaining <= 0) continue // not started / expired

    const key = episodeKey(c)
    const notified = state.episodes.get(key)

    if (remaining <= 1 && notified !== 'last') {
      messages.push(
        `⏳ Agent "${c.agentName}" is on its LAST pre-approved budget period — ` +
          `payments stop when it ends. Renew with one signature: ${agentUrl(c.agentId)}`,
      )
      nextEpisodes.set(key, 'last')
    } else if (remaining <= RENEWAL_DUE_PERIODS && notified == null) {
      messages.push(
        `🔔 Agent "${c.agentName}" has ${remaining} pre-approved budget periods left. ` +
          `Renew with one signature to keep it paying without interruption: ${agentUrl(c.agentId)}`,
      )
      nextEpisodes.set(key, 'due')
    } else if (notified) {
      nextEpisodes.set(key, notified) // carry forward within the same episode
    }
  }

  return { messages, nextState: { episodes: nextEpisodes } }
}

const moduleState = newRenewalNotifyState()

interface MonitorLogger {
  info(obj: unknown, msg: string): void
  warn(obj: unknown, msg: string): void
}

/** POST a plain `{ text }` payload (Slack-compatible). Best-effort. */
async function sendWebhook(url: string, text: string): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  })
}

/** One scan + notifications. Failure of the notify path never throws. */
export async function runScheduleRenewalMonitor(log: MonitorLogger): Promise<RenewalReport> {
  const report = await scanRenewalCandidates()
  const { messages, nextState } = computeRenewalNotifications(
    report,
    moduleState,
    Math.floor(Date.now() / 1000),
  )
  moduleState.episodes = nextState.episodes

  if (messages.length > 0) {
    log.info(
      { scope: 'schedule-renewal-monitor', notifications: messages.length },
      'schedule renewal notifications due',
    )
  }

  const url = process.env.SCHEDULE_RENEWAL_WEBHOOK_URL || process.env.DELEGATE_ALERT_WEBHOOK_URL
  if (url) {
    for (const text of messages) {
      try {
        await sendWebhook(url, text)
      } catch (err) {
        log.warn(
          { scope: 'schedule-renewal-monitor', err: err instanceof Error ? err.message : String(err) },
          'renewal webhook failed (scan unaffected)',
        )
      }
    }
  } else {
    for (const text of messages) {
      log.warn({ scope: 'schedule-renewal-monitor' }, text)
    }
  }

  return report
}
