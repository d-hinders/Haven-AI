/**
 * Local (stdio) MCP tool handlers. This package runs in the AGENT OPERATOR'S
 * OWN environment — it reads the local credential file and signs locally; the
 * hosted backend is not in the loop for the merchant call. So `merchant_url`
 * passed to `haven.fetch` below is NOT an SSRF surface: the agent is the
 * principal paying a merchant IT chose, on its own machine — the same trust
 * position as running `curl`. There is no server reflecting attacker input
 * into an internal request. (Hosted, multi-tenant fetches live in mcp-server,
 * which is where URL-hardening would matter.)
 */
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  HavenApiError,
  HavenClient,
  HavenError,
  HavenPaymentStateError,
  HavenSigningError,
  MerchantEgressRefusedError,
  catalogFundingLegExpected,
  composeDescription,
  discoverMerchantMcpUrl,
  replaceSettlementEvidenceMessage,
  sameUrl,
  selectErc7710PaymentOption,
  selectStandardPaymentOption,
  toolDescriptions as sharedDescriptions,
  verifyPaymentReceipt,
  x402AuthorizationAmount,
  type HavenAgent,
  type HavenClientUpdate,
  type PaymentReceipt,
  type X402PaymentOption,
  type X402Quote,
  type X402ResumeState,
} from '@haven_ai/sdk'
import { z } from 'zod/v3'

const headersSchema = z.record(z.string(), z.string()).optional()

/**
 * #3967: the option pay will actually authorize for this agent — the same
 * #1450/#2051 preference rule the hosted quote's `selectedSettlement` runs
 * (delegation rail prefers erc7710, standard entry otherwise). Re-declared
 * here because `@haven_ai/mcp` cannot import `@haven_ai/mcp-server` support.
 */
function selectQuoteOption(
  accepts: X402PaymentOption[],
  agent: HavenAgent,
): X402PaymentOption | null {
  if (agent.executionRail === 'delegation') {
    const erc7710 = selectErc7710PaymentOption(accepts)
    if (erc7710) return erc7710
  }
  return selectStandardPaymentOption(accepts)
}

/**
 * #3967: human decimal → atomic, mirroring `cap-price.ts`'s `humanToAtomic`
 * (same regex, same excess-precision null). Re-declared for the same reason —
 * the hosted helper is mcp-server support, and the local surface ships alone.
 */
function humanDecimalToAtomic(human: string, decimals: number): bigint | null {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(human)
  if (!match) return null
  const fraction = match[2] ?? ''
  if (fraction.length > decimals) return null
  return BigInt(match[1] + fraction.padEnd(decimals, '0'))
}

/**
 * #4830: why a stated `expected_amount` could NOT be compared. Mirrors the
 * hosted `ExpectedAmountNotComparedCause` (mcp-server support cannot be
 * imported here) — same four causes, same next-step rule: a transient read
 * failure is worth one re-quote, everything else is deterministic and stops.
 */
type ExpectedAmountNotComparedCause =
  | 'agent_read_failed'
  | 'agent_read_refused'
  | 'no_option_selected'
  | 'unknown_decimals'

/** #4830: the comparison's outcome — a decision, or an honest "not made". */
type ExpectedAmountComparison =
  | { kind: 'compared'; differs: boolean }
  | { kind: 'not_compared'; cause: ExpectedAmountNotComparedCause }

/** #4830: the AUTHORIZATION amount of one option, or null when unpayable data. */
function authorizationAmountOf(option: X402PaymentOption): bigint | null {
  try {
    return BigInt(x402AuthorizationAmount(option))
  } catch {
    return null
  }
}

/** #4830: the cause of a failed agent read, decided the way `normalizeError` does. */
function notComparedCauseForReadError(error: unknown): ExpectedAmountNotComparedCause {
  if (error instanceof HavenApiError) {
    const status = error.statusCode
    if (status === 401 || status === 403) return 'agent_read_refused'
  }
  return 'agent_read_failed'
}

/**
 * #4830 — the local twin of the hosted `compareExpectedAmount`. Same decision
 * procedure, with the local surface's own option selector: the agent read only
 * chooses BETWEEN the merchant's erc7710 and standard options, so when that
 * choice cannot change the answer (one option, equal amounts, or a stated
 * price equal to neither) the comparison is decided WITHOUT the read. When it
 * genuinely cannot be made the result says so instead of answering as if no
 * expectation had been stated.
 *
 * A stated price finer than the token's scale cannot equal any option amount,
 * so it is a decided mismatch — hosted parity, which the local surface used to
 * skip silently.
 */
function compareExpectedAmountLocal(input: {
  accepts: X402PaymentOption[]
  decimals: number | null
  expectedAmount: string
  agent: HavenAgent | undefined
  agentError: unknown
}): ExpectedAmountComparison {
  const { accepts, decimals, expectedAmount, agent, agentError } = input
  if (decimals === null) return { kind: 'not_compared', cause: 'unknown_decimals' }
  const expectedAtomic = humanDecimalToAtomic(expectedAmount, decimals)
  if (expectedAtomic === null) return { kind: 'compared', differs: true }

  if (agent) {
    const option = selectQuoteOption(accepts, agent)
    if (!option) return { kind: 'not_compared', cause: 'no_option_selected' }
    const amount = authorizationAmountOf(option)
    if (amount === null) return { kind: 'not_compared', cause: 'no_option_selected' }
    return { kind: 'compared', differs: amount !== expectedAtomic }
  }

  const candidates: X402PaymentOption[] = []
  const erc7710 = selectErc7710PaymentOption(accepts)
  if (erc7710) candidates.push(erc7710)
  const standard = selectStandardPaymentOption(accepts)
  if (standard && standard !== erc7710) candidates.push(standard)
  if (candidates.length === 0) return { kind: 'not_compared', cause: 'no_option_selected' }
  const amounts = candidates.map(authorizationAmountOf)
  if (amounts.some((amount) => amount === null)) {
    return { kind: 'not_compared', cause: notComparedCauseForReadError(agentError) }
  }
  const decided = amounts as bigint[]
  if (decided.length === 1) return { kind: 'compared', differs: decided[0] !== expectedAtomic }
  if (decided[0] === decided[1]) return { kind: 'compared', differs: decided[0] !== expectedAtomic }
  if (expectedAtomic !== decided[0] && expectedAtomic !== decided[1]) {
    return { kind: 'compared', differs: true }
  }
  return { kind: 'not_compared', cause: notComparedCauseForReadError(agentError) }
}

/** #4830: the next step a not-compared quote carries, decided by the CAUSE. */
function notComparedNextAction(cause: ExpectedAmountNotComparedCause): AgentPaymentNextAction {
  return cause === 'agent_read_failed'
    ? AgentPaymentNextAction.RetryWithExplicitContext
    : AgentPaymentNextAction.StopAndTellUser
}

/** #4830: why no tool follows a not-compared quote. */
function notComparedOmittedReason(cause: ExpectedAmountNotComparedCause): string {
  switch (cause) {
    case 'agent_read_failed':
      return (
        'no Haven tool follows yet: the price could not be compared because the agent read ' +
        'failed — re-quote once with the same arguments before telling the user'
      )
    case 'agent_read_refused':
      return (
        'no Haven tool follows: the agent read was refused, so the price could not be ' +
        'compared — tell the user what failed'
      )
    case 'no_option_selected':
      return (
        'no Haven tool follows: no payment option this agent can pay was selected, so the ' +
        'price could not be compared — tell the user'
      )
    case 'unknown_decimals':
      return (
        "no Haven tool follows: the quote's token is not one Haven recognises, so the price " +
        'could not be compared — tell the user'
      )
  }
}

/**
 * #4830: the prose for a not-compared quote — it says the comparison was NOT
 * made and why, never that the price differs, and never the deposit-address
 * fallback (that remedy belongs to a challenge found WRONG).
 */
function notComparedReason(
  expectedAmount: string,
  cause: ExpectedAmountNotComparedCause,
): string {
  const opening =
    `The merchant's quoted price was NOT compared with the expected price (${expectedAmount}) ` +
    'stated with this quote: '
  const closing = ' No comparison was made — this says nothing about whether the price matches.'
  switch (cause) {
    case 'agent_read_failed':
      return (
        opening +
        "the agent's account could not be read from Haven, and the merchant's payment options " +
        'carry different amounts, so which one this agent would pay is unknown.' +
        closing +
        ' Re-quote once with the same arguments; if the read still fails, stop and tell the ' +
        'user before any payment.'
      )
    case 'agent_read_refused':
      return (
        opening +
        "the agent's account read was refused by Haven, and the merchant's payment options " +
        'carry different amounts, so which one this agent would pay is unknown.' +
        closing +
        ' Stop and tell the user before any payment; re-quoting the same way cannot succeed.'
      )
    case 'no_option_selected':
      return (
        opening +
        "no payment option this agent can pay was selected from the merchant's offer, so the " +
        'amount this agent would authorize is unknown.' +
        closing +
        ' Stop and tell the user before any payment.'
      )
    case 'unknown_decimals':
      return (
        opening +
        "the quote's token is not one Haven recognises, so its decimals are unknown and the " +
        "stated price cannot be converted to the token's atomic amount." +
        closing +
        ' Stop and tell the user before any payment.'
      )
  }
}

export type HavenMcpToolName =
  | 'haven_send'
  | 'haven_pay_mcp_tool'
  | 'haven_quote_x402'
  | 'haven_pay_x402_quote'
  | 'haven_pay_x402'
  | 'haven_resume_x402_payment'
  | 'haven_get_payment_status'
  | 'haven_get_resume_state'
  | 'haven_get_agent'
  | 'haven_get_allowances'
  | 'haven_list_receipts'
  | 'haven_verify_receipt'
  // #3723: the signed bundle's read — `haven_get_receipt { payment_id }`
  // returns `{ receipt }`, and `haven_verify_receipt` accepts that response
  // (or the endpoint's `{ receipt, verification }`) unchanged.
  | 'haven_get_receipt'
  | 'haven_sweep_delegate'
  | 'haven_discover_tools'
  | 'haven_submit_catalog_entry'
  | 'haven_open_task_budget'
  | 'haven_close_task_budget'
  | 'haven_get_task_budget'
  | 'haven_submit'

/**
 * #3100 (epic #3105, decision 4): the structured hint on a local discovery
 * entry — a pay tool with arguments it accepts VERBATIM, or the reason no
 * verbatim hint exists for the row (decision 3's omitted-plus-reason shape).
 */
export type DiscoveryHint =
  | {
      suggested_tool: 'haven_pay_mcp_tool'
      suggested_arguments: { merchant_url: string; tool_name: string; arguments?: Record<string, unknown> }
    }
  | { suggested_tool: 'haven_pay_x402'; suggested_arguments: { url: string } }
  | { suggested_tool_omitted_reason: string }

