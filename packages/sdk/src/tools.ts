/**
 * Pre-built tool definitions for AI agent frameworks.
 *
 * These definitions describe Haven's direct SDK tool-calling surface in the
 * formats expected by Claude (Anthropic) and OpenAI.
 *
 * The agent payment surface used by these tools is shared with the
 * `@haven_ai/mcp` server — both consume `toolDescriptions` from
 * `./tool-descriptions.ts`. Each consumer composes its own user-visible string
 * from the same semantic fragments, so guidance lands in both surfaces at
 * once and a downstream test asserts the shared summary appears in every
 * consumer description.
 *
 * Usage with Claude:
 *   const response = await anthropic.messages.create({
 *     tools: havenTools.claude(),
 *     ...
 *   })
 *
 * Usage with OpenAI:
 *   const response = await openai.chat.completions.create({
 *     tools: havenTools.openai(),
 *     ...
 *   })
 */

import { composeDescription, toolDescriptions as sharedDescriptions } from './tool-descriptions.js'

// ── JSON Schema (shared across formats) ──────────────────────────

const makePaymentSchema = {
  type: 'object' as const,
  properties: {
    token: {
      type: 'string' as const,
      description: 'Token to send. Gnosis Chain: EURe, USDC.e, xDAI. Base: USDC, ETH.',
    },
    amount: {
      type: 'string' as const,
      description: 'Amount to send as a decimal string, e.g. "5.00"',
    },
    to: {
      type: 'string' as const,
      description: 'Recipient Ethereum address (0x...)',
    },
    reason: {
      type: 'string' as const,
      description: 'Brief reason for this payment (for audit trail)',
    },
  },
  required: ['token', 'amount', 'to', 'reason'] as const,
}

const getPaymentStatusSchema = {
  type: 'object' as const,
  properties: {
    payment_id: {
      type: 'string' as const,
      description: 'The payment ID returned from make_payment',
    },
  },
  required: ['payment_id'] as const,
}

const getAllowancesSchema = {
  type: 'object' as const,
  properties: {},
  required: [] as const,
}

const authorizeX402Schema = {
  type: 'object' as const,
  properties: {
    url: {
      type: 'string' as const,
      description: 'The URL that returned HTTP 402',
    },
    payTo: {
      type: 'string' as const,
      description: 'Payment recipient address from the 402 response',
    },
    amount: {
      type: 'string' as const,
      description: 'Payment amount in atomic units (e.g. "1000000" for 1 USDC)',
    },
    asset: {
      type: 'string' as const,
      description: 'Token contract address from the 402 response',
    },
    network: {
      type: 'string' as const,
      description: 'CAIP-2 chain ID. "eip155:100" for Gnosis Chain, "eip155:8453" for Base.',
    },
    description: {
      type: 'string' as const,
      description: 'Description of the resource being paid for',
    },
    idempotencyKey: {
      type: 'string' as const,
      description: 'Stable caller-supplied key for this user intent. Reuse it when resuming the same payment.',
    },
  },
  required: ['url', 'payTo', 'amount', 'asset', 'network'] as const,
}

const resumeX402Schema = {
  type: 'object' as const,
  properties: {
    payment_id: {
      type: 'string' as const,
      description: 'The payment ID returned by authorize_x402_payment.',
    },
    url: {
      type: 'string' as const,
      description: 'The original URL that returned HTTP 402.',
    },
    payTo: {
      type: 'string' as const,
      description: 'Payment recipient address from the original 402 response.',
    },
    amount: {
      type: 'string' as const,
      description: 'Payment amount in atomic units from the original 402 response.',
    },
    asset: {
      type: 'string' as const,
      description: 'Token contract address from the original 402 response.',
    },
    network: {
      type: 'string' as const,
      description: 'CAIP-2 chain ID or x402 network from the original 402 response.',
    },
    description: {
      type: 'string' as const,
      description: 'Description of the resource being paid for.',
    },
    idempotencyKey: {
      type: 'string' as const,
      description: 'Stable caller-supplied key used for the original authorization.',
    },
  },
  required: ['payment_id', 'url', 'payTo', 'amount', 'asset', 'network'] as const,
}

const MAKE_PAYMENT_DESCRIPTION =
  'Request and sign a payment from the user-controlled account within its on-chain budget. ' +
  'For read-only allowance, budget, spend-limit, remaining-amount, or reset-period questions, use get_allowances instead of making a payment. ' +
  'Haven authenticates the agent and relays the signed transaction that redeems the agent budget delegation; it does not hold keys or control funds. ' +
  'Gnosis Chain tokens: EURe, USDC.e, xDAI. Base tokens: USDC, ETH.'

// Descriptions are composed from the shared semantic source so the SDK and MCP
// surfaces stay in lockstep. Each constant prepends the shared `summary` (the
// stable substring tests assert on) and then appends the SDK-specific guidance
// for tool-calling consumers.

