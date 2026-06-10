import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  AgentPaymentRail,
} from '../lib/agent-payment-taxonomy.js'

const address = {
  type: 'string',
  pattern: '^0x[0-9a-fA-F]{40}$',
  examples: ['0x1111111111111111111111111111111111111111'],
} as const

const uuid = {
  type: 'string',
  format: 'uuid',
} as const

const tokenSymbol = {
  type: 'string',
  minLength: 1,
  maxLength: 20,
} as const

const allowanceAtomicAmount = {
  type: 'string',
  pattern: '^[0-9]+$',
  description: 'Decimal atomic token amount. Leading zeroes are accepted and canonicalized; effective amount must be positive and capped at uint96 for Safe AllowanceModule compatibility.',
} as const

const allowanceResetPeriodMin = {
  type: 'integer',
  minimum: 0,
  maximum: 65535,
} as const

const isoDateTime = {
  type: 'string',
  format: 'date-time',
} as const

const errorResponse = {
  description: 'Error response',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string' },
          statusCode: { type: 'integer' },
          details: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  },
} as const

const paymentSignData = {
  type: 'object',
  required: ['hash', 'components', 'instructions'],
  properties: {
    hash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
    components: {
      type: 'object',
      required: ['safe', 'token', 'to', 'amount', 'payment_token', 'payment', 'nonce'],
      properties: {
        safe: address,
        token: address,
        to: address,
        amount: { type: 'string', description: 'Atomic token amount.' },
        payment_token: address,
        payment: { type: 'string' },
        nonce: { type: 'integer' },
      },
      additionalProperties: false,
    },
    instructions: { type: 'string' },
  },
  additionalProperties: false,
} as const

const agentPaymentStatus = {
  type: 'object',
  required: [
    'payment_id',
    'kind',
    'rail',
    'status',
    'phase',
    'next_action',
    'amount',
    'token',
    'resource_url',
    'merchant_address',
    'tx_hash',
    'expires_at',
    'chain_id',
    'message',
  ],
  properties: {
    payment_id: uuid,
    kind: { type: 'string', enum: ['payment_intent', 'approval_request'] },
    rail: { $ref: '#/components/schemas/AgentPaymentRail' },
    status: { type: 'string' },
    phase: { $ref: '#/components/schemas/AgentPaymentPhase' },
    next_action: { $ref: '#/components/schemas/AgentPaymentNextAction' },
    amount: { type: 'string', description: 'Human-readable token amount.' },
    token: { type: 'string' },
    resource_url: { type: ['string', 'null'], format: 'uri' },
    merchant_address: { anyOf: [address, { type: 'null' }] },
    tx_hash: { type: ['string', 'null'], pattern: '^0x[0-9a-fA-F]{64}$' },
    expires_at: isoDateTime,
    chain_id: { type: 'integer' },
    message: { type: 'string' },
    amount_atomic: { type: ['string', 'null'] },
    asset: { anyOf: [address, { type: 'null' }] },
    network: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    idempotency_key: { type: ['string', 'null'] },
    x402: { $ref: '#/components/schemas/RailContext' },
    mpp: {
      allOf: [
        { $ref: '#/components/schemas/RailContext' },
        {
          type: 'object',
          properties: {
            challenge_id: { type: ['string', 'null'] },
          },
        },
      ],
    },
  },
  additionalProperties: false,
} as const

const x402AuthorizeResponse = {
  oneOf: [
    { $ref: '#/components/schemas/X402PendingApproval' },
    { $ref: '#/components/schemas/X402SignablePayment' },
    { $ref: '#/components/schemas/X402ConfirmedPayment' },
    { $ref: '#/components/schemas/AgentPaymentStatus' },
  ],
} as const

const bearerIdentityDescription =
  'Agent API keys identify the calling Haven agent only. API auth is identity; signature is authority; on-chain Safe module state is enforcement. API keys alone cannot move funds or authorize payment execution.'