/** One `haven_discover_tools` entry on the local surface (wire-shaped). */
export type DiscoveryEntry = {
  id: string
  name: string
  description: string | null
  category: string | null
  resource_url: string
  rail: string
  protocol: string
  tool_name: string | null
  tool_arguments: Record<string, unknown> | null
  price_display: string | null
  price_atomic: string | null
  asset: string | null
  network: string | null
  /** #3839: comma-separated x402 assetTransferMethods last advertised; null when none recorded. */
  asset_transfer_methods: string | null
  /** #3839: catalog-based hint — false when erc7710 is advertised, true when not, "unknown" when nothing is recorded. */
  funding_leg_expected: boolean | 'unknown'
  status: string
  verified_at: string | null
  source?: string
  domain_verified?: boolean
  verified_payable?: boolean
} & DiscoveryHint

export const toolSchemas = {
  haven_send: {
    asset: z.enum(['ETH', 'USDC']),
    recipient: z.string().min(1),
    amount: z.string().min(1),
    idempotency_key: z.string().optional(),
    /** REMOVED (#3411): declared only so the resolver can refuse it by name, never accepted. */
    idempotencyKey: z.string().optional().describe('REMOVED (#3411): refused — send idempotency_key'),
    /** #3329: spend against an open task budget instead of the agent's period budget. */
    task_budget_id: z.string().min(1).optional(),
    /**
     * #3330: spend against an open sub-budget this agent HOLDS (it is the
     * sub-agent B) instead of the agent's own budget. Mutually exclusive
     * with task_budget_id — the backend refuses a body naming both.
     */
    sub_budget_id: z.string().min(1).optional(),
  },
  haven_pay_mcp_tool: {
    merchant_url: z.string().url(),
    tool_name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    idempotency_key: z.string().optional(),
    /** REMOVED (#3411): declared only so the resolver can refuse it by name, never accepted. */
    idempotencyKey: z.string().optional().describe('REMOVED (#3411): refused — send idempotency_key'),
  },
  haven_quote_x402: {
    url: z.string().url(),
    method: z.string().optional(),
    headers: headersSchema,
    body: z.string().optional(),
    idempotency_key: z.string().optional(),
    /**
     * #3967: the price the agent EXPECTS, in whole tokens ("0.10" = 0.1 USDC),
     * compared against the amount of the option pay will actually select. A
     * mismatch stops the agent — the same stop signals the hosted quote
     * carries. Local parity: a hosted-only input would split the two tools'
     * contracts. Same shape and name as the hosted surface's.
     */
    expected_amount: z
      .string()
      .regex(
        /^[0-9]+(\.[0-9]+)?$/,
        'expected_amount must be a plain decimal amount in whole tokens, e.g. "0.10"',
      )
      .optional(),
    /** REMOVED (#3411): declared only so the resolver can refuse it by name, never accepted. */
    idempotencyKey: z.string().optional().describe('REMOVED (#3411): refused — send idempotency_key'),
  },
  haven_pay_x402_quote: {
    quote: z.unknown(),
    idempotency_key: z.string().optional(),
    /** REMOVED (#3411): declared only so the resolver can refuse it by name, never accepted. */
    idempotencyKey: z.string().optional().describe('REMOVED (#3411): refused — send idempotency_key'),
    /** #3329: spend against an open task budget instead of the agent's period budget. */
    task_budget_id: z.string().min(1).optional(),
    /** #3330: spend against an open sub-budget this agent holds (it is sub-agent B). Mutually exclusive with task_budget_id. */
    sub_budget_id: z.string().min(1).optional(),
  },
  haven_pay_x402: {
    url: z.string().url(),
    method: z.string().optional(),
    headers: headersSchema,
    body: z.string().optional(),
    idempotency_key: z.string().optional(),
    /** REMOVED (#3411): declared only so the resolver can refuse it by name, never accepted. */
    idempotencyKey: z.string().optional().describe('REMOVED (#3411): refused — send idempotency_key'),
    /** #3329: spend against an open task budget instead of the agent's period budget. */
    task_budget_id: z.string().min(1).optional(),
    /** #3330: spend against an open sub-budget this agent holds (it is sub-agent B). Mutually exclusive with task_budget_id. */
    sub_budget_id: z.string().min(1).optional(),
  },
  haven_resume_x402_payment: {
    payment_id: z.string().optional(),
    resume_state: z.unknown().optional(),
  },
  haven_get_payment_status: {
    payment_id: z.string(),
  },
  haven_get_resume_state: {
    payment_id: z.string(),
  },
  haven_get_agent: {},
  haven_get_allowances: {},
  haven_sweep_delegate: {},
  haven_discover_tools: {
    category: z.string().optional(),
    search: z.string().optional(),
    rail: z.enum(['x402', 'mpp']).optional(),
    verified: z.enum(['any', 'verified', 'operator']).optional(),
  },
  haven_submit_catalog_entry: {
    resource_url: z.string().min(1),
    website: z.string().optional(),
  },
  haven_list_receipts: {
    limit: z.number().int().min(1).max(100).optional(),
    /** #3128: the previous page's next_cursor (a receipt id). */
    cursor: z.string().min(1).optional(),
    /** #3423: drop each row's payload echoes; the default shape is unchanged. */
    compact: z
      .boolean()
      .optional()
      .describe('true drops challengePayload, selectedPayment and protocolReceiptPayload from each row; omit for the full row.'),
  },
  haven_verify_receipt: {
    receipt: z.unknown(),
    // #3723: the spread form — the endpoint's `{ receipt, verification }`
    // spread as top-level arguments — verifies: `verification` is declared
    // ACCEPTED-AND-IGNORED (Haven's own self-check, never read). The stdio
    // z.object would strip it silently anyway; declaring it keeps the schema
    // identical to the hosted runtime's, where the key must be declared to
    // pass its strict refusal.
    verification: z.unknown().optional().describe('accepted and ignored — verification reads the receipt itself'),
  },
  // #3723: the signed bundle's read — `{ receipt }` only, settled payments
  // only. The endpoint's server-side `verification` is deliberately NOT
  // returned: it is computed on Haven's server, not offline, and an agent
  // that trusted it would skip haven_verify_receipt.
  haven_get_receipt: {
    payment_id: z.string().min(1),
  },
  // #3329: a budget for one task that ends by itself — a short-lived child of
  // the agent's own budget, capped and time-boxed independently of the period
  // reset.
  haven_open_task_budget: {
    max_amount_human: z.string().min(1),
    ttl_minutes: z.number().int().min(1).max(1440),
    recipient: z.string().optional(),
    label: z.string().max(120).optional(),
    token: z.string().optional(),
  },
  haven_close_task_budget: {
    task_budget_id: z.string().min(1),
  },
  // #3518: read ONE task budget by id, any status — the status check a close
  // refusal's "re-check the budget's status" points at, on the local surface
  // too (schema and wording parity with the hosted read).
  haven_get_task_budget: {
    task_budget_id: z.string().min(1),
  },
  // #3329 / #3506: relays a signature from the local signer — the open/close
  // signature for a task budget or a sub-budget row, or (schema parity with
  // the hosted surface) a direct-payment signature by payment_id. Exactly one
  // of task_budget_id / sub_budget_id / payment_id, never two or none.
  haven_submit: {
    task_budget_id: z.string().min(1).optional(),
    sub_budget_id: z.string().min(1).optional(),
    payment_id: z.string().min(1).optional(),
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'signature must be a 0x-prefixed hex string'),
  },
// #3101: keys survive on the type (see the hosted server's contracts.ts).
} as const satisfies Record<HavenMcpToolName, z.ZodRawShape>

// #3329 / #4825: outcome language only — never "delegation", "caveat" or
// "UserOp". The tool stays registered and refuses: opening a task budget needs
// a signature from the Haven signer, and a --local install has no signer tool.
const OPEN_TASK_BUDGET_DESCRIPTION = [
  'Open a budget for one task that ends by itself: a spending cap, good for at most ttl_minutes,',
  'reserved out of the agent\'s own budget and separate from its period reset.',
  'Pass max_amount_human (whole tokens, e.g. "5" for 5 USDC), ttl_minutes (1-1440), and optionally',
  'recipient (pins every payment against this task budget to one address), label, and token',
  '(defaults to USDC). This runtime cannot open a task budget: opening one needs a signature from the',
  'Haven signer, and a --local install has no signer tool, so the call refuses with',
  'TASK_BUDGET_SIGNING_UNAVAILABLE and nothing is reserved. Task budgets are a hosted-plus-signer',
  'feature — use a hosted MCP install with the Haven signer connected, or ask the owner to open the',
  'budget there. Spending anything above the reserved amount, past the deadline, or to a',
  'different recipient than the one pinned here is declined on the spot — nothing is queued.',
  'A recipient pin is checked against where each payment first goes: haven_pay_x402 and',
  'haven_pay_x402_quote first move funds into the agent\'s own wallet, so a budget pinned to a',
  'merchant is declined there — pin only budgets meant for haven_send.',
].join(' ')

const CLOSE_TASK_BUDGET_DESCRIPTION = [
  'End a task budget early, before its deadline, releasing whatever of its cap was unspent back',
  'to the agent\'s own budget. Pass task_budget_id. A budget that was never signed (still pending)',
  'or is past its own deadline ends immediately with { task_budget, status: "closed" } and nothing',
  'was ever reserved on-chain. A budget that is open or closing needs a signature from the Haven',
  'signer, and a --local install has no signer tool: the call refuses with',
  'TASK_BUDGET_SIGNING_UNAVAILABLE, nothing is closed and the budget is left unchanged. Task',
  'budgets are a hosted-plus-signer feature — use a hosted MCP install with the Haven signer',
  'connected, or ask the owner to close it there.',
].join(' ')

// #3518: the status check a close refusal's "re-check the budget's status"
// names — reads ONE task budget by id, any status (pending/closing rows
// included; haven_get_agent lists them with their status too). Same wording
// as the hosted read: the surfaces describe the same behavior.
const GET_TASK_BUDGET_DESCRIPTION = [
  'Read one task budget by id, any status.',
  'Returns { task_budget } with status (pending | open | closing | closed), isExpired, maxDisplay, recipientAddress, label and expiresAt —',
  'the check to run after a close or submit refusal says to re-check the budget\'s status.',
  'haven_get_agent lists live task budgets only; this reads any one, closed or expired included.',
].join(' ')

// #3329 / #3506 / #4825: the relay step. The local runtime has no signer tool,
// so it cannot produce a task-budget or sub-budget signature — the description
// says so instead of naming a signer step.
const SUBMIT_DESCRIPTION = [
  'Relay a signature you already hold. Pass exactly one of task_budget_id (from',
  'haven_open_task_budget or haven_close_task_budget), sub_budget_id (from haven_get_agent',
  'pendingSubBudgetSignatures[]) or payment_id — never two, never none — plus signature.',
  'For a task budget this opens or closes it on-chain and returns { task_budget,',
  'status }; a close in progress may return { task_budget, status: "closed", close_tx_hash }.',
  'A sub_budget_id returns { sub_budget, status }. This runtime has no signer tool, so it cannot',
  'produce a signature for a task budget or a sub-budget: a pendingSubBudgetSignatures[] row names',
  'no next tool and says the owner signs it from a hosted-plus-signer install.',
].join(' ')

