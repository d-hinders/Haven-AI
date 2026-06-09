import {
  HavenApiError,
  HavenClient,
  HavenError,
  HavenPaymentStateError,
  composeDescription,
  toolDescriptions as sharedDescriptions,
  type MachinePaymentChallenge,
  type MppQuote,
  type MppResumeState,
  type X402PaymentRequired,
  type X402Quote,
  type X402ResumeState,
} from '@haven_ai/sdk'
import { z } from 'zod/v3'

/**
 * Hosted MCP tool set — keyless.
 *
 * Every tool here either reads agent state or performs the construct/relay
 * half of a payment. None of them sign: quote/pay tools return the unsigned
 * hash for the edge signer to sign, and haven_submit relays a signature the
 * edge produced. The bound `HavenClient` is constructed without a
 * `delegateKey`, so the signing methods are unavailable by construction.
 *
 * The tool surface mirrors the local MCP (`@haven_ai/mcp`) where semantics
 * map cleanly. Tools that require local signing in the local MCP return
 * signing context (payload_hash + x402/mpp context) instead so the agent can
 * route to the local edge signer.
 *
 * Contract: docs/architecture/06-hosted-mcp-connect-flow.md.
 */
export type HostedToolName =
  | 'haven_get_agent'
  | 'haven_get_allowances'
  | 'haven_send'
  | 'haven_pay'
  | 'haven_submit'
  | 'haven_pay_mcp_tool'
  | 'haven_quote_x402'
  | 'haven_pay_x402_quote'
  | 'haven_resume_x402_payment'
  | 'haven_quote_mpp'
  | 'haven_pay_mpp_challenge'
  | 'haven_resume_mpp_payment'
  | 'haven_get_payment_status'
  | 'haven_get_resume_state'
  | 'haven_list_receipts'

/** Legacy aliases kept for one release cycle so existing agents don't break. */
export type HostedToolNameLegacy = 'haven_x402_authorize' | 'haven_list_transactions'

export const toolSchemas: Record<HostedToolName, z.ZodRawShape> = {
  haven_get_agent: {},
  haven_get_allowances: {},
  haven_send: {
    asset: z.enum(['ETH', 'USDC']),
    recipient: z.string().min(1),
    amount: z.string().min(1),
    idempotency_key: z.string().optional(),
  },
  haven_pay: {
    token: z.string().min(1),
    amount: z.string().min(1),
    to: z.string().min(1),
  },
  haven_submit: {
    payment_id: z.string().min(1),
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'signature must be a 0x-prefixed hex string'),
  },
  haven_pay_mcp_tool: {
    merchant_url: z.string().url(),
    tool_name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    idempotency_key: z.string().optional(),
  },
  haven_quote_x402: {
    url: z.string().url(),
    method: z.string().optional(),
    headers: z.record(z.string()).optional(),
  },
  haven_pay_x402_quote: {
    // The parsed HTTP 402 PaymentRequired the agent received from the merchant
    // (or the paymentRequired field from a haven_quote_x402 result).
    // Validated downstream by the SDK; kept loose here to avoid forking the
    // x402 schema in two places.
    payment_required: z.unknown(),
    idempotency_key: z.string().optional(),
  },
  haven_resume_x402_payment: {
    payment_id: z.string().optional(),
    resume_state: z.unknown().optional(),
  },
  haven_quote_mpp: {
    url: z.string().url().optional(),
    challenge: z.unknown().optional(),
    method: z.string().optional(),
    headers: z.record(z.string()).optional(),
  },
  haven_pay_mpp_challenge: {
    quote: z.unknown(),
    idempotency_key: z.string().optional(),
  },
  haven_resume_mpp_payment: {
    payment_id: z.string().optional(),
    resume_state: z.unknown().optional(),
  },
  haven_get_payment_status: {
    payment_id: z.string().min(1),
  },
  haven_get_resume_state: {
    payment_id: z.string().min(1),
  },
  haven_list_receipts: {
    limit: z.number().int().min(1).max(100).optional(),
  },
}

// ── Legacy tool schemas (one release cycle compatibility shim) ───────────────
export const legacyToolSchemas: Record<HostedToolNameLegacy, z.ZodRawShape> = {
  haven_x402_authorize: toolSchemas.haven_pay_x402_quote,
  haven_list_transactions: toolSchemas.haven_list_receipts,
}