export const openapiSpec = {
  openapi: '3.1.0',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: {
    title: 'Haven Agent Payment API',
    version: '0.1.0',
    summary: 'Machine-readable contract for Haven agent payments.',
    description:
      'Haven is non-custodial smart account software. These endpoints let authenticated agents create payment intents, fetch payment state, and relay independently signed payment payloads. Haven never receives the agent delegate private key and never treats an API key as payment authority.',
  },
  servers: [
    { url: 'https://havenbackend-production-8a00.up.railway.app', description: 'Production Railway backend' },
    { url: 'http://localhost:3001', description: 'Local development backend' },
  ],
  tags: [
    { name: 'Health' },
    { name: 'Agents' },
    { name: 'Connect Agent 2' },
    { name: 'Payments' },
    { name: 'x402' },
    { name: 'Machine payments' },
    { name: 'Transactions' },
  ],
  paths: {
    '/openapi.json': {
      get: {
        tags: ['Health'],
        operationId: 'getOpenApiSpec',
        summary: 'Fetch this OpenAPI document.',
        security: [],
        responses: {
          '200': {
            description: 'OpenAPI 3.1 document for the Haven Agent Payment API.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
            },
          },
        },
      },
    },
    '/health': {
      get: {
        tags: ['Health'],
        operationId: 'getHealth',
        summary: 'Check backend and database health.',
        security: [],
        responses: {
          '200': {
            description: 'Backend is healthy.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
          '503': {
            description: 'Backend is reachable but degraded.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
        },
      },
    },
    '/agents': {
      get: {
        tags: ['Agents'],
        operationId: 'listAgents',
        summary: 'List Haven agents for the signed-in user.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Agents owned by the user.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['agents'],
                  properties: {
                    agents: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Agent' },
                    },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
      post: {
        tags: ['Agents'],
        operationId: 'createAgent',
        summary: 'Create a Haven agent identity and API key.',
        description:
          'Creates the API identity for an agent. Payment authority still comes from the user-controlled Safe, the agent-held delegate key, and on-chain allowance state.',
        security: [{ DashboardJwt: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateAgentRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Agent created. The api_key is shown once and should be stored by the user or agent runtime.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateAgentResponse' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/agents/{id}': {
      get: {
        tags: ['Agents'],
        operationId: 'getAgent',
        summary: 'Fetch one Haven agent.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          '200': {
            description: 'Agent details.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Agent' },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/agents/{id}/delegate-balance': {
      get: {
        tags: ['Agents'],
        operationId: 'getDelegateBalance',
        summary: 'Get on-chain USDC and ETH balance of the agent delegate EOA.',
        description:
          'Reads on-chain balances for the delegate EOA linked to this agent. ' +
          'Used by the dashboard to surface stranded funds and by the sweep flow to show exact amounts. ' +
          'Haven never holds the delegate key; this endpoint only reads balances from the chain.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          '200': {
            description: 'Delegate balance.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['delegate_address', 'safe_address', 'chain_id', 'eth', 'eth_atomic', 'usdc', 'usdc_atomic', 'usdc_address'],
                  properties: {
                    delegate_address: { type: 'string' },
                    safe_address: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    chain_id: { type: 'integer' },
                    eth: { type: 'string' },
                    eth_atomic: { type: 'string' },
                    usdc: { type: 'string' },
                    usdc_atomic: { type: 'string' },
                    usdc_address: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  },
                },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
          '422': errorResponse,
        },
      },
    },
    '/agents/{id}/revoke': {
      post: {
        tags: ['Agents'],
        operationId: 'revokeAgent',
        summary: 'Mark an agent as revoked in Haven.',
        description:
          'Blocks Haven API access for the agent. Users can also revoke or change Safe module permissions outside Haven; on-chain revocation remains the authority boundary.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          '200': {
            description: 'Agent revoked.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SuccessResponse' },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/agent-connection-setups': {
      post: {
        tags: ['Connect Agent 2'],
        operationId: 'createAgentConnectionSetup',
        summary: 'Create a pending Connect Agent 2 setup.',
        description:
          'Creates setup metadata and a short-lived setup token before any agent signing address exists. Haven stores only a setup-token hash and never receives an agent private key.',
        security: [{ DashboardJwt: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateAgentConnectionSetupRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Pending setup created. The setup_token is returned once and should be passed to the local connector.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateAgentConnectionSetupResponse' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
        },
      },
    },
    '/agent-connection-setups/resolve': {
      post: {
        tags: ['Connect Agent 2'],
        operationId: 'resolveAgentConnectionSetup',
        summary: 'Resolve setup details for the local connector.',
        description:
          'Uses the setup token from the request body to return public setup context and an exact challenge message. The response contains no API key or private key material.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ResolveAgentConnectionSetupRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Public setup details and proof-of-possession challenge.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ResolveAgentConnectionSetupResponse' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '409': errorResponse,
          '410': errorResponse,
        },
      },
    },
    '/agent-connection-setups/register': {
      post: {
        tags: ['Connect Agent 2'],
        operationId: 'registerAgentConnectionSetup',
        summary: 'Register a locally generated public signing address.',
        description:
          'The local connector signs the Haven challenge with its locally generated key and sends only the public signing address, proof, and locally generated API-key hash. Haven creates a non-active pending agent and never receives the private key or plaintext API key.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RegisterAgentConnectionSetupRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Public signing address registered. Payment tools remain unavailable until wallet approval activates the agent.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RegisterAgentConnectionSetupResponse' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '409': errorResponse,
          '410': errorResponse,
        },
      },
    },
    '/agent-connection-setups/{setupId}': {
      get: {
        tags: ['Connect Agent 2'],
        operationId: 'getAgentConnectionSetup',
        summary: 'Read pending setup status for the signed-in user.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/SetupId' }],
        responses: {
          '200': {
            description: 'Recoverable setup status for the Haven UI.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AgentConnectionSetupStatus' },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/agent-connection-setups/{setupId}/install-status': {
      post: {
        tags: ['Connect Agent 2'],
        operationId: 'updateAgentConnectionInstallStatus',
        summary: 'Report local connector install readiness.',
        description:
          'Updates best-effort local install/probe metadata only. A setup token may be used only before registration and before expiry; after registration the connector uses the pending agent API key. This endpoint cannot change signing address, wallet, allowances, approval status, or payment authority.',
        security: [{ AgentApiKey: [] }, { SetupToken: [] }],
        parameters: [{ $ref: '#/components/parameters/SetupId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdateConnectorInstallStatusRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Install status updated.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateConnectorInstallStatusResponse' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/agent-connection-setups/{setupId}/wallet-approval': {
      post: {
        tags: ['Connect Agent 2'],
        operationId: 'recordAgentConnectionWalletApproval',
        summary: 'Record wallet approval evidence for Connect Agent 2.',
        description:
          'Records user wallet approval or a Safe multisig proposal for a locally connected setup. Confirmed approvals activate the pending agent only after Haven verifies the live on-chain allowance state for the exact Haven wallet, public signing address, token budgets, and reset periods. Proposed approvals remain non-active until that on-chain authority is live.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/SetupId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RecordAgentConnectionWalletApprovalRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Wallet approval was recorded and the setup status was returned.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AgentConnectionSetupStatus' },
              },
            },
          },
          '202': {
            description: 'Confirmation evidence was recorded, but on-chain authority is not verified yet.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AgentConnectionSetupStatus' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '410': errorResponse,
        },
      },
    },
    '/agent-connection-setups/{setupId}/cancel': {
      post: {
        tags: ['Connect Agent 2'],
        operationId: 'cancelAgentConnectionSetup',
        summary: 'Cancel a pending Connect Agent 2 setup.',
        description:
          'Cancels setup state and revokes the pending agent API key when no on-chain authority has been activated. Active agents must be paused or revoked through normal agent controls.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/SetupId' }],
        responses: {
          '200': {
            description: 'Setup cancelled.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SuccessResponse' },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/payments': {
      get: {
        tags: ['Payments'],
        operationId: 'listAgentPayments',
        summary: 'List recent payment intents for the authenticated agent.',
        security: [{ AgentApiKey: [] }],
        responses: {
          '200': {
            description: 'Recent payment intents.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['payments'],
                  properties: {
                    payments: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/PaymentListItem' },
                    },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
      post: {
        tags: ['Payments'],
        operationId: 'createPaymentIntent',
        summary: 'Create a direct Haven payment intent.',
        description:
          'Creates a signable payment intent or queues an over-budget request for wallet owner approval. The agent must sign returned sign_data with its delegate key before Haven can relay execution.',
        security: [{ AgentApiKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreatePaymentRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Payment intent requires the agent signature.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SignablePaymentIntent' },
              },
            },
          },
          '202': {
            description: 'Payment exceeds remaining on-chain allowance and is waiting for wallet owner approval.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PendingApproval' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/payments/{id}': {
      get: {
        tags: ['Payments'],
        operationId: 'getPaymentIntent',
        summary: 'Fetch direct payment intent status.',
        security: [{ AgentApiKey: [] }],
        parameters: [{ $ref: '#/components/parameters/PaymentId' }],
        responses: {
          '200': {
            description: 'Payment intent status.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PaymentIntentStatus' },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/payments/{id}/sign': {
      post: {
        tags: ['Payments'],
        operationId: 'submitPaymentSignature',
        summary: 'Submit a delegate signature and relay a payment intent.',
        description:
          'The signature must be produced outside Haven by the agent-held delegate key. Haven verifies it against the delegate address and on-chain allowance before relaying.',
        security: [{ AgentApiKey: [] }],
        parameters: [{ $ref: '#/components/parameters/PaymentId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['signature'],
                properties: {
                  signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$' },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Payment execution result.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PaymentExecutionResult' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '409': errorResponse,
          '410': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/payments/{id}/resume_state': {
      get: {
        tags: ['Payments'],
        operationId: 'getPaymentResumeState',
        summary: 'Rehydrate x402 or MPP resume state for a payment id.',
        description:
          'Returns stored protocol context only. This endpoint does not sign, execute, relay, or authorize a payment. The agent still signs locally when it resumes the x402 or MPP flow.',
        security: [{ AgentApiKey: [] }],
        parameters: [{ $ref: '#/components/parameters/PaymentId' }],
        responses: {
          '200': {
            description: 'Serializable x402 or MPP resume state.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PaymentResumeState' },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '410': errorResponse,
        },
      },
    },
    '/x402/authorize': {
      post: {
        tags: ['x402'],
        operationId: 'authorizeX402Payment',
        summary: 'Authorize an x402 funding payment.',
        description:
          'Creates or executes the Haven funding leg for an x402 merchant request. Haven relays only independently signed payloads; it does not sign on behalf of the agent. If approval is required, preserve the original merchant session and resume after next_action is retry_original_x402_request.',
        security: [{ AgentApiKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/X402AuthorizeRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Existing or resumed x402 state.',
            content: {
              'application/json': { schema: x402AuthorizeResponse },
            },
          },
          '201': {
            description: 'Signable or confirmed x402 funding payment.',
            content: {
              'application/json': { schema: x402AuthorizeResponse },
            },
          },
          '202': {
            description: 'x402 funding payment is waiting for wallet owner approval.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/X402PendingApproval' } },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '409': errorResponse,
          '410': errorResponse,
          '429': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/x402': {
      post: {
        tags: ['x402'],
        operationId: 'authorizeX402PaymentLegacy',
        summary: 'Legacy alias for POST /x402/authorize.',
        deprecated: true,
        security: [{ AgentApiKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/X402AuthorizeRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Same response as POST /x402/authorize.',
            content: {
              'application/json': { schema: x402AuthorizeResponse },
            },
          },
          '202': {
            description: 'Same response as POST /x402/authorize.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/X402PendingApproval' } },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '409': errorResponse,
          '429': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/machine-payments/agent': {
      get: {
        tags: ['Machine payments'],
        operationId: 'getMachinePaymentAgent',
        summary: 'Fetch the authenticated agent identity.',
        security: [{ AgentApiKey: [] }],
        responses: {
          '200': {
            description: 'Agent identity for machine-payment tools.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MachinePaymentAgent' },
              },
            },
          },
          '401': errorResponse,
        },
      },
    },
    '/machine-payments/allowances': {
      get: {
        tags: ['Machine payments'],
        operationId: 'getMachinePaymentAllowances',
        summary: 'Fetch live allowance state for the authenticated agent.',
        security: [{ AgentApiKey: [] }],
        responses: {
          '200': {
            description: 'Configured and on-chain allowance state.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AllowanceSummary' },
              },
            },
          },
          '401': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/machine-payments/authorize': {
      post: {
        tags: ['Machine payments'],
        operationId: 'authorizeMachinePayment',
        summary: 'Authorize an MPP demo machine payment.',
        description:
          'Authorizes the internal MPP demo rail with the same non-custodial boundary as x402: the delegate key signs locally, Haven validates and relays, and on-chain allowance state enforces spend. The current MPP rail is an internal demo surface; production MPP merchant settlement needs separate product and legal review.',
        security: [{ AgentApiKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MachinePaymentAuthorizeRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Existing or completed machine-payment state.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MachinePaymentAuthorizeResponse' } },
            },
          },
          '201': {
            description: 'Signable or confirmed machine payment.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MachinePaymentAuthorizeResponse' } },
            },
          },
          '202': {
            description: 'Machine payment is waiting for wallet owner approval.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MachinePaymentAuthorizeResponse' } },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '409': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/machine-payments/{id}/status': {
      get: {
        tags: ['Machine payments'],
        operationId: 'getMachinePaymentStatus',
        summary: 'Fetch x402 or MPP payment/approval state.',
        security: [{ AgentApiKey: [] }],
        parameters: [{ $ref: '#/components/parameters/PaymentId' }],
        responses: {
          '200': {
            description: 'Agent payment status.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AgentPaymentStatus' },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/machine-payments/send': {
      post: {
        tags: ['Machine payments'],
        operationId: 'sendTransfer',
        summary: 'Send ETH or USDC directly from the agent\'s Safe to a recipient address.',
        description:
          'Creates an AllowanceModule payment intent for a plain transfer. ' +
          'If the amount is within the remaining on-chain allowance, a sign_data hash is returned for the agent to sign (via POST /payments/{id}/sign). ' +
          'If the amount exceeds the remaining allowance, the transfer is queued as a pending_approval for the wallet owner to approve in Haven.',
        security: [{ AgentApiKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['asset', 'recipient', 'amount'],
                properties: {
                  asset: {
                    type: 'string',
                    enum: ['ETH', 'USDC'],
                    description: 'Asset to send.',
                  },
                  recipient: {
                    type: 'string',
                    pattern: '^0x[0-9a-fA-F]{40}$',
                    description: 'Recipient address (checksummed or lowercase).',
                  },
                  amount: {
                    type: 'string',
                    description: 'Human-readable amount, e.g. "1.5".',
                  },
                  idempotency_key: {
                    type: 'string',
                    description: 'Optional idempotency key to deduplicate retried requests.',
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Payment intent created — ready for signing.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['payment_id', 'status', 'expires_at', 'asset', 'amount', 'recipient', 'sign_data'],
                  properties: {
                    payment_id: { type: 'string' },
                    status: { type: 'string', enum: ['pending_signature'] },
                    expires_at: { type: 'string', format: 'date-time' },
                    asset: { type: 'string', enum: ['ETH', 'USDC'] },
                    amount: { type: 'string' },
                    recipient: { type: 'string' },
                    sign_data: {
                      type: 'object',
                      required: ['hash', 'instructions'],
                      properties: {
                        hash: { type: 'string' },
                        components: { type: 'object' },
                        instructions: { type: 'string' },
                      },
                    },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
          '202': {
            description: 'Transfer queued as pending_approval — exceeds remaining on-chain allowance.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['payment_id', 'status', 'asset', 'expires_at'],
                  properties: {
                    payment_id: { type: 'string' },
                    status: { type: 'string', enum: ['pending_approval'] },
                    asset: { type: 'string' },
                    amount: { type: 'string' },
                    recipient: { type: 'string' },
                    expires_at: { type: 'string', format: 'date-time' },
                    message: { type: 'string' },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/machine-payments/receipts': {
      get: {
        tags: ['Machine payments'],
        operationId: 'listMachinePaymentReceipts',
        summary: 'List stored machine-payment receipts for the authenticated agent.',
        security: [{ AgentApiKey: [] }],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
        ],
        responses: {
          '200': {
            description: 'Machine-payment receipts.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['receipts'],
                  properties: {
                    receipts: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/MachinePaymentReceipt' },
                    },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
    },
    '/machine-payments/evidence': {
      post: {
        tags: ['Machine payments'],
        operationId: 'attachMachinePaymentEvidence',
        summary: 'Attach merchant proof evidence for a confirmed machine payment.',
        description:
          'Records proof-loop evidence after a confirmed x402 or MPP payment. This does not authorize or execute payment; it attaches merchant/protocol evidence to an already confirmed payment or approval request owned by the authenticated agent.',
        security: [{ AgentApiKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MachinePaymentEvidenceRequest' },
            },
          },
        },
        responses: {
          '202': {
            description: 'Evidence accepted.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['evidence'],
                  properties: {
                    evidence: { $ref: '#/components/schemas/MachinePaymentReceipt' },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/machine-payments/reconciliation-events': {
      post: {
        tags: ['Machine payments'],
        operationId: 'recordMachinePaymentReconciliationEvent',
        summary: 'Record a merchant retry reconciliation event.',
        description:
          'Records a post-payment reconciliation marker when the merchant/protocol retry rejects or needs follow-up after a confirmed payment. The event is audit context only; it does not move funds.',
        security: [{ AgentApiKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MachinePaymentReconciliationEventRequest' },
            },
          },
        },
        responses: {
          '202': {
            description: 'Reconciliation event recorded.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MachinePaymentReconciliationEventResponse' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/transactions': {
      get: {
        tags: ['Transactions'],
        operationId: 'listTransactions',
        summary: 'List wallet transactions for the signed-in user.',
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'safeId', in: 'query', schema: uuid },
          { name: 'agentId', in: 'query', schema: { type: 'string' } },
          { name: 'tokenKey', in: 'query', schema: { type: 'string', examples: ['8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'] } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
          { name: 'fresh', in: 'query', schema: { type: 'string', enum: ['1', 'true'] } },
        ],
        responses: {
          '200': {
            description: 'Paginated transactions.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TransactionsResponse' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
        },
      },
    },
    '/catalog': {
      get: {
        tags: ['Catalog'],
        operationId: 'listCatalog',
        summary: 'List curated payable services agents can discover and pay.',
        description:
          'Read-only discovery surface. One source of truth consumed by both the dashboard catalog page and the haven_discover_tools MCP tool. ' +
          'Entries are operator-curated and periodically re-verified against the live merchant 402 challenge; nothing here creates payments or signatures.',
        security: [{ AgentApiKey: [] }, { DashboardJwt: [] }],
        parameters: [
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'rail', in: 'query', schema: { type: 'string', enum: ['x402', 'mpp'] } },
        ],
        responses: {
          '200': {
            description: 'Catalog entries.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['entries'],
                  properties: {
                    entries: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/CatalogEntry' },
                    },
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
        },
      },
    },
    '/catalog/{id}': {
      get: {
        tags: ['Catalog'],
        operationId: 'getCatalogEntry',
        summary: 'Fetch one catalog entry.',
        security: [{ AgentApiKey: [] }, { DashboardJwt: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'Catalog entry.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CatalogEntry' },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      AgentApiKey: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'sk_agent_*',
        description: bearerIdentityDescription,
      },
      DashboardJwt: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Dashboard user session token. This authenticates the user for account-management endpoints; it is not agent payment authority.',
      },
      SetupToken: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Haven-Setup-Token',
        description: 'Short-lived setup token used before connector registration. The same token can also be supplied as setup_token in the JSON request body. Setup tokens authenticate setup only and cannot authorize payment.',
      },
    },
    parameters: {
      AgentId: {
        name: 'id',
        in: 'path',
        required: true,
        schema: uuid,
      },
      PaymentId: {
        name: 'id',
        in: 'path',
        required: true,
        schema: uuid,
      },
      SetupId: {
        name: 'setupId',
        in: 'path',
        required: true,
        schema: uuid,
      },
    },
    schemas: {
      CatalogEntry: {
        type: 'object',
        required: ['id', 'name', 'description', 'category', 'resource_url', 'rail', 'protocol', 'status'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string' },
          resource_url: { type: 'string' },
          rail: { type: 'string', enum: ['x402', 'mpp'] },
          protocol: { type: 'string', enum: ['http', 'mcp'] },
          tool_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          price_display: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          price_atomic: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          asset: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          network: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          status: { type: 'string', enum: ['active', 'degraded', 'delisted'] },
          verified_at: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      AgentPaymentPhase: {
        type: 'string',
        enum: Object.values(AgentPaymentPhase),
        description: 'Stable Haven agent payment state phase.',
      },
      AgentPaymentNextAction: {
        type: 'string',
        enum: Object.values(AgentPaymentNextAction),
        description: 'Stable next action an agent should take for a Haven payment state.',
      },
      AgentPaymentRail: {
        type: 'string',
        enum: Object.values(AgentPaymentRail),
        description: 'Stable rail identifier for Haven agent payment states.',
      },
      HealthResponse: {
        type: 'object',
        required: ['status', 'timestamp', 'db'],
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded'] },
          timestamp: isoDateTime,
          db: {
            type: 'object',
            required: ['status'],
            properties: {
              status: { type: 'string', enum: ['ok', 'error'] },
              latencyMs: { type: 'integer' },
              error: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      SuccessResponse: {
        type: 'object',
        required: ['success'],
        properties: { success: { type: 'boolean' } },
        additionalProperties: false,
      },
      AgentConnectionSetupState: {
        type: 'string',
        enum: [
          'awaiting_connection',
          'connected_local',
          'awaiting_wallet_approval',
          'approval_in_progress',
          'proposed',
          'active',
          'expired',
          'cancelled',
          'failed',
        ],
        description: 'Connect Agent 2 setup state. Pending/proposed states are not payment authority.',
      },
      AgentConnectionAllowanceInput: {
        type: 'object',
        required: ['token_address', 'token_symbol', 'allowance_amount', 'reset_period_min'],
        properties: {
          token_address: address,
          token_symbol: tokenSymbol,
          allowance_amount: allowanceAtomicAmount,
          reset_period_min: allowanceResetPeriodMin,
        },
        additionalProperties: false,
      },
      AgentConnectionAllowance: {
        allOf: [
          { $ref: '#/components/schemas/AgentConnectionAllowanceInput' },
          {
            type: 'object',
            properties: { id: uuid },
          },
        ],
      },
      AgentConnectionWallet: {
        type: 'object',
        required: ['id', 'name', 'address', 'chain_id', 'network'],
        properties: {
          id: uuid,
          name: { type: 'string' },
          address,
          chain_id: { type: 'integer' },
          network: { type: 'string' },
        },
        additionalProperties: false,
      },
      AgentConnectionConnector: {
        type: 'object',
        properties: {
          connector_version: { type: ['string', 'null'] },
          environment_label: { type: 'string' },
          runtime_version: { type: 'string' },
          config_target: { type: 'string' },
        },
        additionalProperties: false,
      },
      AgentConnectionInstallStatus: {
        type: 'object',
        properties: {
          runtime: { type: 'string' },
          runtime_mcp_mode: { type: 'string' },
          connector_version: { type: 'string' },
          hosted_mcp_configured: { type: 'boolean' },
          local_signer_configured: { type: 'boolean' },
          local_mcp_configured: { type: 'boolean' },
          credential_files_written: { type: 'boolean' },
          signer_acknowledged: { type: 'boolean' },
          local_mcp_acknowledged: { type: 'boolean' },
          activation_command_available: { type: 'boolean' },
          probe_result: { type: 'string' },
          restart_required: { type: 'boolean' },
          next_user_action: { type: 'string' },
          error_code: { type: ['string', 'null'] },
          environment_label: { type: 'string' },
          last_probe_at: { anyOf: [isoDateTime, { type: 'string' }] },
        },
        additionalProperties: false,
      },
      CreateAgentConnectionSetupRequest: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          safe_id: uuid,
          runtime: { type: 'string' },
          allowances: {
            type: 'array',
            items: { $ref: '#/components/schemas/AgentConnectionAllowanceInput' },
          },
        },
        additionalProperties: false,
      },
      CreateAgentConnectionSetupResponse: {
        type: 'object',
        required: ['setup_id', 'status', 'setup_token', 'expires_at', 'connector_command', 'setup_prompt'],
        properties: {
          setup_id: uuid,
          status: { $ref: '#/components/schemas/AgentConnectionSetupState' },
          setup_token: { type: 'string', pattern: '^hv_setup_' },
          expires_at: isoDateTime,
          connector_command: { type: 'string' },
          setup_prompt: { type: 'string' },
        },
        additionalProperties: false,
      },
      ResolveAgentConnectionSetupRequest: {
        type: 'object',
        required: ['setup_token'],
        properties: {
          setup_token: { type: 'string', pattern: '^hv_setup_' },
          connector_version: { type: 'string' },
          runtime: { type: 'string' },
        },
        additionalProperties: false,
      },
      ResolveAgentConnectionSetupResponse: {
        type: 'object',
        required: ['setup_id', 'status', 'agent', 'haven_wallet', 'agent_budget', 'hosted_mcp_url', 'challenge'],
        properties: {
          setup_id: uuid,
          status: { $ref: '#/components/schemas/AgentConnectionSetupState' },
          agent: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              description: { type: ['string', 'null'] },
            },
            additionalProperties: false,
          },
          haven_wallet: { $ref: '#/components/schemas/AgentConnectionWallet' },
          agent_budget: {
            type: 'array',
            items: { $ref: '#/components/schemas/AgentConnectionAllowance' },
          },
          hosted_mcp_url: { type: 'string', format: 'uri' },
          challenge: {
            type: 'object',
            required: ['id', 'message', 'expires_at'],
            properties: {
              id: uuid,
              message: { type: 'string' },
              expires_at: isoDateTime,
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      RegisterAgentConnectionSetupRequest: {
        type: 'object',
        required: [
          'setup_token',
          'challenge_id',
          'delegate_address',
          'proof_signature',
          'api_key_hash',
          'api_key_prefix',
        ],
        properties: {
          setup_token: { type: 'string', pattern: '^hv_setup_' },
          challenge_id: uuid,
          delegate_address: address,
          proof_signature: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
          api_key_hash: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
          api_key_prefix: { type: 'string', pattern: '^sk_agent_[0-9a-f]{3}$' },
          runtime: { type: 'string' },
          connector_version: { type: 'string' },
          connector_context: { $ref: '#/components/schemas/AgentConnectionConnector' },
          install_capabilities: {
            type: 'object',
            properties: {
              can_write_runtime_config: { type: 'boolean' },
              restart_required: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      RegisterAgentConnectionSetupResponse: {
        type: 'object',
        required: ['setup_id', 'agent_id', 'status', 'agent_status', 'api_key_prefix', 'api_key_scope', 'delegate_address', 'hosted_mcp_url', 'next_action'],
        properties: {
          setup_id: uuid,
          agent_id: uuid,
          status: { $ref: '#/components/schemas/AgentConnectionSetupState' },
          agent_status: { type: 'string', enum: ['pending_approval'] },
          api_key_prefix: { type: 'string', pattern: '^sk_agent_' },
          api_key_scope: { type: 'string', enum: ['setup_pending'] },
          delegate_address: address,
          hosted_mcp_url: { type: 'string', format: 'uri' },
          next_action: { type: 'string', enum: ['return_to_haven_for_wallet_approval'] },
        },
        additionalProperties: false,
      },
      AgentConnectionSetupStatus: {
        type: 'object',
        required: ['setup_id', 'status', 'agent', 'haven_wallet', 'agent_budget', 'install_status', 'approval'],
        properties: {
          setup_id: uuid,
          agent_id: { anyOf: [uuid, { type: 'null' }] },
          status: { $ref: '#/components/schemas/AgentConnectionSetupState' },
          expires_at: isoDateTime,
          agent: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              description: { type: ['string', 'null'] },
            },
            additionalProperties: false,
          },
          haven_wallet: { $ref: '#/components/schemas/AgentConnectionWallet' },
          agent_budget: {
            type: 'array',
            items: { $ref: '#/components/schemas/AgentConnectionAllowance' },
          },
          delegate_address: { anyOf: [address, { type: 'null' }] },
          api_key_prefix: { type: ['string', 'null'] },
          runtime: { type: ['string', 'null'] },
          connector: { $ref: '#/components/schemas/AgentConnectionConnector' },
          install_status: { $ref: '#/components/schemas/AgentConnectionInstallStatus' },
          approval: {
            type: 'object',
            required: ['safe_tx_hash', 'tx_hash', 'status'],
            properties: {
              safe_tx_hash: { type: ['string', 'null'], pattern: '^0x[0-9a-fA-F]{64}$' },
              tx_hash: { type: ['string', 'null'], pattern: '^0x[0-9a-fA-F]{64}$' },
              status: { type: 'string' },
            },
            additionalProperties: false,
          },
          failure_reason: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      RecordAgentConnectionWalletApprovalRequest: {
        type: 'object',
        required: [
          'result',
          'safe_tx_hash',
          'chain_id',
          'safe_address',
          'allowance_module_address',
          'delegate_address',
        ],
        properties: {
          result: { type: 'string', enum: ['confirmed', 'proposed'] },
          tx_hash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
          safe_tx_hash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
          chain_id: { type: 'integer' },
          safe_address: address,
          allowance_module_address: address,
          delegate_address: address,
          confirmation_status: {
            type: 'string',
            enum: ['confirmed', 'receipt_timeout'],
            description: 'Use receipt_timeout only when the wallet transaction was submitted but the local receipt wait timed out.',
          },
        },
        additionalProperties: false,
      },
      UpdateConnectorInstallStatusRequest: {
        type: 'object',
        properties: {
          setup_token: { type: 'string', pattern: '^hv_setup_' },
          runtime: { type: 'string' },
          runtime_mcp_mode: { type: 'string' },
          connector_version: { type: 'string' },
          hosted_mcp_configured: { type: 'boolean' },
          local_signer_configured: { type: 'boolean' },
          local_mcp_configured: { type: 'boolean' },
          credential_files_written: { type: 'boolean' },
          signer_acknowledged: { type: 'boolean' },
          local_mcp_acknowledged: { type: 'boolean' },
          activation_command_available: { type: 'boolean' },
          probe_result: { type: 'string' },
          restart_required: { type: 'boolean' },
          next_user_action: { type: 'string' },
          error_code: { type: ['string', 'null'] },
          environment_label: { type: 'string' },
        },
        additionalProperties: false,
      },
      UpdateConnectorInstallStatusResponse: {
        type: 'object',
        required: ['setup_id', 'status', 'install_status'],
        properties: {
          setup_id: uuid,
          status: { $ref: '#/components/schemas/AgentConnectionSetupState' },
          install_status: { $ref: '#/components/schemas/AgentConnectionInstallStatus' },
        },
        additionalProperties: false,
      },
      AgentAllowance: {
        type: 'object',
        required: ['id', 'agent_id', 'token_address', 'token_symbol', 'allowance_amount', 'reset_period_min'],
        properties: {
          id: uuid,
          agent_id: uuid,
          token_address: address,
          token_symbol: { type: 'string' },
          allowance_amount: { type: 'string' },
          reset_period_min: { type: 'integer' },
        },
        additionalProperties: false,
      },
      Agent: {
        type: 'object',
        required: ['id', 'name', 'delegate_address', 'safe_id', 'safe_address', 'safe_name', 'safe_chain_id', 'api_key_prefix', 'status', 'created_at', 'allowances'],
        properties: {
          id: uuid,
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          delegate_address: { anyOf: [address, { type: 'null' }] },
          safe_id: { anyOf: [uuid, { type: 'null' }] },
          safe_address: { anyOf: [address, { type: 'null' }] },
          safe_name: { type: ['string', 'null'] },
          safe_chain_id: { type: ['integer', 'null'] },
          api_key_prefix: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['active', 'paused', 'pending_approval', 'revoked'] },
          created_at: isoDateTime,
          allowances: { type: 'array', items: { $ref: '#/components/schemas/AgentAllowance' } },
          /** Timestamp of the most recent MCP tool call from this agent. Null until first call. */
          mcp_last_seen_at: { anyOf: [isoDateTime, { type: 'null' }] },
        },
        additionalProperties: true,
      },
      CreateAgentRequest: {
        type: 'object',
        required: ['name', 'delegate_address'],
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          delegate_address: address,
          safe_id: uuid,
          allowances: {
            type: 'array',
            items: {
              type: 'object',
              required: ['token_address', 'token_symbol', 'allowance_amount', 'reset_period_min'],
              properties: {
                token_address: address,
                token_symbol: tokenSymbol,
                allowance_amount: allowanceAtomicAmount,
                reset_period_min: allowanceResetPeriodMin,
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      CreateAgentResponse: {
        allOf: [
          { $ref: '#/components/schemas/Agent' },
          {
            type: 'object',
            required: ['api_key'],
            properties: {
              api_key: { type: 'string', pattern: '^sk_agent_' },
            },
          },
        ],
      },
      CreatePaymentRequest: {
        type: 'object',
        required: ['token', 'amount', 'to'],
        properties: {
          token: { type: 'string', examples: ['USDC', 'EURe', 'xDAI'] },
          amount: { type: 'string', description: 'Human-readable token amount.' },
          to: address,
        },
        additionalProperties: true,
      },
      SignablePaymentIntent: {
        type: 'object',
        required: ['payment_id', 'status', 'expires_at', 'sign_data'],
        properties: {
          payment_id: uuid,
          status: { type: 'string', enum: ['pending_signature'] },
          expires_at: isoDateTime,
          sign_data: paymentSignData,
        },
        additionalProperties: false,
      },
      PendingApproval: {
        type: 'object',
        required: ['payment_id', 'kind', 'status', 'phase', 'next_action', 'message', 'expires_at'],
        properties: {
          payment_id: uuid,
          kind: { type: 'string', enum: ['approval_request'] },
          status: { type: 'string', enum: ['pending_approval', 'pending'] },
          phase: { $ref: '#/components/schemas/AgentPaymentPhase' },
          next_action: { $ref: '#/components/schemas/AgentPaymentNextAction' },
          message: { type: 'string' },
          remaining: { type: ['string', 'null'] },
          requested: { type: 'string' },
          token: { type: 'string' },
          expires_at: isoDateTime,
        },
        // Direct approvals, x402 approvals, and future rail-specific approvals
        // share this base shape while adding their own context fields.
        additionalProperties: true,
      },
      PaymentIntentStatus: {
        type: 'object',
        required: ['payment_id', 'status', 'token', 'amount', 'to', 'tx_hash', 'error_message', 'created_at', 'signed_at', 'submitted_at', 'confirmed_at', 'expires_at'],
        properties: {
          payment_id: uuid,
          status: { type: 'string' },
          chain_id: { type: 'integer' },
          token: { type: 'string' },
          amount: { type: 'string' },
          to: address,
          tx_hash: { type: ['string', 'null'] },
          explorer_url: { type: ['string', 'null'] },
          error_message: { type: ['string', 'null'] },
          created_at: isoDateTime,
          signed_at: { anyOf: [isoDateTime, { type: 'null' }] },
          submitted_at: { anyOf: [isoDateTime, { type: 'null' }] },
          confirmed_at: { anyOf: [isoDateTime, { type: 'null' }] },
          expires_at: isoDateTime,
        },
        additionalProperties: false,
      },
      PaymentExecutionResult: {
        type: 'object',
        required: ['payment_id', 'status'],
        properties: {
          payment_id: uuid,
          status: { type: 'string' },
          tx_hash: { type: 'string' },
          chain_id: { type: 'integer' },
          explorer_url: { type: 'string' },
          token: { type: 'string' },
          amount: { type: 'string' },
          to: address,
          error: { type: 'string' },
          details: { type: 'string' },
        },
        additionalProperties: true,
      },
      PaymentListItem: {
        type: 'object',
        required: ['payment_id', 'status', 'token', 'amount', 'to', 'tx_hash', 'created_at', 'confirmed_at'],
        properties: {
          payment_id: uuid,
          status: { type: 'string' },
          token: { type: 'string' },
          amount: { type: 'string' },
          to: address,
          tx_hash: { type: ['string', 'null'] },
          created_at: isoDateTime,
          confirmed_at: { anyOf: [isoDateTime, { type: 'null' }] },
        },
        additionalProperties: false,
      },
      RailContext: {
        type: 'object',
        required: ['amount_atomic', 'asset', 'network', 'resource_url', 'merchant_address', 'description', 'idempotency_key'],
        properties: {
          amount_atomic: { type: ['string', 'null'] },
          asset: { anyOf: [address, { type: 'null' }] },
          network: { type: ['string', 'null'] },
          resource_url: { type: ['string', 'null'], format: 'uri' },
          merchant_address: { anyOf: [address, { type: 'null' }] },
          description: { type: ['string', 'null'] },
          idempotency_key: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      AgentPaymentStatus: agentPaymentStatus,
      X402PaymentOption: {
        type: 'object',
        required: ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds'],
        properties: {
          scheme: { type: 'string', enum: ['exact'] },
          network: { type: 'string' },
          amount: { type: 'string' },
          maxAmountRequired: { type: 'string' },
          resource: { type: 'string' },
          description: { type: 'string' },
          mimeType: { type: 'string' },
          asset: address,
          payTo: address,
          maxTimeoutSeconds: { type: 'integer' },
          extra: { type: 'object', additionalProperties: true },
        },
        additionalProperties: true,
      },
      X402PaymentRequired: {
        type: 'object',
        required: ['x402Version', 'resource', 'accepts'],
        properties: {
          x402Version: { type: 'integer' },
          resource: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              description: { type: 'string' },
              mimeType: { type: 'string' },
            },
            additionalProperties: true,
          },
          accepts: {
            type: 'array',
            items: { $ref: '#/components/schemas/X402PaymentOption' },
          },
          error: { type: 'string' },
        },
        additionalProperties: true,
      },
      X402AuthorizeRequest: {
        type: 'object',
        required: ['url', 'payTo', 'amount', 'asset', 'network'],
        properties: {
          url: { type: 'string', format: 'uri' },
          payTo: address,
          merchantPayTo: address,
          amount: { type: 'string', description: 'Atomic token amount from the x402 challenge.' },
          asset: address,
          network: { type: 'string', examples: ['base', 'eip155:8453'] },
          description: { type: 'string' },
          maxTimeoutSeconds: { type: 'integer' },
          category: { type: 'string' },
          idempotencyKey: { type: 'string', maxLength: 128 },
          signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$' },
        },
        additionalProperties: false,
      },
      X402SignablePayment: {
        allOf: [
          { $ref: '#/components/schemas/SignablePaymentIntent' },
          {
            type: 'object',
            properties: {
              chain_id: { type: 'integer' },
              safe_address: address,
              payer: address,
              token: { type: 'string' },
              amount: { type: 'string' },
              to: address,
              merchant_to: { anyOf: [address, { type: 'null' }] },
              resource_url: { type: 'string', format: 'uri' },
            },
          },
        ],
      },
      X402ConfirmedPayment: {
        type: 'object',
        required: ['success', 'payment_id', 'status', 'tx_hash'],
        properties: {
          success: { type: 'boolean' },
          payment_id: uuid,
          status: { type: 'string' },
          tx_hash: { type: 'string' },
          chain_id: { type: 'integer' },
          safe_address: address,
          payer: address,
          token: { type: 'string' },
          amount: { type: 'string' },
          to: address,
          merchant_to: { anyOf: [address, { type: 'null' }] },
          resource_url: { type: 'string', format: 'uri' },
          explorer_url: { type: 'string' },
        },
        additionalProperties: false,
      },
      X402PendingApproval: {
        allOf: [
          { $ref: '#/components/schemas/PendingApproval' },
          {
            type: 'object',
            required: ['rail', 'resource_url', 'chain_id', 'amount_atomic', 'asset', 'network', 'x402'],
            properties: {
              rail: { type: 'string', enum: ['x402'] },
              resource_url: { type: 'string', format: 'uri' },
              merchant_address: { anyOf: [address, { type: 'null' }] },
              chain_id: { type: 'integer' },
              amount_atomic: { type: 'string' },
              asset: address,
              network: { type: 'string' },
              idempotency_key: { type: ['string', 'null'] },
              challenge_id: { type: ['string', 'null'] },
              x402: { $ref: '#/components/schemas/RailContext' },
            },
          },
        ],
      },
      X402ResumeState: {
        type: 'object',
        required: ['rail', 'paymentId', 'idempotencyKey', 'paymentRequired', 'accepted', 'url', 'resourceUrl', 'amountAtomic', 'amount', 'token', 'asset', 'network', 'chainId', 'merchantAddress'],
        properties: {
          rail: { type: 'string', enum: ['x402'] },
          paymentId: uuid,
          idempotencyKey: { type: 'string' },
          paymentRequired: { $ref: '#/components/schemas/X402PaymentRequired' },
          accepted: { $ref: '#/components/schemas/X402PaymentOption' },
          url: { type: 'string', format: 'uri' },
          request: { $ref: '#/components/schemas/SerializableRequest' },
          resourceUrl: { type: 'string', format: 'uri' },
          description: { type: ['string', 'null'] },
          amountAtomic: { type: 'string' },
          amount: { type: 'string' },
          token: { type: 'string' },
          asset: address,
          network: { type: 'string' },
          chainId: { type: ['integer', 'null'] },
          merchantAddress: address,
        },
        additionalProperties: false,
      },
      SerializableRequest: {
        type: 'object',
        required: ['url', 'method', 'headers'],
        properties: {
          url: { type: 'string', format: 'uri' },
          method: { type: 'string' },
          headers: {
            type: 'array',
            items: {
              type: 'array',
              prefixItems: [{ type: 'string' }, { type: 'string' }],
              minItems: 2,
              maxItems: 2,
            },
          },
          body: { type: 'string' },
        },
        additionalProperties: false,
      },
      MachinePaymentChallenge: {
        type: 'object',
        required: ['rail', 'version', 'challengeId', 'resource', 'description', 'network', 'asset', 'amount', 'recipient', 'expiresAt'],
        properties: {
          rail: { type: 'string', enum: ['mpp_demo', 'mpp_crypto', 'stripe_deposit', 'spt'] },
          version: { type: 'string' },
          challengeId: { type: 'string' },
          resource: { type: 'string', format: 'uri' },
          description: { type: 'string' },
          network: {
            type: 'object',
            required: ['chainId', 'name'],
            properties: {
              chainId: { type: 'integer' },
              name: { type: 'string', enum: ['base'] },
            },
            additionalProperties: false,
          },
          asset: {
            type: 'object',
            required: ['symbol', 'address', 'decimals'],
            properties: {
              symbol: { type: 'string', enum: ['USDC'] },
              address,
              decimals: { type: 'integer', enum: [6] },
            },
            additionalProperties: false,
          },
          amount: {
            type: 'object',
            required: ['display', 'atomic'],
            properties: {
              display: { type: 'string' },
              atomic: { type: 'string' },
            },
            additionalProperties: false,
          },
          recipient: address,
          expiresAt: isoDateTime,
          metadata: { type: 'object', additionalProperties: true },
        },
        additionalProperties: false,
      },
      MachinePaymentAuthorizeRequest: {
        type: 'object',
        required: ['challenge', 'idempotencyKey'],
        properties: {
          challenge: { $ref: '#/components/schemas/MachinePaymentChallenge' },
          idempotencyKey: { type: 'string' },
          signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$' },
        },
        additionalProperties: false,
      },
      MachinePaymentAuthorizeResponse: {
        oneOf: [
          { $ref: '#/components/schemas/AgentPaymentStatus' },
          { $ref: '#/components/schemas/X402SignablePayment' },
          { $ref: '#/components/schemas/X402ConfirmedPayment' },
        ],
      },
      MppResumeState: {
        type: 'object',
        required: ['rail', 'paymentRail', 'paymentId', 'idempotencyKey', 'challenge', 'url', 'resourceUrl', 'amountAtomic', 'amount', 'token', 'asset', 'network', 'chainId', 'merchantAddress', 'expiresAt'],
        properties: {
          rail: { type: 'string', enum: ['mpp'] },
          paymentRail: { type: 'string' },
          paymentId: uuid,
          idempotencyKey: { type: 'string' },
          challenge: { $ref: '#/components/schemas/MachinePaymentChallenge' },
          url: { type: 'string', format: 'uri' },
          request: { $ref: '#/components/schemas/SerializableRequest' },
          resourceUrl: { type: 'string', format: 'uri' },
          description: { type: ['string', 'null'] },
          amountAtomic: { type: 'string' },
          amount: { type: 'string' },
          token: { type: 'string' },
          asset: address,
          network: { type: 'string' },
          chainId: { type: 'integer' },
          merchantAddress: address,
          expiresAt: isoDateTime,
        },
        additionalProperties: false,
      },
      PaymentResumeState: {
        oneOf: [
          { $ref: '#/components/schemas/X402ResumeState' },
          { $ref: '#/components/schemas/MppResumeState' },
        ],
      },
      MachinePaymentAgent: {
        type: 'object',
        required: ['id', 'name', 'status', 'safe_address', 'delegate_address', 'chain_id'],
        properties: {
          id: uuid,
          name: { type: 'string' },
          status: { type: 'string' },
          safe_address: address,
          delegate_address: address,
          chain_id: { type: 'integer' },
        },
        additionalProperties: false,
      },
      AllowanceSummary: {
        type: 'object',
        required: ['agent_id', 'safe_address', 'delegate_address', 'chain_id', 'allowances'],
        properties: {
          agent_id: uuid,
          safe_address: address,
          delegate_address: address,
          chain_id: { type: 'integer' },
          allowances: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'token_address', 'token_symbol', 'configured_amount', 'reset_period_min', 'onchain'],
              properties: {
                id: uuid,
                token_address: address,
                token_symbol: { type: 'string' },
                configured_amount: { type: 'string' },
                reset_period_min: { type: 'integer' },
                onchain: {
                  type: 'object',
                  required: ['amount', 'spent', 'remaining', 'effective_spent', 'reset_time_min', 'last_reset_min', 'nonce', 'is_reset_pending'],
                  properties: {
                    amount: { type: 'string' },
                    spent: { type: 'string' },
                    remaining: { type: 'string' },
                    effective_spent: { type: 'string' },
                    reset_time_min: { type: 'integer' },
                    last_reset_min: { type: 'integer' },
                    nonce: { type: 'integer' },
                    is_reset_pending: { type: 'boolean' },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      MachinePaymentReceipt: {
        type: 'object',
        required: ['id', 'payment_id', 'rail', 'proof_status', 'tx_hash', 'chain_id', 'resource_url', 'token_symbol', 'token_address', 'amount_raw', 'amount_human', 'created_at', 'updated_at'],
        properties: {
          id: uuid,
          payment_id: uuid,
          payment_intent_id: { anyOf: [uuid, { type: 'null' }] },
          approval_request_id: { anyOf: [uuid, { type: 'null' }] },
          rail: { type: 'string' },
          proof_status: {
            type: 'string',
            enum: ['payment_confirmed', 'merchant_response_observed', 'protocol_receipt_attached'],
          },
          tx_hash: { type: 'string' },
          chain_id: { type: 'integer' },
          resource_url: { type: 'string', format: 'uri' },
          merchant_address: { anyOf: [address, { type: 'null' }] },
          payer_address: address,
          settlement_address: address,
          token_symbol: { type: 'string' },
          token_address: address,
          amount_raw: { type: 'string' },
          amount_human: { type: 'string' },
          challenge_id: { type: ['string', 'null'] },
          idempotency_key: { type: ['string', 'null'] },
          merchant_status: { type: ['integer', 'null'] },
          confirmed_at: { anyOf: [isoDateTime, { type: 'null' }] },
          created_at: isoDateTime,
          updated_at: isoDateTime,
        },
        additionalProperties: true,
      },
      MachinePaymentEvidenceRequest: {
        type: 'object',
        required: ['paymentId', 'rail', 'txHash'],
        properties: {
          paymentId: uuid,
          rail: { type: 'string' },
          txHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
          resourceUrl: { type: 'string', format: 'uri' },
          merchantStatus: { type: 'integer', minimum: 100, maximum: 599 },
          challengePayload: { type: 'object', additionalProperties: true },
          selectedPayment: { type: 'object', additionalProperties: true },
          paymentProofHeaderName: { type: 'string' },
          paymentProofHeader: { type: 'string' },
          protocolReceiptHeaderName: { type: 'string' },
          protocolReceiptHeader: { type: 'string' },
          protocolReceiptPayload: { type: 'object', additionalProperties: true },
        },
        additionalProperties: false,
      },
      MachinePaymentReconciliationEventRequest: {
        type: 'object',
        required: ['paymentId', 'rail', 'eventType'],
        properties: {
          paymentId: uuid,
          rail: { type: 'string' },
          eventType: { type: 'string', enum: ['merchant_retry_rejected_after_payment'] },
          txHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
          reason: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
        additionalProperties: false,
      },
      MachinePaymentReconciliationEventResponse: {
        type: 'object',
        required: ['event_id', 'status', 'payment_id', 'rail', 'event_type', 'created_at'],
        properties: {
          event_id: uuid,
          status: { type: 'string', enum: ['open', 'resolved'] },
          payment_id: uuid,
          rail: { type: 'string' },
          event_type: { type: 'string' },
          created_at: isoDateTime,
        },
        additionalProperties: false,
      },
      Transaction: {
        type: 'object',
        required: ['hash', 'type', 'from', 'to', 'value', 'valueFormatted', 'asset', 'decimals', 'direction', 'timestamp', 'blockNumber', 'isError', 'chainId', 'safeId', 'safeAddress', 'safeName'],
        properties: {
          hash: { type: 'string' },
          type: { type: 'string', enum: ['native', 'erc20', 'internal'] },
          from: address,
          to: address,
          value: { type: 'string' },
          valueFormatted: { type: 'string' },
          asset: { type: 'string' },
          decimals: { type: 'integer' },
          direction: { type: 'string', enum: ['in', 'out'] },
          timestamp: { type: 'integer' },
          blockNumber: { type: 'integer' },
          isError: { type: 'boolean' },
          tokenAddress: address,
          tokenSymbol: { type: 'string' },
          source: { type: 'string' },
          x402ResourceUrl: { type: ['string', 'null'] },
          x402MerchantAddress: { type: ['string', 'null'] },
          paymentId: { type: 'string' },
          paymentProofStatus: { type: ['string', 'null'] },
          paymentFlowStatus: {
            type: ['string', 'null'],
            enum: ['paid', 'confirming_merchant', 'needs_attention', null],
          },
          paymentAttentionReason: {
            type: ['string', 'null'],
            enum: ['merchant_retry_rejected_after_payment', null],
          },
          chainId: { type: 'integer' },
          safeId: uuid,
          safeAddress: address,
          safeName: { type: 'string' },
          agentId: uuid,
          agentName: { type: 'string' },
        },
        additionalProperties: false,
      },
      TransactionsResponse: {
        type: 'object',
        required: ['transactions', 'total', 'offset', 'limit', 'hasMore', 'partialFailure', 'failedSafeIds'],
        properties: {
          transactions: { type: 'array', items: { $ref: '#/components/schemas/Transaction' } },
          total: { type: 'integer' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
          hasMore: { type: 'boolean' },
          partialFailure: { type: 'boolean' },
          failedSafeIds: { type: 'array', items: uuid },
        },
        additionalProperties: false,
      },
    },
  },
} as const

export type OpenApiSpec = typeof openapiSpec
