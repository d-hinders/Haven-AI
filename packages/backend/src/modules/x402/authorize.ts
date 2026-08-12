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
import { resolveExecutionRail, sessionRailRetired } from '../../rails/execution-rail.js'
import { resolvePaymentToken } from '../../domain/payment-token.js'
import { formatTokenValue } from '../../domain/tokens.js'
import { validateGenericSchemeRail } from './scheme-selection.js'
import { runDelegationAuthorize } from './delegation-authorize.js'
import { runLegacyAuthorize } from './legacy-authorize.js'
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
  log?: FastifyBaseLogger
}

export async function authorizeX402(input: AuthorizeX402Input): Promise<X402HandlerResult> {
  const {
    agent, url, payTo, merchantPayTo, amount, asset, network, description, category,
    idempotencyKey, maxTimeoutSeconds, signature, settlementScheme, facilitatorAddresses,
    mcpCallContext, log,
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

  // ── Delegation rail (#830, epic #821) — DIRECT settlement ──────────────
  // The agent's budget delegation IS the settlement instrument: the delegate
  // account re-delegates a narrowed slice (exact amount, payee pin, short
  // expiry) to the merchant, who redeems the [child, budget] chain. The
  // period budget is metered by the settlement itself — no funding leg, no
  // delegate hot balance, no sweep (epic #713's class is gone on this rail).
  if (agent.execution_rail === 'delegation') {
    return runDelegationAuthorize({
      agent, url, payTo, merchantPayTo, amountRaw, amountHuman, category, idempotencyKey,
      maxTimeoutSeconds, signature, settlementScheme, facilitatorAddresses, network, tokenConfig, tokenAddress,
      mcpCallContext,
    })
  }

  return runLegacyAuthorize({
    agent, url, payTo, merchantPayTo, amountRaw, amountHuman, asset, network,
    description, category, idempotencyKey, signature, tokenConfig, tokenAddress, log,
    mcpCallContext,
  })
}
