import { randomUUID } from 'node:crypto'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  HavenApiError,
  HavenClient,
  HavenError,
  HavenPaymentStateError,
  composeDescription,
  selectStandardPaymentOption,
  toolDescriptions as sharedDescriptions,
  x402AuthorizationAmount,
  type MachinePaymentChallenge,
  type MppQuote,
  type MppResumeState,
  type SweepAuthorization,
  type X402McpTransport,
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
  | 'haven_complete_mcp_tool'
  | 'haven_settle_mcp_tool'
  | 'haven_quote_x402'
  | 'haven_pay_x402_quote'
  | 'haven_resume_x402_payment'
  | 'haven_quote_mpp'
  | 'haven_pay_mpp_challenge'
  | 'haven_resume_mpp_payment'
  | 'haven_get_payment_status'
  | 'haven_get_resume_state'
  | 'haven_list_receipts'
  | 'haven_sweep_delegate'
  | 'haven_discover_tools'

/** Legacy aliases kept for one release cycle so existing agents don't break. */
export type HostedToolNameLegacy = 'haven_x402_authorize' | 'haven_list_transactions'

export const toolSchemas: Record<HostedToolName, z.ZodRawShape> = {
  haven_get_agent: {},
  haven_get_allowances: {},
  haven_sweep_delegate: {
    // Phase 2 only: the authorization returned by phase 1 and the signature from
    // the local signer. Omit both to run phase 1 (prepare). Passed through to the
    // backend, which re-derives and re-verifies everything before relaying.
    authorization: z
      .object({
        from: z.string(),
        to: z.string(),
        value: z.string(),
        validAfter: z.string(),
        validBefore: z.string(),
        nonce: z.string(),
        token: z.string(),
        chainId: z.number(),
      })
      .optional(),
    signature: z.string().optional(),
  },
  haven_discover_tools: {
    category: z.string().optional(),
    rail: z.enum(['x402', 'mpp']).optional(),
  },
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
    // Optional pre-funding price cap, atomic units of the merchant's asset
    // (same unit as payment_required.accepts[].amount). If the live merchant
    // price exceeds this, the call is rejected before any funding transfer.
    max_amount: z.string().regex(/^[0-9]+$/, 'max_amount must be a decimal atomic amount').optional(),
    idempotency_key: z.string().optional(),
  },
  haven_complete_mcp_tool: {
    payment_id: z.string().min(1),
    merchant_url: z.string().url(),
    tool_name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    mcp_transport: z.object({
      handshake_required: z.boolean(),
      source: z.enum(['path', 'bazaar']),
    }).optional(),
    // The X-PAYMENT header built by the local signer (haven_x402_sign_header).
    payment_header: z.string().min(1),
  },
  haven_settle_mcp_tool: {
    // Fast-path settle: fund (relay signature) AND deliver the merchant header
    // in one hosted call. Combines haven_submit + haven_complete_mcp_tool.
    payment_id: z.string().min(1),
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'signature must be a 0x-prefixed hex string'),
    merchant_url: z.string().url(),
    tool_name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    mcp_transport: z.object({
      handshake_required: z.boolean(),
      source: z.enum(['path', 'bazaar']),
    }).optional(),
    // The X-PAYMENT header built by the local signer (haven_sign_x402).
    payment_header: z.string().min(1),
  },
  haven_quote_x402: {
    url: z.string().url(),
    method: z.string().optional(),
    headers: z.record(z.string()).optional(),
  },
  haven_pay_x402_quote: {
    // The parsed HTTP 402 PaymentRequired the agent received from the merchant
    // (or the paymentRequired field from a haven_quote_x402 result).
    // Validated downstream by the SDK; typed as an object (not z.unknown()) so
    // MCP clients embed it as JSON rather than serialising it to a string.
    payment_required: z.record(z.string(), z.unknown()),
    // Optional pre-funding price cap, atomic units (same unit as
    // payment_required.accepts[].amount). Rejected before funding if exceeded.
    max_amount: z.string().regex(/^[0-9]+$/, 'max_amount must be a decimal atomic amount').optional(),
    idempotency_key: z.string().optional(),
  },
  haven_resume_x402_payment: {
    payment_id: z.string().optional(),
    resume_state: z.record(z.string(), z.unknown()).optional(),
  },
  haven_quote_mpp: {
    url: z.string().url().optional(),
    challenge: z.record(z.string(), z.unknown()).optional(),
    method: z.string().optional(),
    headers: z.record(z.string()).optional(),
  },
  haven_pay_mpp_challenge: {
    quote: z.record(z.string(), z.unknown()),
    idempotency_key: z.string().optional(),
  },
  haven_resume_mpp_payment: {
    payment_id: z.string().optional(),
    resume_state: z.record(z.string(), z.unknown()).optional(),
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
  'or a resume tool, and the signature over its payload_hash. Funding relay sends',
  '{ payment_id, signature } to Haven — never the signing key. Returns { status, tx_hash }.',
  'For decomposed x402 flows, next after confirmed funding: call mcp__haven-signer__haven_x402_sign_header.',
].join(' ')

