import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  AgentPaymentRail,
} from '../domain/agent-payment-taxonomy.js'

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

const agentAuthForbidden = {
  description:
    'Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is ' +
    'valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused ' +
    'API-initiated transactions. `detail` carries the operator action. Contrast 401, which means ' +
    'the key itself is unknown or revoked.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['error'],
        properties: {
          // Not an enum: agentAuth also 403s configuration refusals
          // ('Agent has no delegate address configured', 'No Safe deployed
          // for this account') — an exhaustive-switch client must treat
          // unknown codes as generic refusals (#1132 review).
          error: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
  },
}


// ── Delegation-lifecycle building blocks (#1446) ─────────────────────────────

const delegationHash = {
  type: 'string',
  pattern: '^0x[0-9a-fA-F]{64}$',
  description: "The delegation's stable identity (#827) — keccak of the unsigned delegation.",
} as const

const delegationHashList = {
  type: 'array',
  minItems: 1,
  items: delegationHash,
} as const

const delegationHashParam = {
  name: 'hash',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
  description: 'Delegation hash from the build/list response.',
} as const

/** Arbitrary-length 0x-hex — an ECDSA signature or an ABI-encoded WebAuthn assertion. */
const hexBytes = {
  type: 'string',
  pattern: '^0x[0-9a-fA-F]+$',
} as const

/**
 * A prepared ERC-4337 UserOperation, echoed back verbatim on submit. Fields are
 * the bundler's concern, not this contract's — bigints travel as '<digits>n'
 * strings (the prepare step's JSON encoding, revived on submit).
 */
const preparedUserOperation = {
  type: 'object',
  additionalProperties: true,
} as const

/** EIP-712 typed data the owner key signs verbatim (domain/types/message). */
const eip712Payload = {
  type: 'object',
  additionalProperties: true,
} as const

/** A prepared treasury UserOp, branching on how the account signs it. */
const preparedTreasuryOp = {
  oneOf: [
    {
      type: 'object',
      required: ['signature_scheme', 'signing_payload', 'user_operation', 'treasury_address', 'instructions'],
      properties: {
        signature_scheme: { type: 'string', enum: ['eip712_userop'] },
        signing_payload: eip712Payload,
        user_operation: preparedUserOperation,
        treasury_address: address,
        instructions: { type: 'string' },
      },
    },
    {
      type: 'object',
      required: ['signature_scheme', 'user_op_hash', 'user_operation', 'treasury_address', 'instructions'],
      properties: {
        signature_scheme: { type: 'string', enum: ['webauthn_userop'] },
        user_op_hash: { type: 'string' },
        user_operation: preparedUserOperation,
        treasury_address: address,
        instructions: { type: 'string' },
      },
    },
  ],
} as const

/** Optional per-request signature-scheme selector for multi-signer accounts. */
const signatureSchemeBody = {
  type: 'object',
  properties: {
    signature_scheme: {
      type: 'string',
      enum: ['eip712_userop', 'webauthn_userop'],
      description: 'Multi-signer accounts choose per request; omitted, an EOA owner defaults to eip712_userop.',
    },
  },
} as const

/** A signer-set change (rails/hybrid-signer-actions.ts SignerActionBody). */
const signerActionBody = {
  type: 'object',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['add_passkey', 'remove_passkey', 'add_owner', 'remove_owner'] },
    passkey: {
      type: 'object',
      description: 'Required for add_passkey/remove_passkey.',
      properties: {
        key_id: { type: 'string' },
        x: { type: 'string' },
        y: { type: 'string' },
      },
    },
    owner_address: { ...address, description: 'Required for add_owner.' },
    signature_scheme: {
      type: 'string',
      enum: ['eip712_userop', 'webauthn_userop'],
    },
  },
} as const


// ── x402 demo-resource building blocks (#1446) ───────────────────────────────

/**
 * The 402 challenge body a resource server embeds in its own 402 response.
 * Shape is fixed by _buildChallenge in routes/x402-resources.ts.
 */