/**
 * MCP tool descriptions, composed from the shared semantic source in
 * `@haven_ai/sdk`'s `tool-descriptions.ts`. Keeping both the SDK tool-calling
 * surface and the MCP surface pointed at the same prose source means new
 * guidance lands in both places at once and a parity test can catch drift.
 */
export const toolDescriptions: Record<HavenMcpToolName, string> = {
  haven_send: composeDescription(sharedDescriptions.send, 'local'),
  haven_pay_mcp_tool: composeDescription(sharedDescriptions.payMcpTool),
  haven_quote_x402: composeDescription(sharedDescriptions.quoteX402),
  haven_pay_x402_quote: composeDescription(sharedDescriptions.payX402),
  haven_pay_x402: composeDescription(sharedDescriptions.payX402OneShot),
  haven_resume_x402_payment: composeDescription(sharedDescriptions.resumeX402),
  haven_get_payment_status: composeDescription(sharedDescriptions.getPaymentStatus),
  haven_get_resume_state: composeDescription(sharedDescriptions.getResumeState),
  haven_get_agent: composeDescription(sharedDescriptions.getAgent, 'local'),
  haven_get_allowances: composeDescription(sharedDescriptions.getAllowances),
  haven_sweep_delegate: composeDescription(sharedDescriptions.sweep_delegate, 'local'),
  haven_discover_tools: composeDescription(sharedDescriptions.discoverTools),
  haven_submit_catalog_entry: composeDescription(sharedDescriptions.submitCatalogEntry),
  haven_list_receipts: composeDescription(sharedDescriptions.listReceipts),
  haven_verify_receipt: composeDescription(sharedDescriptions.verifyReceipt),
  // #3723: the signed bundle's read, described from the shared fragment.
  haven_get_receipt: composeDescription(sharedDescriptions.getReceipt),
  haven_open_task_budget: OPEN_TASK_BUDGET_DESCRIPTION,
  haven_close_task_budget: CLOSE_TASK_BUDGET_DESCRIPTION,
  haven_get_task_budget: GET_TASK_BUDGET_DESCRIPTION,
  haven_submit: SUBMIT_DESCRIPTION,
}

export interface ToolSuccess<T> {
  success: true
  data: T
  /**
   * Non-fatal notices about the CALL, not about its result (#2366).
   *
   * Additive and optional: a caller that ignores it sees exactly what it saw
   * before. It exists so a deprecation can be announced on the surface that
   * observes it — the alternative was a divergence nothing ever told anyone to
   * leave, which is how `idempotencyKey` survived #2312 and #2348.
   */
  warnings?: string[]
  /**
   * #3303: the backend's `client_update` hint when this package is behind the
   * version the deployment recommends (`required: false`) or below its
   * minimum (`required: true`). `upgrade_command` starts the update: for the
   * connector-installed packages it is the connector doctor, which prints the
   * repair line to run next (#3412).
   */
  client_update?: HavenClientUpdate
}

export interface ToolFailure {
  success: false
  code: string
  message: string
  /** Structured hint pointing the agent at the correct tool for this operation. */
  suggested_tool?: string
  statusCode?: number
  paymentId?: string
  status?: string
  phase?: string
  /**
   * @deprecated since #3103 — read `next_action`. Kept with the same value for
   * one release (the #2908 pattern) and removed in the release after the one
   * carrying #3103.
   */
  nextAction?: string
  /**
   * #3103 (epic #3105, decision 10): the same value as `nextAction`, spelled
   * the way the hosted server and the signer spell it. Dual-emitted for one
   * release (the #2908 pattern) before `nextAction` is dropped.
   */
  next_action?: string
  /** #3101 (epic #3105, decision 7): the typed next-step family, additive; `next_tool` never null. */
  next_tool?: string
  next_tool_server?: string
  next_tool_name?: string
  next_tool_server_role?: 'hosted' | 'signer'
  next_arguments?: Record<string, unknown>
  next_tool_omitted_reason?: string
  resume_state?: unknown
  body?: unknown
  /**
   * #2983: carried on `MERCHANT_NOT_READY` — mirrors the hosted MCP's
   * `retry_with_new_quote` (`mcp-context.ts`'s `merchantNotReadyErrorFor`).
   * Genuinely retryable: nothing about the CALL was wrong, the merchant's
   * own wallet needs to recover first.
   */
  retry_with_new_quote?: boolean
  /** #3303: as on {@link ToolSuccess}; on a 426 `client_outdated` refusal it is always `required: true`. */
  client_update?: HavenClientUpdate
}

export type ToolPayload<T = unknown> = ToolSuccess<T> | ToolFailure

/**
 * #4825: the typed refusal the local runtime answers a task-budget open or a
 * close that needs a signature with. Task budgets are a hosted-plus-signer
 * feature: opening one, and closing one that is open, both need a signature
 * from the Haven signer, and a `--local` install has no signer tool — the
 * connector's local mode removes the signer server on every runtime that
 * supports it (`packages/connect/src/runtime-install.ts`,
 * `packages/connect/src/config-writers.ts`). The tools stay registered (the
 * local consent hash covers the tool list, not behaviour); they refuse.
 */
const TASK_BUDGET_SIGNING_UNAVAILABLE = 'TASK_BUDGET_SIGNING_UNAVAILABLE'

/** The one sentence both task-budget refusals share: what the owner can do instead. */
const TASK_BUDGET_HOSTED_PLUS_SIGNER =
  'Task budgets are a hosted-plus-signer feature: use a hosted MCP install with the Haven signer ' +
  'connected, or ask the owner to do it there.'

/**
 * #4825: the refusal for `haven_open_task_budget` and for a
 * `haven_close_task_budget` whose budget needs a signature. Nothing is
 * contacted: no `POST /task-budgets`, no `POST /task-budgets/:id/close`, so no
 * pending row is created and no budget is left `closing`.
 */
function taskBudgetSigningUnavailable(action: 'open' | 'close'): ToolFailure {
  return {
    success: false,
    code: TASK_BUDGET_SIGNING_UNAVAILABLE,
    message:
      action === 'open'
        ? 'Opening a task budget needs a signature from the Haven signer, and this --local install has no ' +
          'signer tool. Nothing was opened and nothing was reserved. ' +
          TASK_BUDGET_HOSTED_PLUS_SIGNER
        : 'Closing this task budget needs a signature from the Haven signer, and this --local install has no ' +
          'signer tool. Nothing was closed and the budget is unchanged. ' +
          TASK_BUDGET_HOSTED_PLUS_SIGNER,
    next_action: 'stop_and_tell_user',
    next_tool_omitted_reason:
      'this runtime cannot sign a task budget — no tool on this surface produces the signature, so no tool ' +
      'follows; the owner can do it from a hosted MCP install with the Haven signer connected',
  }
}

/**
 * #3506 / #4825: a sub-budget row that still needs THIS agent's signature.
 *
 * The local surface has no sub-budget tool of its own and no signer tool: the
 * connector's `--local` mode removes the signer server, so nothing here can
 * produce the signature. The row therefore names no next tool and says why,
 * plus what the owner can do instead. Spending through a sub-budget
 * (`sub_budget_id` on the pay tools) needs no signer once the row is open.
 */
function subBudgetSignStep(subBudgetId: string) {
  return {
    next_action: 'stop_and_tell_user',
    next_tool_omitted_reason:
      `sub-budget ${subBudgetId} still needs your signature, and this --local install has no signer tool: ` +
      'the connector removes the Haven signer on a --local setup, so nothing on this surface can produce it. ' +
      'Ask the owner to sign it from a hosted MCP install with the Haven signer connected; spending through ' +
      'the sub-budget needs no signature once it is open.',
  }
}

/**
 * #3506: `haven_submit { sub_budget_id }` — the DELEGATING agent's signature
 * for a sub-budget row: it opens a pending row, or relays a signed close. The
 * owner relay is no longer required. Mirrors the hosted handler in
 * `packages/mcp-server/src/tools/state-direct-recovery.ts`.
 *
 * A close can answer 409 `close_needs_reprepare` (the stored disable UserOp
 * is stale) or 502 `close_outcome_unconfirmed` (it was sent; the chain has
 * not finalised). Neither runtime has a close tool, so this handler does the
 * recovery the backend names: it calls `closeSubBudget` (idempotent in
 * effect, authority-reducing) — which reports `closed` if the disable
 * finalised, else prepares a fresh op for `haven_sign` — and for the
 * unconfirmed case says to retry this same call later.
 */
async function submitSubBudgetTool(haven: HavenClient, subBudgetId: string, signature: string): Promise<ToolPayload> {
  let result: Awaited<ReturnType<HavenClient['submitSubBudget']>>
  try {
    result = await haven.submitSubBudget(subBudgetId, signature)
  } catch (err) {
    const code =
      err instanceof HavenApiError ? (err.body as { error_code?: string } | undefined)?.error_code : undefined
    if (code === 'close_needs_reprepare') {
      let fresh: Awaited<ReturnType<HavenClient['closeSubBudget']>>
      try {
        fresh = await haven.closeSubBudget(subBudgetId)
      } catch (closeErr) {
        return normalizeError(closeErr)
      }
      if (fresh.status === 'closed') {
        return {
          success: true,
          data: {
            sub_budget: fresh.subBudget,
            status: 'closed',
            next_action: 'none',
            next_tool_omitted_reason: 'the sub-budget is closed on-chain; nothing further to sign or submit for it',
          },
        }
      }
      return {
        success: false,
        code: 'CLOSE_NEEDS_REPREPARE',
        message:
          'The stored close operation for this sub-budget was stale, so nothing was relayed. Haven prepared a ' +
          'fresh one, but this --local install has no signer tool to sign it: ask the owner to sign and submit ' +
          'it from a hosted MCP install with the Haven signer connected.',
        statusCode: 409,
        ...subBudgetSignStep(subBudgetId),
      }
    }
    if (code === 'close_outcome_unconfirmed') {
      return {
        success: false,
        code: 'CLOSE_OUTCOME_UNCONFIRMED',
        message:
          'The close operation was sent but its outcome is not confirmed yet (on Base that can take tens of ' +
          'minutes). Wait, then call haven_submit again with the same arguments: it reports closed once the ' +
          'chain has finalised the disable, or prepares a fresh operation to sign if the earlier one did not land.',
        statusCode: 502,
        next_action: 'check_status_later',
        next_tool: 'haven_submit',
        next_arguments: { sub_budget_id: subBudgetId, signature },
      }
    }
    return normalizeError(err)
  }
  return runTool(async () => {
    const submitted = {
      sub_budget: result.subBudget,
      status: result.status,
      ...(result.closeTxHash !== undefined ? { close_tx_hash: result.closeTxHash } : {}),
    }
    if (result.status === 'closed') {
      return {
        ...submitted,
        next_action: 'none',
        next_tool_omitted_reason: 'the sub-budget is closed on-chain; nothing further to sign or submit for it',
      }
    }
    // Opened: if the tree's other row is still pending, signing it is next
    // (the grant stays unusable until BOTH rows are open).
    let pending: Awaited<ReturnType<HavenClient['listPendingSubBudgetSignatures']>> | null
    try {
      pending = await haven.listPendingSubBudgetSignatures()
    } catch {
      pending = null
    }
    if (pending === null) {
      return {
        ...submitted,
        next_action: 'check_status_later',
        next_tool: 'haven_get_agent',
        next_arguments: {},
        reason:
          'This sub-budget row is open, but Haven could not say whether its tree has another row ' +
          'awaiting your signature. Call haven_get_agent to see; this runtime cannot sign one, so the ' +
          'owner signs it from a hosted MCP install with the Haven signer connected.',
      }
    }
    const tree = result.subBudget.parentSubBudgetId ?? result.subBudget.id
    const sibling = pending.find(
      (row) =>
        row.purpose === 'open' &&
        row.subBudgetId !== result.subBudget.id &&
        (row.parentSubBudgetId ?? row.subBudgetId) === tree,
    )
    if (sibling) return { ...submitted, ...subBudgetSignStep(sibling.subBudgetId) }
    return {
      ...submitted,
      next_action: 'none',
      next_tool_omitted_reason:
        'no other row of this sub-budget awaits your signature, so the sub-budget is fully open ' +
        'and the sub-agent can spend through its grant',
    }
  })
}