const PAY_MCP_TOOL_DESCRIPTION = composeDescription({
  ...sharedDescriptions.payMcpTool,
  behavior:
    'Builds the JSON-RPC tools/call envelope and probes the merchant to obtain the x402 payment_required. ' +
    'Creates a funding intent and returns { payment_id, payload_hash, expires_at, payment_required, x402, merchant_url, tool_name, arguments, mcp_transport }. ' +
    'The funding/quote window expires at expires_at; if it expires, re-run haven_pay_mcp_tool with the same idempotency_key before signing again. ' +
    'Finish with two follow-up calls (fast path, recommended): ' +
    '(1) mcp__haven-signer__haven_sign_x402 on the local signer with payload_hash, x402_expected (the nested x402.expected context, including expires_at), and payment_required → { signature, payment_header }; ' +
    '(2) mcp__haven__haven_settle_mcp_tool with payment_id, signature, payment_header, merchant_url, tool_name, arguments, and mcp_transport to fund the delegate and settle with the merchant in one call, returning the tool result. ' +
    'Step-by-step alternative (also key-safe): mcp__haven-signer__haven_sign → mcp__haven__haven_submit → mcp__haven-signer__haven_x402_sign_header → mcp__haven__haven_complete_mcp_tool. ' +
    'Pass payment_required, arguments, and mcp_transport through verbatim from this response. ' +
    'The returned amount/amount_atomic is the amount Haven authorizes for this call — a ceiling the merchant settles at or below — so show it to the user as the maximum, not any catalog/discovery price. ' +
    'Pass max_amount (atomic units) to reject a quote whose authorized amount exceeds the user\'s cap, before any funding moves. Haven never receives the signing key. ' +
    'Next: call mcp__haven-signer__haven_sign_x402.',
})

const COMPLETE_MCP_TOOL_DESCRIPTION = composeDescription({
  summary:
    'Complete an x402 MCP tool payment by delivering the signed X-PAYMENT header to the merchant and returning the tool result.',
  behavior:
    'Final step after haven_x402_sign_header. Re-issues the MCP tools/call to the merchant with the X-PAYMENT header ' +
    '(running a fresh MCP initialize/session handshake server-side) and returns the merchant tool result. ' +
    'Pass payment_id, merchant_url, tool_name, arguments, and mcp_transport exactly as returned by haven_pay_mcp_tool, plus the payment_header from ' +
    'haven_x402_sign_header. The payment_header is a signed, single-use, amount/merchant/nonce-bound authorization — not a key; ' +
    'Haven relays it but never holds signing authority. Call only after haven_submit has confirmed the funding transfer. ' +
    'The payment_id is used to attach merchant evidence or reconciliation context to the already-funded payment. ' +
    'If the funding window expired first, this returns code PAYMENT_WINDOW_EXPIRED with retry_with_new_quote=true. ' +
    'Next: no further Haven tool is needed on success; return the merchant tool result to the user.',
  nextActionGuidance:
    'If the merchant rejects the payment after funding, this returns code MERCHANT_REJECTED_AFTER_FUNDING and the delegate holds stranded funds — reconcile with mcp__haven__haven_sweep_delegate.',
})

