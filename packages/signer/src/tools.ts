import {
  HavenApiError,
  HavenError,
  HavenSigningError,
  type X402PaymentRequired,
} from '@haven_ai/sdk'
import { z } from 'zod/v3'
import {
  appendSigningAuditEntry,
  createSigningAuditEntry,
  hashPayloadForAudit,
  type SigningAuditContext,
} from './audit.js'
import type { EdgeSigner } from './core.js'

/**
 * Local signer tool set. These run on the agent's machine, next to the key,
 * and pair with the hosted server's construct/relay tools (#183). They sign;
 * they never call the Haven API and never emit the key.
 */
export type SignerToolName = 'haven_sign' | 'haven_x402_sign_header'

const x402ExpectedSchema = z.object({
  payment_id: z.string().min(1),
  payload_hash: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'payload_hash must be a 0x-prefixed hex string'),
  resource_url: z.string().url(),
  merchant_to: z.string().min(1),
  amount: z.string().min(1),
  asset: z.string().min(1),
  network: z.string().min(1),
  auth: z.object({
    version: z.literal(1),
    message: z.string().min(1),
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'signature must be a 0x-prefixed hex string'),
    signer: z.string().min(1),
  }),
})

export const toolSchemas: Record<SignerToolName, z.ZodRawShape> = {
  haven_sign: {
    // The unsigned hash from haven_pay / haven_x402_authorize (payload_hash).
    payload_hash: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'payload_hash must be a 0x-prefixed hex string'),
    // Pass x402.expected from hosted haven_x402_authorize when this hash funds
    // a standard x402 merchant retry. The signer records it locally and returns
    // an opaque x402_binding for the later header-signing step.
    x402_expected: x402ExpectedSchema.optional(),
  },
  haven_x402_sign_header: {
    // The parsed HTTP 402 PaymentRequired from the merchant.
    payment_required: z.unknown(),
    // Opaque binding returned by haven_sign when x402_expected was supplied.
    x402_binding: z.string().min(1),
  },
}

const SIGN_DESCRIPTION = [
  'Sign an unsigned Haven payment hash with the local delegate key. The delegate key never leaves',
  'this process. Pass the payload_hash returned by haven_pay or haven_pay_x402_quote.',
  'For x402, also pass x402_expected from haven_pay_x402_quote; the signer records it locally',
  'and returns { signature, x402_binding }. Hand signature to haven_submit, then pass x402_binding',
  'to haven_x402_sign_header. For plain SafeTransfer payments, just pass payload_hash and',
  'relay the returned signature via haven_submit.',
].join(' ')

const X402_SIGN_HEADER_DESCRIPTION = [
  'Build and sign the EIP-3009 X-PAYMENT header for the merchant leg of an x402 payment.',
  'The delegate key stays local — only the signed header crosses any boundary.',
  'Pass the payment_required from the original merchant 402 response and the x402_binding',
  'returned by haven_sign. The signer validates the merchant, amount, resource, asset, and',
  'network against the recorded funding context before signing, and rejects mismatches.',
  'Returns { payment_header, accepted }. Set X-PAYMENT: <payment_header> on your retry to the',
  'merchant. Only call after haven_submit has confirmed the funding step (nextAction=none or',
  'the funding tx has a confirmed status).',
].join(' ')

export const toolDescriptions: Record<SignerToolName, string> = {
  haven_sign: SIGN_DESCRIPTION,
  haven_x402_sign_header: X402_SIGN_HEADER_DESCRIPTION,
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
}

export type ToolPayload<T = unknown> = ToolSuccess<T> | ToolFailure

export interface ToolHandlerOptions {
  audit?: SigningAuditContext & { auditPath: string }
}

export function createToolHandlers(
  signer: EdgeSigner,
  options: ToolHandlerOptions = {},
): Record<SignerToolName, (input: unknown) => Promise<ToolPayload>> {
  return {
    haven_sign: async (input) =>
      runTool(async () => {
        const args = parse('haven_sign', input)
        const x402Expected = args.x402_expected
          ? {
              paymentId: args.x402_expected.payment_id,
              payloadHash: args.x402_expected.payload_hash,
              resourceUrl: args.x402_expected.resource_url,
              merchantTo: args.x402_expected.merchant_to,
              amount: args.x402_expected.amount,
              asset: args.x402_expected.asset,
              network: args.x402_expected.network,
              auth: args.x402_expected.auth,
            }
          : null
        const result = x402Expected
          ? signer.signX402FundingHash(args.payload_hash, x402Expected)
          : null
        if (!result) {
          const signature = signer.signPaymentHash(args.payload_hash)
          await auditSigning('haven_sign', args.payload_hash)
          return { signature }
        }
        await auditSigning('haven_sign', args.payload_hash)
        return { signature: result.signature, x402_binding: result.x402Binding }
      }),

    haven_x402_sign_header: async (input) =>
      runTool(async () => {
        const args = parse('haven_x402_sign_header', input)
        const result = await signer.buildX402PaymentHeader(
          args.payment_required as X402PaymentRequired,
          args.x402_binding,
        )
        await auditSigning(
          'haven_x402_sign_header',
          hashPayloadForAudit(args.payment_required),
        )
        return { payment_header: result.paymentHeader, accepted: result.accepted }
      }),
  }

  async function auditSigning(tool: SignerToolName, payloadHash: string): Promise<void> {
    if (!options.audit) return
    const { auditPath, ...context } = options.audit
    await appendSigningAuditEntry(
      createSigningAuditEntry(tool, payloadHash, {
        ...context,
        delegateAddress: signer.delegateAddress,
      }),
      auditPath,
    )
  }
}

function parse<TName extends SignerToolName>(name: TName, input: unknown): Record<string, any> {
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
  if (err instanceof HavenSigningError) {
    return { success: false, code: err.code, message: err.message }
  }
  if (err instanceof HavenApiError) {
    return { success: false, code: err.code, message: err.message, statusCode: err.statusCode }
  }
  if (err instanceof HavenError) {
    return { success: false, code: err.code, message: err.message, statusCode: err.statusCode }
  }
  return {
    success: false,
    code: 'UNKNOWN_ERROR',
    message: err instanceof Error ? err.message : String(err),
  }
}