const PAY_DESCRIPTION = [
  'Construct a Safe AllowanceModule payment within the agent budget and return the unsigned hash to sign.',
  'For read-only allowance, budget, spend-limit, remaining-amount, or reset-period questions,',
  'call haven_get_allowances instead of constructing a payment.',
  'Returns { payment_id, payload_hash, expires_at } when the amount fits the remaining',
  'on-chain allowance. Sign payload_hash with the local signer (haven_sign) then relay with',
  'haven_submit. Returns { status: "pending_approval", payload_hash: null } when the amount',
  'exceeds the budget; the user must approve it in Haven. Haven never receives the signing key.',
].join(' ')

const SUBMIT_DESCRIPTION = [
  'Relay a delegate signature produced by the local signer to execute a previously constructed',
  'payment. Pass the payment_id from haven_pay, haven_pay_x402_quote, haven_pay_mpp_challenge,',
  'or a resume tool, and the signature over its payload_hash. Only { payment_id, signature } is',
  'sent to Haven — never the signing key. Returns { status, tx_hash }.',
].join(' ')

const PAY_MCP_TOOL_DESCRIPTION = composeDescription({
  ...sharedDescriptions.payMcpTool,
  behavior:
    'Builds the JSON-RPC tools/call envelope and probes the merchant to obtain the x402 payment_required. ' +
    'Creates a funding intent and returns the unsigned payload_hash for the local edge signer. ' +
    'After signing via haven_sign and relaying via haven_submit, call haven_x402_sign_header ' +
    'on the local signer to build the X-PAYMENT header, then retry the merchant with the ' +
    'original JSON-RPC envelope plus the X-PAYMENT header to get the tool result. ' +
    'Haven never receives the signing key.',
})

const QUOTE_X402_DESCRIPTION = composeDescription({
  ...sharedDescriptions.quoteX402,
  behavior:
    'Probes the merchant directly from the hosted MCP server and parses the 402 response. ' +
    'Haven is not contacted. Returns the full quote object including payment_required for ' +
    'haven_pay_x402_quote.',
})

const PAY_X402_QUOTE_DESCRIPTION = [
  'Construct the funding step for an x402 payment and return the unsigned hash for the local',
  'signer to sign. For read-only allowance, budget, spend-limit, remaining-amount, or',
  'reset-period questions, call haven_get_allowances instead of calling this tool.',
  'Pass the payment_required from haven_quote_x402 or directly from the merchant 402 response.',
  'Returns { payment_id, payload_hash, x402 } where x402 carries the accepted option,',
  'resource_url, merchant_to, funding_to, and x402.expected signing context.',
  'Sign payload_hash via haven_sign (passing x402.expected) on the local signer, then relay',
  'with haven_submit to fund the delegate wallet. After submission confirms, call',
  'haven_x402_sign_header on the local signer to build the EIP-3009 X-PAYMENT header, then',
  'retry the merchant yourself.',
  'Returns { status: "pending_approval", payload_hash: null } when the amount exceeds the',
  'budget. Haven never receives the signing key and never talks to the merchant.',
].join(' ')

const RESUME_X402_DESCRIPTION = [
  'Retrieve the signing context for an approved x402 payment so the local signer can build the',
  'EIP-3009 X-PAYMENT header and the agent can retry the merchant.',
  'Use after haven_get_payment_status returns nextAction=retry_original_x402_request.',
  'Pass resume_state (from the original pending-approval response) or payment_id.',
  'Returns { payment_id, payment_required, x402 } with the same signing context shape as',
  'haven_pay_x402_quote so the signer can call haven_x402_sign_header with the x402_binding',
  '(or re-derive it via haven_sign if the binding was lost across a signer restart).',
].join(' ')

const QUOTE_MPP_DESCRIPTION = composeDescription({
  ...sharedDescriptions.quoteMpp,
  behavior:
    'Probes the merchant directly from the hosted MCP server or parses a provided challenge. ' +
    'Haven is not contacted. Returns the full quote for haven_pay_mpp_challenge.',
})

const PAY_MPP_CHALLENGE_DESCRIPTION = [
  'Construct a machine-payment (MPP) payment intent and return the unsigned hash for the local',
  'signer to sign. Pass the quote from haven_quote_mpp.',
  'Returns { payment_id, payload_hash } when within allowance. Sign via haven_sign on the local',
  'signer, then relay with haven_submit.',
  'Returns { status: "pending_approval", payload_hash: null } when the amount exceeds the budget.',
  'Haven never receives the signing key.',
].join(' ')

const RESUME_MPP_DESCRIPTION = [
  'Retrieve the signing context for an approved MPP payment.',
  'Use after haven_get_payment_status returns nextAction=retry_original_x402_request.',
  'Pass resume_state or payment_id. Returns { payment_id, payload_hash, challenge } with the',
  'signing context the local signer needs to complete the payment.',
].join(' ')

