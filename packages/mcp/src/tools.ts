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
  composeDescription,
  discoverMerchantMcpUrl,
  resolveTokenFromAddress,
  sameUrl,
  toolDescriptions as sharedDescriptions,
  verifyPaymentReceipt,
  type HavenClientUpdate,
  type PaymentReceipt,
  type X402Quote,
  type X402ResumeState,
} from '@haven_ai/sdk'
import { z } from 'zod/v3'

const headersSchema = z.record(z.string(), z.string()).optional()

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
  | 'haven_sweep_delegate'
  | 'haven_discover_tools'
  | 'haven_submit_catalog_entry'
  | 'haven_open_task_budget'
  | 'haven_close_task_budget'
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
    /** Legacy spelling, accepted during the #2366 window. Warns; do not use. */
    idempotencyKey: z.string().optional(),
    /** #3329: spend against an open task budget instead of the agent's period budget. */
    task_budget_id: z.string().min(1).optional(),
  },
  haven_pay_mcp_tool: {
    merchant_url: z.string().url(),
    tool_name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    idempotency_key: z.string().optional(),
    /** Legacy spelling, accepted during the #2366 window. Warns; do not use. */
    idempotencyKey: z.string().optional(),
  },
  haven_quote_x402: {
    url: z.string().url(),
    method: z.string().optional(),
    headers: headersSchema,
    body: z.string().optional(),
    idempotency_key: z.string().optional(),
    /** Legacy spelling, accepted during the #2366 window. Warns; do not use. */
    idempotencyKey: z.string().optional(),
  },
  haven_pay_x402_quote: {
    quote: z.unknown(),
    idempotency_key: z.string().optional(),
    /** Legacy spelling, accepted during the #2366 window. Warns; do not use. */
    idempotencyKey: z.string().optional(),
    /** #3329: spend against an open task budget instead of the agent's period budget. */
    task_budget_id: z.string().min(1).optional(),
  },
  haven_pay_x402: {
    url: z.string().url(),
    method: z.string().optional(),
    headers: headersSchema,
    body: z.string().optional(),
    idempotency_key: z.string().optional(),
    /** Legacy spelling, accepted during the #2366 window. Warns; do not use. */
    idempotencyKey: z.string().optional(),
    /** #3329: spend against an open task budget instead of the agent's period budget. */
    task_budget_id: z.string().min(1).optional(),
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
  },
  haven_verify_receipt: {
    receipt: z.unknown(),
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
  // #3329: relays a signature from the local signer — either the open/close
  // signature for a task budget, or (schema parity with the hosted surface)
  // a direct-payment signature by payment_id. Exactly one of task_budget_id /
  // payment_id, never both or neither.
  haven_submit: {
    task_budget_id: z.string().min(1).optional(),
    payment_id: z.string().min(1).optional(),
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'signature must be a 0x-prefixed hex string'),
  },
// #3101: keys survive on the type (see the hosted server's contracts.ts).
} as const satisfies Record<HavenMcpToolName, z.ZodRawShape>

// #3329: outcome language only — never "delegation", "caveat" or "UserOp".
const OPEN_TASK_BUDGET_DESCRIPTION = [
  'Open a budget for one task that ends by itself: a spending cap, good for at most ttl_minutes,',
  'reserved out of the agent\'s own budget and separate from its period reset.',
  'Pass max_amount_human (whole tokens, e.g. "5" for 5 USDC), ttl_minutes (1-1440), and optionally',
  'recipient (pins every payment against this task budget to one address), label, and token',
  '(defaults to USDC). Returns { task_budget, next_action: "sign", next_tool, next_arguments } —',
  'call next_tool with next_arguments EXACTLY as given to get a signature, then relay it with',
  'haven_submit. Spending anything above the reserved amount, past the deadline, or to a',
  'different recipient than the one pinned here is declined on the spot — nothing is queued.',
].join(' ')