const GET_STATUS_DESCRIPTION =
  sharedDescriptions.getPaymentStatus.summary + ' ' +
  'Accepts payment intent IDs. Returns the current status, phase, next_action, transaction hash if available, and payment details.'

const GET_ALLOWANCES_DESCRIPTION = composeDescription(sharedDescriptions.getAllowances)

const AUTHORIZE_X402_DESCRIPTION =
  composeDescription(sharedDescriptions.payX402) + ' ' +
  'In this SDK tool set, the allowance lookup tool is get_allowances. ' +
  'When a paid API returns x402 payment requirements, use this tool to sign with the agent-owned delegate key; funding, when the scheme needs it, is redeemed from the agent budget delegation and is bounded by it. ' +
  'Haven relays signed transactions only; the agent key authorizes payment and on-chain limits enforce spend. ' +
  'A payment outside the on-chain budget is declined before any money moves — report the decline and ask the user to raise the budget in Haven; do not loop retries and do not wait for an approval, because none is queued. Preserve the original merchant/MCP session and x402 details. ' +
  'On a manual HTTP retry set BOTH PAYMENT-SIGNATURE (x402 v2) and X-PAYMENT (v1) to the returned payment_header; a strict v2 merchant reads only the first.'

// #2145: the backend now emits nextAction=retry_original_x402_request from
// GET /payments/:id (agent-payment-status.ts) when the funding leg confirmed
// but no merchant response was ever recorded — the crash-recovery case, after
// a 15-minute grace window. This tool's gate requires that exact nextAction,
// so it is reachable again on purpose; the description tells an agent to gate
// on the structured field rather than call this speculatively.
const RESUME_X402_DESCRIPTION =
  sharedDescriptions.resumeX402.summary + ' ' +
  'Only call this after get_payment_status reports nextAction=retry_original_x402_request — that means Haven\'s funding leg confirmed but no merchant response was ever recorded (typically a crash between funding and the merchant retry). ' +
  'Any other nextAction reports a conflict instead of retrying — do not call this speculatively, and do not pay again.'

const SWEEP_DELEGATE_DESCRIPTION = composeDescription(sharedDescriptions.sweep_delegate)

const sweepDelegateSchema = {
  type: 'object' as const,
  properties: {},
  required: [] as readonly string[],
}

// ── Claude (Anthropic) format ────────────────────────────────────

export interface ClaudeTool {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required: readonly string[]
  }
}

function claudeTools(): ClaudeTool[] {
  return [
    {
      name: 'make_payment',
      description: MAKE_PAYMENT_DESCRIPTION,
      input_schema: makePaymentSchema,
    },
    {
      name: 'get_payment_status',
      description: GET_STATUS_DESCRIPTION,
      input_schema: getPaymentStatusSchema,
    },
    {
      name: 'get_allowances',
      description: GET_ALLOWANCES_DESCRIPTION,
      input_schema: getAllowancesSchema,
    },
    {
      name: 'authorize_x402_payment',
      description: AUTHORIZE_X402_DESCRIPTION,
      input_schema: authorizeX402Schema,
    },
    {
      name: 'resume_x402_payment',
      description: RESUME_X402_DESCRIPTION,
      input_schema: resumeX402Schema,
    },
    {
      name: 'haven_sweep_delegate',
      description: SWEEP_DELEGATE_DESCRIPTION,
      input_schema: sweepDelegateSchema,
    },
  ]
}

// ── OpenAI format ────────────────────────────────────────────────

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required: readonly string[]
    }
  }
}

function openaiTools(): OpenAITool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'make_payment',
        description: MAKE_PAYMENT_DESCRIPTION,
        parameters: makePaymentSchema,
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_payment_status',
        description: GET_STATUS_DESCRIPTION,
        parameters: getPaymentStatusSchema,
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_allowances',
        description: GET_ALLOWANCES_DESCRIPTION,
        parameters: getAllowancesSchema,
      },
    },
    {
      type: 'function',
      function: {
        name: 'authorize_x402_payment',
        description: AUTHORIZE_X402_DESCRIPTION,
        parameters: authorizeX402Schema,
      },
    },
    {
      type: 'function',
      function: {
        name: 'resume_x402_payment',
        description: RESUME_X402_DESCRIPTION,
        parameters: resumeX402Schema,
      },
    },
    {
      type: 'function',
      function: {
        name: 'haven_sweep_delegate',
        description: SWEEP_DELEGATE_DESCRIPTION,
        parameters: sweepDelegateSchema,
      },
    },
  ]
}

// ── Public API ───────────────────────────────────────────────────

export const havenTools = {
  /** Tool definitions in Anthropic/Claude format */
  claude: claudeTools,

  /** Tool definitions in OpenAI function-calling format */
  openai: openaiTools,
}
