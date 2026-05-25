import {
  AgentPaymentNextAction,
  HavenApiError,
  HavenClient,
  HavenError,
  HavenPaymentStateError,
  HavenSigningError,
  type MachinePaymentChallenge,
  type MppQuote,
  type MppResumeState,
  type X402Quote,
  type X402ResumeState,
} from '@haven_ai/sdk'
import { z } from 'zod/v3'

const headersSchema = z.record(z.string(), z.string()).optional()

export type HavenMcpToolName =
  | 'haven_quote_x402'
  | 'haven_pay_x402_quote'
  | 'haven_resume_x402_payment'
  | 'haven_quote_mpp'
  | 'haven_pay_mpp_challenge'
  | 'haven_resume_mpp_payment'
  | 'haven_get_payment_status'
  | 'haven_get_resume_state'
  | 'haven_get_agent'
  | 'haven_get_allowances'
  | 'haven_list_receipts'

export const toolSchemas: Record<HavenMcpToolName, z.ZodRawShape> = {
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
  haven_list_receipts: {
    limit: z.number().int().min(1).max(100).optional(),
  },
}

export const toolDescriptions: Record<HavenMcpToolName, string> = {
  haven_quote_x402:
    'Inspect an HTTP 402 x402 paid resource without creating a Haven payment, signature, approval, or on-chain transaction.',
  haven_pay_x402_quote:
    'Pay a previously inspected x402 quote. The delegate key signs locally; Haven only validates and relays signed, on-chain-constrained payment transactions. If approval is needed, preserve the returned resume_state and wait for nextAction=retry_original_x402_request before resuming.',
  haven_resume_x402_payment:
    'Resume an x402 payment after the Haven wallet owner approved the funding step. Accepts either resume_state or payment_id. Only use when get status returns nextAction=retry_original_x402_request; do not start a new merchant session.',
  haven_quote_mpp:
    'Inspect a Haven MPP challenge or paid MPP URL without creating a Haven payment, signature, approval, or on-chain transaction.',
  haven_pay_mpp_challenge:
    'Pay a previously inspected MPP challenge. The delegate key signs locally; Haven only validates and relays signed, on-chain-constrained payment transactions. If approval is needed, preserve resume_state or payment_id.',
  haven_resume_mpp_payment:
    'Resume an MPP payment after the Haven wallet owner approved the funding step. Accepts either resume_state or payment_id and retries the original paid resource.',
  haven_get_payment_status:
    'Fetch structured Haven payment status, including phase and nextAction taxonomy for agent recovery.',
  haven_get_resume_state:
    'Rehydrate stored x402/MPP resume_state by payment_id. This returns context only; signing still happens locally when a resume tool is called.',
  haven_get_agent:
    'Return the authenticated agent identity, Haven wallet, delegate address, chain, and status.',
  haven_get_allowances:
    'Return configured and on-chain allowance state for the authenticated agent. On-chain allowance is the real spend gate.',
  haven_list_receipts:
    'List recent machine-payment receipts/evidence for bookkeeping. Proof header values are not returned.',
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
  phase?: string
  nextAction?: string
  resume_state?: unknown
  body?: unknown
}

export type ToolPayload<T = unknown> = ToolSuccess<T> | ToolFailure

export function createToolHandlers(haven: HavenClient): Record<HavenMcpToolName, (input: unknown) => Promise<ToolPayload>> {
  return {
    haven_quote_x402: async (input) => {
      const args = objectInput('haven_quote_x402', input)
      return runTool(async () => haven.quoteX402(args.url, requestInit(args), { idempotencyKey: args.idempotencyKey }))
    },

    haven_pay_x402_quote: async (input) => {
      const args = objectInput('haven_pay_x402_quote', input)
      return runTool(async () => {
        const response = await haven.payX402Quote(args.quote as X402Quote, { idempotencyKey: args.idempotencyKey })
        return responsePayload(response)
      })
    },

    haven_resume_x402_payment: async (input) => {
      const args = objectInput('haven_resume_x402_payment', input)
      return runTool(async () => {
        const state = await resumeState(args, 'x402')
        const response = await haven.resumeX402Payment(state)
        return responsePayload(response)
      })
    },

    haven_quote_mpp: async (input) => {
      const args = objectInput('haven_quote_mpp', input)
      return runTool(async () => {
        if (args.challenge) {
          return haven.quoteMpp(args.challenge as MachinePaymentChallenge, requestInit(args), {
            idempotencyKey: args.idempotencyKey,
          })
        }
        if (!args.url) {
          throw new HavenApiError('haven_quote_mpp requires either url or challenge.', 400)
        }
        return haven.quoteMpp(args.url, requestInit(args), { idempotencyKey: args.idempotencyKey })
      })
    },

    haven_pay_mpp_challenge: async (input) => {
      const args = objectInput('haven_pay_mpp_challenge', input)
      return runTool(async () => {
        const response = await haven.payMppChallenge(args.quote as MppQuote, { idempotencyKey: args.idempotencyKey })
        return responsePayload(response)
      })
    },

    haven_resume_mpp_payment: async (input) => {
      const args = objectInput('haven_resume_mpp_payment', input)
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

    haven_get_agent: async () => runTool(async () => haven.getAgent()),
    haven_get_allowances: async () => runTool(async () => haven.getAllowances()),
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