export const toolDescriptions: Record<HostedToolName, string> = {
  haven_get_agent: composeDescription(sharedDescriptions.getAgent),
  haven_get_allowances: composeDescription(sharedDescriptions.getAllowances),
  haven_send: composeDescription(sharedDescriptions.send),
  haven_pay: PAY_DESCRIPTION,
  haven_submit: SUBMIT_DESCRIPTION,
  haven_pay_mcp_tool: PAY_MCP_TOOL_DESCRIPTION,
  haven_quote_x402: QUOTE_X402_DESCRIPTION,
  haven_pay_x402_quote: PAY_X402_QUOTE_DESCRIPTION,
  haven_resume_x402_payment: RESUME_X402_DESCRIPTION,
  haven_quote_mpp: QUOTE_MPP_DESCRIPTION,
  haven_pay_mpp_challenge: PAY_MPP_CHALLENGE_DESCRIPTION,
  haven_resume_mpp_payment: RESUME_MPP_DESCRIPTION,
  haven_get_payment_status: composeDescription(sharedDescriptions.getPaymentStatus),
  haven_get_resume_state: composeDescription(sharedDescriptions.getResumeState),
  haven_list_receipts: composeDescription(sharedDescriptions.listReceipts),
}

export interface ToolSuccess<T> {
  success: true
  data: T
}

export interface ToolFailure {
  success: false
  code: string
  message: string
  statusCode?: number
  paymentId?: string
  status?: string
}

export type ToolPayload<T = unknown> = ToolSuccess<T> | ToolFailure

