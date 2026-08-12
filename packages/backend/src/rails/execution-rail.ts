/**
 * Execution-rail seam (epic #733 → retirement #834 → one-gate #993).
 *
 * TWO rails are live: the legacy AllowanceModule rail (import-only, existing
 * Safes) and the delegation rail (the base for new accounts, epic #821). The
 * session-key rail (ERC-4337 Safe7579 + Smart Sessions) is RETIRED outright
 * (#834): its machinery is deleted, and any account or intent still marked
 * `session_key` gets HTTP 410 — fail-closed, nothing written — on every
 * agent-payment ENTRY point (/payments, /payments/:id/sign, MPP authorize +
 * replay, /machine-payments/send, x402 authorize). Queued approvals are NOT
 * a residual (investigated on #1121): approval execution is an OWNER-signed
 * Safe transaction built by the dashboard — owner authority, not the
 * retired rail's agent authority, so the seam is rightly not consulted
 * there. The typed seam itself stays for
 * reversibility (the #834 owner decision); what #993 removed is the four
 * scattered copies of the retirement gate, not the seam.
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

import { findExecutionRailForAgent } from '../infra/repositories/user-safes.js'
import { getChain } from '../domain/chains.js'

export interface ExecutionRailState {
  /** `user_safes.execution_rail` for the agent's Safe (null = no row / legacy). */
  safeExecutionRail: string | null
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
 * The two-value rail label exposed on agent-facing read surfaces (#1306),
 * e.g. `GET /machine-payments/agent`'s `execution_rail` field. Reporting
 * only — matches the same `agent.execution_rail === 'delegation'` check
 * `handleGetAllowances` already branches on (#1135); anything else
 * (including the retired session rail, `allowance_module`, or a missing
 * column) buckets into `legacy`, since every non-delegation account reads
 * the AllowanceModule shape on the allowances endpoint today.
 */
export function agentExecutionRailLabel(
  executionRail: string | null | undefined,
): 'legacy' | 'delegation' {
  return executionRail === 'delegation' ? 'delegation' : 'legacy'
}

/**
 * The ONE producer of the session-rail refusal (#993). Fail-closed contract:
 * callers return this VERBATIM with nothing written — no intent row, no
 * audit side effect, no status flip.
 */
/**
 * The MPP surface has no delegation branch yet (#1251): x402 got
 * `delegation-authorize.ts` and the #946 3009 fallback, MPP never did, and
 * the silent fall-through ran a Hybrid account through LEGACY allowance
 * coverage — AllowanceModule reads zero for a Hybrid, so every payment
 * queued as an approval that could never execute (approving it reverts
 * on-chain). Fail-closed at the seam, the #745/#993 pattern: one refusal
 * shape, produced here, used by every MPP entry point.
 */
export function mppNotOnDelegationRail(): {
  statusCode: 422
  body: { error: string; error_code: 'rail_not_supported' }
} {
  return {
    statusCode: 422,
    body: {
      error:
        'MPP payments are not yet supported on delegation-rail accounts. ' +
        'Use a direct payment (POST /payments) or an x402 purchase instead.',
      error_code: 'rail_not_supported',
    },
  }
}

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
 * Load the rail state for an agent. The query lives in
 * `infra/repositories/user-safes.ts` (`FIND_EXECUTION_RAIL_FOR_AGENT_SQL`, #999):
 * LEFT JOIN through `agents.safe_id` so a missing Safe row yields null →
 * legacy (fail-closed), never an error — see the repository's note on the
 * #745/#757 join regression.
 */
export async function loadExecutionRailState(agent: {
  id: string
  chain_id: number
}): Promise<ExecutionRailState> {
  return {
    safeExecutionRail: await findExecutionRailForAgent(agent.id),
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
