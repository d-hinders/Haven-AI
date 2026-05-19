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
  },
  required: ['url', 'payTo', 'amount', 'asset', 'network'] as const,
}

const authorizeMachinePaymentSchema = {
  type: 'object' as const,
  properties: {
    challenge: {
      type: 'object' as const,
      description: 'Machine payment challenge returned by a Haven demo endpoint',
    },
  },
  required: ['challenge'] as const,
}

const MAKE_PAYMENT_DESCRIPTION =
  'Request and sign a payment from the user-controlled Safe within approved on-chain limits. ' +
  'Haven authenticates the agent, validates the signed intent, and relays the Safe AllowanceModule transaction; it does not hold keys or control funds. ' +
  'Gnosis Chain tokens: EURe, USDC.e, xDAI. Base tokens: USDC, ETH.'

const GET_STATUS_DESCRIPTION =
  'Check the status of a previously initiated payment. ' +
  'Returns the current status, transaction hash (if confirmed), and payment details.'

const AUTHORIZE_X402_DESCRIPTION =
  'Authorize payment for an HTTP 402 (Payment Required) response. ' +
  'When a paid API returns x402 payment requirements, use this tool to sign with the agent-owned delegate key and request a policy-limited Safe AllowanceModule top-up when needed. ' +
  'Haven relays signed transactions only; the agent key authorizes payment and on-chain limits enforce spend. ' +
  'Use the returned payment_header as the X-PAYMENT header on the retry request.'

const AUTHORIZE_MACHINE_PAYMENT_DESCRIPTION =
  'Authorize a Haven machine-payment challenge, currently for the internal MPP demo rail. ' +
  'The agent signs the payment, Haven relays it within the on-chain allowance, and the tool returns a proof header for the retry request.'

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
      name: 'authorize_x402_payment',
      description: AUTHORIZE_X402_DESCRIPTION,
      input_schema: authorizeX402Schema,
    },
    {
      name: 'authorize_machine_payment',
      description: AUTHORIZE_MACHINE_PAYMENT_DESCRIPTION,
      input_schema: authorizeMachinePaymentSchema,
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
        name: 'authorize_x402_payment',
        description: AUTHORIZE_X402_DESCRIPTION,
        parameters: authorizeX402Schema,
      },
    },
    {
      type: 'function',
      function: {
        name: 'authorize_machine_payment',
        description: AUTHORIZE_MACHINE_PAYMENT_DESCRIPTION,
        parameters: authorizeMachinePaymentSchema,
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