const CLOSE_TASK_BUDGET_DESCRIPTION = [
  'End a task budget early, before its deadline, releasing whatever of its cap was unspent back',
  'to the agent\'s own budget. Pass task_budget_id. If the budget was never signed (still pending),',
  'this ends it immediately with { task_budget, status: "closed" } and nothing was ever reserved',
  'on-chain. Otherwise it returns a signature request: { task_budget, next_action: "sign",',
  'next_tool, next_arguments } — call next_tool with next_arguments EXACTLY as given, then relay',
  'the signature with haven_submit. A task budget past its own deadline closes immediately, the',
  'same as the pending case.',
].join(' ')

const SUBMIT_DESCRIPTION = [
  'Relay a signature from the local signer. Pass exactly one of task_budget_id (from',
  'haven_open_task_budget or haven_close_task_budget) or payment_id — never both, never neither —',
  'plus signature. For a task budget this opens or closes it on-chain and returns { task_budget,',
  'status }; a close in progress may return { task_budget, status: "closed", close_tx_hash }.',
].join(' ')

/**
 * MCP tool descriptions, composed from the shared semantic source in
 * `@haven_ai/sdk`'s `tool-descriptions.ts`. Keeping both the SDK tool-calling
 * surface and the MCP surface pointed at the same prose source means new
 * guidance lands in both places at once and a parity test can catch drift.
 */
