/**
 * `POST /send` orchestration (#997, epic #980 M4) — the plain-transfer flow
 * (asset/recipient naming convention, distinct from the challenge-based mpp
 * rails).
 *
 * #1987 (epic #1440): the AllowanceModule rail is retired and every account
 * that could once reach the body below now hits one of the three refusals —
 * `retired_session`, `retired_allowance`, or `delegation` (which /send never
 * supported to begin with, #1251). `resolveExecutionRail` only ever returns
 * one of those three values, so the refusals are now the entire function,
 * not a gate in front of one. The asset-resolution / idempotency-replay /
 * on-chain-allowance / transfer-hash / intent-storage body that used to
 * follow (see git history, or PR #2005 which staged this as a fail-closed
 * 410 without deleting the body yet) is gone — it was unreachable dead code
 * once the three refusals covered every rail.
 */
import {
  allowanceModuleRailRetired,
  mppNotOnDelegationRail,
  resolveExecutionRail,
  sessionRailRetired,
} from '../../rails/execution-rail.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import type { MppHandlerResult, SendAsset, SendBody } from './types.js'

/**
 * `POST /send` orchestration. `routes/machine-payments.ts` validates request
 * shape (asset enum, recipient address, amount, idempotency_key length) and
 * hands the parsed fields here.
 */
export async function handleSend(
  agent: AgentContext,
  asset: SendAsset,
  recipient: string,
  amount: string,
  idempotencyKey: string | undefined,
): Promise<MppHandlerResult> {
  // #993 (review finding on #1120): the retired-rail refusal must hold on
  // EVERY money entry point — /send previously never consulted the seam.
  const sendRail = resolveExecutionRail({
    safeExecutionRail: agent.execution_rail ?? null,
    chainId: agent.chain_id,
  })
  if (sendRail.rail === 'retired_session') {
    const retired = sessionRailRetired('account')
    return { statusCode: retired.statusCode, body: retired.body }
  }
  // #1986: /send does not itself call `executeAllowanceTransfer` — it mints a
  // `pending_signature` intent (or an over-allowance approval row) and hands
  // back sign_data, and `/payments/:id/sign` executes. Both ends refuse, and
  // this end matters independently: without it the route would still WRITE
  // rows and hand an agent signing instructions for a payment that can never
  // execute, which is the opposite of fail-closed-with-nothing-written.
  if (sendRail.rail === 'retired_allowance') {
    const retired = allowanceModuleRailRetired('account')
    return { statusCode: retired.statusCode, body: retired.body }
  }
  // #1251: same refusal as authorize — see the note there. Raw-state check,
  // like payments.ts. Delegation accounts send via POST /payments (direct
  // delegation redemption). This is now the terminal branch: `sendRail.rail`
  // is exhaustively `retired_session | retired_allowance | delegation`, so
  // every account that reaches here is on the delegation rail and every
  // delegation-rail account is refused — there is no fourth path left to
  // fall through to.
  const refusal = mppNotOnDelegationRail()
  return { statusCode: refusal.statusCode, body: refusal.body }
}
