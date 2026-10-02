/**
 * The mocked `/ops/*` fixture for the ops screenshot harness (#3516).
 *
 * WHY THIS EXISTS: the design-reviewer pass captures rendered screens, and
 * the console's pages render REAL customer records on the dev backend. A
 * capture made against the dev backend would put customer PII into PR
 * screenshots. So every capture run answers `/ops/*` from THIS module — fake,
 * deterministic, masked exactly the way the backend serves masked values —
 * and the harness refuses to boot without it. Captures are NEVER made
 * against a real backend.
 *
 * Shapes mirror the wire types (#3512/#3513/#3514): every field the pages
 * read is present, so a fixture-shape gap reads as a missing key here and
 * not as a crashed page in a PNG. Amounts are atomic decimal strings; emails
 * and names are masked at rest (the reveal endpoint is the only unmasked
 * shape in the file, one field, as `POST /ops/reveal` serves).
 */

/** The backend origin the capture registry names — RFC 2606 `.invalid`, so a fixture gap can never fall through to a real host. */
export const FIXTURE_BACKEND_ORIGIN = 'https://ops-backend.fixture'

/** The customer id every customer-page capture renders. A fixed UUID. */
export const FIXTURE_USER_ID = '9d1f4c0a-6b2e-4f3a-9c8d-1e2f3a4b5c6d'

export const FIXTURE_TOKEN = 'fixture-ops-token-not-a-credential'

const GENERATED_AT = '2026-10-02T06:00:00.000Z'

const me = {
  github_id: '5090',
  login: 'ops-fixture',
  expires_at: '2026-10-02T14:00:00.000Z',
}

const overview = {
  users: 1284,
  smart_accounts: [
    { chain_id: 100, account_type: 'delegator_hybrid', count: 812 },
    { chain_id: 8453, account_type: 'delegator_hybrid', count: 96 },
    { chain_id: 100, account_type: 'legacy_safe', count: 340 },
  ],
  agents_by_status: [
    { status: 'active', count: 214 },
    { status: 'paused', count: 31 },
    { status: 'revoked', count: 58 },
  ],
  active_delegations: 189,
  payment_intents_24h: [
    { status: 'confirmed', count: 342 },
    { status: 'failed', count: 7 },
    { status: 'expired', count: 4 },
  ],
  payment_refusals_24h: [
    { reason: 'delegation_budget_exceeded', count: 5 },
    { reason: 'no_delegation_for_target', count: 2 },
    { reason: 'delegation_expired', count: 1 },
  ],
  generated_at: GENERATED_AT,
}

const search = {
  key_type: 'uuid',
  hits: [
    {
      kind: 'user',
      id: FIXTURE_USER_ID,
      email: 'da•••@gmail.com',
      created_at: '2026-03-14T09:12:00.000Z',
    },
    {
      kind: 'agent',
      id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      user_id: FIXTURE_USER_ID,
      status: 'active',
      delegate_address: '0x7A3f5c1E9b2D4A86F0c7e5138D9A4b62c0e1F37d',
      created_at: '2026-04-02T11:30:00.000Z',
    },
    {
      kind: 'payment_intent',
      id: '5c2e8f1a-3d5f-4a6c-8e0b-2f4d6a8c0e1f',
      user_id: FIXTURE_USER_ID,
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      status: 'confirmed',
      chain_id: 100,
      created_at: '2026-10-01T18:04:00.000Z',
    },
    {
      kind: 'smart_account',
      id: '7b9d2c4e-6f8a-4b0c-9d1e-3f5a7b9c0e2d',
      user_id: FIXTURE_USER_ID,
      chain_id: 100,
      account_address: '0x9f8f72aA9304c8B593d555F12eF6589cC3A579A2',
      account_type: 'delegator_hybrid',
    },
    {
      // The typed lane hit: NO user_id — the page must show the lane, not a user.
      kind: 'system_tx',
      id: 'e4a6b8c0-2d4f-4a6b-8c0e-4f6a8b0c2d4e',
      chain_id: 100,
      submitter: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
      status: 'mined',
      created_at: '2026-10-01T17:55:00.000Z',
    },
  ],
  timed_out: [],
}

