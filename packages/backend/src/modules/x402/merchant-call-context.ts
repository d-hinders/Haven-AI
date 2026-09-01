/**
 * GET /x402/:id/merchant-call-context — the settle-leg twin of #1263's
 * sign-context handoff (#1307).
 *
 * `haven_settle_mcp_tool` / `haven_complete_mcp_tool` need `merchant_url`,
 * `tool_name`, `arguments`, and `mcp_transport` to retry the MERCHANT's own
 * JSON-RPC call after funding — none of that is Haven payment authority, it
 * is where-and-how to redeliver a signed header. `haven_pay_mcp_tool` already
 * has all four at quote time; rather than have the agent copy them across
 * hosted tool calls, they are persisted on the intent row's
 * `machine_metadata` (the same JSONB blob `settlement_scheme` already lives
 * in — no migration) and re-served here by `payment_id`, agent-scoped.
 *
 * Trust model: this constructs nothing and authorizes nothing. A wrong or
 * missing value here fails the outbound merchant HTTP call; it cannot
 * redirect funds or alter the signed payment context, which is verified
 * independently (the delegate signature, the on-chain policy, and — for the
 * EIP-3009 header — the merchant's own facilitator).
 */
import { findIntentForAgent, expirePendingIntent } from '../../infra/repositories/payment-intents.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import type { X402HandlerResult, X402McpCallContextInput } from './types.js'

function parseMachineMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata) as Record<string, unknown>
    } catch {
      return null
    }
  }
  if (typeof metadata === 'object') return metadata as Record<string, unknown>
  return null
}

function storedMcpCallContext(metadata: unknown): X402McpCallContextInput | null {
  const parsed = parseMachineMetadata(metadata)
  const stored = parsed?.mcp_call_context
  if (!stored || typeof stored !== 'object') return null
  const candidate = stored as Record<string, unknown>
  if (typeof candidate.merchantUrl !== 'string' || typeof candidate.toolName !== 'string') return null
  return candidate as unknown as X402McpCallContextInput
}

export async function getX402MerchantCallContext(
  agent: AgentContext,
  paymentId: string,
): Promise<X402HandlerResult> {
  const existing = (await findIntentForAgent(paymentId, agent.id)) as Record<string, unknown> | null
  // Not found and not-yours are the same answer on purpose — same discipline
  // as GET /x402/:id/sign-context (#1263): an id enumerator learns nothing
  // about other agents' intents.
  if (!existing) {
    return { code: 404, body: { error: 'Payment intent not found' } }
  }
  if (!existing.x402_resource_url && !existing.payment_resource_url) {
    return {
      code: 409,
      body: {
        error:
          'Not an x402 intent — merchant-call-context serves the x402 merchant delivery handoff only.',
        error_code: 'merchant_call_context_unavailable',
      },
    }
  }
  if (existing.status === 'expired') {
    return {
      code: 410,
      body: {
        payment_id: existing.id,
        status: 'expired',
        error: 'Payment window expired — re-quote with haven_pay_mcp_tool using the same idempotency key',
        error_code: 'expired',
      },
    }
  }
  // Lazy-expire ONLY a still-pending row past its window (the #961/#1263
  // discipline) — a row that already moved past pending_signature (funding
  // submitted/confirmed) must stay servable however long merchant delivery
  // takes, or a legitimate retry after MERCHANT_UNRESPONSIVE_AFTER_FUNDING
  // would be forced to re-quote (and re-fund) a payment that already funded.
  if (existing.status === 'pending_signature' && new Date(existing.expires_at as string) < new Date()) {
    await expirePendingIntent(existing.id as string, agent.id)
    return {
      code: 410,
      body: {
        payment_id: existing.id,
        status: 'expired',
        error: 'Payment window expired — re-quote with haven_pay_mcp_tool using the same idempotency key',
        error_code: 'expired',
      },
    }
  }
  const stored = storedMcpCallContext(existing.machine_metadata)
  if (!stored) {
    return {
      code: 409,
      body: {
        payment_id: existing.id,
        error:
          'No stored merchant call context for this intent — pass merchant_url, tool_name, ' +
          'arguments, and mcp_transport explicitly (version-skew fallback).',
        error_code: 'merchant_call_context_unavailable',
      },
    }
  }
  return {
    code: 200,
    body: {
      payment_id: existing.id,
      merchant_url: stored.merchantUrl,
      tool_name: stored.toolName,
      arguments: stored.arguments ?? {},
      // #2343: convert the NESTED object too, not just the top-level fields.
      // The stored blob is camelCase throughout (`X402McpCallContextInput`,
      // and `storedMcpCallContext` validates it by reading `merchantUrl` /
      // `toolName`), while this endpoint's contract — and the hosted tool
      // boundary that consumes it — is snake_case. `merchant_url` and
      // `tool_name` were converted; `mcp_transport` was passed through
      // verbatim, so the wire carried a snake_case KEY with camelCase
      // INNARDS. The SDK then read `.handshake_required` as undefined and the
      // hosted `parseMcpTransport` refused Haven's own rehydrated value with
      // INVALID_INPUT — advising the caller to rename a key the caller never
      // sent, since the guided path settles with `{ payment_id, signature }`
      // and nothing else.
      ...(stored.mcpTransport
        ? {
            mcp_transport: {
              handshake_required: stored.mcpTransport.handshakeRequired,
              source: stored.mcpTransport.source,
            },
          }
        : {}),
    },
  }
}
