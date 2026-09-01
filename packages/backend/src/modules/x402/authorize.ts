/**
 * Top-level x402 authorize orchestration (#996, epic #980 M4). Extracted
 * verbatim from `routes/x402.ts`'s authorize handler: the #993/#1986
 * retired-rail refusal, token resolution, amount parsing, and the
 * delegation-rail dispatch (#2274 put the rail refusal FIRST — see the
 * comment on the gate). `routes/x402.ts` keeps request validation, auth
 * wiring, rate limiting, and serialization; this is everything after
 * structural validation. Step numbering in comments matches the pre-#996
 * route, renumbered by #2274 to match the order the code now runs in.
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

  // #2245: NOTHING rail-dependent runs above the rail gate below. The
  // `validateGenericSchemeRail` call that stood here refused
  // `settlementScheme: 'erc7710'` / a present `facilitatorAddresses` from a
  // non-delegation account with a 400 whose body asserted that "the legacy
  // AllowanceModule rail settles via EIP-3009 only" — so one optional caller
  // field decided WHICH refusal a retired-rail account got, and the
  // alternative told it a rail #1986 fail-closes would settle its payment.
  // Deleted (`scheme-selection.ts` carries the full rationale); the only
  // scheme validation left is the delegation-rail-internal shape check inside
  // `runDelegationAuthorize`, which is where #946's real contract lives.
  //
  // Above the gate there is now only rail-INDEPENDENT input validation —
  // `routes/x402.ts`'s structural checks — the same position `POST /payments`
  // puts its gate in. None of it makes a claim about any rail, which is the
  // property that matters here. (#2245 wrote this as "the structural checks
  // AND the token/amount resolution below"; #2274 moved that resolution below
  // the gate on both routes, so the structural checks are all that is left.)

  // 2. Resolve the execution rail — ABOVE token resolution (#2274).
  //
  // #993 (review finding on #1120): the retired-rail refusal must hold on
  // EVERY money entry point, not just /payments — a session-marked account
  // previously slipped into the legacy AllowanceModule x402 flow below.
  //
  // #2274 moved it above token/amount resolution, on this route and on
  // `POST /payments` together. The resolution below answers "which assets can
  // you pay with"; for a retired-rail account the answer is none, on any
  // asset, so handing it a `supported: [...]` list first was a premature
  // answer to a question the 410 settles. Rail-INDEPENDENT residue left
  // deliberately by #2245 and filed as its own issue, because fixing one
  // route alone would have recreated exactly the asymmetry #2245 removed.
  //
  // What stays ABOVE the gate is `routes/x402.ts`'s structural validation —
  // the same bound `POST /payments` keeps, and the same one
  // `agentAuthMiddleware`'s 401 already holds.
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

  // 3. Resolve token from asset address (shared with the MPP core).
  const tokenResult = resolvePaymentToken(agent.chain_id, asset)
  if (!tokenResult.ok) {
    return { code: 400, body: { error: tokenResult.error, supported: tokenResult.supported } }
  }
  // tokenAddress is the AllowanceModule token address (ZERO_ADDRESS for native).
  const { tokenConfig, tokenAddress } = tokenResult

  // 4. Parse amount (already in atomic units from x402)
  const amountRaw = BigInt(amount)

  // Human-readable amount for storage
  const amountHuman = formatTokenValue(amountRaw.toString(), tokenConfig.decimals)

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