const userDetail = {
  user: {
    id: FIXTURE_USER_ID,
    email: 'da•••@gmail.com',
    name: 'D•••',
    created_at: '2026-03-14T09:12:00.000Z',
  },
  smart_accounts: [
    {
      id: '7b9d2c4e-6f8a-4b0c-9d1e-3f5a7b9c0e2d',
      chain_id: 100,
      account_address: '0x9f8f72aA9304c8B593d555F12eF6589cC3A579A2',
      account_type: 'delegator_hybrid',
      execution_rail: 'delegation',
      name: 'Main account',
      created_at: '2026-03-14T09:15:00.000Z',
    },
    {
      id: '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
      chain_id: 8453,
      account_address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      account_type: 'delegator_hybrid',
      execution_rail: 'delegation',
      name: 'Base account',
      created_at: '2026-06-20T14:40:00.000Z',
    },
    {
      id: '11111111-2222-4333-8444-555555555555',
      chain_id: 84532,
      account_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      account_type: 'legacy_safe',
      execution_rail: 'legacy',
      name: 'Old Base Sepolia Safe',
      created_at: '2025-11-02T08:00:00.000Z',
    },
  ],
  agents: [
    {
      id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      account_id: '7b9d2c4e-6f8a-4b0c-9d1e-3f5a7b9c0e2d',
      name: 'Research agent',
      status: 'active',
      delegate_address: '0x7A3f5c1E9b2D4A86F0c7e5138D9A4b62c0e1F37d',
      created_at: '2026-04-02T11:30:00.000Z',
      archived_at: null,
    },
    {
      id: '2a4b6c8d-0e2f-4a6c-8e0b-2d4f6a8c0e2b',
      account_id: null,
      name: 'Data-feed agent',
      status: 'revoked',
      delegate_address: null,
      created_at: '2026-01-10T10:00:00.000Z',
      archived_at: '2026-08-11T09:00:00.000Z',
    },
  ],
  active_delegations: [
    {
      id: '3c5d7e9f-1a3b-4c5d-9e7f-1a3c5e7f9a1b',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      chain_id: 100,
      token_address: '0x2a22f9c3b484c3629090FeD35F2F0fA482F2DB0E',
      recipient_address: null,
      merchant_id: null,
      budget_atomic: '250000000',
      period_seconds: 604800,
      start_date: 1789900000,
      expires_at: 1799982400,
    },
    {
      id: '4d6e8f0a-2b4c-4d6e-8f0a-2b4d6f8a0c2e',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      chain_id: 8453,
      token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      recipient_address: '0x9f8f72aA9304c8B593d555F12eF6589cC3A579A2',
      merchant_id: null,
      budget_atomic: '50000000',
      period_seconds: 86400,
      start_date: 1790000000,
      expires_at: 1799000000,
    },
  ],
  payment_intents: [
    {
      id: '5c2e8f1a-3d5f-4a6c-8e0b-2f4d6a8c0e1f',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      status: 'confirmed',
      chain_id: 100,
      token_symbol: 'USDC',
      amount_human: '12.50',
      to_address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      error_message: null,
      created_at: '2026-10-01T18:04:00.000Z',
    },
    {
      id: '6d3f9a2b-4e6a-4b7c-9f1c-3a5d7e9f0b2d',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      status: 'failed',
      chain_id: 100,
      token_symbol: 'USDC',
      amount_human: '30.00',
      to_address: '0x9f8f72aA9304c8B593d555F12eF6589cC3A579A2',
      error_message: 'x402 retry failed after the delegate wallet was funded — payment outcome unknown, do not recreate (poll haven_get_payment_status).',
      created_at: '2026-09-28T10:22:00.000Z',
    },
    {
      id: '7e4a0b3c-5f7b-4c8d-8a2d-4b6e8f0a1c3e',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      status: 'expired',
      chain_id: 8453,
      token_symbol: 'USDC',
      amount_human: '4.00',
      to_address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
      error_message: null,
      created_at: '2026-09-20T12:00:00.000Z',
    },
  ],
  payment_refusals: [
    {
      id: '8f5b1c4d-6a8c-4d9e-9b3e-5c7f9a1b2d4f',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      chain_id: 100,
      token_symbol: 'USDC',
      amount_atomic: '40000000',
      reason: 'delegation_budget_exceeded',
      source: 'x402_authorize',
      created_at: '2026-10-01T09:40:00.000Z',
    },
    {
      id: '9a6c2d5e-7b9d-4e0f-8c4f-6d8a0b2c3e5a',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      chain_id: 8453,
      token_symbol: 'USDC',
      amount_atomic: '2500000',
      reason: 'no_delegation_for_target',
      source: 'payment',
      created_at: '2026-09-30T16:22:00.000Z',
    },
    {
      id: '0b7d3e6f-8c0e-4f1a-9d5a-7e9b1c3d4f6b',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      chain_id: 100,
      token_symbol: 'USDC',
      amount_atomic: '900000',
      reason: 'delegation_expired',
      source: 'payment',
      created_at: '2026-09-29T08:15:00.000Z',
    },
    {
      id: '1c8e4f7a-9d1f-4a2b-8e6b-8f0c2d4e5a7c',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      chain_id: 100,
      token_symbol: 'USDC',
      amount_atomic: '110000',
      reason: 'onchain_revert',
      source: 'redeem',
      created_at: '2026-09-25T19:05:00.000Z',
    },
  ],
}

