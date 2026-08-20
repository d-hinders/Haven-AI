import { verifyPaymentReceipt, type PaymentReceipt, type ReceiptVerification } from './receipt.js'
import type {
  AgentPaymentWarning,
  HavenAgent,
  HavenAgentAllowanceSummary,
  HavenAgentReadiness,
  HavenAgentSummary,
  HavenAllowanceSummary,
  HavenPaymentReceipt,
  PaymentStatusResult,
  PostPurchaseAllowanceSummary,
  RawHavenAgent,
  RawHavenAllowanceSummary,
  RawHavenPaymentReceiptsResponse,
} from './types.js'
import { AgentPaymentWarningCode } from './types.js'
import { HavenApiTransport } from './haven-api-transport.js'
import { mapPaymentReceipt } from './payment-mappers.js'
import { resolveTokenFromAddress } from './x402.js'

export type PaymentStatusReader = (paymentId: string) => Promise<PaymentStatusResult>

export interface AccountReadsOptions {
  transport: HavenApiTransport
  getPaymentStatus: PaymentStatusReader
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

function formatAtomicAmount(atomic: bigint, decimals: number): string {
  if (atomic < 0n) return '0.0'
  const value = atomic.toString().padStart(decimals + 1, '0')
  const whole = value.slice(0, value.length - decimals) || '0'
  const fraction = value.slice(value.length - decimals).replace(/0+$/, '') || '0'
  return `${whole}.${fraction}`
}

function deriveReadiness(
  status: string,
  allowances: ReadonlyArray<{ remainingAtomic: string }>,
): HavenAgentReadiness {
  if (status !== 'active') return 'revoked'
  return allowances.some((allowance) => safeBigInt(allowance.remainingAtomic) > 0n)
    ? 'ready'
    : 'needs_approval'
}

/**
 * Internal read-only account boundary for HavenClient.
 *
 * It owns authenticated account/allowance/receipt reads and intentionally has
 * no signer, merchant delivery, or payment-state mutation capability. Exported
 * from this module for direct tests and composition only; it is not exported by
 * the SDK entrypoint.
 */
export class AccountReads {
  private readonly transport: HavenApiTransport
  private readonly getPaymentStatus: PaymentStatusReader
  private agentInFlight: Promise<HavenAgent> | null = null

  constructor(options: AccountReadsOptions) {
    this.transport = options.transport
    this.getPaymentStatus = options.getPaymentStatus
  }

  async getAgent(): Promise<HavenAgent> {
    if (this.agentInFlight) return this.agentInFlight
    const request = this.fetchAgent()
    this.agentInFlight = request
    request.finally(() => {
      this.agentInFlight = null
    }).catch(() => {})
    return request
  }

  async getAgentSummary(): Promise<HavenAgentSummary> {
    const [agent, allowanceSummary] = await Promise.all([this.getAgent(), this.getAllowances()])
    const allowances: HavenAgentAllowanceSummary[] = allowanceSummary.allowances.map((allowance) => {
      const token = resolveTokenFromAddress(allowance.tokenAddress)
      const remainingDisplay = token
        ? `${formatAtomicAmount(safeBigInt(allowance.onchain.remaining), token.decimals)} ${allowance.tokenSymbol}`
        : `${allowance.onchain.remaining} ${allowance.tokenSymbol} (atomic; unknown decimals)`
      return {
        tokenSymbol: allowance.tokenSymbol,
        remainingAtomic: allowance.onchain.remaining,
        remainingDisplay,
        configuredAmount: allowance.configuredAmount,
        resetPeriodMin: allowance.resetPeriodMin,
        isResetPending: allowance.onchain.isResetPending,
      }
    })
    const readiness = deriveReadiness(agent.status, allowances)
    return { ...agent, readiness, spend_authority_readiness: readiness, allowances }
  }