const SETTLE_MCP_TOOL_DESCRIPTION = composeDescription({
  summary:
    'Fund and settle an x402 MCP tool payment in one call: relay the funding signature, then deliver the signed X-PAYMENT header to the merchant and return the tool result.',
  behavior:
    'The fast-path final step, combining haven_submit + haven_complete_mcp_tool. Pass payment_id, signature, and payment_header from haven_sign_x402, plus merchant_url, tool_name, arguments, and mcp_transport from haven_pay_mcp_tool. ' +
    'Relays the funding signature to fund the delegate, then (only once funding confirms) re-issues the MCP tools/call to the merchant with the X-PAYMENT header (fresh MCP handshake server-side) and returns the merchant tool result. ' +
    'Both the signature and the payment_header are signed locally by the edge signer — Haven relays them but never holds the key. ' +
    'If funding does not confirm (e.g. pending_approval) it returns { payment_id, settled: false, funding_status } and does not contact the merchant. ' +
    'If the funding window expired it returns code PAYMENT_WINDOW_EXPIRED with retry_with_new_quote=true. ' +
    'Echoes payment_id on both the settled and not-settled responses so you can reconcile against haven_list_receipts / haven_get_payment_status without retaining it from haven_pay_mcp_tool. ' +
    'Next: no further Haven tool is needed on success; return the merchant tool result to the user.',
  nextActionGuidance:
    'If the merchant rejects after funding, this returns code MERCHANT_REJECTED_AFTER_FUNDING and the delegate holds stranded funds — reconcile with mcp__haven__haven_sweep_delegate.',
})

const QUOTE_X402_DESCRIPTION = composeDescription({
  ...sharedDescriptions.quoteX402,
  behavior:
    'Probes the merchant directly from the hosted MCP server and parses the 402 response. ' +
    'Haven is not contacted. Returns the full quote object including payment_required for ' +
    'mcp__haven__haven_pay_x402_quote. Next: call mcp__haven__haven_pay_x402_quote.',
})