export function createToolHandlers(haven: HavenClient): Record<HavenMcpToolName, (input: unknown) => Promise<ToolPayload>> {
  return {
    haven_send: async (input) => {
      // #2366/#3411: resolved OUTSIDE the payload so any `preflight` warning
      // can ride on the success, and BEFORE anything is contacted so a legacy
      // `idempotencyKey` refuses without spending.
      const pf = preflight('haven_send', input)
      if ('success' in pf) return pf
      const { args, warnings } = pf
      return runTool(async () => {
        try {
          const result = await haven.pay({
            token: args.asset,
            amount: args.amount,
            to: args.recipient,
            // #1207/#3411: was accepted by the schema but silently dropped — now
            // carried to the backend's replay contract via the resolved carrier.
            idempotencyKey: args.resolvedIdempotencyKey,
            // #3329: spend against an open task budget instead of the
            // agent's period budget, when the caller names one.
            ...(typeof args.task_budget_id === 'string' ? { taskBudgetId: args.task_budget_id } : {}),
            // #3330: spend through a sub-budget this agent holds (it is
            // sub-agent B). Exactly one of the two ids, never both.
            ...(typeof args.sub_budget_id === 'string' ? { subBudgetId: args.sub_budget_id } : {}),
          })
          return {
            payment_id: result.paymentId,
            status: result.status,
            tx_hash: result.txHash ?? null,
            asset: args.asset,
            amount: args.amount,
            recipient: args.recipient,
          }
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            // #2101: retained fail-closed (see `isPendingApproval` below), but it
            // used to return a bare status string whose only explanation lived in
            // MCP_INSTRUCTIONS' now-deleted "pending_approval means stop" line.
            // Carry the verdict IN BAND rather than leaning on the general
            // unrecognised-status rule: this branch is the one place a model can
            // still meet the status, and it must not read as "poll and wait".
            return {
              payment_id: err.paymentId,
              status: 'pending_approval',
              next_action: 'stop_and_tell_user',
              message:
                'This payment is not payable and nothing is queued for anyone to approve — ' +
                'stop and tell the user, then ask the wallet owner to grant or raise the ' +
                'agent budget in Haven. Do not retry, re-sign, or poll.',
              asset: args.asset,
              amount: args.amount,
              recipient: args.recipient,
            }
          }
          throw err
        }
      }, warnings)
    },

    haven_pay_mcp_tool: async (input) => {
      // #2366: hoisted out of `runTool` so a refusal is a refusal rather than
      // a success carrying one as its payload. (`warnings` no longer fires for
      // idempotency-key spelling since #3411 — the legacy spelling is refused,
      // not warned on — but the field stays hoisted here for any future
      // non-fatal notice `preflight` needs to attach to a success.)
      const pf = preflight('haven_pay_mcp_tool', input)
      if ('success' in pf) return pf
      const { args, warnings } = pf
      return runTool(async () => {
        const envelope = buildMcpToolsCallEnvelope(args.tool_name as string, args.arguments as Record<string, unknown> | undefined)
        const init: RequestInit = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope),
        }
        // #1301: a base merchant URL is accepted, mirroring the hosted MCP's
        // #1271 discovery. `haven.fetch()` already resolves a 402 itself
        // (pays and retries) — it never hands a 402 back to us, and a
        // successfully-paid retry that the merchant rejects THROWS from
        // inside the SDK rather than returning a non-ok Response (see
        // `retryX402Request`). So any Response this call returns with
        // `.ok === false` can only be the UNTOUCHED first-hop response to a
        // URL that never spoke 402 at all — free-tool 200s and paid 200s
        // both stay `.ok === true` and never reach this branch. That is the
        // local flow's equivalent of the hosted probe's
        // `X402UnexpectedStatusError` (#1300): "this URL isn't the MCP
        // endpoint," expressed as a Response instead of a thrown error.
        let merchantUrl = args.merchant_url as string
        const idempotencyKey = args.resolvedIdempotencyKey
        const attempt = () => haven.fetch(merchantUrl, init, { idempotencyKey })

        let response = await attempt()
        if (!response.ok) {
          // #2983: mirror the hosted `merchantNotReadyErrorFor` — an honest,
          // machine-readable merchant refusal is reported as itself, BEFORE
          // the #1301 "wrong endpoint" discovery heuristic ever runs. Without
          // this, every local `merchant_not_ready` 503 fell into the
          // discovery path below and came back as "no discovery document was
          // found", discarding the merchant's own reason entirely — the same
          // misreport #2979 fixed on the hosted side.
          const notReady = await merchantNotReadyErrorFor(response)
          if (notReady) throw notReady
          const discovered = await discoverMerchantMcpUrl(merchantUrl)
          // Trailing-slash/case echoes of the input are "same URL" — spend
          // the one retry only on a genuinely different endpoint.
          if (!discovered || sameUrl(discovered, merchantUrl)) {
            throw discoveryMissError(response, merchantUrl, discovered)
          }
          const inputUrl = merchantUrl
          merchantUrl = discovered
          const retryResponse = await attempt()
          if (!retryResponse.ok) {
            const notReadyAtDiscovered = await merchantNotReadyErrorFor(retryResponse)
            if (notReadyAtDiscovered) throw notReadyAtDiscovered
            // Label which URL failed — the agent otherwise cannot tell the
            // discovered endpoint's miss from the original probe's.
            throw discoveryMissError(retryResponse, merchantUrl, discovered, inputUrl)
          }
          response = retryResponse
        }
        const payload = await responsePayload(response)
        return {
          ...payload,
          // The RESOLVED endpoint (#1271/#1301), not the input as given.
          merchant_url: merchantUrl,
          ...(merchantUrl !== args.merchant_url ? { merchant_url_discovered_from: args.merchant_url } : {}),
        }
      }, warnings)
    },

    haven_quote_x402: async (input) => {
      const pf = preflight('haven_quote_x402', input)
      if ('success' in pf) return pf
      const { args, warnings } = pf
      // #3967: the agent rail is needed ONLY when the caller stated an
      // expected price — the comparison asks about the option pay will
      // actually select (#2051), which the rail determines. Non-throwing,
      // same `.then(a => a, () => undefined)` convention as the hosted quote.
      //
      // #4830: the read's ERROR is kept beside the agent instead of being
      // mapped to `undefined` — a stated price that could not be compared
      // carries a next step decided by the CAUSE (a transient 5xx is worth one
      // re-quote; a 401/403 refusal is not), exactly as `normalizeError` does.
      const agentRead =
        args.expected_amount !== undefined
          ? haven.getAgent().then(
              (a) => ({ agent: a, error: undefined as unknown }),
              (error: unknown) => ({ agent: undefined as HavenAgent | undefined, error }),
            )
          : null
      try {
        const data = await haven.quoteX402(args.url, requestInit(args), { idempotencyKey: args.resolvedIdempotencyKey })
        // #3967: expected_price check — mirrors the hosted haven_quote_x402
        // (plain-http-x402.ts) field for field: compare the stated human
        // decimal against the SELECTED option's atomic amount through the
        // quote's own decimals; a mismatch stops the agent with
        // `next_action: stop_and_tell_user` and names the deposit-address
        // fallback's one condition (the user's explicit go-ahead). A quote
        // makes no budget call locally — the local surface's budget gates
        // live in the pay/prepare paths, and a quote is a read.
        //
        // #4830: the comparison is DECIDED without the agent read wherever the
        // rail cannot change the answer, a stated price finer than the token's
        // scale is a decided mismatch (hosted parity), and when the comparison
        // genuinely cannot be made the result SAYS SO and stops — never a
        // plain quote that reads as "no expectation was stated".
        if (args.expected_amount !== undefined) {
          const read = agentRead ? await agentRead : { agent: undefined, error: undefined }
          const comparison = compareExpectedAmountLocal({
            accepts: data.paymentRequired.accepts,
            decimals: data.decimals,
            expectedAmount: args.expected_amount as string,
            agent: read.agent,
            agentError: read.error,
          })
          if (comparison.kind === 'compared') {
            const priceDiffers = comparison.differs
            const payload = {
              ...data,
              price_differs_from_expected: priceDiffers,
              ...(priceDiffers
                ? {
                    safe_to_continue: false,
                    next_action: AgentPaymentNextAction.StopAndTellUser,
                    next_tool_omitted_reason:
                      'no Haven tool follows: the quoted price does not match the stated ' +
                      'expectation — the user decides before any payment',
                    reason:
                      // #4754: the symbol, not the contract address. Only reachable with
                      // `decimals !== null`; the address arm is a defensive fallback.
                      `The merchant's quoted price (${data.amount} ${data.decimals !== null ? data.token : data.asset}) does not match ` +
                      `the expected price (${args.expected_amount as string}) stated with this quote. ` +
                      'Stop and tell the user before any payment; do not re-quote, re-pay, or poll. ' +
                      'If the x402 challenge itself is wrong and nothing has been paid via x402 on ' +
                      "this invoice, the invoice's own deposit address MAY be an alternative — but " +
                      "only with the user's explicit go-ahead, never automatically, and never once " +
                      'anything has been paid via x402.',
                  }
                : {}),
            }
            return warnings.length > 0
              ? { success: true, data: payload, warnings }
              : { success: true, data: payload }
          }
          // #4830: the comparison was NOT made. The quote object is still
          // returned (like today's mismatch stop), but the result carries
          // `safe_to_continue: false`, the named not-compared field and the
          // cause's next step — no prefilled cap, no pay step.
          const payload = {
            ...data,
            price_comparison_made: false as const,
            price_comparison_not_made_cause: comparison.cause,
            safe_to_continue: false,
            next_action: notComparedNextAction(comparison.cause),
            next_tool_omitted_reason: notComparedOmittedReason(comparison.cause),
            reason: notComparedReason(args.expected_amount as string, comparison.cause),
          }
          return warnings.length > 0
            ? { success: true, data: payload, warnings }
            : { success: true, data: payload }
        }
        return warnings.length > 0 ? { success: true, data, warnings } : { success: true, data }
      } catch (err) {
        // #1328: quoteX402 still refuses a MACHINE-PAYMENT-CHALLENGE response as
        // a defensive shape guard, but nothing in Haven produces that header
        // anymore (the mpp_demo route it was built for is retired) — fall
        // through to the generic error rather than suggesting a deleted tool.
        return normalizeError(err)
      }
    },

    haven_pay_x402_quote: async (input) => {
      const pf = preflight('haven_pay_x402_quote', input)
      if ('success' in pf) return pf
      const { args, warnings } = pf
      const quote = args.quote as Record<string, unknown> | null | undefined
      // Guard before network calls so the agent gets actionable guidance rather
      // than an opaque SDK error.
      if (!quote || typeof quote !== 'object') {
        return wrongTool(
          'WRONG_TOOL',
          'The quote argument is missing or is not a valid x402 quote object. Call haven_quote_x402 first to obtain a quote, or use haven_pay_x402 to handle the full probe → pay → retry round trip automatically.',
          'haven_quote_x402',
        )
      }
      if (!quote.paymentRequired) {
        return wrongTool(
          'WRONG_TOOL',
          'The quote is missing the required paymentRequired field. Call haven_quote_x402 first to obtain a valid x402 quote.',
          'haven_quote_x402',
        )
      }
      return runTool(async () => {
        const response = await haven.payX402Quote(args.quote as X402Quote, {
          idempotencyKey: args.resolvedIdempotencyKey,
          ...(typeof args.task_budget_id === 'string' ? { taskBudgetId: args.task_budget_id } : {}),
          ...(typeof args.sub_budget_id === 'string' ? { subBudgetId: args.sub_budget_id } : {}),
        })
        return responsePayload(response)
      }, warnings)
    },

    haven_pay_x402: async (input) => {
      const pf = preflight('haven_pay_x402', input)
      if ('success' in pf) return pf
      const { args, warnings } = pf
      return runTool(async () => {
        const response = await haven.fetch(args.url, requestInit(args), {
          idempotencyKey: args.resolvedIdempotencyKey,
          ...(typeof args.task_budget_id === 'string' ? { taskBudgetId: args.task_budget_id } : {}),
          ...(typeof args.sub_budget_id === 'string' ? { subBudgetId: args.sub_budget_id } : {}),
        })
        return responsePayload(response)
      }, warnings)
    },

    haven_resume_x402_payment: async (input) => {
      const args = objectInput('haven_resume_x402_payment', input)
      // #1328: the mpp rail resume_state branch is retired along with
      // haven_resume_mpp_payment — any non-x402 rail is now just a
      // state-mismatch, not a "use this other tool" redirect.
      return runTool(async () => {
        const state = await resumeState(args, 'x402')
        const response = await haven.resumeX402Payment(state)
        return responsePayload(response)
      })
    },

    haven_get_payment_status: async (input) => {
      const args = objectInput('haven_get_payment_status', input)
      // #1310/#1311: shared with mcp-server's haven_get_payment_status
      // handler — see HavenClient.getPaymentStatusWithPostPurchaseAllowance
      // in @haven_ai/sdk for the single home of this "settled x402 only"
      // attach logic (was duplicated verbatim in both packages) and for why
      // `funded_but_unsettled` is excluded from "settled".
      //
      // #4808: the backend's message names haven_report_settlement_evidence in
      // two states, and this surface has no such tool. Replace it whole, keyed
      // on the structured fields — see the SDK's payment-status-message module
      // for why the replacement lives in this layer and not in the shared read.
      return runTool(async () =>
        replaceSettlementEvidenceMessage(
          await haven.getPaymentStatusWithPostPurchaseAllowance(args.payment_id),
          'haven_get_payment_status',
        ),
      )
    },

    haven_get_resume_state: async (input) => {
      const args = objectInput('haven_get_resume_state', input)
      return runTool(async () => haven.getResumeState(args.payment_id))
    },

    haven_get_agent: async () =>
      runTool(async () => {
        const summary = await haven.getAgentSummary()
        // #3506: each owner-issued sub-budget row awaiting THIS agent's
        // signature names its own next step (haven_sign { sub_budget_id }).
        if (!Array.isArray(summary.pendingSubBudgetSignatures)) return summary
        return {
          ...summary,
          pendingSubBudgetSignatures: summary.pendingSubBudgetSignatures.map((row) => ({
            ...row,
            ...subBudgetSignStep(row.subBudgetId),
          })),
        }
      }),
    haven_get_allowances: async () => runTool(async () => haven.getAllowances()),
    haven_sweep_delegate: async () => runTool(async () => haven.sweepDelegate()),
    haven_discover_tools: async (input) => {
      const args = objectInput('haven_discover_tools', input)
      return runTool(async () => {
        const entries = await haven.discoverTools({
          category: typeof args.category === 'string' ? args.category : undefined,
          search: typeof args.search === 'string' ? args.search : undefined,
          rail: args.rail === 'x402' || args.rail === 'mpp' ? args.rail : undefined,
          verified: args.verified === 'verified' || args.verified === 'operator' ? args.verified : undefined,
        })
        return entries.map((entry): DiscoveryEntry => ({
          id: entry.id,
          name: entry.name,
          description: entry.description,
          category: entry.category,
          resource_url: entry.resourceUrl,
          rail: entry.rail,
          protocol: entry.protocol,
          tool_name: entry.toolName,
          tool_arguments: entry.toolArguments,
          price_display: entry.priceDisplay,
          price_atomic: entry.priceAtomic,
          asset: entry.asset,
          network: entry.network,
          // #3839: same hint the hosted surface emits — a catalog hint, the
          // live quote stays authoritative; "unknown" when nothing is recorded.
          asset_transfer_methods: entry.assetTransferMethods ?? null,
          funding_leg_expected: catalogFundingLegExpected(entry.assetTransferMethods),
          status: entry.status,
          verified_at: entry.verifiedAt,
          source: entry.source,
          domain_verified: entry.domainVerified,
          verified_payable: entry.verifiedPayable,
          // Which Haven pay tool reaches this entry from the local MCP surface,
          // and — #3100 (epic #3105, decision 4) — the arguments that tool
          // accepts VERBATIM, spelled in ITS vocabulary (`merchant_url`, not
          // the entry's `resource_url`). The local surface keeps pointing at
          // its pay tools: they need no cap, so a verbatim hint exists.
          // #1328: the 'mpp' rail's only-ever catalog row (the Haven MPP demo
          // resource) is delisted with the mpp_demo retirement, so this
          // fallback is unreachable today; it stays x402 rather than naming a
          // deleted tool in case a future non-demo 'mpp' rail entry appears.
          // A row without a tool_name cannot get a verbatim hint —
          // haven_pay_mcp_tool requires tool_name — so it gets the REASON
          // instead of a hint its own tool refuses (haven-reviewer on #3113;
          // the epic's "omitted + reason, never null" shape, decision 3).
          ...(entry.protocol === 'mcp'
            ? entry.toolName
              ? {
                  suggested_tool: 'haven_pay_mcp_tool',
                  suggested_arguments: {
                    merchant_url: entry.resourceUrl,
                    tool_name: entry.toolName,
                    ...(entry.toolArguments ? { arguments: entry.toolArguments } : {}),
                  },
                }
              : {
                  suggested_tool_omitted_reason:
                    'this catalog row carries no tool_name, which haven_pay_mcp_tool requires; ' +
                    'read the merchant\'s tool list yourself, then call haven_pay_mcp_tool with ' +
                    'merchant_url, tool_name and arguments',
                }
            : {
                suggested_tool: 'haven_pay_x402',
                suggested_arguments: { url: entry.resourceUrl },
              }),
        }))
      })
    },
    haven_submit_catalog_entry: async (input) => {
      const args = objectInput('haven_submit_catalog_entry', input)
      return runTool(async () => {
        const submission = await haven.submitCatalogEntry(
          String(args.resource_url),
          typeof args.website === 'string' ? { website: args.website } : undefined,
        )
        return {
          id: submission.id,
          verify_token: submission.verifyToken,
          status: submission.status,
        }
      })
    },
    haven_list_receipts: async (input) => {
      const args = objectInput('haven_list_receipts', input)
      // #3128: same page shape as the hosted runtime.
      return runTool(async () =>
        haven.listReceiptsPage({ limit: args.limit, cursor: args.cursor, compact: args.compact === true }),
      )
    },
    haven_verify_receipt: async (input) => {
      const args = objectInput('haven_verify_receipt', input)
      return runTool(async () => verifyPaymentReceipt(args.receipt as PaymentReceipt))
    },

    // #3723: the signed bundle's home on the local surface. Parsed INSIDE
    // runTool, so a missing payment_id is a structured INVALID_INPUT failure
    // rather than a thrown ZodError (the hosted runtime's parseStrict already
    // answers that way). Returns `{ receipt }` only — the endpoint's
    // server-side `verification` is not offline evidence, and the agent
    // verifies with haven_verify_receipt, which reads the bundle unchanged.
    haven_get_receipt: async (input) =>
      runTool(async () => {
        const args = objectInput('haven_get_receipt', input)
        const { receipt } = await haven.getReceipt(args.payment_id as string)
        return { receipt }
      }),

    haven_open_task_budget: async (input) => {
      objectInput('haven_open_task_budget', input)
      // #4825: opening a task budget needs a signature from the Haven signer,
      // and a --local install has no signer tool (the connector's local mode
      // removes the signer server). Refuse BEFORE anything is contacted: no
      // `POST /task-budgets`, so no pending row is created and nothing is
      // reserved. The arguments are not inspected — no argument makes this
      // runtime able to sign.
      return taskBudgetSigningUnavailable('open')
    },

    haven_close_task_budget: async (input) => {
      const args = objectInput('haven_close_task_budget', input)
      const taskBudgetId = args.task_budget_id as string
      // #4825: read the budget FIRST. A budget that was never signed (still
      // pending) or is past its own deadline closes without a signature, so
      // that case still answers `status: closed`. One that was signed and is
      // still live (open or closing) needs a signature this runtime cannot
      // produce, and calling `POST /task-budgets/:id/close` would leave it
      // `closing` — so it is refused without the call.
      //
      // The question is asked of the wire fields the backend already publishes
      // (`closed_at`, `is_live`, `opened_at`) rather than by restating a status
      // comparison: #3924's census counts inline budget-liveness predicates and
      // is shrink-only. `opened_at` is set exactly when the open was signed
      // (`SET status = 'open', … opened_at = NOW()`), so "signed and still
      // live" is the real question, not a proxy for it.
      let budget: Awaited<ReturnType<HavenClient['getTaskBudget']>>
      try {
        budget = await haven.getTaskBudget(taskBudgetId)
      } catch (err) {
        return normalizeError(err)
      }
      if (budget.closedAt !== null) {
        return { success: true, data: { task_budget: budget, status: 'closed' as const } }
      }
      const live = budget.isLive ?? !budget.isExpired
      if (live && budget.openedAt !== null) {
        return taskBudgetSigningUnavailable('close')
      }
      let result: Awaited<ReturnType<HavenClient['closeTaskBudget']>>
      try {
        result = await haven.closeTaskBudget(taskBudgetId)
      } catch (err) {
        return normalizeError(err)
      }
      if (result.status === 'closed') {
        return { success: true, data: { task_budget: result.taskBudget, status: 'closed' as const } }
      }
      // Defensive: the backend answered a signature request for a row this
      // handler read as unsigned or expired. Refuse rather than hand off to a
      // signer this runtime does not have.
      return taskBudgetSigningUnavailable('close')
    },

    // #3518: read ONE task budget by id, any status — the status check a
    // close/submit refusal's "re-check the budget's status" points at. The
    // SDK relays `GET /task-budgets/:id` (the backend route answers any
    // status) and a 404 carries the backend's own message through runTool.
    haven_get_task_budget: async (input) => {
      const args = objectInput('haven_get_task_budget', input)
      return runTool(async () => {
        const taskBudget = await haven.getTaskBudget(args.task_budget_id as string)
        return { task_budget: taskBudget }
      })
    },

    haven_submit: async (input) => {
      const args = objectInput('haven_submit', input)
      const hasTaskBudget = typeof args.task_budget_id === 'string' && args.task_budget_id.length > 0
      const hasSubBudget = typeof args.sub_budget_id === 'string' && args.sub_budget_id.length > 0
      const hasPayment = typeof args.payment_id === 'string' && args.payment_id.length > 0
      if ([hasTaskBudget, hasSubBudget, hasPayment].filter(Boolean).length !== 1) {
        return {
          success: false,
          code: 'INVALID_INPUT',
          message:
            'haven_submit takes exactly one of payment_id, task_budget_id or sub_budget_id, never two ' +
            'or none. Nothing was relayed.',
        }
      }
      if (hasSubBudget) {
        return submitSubBudgetTool(haven, args.sub_budget_id as string, args.signature as string)
      }
      return runTool(async () => {
        if (hasTaskBudget) {
          const result = await haven.submitTaskBudget(args.task_budget_id as string, args.signature as string)
          return {
            task_budget: result.taskBudget,
            status: result.status,
            ...(result.closeTxHash !== undefined ? { close_tx_hash: result.closeTxHash } : {}),
          }
        }
        // #3329: payment_id has no caller on the local surface today — the
        // local runtime signs and submits a direct payment inline through
        // haven.pay(), so a bare signature relay by payment_id has nothing to
        // do here. Declared for schema parity with the hosted surface
        // (captain contract §5); refuses rather than guessing at behavior.
        throw new HavenApiError(
          'haven_submit with payment_id is not supported on the local MCP surface: haven_send ' +
            'signs and submits a direct payment in one call, so there is no separate relay step. ' +
            'Use haven_submit with task_budget_id or sub_budget_id to relay a budget open/close signature.',
          400,
        )
      })
    },
  }

  async function resumeState(
    args: { payment_id?: string; resume_state?: unknown },
    rail: 'x402',
  ): Promise<X402ResumeState> {
    const state =
      args.resume_state ??
      (args.payment_id ? await haven.getResumeState(args.payment_id) : undefined)

    if (!state || typeof state !== 'object') {
      throw new HavenApiError(`haven_resume_${rail}_payment requires resume_state or payment_id.`, 400)
    }

    if ((state as { rail?: unknown }).rail !== rail) {
      throw new HavenApiError(`Resume state is not for the ${rail} rail.`, 409, state)
    }

    return state as X402ResumeState
  }
}