export const toolDescriptions: Record<HavenMcpToolName, string> = {
  haven_send: composeDescription(sharedDescriptions.send),
  haven_pay_mcp_tool: composeDescription(sharedDescriptions.payMcpTool),
  haven_quote_x402: composeDescription(sharedDescriptions.quoteX402),
  haven_pay_x402_quote: composeDescription(sharedDescriptions.payX402),
  haven_pay_x402: composeDescription(sharedDescriptions.payX402OneShot),
  haven_resume_x402_payment: composeDescription(sharedDescriptions.resumeX402),
  haven_get_payment_status: composeDescription(sharedDescriptions.getPaymentStatus),
  haven_get_resume_state: composeDescription(sharedDescriptions.getResumeState),
  haven_get_agent: composeDescription(sharedDescriptions.getAgent),
  haven_get_allowances: composeDescription(sharedDescriptions.getAllowances),
  haven_sweep_delegate: composeDescription(sharedDescriptions.sweep_delegate),
  haven_discover_tools: composeDescription(sharedDescriptions.discoverTools),
  haven_submit_catalog_entry: composeDescription(sharedDescriptions.submitCatalogEntry),
  haven_list_receipts: composeDescription(sharedDescriptions.listReceipts),
  haven_verify_receipt: composeDescription(sharedDescriptions.verifyReceipt),
  haven_open_task_budget: OPEN_TASK_BUDGET_DESCRIPTION,
  haven_close_task_budget: CLOSE_TASK_BUDGET_DESCRIPTION,
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
   * minimum (`required: true`). Carries the exact command that updates it.
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

export function createToolHandlers(haven: HavenClient): Record<HavenMcpToolName, (input: unknown) => Promise<ToolPayload>> {
  return {
    haven_send: async (input) => {
      // #2366: resolved OUTSIDE the payload so its warnings can ride on the
      // success, and BEFORE anything is contacted so an ambiguous pair refuses
      // without spending.
      const pf = preflight('haven_send', input)
      if ('success' in pf) return pf
      const { args, warnings } = pf
      return runTool(async () => {
        try {
          const result = await haven.pay({
            token: args.asset,
            amount: args.amount,
            to: args.recipient,
            // #1207: was accepted by the schema but silently dropped — now
            // carried to the backend's replay contract.
            idempotencyKey: args.idempotencyKey,
            // #3329: spend against an open task budget instead of the
            // agent's period budget, when the caller names one.
            ...(typeof args.task_budget_id === 'string' ? { taskBudgetId: args.task_budget_id } : {}),
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
      // a success carrying one as its payload, and so the warning can ride on
      // the result.
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
        const idempotencyKey = args.idempotencyKey
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
      try {
        const data = await haven.quoteX402(args.url, requestInit(args), { idempotencyKey: args.idempotencyKey })
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
          idempotencyKey: args.idempotencyKey,
          ...(typeof args.task_budget_id === 'string' ? { taskBudgetId: args.task_budget_id } : {}),
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
          idempotencyKey: args.idempotencyKey,
          ...(typeof args.task_budget_id === 'string' ? { taskBudgetId: args.task_budget_id } : {}),
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
      return runTool(async () => haven.getPaymentStatusWithPostPurchaseAllowance(args.payment_id))
    },

    haven_get_resume_state: async (input) => {
      const args = objectInput('haven_get_resume_state', input)
      return runTool(async () => haven.getResumeState(args.payment_id))
    },

    haven_get_agent: async () => runTool(async () => haven.getAgentSummary()),
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
      return runTool(async () => haven.listReceiptsPage({ limit: args.limit, cursor: args.cursor }))
    },
    haven_verify_receipt: async (input) => {
      const args = objectInput('haven_verify_receipt', input)
      return runTool(async () => verifyPaymentReceipt(args.receipt as PaymentReceipt))
    },

    haven_open_task_budget: async (input) => {
      const args = objectInput('haven_open_task_budget', input)
      return runTool(async () => {
        const token = await resolveTaskBudgetToken(haven, typeof args.token === 'string' ? args.token : undefined)
        const maxAmountAtomic = humanToAtomicOrNull(args.max_amount_human as string, token.decimals)
        if (maxAmountAtomic === null) {
          throw new HavenApiError(
            `max_amount_human ("${args.max_amount_human}") is not a valid decimal amount for ` +
              `${token.symbol} (${token.decimals} decimal places). Nothing was reserved.`,
            400,
          )
        }
        const result = await haven.openTaskBudget({
          tokenAddress: token.address,
          maxAmountAtomic,
          ttlSeconds: Number(args.ttl_minutes) * 60,
          recipientAddress: typeof args.recipient === 'string' ? args.recipient : undefined,
          label: typeof args.label === 'string' ? args.label : undefined,
        })
        return {
          task_budget: result.taskBudget,
          next_action: 'sign',
          next_tool: 'mcp__haven-signer__haven_sign',
          next_arguments: { task_budget_id: result.taskBudget.id },
        }
      })
    },

    haven_close_task_budget: async (input) => {
      const args = objectInput('haven_close_task_budget', input)
      return runTool(async () => {
        const result = await haven.closeTaskBudget(args.task_budget_id as string)
        if (result.status === 'closed') {
          return { task_budget: result.taskBudget, status: 'closed' as const }
        }
        return {
          task_budget: result.taskBudget,
          next_action: 'sign',
          next_tool: 'mcp__haven-signer__haven_sign',
          next_arguments: { task_budget_id: args.task_budget_id },
        }
      })
    },

    haven_submit: async (input) => {
      const args = objectInput('haven_submit', input)
      const hasTaskBudget = typeof args.task_budget_id === 'string' && args.task_budget_id.length > 0
      const hasPayment = typeof args.payment_id === 'string' && args.payment_id.length > 0
      if (hasTaskBudget === hasPayment) {
        return {
          success: false,
          code: 'INVALID_INPUT',
          message:
            'haven_submit takes exactly one of task_budget_id or payment_id, never both or ' +
            'neither. Nothing was relayed.',
        }
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
            'Use haven_submit with task_budget_id to relay a task-budget open/close signature.',
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
 * The one spelling, and the window that gets us there (#2366).
 *
 * Haven's wire convention is snake_case, and the hosted MCP surface already
 * follows it. This package shipped `idempotencyKey` and is PUBLISHED, so the
 * rename cannot be a single release: an installed caller passing the old name
 * must keep working, and must be told. Owner decision 2026-09-06 — accept both,
 * warn on the old, drop it later.
 *
 * Both present with DIFFERENT values is refused rather than resolved. Picking
 * either would be Haven deciding which replay scope the caller meant, and on a
 * payment argument a wrong guess turns a retry into a second spend — the exact
 * failure #2348 measured when the hosted surface dropped the key. Both present
 * and EQUAL is not ambiguous and is accepted.
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
  if (idem.key !== undefined) args = { ...args, idempotencyKey: idem.key }
  return { args, warnings: idem.warnings }
}

export function resolveIdempotencyKey(
  args: Record<string, unknown>,
): { key?: string; warnings: string[] } | ToolFailure {
  const modern = typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined
  const legacy = typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined

  if (modern !== undefined && legacy !== undefined && modern !== legacy) {
    return {
      success: false,
      code: 'AMBIGUOUS_IDEMPOTENCY_KEY',
      message:
        'Both idempotency_key and idempotencyKey were sent with different values. ' +
        'Nothing was contacted or spent. Send exactly one — idempotency_key is the ' +
        'current spelling; idempotencyKey is deprecated and will be removed.',
    }
  }
  if (modern !== undefined) return { key: modern, warnings: [] }
  if (legacy !== undefined) {
    return {
      key: legacy,
      warnings: [
        'idempotencyKey is deprecated and will be removed in a future release of ' +
          '@haven_ai/mcp. Send idempotency_key instead — it is the spelling the hosted ' +
          'Haven MCP surface and every other Haven wire contract use.',
      ],
    }
  }
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

/**
 * #3329: `haven_open_task_budget` takes a symbol-or-address plus a HUMAN
 * amount, but the SDK's `openTaskBudget` takes atomic units against a
 * resolved token address — the same split `haven_check_funds` bridges on the
 * hosted surface. This agent's own allowances are the source of truth for
 * which tokens it may spend at all, so a symbol resolves against THOSE (never
 * a guess), and decimals come from the SDK's own chain registry.
 */
async function resolveTaskBudgetToken(
  haven: HavenClient,
  symbolOrAddress: string | undefined,
): Promise<{ address: string; symbol: string; decimals: number }> {
  const wanted = (symbolOrAddress ?? 'USDC').toLowerCase()
  const { allowances } = await haven.getAllowances()
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(wanted)
  const match = isAddress
    ? allowances.find((a) => a.tokenAddress.toLowerCase() === wanted)
    : allowances.find((a) => (a.tokenSymbol ?? '').toLowerCase() === wanted)
  if (!match) {
    const known = allowances.map((a) => `${a.tokenSymbol} (${a.tokenAddress})`)
    throw new HavenApiError(
      `token "${symbolOrAddress ?? 'USDC'}" is not the symbol or address of any allowance this ` +
        `agent holds${known.length > 0 ? ` (it holds: ${known.join(', ')})` : ' (it holds none)'}. ` +
        'Nothing was reserved.',
      400,
    )
  }
  const resolved = resolveTokenFromAddress(match.tokenAddress)
  return { address: match.tokenAddress, symbol: match.tokenSymbol, decimals: resolved?.decimals ?? 6 }
}

/** A plain decimal string ("5", "0.25") to atomic units, or null if it does not fit `decimals`. */
function humanToAtomicOrNull(human: string, decimals: number): string | null {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(human)) return null
  const [whole, frac = ''] = human.split('.')
  if (frac.length > decimals) return null
  const atomic = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
  return atomic.toString()
}

function parseMaybeJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
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

  constructor(message: string) {
    super(message)
    this.name = 'MerchantNotReadyError'
  }
}

/**
 * #2983: mirrors mcp-server's `merchantNotReadyErrorFor` (`mcp-context.ts`)
 * for the local runtime. Only the merchant's OWN refusal shape — `503
 * { error: 'merchant_not_ready', reason_code, settlements_remaining,
 * retry_after_s }` — maps here. A bare 503 (a load balancer, an HTML outage
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
  const { reason_code, settlements_remaining, retry_after_s } = body as Record<string, unknown>
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
      // the merchant recovers; the message carries retry_after_s.
      next_tool_omitted_reason: 'the merchant needs to recover first; re-quote after the retry_after_s in the message',
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

  if (err instanceof HavenApiError) {
    const body = err.body as Record<string, unknown> | undefined
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
