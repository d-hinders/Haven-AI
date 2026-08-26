/**
 * Execution-rail seam (epic #733 → retirement #834 → one-gate #993 →
 * Safe-rail retirement #1986).
 *
 * **ONE rail is live: the delegation rail** (epic #821). Both other rails are
 * retired tombstones that coexist here:
 *
 * - the session-key rail (ERC-4337 Safe7579 + Smart Sessions), retired by
 *   #834 — its machinery is deleted, and any account or intent still marked
 *   `session_key` gets HTTP 410;
 * - the legacy AllowanceModule / Safe rail, retired by **#1986** (epic
 *   #1440 slice 3, owner decision 2026-08-14, phasing approved 2026-08-24) —
 *   its machinery is still here (deletion is #1987/#1988), but no account
 *   can reach it: `execution_rail='allowance_module'` (and the LEFT-JOIN
 *   `null` that resolves to it) gets HTTP 410 too.
 *
 * Both refusals are fail-closed, nothing written, on every agent-payment
 * ENTRY point (/payments, /payments/:id/sign, MPP authorize + replay,
 * /machine-payments/send, x402 authorize).
 *
 * **Queued approvals — the one place #1986 goes further than #834.** The
 * #1121 investigation concluded the seam is rightly not consulted on
 * approval execution, because that is an OWNER-signed Safe transaction built
 * by the dashboard: owner authority, not the retired rail's agent authority,
 * and #834 left the queue alone on that reasoning. It still holds for the
 * *authority* question — Haven cannot stop an owner signing their own Safe
 * transaction, and `POST /safe/exec` deliberately stays open because
 * approver management (#1229 recovery) rides on it. What changed is the
 * *scope*: #834 retired one rail among several that fed the queue, whereas
 * #1986 retires the only rail that ever fed it, so leaving `/approvals/:id/
 * approve` open would leave Haven manufacturing executable Safe payment
 * transactions for a rail it has declared gone. The queue therefore stays
 * READABLE and REJECTABLE and stops being APPROVABLE — the #1328 mpp_demo
 * shape exactly.
 *
 * The typed seam itself stays for reversibility (the #834 owner decision,
 * restated for Safe in #1440); what #993 removed is the four scattered
 * copies of the retirement gate, not the seam.
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
  | { rail: 'delegation' }
  | { rail: 'retired_session' }
  | { rail: 'retired_allowance' }

/**
 * The pure routing decision. A session-marked account is retired, full stop —
 * the pre-#993 chain/permission checks made a marked-but-misconfigured
 * account silently fall through to the legacy rail, which post-retirement
 * just deferred the refusal to a confusing 403; the honest answer is the 410
 * with re-onboarding instructions.
 *
 * **#1986 removed `allowance_module` from this union entirely.** There is no
 * longer a "route this to the AllowanceModule" answer to give: every spend on
 * that rail is retired. The union's shape is the guard — a call site that
 * used to fall through the `retired_session` check into legacy execution now
 * has to say what it does with `retired_allowance`, and the compiler names
 * every one of them.
 *
 * Note what the fall-through covers. `user_safes.execution_rail` is
 * `NOT NULL DEFAULT 'allowance_module'` (migration 036) with a CHECK over
 * exactly three values (migration 041), so `null` here means only one thing:
 * the LEFT JOIN in `FIND_EXECUTION_RAIL_FOR_AGENT_SQL` found no Safe row.
 * That case was documented as "→ legacy (fail-closed)". Post-#1986 the same
 * fall-through is *actually* fail-closed, which is why the guard is written
 * as "anything that is not delegation and not session" rather than as a
 * literal `=== 'allowance_module'` test: a scope read from the issue title
 * would have closed the string and left the null.
 */
export function resolveExecutionRail(state: ExecutionRailState): ExecutionRailDecision {
  if (state.safeExecutionRail === 'session_key') return { rail: 'retired_session' }
  if (state.safeExecutionRail === 'delegation') return { rail: 'delegation' }
  return { rail: 'retired_allowance' }
}

/** An intent's pinned rail, resolved through the same retirement seam. */
export function isRetiredRailIntent(executionRail: string | null | undefined): boolean {
  return executionRail === 'session_key'
}

/**
 * An intent pinned to the retired AllowanceModule rail (#1986).
 *
 * Same negative shape, and for the same reason, as `resolveExecutionRail`'s
 * fall-through: `payment_intents.execution_rail` is NULLABLE (migration 036)
 * and every legacy insert leaves it unset, so the population this has to
 * catch is mostly `null`, not the literal `'allowance_module'`. The one rail
 * that must NOT match is `delegation`, which `insertDelegationIntent` and
 * `modules/x402/delegation-authorize.ts` both pin explicitly — that pin is
 * what makes the negative safe, and the positive control in
 * `routes/__tests__/allowance-rail-retired.test.ts` is what proves it.
 *
 * `session_key` is excluded so the #834 tombstone keeps producing its own
 * message; both retirements coexist on the seam.
 */
export function isRetiredAllowanceIntent(executionRail: string | null | undefined): boolean {
  return executionRail !== 'delegation' && executionRail !== 'session_key'
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
 * The ONE producer of the AllowanceModule-rail refusal (#1986, epic #1440
 * slice 3) — the #834/#993 pattern applied to the legacy rail.
 *
 * Fail-closed contract, identical to `sessionRailRetired`: callers return
 * this VERBATIM with **nothing written** — no intent row, no approval row,
 * no funnel event, no relayer spend, no status flip.
 *
 * 410 rather than 403/404 for the same reason as #834 and #1328: a
 * permanently-gone flow must not read as a policy failure the caller can
 * retry out of, nor as a transient routing error.
 *
 * `'approval'` is the queued-approval case (historical: #2055 dropped the
 * `approval_requests` table outright). Every such row was
 * a legacy-rail artifact — the delegation rail has no approval queue at all
 * (its budget is enforced on-chain by the caveat enforcers), and all three
 * inserts (`insertPaymentApproval` / `insertSendApproval` /
 * `insertMachineApproval`) sit on legacy code paths — so a queued approval
 * can no longer become actionable.
 */
export function allowanceModuleRailRetired(kind: 'account' | 'intent' | 'approval'): {
  statusCode: 410
  body: { error: string }
} {
  const REONBOARD =
    'Re-onboard this account on the delegation rail (POST /accounts/hybrid, then grant a budget) to keep paying.'
  return {
    statusCode: 410,
    body: {
      error:
        kind === 'account'
          ? `The Safe rail is retired — this account can no longer pay. ${REONBOARD}`
          : kind === 'intent'
            ? 'The Safe rail is retired — this payment can no longer execute. ' +
              'Re-onboard the account on the delegation rail and authorize again.'
            : 'The Safe rail is retired — this queued approval can no longer be executed. ' +
              'It stays readable, and it can still be rejected.',
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

/**
 * True when a deserialized `prepared_user_op` is an erc7710 SETTLEMENT CHAIN
 * (`{ child, budget }`) rather than a UserOperation (#1482).
 *
 * The column is shared by two settlement schemes that store different things
 * in it, and both also set `delegation_hash` — so presence checks cannot tell
 * them apart. This lives here, beside `deserializeUserOp`, because the caller
 * that deserializes is the caller that needs to know what it got.
 */
export function isSettlementChainState(state: unknown): boolean {
  if (state === null || typeof state !== 'object') return false
  const s = state as Record<string, unknown>
  return s.child != null && s.budget != null
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