/**
 * RETAINED DELIBERATELY, and unreachable from any live rail (#2101). The same
 * reasoning as the hosted server's copy in
 * `packages/mcp-server/src/tools/support/quote-response.ts` (it was
 * `tools.ts` until #2808 moved the predicate into shared support):
 * no rail mints a payment-level `pending` / `pending_approval` any more (410 on
 * the legacy rail per #1986; 403/502 at prepare with nothing written on the
 * delegation rail; `approval_requests` dropped by #2055), but the one branch it
 * guards is fail-CLOSED — it stops the agent rather than continuing. What was
 * removed is the agent-visible promise: `MCP_INSTRUCTIONS` no longer tells a
 * model to branch on this status or to wait for an approval.
 */
function isPendingApproval(status: string | undefined): boolean {
  return status === 'pending' || status === 'pending_approval'
}

/**
 * Build a structured wrong-tool ToolFailure pointing the agent at the right tool.
 * `code` should be 'WRONG_TOOL' (wrong operation entirely) or 'WRONG_RAIL' (right
 * operation but wrong payment protocol — x402 vs MPP).
 */
function wrongTool(code: string, message: string, suggested_tool?: string): ToolFailure {
  return { success: false, code, message, suggested_tool }
}

/**
 * The one spelling — the #2366 window is over (#3411).
 *
 * Haven's wire convention is snake_case, and the hosted MCP surface already
 * follows it. This package shipped `idempotencyKey` and is PUBLISHED, so the
 * rename could not be a single release: an installed caller passing the old
 * name had to keep working for a window, and be told to move. Owner decision
 * 2026-09-06 — accept both, warn on the old, drop it later. The removal
 * condition: the warning first shipped on the `alpha`/`latest` channel in
 * `0.1.35-alpha.0` (npm, published 2026-09-07); `latest` is many releases
 * past it. The window is closed.
 *
 * `idempotencyKey` stays DECLARED in every schema above and is now REFUSED by
 * name with `IDEMPOTENCY_KEY_RENAMED`, rather than simply deleted from the
 * schema. Deleting it would let the MCP SDK's default `z.object` strip mode
 * silently drop an undeclared key before the handler ever ran — the exact
 * #2348 failure this refusal exists to prevent, since a dropped idempotency
 * key turns a retry into a second spend. Sending BOTH spellings is refused
 * the same way, because the legacy name being present at all is the refusal
 * condition — there is no longer a "resolve the disagreement" step.
 */