const onchainView = {
  user_id: FIXTURE_USER_ID,
  accounts: [
    {
      account_id: '7b9d2c4e-6f8a-4b0c-9d1e-3f5a7b9c0e2d',
      chain_id: 100,
      account_address: '0x9f8f72aA9304c8B593d555F12eF6589cC3A579A2',
      account_type: 'delegator_hybrid',
      execution_rail: 'delegation',
      name: 'Main account',
      db: {
        active_delegations: [{ budget_atomic: '250000000' }],
      },
      chain: {
        deploy_status: 'deployed',
        delegations: [
          {
            budget_atomic: '250000000',
            onchain: 'enabled',
            budget_status: 'unavailable',
            budget_remaining_atomic: null,
          },
        ],
      },
      flags: {
        counterfactual_with_active_delegation: false,
        delegation_disabled_onchain_active_in_db: false,
      },
    },
    {
      account_id: '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
      chain_id: 8453,
      account_address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      account_type: 'delegator_hybrid',
      execution_rail: 'delegation',
      name: 'Base account',
      db: {
        active_delegations: [{ budget_atomic: '500000000' }],
      },
      chain: {
        deploy_status: 'counterfactual',
        delegations: [
          {
            budget_atomic: '500000000',
            onchain: 'enabled',
            budget_status: 'from_chain',
            budget_remaining_atomic: '420000000',
          },
        ],
      },
      flags: {
        counterfactual_with_active_delegation: true,
        delegation_disabled_onchain_active_in_db: false,
      },
    },
    {
      account_id: '11111111-2222-4333-8444-555555555555',
      chain_id: 84532,
      account_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      account_type: 'legacy_safe',
      execution_rail: 'legacy',
      status: 'not_served',
      reason: 'legacy_safe',
    },
  ],
  generated_at: GENERATED_AT,
}

const health = {
  sweepable_intents: [
    {
      id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      chain_id: 100,
      token_symbol: 'USDC',
      amount_human: '8.00',
      status: 'submitted',
      window: 'in_window',
      age_seconds: 3600,
    },
    {
      id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      agent_id: '2a4b6c8d-0e2f-4a6c-8e0b-2d4f6a8c0e2b',
      chain_id: 8453,
      token_symbol: 'USDC',
      amount_human: '15.25',
      status: 'submitted',
      window: 'past_horizon',
      age_seconds: 172800,
    },
  ],
  evidence_orphans: [
    {
      id: 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      chain_id: 100,
      token_symbol: 'USDC',
      amount_human: '6.40',
      status: 'confirmed',
      age_seconds: 86400,
    },
  ],
  stuck_revocations: [
    {
      agent_id: '2a4b6c8d-0e2f-4a6c-8e0b-2d4f6a8c0e2b',
      revocation_requested_at: '2026-10-01T20:00:00.000Z',
      revocation_attempts: 3,
      age_seconds: 36000,
    },
  ],
  stuck_reanchors: [
    {
      agent_id: '2a4b6c8d-0e2f-4a6c-8e0b-2d4f6a8c0e2b',
      agent_eoa: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
      delegate_address: '0x7A3f5c1E9b2D4A86F0c7e5138D9A4b62c0e1F37d',
      revocation_attempts: 2,
    },
  ],
  stuck_lanes: [
    {
      id: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b',
      chain_id: 100,
      submitter: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
      nonce: '42',
      age_seconds: 600,
      reason: 'stale_unmined',
    },
    {
      id: 'f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c',
      chain_id: 8453,
      submitter: '0x7A3f5c1E9b2D4A86F0c7e5138D9A4b62c0e1F37d',
      nonce: '7',
      age_seconds: 90000,
      reason: 'capped_needs_operator',
    },
  ],
  delegate_balances: {
    available: true,
    scanned_at: '2026-10-02T05:30:00.000Z',
    report: {
      scanned_delegates: 1612,
      unread: 3,
      lingering: [
        {
          agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
          agent_name: 'Research agent',
          delegate_address: '0x7A3f5c1E9b2D4A86F0c7e5138D9A4b62c0e1F37d',
          chain_id: 100,
          balance_atomic: '30000000',
        },
      ],
      dust_total_atomic: '412000',
      dust_alert: false,
      chain_errors: {},
    },
  },
  ops_diagnostics: {
    relayer: [
      {
        chainId: 100,
        address: '0x1111111111111111111111111111111111111111',
        balanceWei: '2500000000000000',
        low: false,
        checkedAt: '2026-10-02T05:00:00.000Z',
      },
      {
        chainId: 8453,
        address: '0x1111111111111111111111111111111111111111',
        balanceWei: '9000000000000',
        low: true,
        checkedAt: '2026-10-02T05:30:00.000Z',
      },
    ],
    passport: {
      verification: { configured: true, issuer: '0x9999999999999999999999999999999999999991' },
      chains: [
        { chainId: 100, issuanceConfigured: true, verificationConfigured: true, state: 'ready' },
        { chainId: 8453, issuanceConfigured: true, verificationConfigured: false, state: 'issuance_only' },
      ],
      unverifiableChainIds: [],
    },
    trustProxy: { hops: 1, authRateLimitArmed: true },
    accounting: {
      exhaustedSyncs: 0,
      connectionsNeedingAttention: 1,
      webhookCounters: {
        received: 4210,
        bad_signature: 0,
        stale: 6,
        unknown_token: 0,
        duplicate: 3,
        processed: 4198,
        feature_off: 0,
        unknown_type: 0,
        confirmed: 4198,
      },
    },
    request_validation: {
      mode: 'shadow',
      wouldRefuse: 2,
      wouldCoerce: 0,
      byRouteField: {},
      coerceByRouteField: {},
      since: '2026-09-25T00:00:00.000Z',
      seenByRoute: {},
    },
  },
  generated_at: GENERATED_AT,
}

