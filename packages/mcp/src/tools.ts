import {
  AgentPaymentNextAction,
  HavenApiError,
  HavenClient,
  HavenError,
  HavenPaymentStateError,
  HavenSigningError,
  composeDescription,
  toolDescriptions as sharedDescriptions,
  type MachinePaymentChallenge,
  type MppQuote,
  type MppResumeState,
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
  | 'haven_quote_mpp'
  | 'haven_pay_mpp_challenge'
  | 'haven_resume_mpp_payment'
  | 'haven_get_payment_status'
  | 'haven_get_resume_state'
  | 'haven_get_agent'
  | 'haven_get_allowances'
  | 'haven_list_receipts'
  | 'haven_sweep_delegate'
  | 'haven_discover_tools'

export const toolSchemas: Record<HavenMcpToolName, z.ZodRawShape> = {
  haven_send: {
    asset: z.enum(['ETH', 'USDC']),
    recipient: z.string().min(1),
    amount: z.string().min(1),
    idempotencyKey: z.string().optional(),
  },
  haven_pay_mcp_tool: {
    merchant_url: z.string().url(),
    tool_name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey: z.string().optional(),
  },
  haven_quote_x402: {
    url: z.string().url(),
    method: z.string().optional(),
    headers: headersSchema,
    body: z.string().optional(),
    idempotencyKey: z.string().optional(),
  },
  haven_pay_x402_quote: {
    quote: z.unknown(),
    idempotencyKey: z.string().optional(),
  },
  haven_pay_x402: {
    url: z.string().url(),
    method: z.string().optional(),
    headers: headersSchema,
    body: z.string().optional(),
    idempotencyKey: z.string().optional(),
  },
  haven_resume_x402_payment: {
    payment_id: z.string().optional(),
    resume_state: z.unknown().optional(),
  },
  haven_quote_mpp: {
    url: z.string().url().optional(),
    challenge: z.unknown().optional(),
    method: z.string().optional(),
    headers: headersSchema,
    body: z.string().optional(),
    idempotencyKey: z.string().optional(),
  },
  haven_pay_mpp_challenge: {
    quote: z.unknown(),
    idempotencyKey: z.string().optional(),
  },
  haven_resume_mpp_payment: {
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
    rail: z.enum(['x402', 'mpp']).optional(),
  },
  haven_list_receipts: {
    limit: z.number().int().min(1).max(100).optional(),
  },
}

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
  haven_quote_mpp: composeDescription(sharedDescriptions.quoteMpp),
  haven_pay_mpp_challenge: composeDescription(sharedDescriptions.payMpp),
  haven_resume_mpp_payment: composeDescription(sharedDescriptions.resumeMpp),
  haven_get_payment_status: composeDescription(sharedDescriptions.getPaymentStatus),
  haven_get_resume_state: composeDescription(sharedDescriptions.getResumeState),
  haven_get_agent: composeDescription(sharedDescriptions.getAgent),
  haven_get_allowances: composeDescription(sharedDescriptions.getAllowances),
  haven_sweep_delegate: composeDescription(sharedDescriptions.sweep_delegate),
  haven_discover_tools: composeDescription(sharedDescriptions.discoverTools),
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
  nextAction?: string
  resume_state?: unknown
  body?: unknown
}

export type ToolPayload<T = unknown> = ToolSuccess<T> | ToolFailure