/**
 * Parse the input and resolve the idempotency-key spelling, in one step (#2366).
 *
 * Both have to happen BEFORE `runTool`, because a `ToolFailure` returned from
 * inside its callback becomes `data` — a refusal wearing a success. But moving
 * `objectInput` out on its own lost the normalisation `runTool` was giving its
 * schema errors, which turned two "rejects at schema level" tests red. So the
 * pair is hoisted together and normalised here, and every caller gets the same
 * two exits: a failure to return, or args plus any warnings to carry.
 */
function preflight<TName extends HavenMcpToolName>(
  name: TName,
  input: unknown,
): { args: Record<string, any>; warnings: string[] } | ToolFailure {
  let args: Record<string, any>
  try {
    args = objectInput(name, input)
  } catch (err) {
    return normalizeError(err)
  }
  const idem = resolveIdempotencyKey(args)
  if ('success' in idem) return idem
  // #3411: carried under a name distinct from the refused `idempotencyKey`
  // input field, so it cannot be confused with — or accidentally re-trigger
  // — the refusal in `resolveIdempotencyKey` below. The snake_case key still
  // reaches the SDK from here.
  if (idem.key !== undefined) args = { ...args, resolvedIdempotencyKey: idem.key }
  return { args, warnings: idem.warnings }
}

export function resolveIdempotencyKey(
  args: Record<string, unknown>,
): { key?: string; warnings: string[] } | ToolFailure {
  const modern = typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined
  const legacy = typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined

  // #3411: the #2366 window is over. `idempotencyKey` is refused by NAME,
  // whether or not `idempotency_key` was also sent — the schema still
  // DECLARES it (see toolSchemas above) so the MCP SDK does not silently
  // strip it before this code runs (the #2348 failure); it is refused here
  // instead, before anything is contacted or spent.
  if (legacy !== undefined) {
    return {
      success: false,
      code: 'IDEMPOTENCY_KEY_RENAMED',
      message:
        'idempotencyKey has been renamed to idempotency_key and is no longer accepted. ' +
        'Send idempotency_key instead. Nothing was contacted or spent.',
    }
  }
  if (modern !== undefined) return { key: modern, warnings: [] }
  return { warnings: [] }
}

/** Build a JSON-RPC 2.0 tools/call envelope for an MCP merchant. */
function buildMcpToolsCallEnvelope(
  toolName: string,
  args?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: `haven-mcp-${Date.now()}`,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args ?? {},
    },
  }
}

function objectInput<TName extends HavenMcpToolName>(
  name: TName,
  input: unknown,
): Record<string, any> {
  return z.object(toolSchemas[name]).parse(input ?? {})
}

function requestInit(input: { method?: string; headers?: Record<string, string>; body?: string }): RequestInit | undefined {
  if (!input.method && !input.headers && input.body === undefined) return undefined
  return {
    method: input.method,
    headers: input.headers,
    body: input.body,
  }
}

async function runTool<T>(fn: () => Promise<T>, warnings: string[] = []): Promise<ToolPayload<T>> {
  try {
    const data = await fn()
    // #2366: attached only when there is something to say, so a caller that
    // sends the current spelling sees the response shape it always saw.
    return warnings.length > 0 ? { success: true, data, warnings } : { success: true, data }
  } catch (err) {
    return normalizeError(err)
  }
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: parseMaybeJson(text),
  }
}

function parseMaybeJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** The demo merchant's reason code for a settlement wallet below its fail floor (#2979). */
const MERCHANT_OUT_OF_GAS_REASON = 'settlement_wallet_out_of_gas'

/**
 * #3834: the local twin of mcp-server's `merchantOutOfGasMessage`
 * (`support/mcp-context.ts`). Kept here, not shared — the two runtimes do not
 * import each other — and pinned equal by a parity test.
 */
function merchantOutOfGasMessage(settlementsRemaining: unknown, failFloor: unknown): string {
  const remaining = typeof settlementsRemaining === 'number' ? settlementsRemaining : null
  const floor = typeof failFloor === 'number' ? failFloor : null
  const figures =
    remaining !== null && floor !== null
      ? ` It has gas for ${remaining} more settlement${remaining === 1 ? '' : 's'} and refuses new payments below ${floor} (settlements_remaining: ${remaining}, fail_floor: ${floor}).`
      : remaining !== null
        ? ` settlements_remaining: ${remaining}.`
        : ''
  return (
    `The merchant refused this call: its settlement wallet is out of gas (reason_code: ${MERCHANT_OUT_OF_GAS_REASON}).` +
    figures +
    ' No payment was created.' +
    " The merchant's operator must top up its settlement wallet; until then every retry is refused again." +
    ' Tell the user, and re-quote once the merchant has been topped up.'
  )
}

/**
 * #2983: the local-flow counterpart of mcp-server's `HostedToolError` for the
 * `MERCHANT_NOT_READY` failure — carries the same wire fields
 * (`code`, `next_action`, `retry_with_new_quote`) `normalizeError` below
 * reads off it. Not a `HavenApiError`: that class's `code` is hardcoded to
 * `'API_ERROR'`, and this failure needs its own code on the wire.
 */
