import {
  HavenApiError,
  HavenError,
  HavenSigningError,
  type X402PaymentRequired,
} from '@haven_ai/sdk'
import { z } from 'zod/v3'
import type { EdgeSigner } from './core.js'

/**
 * Local signer tool set. These run on the agent's machine, next to the key,
 * and pair with the hosted server's construct/relay tools (#183). They sign;
 * they never call the Haven API and never emit the key.
 */
export type SignerToolName = 'haven_sign' | 'haven_x402_sign_header'

export const toolSchemas: Record<SignerToolName, z.ZodRawShape> = {
  haven_sign: {
    // The unsigned hash from haven_pay / haven_x402_authorize (payload_hash).
    payload_hash: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'payload_hash must be a 0x-prefixed hex string'),
  },
  haven_x402_sign_header: {
    // The parsed HTTP 402 PaymentRequired from the merchant.
    payment_required: z.unknown(),
  },
}

const SIGN_DESCRIPTION = [
  'Sign an unsigned Haven payment hash with the delegate key on this machine.',
  'Pass the payload_hash returned by haven_pay or haven_x402_authorize; returns { signature }',
  'to hand to haven_submit. The delegate key never leaves this process.',
].join(' ')

const X402_SIGN_HEADER_DESCRIPTION = [
  'Build and sign the EIP-3009 X-PAYMENT header for the merchant leg of an x402 payment, using',
  'the delegate key on this machine. Pass the same payment_required you gave haven_x402_authorize;',
  'returns { payment_header } to send to the merchant as the X-PAYMENT header on your retry.',
  'Do this only after the funding step (haven_submit) has confirmed.',
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

export function createToolHandlers(
  signer: EdgeSigner,
): Record<SignerToolName, (input: unknown) => Promise<ToolPayload>> {
  return {
    haven_sign: async (input) =>
      runTool(async () => {
        const args = parse('haven_sign', input)
        return { signature: signer.signPaymentHash(args.payload_hash) }
      }),

    haven_x402_sign_header: async (input) =>
      runTool(async () => {
        const args = parse('haven_x402_sign_header', input)
        const result = await signer.buildX402PaymentHeader(
          args.payment_required as X402PaymentRequired,
        )
        return { payment_header: result.paymentHeader, accepted: result.accepted }
      }),
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
