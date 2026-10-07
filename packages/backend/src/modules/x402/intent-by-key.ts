/**
 * GET /x402/by-idempotency-key/:key — agent-scoped, READ-ONLY lookup of an
 * x402 intent by its idempotency key (#3739).
 *
 * The hosted pay tool's request mode checks this BEFORE re-probing a merchant,
 * so a replayed call never depends on the merchant still answering. Never
 * writes: a stale `pending_signature` row is reported with `window_open:
 * false`, not lazily expired (the authorize replay and sign-context own that).
 *
 * Not-found and not-yours are the same answer, because the lookup is scoped by
 * `agent.id` in the query itself.
 */
import type { AgentContext } from '../../middleware/agentAuth.js'
import { findX402IntentByIdempotencyKey } from '../../infra/repositories/x402-authorizations.js'
import { x402MetadataNetwork } from './helpers.js'
import type { X402HandlerResult } from './types.js'

function parseObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * `machine_metadata.settlement_scheme` first (written at authorize on both
 * legs); rows without it fall back to the stored settlement state's shape —
 * an erc7710 `{child, budget}` pair. Anything else is unknown (null).
 */
function settlementSchemeOf(row: Record<string, unknown>): 'erc7710' | 'eip3009' | null {
  const scheme = parseObject(row.machine_metadata)?.settlement_scheme
  if (scheme === 'erc7710' || scheme === 'eip3009') return scheme
  const state = parseObject(row.prepared_user_op)
  if (state?.child && state?.budget) return 'erc7710'
  return null
}

function toIso(value: unknown): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value as string)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export async function getX402IntentByIdempotencyKey(
  agent: AgentContext,
  idempotencyKey: string,
): Promise<X402HandlerResult> {
  const row = (await findX402IntentByIdempotencyKey(agent.id, idempotencyKey)) as unknown as
    | Record<string, unknown>
    | null
  if (!row) {
    return { code: 404, body: { error: 'No x402 payment found for this idempotency key' } }
  }
  const expiresAt = toIso(row.expires_at)
  const windowOpen =
    row.status === 'pending_signature' && expiresAt !== null && new Date(expiresAt).getTime() > Date.now()
  const network =
    x402MetadataNetwork(row.machine_metadata) ??
    `eip155:${(row.chain_id as number | null) ?? agent.chain_id}`
  return {
    code: 200,
    body: {
      payment_id: row.id,
      status: row.status,
      settlement_scheme: settlementSchemeOf(row),
      resource_url: (row.x402_resource_url ?? row.payment_resource_url ?? null) as string | null,
      expires_at: expiresAt,
      window_open: windowOpen,
      task_budget_id: (row.task_budget_id as string | null | undefined) ?? null,
      amount_atomic: String(row.amount_raw),
      network,
    },
  }
}