class MerchantNotReadyError extends Error {
  readonly code = AgentPaymentFailureCode.MerchantNotReady
  readonly statusCode = 503
  readonly nextAction = AgentPaymentNextAction.StopAndTellUser
  // Genuinely retryable — unlike a rejection, nothing about THIS call was
  // wrong; the merchant's own wallet needs to recover first.
  readonly retryWithNewQuote = true

  constructor(
    message: string,
    // #3834: the out-of-gas branch passes its own reason — that message gives
    // no retry_after_s to wait out, so the default would point at nothing.
    readonly nextToolOmittedReason: string = 'the merchant needs to recover first; re-quote after the retry_after_s in the message',
  ) {
    super(message)
    this.name = 'MerchantNotReadyError'
  }
}

/**
 * #2983: mirrors mcp-server's `merchantNotReadyErrorFor` (`mcp-context.ts`)
 * for the local runtime. Only the merchant's OWN refusal shape — `503
 * { error: 'merchant_not_ready', reason_code, settlements_remaining,
 * fail_floor, retry_after_s }` — maps here (`fail_floor` is read for the
 * out-of-gas message, #3834). A bare 503 (a load balancer, an HTML outage
 * page, a non-JSON body) is not a capacity signal and keeps going through
 * the #1301 discovery path. `response.clone()` because the caller still
 * needs to read the ORIGINAL response (for `discoveryMissError`'s status)
 * when this returns null.
 */
async function merchantNotReadyErrorFor(response: Response): Promise<MerchantNotReadyError | null> {
  if (response.status !== 503) return null
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return null
  }
  if (!body || typeof body !== 'object' || (body as Record<string, unknown>).error !== 'merchant_not_ready') {
    return null
  }
  const { reason_code, settlements_remaining, fail_floor, retry_after_s } = body as Record<string, unknown>
  // #3834: out of gas does not recover by waiting — the operator must top the
  // merchant's settlement wallet up. Same sentence as the hosted runtime's
  // `merchantOutOfGasMessage` (mcp-server, support/mcp-context.ts), pinned by
  // a parity test; every other reason keeps the wording below.
  if (reason_code === MERCHANT_OUT_OF_GAS_REASON) {
    return new MerchantNotReadyError(
      merchantOutOfGasMessage(settlements_remaining, fail_floor),
      // Same reason the hosted runtime returns (support/mcp-context.ts).
      "the merchant's operator must top up its settlement wallet first; re-quote after that",
    )
  }
  return new MerchantNotReadyError(
    'The merchant refused this call: it cannot settle a payment right now' +
      (typeof reason_code === 'string' ? ` (reason_code: ${reason_code})` : '') +
      (typeof settlements_remaining === 'number'
        ? `, settlements_remaining: ${settlements_remaining}`
        : '') +
      '. No payment was created.' +
      (typeof retry_after_s === 'number'
        ? ` Retry after approximately ${retry_after_s}s.`
        : ' This is often transient; retry later.'),
  )
}

/**
 * #1301: the local-flow counterpart of mcp-server's `withDiscoveryGuidance`
 * (kept there, not shared — that helper rewrites a thrown `HavenApiError`;
 * this one builds a fresh failure from a non-ok `Response`, since the local
 * `haven.fetch()` idiom never throws for a non-402 answer). Keeps the
 * original probe status authoritative, but tells the agent what discovery
 * tried — the pre-#1301 local failure mode was a silent pass-through of
 * whatever the base path served.
 */
function discoveryMissError(
  response: Response,
  merchantUrl: string,
  discovered: string | null,
  discoveredFromUrl?: string,
): HavenApiError {
  const base = discoveredFromUrl
    ? `Merchant call to ${merchantUrl} failed with HTTP ${response.status} ` +
      `(at the DISCOVERED endpoint ${merchantUrl}, resolved from ${discoveredFromUrl} ` +
      `via the merchant discovery document).`
    : `Merchant call to ${merchantUrl} failed with HTTP ${response.status}.`
  const guidance = discoveredFromUrl
    ? ''
    : discovered
      ? ` Same-origin discovery resolved the same URL (${discovered}), which still did not answer successfully.`
      : ` No same-origin discovery document was found at /.well-known/haven-demo-merchant or /. ` +
        `If ${merchantUrl} is a base merchant URL, pass the exact MCP endpoint instead (often <origin>/mcp).`
  return new HavenApiError(`${base}${guidance}`, response.status || 400)
}

/**
 * #4790 (epic #4788 slice 2): the ten payment-scope refusal codes the backend
 * answers a payment that names a task budget or a sub-budget with. The hosted
 * MCP's `normalizeError` types all ten off `@haven_ai/core`'s
 * `PAYMENT_SCOPE_REFUSAL_CODES`; this package cannot import that
 * workspace-private union (`@haven_ai/mcp` depends on the SDK only), so the
 * table is written here and held equal to the hosted answers by
 * `packages/mcp-server/src/local-hosted-refusal-parity.test.ts`. A member added
 * to the core union without a row here turns that test red.
 *
 * The `Object.hasOwn` guard is load-bearing, not defensive noise: the lookup is
 * keyed by an arbitrary body string, so a body carrying
 * `error_code: "constructor"` (or `toString`, `valueOf`, `hasOwnProperty`,
 * `__proto__`) would otherwise return a truthy non-answer and the branch would
 * emit `code: undefined` — breaking `ToolFailure.code: string`.
 */
const PAYMENT_SCOPE_REFUSAL_ANSWERS: Record<string, { code: string; reason: string }> = {
  task_budget_not_found: {
    code: 'TASK_BUDGET_NOT_FOUND',
    reason:
      'no task budget with this id belongs to this agent, so the payment was refused before anything moved; check the id with haven_get_task_budget, and pay without it only after telling the user',
  },
  task_budget_not_open: {
    code: 'TASK_BUDGET_NOT_OPEN',
    reason:
      'the task budget is not open — a pending one is your own unsigned row (sign it and submit it with haven_submit), while a closed or expired one needs a new task budget, opened after telling the user; haven_get_task_budget says which, and paying without it is allowed only after telling the user',
  },
  task_budget_token_mismatch: {
    code: 'TASK_BUDGET_TOKEN_MISMATCH',
    reason:
      "the payment's token differs from the token the task budget was opened for, so it cannot be charged to it; pay in the task budget's token, or pay without it only after telling the user",
  },
  task_budget_recipient_mismatch: {
    code: 'TASK_BUDGET_RECIPIENT_MISMATCH',
    reason:
      'the payment recipient differs from the recipient pinned on the task budget, so it cannot be charged to it; pay the pinned recipient, or pay without it only after telling the user',
  },
  task_budget_parent_mismatch: {
    code: 'TASK_BUDGET_PARENT_MISMATCH',
    reason:
      'the budget delegation this task budget was carved from is not active or is outside its window, so the task budget cannot authorize a payment and there is no other id to offer; the wallet owner has to restore that delegation, and paying without the task budget is allowed only after telling the user',
  },
  sub_budget_not_found: {
    code: 'SUB_BUDGET_NOT_FOUND',
    reason:
      "no sub-budget with this id belongs to this agent, so the payment was refused before anything moved; the grant is the issuer's — ask the issuer for the right id, and pay without it only after telling the user",
  },
  sub_budget_not_open: {
    code: 'SUB_BUDGET_NOT_OPEN',
    reason:
      "the sub-budget is not open (closed, closing, pending or expired), so it cannot authorize a payment; the grant is the issuer's, not yours — ask the issuer to open it, and pay without it only after telling the user",
  },
  sub_budget_token_mismatch: {
    code: 'SUB_BUDGET_TOKEN_MISMATCH',
    reason:
      "the payment's token differs from the token the sub-budget was granted for, so it cannot be charged to it; pay in the granted token, or pay without it only after telling the user",
  },
  sub_budget_recipient_mismatch: {
    code: 'SUB_BUDGET_RECIPIENT_MISMATCH',
    reason:
      'the payment recipient differs from the recipient pinned on the sub-budget, so it cannot be charged to it; pay the pinned recipient, or pay without it only after telling the user',
  },
  sub_budget_parent_mismatch: {
    code: 'SUB_BUDGET_PARENT_MISMATCH',
    reason:
      "the sub-budget's chain is broken — its parent-child link is closed, or it was not carved from the budget delegation selected for this payment; the grant is the issuer's, so ask the issuer to re-grant it, and pay without it only after telling the user",
  },
}

function paymentScopeRefusalAnswer(errorCode: string | undefined): { code: string; reason: string } | undefined {
  if (!errorCode) return undefined
  if (!Object.hasOwn(PAYMENT_SCOPE_REFUSAL_ANSWERS, errorCode)) return undefined
  return PAYMENT_SCOPE_REFUSAL_ANSWERS[errorCode]
}

/**
 * #4790: the hand-written hosted branches, whose answers a flat table cannot
 * hold — `submission_outcome_unknown` and `prepare_reverted` change their step
 * on a body field, `delegation_expired` is guarded on status 403, and
 * `payment_already_submitted` (#4826) requires the body's payment_id. The
 * reason strings are written here rather than imported: they live in
 * `packages/mcp-server/src/tools/support/errors.ts`, which this package cannot
 * depend on, and the SDK does not export them. The parity test holds every one
 * of them equal to the hosted answer.
 */
const RAIL_UNAVAILABLE_OMITTED_REASON =
  "this Haven deployment cannot serve this chain's payments until its operator provisions it; retrying gets the same answer, so tell the user"
const TASK_BUDGET_EXCEEDED_OMITTED_REASON =
  "the task budget's cap is spent and is enforced on-chain, so retrying cannot succeed; close it and open a new one, or pay without it, after telling the user"
const TASK_BUDGET_EXCEEDS_REMAINING_OMITTED_REASON =
  "the requested cap exceeds the parent budget's remaining, unreserved amount, so no task budget was opened; open a smaller one, or close the open task budgets that reserve it, after telling the user"
const DELEGATION_BUDGET_EXCEEDED_OMITTED_REASON =
  "the agent's period budget is spent and is enforced on-chain, so retrying cannot succeed; the wallet owner can raise the budget in Haven or wait for the period to reset; tell the user the remaining and shortfall figures on this failure"
const DELEGATION_EXPIRED_OMITTED_REASON =
  "the agent's budget for this token has ENDED and is enforced on-chain, so retrying cannot succeed and waiting will not help; ask the owner to set a new one in Haven; tell the user the end date on this failure"
const SUBMISSION_OUTCOME_UNKNOWN_OMITTED_REASON =
  "the payment was submitted but its on-chain outcome is not known yet, and no payment id is available to poll; do not create a new payment for this — tell the user, who can check the account's activity or the userOpHash before paying again"
const ACCOUNT_VALIDATION_FAILED_OMITTED_REASON =
  'the account rejected this payment during on-chain validation (not a signature cause); retrying this payment_id cannot succeed — create a new payment, after telling the user'
const SIGNATURE_REJECTED_OMITTED_REASON =
  'the account rejected this signature during on-chain validation; retrying this payment_id cannot succeed — update the signer, then create a NEW payment, after telling the user'