const x402Challenge = {
  type: 'object',
  required: ['version', 'resource_id', 'accepts'],
  properties: {
    version: { type: 'string', examples: ['1'] },
    resource_id: { type: 'string', format: 'uuid' },
    accepts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['scheme', 'network', 'asset', 'maxAmountRequired', 'payTo', 'description', 'extra'],
        properties: {
          scheme: { type: 'string', examples: ['exact'] },
          network: { type: 'string', examples: ['eip155:8453'] },
          asset: address,
          maxAmountRequired: { type: 'string', pattern: '^[0-9]+$', description: 'Atomic units.' },
          payTo: address,
          description: { type: 'string' },
          extra: {
            type: 'object',
            required: ['name', 'authorize_endpoint', 'verify_endpoint'],
            properties: {
              name: { type: 'string' },
              authorize_endpoint: { type: 'string' },
              verify_endpoint: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const

/** One registered resource as the list route reshapes it. */
const x402Resource = {
  type: 'object',
  required: [
    'resource_id', 'name', 'description', 'price_amount', 'price_human',
    'token_symbol', 'token_address', 'chain_id', 'pay_to', 'active',
    'created_at', 'challenge',
  ],
  properties: {
    resource_id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    price_amount: { type: 'string', pattern: '^[0-9]+$', description: 'Atomic units.' },
    price_human: { type: 'string', description: 'Formatted with the token decimals; falls back to 6 for an unknown token.' },
    token_symbol: { type: 'string', description: 'Stored uppercase.' },
    token_address: {
      type: 'string',
      pattern: '^0x[0-9a-fA-F]{40}$',
      description:
        "Read back verbatim from storage. The create route lowercases on insert, but x402_resources has NO lowercase CHECK constraint (unlike agent_delegations), so a row written any other way keeps its case — compare case-insensitively.",
    },
    chain_id: { type: 'integer' },
    pay_to: {
      type: ['string', 'null'],
      pattern: '^0x[0-9a-fA-F]{40}$',
      description: "Null when the linked Safe was detached (safe_id is ON DELETE SET NULL) — the resource stays listed but cannot be paid.",
    },
    active: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
    challenge: {
      oneOf: [x402Challenge, { type: 'null' }],
      description: 'Null exactly when pay_to is null — a challenge cannot be built without a payment address.',
    },
  },
} as const


// ── Agent Passport building blocks (#1446, epic #970) ────────────────────────

/** The passport row as the agent-scoped routes serialize it. */
const passportState = {
  type: 'object',
  required: [
    'status', 'assurance_level', 'attestation_uid', 'tx_hash', 'chain_id',
    'attempts', 'last_error', 'requested_at', 'anchored_at',
  ],
  properties: {
    status: {
      type: 'string',
      enum: ['pending', 'anchored', 'failed'],
      description:
        'Issuance progress. The enum is the table CHECK (migration 048), so a client can branch on it safely.',
    },
    assurance_level: {
      type: 'integer',
      description: 'L0 only. The table CHECK pins this to 0 — higher tiers are not issuable (#970).',
    },
    attestation_uid: { type: ['string', 'null'], description: 'EAS UID once anchored — the evidence pointer, never the decision.' },
    tx_hash: { type: ['string', 'null'] },
    chain_id: { type: ['integer', 'null'] },
    attempts: { type: 'integer' },
    last_error: { type: ['string', 'null'] },
    requested_at: { type: ['string', 'null'], format: 'date-time' },
    anchored_at: { type: ['string', 'null'], format: 'date-time' },
  },
} as const

/**
 * The signed receipt a merchant verifies OFFLINE. Field names are camelCase —
 * unlike the rest of this API — because the signature is over a canonical
 * JSON serialization of exactly these keys: renaming one breaks every
 * verifier. Documented as-is rather than normalized (#1446).
 */
const passportReceipt = {
  type: 'object',
  required: [
    'version', 'issuer', 'agentId', 'agentEoa', 'smartAccount', 'assuranceLevel',
    'standing', 'anchor', 'evidenceUid', 'chainId', 'controls', 'standingEpoch',
    'issuedAt', 'expiresAt',
  ],
  properties: {
    version: { type: 'string' },
    issuer: { ...address, description: 'The signing address a merchant pins — fetch it from GET /passport/issuer.' },
    agentId: { type: 'string', description: "Haven's opaque agent id. Not PII and not a wallet." },
    agentEoa: { type: ['string', 'null'], description: 'The delegate EOA a merchant sees on an EIP-3009 header.' },
    smartAccount: { type: ['string', 'null'], description: 'The Hybrid delegator a merchant sees in erc7710 redemption.' },
    assuranceLevel: { type: 'integer', enum: [0] },
    standing: {
      type: 'string',
      enum: ['active', 'suspended', 'revoked', 'unknown'],
      description: 'THE answer, sourced from the database — never derived from the chain.',
    },
    anchor: {
      type: 'string',
      enum: ['not_anchored', 'anchored', 'revocation_pending', 'revoked_onchain'],
      description: "The on-chain anchor's progress, for transparency. Never the authority.",
    },
    evidenceUid: { type: ['string', 'null'] },
    chainId: { type: ['integer', 'null'] },
    controls: {
      oneOf: [
        {
          type: 'object',
          required: ['rail', 'policyEnforcedOnchain', 'treasuryBound'],
          properties: {
            rail: { type: 'string', description: "The rail whose primitive holds the policy: 'delegation' or 'allowance'." },
            policyEnforcedOnchain: { type: 'boolean' },
            treasuryBound: { type: 'boolean' },
          },
        },
        { type: 'null' },
      ],
    },
    standingEpoch: {
      type: 'integer',
      description:
        'Monotonic ORDERING marker (ms) over changes to the agent record, not a causation signal; 0 means no timestamp. Equal epochs do NOT imply equal receipts — anchor progress moves without it (#1015).',
    },
    issuedAt: { type: 'integer' },
    expiresAt: { type: 'integer', description: 'issuedAt + the TTL published by GET /passport/issuer.' },
  },
} as const


// ── Safe (account) management building blocks (#1446) ────────────────────────

/** A linked Safe as every write and the list route return it. */
const userSafe = {
  type: 'object',
  required: ['id', 'safe_address', 'chain_id', 'name', 'is_default', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    safe_address: address,
    chain_id: { type: 'integer' },
    name: { type: 'string', description: "Display label; defaults to 'My account' when none is given." },
    is_default: { type: 'boolean', description: 'The first Safe a user links becomes the default.' },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const

/** An approver (Safe owner) decorated with Haven-stored metadata. */
const approver = {
  type: 'object',
  required: ['address', 'type', 'label'],
  properties: {
    address: {
      ...address,
      description: 'Checksummed, as the chain returns it — membership comes from getOwners(), not from Haven.',
    },
    type: {
      type: 'string',
      enum: ['eoa', 'passkey'],
      description: "Decoration only; defaults to 'eoa' for an owner Haven has no metadata row for.",
    },
    label: { type: ['string', 'null'], description: 'Trimmed and capped at 120 characters.' },
  },
} as const

/**
 * An unsigned Safe self-call for an owner change. Haven CONSTRUCTS and guards
 * it; the user signs and relays it through /safe/exec. Haven never signs.
 */
const safeOwnerTx = {
  type: 'object',
  required: ['to', 'value', 'data', 'operation'],
  properties: {
    to: { ...address, description: 'The Safe itself — owner changes are self-calls.' },
    value: { type: 'string', enum: ['0'] },
    data: { type: 'string', pattern: '^0x[0-9a-fA-F]*$' },
    operation: { type: 'integer', enum: [0], description: 'CALL, never DELEGATECALL.' },
  },
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
    payer_address: { anyOf: [address, { type: 'null' }], description: 'Delegate EOA captured on a payment intent.' },
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
    {
      name: 'x402',
      description:
        'Agent-side x402 payment authorization, plus an EXPLORATORY merchant-side surface (resource registration, public verification, receipts). The merchant-side routes are not production facilitator functionality and must not be exposed or expanded without legal/product review — see docs/regulatory/casp-risk-guardrails.md.',
    },
    { name: 'Machine payments' },
    { name: 'Transactions' },
    { name: 'Delegations' },
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
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
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
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'Delegate balance.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DelegateBalance' },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
          '422': errorResponse,
        },
      },
    },
    '/agents/{id}/archive': {
      post: {
        tags: ['Agents'],
        operationId: 'archiveAgent',
        summary: 'Archive a revoked agent (soft removal — history is kept).',
        description:
          'Replaces agent deletion (#1401). Requires status=revoked — archiving is a filing action and never the thing that stops spending. The agent row and every dependent audit row (payments, approvals, evidence, delegations, passports) remain; the agent leaves the primary list. Idempotent: re-archiving keeps the original archived_at.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'Archived (or already archived).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['success', 'archived_at'],
                  properties: {
                    success: { type: 'boolean' },
                    archived_at: isoDateTime,
                  },
                  additionalProperties: false,
                },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/agents/{id}/unarchive': {
      post: {
        tags: ['Agents'],
        operationId: 'unarchiveAgent',
        summary: 'Return an archived agent to the primary list.',
        description:
          'Clears archived_at and nothing else — the agent remains revoked; un-archiving restores no authority of any kind. Idempotent on a non-archived agent.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'No longer archived (or was not archived).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['success'],
                  properties: { success: { type: 'boolean' } },
                  additionalProperties: false,
                },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
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
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
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
    // ── Delegation lifecycle (#828, documented by #1446) ────────────────────
    // DESCRIPTIVE ONLY: these shapes document what the routes already return.
    // Spend authority lives in the signed delegation's on-chain caveat
    // enforcers, never in this spec — the backend prepares and relays but
    // signs nothing here (#824 invariants 5/12).
    '/agents/{id}/delegations': {
      get: {
        tags: ['Delegations'],
        operationId: 'listAgentDelegations',
        summary: "List an agent's budget delegations with lifecycle status.",
        description:
          "Every grant the agent has, newest first, including pending (built but not owner-signed), replaced and revoked rows — the dashboard renders exactly what is and isn't live (#802). The signed delegation object itself is deliberately NOT in the list: it is api_key_hash-class data returned only by the explicit flows that need it.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          '200': {
            description: 'Delegations ordered by created_at DESC.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['delegations'],
                  properties: {
                    delegations: { type: 'array', items: { $ref: '#/components/schemas/Delegation' } },
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/agents/{id}/delegations/build': {
      post: {
        tags: ['Delegations'],
        operationId: 'buildAgentDelegation',
        summary: 'Grant step 1: build an unsigned budget delegation for the owner to sign.',
        description:
          'Builds the EIP-712 typed data for a period-budget delegation (token, atomic budget, refill period, optional recipient pin, expiry — defaulting to 90 days) and stores it as a pending row. Nothing is signed and nothing moves: the OWNER signs signing_payload client-side (one signature, zero transactions) and then calls activate. A rebuilt (token, recipient) slot gets a fresh version so replacements never collide (#827).',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token_address', 'budget_atomic', 'period_seconds'],
                properties: {
                  token_address: address,
                  recipient_address: {
                    ...address,
                    description: 'Optional recipient pin. Omit (or null) for an open budget.',
                  },
                  budget_atomic: {
                    type: 'string',
                    pattern: '^[0-9]+$',
                    description: 'Positive atomic token amount; must fit uint96 (the enforcer word size).',
                  },
                  period_seconds: { type: 'integer', minimum: 60, description: 'Native refill period; ≥ 60.' },
                  expires_at: { type: 'integer', description: 'Unix seconds, must be in the future. Default: now + 90 days.' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Pending delegation stored; the owner signs signing_payload next.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['delegation_hash', 'version', 'delegate_account_address', 'signing_payload'],
                  properties: {
                    delegation_hash: delegationHash,
                    version: { type: 'integer', description: 'Fresh per (agent, token, recipient) slot — replacement identity (#827).' },
                    delegate_account_address: address,
                    signing_payload: {
                      type: 'object',
                      description: "EIP-712 typed data (primaryType 'Delegation') the owner signs verbatim.",
                      additionalProperties: true,
                    },
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/agents/{id}/delegations/{hash}/activate': {
      post: {
        tags: ['Delegations'],
        operationId: 'activateAgentDelegation',
        summary: 'Grant step 2: attach the owner signature and make the budget live.',
        description:
          "Stores the owner's signature on the pending delegation and flips it active, marking any previously active grant in the same (token, recipient) slot replaced — atomically, so the slot never ends up with zero live grants mid-replacement. Deploys the counterfactual delegator account via the relayer first when needed (#860; permissionless factory call, no owner signature). Activating an agent's FIRST budget also activates a pending_approval agent — on this rail the grant signature IS the approval (#1069). Signature validation is a shape check only (65-byte ECDSA or longer WebAuthn assertion); the real validator is EIP-1271 at redemption.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }, delegationHashParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['signature'],
                properties: {
                  signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130,}$' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Budget is live.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['activated', 'delegation_hash'],
                  properties: {
                    activated: { type: 'boolean' },
                    delegation_hash: delegationHash,
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '429': { ...errorResponse, description: 'Relayer gas budget exhausted — retry later.' },
          '500': { ...errorResponse, description: 'Stored owner config no longer derives the stored account address.' },
          '502': { ...errorResponse, description: 'Account deploy failed; the grant stays pending and activate can be retried.' },
        },
      },
    },
    '/agents/{id}/delegations/{hash}/revoke': {
      post: {
        tags: ['Delegations'],
        operationId: 'prepareDelegationRevocation',
        summary: 'Revoke step 1: prepare the disableDelegation UserOp for the owner to sign.',
        description:
          'Prepares a sponsored treasury UserOp executing disableDelegation. The response branches on the signature scheme: an EOA owner signs EIP-712 typed data (signing_payload); a pure-passkey account signs the userOpHash via WebAuthn (user_op_hash). Multi-signer accounts pick per request with signature_scheme. A row already disabled on-chain is healed to revoked and answered 409 instead of preparing a doomed op (#1423).',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }, delegationHashParam],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: signatureSchemeBody } },
        },
        responses: {
          '200': {
            description: 'Prepared revocation, shaped by the signature scheme.',
            content: { 'application/json': { schema: preparedTreasuryOp } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/agents/{id}/delegations/{hash}/revoke/submit': {
      post: {
        tags: ['Delegations'],
        operationId: 'submitDelegationRevocation',
        summary: 'Revoke step 2: submit the signed UserOp; the row flips only after it lands.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }, delegationHashParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['signature', 'user_operation'],
                properties: {
                  signature: hexBytes,
                  user_operation: preparedUserOperation,
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Delegation disabled on-chain and marked revoked.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['revoked', 'tx_hash'],
                  properties: {
                    revoked: { type: 'boolean' },
                    tx_hash: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/agents/{id}/delegations/revoke-all': {
      post: {
        tags: ['Delegations'],
        operationId: 'prepareRevokeAllDelegations',
        summary: 'Batch revoke step 1: ONE signature kills every non-revoked budget (#1400).',
        description:
          'Bundles one disableDelegation call per pending/active delegation into a single sponsored UserOp (capped at 25 per batch; a coarser 100-row ceiling refuses before any reconciliation reads). Rows already disabled on-chain are healed to revoked and dropped from the batch first (#1423). Response shape matches the per-hash prepare, plus the delegation_hashes the batch will kill.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: signatureSchemeBody } },
        },
        responses: {
          '200': {
            description: 'Prepared batch revocation, shaped by the signature scheme.',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      required: ['signature_scheme', 'signing_payload', 'user_operation', 'treasury_address', 'delegation_hashes', 'instructions'],
                      properties: {
                        signature_scheme: { type: 'string', enum: ['eip712_userop'] },
                        signing_payload: eip712Payload,
                        user_operation: preparedUserOperation,
                        treasury_address: address,
                        delegation_hashes: delegationHashList,
                        instructions: { type: 'string' },
                      },
                    },
                    {
                      type: 'object',
                      required: ['signature_scheme', 'user_op_hash', 'user_operation', 'treasury_address', 'delegation_hashes', 'instructions'],
                      properties: {
                        signature_scheme: { type: 'string', enum: ['webauthn_userop'] },
                        user_op_hash: { type: 'string' },
                        user_operation: preparedUserOperation,
                        treasury_address: address,
                        delegation_hashes: delegationHashList,
                        instructions: { type: 'string' },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '422': { ...errorResponse, description: 'Batch too large — revoke per hash, then retry.' },
          '502': errorResponse,
        },
      },
    },
    '/agents/{id}/delegations/revoke-all/submit': {
      post: {
        tags: ['Delegations'],
        operationId: 'submitRevokeAllDelegations',
        summary: 'Batch revoke step 2: submit the signed batch; rows flip only after the UserOp lands.',
        description:
          'The response reports the hashes that actually flipped (scoped to this agent), never an echo of the request.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['signature', 'user_operation', 'delegation_hashes'],
                properties: {
                  signature: hexBytes,
                  user_operation: preparedUserOperation,
                  delegation_hashes: delegationHashList,
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Batch disabled on-chain; the listed rows are marked revoked.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['revoked', 'tx_hash', 'delegation_hashes'],
                  properties: {
                    revoked: { type: 'boolean' },
                    tx_hash: { type: 'string' },
                    delegation_hashes: delegationHashList,
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/agents/{id}/account-signers': {
      get: {
        tags: ['Delegations'],
        operationId: 'getAccountSigners',
        summary: "Read the treasury account's signer set (public key material only).",
        description:
          "The exact owner configuration the account address was derived from (#887) — the dashboard rebuilds the WebAuthn signer from this. Nothing secret: an address and P256 public-key coordinates.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          '200': {
            description: 'The signer set.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['account_address', 'chain_id', 'owner_address', 'passkeys'],
                  properties: {
                    account_address: address,
                    chain_id: { type: 'integer' },
                    owner_address: {
                      type: ['string', 'null'],
                      pattern: '^0x[0-9a-fA-F]{40}$',
                      description: 'Null for a pure-passkey account.',
                    },
                    passkeys: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['key_id', 'x', 'y'],
                        properties: {
                          key_id: { type: 'string' },
                          x: { type: 'string', description: '0x-hex P256 public-key x coordinate.' },
                          y: { type: 'string', description: '0x-hex P256 public-key y coordinate.' },
                        },
                      },
                    },
                  },
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
    '/agents/{id}/account-signers/prepare': {
      post: {
        tags: ['Delegations'],
        operationId: 'prepareSignerChange',
        summary: 'Prepare a signer-set change (enroll a backup, remove a key) for an EXISTING signer to sign.',
        description:
          "Signer changes are ACCOUNT operations prepared here and signed by an existing signer — Haven prepares, never signs (#824). The chain's CannotRemoveLastSigner rule is mirrored as a clear 409 instead of an opaque revert; an informed two-to-one transition is permitted (#1199). Unlike the revocation prepares, this response carries no treasury_address.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: signerActionBody } },
        },
        responses: {
          '200': {
            description: 'Prepared signer change, shaped by the signature scheme.',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      required: ['signature_scheme', 'signing_payload', 'user_operation', 'instructions'],
                      properties: {
                        signature_scheme: { type: 'string', enum: ['eip712_userop'] },
                        signing_payload: eip712Payload,
                        user_operation: preparedUserOperation,
                        instructions: { type: 'string' },
                      },
                    },
                    {
                      type: 'object',
                      required: ['signature_scheme', 'user_op_hash', 'user_operation', 'instructions'],
                      properties: {
                        signature_scheme: { type: 'string', enum: ['webauthn_userop'] },
                        user_op_hash: { type: 'string' },
                        user_operation: preparedUserOperation,
                        instructions: { type: 'string' },
                      },
                    },
                  ],
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/agents/{id}/account-signers/submit': {
      post: {
        tags: ['Delegations'],
        operationId: 'submitSignerChange',
        summary: 'Submit the signed signer-set change; storage syncs only after the on-chain op succeeds.',
        description:
          'Body precedence is envelope first, config second: a malformed body is a 400 regardless of account state. The DB sync is pinned to the SIGNED calldata — a user_operation that does not match the signed action is refused.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['signature', 'user_operation'],
                properties: {
                  ...signerActionBody.properties,
                  signature: hexBytes,
                  user_operation: preparedUserOperation,
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Signer set updated on-chain and in storage.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['updated', 'tx_hash'],
                  properties: {
                    updated: { type: 'boolean' },
                    tx_hash: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '502': errorResponse,
        },
      },
    },
    // ── x402 demo resources (#1446) ─────────────────────────────────────────
    // REGULATORY PERIMETER, carried from routes/x402-resources.ts: this is
    // EXPLORATORY merchant-side x402, not production facilitator
    // functionality. Documenting it does not widen it — see
    // docs/regulatory/casp-risk-guardrails.md before exposing or expanding
    // resource registration, public verification, receipts or settlement.
    '/x402/resources': {
      post: {
        tags: ['x402'],
        operationId: 'createX402Resource',
        summary: 'Register a resource behind an x402 payment wall.',
        description:
          "Stores the resource and returns the 402 challenge a resource server embeds in its own responses. Price is ALWAYS atomic units (price_amount); price_human is derived for display only. Payment lands on the linked Safe — safe_id when given (ownership-checked), otherwise the user's default Safe; with neither, registration refuses rather than creating an unpayable resource.",
        security: [{ DashboardJwt: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'price_amount', 'token_address', 'token_symbol'],
                properties: {
                  name: { type: 'string', minLength: 1, description: 'Trimmed; blank after trimming is a 400.' },
                  description: { type: 'string' },
                  price_amount: { type: 'string', pattern: '^[0-9]+$', description: 'Atomic units; must parse as an integer.' },
                  token_address: address,
                  token_symbol: { type: 'string', minLength: 1, description: 'Stored uppercase.' },
                  chain_id: { type: 'integer', description: 'Defaults to DEFAULT_CHAIN_ID (Base).' },
                  safe_id: { type: 'string', format: 'uuid', description: "Must belong to the caller; omitted, the user's default Safe is used." },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Resource registered; the challenge is ready to embed.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['resource_id', 'name', 'price_amount', 'price_human', 'token_symbol', 'token_address', 'chain_id', 'pay_to', 'challenge'],
                  properties: {
                    resource_id: { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                    price_amount: { type: 'string', pattern: '^[0-9]+$' },
                    price_human: { type: 'string' },
                    token_symbol: { type: 'string' },
                    token_address: { type: 'string', pattern: '^0x[0-9a-f]{40}$' },
                    chain_id: { type: 'integer' },
                    pay_to: address,
                    challenge: x402Challenge,
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
        },
      },
      get: {
        tags: ['x402'],
        operationId: 'listX402Resources',
        summary: "List the caller's registered resources, newest first.",
        description:
          'Includes deactivated resources — active is a field, not a filter, so an owner can see what they took down. pay_to and challenge are null together when the linked Safe was detached.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Resources ordered by created_at DESC.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['resources'],
                  properties: {
                    resources: { type: 'array', items: x402Resource },
                  },
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
    },
    '/x402/resources/{id}': {
      delete: {
        tags: ['x402'],
        operationId: 'deactivateX402Resource',
        summary: 'Deactivate a resource (soft delete).',
        description:
          'Sets active=false, scoped to the caller. The row is kept so existing receipts keep their resource, and the challenge endpoint answers 410 rather than 404 — a payer learns the resource retired, not that it never existed.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Resource id.' }],
        responses: {
          '200': {
            description: 'Resource deactivated.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/x402/receipts': {
      get: {
        tags: ['x402'],
        operationId: 'listX402Receipts',
        summary: 'List payments verified against the caller\'s resources (max 100, newest first).',
        description:
          'Receipts are written only by the verify endpoint, after on-chain verification. amount_human here is best-effort: it formats with 6 decimals unconditionally, so a non-6-decimal token displays wrong — amount_raw is the authoritative field.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Receipts ordered by verified_at DESC, capped at 100.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['receipts'],
                  properties: {
                    receipts: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['receipt_id', 'resource_id', 'resource_name', 'tx_hash', 'payer_address', 'amount_raw', 'amount_human', 'chain_id', 'verified_at'],
                        properties: {
                          receipt_id: { type: 'string', format: 'uuid' },
                          resource_id: { type: 'string', format: 'uuid' },
                          resource_name: { type: 'string' },
                          tx_hash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
                          payer_address: { type: ['string', 'null'], pattern: '^0x[0-9a-fA-F]{40}$' },
                          amount_raw: { type: 'string', pattern: '^[0-9]+$' },
                          amount_human: { type: 'string', description: 'Formatted with 6 decimals unconditionally (best-effort).' },
                          chain_id: { type: 'integer' },
                          verified_at: { type: 'string', format: 'date-time' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
    },
    '/x402/resources/{id}/challenge': {
      get: {
        tags: ['x402'],
        operationId: 'getX402ResourceChallenge',
        summary: 'PUBLIC: fetch a resource\'s 402 payment challenge.',
        description:
          'No authentication — a challenge is public by construction, and it grants nothing: it states a price and a destination. NOTE THE SUCCESS CODE: this answers **402 Payment Required** with the challenge body, not 200, so a resource server can relay the status verbatim. 410 means the resource was deactivated; 503 means it has no payment address (its Safe was detached).',
        security: [],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Resource id.' }],
        responses: {
          '402': {
            description: 'The payment challenge (the success case for this route).',
            content: { 'application/json': { schema: x402Challenge } },
          },
          '400': errorResponse,
          '404': errorResponse,
          '410': { ...errorResponse, description: 'Resource deactivated.' },
          '503': { ...errorResponse, description: 'Resource has no payment address configured.' },
        },
      },
    },
    '/x402/resources/{id}/verify': {
      post: {
        tags: ['x402'],
        operationId: 'verifyX402Payment',
        summary: 'PUBLIC: verify a transaction paid for this resource, and mint a receipt.',
        description:
          "No authentication — verification reads the chain and the resource's own terms, so it grants the caller nothing they could not check themselves. The transaction must be an AllowanceModule transfer to the resource's Safe, in the resource's token, for at least its price. A tx_hash already used is a 409 (receipts are one-per-transaction, enforced before any RPC call). A failed verification is **402 with verified:false plus the expected terms** — a documented negative answer, not an error envelope.",
        security: [],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Resource id.' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['tx_hash'],
                properties: { tx_hash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' } },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Payment verified on-chain; a receipt was stored.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['verified', 'receipt_id', 'resource_id', 'resource_name', 'tx_hash', 'payer_address', 'amount_raw', 'amount_human', 'token_symbol', 'verified_at'],
                  properties: {
                    verified: { type: 'boolean', enum: [true] },
                    receipt_id: { type: 'string', format: 'uuid' },
                    resource_id: { type: 'string', format: 'uuid' },
                    resource_name: { type: 'string' },
                    tx_hash: { type: 'string', pattern: '^0x[0-9a-f]{64}$', description: 'Lowercased before storage.' },
                    payer_address: { type: ['string', 'null'], pattern: '^0x[0-9a-fA-F]{40}$' },
                    amount_raw: { type: 'string', pattern: '^[0-9]+$', description: "The VERIFIED on-chain amount, which can exceed the resource price." },
                    amount_human: { type: 'string' },
                    token_symbol: { type: 'string' },
                    verified_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '402': {
            description: 'Verification failed — the documented negative answer, with the terms the transaction had to meet.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['verified', 'reason', 'expected'],
                  properties: {
                    verified: { type: 'boolean', enum: [false] },
                    reason: { type: 'string' },
                    expected: {
                      type: 'object',
                      required: ['to', 'token', 'min_amount', 'chain_id'],
                      properties: {
                        to: address,
                        token: {
                          type: 'string',
                          pattern: '^0x[0-9a-fA-F]{40}$',
                          description: 'From storage, so case is not guaranteed (see the list schema).',
                        },
                        min_amount: { type: 'string', pattern: '^[0-9]+$' },
                        chain_id: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          '404': errorResponse,
          '409': { ...errorResponse, description: 'This transaction was already used as payment.' },
          '410': { ...errorResponse, description: 'Resource deactivated.' },
          '503': { ...errorResponse, description: 'Resource has no payment address.' },
        },
      },
    },
    // ── Agent Passport (epic #970, documented by #1446) ─────────────────────
    // GOVERNANCE METADATA, never spend authority: a passport attests that an
    // agent was issued by Haven, bound to a treasury, governed by
    // on-chain-enforced controls, and is revocable. It verifies no payment and
    // settles nothing. The word "verified" is reserved for the unissuable L2
    // tier — see docs/product/agent-passport.md.
    '/agents/{id}/passport': {
      get: {
        tags: ['Agents'],
        operationId: 'getAgentPassport',
        summary: "Read an agent's passport state and its authoritative standing.",
        description:
          "`passport: null` means the agent has none — the normal case for a basic agent, never an error (issuance is opt-in). The two fields answer different questions and are deliberately not collapsed into one badge: `standing` is the DATABASE's authoritative answer about the agent, while `passport.status`/the anchor describe how far the on-chain attestation has got. The chain lags; the database does not.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '200': {
            description: 'Passport state (or null) plus the agent\'s standing.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['passport', 'standing'],
                  properties: {
                    passport: { oneOf: [passportState, { type: 'null' }] },
                    standing: {
                      type: 'object',
                      description:
                        'The standing OBJECT (not a bare string): the database-authoritative answer plus the chain-lag transparency fields. Always present, even for an agent with no passport row.',
                      required: ['agentId', 'standing', 'anchor', 'attestationUid', 'chainLagging', 'revocationConfirmedAt'],
                      properties: {
                        agentId: { type: 'string' },
                        standing: {
                          type: 'string',
                          enum: ['active', 'suspended', 'revoked', 'unknown'],
                          description: 'THE answer, derived from agents.status alone — an agent revoked before its passport ever anchored is still revoked.',
                        },
                        anchor: {
                          type: 'string',
                          enum: ['not_anchored', 'anchored', 'revocation_pending', 'revoked_onchain'],
                          description: 'Describes the chain, for transparency — not for deciding.',
                        },
                        attestationUid: { type: ['string', 'null'] },
                        chainLagging: {
                          type: 'boolean',
                          description: 'True when the database says revoked but the chain has not caught up — a merchant reading only the chain in this window would be WRONG.',
                        },
                        revocationConfirmedAt: { type: ['string', 'null'], format: 'date-time' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
        },
      },
      post: {
        tags: ['Agents'],
        operationId: 'requestAgentPassport',
        summary: 'Opt an existing agent in to a passport.',
        description:
          "Owner action, never agent-authenticated: an agent must not be able to issue itself a credential. Records the request synchronously and returns **202** — the EAS write is fire-and-forget, so poll the GET (or the public verifier) for the anchored state. Idempotent: an already-anchored passport returns **200** with `already_issued: true` rather than minting a second attestation. Refusals are shaped by whose problem it is — a revoked agent is a 409 (terminal, and anchoring now would spend gas on an attestation that must be revoked immediately), an unbound or unsupported chain is a 400, and a deployment that has not configured issuance is a 503, because that is the operator's gap and not the caller's mistake. A PAUSED agent is deliberately not blocked: pausing is reversible and `standing` already reports it as suspended.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          '202': {
            description: 'Passport requested; the anchor is in progress.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['passport'],
                  properties: { passport: { oneOf: [passportState, { type: 'null' }] } },
                },
              },
            },
          },
          '200': {
            description: 'Already anchored — nothing was minted and no gas was spent.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['passport', 'already_issued'],
                  properties: {
                    passport: passportState,
                    already_issued: { type: 'boolean', enum: [true] },
                  },
                },
              },
            },
          },
          '400': { ...errorResponse, description: 'Agent has no bound account, or passports are not issued on its chain.' },
          '401': errorResponse,
          '404': errorResponse,
          '409': { ...errorResponse, description: 'Agent is revoked — revocation is terminal.' },
          '503': { ...errorResponse, description: 'Passport issuance is not configured on this deployment.' },
        },
      },
    },
    '/passport/issuer': {
      get: {
        tags: ['Agents'],
        operationId: 'getPassportIssuer',
        summary: 'PUBLIC: the issuer address a merchant pins to verify receipts offline.',
        description:
          'Published so pinning is a one-time setup step rather than something a merchant extracts from a receipt it has not yet verified — trusting the issuer field of an unverified artifact is circular. Rate-limited.',
        security: [],
        responses: {
          '200': {
            description: 'The issuer and the receipt envelope parameters.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['issuer', 'version', 'receipt_ttl_seconds', 'signature_scheme'],
                  properties: {
                    issuer: address,
                    version: { type: 'string' },
                    receipt_ttl_seconds: { type: 'integer' },
                    signature_scheme: { type: 'string', examples: ['eip191-personal-sign-over-canonical-json'] },
                  },
                },
              },
            },
          },
          '429': { ...errorResponse, description: 'Rate limited.' },
          '503': { ...errorResponse, description: 'Verification is not configured on this deployment.' },
        },
      },
    },
    '/passport/verify': {
      get: {
        tags: ['Agents'],
        operationId: 'verifyPassport',
        summary: 'PUBLIC: fetch a signed governance receipt for an agent.',
        description:
          "Unauthenticated by design — the caller is a merchant deciding whether to serve an agent; it has no Haven account and cannot be asked to get one. That makes the disclosure boundary the only protection, so the receipt carries booleans and public on-chain addresses and nothing else: no budget, no balance, no owner, and no Safe/treasury identifier beyond the spend accounts a merchant already needs in order to recognise the payer (the delegate EOA on an EIP-3009 header, the smart account in erc7710 redemption). Query by EXACTLY ONE of `address` or `uid`; both or neither is a 400. **An agent with no passport is 200 with `found: false`, not a 404** — issuance is opt-in so most agents have none, and an error status invites integrations to treat a lookup failure as a pass. Only passports already public on-chain resolve; a pending or failed one is indistinguishable from having none. Caching follows the same logic: a negative answer is `no-store` (today's no can be tomorrow's yes), a receipt is cacheable for half its TTL so an HTTP cache can never outlive the signed envelope.",
        security: [],
        parameters: [
          { name: 'address', in: 'query', required: false, schema: address, description: "The agent's delegate EOA or smart account." },
          { name: 'uid', in: 'query', required: false, schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' }, description: 'EAS attestation UID.' },
        ],
        responses: {
          '200': {
            description: 'Either a signed receipt, or a clean `found: false` — both are normal answers.',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      required: ['found', 'receipt', 'signature'],
                      properties: {
                        found: { type: 'boolean', enum: [true] },
                        receipt: passportReceipt,
                        signature: { type: 'string', description: 'EIP-191 signature over the canonical JSON of `receipt`.' },
                      },
                    },
                    {
                      type: 'object',
                      required: ['found'],
                      properties: {
                        found: { type: 'boolean', enum: [false] },
                        reason: { type: 'string' },
                      },
                    },
                  ],
                },
              },
            },
          },
          '400': { ...errorResponse, description: 'Not exactly one of address/uid, or a malformed value.' },
          '429': { ...errorResponse, description: 'Rate limited.' },
          '503': { ...errorResponse, description: 'Receipt signing is not configured — fail closed rather than serve an unsigned receipt.' },
        },
      },
    },
    // ── Safe (account) management (#1446) ───────────────────────────────────
    // CUSTODY BOUNDARY: Haven links, labels and CONSTRUCTS owner-change
    // transactions, but never signs one. Membership truth is on-chain
    // (getOwners()); the approver rows here only decorate it with a label and
    // a type. A user who deletes a Safe from Haven still owns it on-chain.
    //
    // RETIRING SURFACE (#1440, owner decision 2026-08-14: the Safe rail goes
    // away entirely). Of the operations below, only the four plain-CRUD ones
    // (list, rename, set-default, unlink) are expected to survive — user_safes
    // is shared with the delegation rail. `deploy`, the import POST and every
    // approver route are on that epic's removal list, and their entries here
    // come out with them. Documented anyway, deliberately: the spec describes
    // the API that exists TODAY, and an undocumented live route is the failure
    // #1442 was opened on. Do not build new callers against the retiring half.
    '/user/safes': {
      get: {
        tags: ['Dashboard'],
        operationId: 'listUserSafes',
        summary: "List the Safes linked to the caller's account, oldest first.",
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Linked Safes ordered by created_at ASC.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['safes'],
                  properties: { safes: { type: 'array', items: userSafe } },
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
      post: {
        tags: ['Dashboard'],
        operationId: 'addUserSafe',
        summary: 'Link (import) an existing Safe to the caller\'s account.',
        description:
          'Registration only — this moves nothing on-chain and grants Haven no authority over the Safe. The same address on the same chain cannot be linked twice (409). The first Safe a user links becomes their default.',
        security: [{ DashboardJwt: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['safe_address'],
                properties: {
                  safe_address: address,
                  chain_id: { type: 'integer', description: 'Defaults to DEFAULT_CHAIN_ID (Base); must be a supported chain.' },
                  name: { type: 'string', description: "Trimmed; blank or absent becomes 'My account'." },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Safe linked.',
            content: { 'application/json': { schema: userSafe } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '409': { ...errorResponse, description: 'This Safe is already linked to the account.' },
        },
      },
    },
    '/user/safes/deploy': {
      post: {
        tags: ['Dashboard'],
        operationId: 'deployUserSafe',
        summary: 'Deploy a new Safe with the relayer paying gas.',
        description:
          'The relayer sponsors the deployment and returns the deployed address plus the transaction hash. Deployment does NOT link the Safe: registration is a separate POST /user/safes call, so onboarding and add-account take the identical path. The deployed Safe is owned by owner_address (single owner, threshold 1) and never by Haven. Note that owner_address is NOT checked against the caller: any authenticated user can have a Safe deployed for any address, so this is a relayer-gas surface bounded only by the global rate limit, not a per-caller ownership check.',
        security: [{ DashboardJwt: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['owner_address'],
                properties: {
                  owner_address: address,
                  chain_id: { type: 'integer', description: 'Defaults to DEFAULT_CHAIN_ID (Base); must be a supported chain.' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Safe deployed; link it with POST /user/safes.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['safe_address', 'tx_hash'],
                  properties: { safe_address: address, tx_hash: { type: 'string' } },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '500': { ...errorResponse, description: 'Relay deployment failed.' },
        },
      },
    },
    '/user/safes/{safeId}': {
      put: {
        tags: ['Dashboard'],
        operationId: 'renameUserSafe',
        summary: 'Rename a linked Safe.',
        description: 'Display metadata only — the name exists nowhere on-chain.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'safeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Linked-Safe id.' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', minLength: 1, description: 'Trimmed; blank after trimming is a 400.' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'The renamed Safe.',
            content: { 'application/json': { schema: userSafe } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
        },
      },
      delete: {
        tags: ['Dashboard'],
        operationId: 'unlinkUserSafe',
        summary: 'Unlink a Safe from the Haven account.',
        description:
          'Removes the link and its Haven-side metadata. **The Safe itself is untouched on-chain** — the user still owns it and can re-link it later. Unlinking the default Safe promotes another one.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'safeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Linked-Safe id.' }],
        responses: {
          '200': {
            description: 'Safe unlinked.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/user/safes/{safeId}/default': {
      put: {
        tags: ['Dashboard'],
        operationId: 'setDefaultUserSafe',
        summary: 'Make a linked Safe the default.',
        description: "Exactly one Safe is default per user; setting one clears the previous.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'safeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Linked-Safe id.' }],
        responses: {
          '200': {
            description: 'Default updated.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/user/safes/known-approvers': {
      get: {
        tags: ['Dashboard'],
        operationId: 'listKnownApprovers',
        summary: "The caller's approver registry across all their Safes.",
        description:
          'Distinct by address, carrying the most recent label/type and every safe_id the approver is known on — so a picker can offer reuse on another account while excluding the Safes it already approves (#417). Haven metadata only; it confers nothing on-chain.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Known approvers, distinct by address.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['approvers'],
                  properties: {
                    approvers: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['address', 'type', 'label', 'safe_ids'],
                        properties: {
                          ...approver.properties,
                          safe_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
    },
    '/user/safes/{safeId}/approvers': {
      get: {
        tags: ['Dashboard'],
        operationId: 'listSafeApprovers',
        summary: "Read a Safe's on-chain owners, decorated with stored labels.",
        description:
          'The owner list and threshold are read live from the chain (`getOwners()`), not from Haven — an owner added outside Haven appears here with no label rather than being invisible.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'safeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Linked-Safe id.' }],
        responses: {
          '200': {
            description: 'On-chain owners plus the Safe threshold.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['threshold', 'approvers'],
                  properties: {
                    threshold: { type: 'integer' },
                    approvers: { type: 'array', items: approver },
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '502': { ...errorResponse, description: 'Could not read owners from the network.' },
        },
      },
      post: {
        tags: ['Dashboard'],
        operationId: 'upsertSafeApproverMetadata',
        summary: 'Record an approver\'s label and type after the on-chain change lands.',
        description:
          'Metadata only, and idempotent: this does not add an owner. Call it after relaying the transaction from /approvers/tx. Enrolling a passkey approver also binds it to the Safe as a signing fast-path — deliberately non-fatal, because /safe/exec re-derives the binding from the on-chain owner list when it is missing.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'safeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Linked-Safe id.' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['address'],
                properties: {
                  address: address,
                  type: { type: 'string', enum: ['eoa', 'passkey'], description: "Defaults to 'eoa'." },
                  label: { type: 'string', description: 'Trimmed and capped at 120 characters; blank becomes null.' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Metadata recorded.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/user/safes/{safeId}/approvers/tx': {
      post: {
        tags: ['Dashboard'],
        operationId: 'buildSafeApproverTx',
        summary: 'Build the UNSIGNED owner-change transaction for the user to sign.',
        description:
          "Haven constructs and guards; the user signs and relays through /safe/exec. Haven never signs an owner change. The guards run against the LIVE owner list, before any transaction is produced: removing the final owner is refused (409), as is adding an owner the Safe already has; removing an address that is not an owner is a 404.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'safeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Linked-Safe id.' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['action', 'address'],
                properties: {
                  action: { type: 'string', enum: ['add', 'remove'] },
                  address: address,
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'The unsigned Safe self-call.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['chain_id', 'safe_address', 'tx'],
                  properties: {
                    chain_id: { type: 'integer' },
                    safe_address: address,
                    tx: safeOwnerTx,
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': { ...errorResponse, description: 'Safe not found, or the address to remove is not an owner.' },
          '409': { ...errorResponse, description: 'Would remove the last owner, or the owner already exists.' },
          '502': { ...errorResponse, description: 'Could not read owners from the network.' },
        },
      },
    },
    '/user/safes/{safeId}/approvers/{address}': {
      delete: {
        tags: ['Dashboard'],
        operationId: 'deleteSafeApproverMetadata',
        summary: "Drop an approver's stored metadata after the on-chain removal.",
        description:
          'Cleans up the decoration row only — it removes no owner. The last-owner guard lives on /approvers/tx, where the actual removal is built.',
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'safeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Linked-Safe id.' },
          { name: 'address', in: 'path', required: true, schema: address, description: 'Approver address.' },
        ],
        responses: {
          '200': {
            description: 'Metadata removed.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } },
          },
          '400': errorResponse,
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
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
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
    '/agent-connection-setups/{setupId}/connector-status': {
      get: {
        tags: ['Connect Agent 2'],
        operationId: 'getAgentConnectionConnectorStatus',
        summary: 'Narrow post-register status read for the local connector.',
        description:
          'Lets the connector wait for the user\'s budget approval after registering (#1377). Authenticated with the pending agent API key — deliberately usable while the key is still setup_pending-scoped. Read-only and narrow by design: it reveals only the setup status plus, once active, the approved budget summary; it grants no payment authority and returns 404 for setups not owned by the presented key.',
        security: [{ AgentApiKey: [] }],
        parameters: [{ $ref: '#/components/parameters/SetupId' }],
        responses: {
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'Current setup status for the polling connector.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AgentConnectionConnectorStatus' },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
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
    '/agent-connection-setups/{setupId}/budget-approval': {
      post: {
        tags: ['Connect Agent 2'],
        operationId: 'recordAgentConnectionBudgetApproval',
        summary: 'Complete a delegation-rail Connect Agent 2 setup.',
        description:
          'The delegation rail\'s counterpart to wallet-approval. Activates the pending agent only after Haven confirms that every budget this setup promised exists as an active, owner-signed budget on the agent — the caller asserts nothing, so the request body is empty and the call is safe to retry. Rejected with 409 on a Safe / AllowanceModule wallet, which approves with a wallet transaction instead.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/SetupId' }],
        responses: {
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'The budget was confirmed and the setup status was returned.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AgentConnectionSetupStatus' },
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
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
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
          '403': agentAuthForbidden,
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
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'Payment intent status.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PaymentIntentStatus' },
              },
            },
          },
          '401': errorResponse,
          '403': agentAuthForbidden,
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
    '/payments/{id}/receipt': {
      get: {
        tags: ['Payments'],
        operationId: 'getPaymentReceipt',
        summary: 'Fetch a verifiable receipt for a settled payment.',
        description:
          'Returns a self-contained proof bundle (payment facts, the delegate authorization signature, and the on-chain tx) plus a self-verification. The bundle is verifiable independently of Haven by recovering the signer from the authorization and confirming it is the agent delegate.',
        security: [{ AgentApiKey: [] }],
        parameters: [{ $ref: '#/components/parameters/PaymentId' }],
        responses: {
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'Receipt bundle and verification result.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    receipt: { type: 'object', additionalProperties: true },
                    verification: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
          '401': errorResponse,
          '403': agentAuthForbidden,
          '404': errorResponse,
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
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'Serializable x402 or MPP resume state.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PaymentResumeState' },
              },
            },
          },
          '401': errorResponse,
          '403': agentAuthForbidden,
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
    '/x402/{id}/sign-context': {
      get: {
        tags: ['x402'],
        operationId: 'getX402SignContext',
        summary: 'Fetch the exact signing payload for a pending delegation-rail x402 intent.',
        description:
          'Read-only byte-free signing handoff (#1263): re-serves the stored delegation-rail signing payload (sign_data.typed_data) plus a freshly Haven-signed expected context committing to its digest, so a LOCAL SIGNER can fetch exact bytes by payment_id instead of an agent re-emitting them. Constructs and signs nothing new; the signer re-derives the digest and verifies the binding exactly as against an authorize response.',
        security: [{ AgentApiKey: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Payment intent id from the quote/authorize response.',
          },
        ],
        responses: {
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description:
              'The rebuilt sign_data + complete snake_case x402_expected context (field-for-field as signed).',
            content: {
              'application/json': { schema: x402AuthorizeResponse },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '410': errorResponse,
        },
      },
    },
    '/x402/{id}/merchant-call-context': {
      get: {
        tags: ['x402'],
        operationId: 'getX402MerchantCallContext',
        summary: 'Fetch the stored MCP merchant-call context for an x402 intent.',
        description:
          'Read-only settle-leg handoff (#1307): re-serves the merchant_url, tool_name, arguments, and mcp_transport recorded on the intent at quote time (haven_pay_mcp_tool), so haven_settle_mcp_tool / haven_complete_mcp_tool can omit them and let Haven rehydrate by payment_id instead of the caller re-threading them. Convenience metadata for retrying the MERCHANT\'s own call — never payment authority.',
        security: [{ AgentApiKey: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Payment intent id from the quote/authorize response.',
          },
        ],
        responses: {
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'The stored merchant call context.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/X402MerchantCallContext' } },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '410': errorResponse,
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
          '403': agentAuthForbidden,
        },
      },
    },
    '/machine-payments/allowances': {
      get: {
        tags: ['Machine payments'],
        operationId: 'getMachinePaymentAllowances',
        summary: 'Fetch live spend-authority state for the authenticated agent.',
        description:
          'Rail-aware (#1135): on the legacy rail this reads the on-chain AllowanceModule per configured token; on the delegation rail the same response shape carries the ACTIVE budget delegations (remaining = the period budget; AllowanceModule-only fields are zeroed placeholders). A retired session-rail account gets 410. Reporting only — enforcement stays on-chain on every rail.',
        security: [{ AgentApiKey: [] }],
        responses: {
          '200': {
            description: 'Configured and remaining spend authority for the account\'s rail.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AllowanceSummary' },
              },
            },
          },
          '401': errorResponse,
          '403': agentAuthForbidden,
          '410': {
            ...errorResponse,
            description: 'The account is on the retired session rail — no state is read (#993 fail-closed contract).',
          },
          '502': errorResponse,
        },
      },
    },
    '/machine-payments/authorize': {
      post: {
        tags: ['Machine payments'],
        operationId: 'authorizeMachinePayment',
        summary: 'Retired: the legacy MPP demo machine-payment authorize flow (#1328).',
        description:
          'The internal mpp_demo flow is retired outright — this endpoint now refuses unconditionally with HTTP 410, fail-closed, before the body is inspected (mirrors the #834 session-rail retirement pattern). DELIBERATE EXCEPTION (review decision on #1339): the route is retained as a compatibility tombstone rather than removed — a 410 tells an old client the flow is permanently gone, where a 404 reads as a transient routing error and invites retries. No new mpp_demo challenge can be authorized. Use the x402 merchant flow instead (POST /x402/authorize). Existing mpp_demo payment/receipt/evidence/status records remain readable through the other /machine-payments/* endpoints.',
        security: [{ AgentApiKey: [] }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MachinePaymentAuthorizeRequest' },
            },
          },
        },
        responses: {
          '401': errorResponse,
          '403': agentAuthForbidden,
          '410': {
            ...errorResponse,
            description: 'The mpp_demo flow is retired (#1328) — no new legacy MPP demo challenge can be authorized.',
          },
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
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'Agent payment status.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AgentPaymentStatus' },
              },
            },
          },
          '401': errorResponse,
          '403': agentAuthForbidden,
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
                    idempotent_replay: {
                      type: 'boolean',
                      description: 'Present and true when this is a replay of an earlier request with the same idempotency_key.',
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
                    idempotent_replay: {
                      type: 'boolean',
                      description: 'Present and true when this is a replay of an earlier request with the same idempotency_key.',
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          '200': {
            description:
              'Idempotent replay of a request whose payment has already progressed (e.g. confirmed, or an approval the owner executed). Body is the canonical payment-status object with idempotent_replay: true.',
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '409': {
            description:
              'Idempotent replay of a request that is mid-flight (intent submitted but not yet confirmed) or whose approval was rejected.',
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true },
              },
            },
          },
          '410': {
            description: 'Idempotent replay of a request whose payment has expired.',
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true },
              },
            },
          },
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
          '403': agentAuthForbidden,
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
          '403': agentAuthForbidden,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/machine-payments/{id}/merchant-receipt': {
      post: {
        tags: ['Machine payments'],
        operationId: 'reportMerchantReceipt',
        summary: "Report the merchant's own receipt for a settled payment.",
        description:
          "Captures the receipt document the merchant handed back in the paid response (invoice number, VAT breakdown — facts Haven's own payment evidence cannot assert). " +
          'The reporting feed attaches it verbatim next to the Haven-generated evidence document. Best-effort and idempotent: absence is the normal case, the first report wins, and nothing here affects the payment itself. ' +
          'Provide either `url` (https, fetched at feed time under strict guards) or `json` (the inline receipt document, max 64KB).',
        security: [{ AgentApiKey: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'The payment id (intent or approval) the receipt belongs to.',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'https URL to the merchant receipt document (pdf/png/jpg).' },
                  json: { type: 'object', description: 'The inline receipt document as provided by the merchant.', additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Merchant receipt stored.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { stored: { type: 'boolean' } },
                  required: ['stored'],
                },
              },
            },
          },
          '200': {
            description: 'A merchant receipt was already recorded for this payment (first write wins).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { stored: { type: 'boolean' }, message: { type: 'string' } },
                  required: ['stored'],
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': agentAuthForbidden,
          '404': errorResponse,
          '429': errorResponse,
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
          '403': agentAuthForbidden,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/machine-payments/sweep/prepare': {
      post: {
        tags: ['Machine payments'],
        operationId: 'prepareDelegateSweep',
        summary: 'Prepare a gasless USDC sweep from the delegate wallet to the Safe.',
        description:
          'Reads the delegate EOA\'s stranded USDC and returns an EIP-3009 TransferWithAuthorization (delegate → the agent\'s own Safe) plus Haven\'s authorization binding. ' +
          'The edge signer signs the authorization with haven_sign_sweep_delegate; POST /machine-payments/sweep/submit relays it. The delegate never needs ETH and Haven never holds the key. ' +
          'Returns { nothing_stranded: true } when the delegate is empty.',
        security: [{ AgentApiKey: [] }],
        responses: {
          '200': {
            description: 'Nothing stranded — no authorization to sign.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    nothing_stranded: { type: 'boolean', enum: [true] },
                    asset: { type: 'string', examples: ['USDC'] },
                    chain_id: { type: 'integer', examples: [8453] },
                    message: { type: 'string' },
                  },
                  required: ['nothing_stranded', 'chain_id'],
                },
              },
            },
          },
          '201': {
            description: 'Sweep authorization prepared; sign and submit it.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SweepPrepareResponse' },
              },
            },
          },
          '401': errorResponse,
          '403': agentAuthForbidden,
          '422': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/machine-payments/sweep/submit': {
      post: {
        tags: ['Machine payments'],
        operationId: 'submitDelegateSweep',
        summary: 'Relay a delegate-signed gasless USDC sweep.',
        description:
          'Submits the delegate-signed EIP-3009 authorization from /machine-payments/sweep/prepare. Haven\'s relayer pays gas; the relayer is never a spender. ' +
          'The authorization is re-derived from server state, the delegate signature is verified, and the balance is re-read before relaying.',
        security: [{ AgentApiKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SweepSubmitRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Sweep relayed (or idempotent replay of a prior relay).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SweepSubmitResponse' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '502': errorResponse,
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
    '/transactions/filters': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getTransactionFilterOptions',
        summary: 'Filter metadata (safes, agents, tokens) for the transactions view.',
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'fresh', in: 'query', schema: { type: 'string', enum: ['1', 'true'] } },
        ],
        responses: {
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'Available filter options.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TransactionFilterOptionsResponse' } } },
          },
          '401': errorResponse,
        },
      },
    },
    '/transactions/{safeAddress}': {
      get: {
        tags: ['Dashboard'],
        operationId: 'listSafeTransactions',
        summary: 'Page-based transaction list for one Safe.',
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'safeAddress', in: 'path', required: true, schema: address },
          { name: 'chain_id', in: 'query', schema: { type: 'integer' } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
          { name: 'fresh', in: 'query', schema: { type: 'string', enum: ['1', 'true'] } },
        ],
        responses: {
          '200': {
            description: 'Paginated per-Safe transactions.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TransactionsPageResponse' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
        },
      },
    },
    '/dashboard/overview': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getDashboardOverview',
        summary: 'Aggregated dashboard overview: totals, day change, metrics, previews.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Dashboard overview.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DashboardOverviewResponse' } } },
          },
          '401': errorResponse,
        },
      },
    },
    '/balances/{safeAddress}': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getSafeBalances',
        summary: 'Token balances for one Safe.',
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'safeAddress', in: 'path', required: true, schema: address },
          { name: 'chain_id', in: 'query', schema: { type: 'integer' }, description: 'Required when the same address is linked on more than one chain.' },
        ],
        responses: {
          '200': {
            description: 'Balances, native token first.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BalancesResponse' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
        },
      },
    },
    '/portfolio/{safeAddress}': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getSafePortfolio',
        summary: 'Fiat-valued portfolio breakdown for one Safe.',
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'safeAddress', in: 'path', required: true, schema: address },
          { name: 'chain_id', in: 'query', schema: { type: 'integer' }, description: 'Required when the same address is linked on more than one chain.' },
        ],
        responses: {
          '200': {
            description: 'Portfolio totals and per-token breakdown.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PortfolioResponse' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
        },
      },
    },
    '/safe/{safeAddress}/details': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getSafeDetails',
        summary: 'On-chain Safe details: owners, threshold, nonce.',
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'safeAddress', in: 'path', required: true, schema: address },
          { name: 'chain_id', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'Safe details.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SafeDetails' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
        },
      },
    },
    '/contacts': {
      get: {
        tags: ['Contacts'],
        operationId: 'listContacts',
        summary: "List the user's saved address-book entries.",
        description:
          'Dashboard address book: a name for an address, scoped to the user. Naming an address changes nothing on-chain and grants no authority — it is presentation only, so a transfer to a named contact is exactly as constrained as a transfer to a raw address.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Contacts, alphabetical by name (LIST_CONTACTS_FOR_USER_SQL orders by name ASC).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['contacts'],
                  properties: {
                    contacts: { type: 'array', items: { $ref: '#/components/schemas/Contact' } },
                  },
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
      post: {
        tags: ['Contacts'],
        operationId: 'createContact',
        summary: 'Save a new address-book entry.',
        description:
          'The address must be a valid EVM address and unique per user — a second entry for the same address is a 409, not a silent overwrite, so an existing name is never replaced by accident.',
        security: [{ DashboardJwt: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'address'],
                properties: {
                  name: { type: 'string', minLength: 1, description: 'Trimmed before storage; blank after trimming is a 400.' },
                  address: address,
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Contact created.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Contact' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/contacts/{id}': {
      put: {
        tags: ['Contacts'],
        operationId: 'renameContact',
        summary: 'Rename an address-book entry.',
        description: 'Only the name is mutable; an address is never re-pointed under an existing name. To point a name at a different address, delete and re-create.',
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: uuid },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', minLength: 1 } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Updated contact.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Contact' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
        },
      },
      delete: {
        tags: ['Contacts'],
        operationId: 'deleteContact',
        summary: 'Delete an address-book entry.',
        description:
          'Hard delete of a label, not of history: transactions to that address remain, and simply stop rendering a name. A contact belonging to another user is a 404, never a 403 — the route does not confirm that an id exists.',
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: uuid },
        ],
        responses: {
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'Deleted.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['success'],
                  properties: { success: { type: 'boolean' } },
                },
              },
            },
          },
          '401': errorResponse,
          '404': errorResponse,
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
          'Entries are operator-curated and periodically re-verified against the live merchant 402 challenge; category matching is case-insensitive and search matches product name, description, or category. Blank search is rejected after trimming and non-empty search is capped at 120 characters; nothing here creates payments or signatures.',
        security: [{ AgentApiKey: [] }, { DashboardJwt: [] }],
        parameters: [
          { name: 'category', in: 'query', schema: { type: 'string' } },
          {
            name: 'search',
            in: 'query',
            schema: { type: 'string', minLength: 1, maxLength: 120 },
            description: 'Whitespace is trimmed/collapsed. Blank search after trimming returns 400.',
          },
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
          '403': agentAuthForbidden,
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
          // #1464: a malformed uuid in the path is a 400 (central 22P02
          // mapping in infra/http-error-handler.ts), not a 500.
          '400': errorResponse,
          '200': {
            description: 'Catalog entry.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CatalogEntry' },
              },
            },
          },
          '401': errorResponse,
          '403': agentAuthForbidden,
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
      Delegation: {
        type: 'object',
        description:
          "One budget-delegation row (#828). start_date and expires_at are unix-second BIGINTs and arrive as digit STRINGS (node-postgres decodes int8 as string). The signed delegation object is never included here — the list is lifecycle metadata only.",
        required: [
          'id', 'chain_id', 'token_address', 'recipient_address', 'delegation_hash',
          'version', 'status', 'budget_atomic', 'period_seconds', 'start_date',
          'expires_at', 'created_at',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          chain_id: { type: 'integer' },
          token_address: { type: 'string', pattern: '^0x[0-9a-f]{40}$', description: 'Stored lowercase (table CHECK).' },
          recipient_address: {
            type: ['string', 'null'],
            pattern: '^0x[0-9a-f]{40}$',
            description: 'Lowercase recipient pin, or null for an open budget.',
          },
          delegation_hash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
          version: { type: 'integer' },
          status: { type: 'string', enum: ['pending', 'active', 'replaced', 'revoked'] },
          budget_atomic: { type: 'string', pattern: '^[0-9]+$' },
          period_seconds: { type: 'integer' },
          start_date: { type: 'string', pattern: '^[0-9]+$', description: 'Unix seconds as a string (BIGINT).' },
          expires_at: { type: 'string', pattern: '^[0-9]+$', description: 'Unix seconds as a string (BIGINT).' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      /**
       * #1446: an address-book label. `LIST_CONTACTS_FOR_USER_SQL` and both
       * RETURNING clauses in `infra/repositories/contacts.ts` select exactly
       * these five columns, so every one is required.
       */
      Contact: {
        type: 'object',
        required: ['id', 'name', 'address', 'created_at', 'updated_at'],
        properties: {
          id: uuid,
          name: { type: 'string' },
          address: address,
          created_at: isoDateTime,
          updated_at: isoDateTime,
        },
        additionalProperties: false,
      },
      CatalogEntry: {
        type: 'object',
        /**
         * #1445: `catalog.ts`'s `serialize()` emits every one of these keys on
         * every row — nullable ones as null, never absent. The old list named
         * only 8, so the generated type made the other 9 optional and the UI
         * had to defend against a shape the route does not produce.
         */
        required: [
          'id', 'name', 'description', 'category', 'resource_url', 'rail', 'protocol', 'status',
          'tool_name', 'tool_arguments', 'price_display', 'price_atomic', 'asset', 'network',
          'asset_transfer_methods', 'verified_at',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string' },
          resource_url: { type: 'string' },
          rail: { type: 'string', enum: ['x402', 'mpp'] },
          protocol: { type: 'string', enum: ['http', 'mcp'] },
          tool_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          tool_arguments: {
            anyOf: [
              { type: 'object', additionalProperties: true },
              { type: 'null' },
            ],
            description:
              'Suggested MCP tool arguments for this catalog item, when the row represents a specific product variant. Agents should pass this object unchanged to the pay tool arguments field after confirming the live merchant quote.',
          },
          price_display: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          price_atomic: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          asset: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          network: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          asset_transfer_methods: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description:
              'Comma-separated set of x402 assetTransferMethods the merchant advertises (e.g. "eip3009" or "eip3009,erc7710"). Null until the first successful x402 probe; MPP entries stay null.',
          },
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
          relayer: {
            type: 'array',
            description:
              'Cached per-chain relayer gas balance from the hourly scan. Never a live RPC read.',
            items: {
              type: 'object',
              required: ['chainId', 'address', 'balanceWei', 'low', 'checkedAt'],
              properties: {
                chainId: { type: 'integer' },
                address,
                balanceWei: { type: 'string' },
                low: { type: 'boolean' },
                checkedAt: isoDateTime,
              },
              additionalProperties: false,
            },
          },
          passport: {
            type: 'object',
            description:
              'L0 Agent Passport configuration state (#1151). Booleans plus the published ' +
              'issuer address only — never key material, never the schema UID. A chain in ' +
              '`issuance_only` anchors passports no merchant can verify.',
            required: ['verification', 'chains', 'unverifiableChainIds'],
            properties: {
              verification: {
                type: 'object',
                required: ['configured', 'issuer'],
                properties: {
                  configured: { type: 'boolean' },
                  issuer: { anyOf: [address, { type: 'null' }] },
                },
                additionalProperties: false,
              },
              chains: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['chainId', 'issuanceConfigured', 'verificationConfigured', 'state'],
                  properties: {
                    chainId: { type: 'integer' },
                    issuanceConfigured: { type: 'boolean' },
                    verificationConfigured: { type: 'boolean' },
                    state: {
                      type: 'string',
                      enum: ['ready', 'issuance_only', 'verification_only', 'unconfigured'],
                    },
                  },
                  additionalProperties: false,
                },
              },
              unverifiableChainIds: { type: 'array', items: { type: 'integer' } },
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
          /**
           * #1445: the connector reports this and the backend persists it
           * (`agent-connection-setup.ts`), but the schema omitted it — and this
           * schema is `additionalProperties: false`, so the spec actively
           * FORBADE a field the API sends. A strict generated client would have
           * rejected a valid response.
           */
          skill_installed: { type: 'boolean' },
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
          issue_passport: {
            type: 'boolean',
            description: 'Opt in to an L0 Agent Passport for the agent this setup creates. Default false.',
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
          passport_requested: {
            type: 'boolean',
            description: 'True when the setup opted in and its chain issues L0 passports.',
          },
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
      AgentConnectionConnectorStatus: {
        type: 'object',
        required: ['status', 'approved_budget'],
        properties: {
          status: { $ref: '#/components/schemas/AgentConnectionSetupState' },
          approved_budget: {
            // Non-null only once the setup is active — the summary the
            // connector celebrates with. Never spend authority.
            oneOf: [
              {
                type: 'object',
                required: ['token_symbol', 'token_address', 'amount', 'reset_period_min'],
                properties: {
                  token_symbol: { type: 'string' },
                  token_address: address,
                  amount: { type: 'string' },
                  reset_period_min: { type: 'integer' },
                },
                additionalProperties: false,
              },
              { type: 'null' },
            ],
          },
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
          /** 'delegator_hybrid' = delegation rail; frontends branch budget UX on it. */
          account_type: { type: ['string', 'null'] },
          api_key_prefix: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['active', 'paused', 'pending_approval', 'revoked'] },
          created_at: isoDateTime,
          /**
           * #1401: non-null when the agent is archived (soft removal — the row
           * and its full audit history remain; the agent leaves the primary
           * list client-side). Archiving requires status='revoked'.
           */
          archived_at: { anyOf: [isoDateTime, { type: 'null' }] },
          allowances: { type: 'array', items: { $ref: '#/components/schemas/AgentAllowance' } },
          /** Timestamp of the most recent MCP tool call from this agent. Null until first call. */
          mcp_last_seen_at: { anyOf: [isoDateTime, { type: 'null' }] },
          /**
           * True when open reconciliation events indicate stranded delegate
           * funds (#1445). Derived by the list and detail reads, so it is NOT
           * required: the creation response is built from the freshly inserted
           * row and omits it — a brand-new agent cannot have stranded funds.
           */
          has_stranded_funds: { type: 'boolean' },
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
      /**
       * #1445: lifted out of the inline `/agents/{id}/delegate-balance`
       * response so consumers can name it. An inline schema generates an
       * anonymous type, which is why the frontend hand-wrote this one instead
       * of importing it — identical shape, no behaviour change.
       */
      DelegateBalance: {
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
      CreateAgentResponse: {
        allOf: [
          { $ref: '#/components/schemas/Agent' },
          {
            type: 'object',
            required: ['api_key', 'passport_requested'],
            properties: {
              api_key: { type: 'string', pattern: '^sk_agent_' },
              /**
               * #1445: whether an Agent Passport attestation was requested for
               * this agent (#970). Always present on creation — false when the
               * caller did not opt in, or the chain has no passport support.
               * Governance metadata, never spend authority.
               */
              passport_requested: { type: 'boolean' },
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
          idempotency_key: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description:
              'Optional dedupe key (#1207): a retried request with the same key returns the first request\'s result (idempotent_replay: true) instead of minting a second transfer or approval. A key reused for a different transfer is a 409. Same contract as /machine-payments/send.',
          },
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
          mcpCallContext: {
            type: 'object',
            description:
              '#1307: the merchant MCP-tool call this quote was made against (haven_pay_mcp_tool). Persisted so GET /x402/{id}/merchant-call-context can rehydrate it at settle/complete time.',
            required: ['merchantUrl', 'toolName'],
            properties: {
              merchantUrl: { type: 'string', format: 'uri' },
              toolName: { type: 'string', minLength: 1 },
              arguments: { type: 'object', additionalProperties: true },
              mcpTransport: {
                type: 'object',
                required: ['handshakeRequired', 'source'],
                properties: {
                  handshakeRequired: { type: 'boolean' },
                  source: { type: 'string', enum: ['path', 'bazaar'] },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          paymentRequired: {
            type: 'object',
            description:
              '#1355: the merchant\'s full parsed 402 PaymentRequired (max 64KB serialized). Persisted so GET /x402/{id}/sign-context can re-serve it and a local signer needs only payment_id. Reporting material, not payment authority — the signer verifies whichever copy it uses against the Haven-signed expected context.',
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
      X402MerchantCallContext: {
        type: 'object',
        required: ['payment_id', 'merchant_url', 'tool_name'],
        properties: {
          payment_id: uuid,
          merchant_url: { type: 'string', format: 'uri' },
          tool_name: { type: 'string' },
          arguments: { type: 'object', additionalProperties: true },
          mcp_transport: {
            type: 'object',
            properties: {
              handshake_required: { type: 'boolean' },
              source: { type: 'string', enum: ['path', 'bazaar'] },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      X402SignablePayment: {
        allOf: [
          { $ref: '#/components/schemas/SignablePaymentIntent' },
          {
            type: 'object',
            required: ['x402_expected_auth'],
            properties: {
              chain_id: { type: 'integer' },
              safe_address: address,
              payer: address,
              token: { type: 'string' },
              amount: { type: 'string' },
              to: address,
              merchant_to: { anyOf: [address, { type: 'null' }] },
              resource_url: { type: 'string', format: 'uri' },
              x402_expected_auth: {
                type: 'object',
                required: ['version', 'message', 'signature', 'signer'],
                properties: {
                  version: { type: 'integer', enum: [1] },
                  message: {
                    type: 'string',
                    description: 'Haven-signed expected x402 context. Includes expiresAt when the funding window is time-bound.',
                  },
                  signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$' },
                  signer: address,
                },
                additionalProperties: false,
              },
              payment_required: {
                type: 'object',
                description:
                  '#1355: the stored 402 PaymentRequired, present on GET /x402/{id}/sign-context responses when it was persisted at authorize time. Lets the local signer build the merchant header from the context fetch alone.',
                additionalProperties: true,
              },
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
        required: ['id', 'name', 'status', 'safe_address', 'delegate_address', 'delegate_account_address', 'chain_id', 'execution_rail'],
        properties: {
          id: uuid,
          name: { type: 'string' },
          status: { type: 'string' },
          safe_address: address,
          delegate_address: address,
          /**
           * #1472: the counterfactual Hybrid account the signing EOA owns —
           * what an erc7710 merchant sees as the X-PAYMENT header's delegator
           * and may print as "payer". Derived per request; null on the legacy
           * rail, and null when the derivation fails (reconciliation metadata,
           * never authority).
           */
          delegate_account_address: { anyOf: [address, { type: 'null' }] },
          chain_id: { type: 'integer' },
          execution_rail: {
            type: 'string',
            enum: ['legacy', 'delegation'],
            description:
              'Which on-chain policy primitive gates this agent\'s spend (#1306): the legacy Safe ' +
              'AllowanceModule (import-only accounts) or the delegation rail\'s active budget ' +
              'delegations. Reporting only — the on-chain state is the real gate either way.',
          },
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
                    remaining_is_from_chain: {
                      type: 'boolean',
                      description:
                        'Delegation rail only (#1319, provenance for #1145\'s fallback): true when ' +
                        '`remaining` came from a live ERC20PeriodTransferEnforcer read, false when the ' +
                        'read failed and this is the fallback full configured budget. Absent on the ' +
                        'legacy AllowanceModule rail, which has no fallback concept. Reporting only — ' +
                        'the on-chain policy is the actual gate either way, this only says how fresh ' +
                        'this number is.',
                    },
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
          settlement_scheme: {
            type: ['string', 'null'],
            description:
              'Which settlement branch ran (eip3009 | erc7710), from the intent (#946). Null on legacy-rail receipts.',
          },
          budget_delegation_hash: {
            type: ['string', 'null'],
            description:
              'The metering budget delegation, uniform across schemes (#1059). Null on the legacy rail and on intents predating migration 053.',
          },
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
      SweepAuthorization: {
        type: 'object',
        description: 'EIP-3009 TransferWithAuthorization fields for a delegate → Safe USDC sweep.',
        required: ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce', 'token', 'chainId'],
        properties: {
          from: address,
          to: address,
          value: { type: 'string', description: 'Atomic USDC amount.' },
          validAfter: { type: 'string', description: 'Unix seconds the authorization becomes valid.' },
          validBefore: { type: 'string', description: 'Unix seconds the authorization expires.' },
          nonce: { type: 'string', description: '0x-prefixed 32-byte hex nonce.' },
          token: address,
          chainId: { type: 'integer', examples: [8453] },
        },
        additionalProperties: false,
      },
      SweepExpectedAuth: {
        type: 'object',
        description: 'Haven\'s binding over the sweep authorization context, verified by the edge signer.',
        required: ['version', 'message', 'signature', 'signer'],
        properties: {
          version: { type: 'integer', enum: [1] },
          message: { type: 'string' },
          signature: { type: 'string' },
          signer: address,
        },
        additionalProperties: false,
      },
      SweepPrepareResponse: {
        type: 'object',
        required: ['authorization', 'expected_auth', 'asset', 'amount', 'amount_atomic', 'chain_id'],
        properties: {
          authorization: { $ref: '#/components/schemas/SweepAuthorization' },
          expected_auth: { $ref: '#/components/schemas/SweepExpectedAuth' },
          asset: { type: 'string', examples: ['USDC'] },
          amount: { type: 'string' },
          amount_atomic: { type: 'string' },
          chain_id: { type: 'integer', examples: [8453] },
          sign_instructions: { type: 'string' },
        },
        additionalProperties: false,
      },
      SweepSubmitRequest: {
        type: 'object',
        required: ['authorization', 'signature'],
        properties: {
          authorization: { $ref: '#/components/schemas/SweepAuthorization' },
          signature: { type: 'string', description: 'Delegate EIP-712 signature over the authorization.' },
        },
        additionalProperties: false,
      },
      SweepSubmitResponse: {
        type: 'object',
        required: ['tx_hash', 'asset', 'amount', 'amount_atomic', 'from_address', 'to_address', 'chain_id', 'explorer_url'],
        properties: {
          tx_hash: { type: 'string' },
          asset: { type: 'string', examples: ['USDC'] },
          amount: { type: 'string' },
          amount_atomic: { type: 'string' },
          from_address: address,
          to_address: address,
          chain_id: { type: 'integer', examples: [8453] },
          explorer_url: { type: 'string' },
          idempotent_replay: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      TransactionBase: {
        description: 'Fields shared by every transaction representation. The per-Safe page items (`GET /transactions/{safeAddress}`) are exactly this shape; the aggregated feed adds Safe scope on top (`Transaction`).',
        type: 'object',
        required: ['hash', 'type', 'from', 'to', 'value', 'valueFormatted', 'asset', 'decimals', 'direction', 'timestamp', 'blockNumber', 'isError'],
        properties: {
          hash: { type: 'string' },
          type: { type: 'string', enum: ['native', 'erc20', 'internal'] },
          // Deliberately NOT the `address` helper: Safe Transaction Service
          // transfers with a null counterparty are emitted as '' (#984 spec
          // correction — the old pattern rejected real responses).
          from: { type: 'string', description: 'Counterparty address, or the empty string when the explorer reported none.' },
          to: { type: 'string', description: 'Counterparty address, or the empty string when the explorer reported none.' },
          value: { type: 'string' },
          valueFormatted: { type: 'string' },
          asset: { type: 'string', description: 'Token ticker where known; falls back to the raw contract address for unknown tokens.' },
          decimals: { type: 'integer' },
          direction: { type: 'string', enum: ['in', 'out'] },
          timestamp: { type: 'integer' },
          blockNumber: { type: 'integer', description: '0 for x402-synthesized rows with no on-chain receipt yet.' },
          isError: { type: 'boolean' },
          tokenAddress: address,
          tokenSymbol: { type: 'string' },
          source: { type: 'string', description: "Origin of the row. Known values: 'direct', 'x402', 'mpp_demo', 'mpp_crypto', 'spt', 'stripe_deposit'. Open set — new payment rails add values." },
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
          activityType: { type: 'string', enum: ['delegate_sweep'] },
          agentName: { type: 'string' },
          // #984 spec correction: emitted on every enriched row (string | null),
          // was missing while additionalProperties:false claimed completeness.
          amountSek: { type: ['string', 'null'] },
        },
      },
      Transaction: {
        description: 'Aggregated-feed transaction: the shared base plus Safe scope. Also used by the dashboard overview preview, which never populates the payment-enrichment fields.',
        allOf: [
          { $ref: '#/components/schemas/TransactionBase' },
          {
            type: 'object',
            required: ['chainId', 'safeId', 'safeAddress', 'safeName'],
            properties: {
              chainId: { type: 'integer' },
              safeId: uuid,
              safeAddress: address,
              safeName: { type: 'string' },
              agentId: uuid,
            },
          },
        ],
      },
      TransactionsPageResponse: {
        description: 'Per-Safe paginated transaction list (`GET /transactions/{safeAddress}`). Items carry no Safe scope — the Safe is the path parameter.',
        type: 'object',
        required: ['transactions', 'total', 'page', 'limit', 'pages'],
        properties: {
          transactions: { type: 'array', items: { $ref: '#/components/schemas/TransactionBase' } },
          total: { type: 'integer' },
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer' },
          pages: { type: 'integer', description: '0 when total is 0.' },
        },
        additionalProperties: false,
      },
      BalanceItem: {
        type: 'object',
        required: ['symbol', 'address', 'balance', 'formatted', 'decimals'],
        properties: {
          symbol: { type: 'string' },
          address: { type: ['string', 'null'], description: 'Token contract address; null for the chain-native token (exactly one entry).' },
          balance: { type: 'string', description: "Raw base units; '0' when the RPC lookup failed." },
          formatted: { type: 'string' },
          decimals: { type: 'integer' },
        },
        additionalProperties: false,
      },
      BalancesResponse: {
        type: 'object',
        required: ['balances'],
        properties: {
          balances: { type: 'array', items: { $ref: '#/components/schemas/BalanceItem' }, description: 'Native token first, then ERC-20s in registry order. Never empty.' },
        },
        additionalProperties: false,
      },
      PortfolioBreakdown: {
        type: 'object',
        required: ['symbol', 'balance', 'formatted', 'usdValue', 'eurValue'],
        properties: {
          symbol: { type: 'string' },
          balance: { type: 'string', description: "Raw base units; '0' on RPC failure." },
          formatted: { type: 'string' },
          usdValue: { type: 'number', description: '0 when the price feed failed.' },
          eurValue: { type: 'number' },
        },
        additionalProperties: false,
      },
      PortfolioResponse: {
        type: 'object',
        required: ['totalUsd', 'totalEur', 'breakdown'],
        properties: {
          totalUsd: { type: 'number' },
          totalEur: { type: 'number' },
          breakdown: { type: 'array', items: { $ref: '#/components/schemas/PortfolioBreakdown' } },
        },
        additionalProperties: false,
      },
      SafeDetails: {
        type: 'object',
        required: ['address', 'owners', 'threshold', 'nonce'],
        properties: {
          address: { type: 'string', description: 'Echoed back as supplied — not re-checksummed.' },
          owners: { type: 'array', items: address, description: 'Checksummed owner addresses from the contract.' },
          threshold: { type: 'integer' },
          nonce: { type: 'integer' },
        },
        additionalProperties: false,
      },
      TransactionFilterOptionsResponse: {
        type: 'object',
        required: ['safes', 'agents', 'tokens'],
        properties: {
          safes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'name', 'address', 'chainId'],
              properties: { id: uuid, name: { type: 'string' }, address, chainId: { type: 'integer' } },
              additionalProperties: false,
            },
          },
          agents: {
            type: 'array',
            description: 'ALL agents including revoked — unlike the dashboard preview.',
            items: {
              type: 'object',
              required: ['id', 'name', 'status'],
              properties: { id: uuid, name: { type: 'string' }, status: { type: 'string', enum: ['active', 'paused', 'pending_approval', 'revoked'] } },
              additionalProperties: false,
            },
          },
          tokens: {
            type: 'array',
            items: {
              type: 'object',
              required: ['key', 'symbol', 'address', 'chainId', 'isNative'],
              properties: {
                key: { type: 'string', description: "'<chainId>:native' or '<chainId>:<lowercased address>'." },
                symbol: { type: 'string' },
                address: { type: ['string', 'null'], description: 'null iff isNative.' },
                chainId: { type: 'integer' },
                isNative: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      DashboardAgentAllowance: {
        type: 'object',
        required: ['tokenSymbol', 'allowanceAmount', 'resetPeriodMin'],
        properties: {
          tokenSymbol: { type: 'string' },
          allowanceAmount: { type: 'string' },
          resetPeriodMin: { type: 'integer' },
        },
        additionalProperties: false,
      },
      DashboardAgentPreview: {
        type: 'object',
        required: ['id', 'name', 'status', 'safeId', 'safeName', 'safeChainId', 'allowances'],
        properties: {
          id: uuid,
          name: { type: 'string' },
          status: { type: 'string', enum: ['active', 'paused'], description: 'Revoked agents are excluded from the preview query.' },
          safeId: { type: ['string', 'null'], format: 'uuid' },
          safeName: { type: ['string', 'null'] },
          safeChainId: { type: ['integer', 'null'] },
          allowances: { type: 'array', items: { $ref: '#/components/schemas/DashboardAgentAllowance' } },
        },
        additionalProperties: false,
      },
      DashboardOverviewResponse: {
        type: 'object',
        required: ['totals', 'change', 'metrics', 'actionableApprovals', 'pendingApprovals', 'onboardingProgress', 'agents', 'transactions'],
        properties: {
          totals: {
            type: 'object',
            required: ['usd', 'eur'],
            properties: { usd: { type: 'number' }, eur: { type: 'number' } },
            additionalProperties: false,
          },
          change: {
            type: 'object',
            required: ['available', 'usdAmount', 'eurAmount', 'usdPercent', 'eurPercent'],
            properties: {
              available: { type: 'boolean', description: 'true iff a yesterday snapshot existed to diff against.' },
              usdAmount: { type: 'number' },
              eurAmount: { type: 'number' },
              usdPercent: { type: 'number', description: '0 when unavailable or the previous total was 0.' },
              eurPercent: { type: 'number' },
            },
            additionalProperties: false,
          },
          metrics: {
            type: 'object',
            required: ['connectedAgents', 'monthlyAgentSpendUsd', 'monthlyAgentSpendEur', 'successfulTransactions', 'activeAccounts'],
            properties: {
              connectedAgents: { type: 'integer', description: "Agents with status 'active' only." },
              monthlyAgentSpendUsd: { type: 'number' },
              monthlyAgentSpendEur: { type: 'number' },
              successfulTransactions: { type: 'integer' },
              activeAccounts: { type: 'integer', description: 'All linked Safes, regardless of activity.' },
            },
            additionalProperties: false,
          },
          actionableApprovals: { type: 'integer' },
          pendingApprovals: { type: 'integer', description: 'Duplicate of actionableApprovals (same query), kept for compatibility.' },
          onboardingProgress: {
            type: 'object',
            required: ['hasFirstAgentPayment'],
            properties: { hasFirstAgentPayment: { type: 'boolean' } },
            additionalProperties: false,
          },
          agents: { type: 'array', items: { $ref: '#/components/schemas/DashboardAgentPreview' }, description: 'At most 6.' },
          transactions: { type: 'array', items: { $ref: '#/components/schemas/Transaction' }, description: 'At most 5. Payment-enrichment fields (paymentId, paymentFlowStatus, amountSek, …) are never populated in this projection.' },
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