export function createToolHandlers(
  haven: HavenClient,
): Record<HostedToolName, (input: unknown) => Promise<ToolPayload>> {
  return {
    haven_get_agent: async () => runTool(async () => haven.getAgent()),

    haven_get_allowances: async () => runTool(async () => haven.getAllowances()),

    haven_send: async (input) =>
      runTool(async () => {
        const args = parse('haven_send', input)
        try {
          const intent = await haven.createIntent({
            token: args.asset,
            amount: args.amount,
            to: args.recipient,
          })
          return {
            payment_id: intent.paymentId,
            status: intent.status,
            payload_hash: intent.signData.hash,
            expires_at: intent.expiresAt,
            asset: args.asset,
            amount: args.amount,
            recipient: args.recipient,
          }
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return {
              payment_id: err.paymentId,
              status: 'pending_approval',
              payload_hash: null,
              asset: args.asset,
              amount: args.amount,
              recipient: args.recipient,
            }
          }
          throw err
        }
      }),

    haven_pay: async (input) =>
      runTool(async () => {
        const args = parse('haven_pay', input)
        try {
          const intent = await haven.createIntent({
            token: args.token,
            amount: args.amount,
            to: args.to,
          })
          return {
            payment_id: intent.paymentId,
            status: intent.status,
            payload_hash: intent.signData.hash,
            expires_at: intent.expiresAt,
            meta: { token: args.token, amount: args.amount, to: args.to },
          }
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return { payment_id: err.paymentId, status: 'pending_approval', payload_hash: null }
          }
          throw err
        }
      }),

    haven_submit: async (input) =>
      runTool(async () => {
        const args = parse('haven_submit', input)
        const result = await haven.submitSignature(args.payment_id, args.signature)
        return { status: result.status, tx_hash: result.txHash ?? null }
      }),

    haven_pay_mcp_tool: async (input) =>
      runTool(async () => {
        const args = parse('haven_pay_mcp_tool', input)
        const envelope = {
          jsonrpc: '2.0',
          id: `haven-mcp-${Date.now()}`,
          method: 'tools/call',
          params: {
            name: args.tool_name,
            arguments: args.arguments ?? {},
          },
        }
        const init: RequestInit = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope),
        }
        try {
          const quote = await haven.quoteX402(args.merchant_url as string, init, {
            idempotencyKey: args.idempotency_key,
          })
          const intent = await haven.createX402Intent(
            quote.paymentRequired as X402PaymentRequired,
            { idempotencyKey: args.idempotency_key ?? quote.idempotencyKey },
          )
          return {
            ...buildX402SigningContext(intent),
            // Give the agent the request details it needs to retry after signing.
            merchant_url: args.merchant_url,
            tool_name: args.tool_name,
          }
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return { payment_id: err.paymentId, status: 'pending_approval', payload_hash: null }
          }
          throw err
        }
      }),

    haven_quote_x402: async (input) =>
      runTool(async () => {
        const args = parse('haven_quote_x402', input)
        const init: RequestInit = {}
        if (args.method) init.method = args.method
        if (args.headers) init.headers = args.headers
        const quote: X402Quote = await haven.quoteX402(args.url, init)
        // Return the full quote — the agent passes paymentRequired to haven_pay_x402_quote.
        // Omit the captured request snapshot (it's server-side context, not useful at the agent).
        return {
          rail: quote.rail,
          idempotency_key: quote.idempotencyKey,
          payment_required: quote.paymentRequired,
          accepted: quote.accepted,
          resource_url: quote.resourceUrl,
          description: quote.description,
          mime_type: quote.mimeType,
          amount_atomic: quote.amountAtomic,
          amount: quote.amount,
          token: quote.token,
          asset: quote.asset,
          network: quote.network,
          chain_id: quote.chainId,
          merchant_address: quote.merchantAddress,
          max_timeout_seconds: quote.maxTimeoutSeconds,
        }
      }),

    haven_pay_x402_quote: async (input) =>
      runTool(async () => {
        const args = parse('haven_pay_x402_quote', input)
        try {
          const intent = await haven.createX402Intent(
            args.payment_required as X402PaymentRequired,
            { idempotencyKey: args.idempotency_key },
          )
          return buildX402SigningContext(intent)
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return { payment_id: err.paymentId, status: 'pending_approval', payload_hash: null }
          }
          throw err
        }
      }),

    haven_resume_x402_payment: async (input) =>
      runTool(async () => {
        const args = parse('haven_resume_x402_payment', input)
        const state = await resolveResumeState(haven, args, 'x402') as X402ResumeState

        // Verify the payment is ready to retry before returning signing context.
        const status = await haven.getPaymentStatus(state.paymentId)
        if (status.nextAction !== 'retry_original_x402_request') {
          throw new HavenPaymentStateError(
            status.message ??
              `Payment ${state.paymentId} is not ready to resume (nextAction=${status.nextAction}).`,
            409,
            status,
          )
        }

        // Return the same signing context shape as haven_pay_x402_quote so the
        // signer can call haven_x402_sign_header (or re-derive the binding via
        // haven_sign if the binding was lost across a signer restart).
        return {
          payment_id: state.paymentId,
          status: status.status,
          tx_hash: status.txHash ?? null,
          payment_required: state.paymentRequired,
          x402: {
            accepted: state.accepted,
            resource_url: state.resourceUrl,
            amount: state.amount,
            amount_atomic: state.amountAtomic,
            token: state.token,
            asset: state.asset,
            network: state.network,
          },
        }
      }),

    haven_quote_mpp: async (input) =>
      runTool(async () => {
        const args = parse('haven_quote_mpp', input)
        const init: RequestInit = {}
        if (args.method) init.method = args.method
        if (args.headers) init.headers = args.headers
        const quote: MppQuote = args.challenge
          ? await haven.quoteMpp(args.challenge as MachinePaymentChallenge, init)
          : await haven.quoteMpp(args.url as string, init)
        return quote
      }),

    haven_pay_mpp_challenge: async (input) =>
      runTool(async () => {
        const args = parse('haven_pay_mpp_challenge', input)
        const quote = args.quote as MppQuote
        try {
          // Call the internal MPP authorization endpoint directly via the
          // keyless path: POST /machine-payments/authorize returns a payload_hash
          // for the agent to sign, or an already-confirmed tx if auto-executed.
          type PostFn = (path: string, body: Record<string, unknown>) => Promise<unknown>
          const postFn = (haven as unknown as { post?: PostFn }).post
          const raw = await (postFn
            ? postFn.call(haven, '/machine-payments/authorize', {
                challenge: quote.challenge,
                idempotencyKey: args.idempotency_key ?? quote.idempotencyKey,
              })
            : null
          ) as Record<string, unknown> | null

          // Fallback if internal method not available: use createIntent equiv.
          if (raw === null) {
            throw new HavenApiError(
              'haven_pay_mpp_challenge: internal post unavailable; upgrade @haven_ai/sdk.',
              500,
            )
          }

          // Type-narrow the raw response fields.
          const rawTyped = raw as {
            success?: boolean
            tx_hash?: string
            payment_id?: string
            status?: string
            expires_at?: string
            sign_data?: { hash?: string }
          }

          if (rawTyped.success && rawTyped.tx_hash) {
            return { payment_id: rawTyped.payment_id, status: 'confirmed', tx_hash: rawTyped.tx_hash, payload_hash: null }
          }

          if (rawTyped.payment_id && rawTyped.sign_data?.hash) {
            return {
              payment_id: rawTyped.payment_id,
              status: rawTyped.status ?? 'pending_signature',
              payload_hash: rawTyped.sign_data.hash,
              expires_at: rawTyped.expires_at ?? null,
              meta: { challenge: quote.challenge },
            }
          }

          // Over-budget → pending_approval
          if (isPendingApproval(rawTyped.status)) {
            return { payment_id: rawTyped.payment_id, status: 'pending_approval', payload_hash: null }
          }

          throw new HavenApiError(
            `Unexpected machine-payment authorize response: ${JSON.stringify(rawTyped)}`,
            500,
          )
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return { payment_id: err.paymentId, status: 'pending_approval', payload_hash: null }
          }
          throw err
        }
      }),

    haven_resume_mpp_payment: async (input) =>
      runTool(async () => {
        const args = parse('haven_resume_mpp_payment', input)
        const state = await resolveResumeState(haven, args, 'mpp') as MppResumeState

        const status = await haven.getPaymentStatus(state.paymentId)
        if (status.nextAction !== 'retry_original_x402_request') {
          throw new HavenPaymentStateError(
            status.message ??
              `Payment ${state.paymentId} is not ready to resume (nextAction=${status.nextAction}).`,
            409,
            status,
          )
        }

        return {
          payment_id: state.paymentId,
          status: status.status,
          tx_hash: status.txHash ?? null,
          challenge: state.challenge,
          resource_url: state.resourceUrl,
          amount: state.amount,
          amount_atomic: state.amountAtomic,
          asset: state.asset,
          network: state.network,
        }
      }),

    haven_get_payment_status: async (input) =>
      runTool(async () => {
        const args = parse('haven_get_payment_status', input)
        return haven.getPaymentStatus(args.payment_id)
      }),

    haven_get_resume_state: async (input) =>
      runTool(async () => {
        const args = parse('haven_get_resume_state', input)
        return haven.getResumeState(args.payment_id)
      }),

    haven_list_receipts: async (input) =>
      runTool(async () => {
        const args = parse('haven_list_receipts', input)
        return haven.listReceipts({ limit: args.limit })
      }),
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Shape returned by haven_pay_x402_quote and used by haven_resume_x402_payment. */
function buildX402SigningContext(intent: Awaited<ReturnType<HavenClient['createX402Intent']>>) {
  return {
    payment_id: intent.paymentId,
    status: intent.status,
    payload_hash: intent.signData.hash,
    expires_at: intent.expiresAt,
    // The edge signer needs these to build + sign the EIP-3009 merchant header
    // locally after the funding transfer is relayed via haven_submit.
    x402: {
      accepted: intent.accepted,
      resource_url: intent.resourceUrl,
      merchant_to: intent.merchantTo,
      funding_to: intent.fundingTo,
      expected: {
        payment_id: intent.paymentId,
        payload_hash: intent.signData.hash,
        resource_url: intent.accepted.resource ?? intent.resourceUrl,
        merchant_to: intent.merchantTo,
        amount: intent.amountAtomic,
        asset: intent.asset,
        network: intent.network,
        auth: intent.expectedAuth,
      },
    },
  }
}