const PREPARE_REVERTED_OMITTED_REASON =
  'the payment reverted during on-chain simulation (see revert_reason); nothing was signed or moved and retrying the same payment reverts again — tell the user the reason; a budget, recipient or expiry caveat is changed by the wallet owner in Haven'
const PREPARE_REVERTED_FUNDING_OMITTED_REASON =
  'the account does not hold enough of the token to fund this payment; the revert already proves the shortfall and the body carries no token or amount to check with — tell the user the account needs funds, and the payment can be re-made once it is funded'
const ONCHAIN_EXECUTION_FAILED_OMITTED_REASON =
  'this payment_id already failed on-chain and cannot be retried; tell the user what the message says, and create a new payment if they still want to pay'

/** #4790: one typed refusal answer, in the shape the local envelope emits. */
interface TypedRefusalAnswer {
  code: string
  nextAction: AgentPaymentNextAction
  /** The tool the agent should call next, or null when none follows. */
  nextTool: string | null
  nextArguments?: Record<string, unknown>
  /** Why no tool follows — null exactly when `nextTool` is set. */
  nextToolOmittedReason: string | null
  paymentId?: string
}

/**
 * #4790: the typed answer for one of the refusal codes the hosted mapper
 * types, or `null` for any other code — and for `delegation_expired` at a
 * status other than 403, or `payment_already_submitted` without a body
 * payment_id, where the hosted mapper falls back to the generic answer and so
 * does this one.
 */
function typedRefusalAnswer(err: HavenApiError, errorCode: string | undefined): TypedRefusalAnswer | null {
  if (!errorCode) return null
  const scope = paymentScopeRefusalAnswer(errorCode)
  if (scope) {
    return {
      code: scope.code,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason: scope.reason,
    }
  }
  const body = err.body as Record<string, unknown> | undefined
  switch (errorCode) {
    case 'rail_unavailable_for_chain':
      return {
        code: 'RAIL_UNAVAILABLE_FOR_CHAIN',
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        nextTool: null,
        nextToolOmittedReason: RAIL_UNAVAILABLE_OMITTED_REASON,
      }
    case 'task_budget_exceeded':
      return {
        code: 'TASK_BUDGET_EXCEEDED',
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        nextTool: null,
        nextToolOmittedReason: TASK_BUDGET_EXCEEDED_OMITTED_REASON,
      }
    case 'task_budget_exceeds_remaining':
      return {
        code: 'TASK_BUDGET_EXCEEDS_REMAINING',
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        nextTool: null,
        nextToolOmittedReason: TASK_BUDGET_EXCEEDS_REMAINING_OMITTED_REASON,
      }
    case 'delegation_budget_exceeded':
      return {
        code: 'DELEGATION_BUDGET_EXCEEDED',
        nextAction: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
        nextTool: null,
        nextToolOmittedReason: DELEGATION_BUDGET_EXCEEDED_OMITTED_REASON,
      }
    case 'delegation_expired':
      // The hosted branch is guarded on 403; at any other status it gets the
      // generic answer, so this one must too.
      if (err.statusCode !== 403) return null
      return {
        code: 'DELEGATION_EXPIRED',
        nextAction: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
        nextTool: null,
        nextToolOmittedReason: DELEGATION_EXPIRED_OMITTED_REASON,
      }
    case 'payment_already_submitted': {
      // #4826: an x402 authorize replay whose key belongs to a `submitted`
      // payment. The payment is in flight, so the only follow-up is reading
      // its status — never a retry, never a new payment. The hosted branch
      // requires the body's payment_id (check_status_later's default tool
      // cannot be called without one); a body without it falls through to the
      // generic answer on both surfaces.
      const paymentId = typeof body?.payment_id === 'string' ? body.payment_id : undefined
      if (!paymentId) return null
      return {
        code: 'PAYMENT_ALREADY_SUBMITTED',
        nextAction: AgentPaymentNextAction.CheckStatusLater,
        nextTool: 'haven_get_payment_status',
        nextArguments: { payment_id: paymentId },
        nextToolOmittedReason: null,
        paymentId,
      }
    }
    case 'submission_outcome_unknown': {
      const paymentId = typeof body?.payment_id === 'string' ? body.payment_id : undefined
      // With a payment id the status read is truthful and is named; without
      // one it cannot be called, so the answer stops and says why no new
      // payment may be created.
      return paymentId
        ? {
            code: 'SUBMISSION_OUTCOME_UNKNOWN',
            nextAction: AgentPaymentNextAction.CheckStatusLater,
            nextTool: 'haven_get_payment_status',
            nextArguments: { payment_id: paymentId },
            nextToolOmittedReason: null,
            paymentId,
          }
        : {
            code: 'SUBMISSION_OUTCOME_UNKNOWN',
            nextAction: AgentPaymentNextAction.StopAndTellUser,
            nextTool: null,
            nextToolOmittedReason: SUBMISSION_OUTCOME_UNKNOWN_OMITTED_REASON,
          }
    }
    case 'account_validation_failed':
      return {
        code: 'ACCOUNT_VALIDATION_FAILED',
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        nextTool: null,
        nextToolOmittedReason: ACCOUNT_VALIDATION_FAILED_OMITTED_REASON,
      }
    case 'signature_rejected':
      return {
        code: 'SIGNATURE_REJECTED',
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        nextTool: null,
        nextToolOmittedReason: SIGNATURE_REJECTED_OMITTED_REASON,
      }
    case 'prepare_reverted':
      // An insufficient-balance revert names the real remedy — fund the
      // account — instead of the caveat text, which points at the wrong fix.
      return body?.revert_cause === 'insufficient_balance'
        ? {
            code: 'PREPARE_REVERTED',
            nextAction: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
            nextTool: null,
            nextToolOmittedReason: PREPARE_REVERTED_FUNDING_OMITTED_REASON,
          }
        : {
            code: 'PREPARE_REVERTED',
            nextAction: AgentPaymentNextAction.StopAndTellUser,
            nextTool: null,
            nextToolOmittedReason: PREPARE_REVERTED_OMITTED_REASON,
          }
    case 'onchain_execution_failed':
      return {
        code: 'ONCHAIN_EXECUTION_FAILED',
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        nextTool: null,
        nextToolOmittedReason: ONCHAIN_EXECUTION_FAILED_OMITTED_REASON,
      }
    default:
      return null
  }
}

function normalizeError(err: unknown): ToolFailure {
  if (err instanceof MerchantNotReadyError) {
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      nextAction: err.nextAction,
      next_action: err.nextAction,
      retry_with_new_quote: err.retryWithNewQuote,
      // #3103: the local runtime's one decision site — no tool can act until
      // the merchant recovers. The reason rides the error (#3834): the
      // generic one points at the message's retry_after_s, the out-of-gas
      // one at the operator top-up.
      next_tool_omitted_reason: err.nextToolOmittedReason,
    }
  }

  if (err instanceof HavenPaymentStateError) {
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      status: err.status,
      phase: err.phase,
      nextAction: err.nextAction,
      next_action: err.nextAction,
      resume_state: err.resumeState,
      body: err.body,
    }
  }

  if (err instanceof HavenSigningError) {
    return {
      success: false,
      code: err.code,
      message: err.message,
    }
  }

  // #4257: a refused redirect that interrupted a PAID delivery (the local
  // twin of the hosted #1300 treatment in mcp-server's paid-mcp-completion).
  // The payment reached the merchant and nothing came back, so this is the
  // funded, undelivered state: status read first, never a re-pay, never a
  // blind sweep. erc7710 has no funding leg and nothing to sweep.
  if (err instanceof MerchantEgressRefusedError && !err.beforeRequest && err.paymentId) {
    const noFundingLeg = err.settlementScheme === 'erc7710'
    const nextAction = noFundingLeg ? AgentPaymentNextAction.CheckStatusLater : AgentPaymentNextAction.SweepStrandedFunds
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      status: 'merchant_unresponsive_after_funding',
      phase: noFundingLeg ? 'not_delivered' : 'funded_but_unsettled',
      nextAction,
      next_action: nextAction,
      next_tool: 'haven_get_payment_status',
      next_arguments: { payment_id: err.paymentId },
      suggested_tool: 'haven_get_payment_status',
    }
  }

  if (err instanceof HavenApiError) {
    const body = err.body as Record<string, unknown> | undefined
    // #4790: a typed backend refusal answers with the hosted mapper's typed
    // code, step and reason instead of the generic API_ERROR below. The
    // hosted mapper is the reference; `local-hosted-refusal-parity.test.ts`
    // holds the two equal on the fixture bodies.
    const typed = typedRefusalAnswer(err, typeof body?.error_code === 'string' ? body.error_code : undefined)
    if (typed) {
      return {
        success: false,
        code: typed.code,
        message: err.message,
        statusCode: err.statusCode,
        paymentId: err.paymentId ?? typed.paymentId,
        phase: stringOrUndefined(body?.phase),
        nextAction: typed.nextAction,
        next_action: typed.nextAction,
        ...(typed.nextTool ? { next_tool: typed.nextTool, next_tool_name: typed.nextTool } : {}),
        ...(typed.nextArguments ? { next_arguments: typed.nextArguments } : {}),
        ...(typed.nextToolOmittedReason ? { next_tool_omitted_reason: typed.nextToolOmittedReason } : {}),
        body: err.body,
      }
    }
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      phase: stringOrUndefined(body?.phase),
      nextAction:
        stringOrUndefined(body?.nextAction) ??
        stringOrUndefined(body?.next_action) ??
        AgentPaymentNextAction.StopAndTellUser,
      next_action:
        stringOrUndefined(body?.nextAction) ??
        stringOrUndefined(body?.next_action) ??
        AgentPaymentNextAction.StopAndTellUser,
      // #3303: a backend refusal that already names why no tool follows (the
      // 426 `client_outdated` does) keeps that reason at the top level.
      ...(typeof body?.next_tool_omitted_reason === 'string'
        ? { next_tool_omitted_reason: body.next_tool_omitted_reason }
        : {}),
      body: err.body,
    }
  }

  if (err instanceof z.ZodError) {
    // #3723: an argument-schema failure that reaches a handler — the
    // direct-embedder path, or a parse moved inside runTool — is a structured
    // INVALID_INPUT, the same envelope the hosted runtime answers (mirrors
    // mcp-server tools/support/errors.ts), never a raw ZodError or a shrug.
    return {
      success: false,
      code: 'INVALID_INPUT',
      message: err.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; '),
      statusCode: 400,
    }
  }

  if (err instanceof HavenError) {
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
    }
  }

  return {
    success: false,
    code: 'UNKNOWN_ERROR',
    message: err instanceof Error ? err.message : String(err),
    nextAction: AgentPaymentNextAction.StopAndTellUser,
    next_action: AgentPaymentNextAction.StopAndTellUser,
    // #3103: the second local decision site — nothing structured can follow an
    // error this runtime did not recognise.
    next_tool_omitted_reason: 'an error this runtime does not recognise; tell the user what the message says',
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
