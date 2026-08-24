/**
 * Top-level x402 authorize orchestration (#996, epic #980 M4). Extracted
 * verbatim from `routes/x402.ts`'s authorize handler: token resolution,
 * amount parsing, the #993 retired-rail refusal, and the delegation-vs-legacy
 * rail dispatch. `routes/x402.ts` keeps request validation, auth wiring, rate
 * limiting, and serialization; this is everything after structural
 * validation. Step numbering in comments matches the pre-#996 route.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { AgentContext } from '../../middleware/agentAuth.js'
import {
  allowanceModuleRailRetired,
  resolveExecutionRail,
  sessionRailRetired,
} from '../../rails/execution-rail.js'
import { resolvePaymentToken } from '../../domain/payment-token.js'
import { formatTokenValue } from '../../domain/tokens.js'
import { validateGenericSchemeRail } from './scheme-selection.js'
import { runDelegationAuthorize } from './delegation-authorize.js'
import type { X402HandlerResult, X402McpCallContextInput } from './types.js'

export interface AuthorizeX402Input {
  agent: AgentContext
  url: string
  payTo: string
  merchantPayTo?: string
  amount: string // atomic units, already validated as a positive decimal integer string
  asset: string
  network: string
  description?: string
  category?: string
  idempotencyKey?: string
  maxTimeoutSeconds?: number
  signature?: string
  settlementScheme?: string
  facilitatorAddresses?: string[]
  /** #1307: optional MCP merchant-call context, persisted for settle-leg rehydration. */
  mcpCallContext?: X402McpCallContextInput
  /** #1355: optional full 402 PaymentRequired, persisted for sign-leg rehydration. */
  paymentRequired?: Record<string, unknown>
  log?: FastifyBaseLogger
}

export async function authorizeX402(input: AuthorizeX402Input): Promise<X402HandlerResult> {
  const {
    agent, url, payTo, merchantPayTo, amount, asset, network, category,
    idempotencyKey, maxTimeoutSeconds, signature, settlementScheme, facilitatorAddresses,
    mcpCallContext, paymentRequired,
  } = input

  const genericSchemeError = validateGenericSchemeRail(agent, settlementScheme, facilitatorAddresses)
  if (genericSchemeError) return genericSchemeError

  // 2. Resolve token from asset address (shared with the MPP core).
  const tokenResult = resolvePaymentToken(agent.chain_id, asset)
  if (!tokenResult.ok) {
    return { code: 400, body: { error: tokenResult.error, supported: tokenResult.supported } }
  }
  // tokenAddress is the AllowanceModule token address (ZERO_ADDRESS for native).
  const { tokenConfig, tokenAddress } = tokenResult

  // 3. Parse amount (already in atomic units from x402)
  const amountRaw = BigInt(amount)

  // Human-readable amount for storage
  const amountHuman = formatTokenValue(amountRaw.toString(), tokenConfig.decimals)

  // #993 (review finding on #1120): the retired-rail refusal must hold on
  // EVERY money entry point, not just /payments — a session-marked account
  // previously slipped into the legacy AllowanceModule x402 flow below.
  const railDecision = resolveExecutionRail({
    safeExecutionRail: agent.execution_rail ?? null,
    chainId: agent.chain_id,
  })
  if (railDecision.rail === 'retired_session') {
    const retired = sessionRailRetired('account')
    return { code: retired.statusCode, body: retired.body }
  }
  // #1986 (epic #1440 slice 3): the legacy AllowanceModule x402 flow is
  // retired. This refusal sits ABOVE the delegation branch, so the Safe →
  // delegate funding leg never runs, no intent row and no approval row is
  // written, and the delegate never holds a hot balance for a rail that is
  // gone. The legacy flow itself was deleted in slice #1987
  // (`legacy-authorize.ts`).
  if (railDecision.rail === 'retired_allowance') {
    const retired = allowanceModuleRailRetired('account')
    return { code: retired.statusCode, body: retired.body }
  }

  // ── Delegation rail (#830, epic #821) — DIRECT settlement ──────────────
  // The agent's budget delegation IS the settlement instrument: the delegate
  // account re-delegates a narrowed slice (exact amount, payee pin, short
  // expiry) to the merchant, who redeems the [child, budget] chain. The
  // period budget is metered by the settlement itself — no funding leg, no
  // delegate hot balance, no sweep (epic #713's class is gone on this rail).
  //
  // This is the unconditional terminal case rather than a branch:
  // `ExecutionRailDecision` is exactly `delegation | retired_session |
  // retired_allowance` and both retired answers returned above, so the only
  // value that can reach this line is `delegation`.
  //
  // Read the seam's predicate in the right direction — it is a NEGATIVE, and
  // #1986 is emphatic about why. `resolveExecutionRail` answers `delegation`
  // ONLY for the literal `'delegation'`; every other value of
  // `agent.execution_rail ?? null` — including the `null` an account with no
  // Safe row carries, which is most of the retired population — falls through
  // to `retired_allowance` and is refused above. The exhaustion is what makes
  // this terminal safe; it is not a claim that unknown rails route here.
  return runDelegationAuthorize({
    agent, url, payTo, merchantPayTo, amountRaw, amountHuman, category, idempotencyKey,
    maxTimeoutSeconds, signature, settlementScheme, facilitatorAddresses, network, tokenConfig, tokenAddress,
    mcpCallContext, paymentRequired,
  })
}
