/**
 * Pre-built tool definitions for AI agent frameworks.
 *
 * These definitions describe the `make_payment` and `get_payment_status` tools
 * in the formats expected by Claude (Anthropic) and OpenAI.
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

// ── JSON Schema (shared across formats) ──────────────────────────

const makePaymentSchema = {
  type: 'object' as const,
  properties: {
    token: {
      type: 'string' as const,
      description: 'Token to send. One of: EURe, USDC.e, xDAI',
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

const MAKE_PAYMENT_DESCRIPTION =
  'Send a payment from the Haven-managed Safe wallet. ' +
  "The payment will be validated against the agent's on-chain spending policy. " +
  'Supported tokens: EURe, USDC.e, xDAI. All on Gnosis Chain.'

const GET_STATUS_DESCRIPTION =
  'Check the status of a previously initiated payment. ' +
  'Returns the current status, transaction hash (if confirmed), and payment details.'

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
  ]
}

// ── Public API ───────────────────────────────────────────────────

export const havenTools = {
  /** Tool definitions in Anthropic/Claude format */
  claude: claudeTools,

  /** Tool definitions in OpenAI function-calling format */
  openai: openaiTools,
}
