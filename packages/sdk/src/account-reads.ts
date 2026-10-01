import { verifyPaymentReceipt, type PaymentReceipt, type ReceiptVerification } from './receipt.js'
import type {
  AgentPaymentWarning,
  HavenAgent,
  HavenAgentAllowanceSummary,
  HavenAgentReadiness,
  HavenAgentSummary,
  HavenAllowanceSummary,
  HavenBalanceCoverage,
  HavenPaymentReceipt,
  HavenPendingSubBudgetSignature,
  HavenSubBudget,
  HavenTaskBudget,
  HavenTaskBudgetSummary,
  PaymentStatusResult,
  PostPurchaseAllowanceSummary,
  RawHavenAgent,
  RawHavenAllowanceSummary,
  RawHavenBalanceCoverage,
  RawHavenPaymentReceiptsResponse,
  RawSubBudget,
  RawTaskBudget,
  HavenPaymentReceiptsPage,
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
 * #3128: the ONE function behind every `remainingDisplay` the SDK emits —
 * `HavenAllowance.remainingDisplay` and the bootstrap summary's field are the
 * same call on the same inputs.
 */
export function formatRemainingDisplay(tokenAddress: string, tokenSymbol: string, remainingAtomic: string): string {
  const token = resolveTokenFromAddress(tokenAddress)
  return token
    ? `${formatAtomicAmount(safeBigInt(remainingAtomic), token.decimals)} ${tokenSymbol}`
    : `${remainingAtomic} ${tokenSymbol} (atomic; unknown decimals)`
}

/**
 * #3410: atomic → human token amount, ONE formatter for every consent-surface
 * render (the same role `formatRemainingDisplay` plays for allowance reads).
 * `decimals` must come from `resolveTokenBySymbol` or
 * `resolveTokenFromAddress`; with neither resolving, the caller labels the
 * atomic string explicitly instead of guessing. A whole number carries no
 * trailing `.0` (`1000000` USDC atomic → `1`, matching connect's budget
 * phrasing, not `1.0`); a fraction keeps its significant digits (`0.5`).
 */
export function formatTokenAmount(atomic: string, decimals: number): string {
  const value = safeBigInt(atomic)
  if (value < 0n) return '0' // same guard formatAtomicAmount applies; budgets are never negative
  const digits = value.toString().padStart(decimals + 1, '0')
  const intPart = digits.slice(0, digits.length - decimals) || '0'
  const fracPart = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return fracPart ? `${intPart}.${fracPart}` : intPart
}

/** #3329: `RawTaskBudget` (snake_case wire) → `HavenTaskBudget` (camelCase). */
export function mapTaskBudget(raw: RawTaskBudget): HavenTaskBudget {
  return {
    id: raw.id,
    agentId: raw.agent_id,
    chainId: raw.chain_id,
    tokenAddress: raw.token_address,
    recipientAddress: raw.recipient_address,
    parentDelegationHash: raw.parent_delegation_hash,
    delegationHash: raw.delegation_hash,
    label: raw.label,
    maxAtomic: raw.max_atomic,
    // #3501: the wire keys are optional/present-when-read; the mapping
    // preserves presence exactly — absent stays absent, so a caller can
    // distinguish "this response did not read the chain" from "the read
    // failed" (null) and from a live figure.
    ...(raw.spent_atomic === undefined ? {} : { spentAtomic: raw.spent_atomic }),
    ...(raw.remaining_atomic === undefined ? {} : { remainingAtomic: raw.remaining_atomic }),
    ...(raw.remaining_is_from_chain === undefined ? {} : { remainingIsFromChain: raw.remaining_is_from_chain }),
    status: raw.status,
    expiresAt: raw.expires_at,
    isExpired: raw.is_expired,
    createdAt: raw.created_at,
    openedAt: raw.opened_at,
    closedAt: raw.closed_at,
    closeTxHash: raw.close_tx_hash,
  }
}

/** #3506: `RawSubBudget` (snake_case wire) → `HavenSubBudget` (camelCase). */
export function mapSubBudget(raw: RawSubBudget): HavenSubBudget {
  return {
    id: raw.id,
    agentId: raw.agent_id,
    parentAgentId: raw.parent_agent_id,
    parentSubBudgetId: raw.parent_sub_budget_id,
    chainId: raw.chain_id,
    tokenAddress: raw.token_address,
    recipientAddress: raw.recipient_address,
    parentDelegationHash: raw.parent_delegation_hash,
    delegationHash: raw.delegation_hash,
    label: raw.label,
    periodAmountAtomic: raw.period_amount_atomic,
    status: raw.status,
    expiresAt: raw.expires_at,
    isExpired: raw.is_expired,
    createdAt: raw.created_at,
    openedAt: raw.opened_at,
    closedAt: raw.closed_at,
    closeTxHash: raw.close_tx_hash,
  }
}

/** #3506: a sub-budget row owed a signature → the condensed row `getAgentSummary()` carries. */
function summarizePendingSubBudget(row: HavenSubBudget): HavenPendingSubBudgetSignature {
  const isParentChild = row.parentSubBudgetId === null
  return {
    subBudgetId: row.id,
    parentSubBudgetId: row.parentSubBudgetId,
    purpose: row.status === 'closing' ? 'close' : 'open',
    what: isParentChild ? 'parent-child' : 'grant',
    subAgentId: isParentChild ? null : row.agentId,
    tokenAddress: row.tokenAddress,
    recipientAddress: row.recipientAddress,
    periodAmountAtomic: row.periodAmountAtomic,
    expiresAt: row.expiresAt,
    isExpired: row.isExpired,
  }
}

/** #3329: `HavenTaskBudget` → the condensed row `getAgentSummary()` carries. */
function summarizeTaskBudget(taskBudget: HavenTaskBudget): HavenTaskBudgetSummary {
  const token = resolveTokenFromAddress(taskBudget.tokenAddress)
  const maxDisplay = token
    ? `${formatAtomicAmount(safeBigInt(taskBudget.maxAtomic), token.decimals)} ${token.symbol}`
    : `${taskBudget.maxAtomic} (atomic; unknown decimals)`
  // #3501: the display form rides beside the atomic one, derived by the SAME
  // formatter as `maxDisplay` — one arithmetic, no drift between max and
  // remaining. Null atomic (failed read) maps to null display, never "0" or
  // the cap; an unknown token spells the atomic figure out explicitly
  // instead of guessing decimals.
  const spendDisplay = (atomic: string | null): string | null => {
    if (atomic === null) return null
    return token
      ? `${formatAtomicAmount(safeBigInt(atomic), token.decimals)} ${token.symbol}`
      : `${atomic} (atomic; unknown decimals)`
  }
  return {
    id: taskBudget.id,
    label: taskBudget.label,
    tokenAddress: taskBudget.tokenAddress,
    maxAtomic: taskBudget.maxAtomic,
    maxDisplay,
    // The GET route only enriches OPEN rows, and the list the summary feeds
    // keeps closed/expired rows out (below), so a mapped row is an OPEN one
    // whenever the backend deployed this far. An older backend without the
    // figures maps to the honest degraded shape (null figures, false flag),
    // which is also exactly what a backend whose live read failed reports:
    // "unknown", never optimistic.
    spentAtomic: taskBudget.spentAtomic ?? null,
    remainingAtomic: taskBudget.remainingAtomic ?? null,
    remainingIsFromChain: taskBudget.remainingIsFromChain ?? false,
    remainingDisplay: spendDisplay(taskBudget.remainingAtomic ?? null),
    recipientAddress: taskBudget.recipientAddress,
    expiresAt: taskBudget.expiresAt,
    // #3518: lifecycle status + derived expiry ride the summary — a
    // close/pending row must be visible AS closing/pending, not silently
    // dropped from the agent read.
    status: taskBudget.status,
    isExpired: taskBudget.isExpired,
  }
}

/** #3423: a receipts-list row without its payload echoes (see `listReceiptsPage({ compact })`). */
function compactReceipt(receipt: HavenPaymentReceipt): HavenPaymentReceipt {
  const row: HavenPaymentReceipt = { ...receipt }
  delete row.challengePayload
  delete row.selectedPayment
  delete row.protocolReceiptPayload
  return row
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
    const [agent, allowanceSummary, taskBudgets, pendingSubBudgetSignatures] = await Promise.all([
      this.getAgent(),
      this.getAllowances(),
      this.listTaskBudgetsSummary(),
      // #3506: fails SOFT in the summary (the owner-issued sign targets are
      // additive, never the reason the whole bootstrap fails).
      this.listPendingSubBudgetSignatures().catch((): HavenPendingSubBudgetSignature[] => []),
    ])
    // #3128: every field here is the HavenAllowance's own (or, for the display
    // string, derived by the same function `getAllowances` used), so the two
    // reads cannot disagree for the same fixture.
    const allowances: HavenAgentAllowanceSummary[] = allowanceSummary.allowances.map((allowance) => {
      return {
        id: allowance.id,
        tokenSymbol: allowance.tokenSymbol,
        tokenAddress: allowance.tokenAddress,
        remainingAtomic: allowance.onchain.remaining,
        remainingDisplay: allowance.remainingDisplay,
        configuredAmount: allowance.configuredAmount,
        resetPeriodMin: allowance.resetPeriodMin,
        isResetPending: allowance.onchain.isResetPending,
      }
    })
    const readiness = deriveReadiness(agent.status, allowances)
    return { ...agent, readiness, spend_authority_readiness: readiness, allowances, taskBudgets, pendingSubBudgetSignatures }
  }

  /**
   * #3329: `GET /task-budgets?status=open`, mapped to the condensed summary
   * row `getAgentSummary()` carries. Fails SOFT per the #3093 rule (default
   * every array wire key to `[]` so an absent/malformed key degrades instead
   * of taking the route down): a 404 (a backend that predates #3329's
   * route), ANY other transport error, an undefined/null body, or a missing
   * or non-array `task_budgets` key all return `[]` rather than throwing —
   * `getAgentSummary`'s identity + readiness + allowances fields are what
   * callers depend on, and this read must never be why the whole summary
   * fails.
   *
   * #3518: the query is `status=all` now. The close refusal tells the caller
   * to RE-CHECK the budget's status, and `haven_get_agent` is the read an
   * agent is holding — so a `closing` (or `pending`) budget must appear
   * there with its status, not vanish the moment its close starts. Every
   * row carries `status` (+ `isExpired`) so the reader distinguishes them;
   * the soft-fail contract is unchanged.
   *
   * #3518 boundedness: `status=all` answers EVERY row this agent ever held —
   * closed and long-expired included (the repository's all-branch has no
   * window at all), so mapping it verbatim would grow `haven_get_agent`
   * without bound. The list filters CLIENT-SIDE to the rows an agent can
   * still act on, and read-by-id (`haven_get_task_budget`) is the any-status
   * surface for everything else:
   *
   * - `closing` ALWAYS stays visible, expired or not — the close submit is
   *   in flight and the signer's close refusal tells the caller to re-check
   *   exactly this row's status;
   * - `closed` rows drop (terminal — `closed_at` names what happened, and
   *   the read-by-id tool answers any status);
   * - a non-closing row past its `expires_at` drops (an expired open budget
   *   reserves nothing and pays nothing) — the backend's `is_expired` is
   *   derived from the same field, so the filter agrees with what the wire
   *   would have said;
   * - `pending` and live `open` rows stay, whatever their expiry.
   *
   * A row whose wire carries no `is_expired` is treated as unexpired — the
   * degraded read errs toward KEEPING rows, never toward hiding one the
   * agent could still act on. (No deployed backend has that shape: `status`
   * and `is_expired` landed together in #3329's wire.)
   */
  private async listTaskBudgetsSummary(): Promise<HavenTaskBudgetSummary[]> {
    try {
      const raw = await this.transport.get<{ task_budgets?: RawTaskBudget[] } | null | undefined>(
        '/task-budgets?status=all',
      )
      const rows = raw?.task_budgets
      if (!Array.isArray(rows)) return []
      // The boundedness filter (comment above): closing rows always ride;
      // closed and expired rows drop.
      return rows
        .map((row) => mapTaskBudget(row))
        .filter((tb) => tb.status === 'closing' || (!tb.isExpired && tb.status !== 'closed'))
        .map((tb) => summarizeTaskBudget(tb))
    } catch {
      // #3093: any transport failure (404, network error, malformed body) —
      // never let it fail the agent summary this feeds.
      return []
    }
  }

  /**
   * #3506: `GET /sub-budgets?status=awaiting_signature` — the sub-budget rows
   * THIS agent (as the delegating agent) must still sign, mapped to the
   * condensed summary rows. A transport error THROWS here (a caller that
   * reasons from "nothing is pending" must be able to tell that from "the
   * read failed"); `getAgentSummary()` wraps it soft, like the task-budget
   * read (#3093), so an old backend's 404 never fails the bootstrap. A
   * missing or non-array body is `[]`.
   */
  async listPendingSubBudgetSignatures(): Promise<HavenPendingSubBudgetSignature[]> {
    const raw = await this.transport.get<{ sub_budgets?: RawSubBudget[] } | null | undefined>(
      '/sub-budgets?status=awaiting_signature',
    )
    const rows = raw?.sub_budgets
    if (!Array.isArray(rows)) return []
    return rows.map((row) => summarizePendingSubBudget(mapSubBudget(row)))
  }

  async getAllowances(): Promise<HavenAllowanceSummary> {
    const raw = await this.transport.get<RawHavenAllowanceSummary>('/machine-payments/allowances')
    return {
      agentId: raw.agent_id,
      // `account_address` is required on the wire contract, so the declared
      // type stays `string`; a server that omits it is off-contract and the
      // cast is the one place that case is allowed through as `undefined`
      // rather than a fabricated `''` (a present-but-blank address downstream
      // — the hosted MCP output spreads this object, and the sweep uses it as
      // a destination).
      accountAddress: raw.account_address as string,
      delegateAddress: raw.delegate_address,
      chainId: raw.chain_id,
      allowances: raw.allowances.map((allowance) => ({
        id: allowance.id,
        tokenAddress: allowance.token_address,
        tokenSymbol: allowance.token_symbol,
        configuredAmount: allowance.configured_amount,
        resetPeriodMin: allowance.reset_period_min,
        // #3518: scope + Haven-side reservation, additive — undefined on an
        // older backend whose rows do not carry them.
        ...(allowance.delegation_hash !== undefined ? { delegationHash: allowance.delegation_hash } : {}),
        ...(allowance.recipient_address !== undefined ? { recipientAddress: allowance.recipient_address } : {}),
        ...(allowance.merchant_id !== undefined ? { merchantId: allowance.merchant_id } : {}),
        ...(allowance.reserved_haven_atomic !== undefined
          ? { reservedHavenAtomic: allowance.reserved_haven_atomic }
          : {}),
        remainingDisplay: formatRemainingDisplay(allowance.token_address, allowance.token_symbol, allowance.onchain.remaining),
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

  /**
   * #3126 — the sufficiency signal behind {@link HavenBalanceCoverage}.
   *
   * Deliberately NOT a balance read: the endpoint answers whether the
   * account HOLDS at least the checked amount, as `covered
   * true/false/null`, and never returns the balance itself. The camelCase
   * mapping is permissive (raw fields flow through; the server owns the
   * wire shape, pinned by the backend's `expectMatchesSpec` assertion), so
   * an older server that has not deployed the endpoint surfaces its 404 as
   * a thrown error rather than a fabricated answer.
   */
  async checkFunds(input: { token: string; amountAtomic: string }): Promise<HavenBalanceCoverage> {
    const query = `token=${encodeURIComponent(input.token)}&amount_atomic=${encodeURIComponent(input.amountAtomic)}`
    const raw = await this.transport.get<RawHavenBalanceCoverage>(
      `/machine-payments/balance-coverage?${query}`,
    )
    return {
      covered: raw.covered,
      ...(raw.coverage_error !== undefined ? { coverageError: raw.coverage_error } : {}),
      chainId: raw.chain_id,
      tokenAddress: raw.token_address,
      tokenSymbol: raw.token_symbol,
      checkedAmountAtomic: raw.checked_amount_atomic,
      budgetRemainingAtomic: raw.budget_remaining_atomic,
      ...(raw.budget_remaining_is_from_chain !== undefined
        ? { budgetRemainingIsFromChain: raw.budget_remaining_is_from_chain }
        : {}),
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
      // #3518: report the budget that PAID, never a re-derived first match.
      // The payment status carries `budgetDelegationHash` (recorded at
      // authorize, migration 053) — the allowance row whose
      // `delegationHash` equals it is the one whose remaining figure is
      // honest here. Re-deriving (token, payee) selection at settle time is
      // wrong twice over: the grants' window can have moved between pay and
      // settle, and task/sub-budget payments meter their PARENT by hash
      // while the payee matches no pin at all. The token match below is the
      // fallback for an older backend whose status predates the field — the
      // old first-match behaviour, kept only where nothing better exists.
      const tokenRows = allowanceResult.value.allowances.filter(
        (allowance) => allowance.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
      )
      const payingHash = payment.budgetDelegationHash ?? null
      const match =
        (payingHash && tokenRows.find((allowance) => allowance.delegationHash === payingHash)) ||
        tokenRows[0] ||
        null
      if (!match) return unavailable('no allowance/budget row matches the settled token', payment)
      // #3464: the ONE shared formatter — `haven_get_agent`'s allowances[]
      // rows use the same `formatRemainingDisplay` call, so the settle summary
      // can never omit or disagree with the display figure get_agent emits
      // for the same fixture (an unknown-decimals token gets the same explicit
      // atomic label instead of a missing field).
      const remainingDisplay = formatRemainingDisplay(match.tokenAddress, match.tokenSymbol, match.onchain.remaining)
      // #1986/#2020 proven by exhaustion: a retired-rail account is refused
      // (410) by GET /machine-payments/allowances BEFORE this read completes,
      // so `executionRail` can only be 'delegation' here — narrowed at the
      // mapping, not at the public HavenAgent.executionRail type (#3464).
      const rail = agentResult.value.executionRail
      if (rail !== 'delegation') {
        return unavailable(`the account's rail ('${rail}') cannot have a settled x402 payment`, payment)
      }
      return {
        payment,
        allowance: {
          rail,
          remaining_atomic: match.onchain.remaining,
          // Deprecated spellings (#3464): kept for the deprecation window;
          // removal condition on the type's JSDoc.
          remaining_display: remainingDisplay,
          token_symbol: match.tokenSymbol,
          token_address: match.tokenAddress,
          reset_period: match.resetPeriodMin,
          source: 'active_delegations',
          // The canonical spellings — the SAME names and values
          // `haven_get_agent`'s allowances[] rows report.
          remainingAtomic: match.onchain.remaining,
          remainingDisplay,
          resetPeriodMin: match.resetPeriodMin,
          tokenSymbol: match.tokenSymbol,
          tokenAddress: match.tokenAddress,
        },
        warnings: [],
      }
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error))
    }
  }

  /** The first page's receipts as a bare array — the pre-#3128 shape, kept for callers that never page. */
  async listReceipts(options: { limit?: number } = {}): Promise<HavenPaymentReceipt[]> {
    return (await this.listReceiptsPage(options)).receipts
  }

  /** #3128: one page with `total`, `hasMore` and `nextCursor` — see {@link HavenPaymentReceiptsPage}. */
  async listReceiptsPage(
    options: { limit?: number; cursor?: string; compact?: boolean } = {},
  ): Promise<HavenPaymentReceiptsPage> {
    const params = new URLSearchParams()
    if (options.limit) params.set('limit', String(options.limit))
    if (options.cursor) params.set('cursor', options.cursor)
    const query = params.size > 0 ? `?${params.toString()}` : ''
    const raw = await this.transport.get<RawHavenPaymentReceiptsResponse>(`/machine-payments/receipts${query}`)
    const receipts = raw.receipts.map(mapPaymentReceipt)
    return {
      // #3423 (owner decision, opt-in): `compact` drops the three bulky
      // payload echoes (the merchant's full 402 challenge, the selected
      // option, and the merchant's PAYMENT-RESPONSE) from each row. The keys
      // are absent, not null, and the default shape is unchanged.
      receipts: options.compact ? receipts.map(compactReceipt) : receipts,
      total: typeof raw.total === 'number' ? raw.total : null,
      hasMore: typeof raw.has_more === 'boolean' ? raw.has_more : null,
      nextCursor: typeof raw.next_cursor === 'string' ? raw.next_cursor : null,
    }
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
      // See the comment on `getAllowances` above: `account_address` is
      // required on the wire contract, so an omission here is off-contract
      // and comes through as `undefined` rather than a fabricated `''`.
      accountAddress: raw.account_address as string,
      delegateAddress: raw.delegate_address,
      chainId: raw.chain_id,
      executionRail: raw.execution_rail === 'delegation' ? 'delegation' : 'legacy',
    }
  }
}
