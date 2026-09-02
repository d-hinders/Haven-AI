import {
  AgentPaymentNextAction,
  AgentPaymentNextActionDescriptions,
  AgentPaymentPhase,
  AgentPaymentPhaseDescriptions,
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

/**
 * ── The two allowance amount shapes (#2295) ──────────────────────────────────
 *
 * `allowance_amount` carries TWO incompatible wire shapes under one field name,
 * and for a long time nothing in the contract chain said which one a consumer
 * was getting. #2283 was the cost: `formatConfiguredAllowance` discriminated
 * between them BY EXCEPTION (`BigInt('250.000000')` throws, a bare `catch`
 * returned the string unformatted), and `/agents` shipped
 * `"250.000000 USDC per week"` to production.
 *
 * Both shapes are named schemas below so the split is readable from the spec
 * alone. The shapes themselves are DELIBERATELY unchanged — the human-decimal
 * projection is the historical `allowances` element shape that `GET /agents`,
 * `GET /agents/{id}`, `PUT /agents/{id}`, `GET /dashboard/overview` and the CLI have
 * always returned, so unifying it is a breaking wire change and a versioning
 * decision, not a cleanup (recorded on #2295).
 *
 * Who produces which, measured rather than assumed:
 *
 *   ATOMIC  (`allowanceAtomicAmount`) — the connect-setup budget REQUEST.
 *     Written by `POST /agent-connection-setups` and read back verbatim from
 *     `agent_connection_setup_allowances` by `GET /agent-connection-setups/*`
 *     (`routes/agent-connection-setups.ts` → `agent_budget[]`). Validated
 *     `^[0-9]+$` and uint96-capped on the way in.
 *
 *   HUMAN   (`allowanceHumanAmount`) — the delegation-rail budget PROJECTION.
 *     Every one of its emitters goes through `rails/delegation-budget-view.ts`,
 *     which builds the string with `formatTokenValue(row.budget_atomic,
 *     decimals)`. Since #2020 that view is the ONLY source of an `allowances`
 *     array — the `agent_allowances` mirror is read nowhere.
 *
 * Because that emitter is sole AND its output set is narrow, the human schema's
 * pattern DISCRIMINATES the two shapes for every value except `'0'` (#2408).
 * The shapes on the wire are still unchanged — what changed is that the
 * contract can now REJECT an atomic value in a human field instead of only
 * naming the two apart.
 */
const allowanceAtomicAmount = {
  type: 'string',
  pattern: '^[0-9]+$',
  // #2105: the uint96 cap is LIVE — only its stated reason had drifted to the
  // retired rail. It is now the delegation rail's ERC20PeriodTransferEnforcer
  // word size (`periodAmount`, see `modules/agents/rekey-carry.ts`), which is
  // the same width the AllowanceModule used. Constraint kept, reason corrected.
  description: 'ATOMIC token amount — an integer string in the token\'s smallest unit (25 USDC is "25000000"). Leading zeroes are accepted and canonicalized; effective amount must be positive and capped at uint96 — the word size of the delegation rail\'s ERC20PeriodTransferEnforcer. NOT interchangeable with the human-decimal shape the delegation-rail budget projection returns for the same field name — see AgentAllowance.allowance_amount (#2295).',
} as const

/**
 * The human-decimal counterpart, and the pattern DISCRIMINATES (#2408).
 *
 * `domain/tokens.ts`'s `formatTokenValue(raw, decimals)` — lines 33-49 — is the
 * sole emitter of this shape, and its output set is narrower than a bare
 * integer. It returns `'0'` for `''`/`'0'` and otherwise
 * `` `${intPart}.${capped}` ``, where `capped` is the fraction trailing-zero-
 * trimmed, then `padEnd(2, '0')`, then `slice(0, 6)` — so exactly one `.`
 * followed by 2-6 digits, for any `decimals >= 0`. The produced set is
 * therefore `^(0|[0-9]+\.[0-9]{2,6})$`, which REJECTS `'500'`, `'1000000'` and
 * every other atomic value except `'0'`.
 *
 * `'0'` is the one genuinely shared value, and it is genuinely identical in
 * both shapes, so nothing is lost by admitting it.
 *
 * This comment previously said the opposite — "a bare integer is legal here" —
 * and its own regex was looser still. That conflated "`'0'` is legal" with "any
 * integer is legal", and it cost a real hole: #2392 measured a view emitting
 * the atomic `budget_atomic` passing the `GET /dashboard/overview` round trip,
 * caught only by a hand-asserted `'1.00'` literal. The schema now catches it.
 *
 * What has NOT changed: a consumer still must not sniff the shape at runtime.
 * The discrimination here is a contract assertion over what one emitter is
 * known to produce, not a property of the string — `'0'` remains ambiguous,
 * and a future emitter that bypassed `formatTokenValue` would be a spec
 * violation rather than a new legal shape. The schema name stays the
 * discriminator; the pattern is now a guard that can catch the violation.
 *
 * The producing set is pinned in `openapi/spec.test.ts` against
 * `formatTokenValue` itself, so this claim is measured on every run rather
 * than trusted.
 */
const allowanceHumanAmount = {
  type: 'string',
  pattern: '^(0|[0-9]+\\.[0-9]{2,6})$',
  description: 'HUMAN-DECIMAL token amount — whole token units, NOT the atomic integer (25 USDC is "25.00", a zero budget is "0"). Projected from the agent\'s active delegation by rails/delegation-budget-view.ts via formatTokenValue(budget_atomic, decimals), whose output is always "0" or <integer>.<2–6 fraction digits> — so this pattern REJECTS an atomic value such as "500" (#2408). "0" is the one value both shapes share. Do not BigInt() this value: it is the shape that made #2283 a production bug. To compare it against an atomic price, scale it by the token\'s decimals first (#2295).',
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

/** The re-key ledger row a step belongs to (#1698). Scoped by agent id. */
const rekeyIdParam = {
  name: 'rekeyId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description: 'Re-key id from the preflight response.',
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
      enum: ['not_anchored', 'anchored', 're_anchoring', 'revocation_pending', 'revoked_onchain'],
      description: "The on-chain anchor's progress, for transparency. Never the authority. `re_anchoring` is the re-key window (#1699): the attestation on-chain is live but names the agent's RETIRED delegate key, because EAS attestations are immutable — the agent's standing is unaffected.",
    },
    evidenceUid: { type: ['string', 'null'] },
    chainId: { type: ['integer', 'null'] },
    controls: {
      oneOf: [
        {
          type: 'object',
          required: ['rail', 'policyEnforcedOnchain', 'treasuryBound'],
          properties: {
            rail: {
              type: 'string',
              enum: ['delegation', 'allowance_module', 'session_key'],
              description:
                "The account's execution rail, verbatim from user_safes. Only 'delegation' is live; " +
                "'allowance_module' (#1440) and 'session_key' (#834) are retired and cannot transact. " +
                'This field named a shorter, non-existent rail value until #2110 — one the column CHECK ' +
                'has never permitted.',
            },
            policyEnforcedOnchain: {
              type: 'boolean',
              description:
                'True only on the delegation rail, where the caveat enforcers revert an out-of-policy ' +
                'redemption on-chain. False on both retired rails: a legacy account may still hold a ' +
                'real on-chain allowance, but every agent payment entry point answers 410, so there is ' +
                'no spend for a contract to govern.',
            },
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


// ── Dashboard account building blocks (#1446) ────────────────────────────────

/** The FULL profile row — what the profile write returns. */
const userProfile = {
  type: 'object',
  required: ['id', 'name', 'email', 'wallet_address', 'safe_address', 'currency_preference', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: ['string', 'null'] },
    email: { type: 'string' },
    wallet_address: { type: ['string', 'null'], pattern: '^0x[0-9a-fA-F]{40}$' },
    safe_address: { type: ['string', 'null'], pattern: '^0x[0-9a-fA-F]{40}$' },
    currency_preference: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const

/**
 * The NARROWER projection the wallet and safe writes return — five fields, no
 * currency_preference and no created_at. Deliberately not the same shape as
 * the profile write, and documented as the difference it is.
 */
const userIdentity = {
  type: 'object',
  required: ['id', 'name', 'email', 'wallet_address', 'safe_address'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: ['string', 'null'] },
    email: { type: 'string' },
    wallet_address: { type: ['string', 'null'], pattern: '^0x[0-9a-fA-F]{40}$' },
    safe_address: { type: ['string', 'null'], pattern: '^0x[0-9a-fA-F]{40}$' },
  },
} as const


// ── Bookkeeping building blocks (#1446, epics #462/#491) ─────────────────────

/** One reporting-feed sync row, as the status route returns it. */
const feedSyncRow = {
  type: 'object',
  required: ['id', 'user_id', 'provider', 'payment_id', 'external_ref', 'status', 'error', 'attempts', 'created_at', 'updated_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    user_id: { type: 'string', format: 'uuid' },
    provider: { type: 'string', examples: ['fortnox'] },
    payment_id: { type: 'string' },
    external_ref: { type: ['string', 'null'], description: 'The provider-side reference once pushed.' },
    status: { type: 'string', enum: ['pending', 'pushed', 'failed', 'skipped'] },
    error: { type: ['string', 'null'] },
    attempts: { type: 'integer' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const

/**
 * The read-back verdict from the provider's OWN records (#1362). Strictly
 * read-only: it asserts nothing and cannot modify an invoice.
 */
const invoiceVerification = {
  type: 'object',
  required: ['registered', 'missing', 'booked', 'cancelled', 'invoice_number', 'voucher', 'invoice_date', 'total', 'checked_at'],
  properties: {
    registered: { type: 'boolean', description: 'The invoice exists in Fortnox under our external_ref.' },
    missing: {
      type: ['string', 'null'],
      enum: ['deleted', 'foreign_invoice', null],
      description:
        "Why registered is false. 'deleted' = the number 404s; 'foreign_invoice' = an invoice exists at that number but carries someone else's ExternalInvoiceNumber (a company-switch collision). Null when registered. Both mean OUR record was never delivered under our ref — but an audit trail must not say \'no longer exists\' about an invoice that does.",
    },
    booked: { type: ['boolean', 'null'], description: 'A human has booked it. Null when not registered.' },
    cancelled: { type: ['boolean', 'null'], description: 'Registered but struck. Null when not registered.' },
    invoice_number: { type: 'integer' },
    voucher: { type: ['string', 'null'], description: '`<series><number> <year>` once booked, e.g. "A123 2026". Null until then.' },
    invoice_date: { type: ['string', 'null'] },
    total: { type: ['number', 'null'] },
    checked_at: { type: 'string', format: 'date-time' },
  },
} as const


// ── Session building blocks (#1446) ──────────────────────────────────────────

/**
 * A Safe as the session payloads carry it. sessionSafePayload STRIPS
 * owner_address and passkey_count — the raw signer inputs — and replaces them
 * with the two derived answers the UI actually needs.
 */
const sessionSafe = {
  type: 'object',
  required: [
    'id', 'safe_address', 'chain_id', 'name', 'is_default', 'created_at',
    'account_type', 'value_bearing_chain', 'needs_backup_recommendation',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    safe_address: address,
    chain_id: { type: 'integer' },
    name: { type: 'string' },
    is_default: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
    account_type: { type: ['string', 'null'] },
    value_bearing_chain: { type: 'boolean', description: 'Derived from the chain — is real value at stake here.' },
    needs_backup_recommendation: {
      type: ['boolean', 'null'],
      description:
        'Delegation-rail accounts only (null otherwise): whether to RECOMMEND a backup signer. A recommendation, never a gate (#1153) — nothing refuses a single-signer account.',
    },
  },
} as const

/** The user object every session response carries. */
const sessionUser = {
  type: 'object',
  required: ['id', 'name', 'email', 'wallet_address', 'safe_address', 'currency_preference', 'safes'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: ['string', 'null'] },
    email: { type: 'string' },
    wallet_address: { type: ['string', 'null'] },
    safe_address: { type: ['string', 'null'] },
    currency_preference: { type: 'string' },
    safes: { type: 'array', items: sessionSafe },
  },
} as const


// ── Activity-feed building blocks (#1446) ────────────────────────────────────

/**
 * One payment in an activity list. `explorer_url` and the two lifecycle
 * fields (payment_flow_status, payment_attention_reason) are DERIVED at read
 * time — the first from the chain registry, the others from the
 * machine-payment lifecycle helper — so a client never has to re-derive them.
 */
const activityPayment = {
  type: 'object',
  required: ['type', 'id', 'token', 'amount', 'to', 'status', 'created_at'],
  properties: {
    type: { type: 'string', enum: ['payment'] },
    id: { type: 'string' },
    token: { type: ['string', 'null'] },
    amount_raw: { type: ['string', 'null'] },
    amount: { type: ['string', 'null'] },
    to: { type: ['string', 'null'] },
    status: { type: ['string', 'null'] },
    tx_hash: { type: ['string', 'null'] },
    payment_id: { type: 'string' },
    payment_proof_status: { type: ['string', 'null'] },
    payment_flow_status: { type: ['string', 'null'], description: 'Derived from the payment lifecycle.' },
    payment_attention_reason: { type: ['string', 'null'], description: 'Derived: why this payment needs a human look, if it does.' },
    source: { type: 'string', description: "Falls back to 'direct'." },
    x402_resource_url: { type: ['string', 'null'] },
    x402_merchant_address: { type: ['string', 'null'] },
    chain_id: { type: ['integer', 'null'] },
    token_address: { type: ['string', 'null'] },
    safe_id: { type: ['string', 'null'] },
    safe_address: { type: ['string', 'null'] },
    safe_name: { type: ['string', 'null'] },
    explorer_url: { type: ['string', 'null'], description: 'Null exactly when tx_hash is null.' },
    execution_rail: { type: ['string', 'null'], description: 'Which on-chain mechanism moved the money (#799).' },
    delegation_hash: { type: ['string', 'null'], description: 'Which delegation authorized a delegation-rail payment (#829).' },
    confirmed_at: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    agent_id: { type: 'string', description: 'Feed only — the per-agent list already knows the agent.' },
    agent_name: { type: 'string', description: "Feed only; 'Unknown' when the agent row is gone." },
  },
} as const

/** One MCP tool call — the agent-facing audit log entry. */
const activityToolCall = {
  type: 'object',
  required: ['type', 'id', 'tool_name', 'created_at'],
  properties: {
    type: { type: 'string', enum: ['mcp_tool_call'] },
    id: { type: 'string' },
    tool_name: { type: 'string' },
    payment_id: { type: ['string', 'null'], description: 'Set when the call created or advanced a payment.' },
    result_status: { type: ['string', 'null'] },
    next_action: { type: ['string', 'null'] },
    error_code: { type: ['string', 'null'] },
    status_code: { type: ['integer', 'null'] },
    created_at: { type: 'string' },
    agent_id: { type: 'string', description: 'Feed only.' },
    agent_name: { type: 'string', description: 'Feed only.' },
  },
} as const

/** The heterogeneous activity entry, discriminated by `type`. */
// #2055: `activityApproval` is REMOVED from this union, not deprecated in it.
// The approval-request feed entries died with the `approval_requests` table —
// `routes/agent-activity.ts` merges payments and MCP tool invocations and has
// no third source, so a documented `type: 'approval'` branch described a
// response shape the route cannot emit. #2120 already deleted the fabricated
// `type: 'approval'` FIXTURE for this reason; the schema it was fixed against
// was not touched then (#2262). Kept out of the union rather than tombstoned
// inside it: a `oneOf` member is a promise to a code generator, and
// `packages/core/src/api-types.ts` mirrors it into the frontend's
// `ApiSchema<>` imports.
const activityEntry = { oneOf: [activityPayment, activityToolCall] } as const

/** Per-token spend totals, as the stats route shapes them. */
const spendTotals = {
  type: 'array',
  items: {
    type: 'object',
    required: ['token', 'total_spent', 'tx_count'],
    properties: {
      token: { type: ['string', 'null'] },
      total_spent: { type: ['string', 'null'] },
      tx_count: { type: 'integer' },
    },
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

/**
 * The signing handoff on the 201 of `POST /payments` — and, through
 * `X402SignablePayment`, on the x402 authorize 200/201.
 *
 * #2105 (found by review): this described the RETIRED AllowanceModule signing
 * scheme, on the live rail's primary success response. It required
 * `components.{safe, payment_token, payment, nonce}` — the
 * `executeAllowanceTransfer` argument list — was `additionalProperties: false`,
 * and therefore actively FORBADE the `signature_scheme` and `typed_data` that
 * the live handlers emit (`routes/payments.ts` 201, and
 * `modules/x402/delegation-authorize.ts`). An integrator following it would
 * sign a bare hash with raw ECDSA and look for a nonce that is not there.
 *
 * What the two live emitters actually send: `hash` + `signature_scheme:
 * 'eip712_userop'` + `typed_data` (the payload the account validates verbatim —
 * NEVER the bare 4337 hash, the #829 lesson) + `components` + `instructions`.
 * `components` carries `account`/`token`/`to`/`amount` on the direct-payment
 * path and additionally `safe` on the x402 funding path, which is why the
 * required set is their intersection while both fields are declared.
 *
 * One shape this schema deliberately does NOT admit: `replayIntentBody`'s
 * legacy fall-through in `routes/payments.ts` still builds the old
 * `sign_hash` + `{safe, payment_token, payment, nonce}` body for an intent
 * whose `execution_rail` is not `delegation`. It is unreachable — the only
 * live insert (`insertDelegationIntent`, at the one call site in POST
 * /payments) pins `executionRail: 'delegation'` AND a `preparedUserOp`, the
 * retired-rail gate returns before the replay lookup, and the lookup itself
 * requires a still-`pending_signature`, unexpired row. Reaching it needs a
 * pre-#1986 row that outlived the intent TTL. Documenting the live shape
 * strictly is the right trade: the alternative is widening the contract of
 * the only rail that can pay to accommodate a row that cannot exist.
 */
const paymentSignData = {
  type: 'object',
  required: ['hash', 'signature_scheme', 'typed_data', 'components', 'instructions'],
  properties: {
    hash: {
      type: 'string',
      pattern: '^0x[0-9a-fA-F]{64}$',
      description:
        'The UserOperation hash. Present for reference and replay-matching — do NOT sign it ' +
        'directly; sign `typed_data`.',
    },
    signature_scheme: {
      type: 'string',
      enum: ['eip712_userop'],
      description:
        'The delegation rail\'s only scheme. The retired AllowanceModule rail\'s raw-ECDSA-over-' +
        '`hash` scheme died with it (#1986) and is not offered here.',
    },
    typed_data: {
      type: 'object',
      additionalProperties: true,
      description:
        'The EIP-712 payload to sign VERBATIM with the delegate key. The account validates this, ' +
        'not `hash`.',
    },
    components: {
      type: 'object',
      required: ['token', 'to', 'amount'],
      properties: {
        account: { ...address, description: 'The delegator account the UserOperation runs on.' },
        safe: { ...address, description: 'Present on the x402 funding shape only.' },
        token: address,
        to: address,
        amount: { type: 'string', description: 'Atomic token amount.' },
      },
      // CLOSED, and deliberately: both live emitters produce exactly the five
      // fields declared above, so `additionalProperties: true` bought nothing
      // and cost `expectMatchesSpec` its teeth on this object (a schema that
      // opts into `true` keeps it, and an undeclared field then passes).
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
    kind: {
      type: 'string',
      enum: ['payment_intent', 'approval_request'],
      description:
        'Always `payment_intent` in practice. `approval_request` is kept for wire compatibility ' +
        'in the #2055 style: the approval queue died with the Safe rail and `approval_requests` ' +
        'was dropped (migration 070), so no payment can resolve to that kind any more — but the ' +
        'value stays declared because the backend\'s own status type still carries it and this ' +
        'route still serializes the field. Do not write a branch on it.',
    },
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

// #2105: `X402PendingApproval` left this union with the 202 that carried it.
// A `oneOf` member is a branch an integrator writes code for, so an
// unreachable member is not a harmless leftover — it is an instruction.
const x402AuthorizeResponse = {
  oneOf: [
    { $ref: '#/components/schemas/X402SignablePayment' },
    { $ref: '#/components/schemas/X402ConfirmedPayment' },
    { $ref: '#/components/schemas/AgentPaymentStatus' },
  ],
} as const

// #2105: this string is attached to every AGENT-AUTHENTICATED operation — 26 of
// the document's 134 — so the primitive it names is the one an integrator
// building against the agent API reads first. It named "on-chain
// Safe module state" — the retired AllowanceModule (#1986). The live
// enforcement primitive is the agent's owner-signed budget delegation, enforced
// by the DelegationManager's audited caveat enforcers at redemption. The
// three-way identity/authority/enforcement split is unchanged; only the
// primitive holding the third term moved.
const bearerIdentityDescription =
  'Agent API keys identify the calling Haven agent only. API auth is identity; signature is authority; the on-chain budget delegation — its caveat enforcers, checked by the DelegationManager at redemption — is enforcement. API keys alone cannot move funds or authorize payment execution.'

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
        'Agent-side x402 payment authorization for independently signed payment payloads. Haven never receives the agent delegate private key and never treats an API key as payment authority.',
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
          'Creates the API identity for an agent — identity and credential only. Payment authority arrives separately as an owner-signed budget delegation, enforced on-chain (#1440/#2020: the per-token allowance mirror is retired; the response’s `allowances` is always empty at creation).',
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
      put: {
        tags: ['Agents'],
        operationId: 'updateAgent',
        summary: "Rename an agent or change its description.",
        description: 'Display metadata only — it changes no authority, no allowance and no key. The response carries the agent with its current allowances so a client can re-render without a second call.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Trimmed.' },
                  description: { type: 'string', description: 'Trimmed.' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            // #2400: was `{ type: 'object', additionalProperties: true }`, an
            // open envelope a round trip could only prove "is an object"
            // against. The route returns `{ ...updated, allowances }` — the
            // same shape as GET /agents/{id} — so it gets the same schema.
            description: 'The updated agent, with allowances.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Agent' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
        },
      },
      delete: {
        tags: ['Agents'],
        operationId: 'deleteAgent',
        summary: 'RETIRED — always answers 410. Archive instead.',
        description:
          "Deleting an agent is retired (#1401) and this route is a tombstone: **it always answers 410 and writes nothing.** Hard deletion failed outright on any agent with payment history (a foreign-key violation surfacing as a 500) and, where it did succeed, cascaded away seven tables of money-path audit trail. Removal is now an ARCHIVE that keeps the history: revoke the agent, kill its budgets, then POST /agents/{id}/archive. The typed route survives for reversibility, in the same spirit as the session-rail retirement.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          '410': { ...errorResponse, description: 'Always. The message names the archive route to use instead.' },
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
        summary: 'Archive an agent (soft removal — history is kept).',
        description:
          'Replaces agent deletion (#1401). Delegation agents require status=revoked and no pending or active budget delegations because archiving is a filing action and never the thing that stops spending. Linked legacy Safe records may be archived at any status; that only removes the Haven-side record and leaves the old Safe permission untouched. An agent whose Safe was already unlinked is archivable when no live delegation remains. The agent row and every dependent audit row (payments, approvals, evidence, delegations, passports) remain; the agent leaves the primary list. Idempotent: re-archiving keeps the original archived_at.',
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
          'Clears archived_at and nothing else — the agent keeps the status it had when archived. For delegation agents, the archive contract requires revoked status and no live budgets; legacy Safe records can return with their prior active, paused, pending_approval, or revoked status. Un-archiving restores no authority of any kind. Idempotent on a non-archived agent.',
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
          '409': { ...errorResponse, description: 'Revoked agents cannot receive a new budget delegation; other delegation-account conflicts also return 409.' },
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
          '409': { ...errorResponse, description: 'Revoked agents cannot activate a new budget delegation; non-pending delegation and account conflicts also return 409.' },
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
    // ── Re-key (#1698, epic #1694) ────────────────────────────────────────
    // Owner-authorised credential rotation. Ordering is a hard invariant:
    // revoke precedes issue, and the meter is read AFTER the revoke.
    '/agents/{id}/rekey': {
      post: {
        tags: ['Delegations'],
        operationId: 'startAgentRekey',
        summary: 'Re-key step 0: preflight — residual check, and open the re-key (#1698).',
        description:
          "Opens an owner-authorised re-key: same agent identity, new delegate key, new API key, old authority revoked. Delegation rail only — a legacy AllowanceModule account is refused 409 with re-onboarding named as the path. An agent API key is refused 403: an agent can never re-key itself. new_delegate_address is the PUBLIC address of a keypair generated on the target machine; Haven never receives the private half. Preflight reads the residual balance on the OLD delegate EOA and refuses 409 on a non-zero one until residual_disposition says what happened to it, because sweeping needs the old key's signature and after the rotation that balance is unrecoverable. A failed balance read is 503 rather than a shrug.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['new_delegate_address'],
                properties: {
                  new_delegate_address: {
                    ...address,
                    description:
                      'PUBLIC address of the new delegate keypair, generated locally. Must differ from the current delegate and must not collide with another live agent.',
                  },
                  residual_disposition: {
                    type: 'string',
                    enum: ['swept', 'acknowledged_unrecoverable'],
                    description:
                      'Required only when the old delegate EOA holds a non-zero balance. "swept" after sweeping it with the old key; "acknowledged_unrecoverable" to proceed knowing the key is lost and the balance is written off.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Re-key opened at stage preflight.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AgentRekeyPreflight' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': {
            ...errorResponse,
            description: 'An agent credential was presented — an agent can never re-key itself.',
          },
          '404': errorResponse,
          '409': {
            ...errorResponse,
            description:
              'Not on the delegation rail, a re-key already in flight (the body names its rekey_id, stage and the new_delegate_address it is bound to, #1868), a colliding delegate address, or an undispositioned residual balance.',
          },
          '503': {
            ...errorResponse,
            description:
              'The residual balance read failed; proceeding would retire the only key that could sweep it.',
          },
        },
      },
    },
    '/agents/{id}/rekey/{rekeyId}/revoke': {
      post: {
        tags: ['Delegations'],
        operationId: 'prepareRekeyRevocation',
        summary: 'Re-key step 1a: prepare the batched revoke of every live delegation (#1698).',
        description:
          'Revoke comes FIRST, always. If the revoke lands and the issue does not, the agent has no authority — recoverable, and the correct posture when a key is lost. The reverse ordering would leave two simultaneously live keys. The response branches on the signature scheme, exactly as the per-hash and batch delegation revokes do: an EOA owner signs EIP-712 typed data (signing_payload); a passkey signs the userOpHash via WebAuthn (user_op_hash). A multi-signer account (EOA owner AND enrolled passkeys) picks per request with signature_scheme — without it the server would infer the owner path and estimate verification gas for a 65-byte signature the device may not be able to produce (#1870). An agent with no live delegations short-circuits: nothing to revoke, so the re-key advances straight to the metered stage — inheriting an abandoned predecessor’s frozen carry when one qualifies (#1868), otherwise with an empty carry.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }, rekeyIdParam],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: signatureSchemeBody } },
        },
        responses: {
          '200': {
            description: 'Prepared revocation, shaped by the signature scheme — or the no-authority short-circuit.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AgentRekeyRevokePrepare' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': {
            ...errorResponse,
            description:
              'Wrong stage — this re-key is past the revoke; the account signer configuration is unknown; or the requested signature_scheme is one this account cannot sign. Every one of these lands BEFORE the revoke, so the re-key stays retryable (#1868).',
          },
          '502': errorResponse,
        },
      },
    },
    '/agents/{id}/rekey/{rekeyId}/revoke/submit': {
      post: {
        tags: ['Delegations'],
        operationId: 'submitRekeyRevocation',
        summary: 'Re-key steps 1b + 2: land the revoke, THEN read the now-frozen meter (#1698).',
        description:
          "Submits the owner-signed disableDelegation UserOp and, only once it has landed, reads each revoked delegation's remaining period budget and boundary into a frozen carry snapshot. The ordering is the point: reading before the revoke leaves a window in which a payment lands and the carried remainder over-counts it by that amount; after the revoke the on-chain state cannot move. It is safe because the revoke writes to the DelegationManager while the meter is read from the ERC20PeriodTransferEnforcer — two different contracts, and the read consults nothing the revoke writes. On a failed submit nothing is written and the old key is still live, so a retry is safe.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }, rekeyIdParam],
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
                  delegation_hashes: { type: 'array', items: delegationHash },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description:
              'Revoked on-chain and metered. The agent now has NO authority until the issue step completes.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['revoked', 'stage', 'agent_has_no_authority'],
                  properties: {
                    revoked: { type: 'boolean' },
                    tx_hash: { type: 'string', nullable: true },
                    delegation_hashes: { type: 'array', items: delegationHash },
                    stage: { type: 'string', enum: ['metered'] },
                    carry: {
                      type: 'array',
                      description: 'The frozen measurement, one entry per revoked delegation.',
                      items: {
                        type: 'object',
                        properties: {
                          delegation_hash: delegationHash,
                          remaining_atomic: { type: 'string' },
                          from_chain: {
                            type: 'boolean',
                            description:
                              'False means the read fell back to the full budget. The carry REFUSES these rather than granting a fresh full period.',
                          },
                        },
                      },
                    },
                    agent_has_no_authority: { type: 'boolean' },
                    next_step: { type: 'string' },
                  },
                },
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
    '/agents/{id}/rekey/{rekeyId}/issue': {
      post: {
        tags: ['Delegations'],
        operationId: 'issueRekeyDelegations',
        summary: 'Re-key step 3: build the carried delegations for the new delegate (#1698).',
        description:
          'Refuses unless the re-key is at stage "metered" — which is only reachable through the revoke, so issue-before-revoke is forbidden structurally rather than by convention. Each replaced budget yields up to two grants: a "carry" capped at the frozen remainder and EXPIRING at the old period boundary, and a paired "steady" carrying the original budget and cadence starting at that same instant. The two never overlap, so no re-key can shorten a period or grant more than the original budget within one. Returns EIP-712 payloads for the owner to sign.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }, rekeyIdParam],
        responses: {
          '201': {
            description: 'Replacement delegations built, pending the owner signature.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AgentRekeyIssueResponse' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': {
            ...errorResponse,
            description:
              'Wrong stage (issue may never precede the revoke), or the carry was refused because the meter read did not come from the chain.',
          },
          '502': errorResponse,
        },
      },
    },
    '/agents/{id}/rekey/{rekeyId}/complete': {
      post: {
        tags: ['Delegations'],
        operationId: 'completeAgentRekey',
        summary:
          'Re-key steps 4 + 5: activate, rotate BOTH credentials, invalidate old-payer intents (#1698).',
        description:
          "Activates every signed replacement delegation and, in the same transaction, swaps the agent's delegate address AND mints a new API key — one operation retires the whole old credential set, because a stale API key is its own hazard (#1681 finding A). Every unexecuted intent stamped with the old payer is expired in that same transaction; #1690's signer-side payer guard is a backstop, not the primary defence. The new API key is returned ONCE, to the authenticated owner.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }, rekeyIdParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['signatures'],
                properties: {
                  signatures: {
                    type: 'array',
                    description:
                      'One entry per delegation from the issue step. Every one must be signed — a partial completion would rotate credentials while some replacement authority stayed unsigned.',
                    items: {
                      type: 'object',
                      required: ['delegation_hash', 'signature'],
                      properties: {
                        delegation_hash: delegationHash,
                        signature: hexBytes,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Re-key complete. The old API key stops authenticating immediately.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AgentRekeyCompleteResponse' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/agents/{id}/rekey/{rekeyId}/abandon': {
      post: {
        tags: ['Delegations'],
        operationId: 'abandonAgentRekey',
        summary:
          'Record a stopped re-key, and say plainly if it left the agent without authority (#1698).',
        description:
          'Recorded, not deleted: an abandoned re-key that got past the revoke left the agent with no authority, and the dashboard has to be able to say so rather than letting it read as a mysterious 403.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }, rekeyIdParam],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { reason: { type: 'string' } } },
            },
          },
        },
        responses: {
          '200': {
            description: 'Re-key abandoned.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['abandoned', 'stage', 'agent_has_no_authority'],
                  properties: {
                    abandoned: { type: 'boolean' },
                    stage: { type: 'string', enum: ['abandoned'] },
                    agent_has_no_authority: { type: 'boolean' },
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
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
            description: 'The signer set. Same shape as the account-scoped read (#1679).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HybridAccountSigners' },
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
                          enum: ['not_anchored', 'anchored', 're_anchoring', 'revocation_pending', 'revoked_onchain'],
                          description: "Describes the chain, for transparency — not for deciding. `re_anchoring` means a re-key rotated the delegate key and the attestation naming the old one is being retired and reissued (#1699); standing is unaffected.",
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
          "Owner action, never agent-authenticated: an agent must not be able to issue itself a credential. Records the request synchronously and returns **202** — the EAS write is fire-and-forget, so poll the GET (or the public verifier) for the anchored state. Idempotent: an already-anchored passport returns **200** with `already_issued: true` rather than minting a second attestation. Refusals are shaped by whose problem it is — a revoked agent is a 409 (terminal, and anchoring now would spend gas on an attestation that must be revoked immediately), an account on a RETIRED rail is also a 409 (#2138: passports are issued on the delegation rail only, because a rail that cannot transact has no spending for a contract to govern), an unbound or unsupported chain is a 400, and a deployment that has not configured issuance is a 503, because that is the operator's gap and not the caller's mistake. The rail refusal is ordered AFTER the idempotency check, so a passport already anchored on a legacy account still returns 200 — existing passports are left alone rather than revoked. A PAUSED agent is deliberately not blocked: pausing is reversible and `standing` already reports it as suspended.",
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
          '409': {
            ...errorResponse,
            description:
              'Agent is revoked (terminal), or its account is on a retired rail — passports are issued on the delegation rail only (#2138).',
          },
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
    // CUSTODY BOUNDARY: Haven labels a linked Safe and nothing more. It never
    // signed an owner change and, since #1988, no longer constructs one
    // either. Membership truth was always on-chain (getOwners()). A user who
    // deletes a Safe from Haven still owns it on-chain, and manages its owners
    // with their own key wherever they like — which is the property that makes
    // removing Haven's owner-change builder a narrowing rather than a loss.
    //
    // RETIRED SURFACE (#1440, owner decision 2026-08-14: the Safe rail goes
    // away entirely). Four plain-CRUD operations survive — list, rename,
    // set-default, unlink — because `user_safes` is shared with the delegation
    // rail. `deploy` and the import POST are TOMBSTONES: registered, answering
    // 410, with no implementation behind them since #1988. Every approver
    // route is deleted outright. Documented anyway, deliberately: the spec
    // describes the API that exists TODAY, and a 410 a client can still reach
    // is part of that API.
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
        summary: 'RETIRED — always answers 410. Importing a Safe is closed.',
        description:
          '**RETIRED (#1984, epic #1440) — always answers 410 and writes nothing.** The Safe rail is being retired outright, and importing is one of the four ways a Safe could enter Haven; all four are closed. The refusal is a route preHandler, so it precedes every read and write. The route is kept as a compatibility tombstone rather than removed — a 410 tells an old client the flow is permanently gone, where a 404 reads as a transient routing error and invites retries (the #834 session-rail / #1328 mpp_demo pattern); the route itself goes in deletion slice #1988. Create a Haven account on the delegation rail instead (POST /accounts/hybrid). Existing linked Safes are unaffected: GET /user/safes, rename, re-default, unlink and every read path behave exactly as before. Historically this was registration only — it moved nothing on-chain and granted Haven no authority over the Safe.',
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
          '401': errorResponse,
          '410': { ...errorResponse, description: 'Always. The Safe rail is retired; the message names POST /accounts/hybrid.' },
        },
      },
    },
    '/user/safes/deploy': {
      post: {
        tags: ['Dashboard'],
        operationId: 'deployUserSafe',
        summary: 'RETIRED — always answers 410. Haven no longer deploys Safes.',
        description:
          '**RETIRED (#1984, epic #1440) — always answers 410 and spends no relayer gas.** The refusal is a route preHandler, so it precedes the relayer entirely. Kept as a compatibility tombstone; removed in deletion slice #1988. Create a Haven account on the delegation rail instead (POST /accounts/hybrid). Historically the relayer sponsored the deployment and returned the deployed address plus the transaction hash, and owner_address was NOT checked against the caller — an unbounded-by-ownership relayer-gas surface that this retirement closes as a side effect.',
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
          '401': errorResponse,
          '410': { ...errorResponse, description: 'Always. The Safe rail is retired; the message names POST /accounts/hybrid.' },
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
          'Removes the link and its Haven-side metadata. **The Safe itself is untouched on-chain** — the user still owns it and can re-link it later. Unlinking the default Safe promotes another one. Unlinking is refused while an agent has a pending or active budget delegation, an in-flight recovery, or an in-flight re-key.',
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
          '409': {
            ...errorResponse,
            description: 'The Safe remains linked while a delegation, recovery, or re-key is in progress.',
          },
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
    // The approver routes that lived here — GET /user/safes/known-approvers,
    // GET|POST /user/safes/{safeId}/approvers, POST
    // /user/safes/{safeId}/approvers/tx and DELETE
    // /user/safes/{safeId}/approvers/{address} — are DELETED (#1988, epic
    // #1440 slice 5), exactly as the caveat above said they would be. They are
    // gone from the router too, so these are not tombstones: the paths 404.
    // ── Dashboard account + owner directory (#1446) ─────────────────────────
    // Profile/preference writes are the user's own record. The owner
    // directory reads Safe owners LIVE from every linked account, so it is
    // Safe-rail-shaped and inherits the #1440 retirement caveat recorded on
    // the /user/safes block: an alias is decoration over on-chain membership,
    // never a grant.
    '/user/profile': {
      put: {
        tags: ['Dashboard'],
        operationId: 'updateUserProfile',
        summary: "Rename the caller's own account.",
        description: 'Returns the FULL profile row (including currency_preference and created_at) — a wider shape than the wallet and safe writes below.',
        security: [{ DashboardJwt: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', minLength: 1, maxLength: 80, description: 'Trimmed; blank or over 80 characters is a 400.' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'The updated profile.', content: { 'application/json': { schema: userProfile } } },
          '400': errorResponse,
          '401': errorResponse,
          '404': { ...errorResponse, description: 'The account was deleted while a valid token for it was still in flight.' },
        },
      },
    },
    '/user/wallet': {
      put: {
        tags: ['Dashboard'],
        operationId: 'updateUserWallet',
        summary: "Record the caller's connected wallet address.",
        description: 'Bookkeeping only: recording an address grants Haven nothing and moves nothing. Returns the narrower five-field identity projection, not the full profile.',
        security: [{ DashboardJwt: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['wallet_address'],
                properties: { wallet_address: address },
              },
            },
          },
        },
        responses: {
          '200': { description: 'The updated identity projection.', content: { 'application/json': { schema: userIdentity } } },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/user/safe': {
      put: {
        tags: ['Dashboard'],
        operationId: 'updateUserSafe',
        summary: 'RETIRED — always answers 410. This link is an import.',
        description:
          "**RETIRED (#1984, epic #1440) — always answers 410 and writes nothing.** This route wrote the legacy users.safe_address column AND linked the Safe into user_safes as the default, emitting the `safe_imported` funnel event: it is an IMPORT, so it retires with the rail. It is named here explicitly because no shipped client calls it, which is exactly what would have made it the hole left open. Kept as a compatibility tombstone; create a Haven account on the delegation rail instead (POST /accounts/hybrid).",
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
                  chain_id: { type: 'integer', description: 'Defaults to DEFAULT_CHAIN_ID (Base).' },
                },
              },
            },
          },
        },
        responses: {
          '401': errorResponse,
          '410': { ...errorResponse, description: 'Always. The Safe rail is retired; the message names POST /accounts/hybrid.' },
        },
      },
    },
    '/user/preferences': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getUserPreferences',
        summary: "Read the caller's display-currency preference.",
        description: "Defaults to 'USD' when the account has never set one — a value, not an absence.",
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'The current preference.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['currency_preference'],
                  properties: { currency_preference: { type: 'string' } },
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
      put: {
        tags: ['Dashboard'],
        operationId: 'updateUserPreferences',
        summary: 'Set the display-currency preference.',
        description: 'Display only — it changes no balance, no price and no settlement asset.',
        security: [{ DashboardJwt: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['currency_preference'],
                properties: { currency_preference: { type: 'string', enum: ['USD', 'EUR'] } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'The stored preference.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['currency_preference'],
                  properties: { currency_preference: { type: 'string' } },
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
    '/user/owners': {
      get: {
        tags: ['Dashboard'],
        operationId: 'listUserOwners',
        summary: 'The owner directory across every linked Safe, with aliases.',
        description:
          "Reads each linked Safe's owners LIVE from the chain and groups them by address, so one owner appearing on three accounts is one entry listing three. Aliases are looked up ONLY for the addresses just confirmed on-chain, which is what stops a removed owner's alias from reappearing. **A partial chain failure is reported, never hidden**: partialFailure/failedSafeIds name the Safes whose owners could not be read, so a caller can tell an incomplete directory from a complete one. Those two fields are camelCase, unlike the rest of this API — documented as-is rather than silently normalised.",
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Owners grouped by address, plus the partial-failure report.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['owners', 'partialFailure', 'failedSafeIds'],
                  properties: {
                    owners: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['owner_address', 'name', 'accounts'],
                        properties: {
                          owner_address: { type: 'string', pattern: '^0x[0-9a-f]{40}$', description: 'Lowercased for grouping.' },
                          name: { type: ['string', 'null'], description: 'The stored alias, or null.' },
                          accounts: {
                            type: 'array',
                            items: {
                              type: 'object',
                              required: ['id', 'safe_address', 'chain_id', 'name'],
                              properties: {
                                id: { type: 'string', format: 'uuid' },
                                safe_address: address,
                                chain_id: { type: 'integer' },
                                name: { type: 'string' },
                              },
                            },
                          },
                        },
                      },
                    },
                    partialFailure: { type: 'boolean' },
                    failedSafeIds: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
    },
    '/user/owners/{ownerAddress}': {
      put: {
        tags: ['Dashboard'],
        operationId: 'setOwnerAlias',
        summary: 'Name an owner address.',
        description:
          "An alias is a label, never a grant — naming an address confers no authority over any Safe. The address must be a CURRENT owner of a linked account, checked against the live directory: an unknown address is a 404, but if the chain read partially failed the answer is **503 rather than 404**, because 'not an owner' and 'could not check' must not look the same.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'ownerAddress', in: 'path', required: true, schema: address, description: 'Owner address; matched case-insensitively (stored lowercase).' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'The stored alias.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['owner_address', 'name'],
                  properties: {
                    owner_address: { type: 'string', pattern: '^0x[0-9a-f]{40}$' },
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': { ...errorResponse, description: 'Not a current owner of any linked account.' },
          '503': { ...errorResponse, description: 'Owners could not be verified — distinct from "not an owner".' },
        },
      },
      delete: {
        tags: ['Dashboard'],
        operationId: 'deleteOwnerAlias',
        summary: "Remove an owner's alias.",
        description: 'Drops the label only. Idempotent — removing an alias that does not exist still succeeds, and no ownership check is needed because no authority is involved either way.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'ownerAddress', in: 'path', required: true, schema: address, description: 'Owner address; matched case-insensitively (stored lowercase).' }],
        responses: {
          '200': {
            description: 'Alias removed (or was already absent).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
        },
      },
    },
    // ── Bookkeeping: export, reconcile, categories (#1446, epic #462) ───────
    // Read-only over settled-payment data. No custody surface: nothing here
    // moves money, and the reporting feed below is deliberately NON-ASSERTING
    // (#491) — it hands the accounting tool a draft, never a booked verdict.
    '/accounting/export': {
      get: {
        tags: ['Dashboard'],
        operationId: 'exportAccounting',
        summary: 'Legacy SIE export — GATED OFF by default.',
        description:
          "Superseded by the non-asserting reporting feed (#491): agent spend now syncs into the accounting tool as draft transactions instead of being exported as an asserting SIE file. **410 is the normal answer on a default deployment**; the route only serves when the legacy flag is on. Responds with a FILE, not JSON — Content-Disposition attachment, plus the custom headers X-Export-Entry-Count and X-Export-Skipped reporting how many entries were written and how many could not be.",
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['sie'] }, description: "Defaults to 'sie'; anything else is a 400." },
          { name: 'from', in: 'query', schema: { type: 'string' }, description: 'ISO date (YYYY-MM-DD…).' },
          { name: 'to', in: 'query', schema: { type: 'string' }, description: 'ISO date (YYYY-MM-DD…).' },
          { name: 'company', in: 'query', schema: { type: 'string' }, description: "Company name in the file header; defaults to 'Haven'." },
        ],
        responses: {
          '200': {
            description: 'The SIE file.',
            headers: {
              'X-Export-Entry-Count': { schema: { type: 'string' }, description: 'Entries written.' },
              'X-Export-Skipped': { schema: { type: 'string' }, description: 'Entries that could not be written.' },
            },
            content: { 'application/octet-stream': { schema: { type: 'string' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '410': { ...errorResponse, description: 'The default: SIE export is retired in favour of the reporting feed.' },
        },
      },
    },
    '/accounting/reconcile': {
      get: {
        tags: ['Dashboard'],
        operationId: 'reconcileAccounting',
        summary: 'Surface the entries that cannot book cleanly over a period.',
        description:
          'Read-only diagnosis, never a fix: it classifies each entry and counts the classes, so a user can see WHY a period will not balance before trying to book it. Note the camelCase byStatus/paymentId/txHash/settledAt fields — this report comes from the accounting module, not from SQL rows.',
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string' }, description: 'ISO date.' },
          { name: 'to', in: 'query', schema: { type: 'string' }, description: 'ISO date.' },
        ],
        responses: {
          '200': {
            description: 'The reconciliation report.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['total', 'ok', 'issues', 'byStatus', 'items'],
                  properties: {
                    total: { type: 'integer' },
                    ok: { type: 'integer' },
                    issues: { type: 'integer' },
                    byStatus: {
                      type: 'object',
                      required: ['ok', 'missing_fx', 'missing_tx', 'unbalanced'],
                      properties: {
                        ok: { type: 'integer' },
                        missing_fx: { type: 'integer', description: 'No SEK amount — the FX rate was unavailable.' },
                        missing_tx: { type: 'integer', description: 'No transaction hash to anchor the entry.' },
                        unbalanced: { type: 'integer', description: 'Debits and credits disagree.' },
                      },
                    },
                    items: {
                      type: 'array',
                      description:
                        'ONLY the entries that need attention — an entry classified ok is counted in byStatus but never listed here, so items.length is issues, not total.',
                      items: {
                        type: 'object',
                        required: ['paymentId', 'txHash', 'settledAt', 'status'],
                        properties: {
                          paymentId: { type: 'string' },
                          txHash: { type: 'string' },
                          settledAt: { type: 'string' },
                          status: { type: 'string', enum: ['ok', 'missing_fx', 'missing_tx', 'unbalanced'] },
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
        },
      },
    },
    '/accounting/categories': {
      get: {
        tags: ['Dashboard'],
        operationId: 'listAccountOverrides',
        summary: "The caller's per-merchant BAS account overrides.",
        description:
          'NOTE THE CASING: this read returns the SQL rows as-is (resource_url/bas_account, snake_case), while the write below echoes its own request fields (resourceUrl/account, camelCase). Same path, two conventions — documented rather than normalised, because a generated client must match what the routes actually emit.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Overrides ordered by resource_url.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['overrides'],
                  properties: {
                    overrides: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['resource_url', 'bas_account'],
                        properties: {
                          resource_url: { type: 'string' },
                          bas_account: { type: 'string' },
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
      put: {
        tags: ['Dashboard'],
        operationId: 'setAccountOverride',
        summary: 'Map a merchant to a BAS account.',
        description:
          'Idempotent upsert keyed on (user, resourceUrl). A category is a bookkeeping label — it changes no payment and moves nothing. The response echoes the request fields in camelCase, unlike the snake_case read above.',
        security: [{ DashboardJwt: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['resourceUrl', 'account'],
                properties: {
                  resourceUrl: { type: 'string', minLength: 1 },
                  account: { type: 'string', pattern: '^[0-9]{3,6}$', description: 'A BAS account number.' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'The stored override, echoed.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['resourceUrl', 'account'],
                  properties: { resourceUrl: { type: 'string' }, account: { type: 'string' } },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
        },
      },
      delete: {
        tags: ['Dashboard'],
        operationId: 'clearAccountOverride',
        summary: "Clear a merchant's BAS account override.",
        description: 'Answers **204 No Content**, not a success envelope. Idempotent: clearing an override that was never set still succeeds.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'resourceUrl', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          '204': { description: 'Override cleared (or was never set).' },
          '400': errorResponse,
          '401': errorResponse,
        },
      },
    },
    '/accounting/reporting/status': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getReportingStatus',
        summary: 'Whether the reporting feed is available, connected, and live — plus recent syncs.',
        description:
          'Deliberately NOT gated, unlike the actions below: the page must be able to tell whether to render the full UI, an upsell, or nothing at all, and a 404 here would make "not entitled" indistinguishable from "broken". `liveSyncReady` false means sync is a preview that delivers nowhere — the provider adapter is not configured on this deployment. When the feed is unavailable the answer is a complete, honest shape with available:false and an empty syncs list, not an error.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Feed status.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['hosted', 'flagEnabled', 'liveSyncReady', 'available', 'connected', 'syncs'],
                  properties: {
                    hosted: { type: 'boolean' },
                    flagEnabled: { type: 'boolean' },
                    liveSyncReady: { type: 'boolean', description: 'A real provider adapter is registered.' },
                    available: { type: 'boolean', description: 'The caller is entitled to the feed.' },
                    connected: { type: 'boolean', description: 'The caller has a live provider connection.' },
                    syncs: { type: 'array', items: feedSyncRow },
                  },
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
    },
    '/accounting/reporting/sync': {
      post: {
        tags: ['Dashboard'],
        operationId: 'syncReportingFeed',
        summary: 'Backfill and retry the feed for the caller.',
        description:
          'Pushes what has not been pushed and retries what failed. Gated: **404 when the feed is unavailable**, which is how an unentitled caller sees it. Returns how many rows were fed — 0 is a normal answer, not a failure.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Rows fed.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['fed'],
                  properties: { fed: { type: 'integer' } },
                },
              },
            },
          },
          '401': errorResponse,
          '404': { ...errorResponse, description: 'The reporting feed is not available for this caller.' },
        },
      },
    },
    '/accounting/reporting/verify/{paymentId}': {
      get: {
        tags: ['Dashboard'],
        operationId: 'verifyReportingInvoice',
        summary: "Read back a pushed invoice from the provider's own records.",
        description:
          'Strictly read-only (#1362): it confirms whether the supplier invoice still exists and whether a human has booked it, and asserts nothing — the non-asserting principle is untouched. A payment that was never pushed, a disconnected provider, or a sync row with no invoice reference all answer 409 with a machine-readable error_code, because none of them is a verification result.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string' }, description: 'Haven payment id.' }],
        responses: {
          '200': {
            description: "The provider's verdict.",
            content: { 'application/json': { schema: invoiceVerification } },
          },
          '401': errorResponse,
          '404': { ...errorResponse, description: 'The reporting feed is not available for this caller.' },
          '409': {
            description: 'Not verifiable — not pushed, not connected, or no invoice reference.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['error', 'error_code'],
                  properties: {
                    error: { type: 'string' },
                    error_code: { type: 'string', enum: ['not_pushed', 'not_connected', 'no_invoice_ref'] },
                    status: { type: ['string', 'null'] },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/accounting/reporting/reopen/{paymentId}': {
      post: {
        tags: ['Dashboard'],
        operationId: 'reopenReportingPush',
        summary: 'Reopen a pushed row for retry — only when the provider confirms the invoice is gone.',
        description:
          "The ONLY path that flips a pushed row back to retryable, and it is conditional on the PROVIDER, not on the caller's say-so (#1365): the server re-runs the read-back and reopens only when the invoice is confirmed gone, or when a number collision proves the invoice at that number is not ours. **An invoice that still exists refuses with 409 and writes nothing** — that is the double-post guard, and reopening against a live invoice would duplicate it. A row that moved between the check and the flip (raced by a concurrent sync) also refuses rather than pretending. After a successful reopen, the next sync re-claims and re-pushes through the normal retry path.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string' }, description: 'Haven payment id.' }],
        responses: {
          '200': {
            description: 'Row reopened for retry.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['reopened', 'payment_id', 'next'],
                  properties: {
                    reopened: { type: 'boolean', enum: [true] },
                    payment_id: { type: 'string' },
                    next: { type: 'string' },
                  },
                },
              },
            },
          },
          '401': errorResponse,
          '404': { ...errorResponse, description: 'The reporting feed is not available for this caller.' },
          '409': {
            description: 'Refused, nothing written — the invoice still exists, the row is not pushed, or it moved under us.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['error', 'error_code'],
                  properties: {
                    error: { type: 'string' },
                    error_code: { type: 'string', enum: ['not_pushed', 'not_connected', 'no_invoice_ref', 'invoice_exists'] },
                    invoice_number: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    // ── Fortnox OAuth connect + legacy voucher push (#1446, epic #462) ──────
    // CREDENTIAL BOUNDARY: the OAuth access and refresh tokens live server-side
    // only. NOTHING in this surface returns them — /status exposes the granted
    // scope and an expiry timestamp and nothing else, and the callback
    // redirects without echoing anything it received. Pinned by the route
    // tests, which are written as redaction tests rather than shape tests.
    //
    // This router is registered WITHOUT the global auth hook, deliberately:
    // the callback is a browser redirect from Fortnox and carries no JWT, so
    // every other route opts into authentication per-route instead.
    '/accounting/fortnox/status': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getFortnoxStatus',
        summary: 'Whether Fortnox is configured on this deployment and connected for the caller.',
        description:
          "Returns SAFE METADATA ONLY: the granted scope and the token expiry, never the tokens themselves. Two shapes, deliberately: when the deployment has no Fortnox credentials the answer omits scope/expiresAt entirely (there is nothing to report), and when it is configured they are present but null until a connection exists. `legacyBookkeeping` tells the UI whether the asserting voucher-push surface below is reachable at all — off by default (#492).",
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Connection metadata.',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      required: ['configured', 'connected', 'legacyBookkeeping'],
                      properties: {
                        configured: { type: 'boolean', enum: [false] },
                        connected: { type: 'boolean', enum: [false] },
                        legacyBookkeeping: { type: 'boolean' },
                      },
                    },
                    {
                      type: 'object',
                      required: ['configured', 'connected', 'scope', 'expiresAt', 'legacyBookkeeping'],
                      properties: {
                        configured: { type: 'boolean', enum: [true] },
                        connected: { type: 'boolean' },
                        scope: { type: ['string', 'null'], description: 'The granted OAuth scope. Null until connected.' },
                        expiresAt: { type: ['string', 'null'], description: 'Access-token expiry. Null until connected.' },
                        legacyBookkeeping: { type: 'boolean' },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
    },
    '/accounting/fortnox/connect-url': {
      post: {
        tags: ['Dashboard'],
        operationId: 'getFortnoxConnectUrl',
        summary: 'Get the Fortnox consent URL as JSON.',
        description:
          "The JSON twin of /connect, and it exists for a concrete reason: a single-page app cannot carry its Bearer token through a plain browser navigation, so it fetches the URL here and navigates itself. The URL embeds a signed `state` that expires in 10 minutes and carries a purpose claim — see the callback.",
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'The consent URL. Carries no token material.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url'],
                  properties: { url: { type: 'string' } },
                },
              },
            },
          },
          '401': errorResponse,
          '503': { ...errorResponse, description: 'Fortnox is not configured on this deployment.' },
        },
      },
    },
    '/accounting/fortnox/connect': {
      get: {
        tags: ['Dashboard'],
        operationId: 'startFortnoxConnect',
        summary: 'Redirect the browser to Fortnox consent.',
        description: 'The redirect twin of /connect-url, for a navigation that can carry the session. Same signed, 10-minute, purpose-scoped state.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '302': { description: 'Redirect to the Fortnox consent screen.' },
          '401': errorResponse,
          '503': { ...errorResponse, description: 'Fortnox is not configured on this deployment.' },
        },
      },
    },
    '/accounting/fortnox/callback': {
      get: {
        tags: ['Dashboard'],
        operationId: 'fortnoxOAuthCallback',
        summary: 'PUBLIC OAuth callback — authenticated by the signed state, not by a session.',
        description:
          "Hit by a browser redirect from Fortnox, which carries no JWT. The caller is authenticated by the `state` this flow issued: it must verify, and it must carry the fortnox_oauth PURPOSE claim — an ordinary session token is rejected here, so a valid Haven token cannot be replayed as OAuth state. **Every outcome is a redirect, never JSON**, and every failure collapses to the same `?fortnox=error` regardless of cause: a bad state, a failed code exchange and a failed save are indistinguishable to the browser by design. A user-declined consent is reported separately as `?fortnox=denied` because that is the user's own action, not a failure to hide.",
        security: [],
        parameters: [
          { name: 'code', in: 'query', schema: { type: 'string' }, description: 'Authorization code from Fortnox.' },
          { name: 'state', in: 'query', schema: { type: 'string' }, description: 'The signed, purpose-scoped state this flow issued.' },
          { name: 'error', in: 'query', schema: { type: 'string' }, description: 'Present when the user declined consent.' },
        ],
        responses: {
          '302': {
            description: 'Always a redirect to the settings page: ?fortnox=connected, ?fortnox=denied, or ?fortnox=error.',
          },
        },
      },
    },
    '/accounting/fortnox': {
      delete: {
        tags: ['Dashboard'],
        operationId: 'disconnectFortnox',
        summary: 'Disconnect Fortnox for the caller.',
        description: 'Deletes the stored connection, tokens included. Answers **204 No Content** and returns no token material. Idempotent — disconnecting when nothing is connected still succeeds.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '204': { description: 'Disconnected (or was never connected).' },
          '401': errorResponse,
        },
      },
    },
    '/accounting/fortnox/push': {
      post: {
        tags: ['Dashboard'],
        operationId: 'pushFortnoxVouchers',
        summary: 'Legacy asserting voucher push — GATED OFF by default.',
        description:
          "The asserting counterpart to the reporting feed: it pushes FINISHED vouchers rather than drafts, which is exactly what #491/#492 moved away from. **410 is the normal answer on a default deployment.** When enabled, it reports per-entry outcomes rather than failing the batch: an entry with no book-time SEK amount is unbookable and counted as skipped, and a provider error is collected into failures with its payment id — so a partial push is visible as a partial push instead of an exception.",
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string' }, description: 'ISO date.' },
          { name: 'to', in: 'query', schema: { type: 'string' }, description: 'ISO date.' },
        ],
        responses: {
          '200': {
            description: 'Per-entry outcome of the push.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['pushed', 'skipped', 'failed', 'failures'],
                  properties: {
                    pushed: { type: 'integer' },
                    skipped: { type: 'integer', description: 'Entries with no book-time SEK amount — unbookable, not errors.' },
                    failed: { type: 'integer' },
                    failures: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['paymentId', 'error'],
                        properties: {
                          paymentId: { type: 'string' },
                          error: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { ...errorResponse, description: 'Malformed date, or Fortnox is not connected.' },
          '401': errorResponse,
          '410': { ...errorResponse, description: 'The default: pushing finished vouchers is retired in favour of the draft feed.' },
        },
      },
    },
    // ── Hybrid DeleGator accounts (#1446, epic #821) ────────────────────────
    // CUSTODY: Haven PREPARES and RELAYS; the owner's own key signs. Every
    // write that reaches the CHAIN is a two-step prepare→submit where the
    // signature is made on the caller's device and the re-derived calldata
    // must match what was signed, so a compromised Haven cannot substitute a
    // different operation. (Provisioning is the exception and needs no
    // signature: it derives a counterfactual address and records a row —
    // nothing executes, so there is nothing to sign.) Ownership is the
    // user_safes row, so naming any address only ever reaches an account the
    // caller already owns.
    '/accounts/hybrid': {
      post: {
        tags: ['Dashboard'],
        operationId: 'createHybridAccount',
        summary: 'Provision a counterfactual Hybrid DeleGator account.',
        description:
          "Computes the deterministic account address for an owner configuration (an EOA, P256 passkeys, or both) and records the row. **No transaction happens here** — the address is derived, not deployed, and `deployed: false` says so; the first sponsored operation (the budget grant) deploys the code. Refusals guard the derivation's own traps: the zero address is rejected because it derives the SAME account as the pure-passkey configuration while counting as a second signer, and duplicate passkey key_ids are rejected because they collapse to one on-chain key. A single-signer account is permitted (#1153) — the backup recommendation reaches the user after funding instead of walling the first minute.",
        security: [{ DashboardJwt: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: 'At least one owner is required: owner_address, passkeys, or both.',
                properties: {
                  chain_id: { type: 'integer', description: 'Defaults to Base Sepolia while delegation onboarding is dark-launched.' },
                  name: { type: 'string', description: "Display label; defaults to 'My account'." },
                  owner_address: { ...address, description: 'EOA owner. Must not be the zero address.' },
                  passkeys: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['key_id', 'x', 'y'],
                      properties: {
                        key_id: { type: 'string' },
                        x: { type: 'string', pattern: '^0x[0-9a-fA-F]{1,64}$', description: 'P256 public-key x coordinate.' },
                        y: { type: 'string', pattern: '^0x[0-9a-fA-F]{1,64}$', description: 'P256 public-key y coordinate.' },
                      },
                    },
                  },
                  single_signer_waiver: {
                    type: 'object',
                    description:
                      'Accepted and recorded as history, but REQUIRED FOR NOTHING (#1153) — sending it changes no outcome and omitting it changes no outcome. Kept on the request shape so existing clients keep working.',
                    properties: { acknowledged: { type: 'boolean' } },
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Account row recorded. Counterfactual — nothing was deployed.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'account_address', 'chain_id', 'account_type', 'deployed', 'created_at'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    account_address: address,
                    chain_id: { type: 'integer' },
                    account_type: { type: 'string', enum: ['delegator_hybrid'] },
                    deployed: { type: 'boolean', enum: [false], description: 'Always false here — deployment rides the first sponsored operation.' },
                    created_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          '400': { ...errorResponse, description: 'Bad owner configuration, or a chain the delegation rail does not serve.' },
          '401': errorResponse,
          '409': { ...errorResponse, description: 'This account is already registered for the caller.' },
          '502': { ...errorResponse, description: 'The account address could not be derived.' },
        },
      },
    },
    '/accounts/hybrid/{address}/signers': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getHybridAccountSigners',
        summary: "Read an account's signer set (public key material only).",
        description:
          "The account-scoped twin of the agent-scoped read, and it exists for two cases the agent route cannot serve: resolving a signer at LOGIN, before any agent exists, and giving account-level recovery a data source for an account with zero agents. Owner-scoped; nothing secret — an address and P256 public-key coordinates. The exact configuration the address was derived FROM, so a client can rebuild the same signer.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'address', in: 'path', required: true, schema: address, description: 'The hybrid account address.' }, { name: 'chain_id', in: 'query', schema: { type: 'string' }, description: 'Required — the (address, chain) pair identifies the account.' }],
        responses: {
          '200': {
            description: 'The signer set.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HybridAccountSigners' },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': { ...errorResponse, description: 'The account signer configuration is unknown.' },
        },
      },
    },
    '/accounts/hybrid/{address}/signers/prepare': {
      post: {
        tags: ['Dashboard'],
        operationId: 'prepareHybridSignerChange',
        summary: 'Prepare a signer-set change for an EXISTING signer to sign.',
        description:
          "Enroll a backup passkey or EOA, or remove one. Haven prepares; an existing signer signs — Haven never signs a signer change. The chain's own last-signer rule is mirrored as a clear 409 rather than an opaque revert. The response branches on the signature scheme the device can satisfy.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'address', in: 'path', required: true, schema: address, description: 'The hybrid account address.' }, { name: 'chain_id', in: 'query', schema: { type: 'string' }, description: 'Required — the (address, chain) pair identifies the account.' }],
        requestBody: { required: true, content: { 'application/json': { schema: signerActionBody } } },
        responses: {
          '200': {
            description: 'Prepared change, shaped by the signature scheme. Carries no treasury_address.',
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
    '/accounts/hybrid/{address}/signers/submit': {
      post: {
        tags: ['Dashboard'],
        operationId: 'submitHybridSignerChange',
        summary: 'Submit the signed signer-set change.',
        description:
          'Envelope first, account second — a malformed body is a 400 regardless of account state. Storage syncs only after the on-chain operation succeeds, and the sync is pinned to the SIGNED calldata: a user_operation that does not match the signed action is refused rather than trusted.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'address', in: 'path', required: true, schema: address, description: 'The hybrid account address.' }, { name: 'chain_id', in: 'query', schema: { type: 'string' }, description: 'Required — the (address, chain) pair identifies the account.' }],
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
                  properties: { updated: { type: 'boolean' }, tx_hash: { type: 'string' } },
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
    '/accounts/hybrid/{address}/transfers/prepare': {
      post: {
        tags: ['Dashboard'],
        operationId: 'prepareHybridTransfer',
        summary: 'MONEY PATH: prepare an owner-signed ERC-20 transfer from the account.',
        description:
          "The rail's Send. The treasury executes the transfer as a sponsored account operation **the OWNER signs** — the same prepare/submit and calldata-pinning discipline as a signer change, and the same device-decides scheme. Haven constructs and relays; it never signs, so it cannot move these funds on its own. Works on a counterfactual account: deploy and transfer ride one sponsored operation. Rate-limited on the money-path limiter.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'address', in: 'path', required: true, schema: address, description: 'The hybrid account address.' }, { name: 'chain_id', in: 'query', schema: { type: 'string' }, description: 'Required — the (address, chain) pair identifies the account.' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token_address', 'to', 'amount_atomic'],
                properties: {
                  token_address: address,
                  to: { ...address, description: 'Recipient.' },
                  amount_atomic: { type: 'string', pattern: '^[0-9]+$', description: 'Atomic units.' },
                  signature_scheme: { type: 'string', enum: ['eip712_userop', 'webauthn_userop'] },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Prepared transfer, shaped by the signature scheme.',
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
          '429': { ...errorResponse, description: 'Money-path rate limit.' },
          '502': errorResponse,
        },
      },
    },
    '/accounts/hybrid/{address}/transfers/submit': {
      post: {
        tags: ['Dashboard'],
        operationId: 'submitHybridTransfer',
        summary: 'MONEY PATH: submit the owner-signed transfer.',
        description: 'Relays the signed operation. The calldata is pinned to what was signed, so the submitted transfer is the one the owner approved — a different recipient or amount is refused, not relayed. Rate-limited on the money-path limiter.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'address', in: 'path', required: true, schema: address, description: 'The hybrid account address.' }, { name: 'chain_id', in: 'query', schema: { type: 'string' }, description: 'Required — the (address, chain) pair identifies the account.' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['signature', 'user_operation'],
                properties: {
                  token_address: address,
                  to: address,
                  amount_atomic: { type: 'string', pattern: '^[0-9]+$' },
                  signature: hexBytes,
                  user_operation: preparedUserOperation,
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Transfer submitted on-chain.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['submitted', 'tx_hash'],
                  properties: { submitted: { type: 'boolean' }, tx_hash: { type: 'string' } },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '429': { ...errorResponse, description: 'Money-path rate limit.' },
          '502': errorResponse,
        },
      },
    },
    // ── Approval queue (#1446) ──────────────────────────────────────────────
    // The human circuit breaker on the legacy AllowanceModule rail: a payment
    // that exceeds the on-chain allowance is queued here instead of executing.
    //
    // TWO PROPERTIES WORTH KNOWING BEFORE READING THE SHAPES.
    // First, every state flip is guarded INSIDE the UPDATE's WHERE clause —
    // ownership, current status and expiry are all conditions of the write, so
    // an expired, foreign or already-actioned request writes nothing and the
    // race is closed by the database rather than by a check-then-write.
    // Second, approving executes NOTHING. It records consent and hands back
    // the payment details; the user's own wallet executes the Safe
    // transaction and reports the hash to /executed. Haven never signs it.
    // #2055 (epic #1440): the /approvals surface is REMOVED, not tombstoned.
    // The queue belonged to the Safe rail; #1986 closed its actionable
    // transitions, the owner decision on #2021 waived queue-history
    // readability, and the `approval_requests` table is dropped (migration
    // 070) — so the five operations that stood here (list / approve /
    // proposed / reject / executed) are deregistered and now answer 404.
    // Unlike the payment-path tombstones (which stayed as 410s because a
    // retired SPEND flow must not read as retryable), a deleted dashboard
    // queue has no such ambiguity: #1989 removed its only UI, and nothing
    // programmatic ever called it.
    // ── Session + passkeys (#1446) ──────────────────────────────────────────
    // CREDENTIAL BOUNDARY: no response here returns a password, a hash, or a
    // passkey's private material. The passkey routes echo an id, the derived
    // signer address and the chain — never the public-key coordinates they
    // were derived from, and never the stored attestation.
    '/auth/signup': {
      post: {
        tags: ['Dashboard'],
        operationId: 'signup',
        summary: 'Create an account and return a session token.',
        description:
          "The email is NORMALISED before the uniqueness check, deliberately: an exact match on the raw input would let `ADA@Example.com` register alongside a stored `ada@example.com`, giving one person two accounts and two treasuries. Password bounds are 8-128 characters. The returned user is a fixed new-account shape — no wallet, no Safe, USD, an empty safes list — because none of those exist yet. **The 409 for a taken address is a deliberate, ACCEPTED disclosure (#1654):** one unauthenticated request tells the caller whether an email has a Haven account, which is stronger than the oracle #1646 closed on login. It stands because telling a returning user \"you already have an account — sign in instead\" is real product value, and because the standard mitigation is structurally unavailable here: a 201 carries the SESSION TOKEN, so answering 201 for a taken address would either mint a token for someone else's account or return a token-less 201 that is an equally strong oracle — genuine hardening needs an email-verification channel this API does not have. Bulk probing is additionally rate limited (#1670) — 10 requests/minute per client address, in deployments where TRUST_PROXY_HOPS is set so per-IP means the CLIENT rather than one shared proxy bucket; the tier deliberately disarms itself otherwise, since a shared-bucket limit on the front door is a denial-of-service, not a protection. Throttled is not closed: one request against one address still answers definitively, which is what the acceptance above is about. If an email channel is ever added, revisit this tradeoff in the same change. Timing is not equalised on this route because the status already discloses account existence — the clock has nothing to add beyond what the 409 already says.",
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'email', 'password'],
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 80, description: 'Trimmed; control characters are rejected.' },
                  email: { type: 'string', maxLength: 255 },
                  password: { type: 'string', minLength: 8, maxLength: 128 },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Account created; the token is valid for 7 days.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token', 'user'],
                  properties: { token: { type: 'string' }, user: sessionUser },
                },
              },
            },
          },
          '400': errorResponse,
          '409': { ...errorResponse, description: 'An account with this email already exists. A deliberate, documented enumeration disclosure — see this operation\'s description (#1654).' },
          '429': { ...errorResponse, description: 'Rate limited (10/min per client address, #1670) — only in deployments with a trusted proxy.' },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Dashboard'],
        operationId: 'login',
        summary: 'Exchange credentials for a session token.',
        description:
          "**An unknown email and a wrong password return the SAME 401**, deliberately: distinguishing them would turn this endpoint into an account-enumeration oracle, letting anyone discover which addresses have Haven accounts. Do not make the error message more helpful. The protection covers timing as well as the status and body (#1646): the password comparison runs on BOTH paths — against an absent-user hash when there is no account — so the answer costs materially the same either way (the remaining difference is the sub-millisecond indexed lookup, far below bcrypt cost). The token is valid for 7 days, and the response carries the user's Safes so a client needs no second call to render a session.",
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: { email: { type: 'string' }, password: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Session established.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token', 'user'],
                  properties: { token: { type: 'string' }, user: sessionUser },
                },
              },
            },
          },
          '400': errorResponse,
          '401': { ...errorResponse, description: 'Invalid email or password — one answer for both, on purpose.' },
          '429': { ...errorResponse, description: 'Rate limited (30/min per client address, #1670) — only in deployments with a trusted proxy.' },
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getSession',
        summary: 'Read the authenticated session: profile plus Safes.',
        description:
          'Both reads are scoped to the JWT subject, never to a client-supplied id. Returns the FULL profile row (including created_at, unlike the login and signup user object) plus the same Safe list. A 404 here means the account was deleted while a valid token for it was still in flight.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'The session.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'name', 'email', 'wallet_address', 'safe_address', 'currency_preference', 'created_at', 'safes'],
                  properties: {
                    ...userProfile.properties,
                    safes: { type: 'array', items: sessionSafe },
                  },
                },
              },
            },
          },
          '401': errorResponse,
          '404': { ...errorResponse, description: 'The account no longer exists.' },
        },
      },
    },
    '/passkeys': {
      post: {
        tags: ['Dashboard'],
        operationId: 'registerPasskey',
        summary: 'Enroll a passkey signer for the caller.',
        description:
          "Derives the Safe passkey-signer address from the P256 public key and records it. **A second passkey on the same chain is allowed and is the point** (#1229): it is a BACKUP SIGNER, and this rail's only recovery — refusing it used to lock out exactly the users who most needed protection. Only a duplicate credential_id is refused. HONEST LIMITATION: the attestation object is persisted for future verification but is NOT cryptographically verified yet, so a bad enrollment harms only the enrolling user. The response is NARROWER than the list read below — an id, the credential, the derived signer address and the chain, never the public-key coordinates or the stored attestation.",
        security: [{ DashboardJwt: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['credential_id', 'public_key_x', 'public_key_y', 'chain_id'],
                properties: {
                  credential_id: { type: 'string', description: 'Non-empty base64url.' },
                  public_key_x: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$', description: '32-byte 0x-hex.' },
                  public_key_y: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$', description: '32-byte 0x-hex.' },
                  chain_id: { type: 'integer' },
                  raw_attestation_object: { type: 'string', description: 'Optional base64url attestation. Stored, not yet verified.' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Passkey enrolled.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'credential_id', 'signer_address', 'chain_id'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    credential_id: { type: 'string' },
                    signer_address: { type: 'string', description: 'Derived from the public key; stored lowercase.' },
                    chain_id: { type: 'integer' },
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '409': { ...errorResponse, description: 'This credential is already registered. Note: a SECOND passkey on the same chain is NOT a conflict.' },
        },
      },
      get: {
        tags: ['Dashboard'],
        operationId: 'listPasskeys',
        summary: "List the caller's enrolled passkeys.",
        description: 'Wider than the create response: it also carries the bound Safe address and the enrollment time. Still no key material.',
        security: [{ DashboardJwt: [] }],
        responses: {
          '200': {
            description: 'Enrolled passkeys.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['passkeys'],
                  properties: {
                    passkeys: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['id', 'credential_id', 'signer_address', 'chain_id', 'safe_address', 'created_at'],
                        properties: {
                          id: { type: 'string', format: 'uuid' },
                          credential_id: { type: 'string' },
                          signer_address: { type: 'string' },
                          chain_id: { type: 'integer' },
                          safe_address: { type: ['string', 'null'], description: 'Null until the passkey is bound to a Safe.' },
                          created_at: { type: 'string', format: 'date-time' },
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
    // ── Activity + analytics (#1446) ────────────────────────────────────────
    // Read-only. Nothing here writes, signs, or moves anything — these are the
    // owner's window onto what an agent did, including the MCP tool-call audit
    // log, which is how a tool call that never became a payment stays visible.
    '/agent-activity/{id}/activity': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getAgentActivity',
        summary: "One agent's payments and tool calls, newest first.",
        description:
          "A heterogeneous list discriminated by `type`: payment or mcp_tool_call. (#2262: the third branch, `approval`, is gone — #2055 dropped `approval_requests` and this handler merges `payment_intents` and the MCP tool-call audit log, with no third source.) **Read the pagination carefully — it is approximate by construction.** `limit` is applied to EACH of the two sources separately and the results are then merged and sorted, so this route can return up to twice `limit` entries, and `offset` walks each source independently rather than the merged sequence. (The combined feed below merges the same way but then truncates to `limit`, so the two routes do NOT paginate identically.) Treat the list as a recent-activity window, not as a stable paged sequence.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Agent id.' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 }, description: 'Capped at 100.' },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          '200': {
            description: 'Merged activity, newest first.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['activity'],
                  properties: { activity: { type: 'array', items: activityEntry } },
                },
              },
            },
          },
          '401': errorResponse,
          '404': { ...errorResponse, description: 'No such agent for this caller.' },
        },
      },
    },
    '/agent-activity/{id}/stats': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getAgentStats',
        summary: "One agent's spend totals per token, plus its pending-approval count.",
        description:
          'Totals count CONFIRMED spend only, so an in-flight payment does not inflate them. Each window (all time, today, this week) is a separate per-token list rather than one list with three numbers, because a token can appear in one window and not another.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Agent id.' }],
        responses: {
          '200': {
            description: 'Spend totals and the pending count.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['all_time', 'today', 'this_week', 'pending_approvals'],
                  properties: {
                    all_time: spendTotals,
                    today: spendTotals,
                    this_week: spendTotals,
                    pending_approvals: { type: 'integer', description: 'Always 0 since #2055 — the approval queue died with the Safe rail; kept for wire compatibility.' },
                  },
                },
              },
            },
          },
          '401': errorResponse,
          '404': { ...errorResponse, description: 'No such agent for this caller.' },
        },
      },
    },
    '/agent-activity/feed': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getActivityFeed',
        summary: 'Combined activity across every agent the caller owns.',
        description:
          "The same two entry types as the per-agent list, each additionally carrying agent_id and agent_name so the feed can attribute a row without a second lookup ('Unknown' when the agent row is gone — the activity stays visible). Unlike the per-agent route, the merged list IS truncated to `limit`. A caller with no agents gets an empty list and a zero count rather than an error. `pending_approvals` is always 0 since #2055 (the approval queue died with the Safe rail); the field survives for wire compatibility.",
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 }, description: 'Capped at 100.' },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          '200': {
            description: 'Merged cross-agent activity plus the actionable-approval count.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['activity', 'pending_approvals'],
                  properties: {
                    activity: { type: 'array', items: activityEntry },
                    pending_approvals: { type: 'integer', description: 'Always 0 since #2055 — the approval queue died with the Safe rail; kept for wire compatibility.' },
                  },
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
    },
    '/analytics/funnel': {
      get: {
        tags: ['Dashboard'],
        operationId: 'getOnboardingFunnel',
        summary: 'Onboarding step conversion and median time-to-first-payment.',
        description:
          'Counts DISTINCT users per onboarding step over a date range, with the conversion from the previous step, plus the median time from signup to first settled payment. Defaults to the last 30 days. The window is echoed back as resolved ISO timestamps so a caller can tell exactly which range produced the numbers rather than re-deriving the default.',
        security: [{ DashboardJwt: [] }],
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string' }, description: 'Date; defaults to 30 days before `to`.' },
          { name: 'to', in: 'query', schema: { type: 'string' }, description: 'Date; defaults to now.' },
        ],
        responses: {
          '200': {
            description: 'Funnel counts and median TTFP.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['steps', 'medianTtfpMs', 'from', 'to'],
                  properties: {
                    steps: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['event', 'users', 'conversionFromPrev'],
                        properties: {
                          event: {
                            type: 'string',
                            enum: ['signed_up', 'safe_deployed', 'safe_imported', 'agent_created', 'allowance_granted', 'safe_funded', 'first_payment_settled'],
                            description:
                              "Retained for wire compatibility with historical windows. THREE of these steps are permanently zero for any window after their retirement and a funnel built from them will show three dead stages: 'safe_deployed' and 'safe_imported' (410 since #1984 — Safe inflow is retired) and 'allowance_granted' (#2020 — the AllowanceModule rail no longer grants). Historical rows before those dates still count.",
                          },
                          users: { type: 'integer', description: 'DISTINCT users who reached this step.' },
                          conversionFromPrev: { type: ['number', 'null'], description: 'Null when there is nothing to convert from: the first step, or any step whose predecessor counted zero users.' },
                        },
                      },
                    },
                    medianTtfpMs: { type: ['integer', 'null'], description: 'Median signup→first-settled-payment in ms. Null when nobody has completed it in the window.' },
                    from: { type: 'string', format: 'date-time', description: 'The resolved window start.' },
                    to: { type: 'string', format: 'date-time', description: 'The resolved window end.' },
                  },
                },
              },
            },
          },
          '400': { ...errorResponse, description: 'Unparseable dates, or from is not before to.' },
          '401': errorResponse,
        },
      },
    },
    // ── Routes previously excluded one by one (#1446, final slice) ──────────
    // These ten sat in KNOWN_UNDOCUMENTED_ROUTES rather than in a deferred
    // module. Two of their reasons no longer hold: GET /chains' own entry said
    // it SHOULD be in the spec and that documenting it belonged to this
    // backfill, and POST /x402/{id}/settle was excluded pending a sweep (#834)
    // that closed without doing it. The other eight were held back until "the
    // dashboard surface is folded into a separate dashboard spec" — a premise
    // this epic overtook, since the spec now carries the dashboard surface.
    '/chains': {
      get: {
        tags: ['Health'],
        operationId: 'getChains',
        summary: 'PUBLIC: which chains this deployment serves.',
        description:
          'Two different lists, and the difference matters: `supported` is every chain the code knows, while `deployable` is the subset this environment will actually provision accounts on (#679). Onboarding pickers must offer `deployable`, not `supported`, or they will offer a chain the deployment refuses. No authentication — it is configuration, not data.',
        security: [],
        responses: {
          '200': {
            description: 'The chain registry for this deployment.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['deployable', 'supported'],
                  properties: {
                    deployable: { type: 'array', items: { type: 'integer' }, description: 'Chains this environment will provision on.' },
                    supported: { type: 'array', items: { type: 'integer' }, description: 'Chains the code knows about at all.' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/x402/{id}/settle': {
      post: {
        tags: ['x402'],
        operationId: 'settleX402Payment',
        summary: 'MONEY PATH: settle a delegation-rail x402 payment with the delegate signature.',
        description:
          "The delegation rail's settlement step, and the reason the rail has no funding leg: the agent signs the settlement child delegation, Haven assembles the merchant X-PAYMENT header, and the merchant redeems the chain directly from the budget delegation — **money moves account→merchant, never through a delegate hot balance**. Retry the merchant with the returned `payment_header`; it is a signed, single-use, amount-and-merchant-bound authorization, not a key. Refusals are specific on purpose: a payment on the wrong rail is a 409 rather than a confusing 400, and a lost settlement context is a 502 telling you to re-authorize rather than a silent failure. Agent-authenticated and rate-limited on the money-path limiter.",
        security: [{ AgentApiKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Payment intent id from authorize.' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['signature'],
                properties: { signature: { type: 'string', pattern: '^0x[0-9a-fA-F]+$', description: 'The delegate EIP-712 signature over the settlement child.' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Settled; retry the merchant with payment_header.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['payment_id', 'status', 'payment_header'],
                  properties: {
                    payment_id: { type: 'string' },
                    status: { type: 'string', enum: ['submitted'] },
                    payment_header: { type: 'string', description: 'The merchant X-PAYMENT header. Single-use and bound to this amount and merchant.' },
                    resource_url: { type: ['string', 'null'] },
                    passport: { description: 'Optional passport reference for the paying agent.' },
                  },
                },
              },
            },
          },
          '400': { ...errorResponse, description: 'A delegate signature is required.' },
          '401': errorResponse,
          '404': { ...errorResponse, description: 'Payment not found.' },
          '409': { ...errorResponse, description: 'Not a delegation-rail settlement, or not awaiting a signature.' },
          '429': { ...errorResponse, description: 'Money-path rate limit.' },
          '502': { ...errorResponse, description: 'Settlement state was lost — re-authorize.' },
        },
      },
    },
    '/agents/{id}/pause': {
      post: {
        tags: ['Agents'],
        operationId: 'pauseAgent',
        summary: 'Pause an agent — reversible, unlike revoke.',
        description: "Pausing stops Haven serving the agent while leaving its on-chain authority intact; revoking is the terminal action. A paused agent's standing reports as suspended rather than revoked.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          '200': { description: 'Paused.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
          '400': errorResponse,
          '401': errorResponse,
          '404': { ...errorResponse, description: 'No such agent for this caller, or it cannot be paused from its current state.' },
        },
      },
    },
    '/agents/{id}/resume': {
      post: {
        tags: ['Agents'],
        operationId: 'resumeAgent',
        summary: 'Resume a paused agent.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          '200': { description: 'Resumed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
          '400': errorResponse,
          '401': errorResponse,
          '404': { ...errorResponse, description: 'No such agent for this caller, or it cannot be resumed from its current state.' },
        },
      },
    },
    '/agents/{id}/rotate-key': {
      post: {
        tags: ['Agents'],
        operationId: 'rotateAgentKey',
        summary: 'Issue a new API key for an active agent.',
        description:
          "**The plaintext key is returned ONCE, here, and is never retrievable again** — Haven stores only its hash. Rotation invalidates the previous key immediately, so a running agent must be given the new one before its next call. Only an ACTIVE agent can rotate: a revoked agent stays revoked (409), because handing out a fresh credential for it would undo the revocation.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          '200': {
            description: 'The new key. Store it now.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['api_key', 'api_key_prefix'],
                  properties: {
                    api_key: { type: 'string', description: 'Plaintext, shown once.' },
                    api_key_prefix: { type: 'string', description: 'The prefix Haven keeps for display.' },
                  },
                },
              },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
          '409': { ...errorResponse, description: 'The agent is not active.' },
        },
      },
    },
    '/agents/{id}/allowances': {
      post: {
        tags: ['Agents'],
        operationId: 'setAgentAllowance',
        summary: 'RETIRED (410): per-token allowances died with the Safe rail.',
        description:
          'Retired with the Safe rail (#1440/#2020). Always answers 410 and writes nothing — spend authority on the delegation rail is a signed budget delegation (`POST /agents/{id}/delegations/prepare` → activate), never a per-token allowance row. The typed operation stays as a tombstone so older clients get a stable, explicit answer rather than a 404.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: true,
                description: 'Ignored — the endpoint refuses before reading the body.',
              },
            },
          },
        },
        responses: {
          '410': { ...errorResponse, description: 'Always. The Safe rail is retired; grant a budget delegation instead.' },
          '401': errorResponse,
        },
      },
    },
    '/agents/{id}/allowances/{tokenAddress}': {
      delete: {
        tags: ['Agents'],
        operationId: 'deleteAgentAllowance',
        summary: 'RETIRED (410): per-token allowances died with the Safe rail.',
        description:
          'Retired with the Safe rail (#1440/#2020). Always answers 410 and deletes nothing (a malformed token address still gets its 400). Revoke or change the agent’s budget delegation instead.',
        security: [{ DashboardJwt: [] }],
        parameters: [{ $ref: '#/components/parameters/AgentId' }, { name: 'tokenAddress', in: 'path', required: true, schema: address }],
        responses: {
          '410': { ...errorResponse, description: 'Always, for a well-formed token address.' },
          '400': errorResponse,
          '401': errorResponse,
        },
      },
    },
    '/transactions/payment-intents/{paymentId}/evidence': {
      get: {
        tags: ['Transactions'],
        operationId: 'getPaymentEvidence',
        summary: 'Read the stored evidence for one payment or approval.',
        description:
          "The audit view behind a transaction row. `payment_id` is resolved for the caller — it carries whichever of the two source ids exists, so a client does not branch on payment-versus-approval to find its own identifier.",
        security: [{ DashboardJwt: [] }],
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': {
            description: 'The evidence record.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['evidence'],
                  properties: {
                    evidence: {
                      type: 'object',
                      additionalProperties: true,
                      required: ['payment_id'],
                      properties: {
                        payment_id: { type: ['string', 'null'], description: 'Resolved from the payment intent id, else the approval request id.' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { ...errorResponse, description: 'Malformed paymentId.' },
          '401': errorResponse,
          '404': { ...errorResponse, description: 'No evidence for this payment.' },
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
    '/agent-connection-setups/{setupId}/budget-approval': {
      post: {
        tags: ['Connect Agent 2'],
        operationId: 'recordAgentConnectionBudgetApproval',
        summary: 'Complete a delegation-rail Connect Agent 2 setup.',
        description:
          'Activates the pending agent only after Haven confirms that every budget this setup promised exists as an active, owner-signed budget on the agent — the caller asserts nothing, so the request body is empty and the call is safe to retry. Rejected with 409 on a retired Safe / AllowanceModule account, which has no approval path in Haven since #2259 deleted the wallet-approval route.',
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
          'Creates a signable payment intent on the delegation rail. The agent must sign the ' +
          'returned sign_data with its delegate key before Haven can relay execution; the budget ' +
          'delegation\'s caveat enforcers authorize it on-chain at redemption. ' +
          '#2105: there is no over-budget approval branch — an over-budget payment REVERTS during ' +
          'gas estimation rather than queuing, and the approval queue died with the Safe rail ' +
          '(#2055). Both retired rails are refused with 410 before anything is written.',
        security: [{ AgentApiKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreatePaymentRequest' },
            },
          },
        },
        // #2105: the 202 → PendingApproval branch documented here was removed
        // from `routes/payments.ts` with the approval_requests replay fallback
        // (#2055, the comment at its old site). The 409 below is the reachable
        // replay outcome that was never documented.
        responses: {
          '201': {
            description: 'Payment intent requires the agent signature.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SignablePaymentIntent' },
              },
            },
          },
          '200': {
            description:
              'Idempotent replay of a request whose intent has already progressed to a terminal, ' +
              'reportable state. Body is an `AgentPaymentStatus` plus `idempotent_replay: true`. ' +
              'Deliberately NOT a strict $ref: `AgentPaymentStatus` is ' +
              '`additionalProperties: false`, so the replay marker is not a member of it — the ' +
              'permissive shape is the accurate one here, and narrowing it would be a claim the ' +
              'route does not honour.',
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
            ...errorResponse,
            description:
              'Idempotency conflict: the key already belongs to a payment with a different token, ' +
              'recipient or amount, or it replays an intent that is mid-flight ' +
              '(pending_signature / submitted). Only `payment_intents` carry the key — the ' +
              'approval-queue replay fallback is gone with the table (#2055).',
          },
          '429': { ...errorResponse, description: 'Money-path rate limit.' },
          '410': {
            ...errorResponse,
            description:
              'EITHER a retired rail — the Safe / AllowanceModule rail (#1986) or the session ' +
              'rail (#834), refused before anything is written and before any chain read, with a ' +
              'message naming POST /accounts/hybrid — OR an idempotent replay of a request whose ' +
              'intent has since expired. The two are distinguished by `idempotent_replay` on the ' +
              'body; only the first is a rail refusal.',
          },
          '502': {
            ...errorResponse,
            description:
              'Preparation failed against the chain, or an idempotent replay of a request whose ' +
              'payment has failed.',
          },
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
          'The signature must be produced outside Haven by the agent-held delegate key. ' +
          '#2105 (found by review): Haven does NOT verify it against the delegate address or an ' +
          'on-chain allowance, as this said — that was the retired AllowanceModule scheme ' +
          '(`sign_hash` + raw-ECDSA `recoverSigner`), which died with the rail (#1986). Haven ' +
          'now applies a SHAPE check only and relays; the real validator is the account itself ' +
          '(EIP-1271 / the 4337 signature check on the typed data) and the budget delegation\'s ' +
          'caveat enforcers on redemption. An intent pinned to a retired rail is refused 410 ' +
          'here rather than relayed.',
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
          '410': {
            ...errorResponse,
            description:
              'The intent is pinned to a retired rail — the AllowanceModule rail (#1986) or the ' +
              'session rail (#834) — or it has expired. A retired-rail intent is refused before ' +
              'the expiry flip, so nothing is written.',
          },
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
          'Creates or executes the Haven side of an x402 merchant request. Haven relays only ' +
          'independently signed payloads; it does not sign on behalf of the agent. The scheme ' +
          'follows the payTo shape: a merchant payTo builds an erc7710 settlement child ' +
          'delegation and settles account→merchant directly with NO funding leg; the EIP-3009 ' +
          'bridge (agent-EOA payTo + merchantPayTo) is the fallback and is the only shape that ' +
          'still funds anything. #2105: there is no approval branch — spend authority is the ' +
          'agent\'s budget delegation, refused up front with 403 when the amount exceeds the live ' +
          'remaining budget (#2082) and enforced on-chain by the caveat enforcers at redemption. ' +
          'Preserve the original merchant session and the x402 details. The client ' +
          'performs the merchant retry itself; nothing mid-flow waits for a resume ' +
          'signal. #2145: if the process dies after the funding leg confirms, a later ' +
          'GET /machine-payments/:id/status reports next_action ' +
          'retry_original_x402_request (funding confirmed, no merchant response ever ' +
          'recorded) — resume that payment instead of authorizing a new one.',
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
          // #2105: the 202 → X402PendingApproval branch is gone. No code path in
          // `modules/x402/**` emits 202 — the module's whole status set is
          // 200/201/400/403/404/409/410/429/502 — because the delegation rail
          // enforces budget on-chain (403 pre-funding, #2082, then the caveat
          // enforcer at redemption) instead of queuing an approval.
          '400': errorResponse,
          '401': errorResponse,
          '403': { ...errorResponse, description: 'Spend authority the agent does not have. Either it holds no active budget delegation for this token/merchant, or (#2082) the erc7710 direct-settlement amount exceeds that delegation\'s live remaining period budget. The over-budget refusal is PRE-FUNDING — no settlement child is built, no intent row is written, no delegate account is deployed — and carries error_code "delegation_budget_exceeded", phase "insufficient_funds", next_action "fund_safe_or_raise_allowance", plus remaining/remaining_atomic, amount/amount_atomic and shortfall/shortfall_atomic. It is a fail-fast convenience, not the gate: the budget delegation\'s ERC20PeriodTransferEnforcer still refuses an over-budget redemption on-chain, and a degraded budget read fails OPEN (the payment proceeds).' },
          '409': errorResponse,
          '410': { ...errorResponse, description: 'A retired rail: the Safe / AllowanceModule rail (#1986) or the session rail (#834). Fail-closed — nothing is written and no chain read is made. The message names POST /accounts/hybrid.' },
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
          // #2105: this alias is registered to the SAME `authorizeX402Handler`
          // as POST /x402/authorize, so its status set is identical. The 202 it
          // documented is unreachable for the same reason (see the note there);
          // the 200 and 410 it was missing are reachable for the same reason.
          '200': {
            description: 'Same response as POST /x402/authorize.',
            content: {
              'application/json': { schema: x402AuthorizeResponse },
            },
          },
          '201': {
            description: 'Same response as POST /x402/authorize.',
            content: {
              'application/json': { schema: x402AuthorizeResponse },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '409': errorResponse,
          '410': {
            ...errorResponse,
            description:
              'Same as POST /x402/authorize: a retired rail — Safe / AllowanceModule (#1986) or ' +
              'session (#834). Fail-closed, nothing written.',
          },
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
          'Rail-aware (#1135): on the delegation rail the response carries the ACTIVE budget delegations (remaining = the period budget; AllowanceModule-only fields are zeroed placeholders). BOTH retired rails answer 410 — the session rail (#993) and, since #2020 reversed #1986’s left-readable decision, the Safe/AllowanceModule rail too. Reporting only — enforcement stays on-chain.',
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
            description:
              'The account is on a RETIRED rail — session (#993) or Safe/AllowanceModule ' +
              '(#2020, reversing #1986’s left-readable decision on the recorded owner call: ' +
              'the accounts are emptied and unsupported, so no state is read). Fail-closed; ' +
              'nothing is read or written.',
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
        description:
          'Branch on next_action, never on message prose. #2145: a confirmed x402 EIP-3009 ' +
          'payment whose merchant leg was never reported (the agent died between the funding ' +
          'confirmation and the merchant retry) answers phase funded_but_unsettled with ' +
          'next_action retry_original_x402_request — resume that payment rather than starting a ' +
          'new one. A client-reported merchant rejection answers sweep_stranded_funds instead.',
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
        summary: 'RETIRED: plain transfer. Validates the body, then always refuses.',
        description:
          'RETIRED (#1987, epic #1440). This route belonged to the Safe / AllowanceModule rail ' +
          'and no longer has a success path: `modules/mpp/send.ts` is three refusals and nothing ' +
          'else. After body validation (400) the account\'s rail decides which refusal you get — ' +
          '**410** on either retired rail (Safe / AllowanceModule, #1986; session, #834) and ' +
          '**422** `rail_not_supported` on the delegation rail, which MPP never supported ' +
          '(#1251). Those three cases exhaust the HANDLER, so 2xx is unreachable here; the route ' +
          'in front of it can still answer 400, 401, 403 or 429. ' +
          'Fail-closed: no intent row, no approval row, no sign_data, no chain read. ' +
          'To send from a delegation-rail account use POST /payments, which redeems the agent\'s ' +
          'budget delegation directly. The operation stays documented rather than deleted because ' +
          'it is still registered and still answers — an integrator needs the refusal contract, ' +
          'not a 404.',
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
                    description:
                      'Validated (1–128 characters) and then IGNORED — nothing is deduplicated, ' +
                      'because every call refuses. Accepted only so an existing client is ' +
                      'refused by the rail rather than by a body error (#2105).',
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        // #2105: the 201 / 202 / 200 / 409 branches documented here described a
        // send path that was deleted with the rail (#1987). They were not merely
        // stale prose — a documented 2xx shape tells an integrator to write a
        // branch that can never run, and the 422 that DOES happen was missing
        // entirely. `handleSend` returns exactly one of the three refusals below
        // and `resolveExecutionRail`'s union has no fourth member, so there is
        // no success response left to describe.
        responses: {
          '400': {
            ...errorResponse,
            description:
              'Body validation, in `routes/machine-payments.ts` and therefore BEFORE the rail ' +
              'refusal: unsupported asset, malformed recipient, non-positive amount, or an ' +
              'idempotency_key outside 1–128 characters.',
          },
          '401': errorResponse,
          '403': agentAuthForbidden,
          '410': {
            ...errorResponse,
            description:
              'The account is on a retired rail — Safe / AllowanceModule (#1986) or session ' +
              '(#834). Fail-closed: nothing is written and no chain read is made. The message ' +
              'names POST /accounts/hybrid.',
          },
          '422': {
            ...errorResponse,
            description:
              'The account is on the delegation rail, which this MPP route never supported ' +
              '(#1251). `error_code` is `rail_not_supported` and the message names POST /payments ' +
              'and the x402 purchase flow. With both retired rails answering 410 above, this is ' +
              'the response every remaining account gets.',
          },
          // Reachable BEFORE the handler: the route carries `moneyPathRateLimit`.
          // The handler's three cases are exhaustive; the published response set
          // is not the handler's alone (#2105, review nit).
          '429': { ...errorResponse, description: 'Money-path rate limit.' },
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
        summary: 'Attach merchant proof evidence for a settled machine payment.',
        description:
          'Records proof-loop evidence for a settled x402 or MPP payment owned by the authenticated agent. This does not authorize or execute payment. On most schemes the payment is already confirmed and this only attaches merchant/protocol evidence. On erc7710 direct settlement the merchant redeems the delegation chain and Haven submits nothing, so this call is also what COMPLETES the payment: it verifies the reported txHash on-chain against the intent (token, payer, merchant, exact amount, and the settlement window) and confirms the intent before recording evidence. It fails closed — 409 when the transaction does not settle this payment or cannot be attributed to it unambiguously, 503 when the chain could not be read or the transaction is not mined yet; neither confirms anything.',
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
          // #2092: the erc7710 completion seam could not READ the chain (or the
          // reported settlement is not mined yet). Nothing was confirmed and
          // nothing was written — retry once the transaction is mined.
          '503': errorResponse,
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
          'Records a post-payment reconciliation marker when the merchant/protocol retry rejects or needs follow-up after a confirmed payment. The event is audit context only; it does not move funds. '
          + 'The payment is resolved scoped to the calling agent, so another agent\'s payment answers 404 with nothing written. '
          + '#2292: an acceptance is terminal — a merchant_retry_rejected_after_payment on a payment that already carries a client-reported merchant response (machine_payment_evidence proof_status merchant_response_observed or protocol_receipt_attached) answers 409 rather than re-opening a stranded-funds flag on a delivered payment.',
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
          'Entries are operator-curated and periodically re-verified against the live merchant 402 challenge; category matching is case-insensitive and search matches product name, description, or category. Blank search is rejected after trimming and non-empty search is capped at 120 characters; nothing here creates payments or signatures. **What `active` means, exactly (#1669):** verification exercises the 402 CHALLENGE only, so `active` says the merchant answers — it cannot say the merchant settles. One deliberate consequence is in the catalog on purpose: entries with `category: \'test-fixture\'` simulate failure modes (today, a stranded-funds simulator whose funding leg succeeds but which never settles); their name and description say so plainly, and clients that pre-filter should treat the category as the structural signal.',
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
    '/catalog/submit': {
      post: {
        tags: ['Catalog'],
        operationId: 'submitCatalogEntry',
        summary: 'Submit a payable (x402/MCP) endpoint for verification and listing.',
        description:
          'Public, unauthenticated self-service submission (epic #1717). Writes a queue row only and returns a `verify_token`; the request path makes **no outbound request of any kind** — nothing here probes, signs, or pays. The seller proves domain control (well-known token / DNS TXT) and a leader-locked, SSRF-hardened, read-only probe watches a real 402 challenge before anything is listed; listed means domain-controlled AND verified-payable, and verification exercises the 402 challenge only, never settlement. Submitting a host that already has a pending/active submission is a no-op returning the same id. A flood is bound by a per-IP rate limit and a capped pending queue (429), and the request body is capped at 8 KB (413). `resource_url` must be https and must NOT carry embedded credentials (`https://user:pass@host/`) — those are refused (400) rather than stored, so nothing downstream can replay them. A queued row is inert: it confers no listing and no standing until domain control and a live 402 challenge have both been observed. Money-path: none; no payment, signature, or authority change.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CatalogSubmitRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Submission accepted (or an existing pending submission for the same host).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CatalogSubmissionAccepted' },
              },
            },
          },
          '400': errorResponse,
          '413': errorResponse,
          '429': errorResponse,
        },
      },
    },
    '/catalog/submit/{id}': {
      get: {
        tags: ['Catalog'],
        operationId: 'getCatalogSubmissionStatus',
        summary: 'Public status of a catalogue submission (#1715).',
        description:
          'Coarse current state plus, while the domain-ownership proof is still valid, the exact well-known / DNS-TXT proof instructions. Deliberately minimal: the `verify_token` is never returned (it is a credential minted once at creation), and failures surface only as the coarse `failed` status — the granular SSRF/ownership reasons stay in server logs so this cannot become an internal-DNS oracle. 404 for an unknown id.',
        security: [],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'Submission status.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CatalogSubmissionStatus' },
              },
            },
          },
          '404': errorResponse,
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
      HybridAccountSigners: {
        type: 'object',
        description:
          "A hybrid account's signer set — the exact configuration the account address was derived from. Public key material plus per-credential enrollment time (#1679); nothing secret.",
        required: ['account_address', 'chain_id', 'owner_address', 'passkeys'],
        properties: {
          account_address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
          chain_id: { type: 'integer' },
          owner_address: { type: ['string', 'null'], pattern: '^0x[0-9a-fA-F]{40}$', description: 'Null for a pure-passkey account.' },
          passkeys: {
            type: 'array',
            items: {
              type: 'object',
              required: ['key_id', 'x', 'y', 'created_at'],
              properties: {
                key_id: { type: 'string' },
                x: { type: 'string' },
                y: { type: 'string' },
                created_at: {
                  type: ['string', 'null'],
                  format: 'date-time',
                  description:
                    'When this credential was enrolled (#1679) — the UI labels the row "Passkey · added {date}". Null only if the stored row is missing; clients fall back to ordinal "Passkey N" labels, never a platform name.',
                },
              },
            },
          },
        },
      },
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
          'asset_transfer_methods', 'verified_at', 'source', 'domain_verified', 'verified_payable',
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
          source: {
            type: 'string',
            enum: ['operator', 'ingestion'],
            description:
              'Where the entry came from. `operator` = curated in migrations/scripts (the operator vouches; no verification badges). `ingestion` = self-submitted through the Verified Payable Directory (epic #1717) and passed domain-ownership proof plus the read-only quote probe.',
          },
          domain_verified: {
            type: 'boolean',
            description:
              'True only for `ingestion` entries whose seller proved control of the endpoint domain. Always false for operator-curated rows, which have a different (operator) trust story.',
          },
          verified_payable: {
            type: 'boolean',
            description:
              'True only for `ingestion` entries that a leader-locked, SSRF-hardened, read-only probe watched answer a real x402 quote. The badge claims domain-control AND verified-payable — never merchant honesty, quality, or settlement reliability.',
          },
        },
      },
      CatalogSubmitRequest: {
        type: 'object',
        required: ['resource_url'],
        properties: {
          resource_url: {
            type: 'string',
            description:
              'https URL of the payable x402/MCP endpoint the seller wants verified and listed. This endpoint makes no request to it: the submission is queue-only, and ownership proof plus the verification probe run later, asynchronously under the leader-locked catalog monitor.',
          },
          website: {
            type: 'string',
            description:
              'Honeypot. Bots that fill this plausible-looking field are dropped with a fake success and nothing is written; human submitters leave it empty.',
          },
        },
        additionalProperties: false,
      },
      CatalogSubmissionAccepted: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          verify_token: {
            type: 'string',
            description:
              'Domain-ownership proof token. The seller proves control of the endpoint domain by serving the expected value at https://<host>/.well-known/haven-verify-<token>.txt (DNS TXT supported as fallback). Verification, and any public listing, waits for that proof; `submitted` alone guarantees nothing. PRESENT ONLY on the response to the request that created the submission — it is a credential minted for that one submitter. A request that de-duplicates onto an existing pending submission gets `id` and `status` only, so naming a hostname can never disclose another party\'s token.',
          },
          status: {
            type: 'string',
            // The de-duplicating response echoes the EXISTING row's state, which
            // by then may be further along than `submitted`.
            enum: ['submitted', 'ownership_verified', 'verified_payable'],
          },
        },
        additionalProperties: false,
      },
      CatalogOwnershipInstructions: {
        type: 'object',
        required: ['expires_at', 'well_known', 'dns_txt'],
        properties: {
          expires_at: { type: 'string', format: 'date-time' },
          well_known: {
            type: 'object',
            required: ['url', 'content', 'instruction'],
            properties: {
              url: { type: 'string' },
              content: { type: 'string' },
              instruction: { type: 'string' },
            },
            additionalProperties: false,
          },
          dns_txt: {
            type: 'object',
            required: ['name', 'value', 'instruction'],
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
              instruction: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      CatalogSubmissionStatus: {
        type: 'object',
        required: ['id', 'status', 'created_at', 'updated_at', 'last_verified_at', 'name', 'description', 'entrypoint'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          status: {
            type: 'string',
            enum: ['submitted', 'ownership_verified', 'verified_payable', 'failed', 'delisted'],
          },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
          last_verified_at: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
          name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          entrypoint: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          instructions: {
            anyOf: [{ $ref: '#/components/schemas/CatalogOwnershipInstructions' }, { type: 'null' }],
            description:
              'Present while the submission can still prove ownership (submitted / ownership_verified) and the deployment has CATALOG_OWNERSHIP_SECRET set. Absent once verified_payable, failed or delisted — the proof is no longer actionable.',
          },
        },
        additionalProperties: false,
      },
      // #2262: these two enums publish five values no live rail can produce —
      // `user_approval_required`, `user_execution_required`,
      // `waiting_for_additional_approvals`, `wait_for_user_approval`,
      // `wait_for_user_to_complete_payment`. They stay in the enum for wire
      // compatibility, but under a bare `description:` the spec told a raw-API
      // integrator only that the phase is "stable", while an SDK user reading
      // the same taxonomy has been warned since #2101 that these are retired.
      // `x-enumDescriptions` appeared ZERO times in the served spec before
      // this. The prose is the SDK's own, mirrored through
      // `domain/agent-payment-taxonomy.ts` and pinned verbatim by
      // `agent-payment-taxonomy.parity.test.ts` — not a second copy.
      AgentPaymentPhase: {
        type: 'string',
        enum: Object.values(AgentPaymentPhase),
        description: 'Stable Haven agent payment state phase.',
        'x-enumDescriptions': AgentPaymentPhaseDescriptions,
      },
      AgentPaymentNextAction: {
        type: 'string',
        enum: Object.values(AgentPaymentNextAction),
        description: 'Stable next action an agent should take for a Haven payment state.',
        'x-enumDescriptions': AgentPaymentNextActionDescriptions,
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
          trustProxy: {
            type: 'object',
            description:
              'Trust-proxy state (#1670): the hop count the process actually read, and ' +
              'whether the per-IP auth rate-limit tier is therefore armed. Exists because ' +
              'the armed/disarmed split is otherwise invisible from outside — the tier ' +
              'deliberately returns NO limit when the proxy is untrusted, which a probe ' +
              'cannot tell apart from a variable the process never saw.',
            required: ['hops', 'authRateLimitArmed'],
            properties: {
              hops: { type: 'integer' },
              authRateLimitArmed: { type: 'boolean' },
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
        description:
          'One requested budget on a connect setup. Its `allowance_amount` is ATOMIC — the opposite shape to ' +
          'the identically named field on AgentAllowance, which is the human-decimal delegation projection (#2295).',
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
          source: {
            type: 'string',
            maxLength: 64,
            description:
              'Discovery-source slug for connect attribution (#2302) — e.g. 402-page, registry, template, skill. Sanitized server-side; a malformed value is stored as null rather than refused.',
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
        description:
          'One element of an agent\'s derived budget view (GET /agents, GET /agents/{id}, PUT /agents/{id}; POST /agents carries it as a literal empty array). ' +
          'Projected from the agent\'s ACTIVE delegations, never from stored allowance rows (#1090/#2020). ' +
          'Its `allowance_amount` is HUMAN-DECIMAL — the opposite shape to the identically named field on ' +
          'AgentConnectionAllowance, which is atomic (#2295).',
        required: ['id', 'agent_id', 'token_address', 'token_symbol', 'allowance_amount', 'reset_period_min'],
        properties: {
          id: uuid,
          agent_id: uuid,
          token_address: address,
          token_symbol: { type: 'string' },
          allowance_amount: allowanceHumanAmount,
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
           * #1878: the hosted MCP server name this agent is wired as, exactly
           * as it appears in the user's MCP config — `haven` for the unnamed
           * pair, `haven-<slug>` for one connected with `--name`. Its signer
           * counterpart is `haven-signer` / `haven-signer-<slug>`.
           *
           * SELF-REPORTED by the connector at registration and a DISPLAY AID
           * ONLY: nothing keys off it, it is not unique, and it is not
           * identity. Use `id` for that.
           *
           * Null means never reported — an agent created straight through
           * `POST /agents`, one that predates #1878, or one connected by an
           * older connector. Null must NOT be rendered as the bare `haven`
           * pair: `--name` shipped in #1696, so named agents exist with no
           * recorded name, and guessing would mislabel exactly them.
           */
          mcp_server_name: { type: ['string', 'null'] },
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
            maxItems: 0,
            description:
              'RETIRED (#1440/#2020): per-token allowances died with the Safe rail. A non-empty array is refused with 400 — grant the agent a budget delegation after creation instead. The field survives (empty-only) so older clients sending `allowances: []` keep working.',
            items: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
        additionalProperties: false,
      },
      /**
       * #1445: lifted out of the inline `/agents/{id}/delegate-balance`
       * response so consumers can name it. The frontend imports the generated
       * `ApiSchema<'DelegateBalance'>` type from this component; keep this
       * schema as the load-bearing source for the response shape.
       */
      DelegateBalance: {
        type: 'object',
        required: ['delegate_address', 'safe_address', 'chain_id', 'eth', 'eth_atomic', 'usdc', 'usdc_atomic', 'usdc_address', 'sweep_min_usdc'],
        properties: {
          delegate_address: { type: 'string' },
          safe_address: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          chain_id: { type: 'integer' },
          eth: { type: 'string' },
          eth_atomic: { type: 'string' },
          usdc: { type: 'string' },
          usdc_atomic: { type: 'string' },
          usdc_address: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          sweep_min_usdc: {
            type: 'string',
            description: 'Minimum USDC balance eligible for gasless delegate recovery in human token units.',
          },
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
      // ── PendingApproval / X402PendingApproval (REMOVED, #2105) ──────────────
      //
      // Both schemas are deleted, not tombstoned, and the distinction is the
      // one #2055 drew for the /approvals paths. A tombstone earns its place
      // when something is still ON THE WIRE — a path that answers 410
      // (POST/DELETE /agents/{id}/allowances), or a field still serialized at a
      // fixed value (`pending_approvals`, `actionableApprovals`, both "always 0
      // since #2055"). Neither applies here: with the 202s on POST /payments,
      // POST /x402/authorize and POST /x402 gone, and with
      // `X402PendingApproval` dropped from the x402AuthorizeResponse oneOf, no
      // response in this document can carry either shape, so an integrator has
      // nothing left to decode. Keeping them would be worse than inert — a
      // named component schema reads as a shape you may receive.
      //
      // The removed comment on `PendingApproval` said direct approvals, x402
      // approvals "and future rail-specific approvals share this base shape",
      // which invited a builder to extend an approval taxonomy that epic #1440
      // retired. The delegation rail has no approval queue at all: budget is
      // enforced on-chain by the caveat enforcers, and an over-budget payment
      // reverts during gas estimation rather than queuing.
      //
      // Note what is NOT removed for symmetry: `AgentPaymentStatus.kind` keeps
      // `approval_request` in its enum. That one is a live wire enum on a route
      // that still serializes it, unreachable in practice but still declared by
      // the backend's own types — the #2055 wire-compatibility case, not this
      // one.
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
                  version: {
                    type: 'integer',
                    enum: [1, 2, 3],
                    description:
                      'Contents-derived, never chosen: 1 = hash-only (legacy rail); 2 = commits to the EIP-712 typedDataHash (delegation rail, #1138); 3 = additionally binds the payer identity (#1690). The enum previously claimed [1] while v2 had shipped — corrected here.',
                  },
                  message: {
                    type: 'string',
                    description: 'Haven-signed expected x402 context. Includes expiresAt when the funding window is time-bound.',
                  },
                  signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$' },
                  signer: address,
                },
                additionalProperties: false,
              },
              payer_delegate: {
                ...address,
                description:
                  "#1690: the delegate this quote was created FOR, bound inside the Haven-signed expected context (version 3). The edge signer refuses to sign when it is not its own delegate — the guard that turns a stale-host quote-as-A-sign-as-B into a named refusal instead of an on-chain revert. Emitted only when the deployment has flipped X402_EMIT_PAYER_CONTEXT (signer-first rollout).",
              },
              payer_agent_id: {
                type: 'string',
                description: "#1690: the paying agent's id, carried so the signer's refusal can name both sides. Same gate as payer_delegate.",
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
      // X402PendingApproval removed with `PendingApproval` (#2105) — see the
      // note at that schema's old site for why these two are deleted rather
      // than tombstoned.
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
              'Which rail this agent\'s account is on (#1306). `delegation` means spend is gated ' +
              'by the agent\'s active budget delegations, enforced on-chain by the caveat ' +
              'enforcers. `legacy` is the RETIRED Safe / AllowanceModule rail (#1986) and gates ' +
              'nothing any more — every payment entry point answers 410 for such an account, so ' +
              'read it as "this account cannot pay until it re-onboards via POST /accounts/hybrid", ' +
              'not as a second live policy primitive. Reporting only; the enum keeps both values ' +
              'because a retired-rail account can still read its own identity here.',
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
                // #2295: same value as AgentAllowance.allowance_amount, same
                // producer (rails/delegation-budget-view.ts), renamed on this
                // wire. It sits one key above `onchain.amount`, which is the
                // ATOMIC form of the same budget — two representations of one
                // number, side by side, both previously bare strings.
                configured_amount: allowanceHumanAmount,
                reset_period_min: { type: 'integer' },
                onchain: {
                  type: 'object',
                  required: ['amount', 'spent', 'remaining', 'effective_spent', 'reset_time_min', 'last_reset_min', 'nonce', 'is_reset_pending'],
                  properties: {
                    amount: {
                      type: 'string',
                      description:
                        'The configured period budget in ATOMIC units — the same budget as the sibling ' +
                        '`configured_amount`, which states it in whole token units. `spent`, `remaining` ' +
                        'and `effective_spent` are atomic too (#2295).',
                    },
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
                        'read failed and this is the fallback full configured budget. #2105: it is ' +
                        'now effectively always present, because this whole summary is a ' +
                        'delegation-rail response — since #2020 the retired Safe / AllowanceModule ' +
                        'rail answers 410 here rather than a summary, so there is no longer a ' +
                        'second rail for the field to be absent on. Reporting only — the on-chain ' +
                        'policy is the actual gate; this only says how fresh this number is.',
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
          approval_request_id: {
            anyOf: [uuid, { type: 'null' }],
            description:
              'Retained for wire compatibility; ALWAYS null. #2055 dropped `approval_requests`, so no receipt can be anchored to an approval any more.',
          },
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
          // #2097: backend-recorded initiator classification — never derived
          // in the frontend. `agent` = row carries agent attribution (confirmed
          // x402 intents, delegate sweeps, raw transfers matched to a
          // confirmed intent). `human` = reserved; no dashboard-initiated send
          // path populates it (mpp demo & /send retired). `unknown` = outbound
          // raw transfer with no matched intent. Absent for `direction: in`
          // rows.
          initiatedBy: {
            type: 'string',
            enum: ['agent', 'human', 'unknown'],
            description: 'Who initiated the transaction, recorded by the backend. `agent`: agent-attributed rows (confirmed x402 intents, delegate sweeps, raw transfers matched to a confirmed intent). `human`: reserved — nothing populates it today. `unknown`: outbound raw transfer with no matched intent. Absent for inbound (`direction: in`) rows.',
          },
          // #1705 (epic #1704). Read from the intent's `machine_metadata`
          // JSONB, which both delegation-rail branches already stamp
          // (`modules/x402/delegation-authorize.ts`).
          settlementScheme: {
            type: ['string', 'null'],
            enum: ['eip3009', 'erc7710', null],
            description:
              'Which settlement branch actually moved the money: `erc7710` (direct settlement, ' +
              'account → merchant, no funding leg) or `eip3009` (funded transfer — the budget ' +
              'delegation funds the delegate EOA, which then signs the standard EIP-3009 header). ' +
              'This is the settlement SCHEME and is three-way distinct from its neighbours: ' +
              '`source` is the payment PROTOCOL (x402, mpp_crypto, …), and the account\'s ' +
              '`execution_rail` is the ACCOUNT ARCHITECTURE (delegation vs the legacy ' +
              'AllowanceModule). Do not collapse them. Null when no scheme was recorded — ' +
              'non-machine transfers, and legacy-rail rows, which are structurally EIP-3009 but ' +
              'never stamp the key. Null-in-null-out: nothing is inferred or backfilled.',
          },
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
          // #2400: was a bare `{ type: 'string' }`, while the identical value
          // one route over is the named `allowanceHumanAmount` (#2295). Both
          // come from the same `rails/delegation-budget-view.ts` projection, so
          // a reader of the contract alone could not tell this one was HUMAN.
          // This is about #2295's "readable from the OpenAPI spec alone"
          // holding for this emitter too.
          //
          // #2408 corrected the sentence that stood here. It said naming the
          // schema "does not DISCRIMINATE the shape — the pattern admits a bare
          // integer by design", which is why the hand literal in
          // `dashboard.test.ts` was the ONLY guard on this route's digits. The
          // pattern now discriminates: `formatTokenValue` cannot emit a bare
          // integer other than '0', so an atomic `budget_atomic` here fails the
          // round trip. The literal STAYS, now as belt-and-braces rather than
          // as the sole guard.
          allowanceAmount: allowanceHumanAmount,
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
          actionableApprovals: { type: 'integer', description: 'Always 0 since #2055 — the approval queue died with the Safe rail and its table is dropped; the field survives for wire compatibility.' },
          pendingApprovals: { type: 'integer', description: 'Duplicate of actionableApprovals; always 0 since #2055, kept for compatibility.' },
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
      // ── Agent re-key (#1698, epic #1694) ──────────────────────────────
      //
      // Named rather than inline because the dashboard renders them (#1701).
      // The wire-type ratchet (#1447) refuses a hand-written copy of a shape
      // the spec could provide, and it is right to: a generated type proves
      // nothing while the code that renders keeps its own restatement, and
      // this flow revokes and re-issues spend authority.
      AgentRekeyResidual: {
        type: 'object',
        description:
          'Reported whether or not it is recoverable — nothing about a stranded residual fails quietly.',
        required: ['atomic', 'recoverable_after_rekey'],
        properties: {
          atomic: { type: 'string' },
          token_address: { type: 'string', nullable: true },
          disposition: { type: 'string', nullable: true },
          recoverable_after_rekey: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      /**
       * The revoke-prepare 200, discriminated by `signature_scheme` (#1870).
       *
       * Named rather than inline for the reason #1701 established: a response
       * body a client renders belongs in `components/schemas`, so the
       * dashboard imports one definition instead of restating it. Only the
       * nested `user_operation` stays open — it is bundler-shaped and the
       * client relays it back verbatim.
       */
      AgentRekeyRevokePrepare: {
        oneOf: [
          {
            type: 'object',
            description: 'The treasury EOA owner signs signing_payload (EIP-712).',
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
            description: 'An account passkey signs user_op_hash via WebAuthn.',
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
          {
            type: 'object',
            description:
              'Nothing to revoke on-chain — an agent that never held a budget, one already revoked, or one whose previous re-key was abandoned after its revoke landed (#1868). No signature is needed and the re-key advances straight to the metered stage. When an abandoned predecessor froze a carry after its own on-chain revoke and no grant has been made since, that measurement is INHERITED rather than forfeited: carry holds the frozen entries, tx_hash is the predecessor’s revoke transaction, and carry_inherited_from_rekey_id names the abandoned re-key. Otherwise the carry is empty.',
            required: ['revoked', 'stage', 'agent_has_no_authority', 'next_step'],
            properties: {
              revoked: { type: 'boolean', enum: [true] },
              tx_hash: {
                type: 'string',
                nullable: true,
                description:
                  'Null on the empty walk; the ABANDONED predecessor’s revoke transaction when its carry was inherited.',
              },
              // May be empty — the short-circuit revokes nothing on-chain.
              delegation_hashes: { type: 'array', items: delegationHash },
              stage: { type: 'string' },
              carry: {
                type: 'array',
                description:
                  'Empty on the plain short-circuit; the inherited frozen measurement when an abandoned predecessor’s carry was adopted (#1868).',
                items: {
                  type: 'object',
                  required: ['delegation_hash', 'remaining_atomic', 'from_chain'],
                  properties: {
                    delegation_hash: delegationHash,
                    remaining_atomic: { type: 'string' },
                    from_chain: { type: 'boolean' },
                  },
                },
              },
              carry_inherited_from_rekey_id: {
                type: 'string',
                format: 'uuid',
                description:
                  'Present only when the carry was inherited: the abandoned re-key whose frozen measurement this re-key adopted (#1868).',
              },
              agent_has_no_authority: { type: 'boolean' },
              next_step: { type: 'string' },
            },
          },
        ],
      },
      AgentRekeyPreflight: {
        type: 'object',
        required: [
          'rekey_id',
          'stage',
          'old_delegate_address',
          'new_delegate_address',
          'residual',
          'delegations_to_revoke',
          'next_step',
        ],
        properties: {
          rekey_id: { type: 'string', format: 'uuid' },
          stage: { type: 'string', enum: ['preflight'] },
          old_delegate_address: address,
          new_delegate_address: address,
          residual: { $ref: '#/components/schemas/AgentRekeyResidual' },
          delegations_to_revoke: { type: 'array', items: delegationHash },
          next_step: { type: 'string' },
          ordering_note: { type: 'string' },
        },
      },
      AgentRekeyIssuedDelegation: {
        type: 'object',
        required: ['delegation_hash', 'carry_role', 'token_address', 'budget_atomic', 'signing_payload'],
        properties: {
          delegation_hash: delegationHash,
          carry_role: { type: 'string', enum: ['carry', 'steady', 'reanchor'] },
          token_address: address,
          recipient_address: { type: 'string', nullable: true },
          budget_atomic: { type: 'string' },
          period_seconds: { type: 'integer' },
          start_date: { type: 'integer' },
          expires_at: { type: 'integer' },
          signing_payload: eip712Payload,
        },
      },
      AgentRekeyIssueResponse: {
        type: 'object',
        required: ['stage', 'delegate_account_address', 'delegations'],
        properties: {
          stage: { type: 'string', enum: ['issued'] },
          delegate_account_address: address,
          delegations: {
            type: 'array',
            items: { $ref: '#/components/schemas/AgentRekeyIssuedDelegation' },
          },
          skipped: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                delegation_hash: delegationHash,
                reason: { type: 'string' },
              },
            },
          },
          carry_note: { type: 'string' },
          next_step: { type: 'string' },
        },
      },
      AgentRekeyCompleteResponse: {
        type: 'object',
        required: [
          'completed',
          'stage',
          'agent_id',
          'new_delegate_address',
          'api_key',
          'api_key_prefix',
          'old_api_key_revoked',
        ],
        properties: {
          completed: { type: 'boolean' },
          stage: { type: 'string', enum: ['completed'] },
          agent_id: { type: 'string', format: 'uuid' },
          new_delegate_address: address,
          api_key: {
            type: 'string',
            description: 'Shown ONCE. Never stored in plaintext and never logged.',
          },
          api_key_prefix: { type: 'string' },
          old_api_key_revoked: { type: 'boolean' },
          invalidated_intents: { type: 'integer' },
          superseded_delegations: { type: 'integer' },
          residual_on_old_delegate: {
            type: 'object',
            properties: {
              atomic: { type: 'string' },
              recoverable: { type: 'boolean' },
              note: { type: 'string' },
            },
          },
        },
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