  async getAllowances(): Promise<HavenAllowanceSummary> {
    const raw = await this.transport.get<RawHavenAllowanceSummary>('/machine-payments/allowances')
    return {
      agentId: raw.agent_id,
      safeAddress: raw.safe_address,
      delegateAddress: raw.delegate_address,
      chainId: raw.chain_id,
      allowances: raw.allowances.map((allowance) => ({
        id: allowance.id,
        tokenAddress: allowance.token_address,
        tokenSymbol: allowance.token_symbol,
        configuredAmount: allowance.configured_amount,
        resetPeriodMin: allowance.reset_period_min,
        onchain: {
          amount: allowance.onchain.amount,
          spent: allowance.onchain.spent,
          remaining: allowance.onchain.remaining,
          effectiveSpent: allowance.onchain.effective_spent,
          resetTimeMin: allowance.onchain.reset_time_min,
          lastResetMin: allowance.onchain.last_reset_min,
          nonce: allowance.onchain.nonce,
          isResetPending: allowance.onchain.is_reset_pending,
          remainingIsFromChain: allowance.onchain.remaining_is_from_chain,
        },
      })),
    }
  }

  async getPostPurchaseAllowanceSummary(paymentId: string): Promise<{
    allowance: PostPurchaseAllowanceSummary | null
    warnings: AgentPaymentWarning[]
    payment: PaymentStatusResult | null
  }> {
    const unavailable = (detail: string, payment: PaymentStatusResult | null = null) => ({
      payment,
      allowance: null,
      warnings: [{
        code: AgentPaymentWarningCode.AllowanceCheckUnavailable,
        message: `Could not read the post-purchase allowance/budget for payment ${paymentId} (${detail}). ` +
          'The payment itself succeeded — the on-chain policy remains the actual spend gate; this ' +
          'only affects the remaining-budget figure reported here.',
      }],
    })
    const [statusResult, agentResult, allowanceResult] = await Promise.allSettled([
      this.getPaymentStatus(paymentId), this.getAgent(), this.getAllowances(),
    ])
    if (statusResult.status === 'rejected') {
      return unavailable(statusResult.reason instanceof Error ? statusResult.reason.message : String(statusResult.reason))
    }
    const payment = statusResult.value
    if (agentResult.status === 'rejected') {
      return unavailable(agentResult.reason instanceof Error ? agentResult.reason.message : String(agentResult.reason), payment)
    }
    if (allowanceResult.status === 'rejected') {
      return unavailable(allowanceResult.reason instanceof Error ? allowanceResult.reason.message : String(allowanceResult.reason), payment)
    }
    try {
      const tokenAddress = payment.asset ?? payment.x402?.asset ?? null
      if (!tokenAddress) return unavailable('the settled payment does not carry a resolvable token address', payment)
      const match = allowanceResult.value.allowances.find(
        (allowance) => allowance.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
      )
      if (!match) return unavailable('no allowance/budget row matches the settled token', payment)
      const token = resolveTokenFromAddress(match.tokenAddress)
      const remainingDisplay = token
        ? `${formatAtomicAmount(safeBigInt(match.onchain.remaining), token.decimals)} ${match.tokenSymbol}`
        : undefined
      const rail = agentResult.value.executionRail
      return {
        payment,
        allowance: {
          rail,
          remaining_atomic: match.onchain.remaining,
          ...(remainingDisplay ? { remaining_display: remainingDisplay } : {}),
          token_symbol: match.tokenSymbol,
          token_address: match.tokenAddress,
          reset_period: match.resetPeriodMin,
          source: rail === 'delegation' ? 'active_delegations' : 'allowance_module',
        },
        warnings: [],
      }
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error))
    }
  }

  async listReceipts(options: { limit?: number } = {}): Promise<HavenPaymentReceipt[]> {
    const query = options.limit ? `?limit=${encodeURIComponent(String(options.limit))}` : ''
    const raw = await this.transport.get<RawHavenPaymentReceiptsResponse>(`/machine-payments/receipts${query}`)
    return raw.receipts.map(mapPaymentReceipt)
  }

  async getReceipt(paymentId: string): Promise<{ receipt: PaymentReceipt; verification: ReceiptVerification }> {
    const { receipt } = await this.transport.get<{ receipt: PaymentReceipt }>(`/payments/${paymentId}/receipt`)
    return { receipt, verification: verifyPaymentReceipt(receipt) }
  }

  private async fetchAgent(): Promise<HavenAgent> {
    const raw = await this.transport.get<RawHavenAgent>('/machine-payments/agent')
    return {
      id: raw.id,
      name: raw.name,
      status: raw.status,
      safeAddress: raw.safe_address,
      delegateAddress: raw.delegate_address,
      chainId: raw.chain_id,
      executionRail: raw.execution_rail === 'delegation' ? 'delegation' : 'legacy',
    }
  }
}
