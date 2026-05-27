import {
  HavenApiError,
  HavenClient,
  HavenError,
  HavenPaymentStateError,
  composeDescription,
  toolDescriptions as sharedDescriptions,
} from '@haven_ai/sdk'
import { z } from 'zod/v3'

/**
 * Hosted MCP tool set — keyless.
 *
 * Every tool here either reads agent state or performs the construct/relay
 * half of a payment. None of them sign: `pay` returns the unsigned hash for
 * the edge to sign, and `submit` relays a signature the edge produced. The
 * bound `HavenClient` is constructed without a `delegateKey`, so the signing
 * methods (`pay()`, `sign()`, `authorizeX402()`) are unavailable by
 * construction.
 *
 * Contract: docs/architecture/06-hosted-mcp-connect-flow.md.
 */
export type HostedToolName =
  | 'haven_get_agent'
  | 'haven_get_allowances'
  | 'haven_pay'
  | 'haven_submit'
  | 'haven_get_payment_status'
  | 'haven_list_transactions'

export const toolSchemas: Record<HostedToolName, z.ZodRawShape> = {
  haven_get_agent: {},
  haven_get_allowances: {},
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
  haven_get_payment_status: {
    payment_id: z.string().min(1),
  },
  haven_list_transactions: {
    limit: z.number().int().min(1).max(100).optional(),
  },
}

const PAY_DESCRIPTION = [
  'Construct a payment within the agent budget and return the unsigned hash to sign.',
  'Returns { payment_id, payload_hash, expires_at } when the amount fits the remaining',
  'on-chain allowance — sign payload_hash with the delegate key on your machine, then call',
  'haven_submit. Returns { status: "pending_approval" } (no hash) when the amount exceeds the',
  'budget; the user must approve it in Haven and there is nothing to sign. Haven never receives',
  'the signing key.',
].join(' ')

const SUBMIT_DESCRIPTION = [
  'Relay a delegate signature produced on your machine to execute a previously constructed',
  'payment. Pass the payment_id from haven_pay and the signature over its payload_hash.',
  'Only { payment_id, signature } is sent to Haven — never the key. Returns { status, tx_hash }.',
].join(' ')

export const toolDescriptions: Record<HostedToolName, string> = {
  haven_get_agent: composeDescription(sharedDescriptions.getAgent),
  haven_get_allowances: composeDescription(sharedDescriptions.getAllowances),
  haven_pay: PAY_DESCRIPTION,
  haven_submit: SUBMIT_DESCRIPTION,
  haven_get_payment_status: composeDescription(sharedDescriptions.getPaymentStatus),
  haven_list_transactions: composeDescription(sharedDescriptions.listReceipts),
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
          // Over-budget: the SDK throws rather than returning a hashless intent.
          // Surface it as a structured, non-error result so the agent knows to
          // wait for user approval (see the over-budget branch in the contract).
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return {
              payment_id: err.paymentId,
              status: 'pending_approval',
              payload_hash: null,
            }
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

    haven_get_payment_status: async (input) =>
      runTool(async () => {
        const args = parse('haven_get_payment_status', input)
        return haven.getPaymentStatus(args.payment_id)
      }),

    haven_list_transactions: async (input) =>
      runTool(async () => {
        const args = parse('haven_list_transactions', input)
        return haven.listReceipts({ limit: args.limit })
      }),
  }
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
