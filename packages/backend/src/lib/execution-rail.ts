/**
 * Execution-rail routing (epic #733, foundation #739 slice #745): decide, per
 * payment, whether the money moves on the legacy AllowanceModule rail or the
 * session-key rail (ERC-4337 Safe7579 + Smart Sessions, ADR #719 Stage 2).
 *
 * The decision is FAIL-CLOSED to 'allowance_module': every existing account
 * routes exactly as before unless (a) the Safe row is explicitly marked
 * migrated, (b) the agent has an enabled session permissionId, and (c) the
 * chain is on the session-rail allowlist. Any missing or malformed piece
 * falls back to the legacy path — which keeps working on a migrated Safe too,
 * because the #721 on-chain migration is additive.
 *
 * An intent PINS its rail at authorize time (`payment_intents.execution_rail`)
 * so verification and execution use the rail whose hash the client actually
 * signed, even if account state changes in between.
 */

import pool from '../db.js'
import { getChain } from './chains.js'

/**
 * Chains the session rail may execute on. Base Sepolia only until the Stage 2
 * production gates clear: #735 (registry attestation), #736 (non-custody CI +
 * CASP copy), #738 (bundler/paymaster vendor ownership). Do NOT add Base
 * mainnet before those; Gnosis additionally waits on its own v1.3.0 +
 * Safe7579 verification run (#733).
 */
export const SESSION_RAIL_CHAIN_IDS: ReadonlySet<number> = new Set([84532])

const PERMISSION_ID_RE = /^0x[0-9a-fA-F]{64}$/

export interface ExecutionRailState {
  /** `user_safes.execution_rail` for the agent's Safe (null = no row / legacy). */
  safeExecutionRail: string | null
  /** `agents.session_permission_id` (null = no enabled session). */
  sessionPermissionId: string | null
  chainId: number
}

export type ExecutionRailDecision =
  | { rail: 'allowance_module' }
  | { rail: 'session_key'; permissionId: `0x${string}` }

/** The pure routing decision — see the fail-closed contract in the header. */
export function resolveExecutionRail(state: ExecutionRailState): ExecutionRailDecision {
  if (state.safeExecutionRail !== 'session_key') return { rail: 'allowance_module' }
  if (!SESSION_RAIL_CHAIN_IDS.has(state.chainId)) return { rail: 'allowance_module' }
  if (!state.sessionPermissionId || !PERMISSION_ID_RE.test(state.sessionPermissionId)) {
    return { rail: 'allowance_module' }
  }
  return { rail: 'session_key', permissionId: state.sessionPermissionId as `0x${string}` }
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
  return message.replace(/apikey=[^&\s"'\\)]+/gi, 'apikey=REDACTED')
}
