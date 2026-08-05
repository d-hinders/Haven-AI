/**
 * Execution-rail seam (epic #733 → retirement #834 → one-gate #993).
 *
 * TWO rails are live: the legacy AllowanceModule rail (import-only, existing
 * Safes) and the delegation rail (the base for new accounts, epic #821). The
 * session-key rail (ERC-4337 Safe7579 + Smart Sessions) is RETIRED outright
 * (#834): its machinery is deleted, and any account or intent still marked
 * `session_key` gets HTTP 410 — fail-closed, nothing written. The typed seam
 * itself stays for reversibility (the #834 owner decision); what #993
 * removed is the four scattered copies of the retirement gate, not the seam.
 *
 * Retirement is decided HERE, once: `resolveExecutionRail` returns
 * `retired_session` for any session-marked account (no chain allowlist, no
 * permission-id shape check — those gated a LIVE rail; a retired rail's only
 * answer is 410 regardless), and `sessionRailRetired()` is the single
 * producer of the refusal body.
 *
 * An intent PINS its rail at authorize time (`payment_intents.execution_rail`)
 * so verification and execution use the rail whose hash the client actually
 * signed, even if account state changes in between.
 */

import pool from '../db.js'
import { getChain } from './chains.js'

export interface ExecutionRailState {
  /** `user_safes.execution_rail` for the agent's Safe (null = no row / legacy). */
  safeExecutionRail: string | null
  /** `agents.session_permission_id` (null = no enabled session). */
  sessionPermissionId: string | null
  chainId: number
}

export type ExecutionRailDecision =
  | { rail: 'allowance_module' }
  | { rail: 'retired_session' }

/**
 * The pure routing decision. A session-marked account is retired, full stop —
 * the pre-#993 chain/permission checks made a marked-but-misconfigured
 * account silently fall through to the legacy rail, which post-retirement
 * just deferred the refusal to a confusing 403; the honest answer is the 410
 * with re-onboarding instructions.
 */
export function resolveExecutionRail(state: ExecutionRailState): ExecutionRailDecision {
  if (state.safeExecutionRail === 'session_key') return { rail: 'retired_session' }
  return { rail: 'allowance_module' }
}

/** An intent's pinned rail, resolved through the same retirement seam. */
export function isRetiredRailIntent(executionRail: string | null | undefined): boolean {
  return executionRail === 'session_key'
}

/**
 * The ONE producer of the session-rail refusal (#993). Fail-closed contract:
 * callers return this VERBATIM with nothing written — no intent row, no
 * audit side effect, no status flip.
 */
export function sessionRailRetired(kind: 'account' | 'intent'): { statusCode: 410; body: { error: string } } {
  return {
    statusCode: 410,
    body: {
      error:
        kind === 'account'
          ? 'The session rail is retired — re-onboard this account on the delegation rail ' +
            '(POST /accounts/hybrid, then grant a budget) to keep paying.'
          : 'The session rail is retired — this intent can no longer execute. ' +
            'Re-onboard the account on the delegation rail and authorize again.',
    },
  }
}

/**
 * Load the rail state for an agent. LEFT JOIN so a missing Safe row yields
 * nulls → legacy (fail-closed), never an error.
 *
 * The join goes through `agents.safe_id` — the agent's bound Safe row — the
 * same resolution agentAuthMiddleware uses. NOTE: `agents` has NO
 * `safe_address` column (the AgentContext field is middleware-hydrated via
 * this very join); an address-based join here 500s with "column does not
 * exist" on the real schema, which mocked route tests cannot catch — found
 * live on the first DoD run (#745).
 */
export async function loadExecutionRailState(agent: {
  id: string
  chain_id: number
}): Promise<ExecutionRailState> {
  const result = await pool.query<{
    execution_rail: string | null
    session_permission_id: string | null
  }>(
    `SELECT us.execution_rail, a.session_permission_id
     FROM agents a
     LEFT JOIN user_safes us ON us.id = a.safe_id
     WHERE a.id = $1`,
    [agent.id],
  )
  const row = result.rows[0]
  return {
    safeExecutionRail: row?.execution_rail ?? null,
    sessionPermissionId: row?.session_permission_id ?? null,
    chainId: agent.chain_id,
  }
}

// ── Prepared-UserOp persistence ─────────────────────────────────────────────
//
// The prepared UserOperation (permissionless) carries bigints, which JSON
// cannot represent. Serialize them with an explicit marker so the submit step
// replays EXACTLY the payload whose hash the client signed — a lossy or
// key-guessing round-trip here would silently change the hash.

const BIGINT_MARKER = '__bigint__'

export function serializeUserOp(userOp: unknown): string {
  return JSON.stringify(userOp, (_key, value: unknown) =>
    typeof value === 'bigint' ? `${BIGINT_MARKER}${value.toString()}` : value,
  )
}

/**
 * Accepts either the serialized string or the object pg hands back from a
 * JSONB column (node-postgres parses JSONB on read).
 */
export function deserializeUserOp(stored: unknown): unknown {
  const json = typeof stored === 'string' ? stored : JSON.stringify(stored)
  return JSON.parse(json, (_key, value: unknown) =>
    typeof value === 'string' && value.startsWith(BIGINT_MARKER)
      ? BigInt(value.slice(BIGINT_MARKER.length))
      : value,
  )
}

// ── Error-surface hygiene ───────────────────────────────────────────────────

/**
 * Scrub vendor credentials from error text before it reaches API responses or
 * the database. Viem/bundler errors echo the full request URL — which for
 * hosted bundlers EMBEDS THE API KEY (`?apikey=…`). Found live during the
 * #738 exhaustion test: the sponsorship decline leaked the key into the 502
 * `details`. Every session-rail error surface must pass through this.
 */
export function redactVendorSecrets(message: string): string {
  return (
    message
      // Query-param credentials in any spelling: apikey=, api_key=, api-key=,
      // key=, token= (#1053 review, finding 6 — the old regex caught only
      // `apikey=`).
      .replace(/\b(api[_-]?key|key|token|secret)=[^&\s"'\\)]+/gi, '$1=REDACTED')
      // Basic-auth credentials embedded in a URL: https://user:pass@host
      .replace(/(https?:\/\/)[^\s/@]+:[^\s@]+@/gi, '$1REDACTED@')
      // Pimlico-style key-in-path segments: /rpc/<hex-ish token>
      .replace(/(\/(?:rpc|v2)\/)[A-Za-z0-9_-]{16,}/g, '$1REDACTED')
  )
}