const docHealth = {
  generatedAt: GENERATED_AT,
  unverifiedDays: 90,
  notes: [
    '`no-front-matter` and `no-owner` cannot fire on a governed doc: validate-frontmatter.mjs is a hard CI gate (docs:check), so an empty column is the expected state, not a broken instrument.',
    '`unverified-90d` is age only: `last-verified` more than 90 days before `generatedAt`, excluding `status: archived|research`. It is NOT the commit-based staleness signal.',
    '`empty-covers` is a doc with `covers: []` — a deliberately uncoupled doc, not an error.',
  ],
  total: 6,
  counts: {
    'no-front-matter': 1,
    'no-owner': 0,
    'empty-covers': 1,
    'unverified-90d': 2,
  },
  docs: [
    { path: 'README.md', owner: '@d-hinders', status: 'current', lastVerified: '2026-09-28', flags: [] },
    { path: 'docs/architecture/03-payment-sequence.md', owner: '@d-hinders', status: 'current', lastVerified: '2026-06-01', flags: ['unverified-90d'] },
    { path: 'docs/contributing/ai-agent-workflow.md', owner: '@d-hinders', status: 'current', lastVerified: '2026-09-20', flags: [] },
    { path: 'docs/operations/runbook.md', owner: null, status: null, lastVerified: null, flags: ['no-front-matter'] },
    { path: 'docs/product/design-system.md', owner: '@d-hinders', status: 'current', lastVerified: '2025-11-30', flags: ['unverified-90d', 'empty-covers'] },
    { path: 'docs/regulatory/casp-risk-guardrails.md', owner: '@d-hinders', status: 'current', lastVerified: '2026-09-30', flags: [] },
  ],
}

/**
 * The route-keyed fixture. Each entry is `[urlPattern, status, body]`; the
 * harness registers them with `page.route`, so NOTHING here can reach a
 * real backend even if the console had a bug in its URL building — the
 * registry origin is a `.invalid` host and only these patterns answer.
 */
export function fixtureRoutes() {
  return [
    [`${FIXTURE_BACKEND_ORIGIN}/ops/me`, 200, me],
    [`${FIXTURE_BACKEND_ORIGIN}/ops/overview`, 200, overview],
    [`${FIXTURE_BACKEND_ORIGIN}/ops/search*`, 200, search],
    [`${FIXTURE_BACKEND_ORIGIN}/ops/users/${FIXTURE_USER_ID}/onchain`, 200, onchainView],
    [`${FIXTURE_BACKEND_ORIGIN}/ops/users/${FIXTURE_USER_ID}`, 200, userDetail],
    [`${FIXTURE_BACKEND_ORIGIN}/ops/health`, 200, health],
    [`${FIXTURE_BACKEND_ORIGIN}/ops/reveal`, 200, { target_type: 'user', target_id: FIXTURE_USER_ID, field: 'email', value: 'daniel@fixture.example' }],
    ['**/ops-doc-health.json', 200, docHealth],
  ]
}

/** The storage seed: one token, filed under the fixture backend's origin. */
export function fixtureStorageSeed() {
  return { key: `haven.ops.token.${FIXTURE_BACKEND_ORIGIN}`, value: FIXTURE_TOKEN }
}
