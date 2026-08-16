/**
 * Small shared helpers for the x402 module (#996). Extracted verbatim from
 * `routes/x402.ts` — behavior unchanged, only the import depth moved (one
 * level deeper: `modules/x402/` vs `routes/`).
 */
import { getChainClient } from '../../infra/chain/index.js'
import { getIntentStatus } from '../../infra/repositories/payment-intents.js'
import { getX402HourlyUsage } from '../../infra/repositories/x402-authorizations.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import { AgentPaymentNextAction, AgentPaymentPhase, AgentPaymentRail } from '../../domain/agent-payment-taxonomy.js'
import type { X402ApprovalRow } from './types.js'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DECIMAL_ATOMIC_AMOUNT_RE = /^[0-9]+$/

export function isPositiveDecimalAtomicAmount(value: string): boolean {
  return DECIMAL_ATOMIC_AMOUNT_RE.test(value) && BigInt(value) > 0n
}

/**
 * Normalise an Ethereum address to its canonical EIP-55 checksum form.
 *
 * x402 payment-required headers are emitted by third-party services that may
 * ship malformed (non-checksummed or mis-cased) addresses. Skipping to the
 * lower-cased form first lets the checksum re-derive instead of validate, so
 * any 40-hex address (any casing) is accepted — see the `ChainClient` port
 * (#994) for why this goes through `normaliseAddress` and not a raw SDK call.
 */
export function normaliseAddress(addr: string): string {
  return getChainClient('allowance_module').normaliseAddress(addr)
}

export function chainIdFromX402Network(network: string): number | null {
  if (network === 'base') return 8453
  // #1471: 'base-sepolia' is a CANONICAL network identifier in the x402
  // spec's own NetworkSchema enum — real merchants send the bare literal, and
  // the SDK has always accepted it. Rejecting it here made the client call an
  // option payable and then 400 on it, which undercut #1453's promise that
  // selection is decided once and is trustworthy.
  if (network === 'base-sepolia') return 84532
  if (network.startsWith('eip155:')) {
    const chainId = Number(network.slice('eip155:'.length))
    return Number.isInteger(chainId) ? chainId : null
  }
  return null
}

/**
 * #961: the per-agent hourly x402 cap, enforced on EVERY rail. Returns the cap
 * when exceeded (caller 429s), null when within it. On the delegation rail
 * each authorize runs a sponsored bundler estimation, so this cap is also
 * sponsorship-cost protection (#717 surface), not just API hygiene.
 */
export async function agentHourlyX402CapExceeded(agentId: string): Promise<number | null> {
  const { maxPerHour, recentCount } = await getX402HourlyUsage(agentId)
  return recentCount >= maxPerHour ? maxPerHour : null
}

export async function currentPaymentIntentStatus(id: string, agent: AgentContext): Promise<string> {
  return getIntentStatus(id, agent.id)
}

export function x402MetadataNetwork(metadata: unknown): string | null {
  if (!metadata) return null
  const parsed = typeof metadata === 'string'
    ? (() => {
        try {
          return JSON.parse(metadata) as unknown
        } catch {
          return null
        }
      })()
    : metadata
  if (!parsed || typeof parsed !== 'object') return null
  const network = (parsed as { network?: unknown }).network
  return typeof network === 'string' ? network : null
}

export function existingX402IntentMismatch(
  existing: Record<string, unknown>,
  requested: {
    resourceUrl: string
    fundingTo: string
    merchantTo: string
    amountRaw: string
    tokenAddress: string
    network: string
    facilitatorAddresses?: string[]
  },
): string | null {
  const existingResource = existing.x402_resource_url ?? existing.payment_resource_url
  if (existingResource && existingResource !== requested.resourceUrl) return 'resource_url'

  const existingFundingTo = typeof existing.to_address === 'string' ? existing.to_address.toLowerCase() : null
  if (existingFundingTo && existingFundingTo !== requested.fundingTo.toLowerCase()) return 'funding_to'

  const existingMerchant = existing.x402_merchant_address ?? existing.merchant_address
  if (typeof existingMerchant === 'string' && existingMerchant.toLowerCase() !== requested.merchantTo.toLowerCase()) {
    return 'merchant_to'
  }

  if (existing.amount_raw && existing.amount_raw !== requested.amountRaw) return 'amount'

  const existingToken = typeof existing.token_address === 'string' ? existing.token_address.toLowerCase() : null
  if (existingToken && existingToken !== requested.tokenAddress.toLowerCase()) return 'asset'

  const existingNetwork = x402MetadataNetwork(existing.machine_metadata)
  if (existingNetwork && existingNetwork !== requested.network) return 'network'

  // #1058: a replay after the merchant rotated its advertised facilitators
  // would hand back a child pinned to the OLD redeemer — internally
  // consistent but dead on arrival at the merchant's matcher. 409 so the
  // client re-keys. 3009-mode state has no facilitators key; treat absent
  // and undefined as equal.
  const state = existing.prepared_user_op as { facilitatorAddresses?: string[] } | null | undefined
  const existingFacilitators = Array.isArray(state?.facilitatorAddresses) ? state.facilitatorAddresses : null
  const requestedFacilitators = requested.facilitatorAddresses ?? null
  if (JSON.stringify(existingFacilitators) !== JSON.stringify(requestedFacilitators)) {
    return 'facilitator_addresses'
  }

  return null
}

export function pendingApprovalResponse(
  approval: X402ApprovalRow,
  remainingHuman: string | null,
  context: {
    url: string
    merchantPayTo: string | null
    chainId: number
    amountAtomic: string
    asset: string
    network: string
    description?: string
    idempotencyKey?: string
  },
) {
  return {
    payment_id: approval.id,
    kind: 'approval_request',
    rail: AgentPaymentRail.X402,
    status: 'pending_approval',
    phase: AgentPaymentPhase.UserApprovalRequired,
    next_action: AgentPaymentNextAction.WaitForUserApproval,
    message:
      `This x402 funding payment of ${approval.amount_human} ${approval.token_symbol} is waiting for user approval in Haven. ` +
      'Do not start a new merchant session or create another payment; poll this payment id and resume the original x402 request after approval.',
    remaining: remainingHuman,
    requested: approval.amount_human,
    token: approval.token_symbol,
    resource_url: context.url,
    merchant_address: context.merchantPayTo,
    chain_id: context.chainId,
    amount_atomic: context.amountAtomic,
    asset: context.asset,
    network: context.network,
    description: context.description ?? null,
    idempotency_key: context.idempotencyKey ?? null,
    expires_at: approval.expires_at,
    challenge_id: approval.machine_challenge_id,
    x402: {
      amount_atomic: context.amountAtomic,
      asset: context.asset,
      network: context.network,
      resource_url: context.url,
      merchant_address: context.merchantPayTo,
      description: context.description ?? null,
      idempotency_key: context.idempotencyKey ?? null,
    },
  }
}