export function createToolHandlers(haven: HavenClient): Record<HavenMcpToolName, (input: unknown) => Promise<ToolPayload>> {
  return {
    haven_send: async (input) => {
      return runTool(async () => {
        const args = objectInput('haven_send', input)
        try {
          const result = await haven.pay({
            token: args.asset,
            amount: args.amount,
            to: args.recipient,
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
            return {
              payment_id: err.paymentId,
              status: 'pending_approval',
              asset: args.asset,
              amount: args.amount,
              recipient: args.recipient,
            }
          }
          throw err
        }
      })
    },

    haven_pay_mcp_tool: async (input) => {
      return runTool(async () => {
        const args = objectInput('haven_pay_mcp_tool', input)
        const envelope = buildMcpToolsCallEnvelope(args.tool_name as string, args.arguments as Record<string, unknown> | undefined)
        const response = await haven.fetch(
          args.merchant_url as string,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope),
          },
          { idempotencyKey: args.idempotencyKey as string | undefined },
        )
        return responsePayload(response)
      })
    },

    haven_quote_x402: async (input) => {
      const args = objectInput('haven_quote_x402', input)
      try {
        return { success: true, data: await haven.quoteX402(args.url, requestInit(args), { idempotencyKey: args.idempotencyKey }) }
      } catch (err) {
        // quoteX402 throws this when the 402 response carries a MACHINE-PAYMENT-CHALLENGE
        // header instead of PAYMENT-REQUIRED — the merchant speaks MPP, not x402.
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
      const args = objectInput('haven_pay_x402_quote', input)
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
      if (!quote.paymentRequired && quote.rail === 'mpp') {
        return wrongTool(
          'WRONG_TOOL',
          'The quote is for the MPP rail. Use haven_pay_mpp_challenge to pay an MPP quote.',
          'haven_pay_mpp_challenge',
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
        const response = await haven.payX402Quote(args.quote as X402Quote, { idempotencyKey: args.idempotencyKey })
        return responsePayload(response)
      })
    },

    haven_pay_x402: async (input) => {
      const args = objectInput('haven_pay_x402', input)
      return runTool(async () => {
        const response = await haven.fetch(args.url, requestInit(args), { idempotencyKey: args.idempotencyKey })
        return responsePayload(response)
      })
    },

    haven_resume_x402_payment: async (input) => {
      const args = objectInput('haven_resume_x402_payment', input)
      // Detect wrong-rail before touching the network so the agent gets a clear
      // suggestion rather than a generic state-mismatch error.
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
        const state = await resumeState(args, 'x402')
        const response = await haven.resumeX402Payment(state)
        return responsePayload(response)
      })
    },

    haven_quote_mpp: async (input) => {
      const args = objectInput('haven_quote_mpp', input)
      try {
        if (args.challenge) {
          return {
            success: true,
            data: await haven.quoteMpp(args.challenge as MachinePaymentChallenge, requestInit(args), {
              idempotencyKey: args.idempotencyKey,
            }),
          }
        }
        if (!args.url) {
          return normalizeError(new HavenApiError('haven_quote_mpp requires either url or challenge.', 400))
        }
        return { success: true, data: await haven.quoteMpp(args.url, requestInit(args), { idempotencyKey: args.idempotencyKey }) }
      } catch (err) {
        // quoteMpp throws this plain Error when the 402 response has a PAYMENT-REQUIRED
        // header but no MACHINE-PAYMENT-CHALLENGE — the merchant speaks x402, not MPP.
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
      const args = objectInput('haven_pay_mpp_challenge', input)
      const quote = args.quote as Record<string, unknown> | null | undefined
      // Guard before network calls so the agent gets actionable guidance.
      if (!quote || typeof quote !== 'object') {
        return wrongTool(
          'WRONG_TOOL',
          'The quote argument is missing or is not a valid MPP quote object. Call haven_quote_mpp first to obtain a quote.',
          'haven_quote_mpp',
        )
      }
      if (quote.paymentRequired || quote.rail === 'x402') {
        return wrongTool(
          'WRONG_TOOL',
          'The quote is for the x402 rail. Use haven_pay_x402_quote to pay an x402 quote.',
          'haven_pay_x402_quote',
        )
      }
      if (!quote.challenge) {
        return wrongTool(
          'WRONG_TOOL',
          'The quote is missing the required challenge field. Call haven_quote_mpp first to obtain a valid MPP quote.',
          'haven_quote_mpp',
        )
      }
      return runTool(async () => {
        const response = await haven.payMppChallenge(args.quote as MppQuote, { idempotencyKey: args.idempotencyKey })
        return responsePayload(response)
      })
    },

    haven_resume_mpp_payment: async (input) => {
      const args = objectInput('haven_resume_mpp_payment', input)
      // Detect wrong-rail before touching the network.
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
        const state = await resumeState(args, 'mpp')
        const response = await haven.resumeMppPayment(state)
        return responsePayload(response)
      })
    },

    haven_get_payment_status: async (input) => {
      const args = objectInput('haven_get_payment_status', input)
      return runTool(async () => haven.getPaymentStatus(args.payment_id))
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
          rail: args.rail === 'x402' || args.rail === 'mpp' ? args.rail : undefined,
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
          asset: entry.asset,
          network: entry.network,
          status: entry.status,
          verified_at: entry.verifiedAt,
          // Which Haven pay tool reaches this entry from the local MCP surface.
          suggested_tool:
            entry.protocol === 'mcp' ? 'haven_pay_mcp_tool'
            : entry.rail === 'x402' ? 'haven_pay_x402'
            : 'haven_quote_mpp',
        }))
      })
    },
    haven_list_receipts: async (input) => {
      const args = objectInput('haven_list_receipts', input)
      return runTool(async () => haven.listReceipts({ limit: args.limit }))
    },
  }

  async function resumeState(
    args: { payment_id?: string; resume_state?: unknown },
    rail: 'x402' | 'mpp',
  ): Promise<X402ResumeState | MppResumeState> {
    const state =
      args.resume_state ??
      (args.payment_id ? await haven.getResumeState(args.payment_id) : undefined)

    if (!state || typeof state !== 'object') {
      throw new HavenApiError(`haven_resume_${rail}_payment requires resume_state or payment_id.`, 400)
    }

    if ((state as { rail?: unknown }).rail !== rail) {
      throw new HavenApiError(`Resume state is not for the ${rail} rail.`, 409, state)
    }

    return state as X402ResumeState | MppResumeState
  }
}

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

async function runTool<T>(fn: () => Promise<T>): Promise<ToolPayload<T>> {
  try {
    return { success: true, data: await fn() }
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

function normalizeError(err: unknown): ToolFailure {
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
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