async function resolveResumeState(
  haven: HavenClient,
  args: { payment_id?: string; resume_state?: unknown },
  rail: 'x402' | 'mpp',
): Promise<X402ResumeState | MppResumeState> {
  if (args.resume_state && typeof args.resume_state === 'object') {
    return args.resume_state as X402ResumeState | MppResumeState
  }
  if (args.payment_id) {
    return haven.getResumeState(args.payment_id) as Promise<X402ResumeState | MppResumeState>
  }
  throw new HavenApiError(
    `haven_resume_${rail}_payment requires resume_state or payment_id.`,
    400,
  )
}

function isPendingApproval(status: string | undefined): boolean {
  return status === 'pending' || status === 'pending_approval'
}

function parse<TName extends HostedToolName>(name: TName, input: unknown): Record<string, any> {
  return z.object(toolSchemas[name]).parse(input ?? {})
}

async function runTool<T>(fn: () => Promise<T>): Promise<ToolPayload<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (err) {
    return normalizeError(err)
  }
}

function normalizeError(err: unknown): ToolFailure {
  if (err instanceof z.ZodError) {
    return {
      success: false,
      code: 'INVALID_INPUT',
      message: err.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; '),
      statusCode: 400,
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
    }
  }
  if (err instanceof HavenApiError) {
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
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
  }
}