const PAY_X402_QUOTE_DESCRIPTION = [
  'Construct the funding step for an x402 payment and return the unsigned hash for the local',
  'signer to sign. For read-only allowance, budget, spend-limit, remaining-amount, or',
  'reset-period questions, call haven_get_allowances instead of calling this tool.',
  'Pass the payment_required from haven_quote_x402 or directly from the merchant 402 response.',
  'Pass max_amount (atomic units) to reject a quote above the user\'s cap before any funding moves.',
  'Returns { payment_id, payload_hash, expires_at, x402 } where x402 carries the accepted option,',
  'resource_url, merchant_to, funding_to, and x402.expected signing context including expires_at.',
  'If expires_at passes before signing, re-quote with the same idempotency_key before signing again.',
  'Sign payload_hash via mcp__haven-signer__haven_sign (passing x402.expected) on the local signer, then relay',
  'with mcp__haven__haven_submit to fund the delegate wallet. After submission confirms, call',
  'mcp__haven-signer__haven_x402_sign_header on the local signer to build the EIP-3009 X-PAYMENT header, then',
  'retry the merchant yourself.',
  'Next: call mcp__haven-signer__haven_sign.',
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
  'Next: call mcp__haven-signer__haven_x402_sign_header when you have the x402_binding, or mcp__haven-signer__haven_sign first to re-derive it.',
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

const SWEEP_DELEGATE_DESCRIPTION = [
  'Recover stranded USDC from the delegate wallet back to the user\'s Haven wallet, gaslessly.',
  'Use when a payment failed or expired after funding, or when a payment status returns',
  'nextAction=sweep_stranded_funds. Two phases, both keyless on this server:',
  '(1) Call with no arguments — returns { status: "signature_required", authorization, expected_auth }',
  '(or { status: "nothing_stranded" } if the delegate is empty).',
  '(2) Pass authorization and expected_auth to the local signer tool haven_sign_sweep_delegate,',
  'then call this tool again with { authorization, signature } to relay it.',
  'The delegate signs an EIP-3009 authorization off-chain (no ETH needed on the delegate);',
  'Haven\'s relayer submits it on-chain and pays gas. Returns { status: "swept", tx_hash, amount }.',
  'Recovers USDC only — stranded native ETH is not recoverable through this gasless path.',
].join(' ')

export const toolDescriptions: Record<HostedToolName, string> = {
  haven_get_agent: composeDescription(sharedDescriptions.getAgent),
  haven_get_allowances: composeDescription(sharedDescriptions.getAllowances),
  haven_sweep_delegate: SWEEP_DELEGATE_DESCRIPTION,
  haven_discover_tools: composeDescription(sharedDescriptions.discoverTools),
  haven_send: composeDescription(sharedDescriptions.send),
  haven_pay: PAY_DESCRIPTION,
  haven_submit: SUBMIT_DESCRIPTION,
  haven_pay_mcp_tool: PAY_MCP_TOOL_DESCRIPTION,
  haven_complete_mcp_tool: COMPLETE_MCP_TOOL_DESCRIPTION,
  haven_settle_mcp_tool: SETTLE_MCP_TOOL_DESCRIPTION,
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
  /** Structured hint pointing the agent at the correct tool for this operation. */
  suggested_tool?: string
  statusCode?: number
  paymentId?: string
  status?: string
  phase?: string
  next_action?: string
  rail?: string
  idempotency_key?: string | null
  retry_with_new_quote?: boolean
}

export type ToolPayload<T = unknown> = ToolSuccess<T> | ToolFailure

export function createToolHandlers(
  haven: HavenClient,
): Record<HostedToolName, (input: unknown) => Promise<ToolPayload>> {
  return {
    haven_get_agent: async () => runTool(async () => haven.getAgent()),

    haven_get_allowances: async () => runTool(async () => haven.getAllowances()),

    haven_sweep_delegate: async (input) =>
      runTool(async () => {
        const args = parse('haven_sweep_delegate', input)

        // Phase 2 — a signature is present: relay the delegate-signed authorization.
        if (args.signature) {
          if (!args.authorization) {
            throw new HavenApiError(
              'authorization is required alongside signature to submit a sweep. ' +
                'Call haven_sweep_delegate with no arguments first to get one.',
              400,
            )
          }
          const result = await haven.submitSweep(
            args.authorization as SweepAuthorization,
            args.signature as string,
          )
          return {
            status: 'swept',
            tx_hash: result.tx_hash,
            asset: result.asset,
            amount: result.amount,
            from_address: result.from_address,
            to_address: result.to_address,
            chain_id: result.chain_id,
            explorer_url: result.explorer_url,
          }
        }

        // Phase 1 — prepare. Keyless: the backend builds the authorization; the
        // local signer (haven_sign_sweep_delegate) signs it.
        const prep = await haven.prepareSweep()
        if (prep.nothing_stranded) {
          return {
            status: 'nothing_stranded',
            asset: prep.asset ?? 'USDC',
            chain_id: prep.chain_id,
            message: prep.message ?? 'No stranded funds to recover.',
          }
        }
        return {
          status: 'signature_required',
          authorization: prep.authorization,
          expected_auth: prep.expected_auth,
          asset: prep.asset,
          amount: prep.amount,
          amount_atomic: prep.amount_atomic,
          sign_with: 'haven_sign_sweep_delegate',
          next_step:
            'Call the local signer tool haven_sign_sweep_delegate with { authorization, expected_auth } ' +
            'to get a signature, then call haven_sweep_delegate again with { authorization, signature }.',
        }
      }),

    haven_discover_tools: async (input) =>
      runTool(async () => {
        const args = parse('haven_discover_tools', input)
        const entries = await haven.discoverTools({
          category: args.category,
          rail: args.rail,
        })
        return entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          description: entry.description,
          category: entry.category,
          resource_url: entry.resourceUrl,
          rail: entry.rail,
          protocol: entry.protocol,
          tool_name: entry.toolName,
          price_display: entry.priceDisplay,
          price_atomic: entry.priceAtomic,
          // Catalog price is a last-verified hint, NOT authoritative. Always
          // confirm the real price from the merchant's live 402 (returned as
          // payment_required / amount_atomic by haven_pay_mcp_tool) before
          // showing a price to the user or paying.
          price_is_indicative: true,
          asset: entry.asset,
          network: entry.network,
          status: entry.status,
          verified_at: entry.verifiedAt,
          // Hosted surface is keyless: x402 entries start with the quote half
          // of the split flow; MCP entries go through haven_pay_mcp_tool.
          suggested_tool:
            entry.protocol === 'mcp' ? 'haven_pay_mcp_tool'
            : entry.rail === 'x402' ? 'haven_quote_x402'
            : 'haven_quote_mpp',
        }))
      }),

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
        const result = await submitSignatureWithExpiryMapping(
          haven,
          args.payment_id,
          args.signature,
        )
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
          // Enforce the optional price cap against the LIVE merchant price,
          // before creating the funding intent. The catalog price is only a hint.
          assertWithinMaxAmount(quote.amountAtomic, args.max_amount as string | undefined, quote.token)
          const intent = await haven.createX402Intent(
            quote.paymentRequired as X402PaymentRequired,
            { idempotencyKey: args.idempotency_key ?? quote.idempotencyKey },
          )
          return {
            ...buildX402SigningContext(intent),
            // The raw merchant 402 PaymentRequired — the local signer needs this
            // verbatim in haven_x402_sign_header to build the EIP-3009 header.
            payment_required: quote.paymentRequired,
            // Authorized amount for this call — a ceiling the merchant settles
            // at or below (maxAmountRequired ?? amount). Show THIS to the user
            // as the maximum, not any catalog price (which is indicative/stale).
            amount_atomic: quote.amountAtomic,
            amount: quote.amount,
            token: quote.token,
            // Request details to pass back to haven_complete_mcp_tool after signing.
            merchant_url: args.merchant_url,
            tool_name: args.tool_name,
            arguments: args.arguments ?? {},
            ...(quote.mcpTransport ? { mcp_transport: serializeMcpTransport(quote.mcpTransport) } : {}),
          }
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return { payment_id: err.paymentId, status: 'pending_approval', payload_hash: null }
          }
          throw err
        }
      }),

    haven_complete_mcp_tool: async (input) =>
      runTool(async () => {
        const args = parse('haven_complete_mcp_tool', input)
        return deliverMerchantPayment(haven, args)
      }),

    haven_settle_mcp_tool: async (input) =>
      runTool(async () => {
        const args = parse('haven_settle_mcp_tool', input)
        // Fast path: fund (relay the signature) then deliver the merchant header
        // in one hosted call. The signature and X-PAYMENT header are both signed
        // by the local edge signer — Haven relays them but never holds the key.
        const funding = await submitSignatureWithExpiryMapping(haven, args.payment_id, args.signature)
        if (funding.status !== 'confirmed') {
          // Funding did not confirm (e.g. queued for approval). Do not deliver the
          // merchant header — return the funding status so the agent can act.
          // Echo payment_id so the agent can cross-reference the queued payment
          // (haven_get_payment_status / haven_list_receipts) without re-deriving it.
          return {
            payment_id: args.payment_id,
            funding_status: funding.status,
            funding_tx_hash: funding.txHash ?? null,
            settled: false,
          }
        }
        const merchant = await deliverMerchantPayment(haven, args, funding.txHash)
        // Pick explicit fields — don't spread the raw HTTP status/ok, which would
        // collide with the funding/payment-status meaning an agent expects here.
        // Echo payment_id so the agent can reconcile this settled payment against
        // haven_list_receipts / haven_get_payment_status without retaining it from
        // the haven_pay_mcp_tool step.
        return {
          payment_id: args.payment_id,
          funding_tx_hash: funding.txHash ?? null,
          settled: true,
          result: merchant.result,
          settlement_tx_hash: merchant.settlement_tx_hash,
        }
      }),

    haven_quote_x402: async (input) => {
      const args = parse('haven_quote_x402', input)
      const init: RequestInit = {}
      if (args.method) init.method = args.method
      if (args.headers) init.headers = args.headers
      try {
        const quote: X402Quote = await haven.quoteX402(args.url, init)
        // Return the full quote — the agent passes paymentRequired to haven_pay_x402_quote.
        // Omit the captured request snapshot (it's server-side context, not useful at the agent).
        return {
          success: true,
          data: {
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
          },
        }
      } catch (err) {
        if (err instanceof HavenApiError && err.message.includes('quoteX402 only supports standard x402')) {
          return wrongTool(
            'WRONG_RAIL',
            'The URL responds with an MPP machine-payment challenge, not an x402 payment. Use haven_quote_mpp to inspect this merchant.',
            'haven_quote_mpp',
          )
        }
        return normalizeError(err)
      }
    },

    haven_pay_x402_quote: async (input) => {
      const args = parse('haven_pay_x402_quote', coerceJsonField(input, 'payment_required'))
      const payReq = args.payment_required as Record<string, unknown> | null | undefined
      if (!payReq || typeof payReq !== 'object') {
        return wrongTool(
          'WRONG_TOOL',
          'The payment_required argument is missing or is not a valid x402 PaymentRequired object. Call haven_quote_x402 first to obtain the payment_required, or use haven_pay_mcp_tool for a full round trip.',
          'haven_quote_x402',
        )
      }
      return runTool(async () => {
        try {
          // Enforce the optional price cap against the merchant-authoritative
          // selected option, before creating the funding intent.
          const option = selectStandardPaymentOption(
            (args.payment_required as X402PaymentRequired).accepts,
          )
          if (option) {
            assertWithinMaxAmount(x402AuthorizationAmount(option), args.max_amount as string | undefined, undefined)
          }
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
      })
    },

    haven_resume_x402_payment: async (input) => {
      const args = parse('haven_resume_x402_payment', input)
      if (args.resume_state && typeof args.resume_state === 'object') {
        const stateRail = (args.resume_state as { rail?: unknown }).rail
        if (stateRail && stateRail !== 'x402') {
          return wrongTool(
            'WRONG_TOOL',
            `The resume state is for the '${stateRail}' rail, not x402. Use haven_resume_mpp_payment instead.`,
            'haven_resume_mpp_payment',
          )
        }
      }
      return runTool(async () => {
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
      })
    },

    haven_quote_mpp: async (input) => {
      const args = parse('haven_quote_mpp', input)
      const init: RequestInit = {}
      if (args.method) init.method = args.method
      if (args.headers) init.headers = args.headers
      try {
        const quote: MppQuote = args.challenge
          ? await haven.quoteMpp(args.challenge as MachinePaymentChallenge, init)
          : await haven.quoteMpp(args.url as string, init)
        return { success: true, data: quote }
      } catch (err) {
        if (err instanceof Error && err.message.includes('No MACHINE-PAYMENT-CHALLENGE header found')) {
          return wrongTool(
            'WRONG_RAIL',
            'The URL responds with an x402 payment requirement, not an MPP machine-payment challenge. Use haven_quote_x402 to inspect this merchant.',
            'haven_quote_x402',
          )
        }
        return normalizeError(err)
      }
    },

    haven_pay_mpp_challenge: async (input) => {
      const args = parse('haven_pay_mpp_challenge', input)
      const quoteArg = args.quote as Record<string, unknown> | null | undefined
      if (!quoteArg || typeof quoteArg !== 'object') {
        return wrongTool(
          'WRONG_TOOL',
          'The quote argument is missing or is not a valid MPP quote object. Call haven_quote_mpp first to obtain a quote.',
          'haven_quote_mpp',
        )
      }
      if (quoteArg.paymentRequired || quoteArg.rail === 'x402') {
        return wrongTool(
          'WRONG_TOOL',
          'The quote is for the x402 rail. Use haven_pay_x402_quote to pay an x402 quote.',
          'haven_pay_x402_quote',
        )
      }
      if (!quoteArg.challenge) {
        return wrongTool(
          'WRONG_TOOL',
          'The quote is missing the required challenge field. Call haven_quote_mpp first to obtain a valid MPP quote.',
          'haven_quote_mpp',
        )
      }
      const quote = args.quote as MppQuote
      return runTool(async () => {
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
      })
    },

    haven_resume_mpp_payment: async (input) => {
      const args = parse('haven_resume_mpp_payment', input)
      if (args.resume_state && typeof args.resume_state === 'object') {
        const stateRail = (args.resume_state as { rail?: unknown }).rail
        if (stateRail && stateRail !== 'mpp') {
          return wrongTool(
            'WRONG_TOOL',
            `The resume state is for the '${stateRail}' rail, not mpp. Use haven_resume_x402_payment instead.`,
            'haven_resume_x402_payment',
          )
        }
      }
      return runTool(async () => {
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
      })
    },

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
    idempotency_key: intent.idempotencyKey,
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
        expires_at: intent.expiresAt,
        auth: intent.expectedAuth,
      },
    },
  }
}

function serializeMcpTransport(input: X402McpTransport | undefined):
  | { handshake_required: boolean; source: X402McpTransport['source'] }
  | undefined {
  if (!input) return undefined
  return {
    handshake_required: input.handshakeRequired,
    source: input.source,
  }
}

function parseMcpTransport(input: unknown): X402McpTransport | undefined {
  if (!input || typeof input !== 'object') return undefined
  const transport = input as { handshake_required?: unknown; source?: unknown }
  if (transport.handshake_required !== true) return undefined
  if (transport.source !== 'path' && transport.source !== 'bazaar') return undefined
  return {
    handshakeRequired: true,
    source: transport.source,
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

function wrongTool(code: string, message: string, suggested_tool?: string): ToolFailure {
  return { success: false, code, message, suggested_tool }
}

/**
 * Pre-funding price guard. `authorizedAtomic` is the amount Haven would
 * authorize for the call — the ceiling the merchant can settle at
 * (`maxAmountRequired ?? amount`), i.e. the user's worst-case spend, which is
 * the right figure to cap. Throws a typed PRICE_EXCEEDS_MAX (preserved by
 * normalizeError) when it exceeds the agent's optional cap, so the call fails
 * BEFORE any funding transfer. The on-chain allowance is still the hard gate;
 * this is an extra agent affordance against surprise overcharges within budget.
 * Compared in atomic BigInt units.
 */
function assertWithinMaxAmount(
  authorizedAtomic: string,
  maxAmount: string | undefined,
  token: string | undefined,
): void {
  if (maxAmount === undefined) return
  let authorized: bigint
  let cap: bigint
  try {
    authorized = BigInt(authorizedAtomic)
    cap = BigInt(maxAmount)
  } catch {
    throw new HavenError(
      'max_amount and the authorized amount must be decimal atomic amounts.',
      'INVALID_MAX_AMOUNT',
      400,
    )
  }
  if (authorized > cap) {
    const unit = token ? `${token}, atomic units` : 'atomic units'
    throw new HavenError(
      `Authorized amount ${authorizedAtomic} exceeds max_amount ${maxAmount} (${unit}); ` +
        `this is the ceiling the merchant can settle at. No funds were moved. ` +
        `Confirm the higher amount with the user before retrying with a larger max_amount.`,
      AgentPaymentFailureCode.PriceExceedsMax,
      400,
    )
  }
}

function parse<TName extends HostedToolName>(name: TName, input: unknown): Record<string, any> {
  return z.object(toolSchemas[name]).parse(input ?? {})
}

class HostedToolError extends Error {
  readonly code: string
  readonly statusCode?: number
  readonly paymentId?: string
  readonly status?: string
  readonly phase?: string
  readonly nextAction?: string
  readonly rail?: string
  readonly idempotencyKey?: string | null
  readonly retryWithNewQuote?: boolean
  readonly suggestedTool?: string

  constructor(input: {
    code: string
    message: string
    statusCode?: number
    paymentId?: string
    status?: string
    phase?: string
    nextAction?: string
    rail?: string
    idempotencyKey?: string | null
    retryWithNewQuote?: boolean
    suggestedTool?: string
  }) {
    super(input.message)
    this.name = 'HostedToolError'
    this.code = input.code
    this.statusCode = input.statusCode
    this.paymentId = input.paymentId
    this.status = input.status
    this.phase = input.phase
    this.nextAction = input.nextAction
    this.rail = input.rail
    this.idempotencyKey = input.idempotencyKey
    this.retryWithNewQuote = input.retryWithNewQuote
    this.suggestedTool = input.suggestedTool
  }
}

/**
 * Deliver the signed X-PAYMENT header to the merchant and shape the result.
 * Shared by haven_complete_mcp_tool (decomposed flow) and haven_settle_mcp_tool
 * (fast flow). Funding has already confirmed before this runs, so a non-2xx
 * merchant response means the delegate holds stranded funds — surface a typed
 * MERCHANT_REJECTED_AFTER_FUNDING (not a soft ok:false) so the agent reconciles
 * via haven_sweep_delegate. The X-PAYMENT header is a signed authorization the
 * edge signer produced — Haven relays it but never holds the key.
 */
async function deliverMerchantPayment(
  haven: HavenClient,
  // Parsed haven_complete_mcp_tool / haven_settle_mcp_tool args (Zod-validated).
  args: Record<string, any>,
  // Funding tx hash from haven_submit when known (settle path); the wait falls
  // back to the payment status when omitted (complete path).
  fundingTxHash?: string,
): Promise<{ status: number; ok: boolean; result: unknown; settlement_tx_hash: string | null }> {
  // Wait for ≥1 on-chain confirmation of the funding tx BEFORE the merchant
  // verifies the X-PAYMENT header — otherwise its balanceOf(delegate) check
  // races the not-yet-mined funding tx and returns "Payment verification
  // failed". No-op if BASE_RPC_URL isn't configured (chainRpcs unset).
  await haven.ensureFundingConfirmed(args.payment_id, fundingTxHash)

  const envelope = {
    jsonrpc: '2.0',
    id: `haven-mcp-${randomUUID()}`,
    method: 'tools/call',
    params: { name: args.tool_name, arguments: args.arguments ?? {} },
  }
  const result = await haven.completeX402MerchantCall({
    url: args.merchant_url,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    },
    paymentId: args.payment_id,
    paymentHeader: args.payment_header,
    mcpTransport: parseMcpTransport(args.mcp_transport),
  })
  if (!result.ok) {
    let status: Awaited<ReturnType<HavenClient['getPaymentStatus']>> | null = null
    try {
      status = await haven.getPaymentStatus(args.payment_id)
    } catch {
      // Preserve the merchant rejection even if status lookup is unavailable.
    }
    throw new HostedToolError({
      code: AgentPaymentFailureCode.MerchantRejectedAfterFunding,
      message:
        `Merchant rejected the payment after funding (HTTP ${result.status}). ` +
        `The delegate wallet may hold stranded funds — reconcile with haven_sweep_delegate. ` +
        `Merchant response: ${JSON.stringify(result.body).slice(0, 500)}`,
      statusCode: result.status,
      paymentId: args.payment_id,
      status: status?.status ?? 'merchant_rejected_after_funding',
      phase: status?.phase ?? 'funded_but_unsettled',
      nextAction: status?.nextAction ?? AgentPaymentNextAction.SweepStrandedFunds,
      rail: status?.rail ?? 'x402',
      idempotencyKey: status?.idempotencyKey,
      suggestedTool: 'haven_sweep_delegate',
    })
  }
  return {
    status: result.status,
    ok: result.ok,
    result: result.body,
    settlement_tx_hash: result.settlementTxHash ?? null,
  }
}

async function submitSignatureWithExpiryMapping(
  haven: HavenClient,
  paymentId: string,
  signature: string,
): ReturnType<HavenClient['submitSignature']> {
  try {
    return await haven.submitSignature(paymentId, signature)
  } catch (err) {
    const mapped = await paymentWindowExpiredErrorFor(haven, paymentId, err)
    if (mapped) throw mapped
    throw err
  }
}

async function paymentWindowExpiredErrorFor(
  haven: HavenClient,
  paymentId: string,
  err: unknown,
): Promise<HostedToolError | null> {
  if (err instanceof HavenPaymentStateError && isX402PaymentWindowExpired(err.state)) {
    return paymentWindowExpiredError(err.state)
  }
  if (!(err instanceof HavenApiError) || err.statusCode !== 410) return null
  try {
    const status = await haven.getPaymentStatus(paymentId)
    if (isX402PaymentWindowExpired(status)) return paymentWindowExpiredError(status)
  } catch {
    // Preserve the original API error if the status lookup cannot confirm this
    // was an x402 funding-window expiry.
  }
  return null
}

function isX402PaymentWindowExpired(state: {
  rail?: string
  status?: string
  phase?: string
  nextAction?: string
}): boolean {
  return state.rail === 'x402' && (state.status === 'expired' || state.phase === 'expired')
}

function paymentWindowExpiredError(state: {
  paymentId: string
  status: string
  phase: string
  nextAction: string
  rail: string
  idempotencyKey?: string | null
}): HostedToolError {
  const idempotencyGuidance = state.idempotencyKey
    ? ` Re-quote with haven_pay_mcp_tool using the same idempotency_key (${state.idempotencyKey}).`
    : ' Re-quote with haven_pay_mcp_tool using the same idempotency_key from the original call.'
  return new HostedToolError({
    code: AgentPaymentFailureCode.PaymentWindowExpired,
    message: `The x402 payment window expired before completion.${idempotencyGuidance}`,
    statusCode: 410,
    paymentId: state.paymentId,
    status: state.status,
    phase: state.phase,
    nextAction: AgentPaymentNextAction.PaymentWindowExpired,
    rail: state.rail,
    idempotencyKey: state.idempotencyKey,
    retryWithNewQuote: true,
    suggestedTool: 'haven_pay_mcp_tool',
  })
}

/**
 * If a caller's transport serialised an object-typed field to a JSON string,
 * parse it back before schema validation (the object-typed schema would
 * otherwise reject the string). Mirrors the same guard in the edge signer.
 */
function coerceJsonField(input: unknown, field: string): unknown {
  if (!input || typeof input !== 'object') return input
  const record = input as Record<string, unknown>
  if (typeof record[field] !== 'string') return input
  try {
    return { ...record, [field]: JSON.parse(record[field] as string) }
  } catch {
    return input
  }
}

async function runTool<T>(fn: () => Promise<T>): Promise<ToolPayload<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (err) {
    return normalizeError(err)
  }
}

function normalizeError(err: unknown): ToolFailure {
  if (err instanceof HostedToolError) {
    return {
      success: false,
      code: err.code,
      message: err.message,
      suggested_tool: err.suggestedTool,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      status: err.status,
      phase: err.phase,
      next_action: err.nextAction,
      rail: err.rail,
      idempotency_key: err.idempotencyKey,
      retry_with_new_quote: err.retryWithNewQuote,
    }
  }
  if (err instanceof z.ZodError) {
    return {
      success: false,
      code: 'INVALID_INPUT',
      message: err.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; '),
      statusCode: 400,
    }
  }
  if (err instanceof HavenPaymentStateError) {
    if (isX402PaymentWindowExpired(err.state)) {
      return normalizeError(paymentWindowExpiredError(err.state))
    }
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      status: err.status,
      phase: err.phase,
      next_action: err.nextAction,
      rail: err.state.rail,
      idempotency_key: err.state.idempotencyKey,
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
