import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import paymentRoutes from '../payments.js'
import { allowanceModuleRailRetired } from '../../rails/execution-rail.js'

const { mockQuery, allowanceMocks, fiatMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    getLatestBlockTimeSec: vi.fn(),
    computeEffectiveAllowance: vi.fn(),
    generateTransferHash: vi.fn(),
    recoverSigner: vi.fn(),
    executeAllowanceTransfer: vi.fn(),
  },
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
    getBookTimeSekValue: vi.fn().mockResolvedValue(null),
  },
}))

// The nonce coordinator (#1196) is fail-open and orthogonal to what these
// tests assert; stub the repository so its reads never reach the dispatcher.
vi.mock('../../infra/repositories/allowance-nonce-watermarks.js', () => ({
  findAllowanceNonceWatermark: async () => null,
  raiseAllowanceNonceWatermark: async () => {},
}))
vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../rails/allowance-module.js', () => allowanceMocks)
// #1207: the delegation replay derives the account address; pin it so the
// reconstructed typed data is assertable without a chain read.
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: async () => '0x' + 'dd'.repeat(20) }
})
vi.mock('../../infra/fiat-values.js', () => fiatMocks)

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Payment Agent',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 100,
  status: 'active',
}

const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const TOKEN = '0x0000000000000000000000000000000000000000'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const SIGN_HASH = `0x${'11'.repeat(32)}`
const SIGNATURE = `0x${'ab'.repeat(65)}`
const TX_HASH = `0x${'cd'.repeat(32)}`

// ── Content-dispatch DB stub (#1226) ─────────────────────────────────────────
//
// Routes match on SQL FRAGMENTS, first hit wins, anything unmatched returns
// zero rows. This replaces the positional mockResolvedValueOnce chains that
// re-shuffled whenever a handler gained a query (#775) — what the database
// DOES with these statements is proven in the repository suites on the real
// harness (payment-intents.test.ts et al., epic #1219); these tests own only
// the handler: status codes, response shapes, and which writes were asked for.

type DbRoute = [RegExp, (sql: string, params: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>]

function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const text = String(sql)
    for (const [re, handler] of routes) {
      if (re.test(text)) return handler(text, params)
    }
    return { rows: [] }
  })
}

/** Every SQL text the handler sent, for pattern-based assertions. */
const sqlCalls = () => mockQuery.mock.calls.map((c) => ({ sql: String(c[0]), params: c[1] as unknown[] }))
const findCall = (re: RegExp) => sqlCalls().find((c) => re.test(c.sql))

const AUTH: DbRoute = [/api_key_hash = \$1/, () => ({ rows: [AGENT] })]

function pendingIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    agent_id: AGENT.id,
    user_id: AGENT.user_id,
    safe_address: AGENT.safe_address,
    chain_id: AGENT.chain_id,
    token_symbol: 'xDAI',
    token_address: TOKEN,
    to_address: RECIPIENT.toLowerCase(),
    amount_raw: '1000000000000000000',
    amount_human: '1',
    delegate_address: AGENT.delegate_address,
    allowance_nonce: 7,
    sign_hash: SIGN_HASH,
    signature: null,
    tx_hash: null,
    status: 'pending_signature',
    error_message: null,
    created_at: '2026-05-13T10:00:00.000Z',
    signed_at: null,
    submitted_at: null,
    confirmed_at: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function x402Approval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-123',
    chain_id: 8453,
    token_symbol: 'USDC',
    token_address: USDC,
    amount_human: '0.01',
    amount_raw: '10000',
    status: 'pending',
    tx_hash: null,
    expires_at: '2099-01-02T00:00:00.000Z',
    source: 'x402',
    payment_rail: 'x402',
    payment_resource_url: 'https://mcp.soundside.ai/mcp',
    x402_resource_url: 'https://mcp.soundside.ai/mcp',
    merchant_address: RECIPIENT.toLowerCase(),
    machine_challenge_id: null,
    machine_idempotency_key: 'x402:approval',
    machine_metadata: JSON.stringify({
      protocol: 'x402',
      network: 'base',
      description: 'create_image via luma',
    }),
    ...overrides,
  }
}

function mppApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-mpp',
    chain_id: 8453,
    token_symbol: 'USDC',
    token_address: USDC,
    amount_human: '0.01',
    amount_raw: '10000',
    status: 'pending',
    tx_hash: null,
    expires_at: '2099-01-02T00:00:00.000Z',
    source: 'mpp_demo',
    payment_rail: 'mpp_demo',
    payment_resource_url: 'https://haven.example/demo/mpp/market-summary',
    x402_resource_url: null,
    merchant_address: RECIPIENT.toLowerCase(),
    machine_challenge_id: 'challenge-123',
    machine_idempotency_key: 'mpp_demo:test',
    machine_metadata: JSON.stringify({
      protocol: 'mpp',
      network: 'base',
      description: 'Haven market summary demo',
    }),
    ...overrides,
  }
}

/** The approval row as BOTH the status probe and the resume fetch see it. */
const approvalRoute = (row: Record<string, unknown> | null): DbRoute => [
  /FROM approval_requests/,
  () => ({ rows: row ? [row] : [] }),
]

describe('payment routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    for (const mock of Object.values(allowanceMocks)) mock.mockReset()
    for (const mock of Object.values(fiatMocks)) mock.mockReset()
    fiatMocks.getBookTimeSekValue.mockResolvedValue(null)
  })

  it('rehydrates x402 resume state from an approval request id', async () => {
    primeDb(AUTH, approvalRoute(x402Approval()))

    const response = await app.inject({
      method: 'GET',
      url: '/payments/approval-123/resume_state',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      rail: 'x402',
      paymentId: 'approval-123',
      idempotencyKey: 'x402:approval',
      url: 'https://mcp.soundside.ai/mcp',
      resourceUrl: 'https://mcp.soundside.ai/mcp',
      description: 'create_image via luma',
      amountAtomic: '10000',
      amount: '0.01',
      token: 'USDC',
      asset: USDC,
      network: 'base',
      chainId: 8453,
      merchantAddress: RECIPIENT.toLowerCase(),
      paymentRequired: {
        x402Version: 2,
        resource: {
          url: 'https://mcp.soundside.ai/mcp',
          description: 'create_image via luma',
        },
      },
      accepted: {
        scheme: 'exact',
        network: 'base',
        amount: '10000',
        maxAmountRequired: '10000',
        resource: 'https://mcp.soundside.ai/mcp',
        description: 'create_image via luma',
        asset: USDC,
        payTo: RECIPIENT.toLowerCase(),
        maxTimeoutSeconds: 30,
      },
    })
  })

  it('rehydrates MPP resume state from an approval request id', async () => {
    primeDb(AUTH, approvalRoute(mppApproval()))

    const response = await app.inject({
      method: 'GET',
      url: '/payments/approval-mpp/resume_state',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      rail: 'mpp',
      paymentRail: 'mpp_demo',
      paymentId: 'approval-mpp',
      idempotencyKey: 'mpp_demo:test',
      url: 'https://haven.example/demo/mpp/market-summary',
      resourceUrl: 'https://haven.example/demo/mpp/market-summary',
      description: 'Haven market summary demo',
      amountAtomic: '10000',
      amount: '0.01',
      token: 'USDC',
      asset: USDC,
      network: 'base',
      chainId: 8453,
      merchantAddress: RECIPIENT.toLowerCase(),
      expiresAt: '2099-01-02T00:00:00.000Z',
      challenge: {
        rail: 'mpp_demo',
        challengeId: 'challenge-123',
        resource: 'https://haven.example/demo/mpp/market-summary',
        description: 'Haven market summary demo',
        network: { chainId: 8453, name: 'base' },
        asset: { symbol: 'USDC', address: USDC, decimals: 6 },
        amount: { display: '0.01', atomic: '10000' },
        recipient: RECIPIENT.toLowerCase(),
        expiresAt: '2099-01-02T00:00:00.000Z',
      },
    })
  })

  it('does not rehydrate resume state for another agent payment or approval', async () => {
    primeDb(AUTH, approvalRoute(null))

    const response = await app.inject({
      method: 'GET',
      url: '/payments/approval-123/resume_state',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'Payment or approval request not found' })
  })

  it('returns 410 when an approval resume state has expired', async () => {
    primeDb(AUTH, approvalRoute(x402Approval({ status: 'expired' })))

    const response = await app.inject({
      method: 'GET',
      url: '/payments/approval-123/resume_state',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json()).toMatchObject({
      error: 'Payment approval expired and cannot be resumed',
      error_code: 'expired',
      payment_id: 'approval-123',
      rail: 'x402',
      status: 'expired',
    })
  })

  it('returns 422 with rail_not_resumable for documented rails the resume surface does not implement', async () => {
    // `AgentPaymentRail` declares `stripe_deposit` and `spt` as valid rails
    // (the wire / OpenAPI surface accepts them) but the resume-state
    // endpoint only implements x402 and MPP today. Clients must be able to
    // distinguish "rail not supported" from generic "cannot resume right
    // now" — the structured error_code makes that pattern-matchable.
    primeDb(
      AUTH,
      approvalRoute(x402Approval({ source: 'stripe_deposit', payment_rail: 'stripe_deposit' })),
    )

    const response = await app.inject({
      method: 'GET',
      url: '/payments/approval-123/resume_state',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      error_code: 'rail_not_resumable',
      payment_id: 'approval-123',
      rail: 'stripe_deposit',
    })
  })

  // ── POST /:id/sign — the claim → execute → confirm handler ─────────────
  //
  // The claim CAS, double-claim refusal, release-on-429 and expiry guards
  // are PROVEN against real Postgres in payment-intents.test.ts; here the
  // routes' outcomes are driven by what those statements return, and the
  // assertions are about status codes, bodies, and which writes were asked.

  /** Sign-path routes: what the claim/confirm/release statements answer. */
  function signRoutes(opts: {
    intent?: Record<string, unknown>
    claimWins?: boolean
    statusNow?: string
    overdueExpires?: boolean
  }): DbRoute[] {
    return [
      AUTH,
      [/SET signature[\s\S]*status = 'submitted'/, () => ({ rows: opts.claimWins ? [{ id: PAYMENT_ID }] : [] })],
      [/SET status = 'confirmed'/, () => ({ rows: [{ id: PAYMENT_ID }] })],
      [/SET status = 'expired'[\s\S]*expires_at <= NOW\(\)/, () => ({ rows: opts.overdueExpires ? [{ status: 'expired' }] : [] })],
      [/SELECT status FROM payment_intents/, () => ({ rows: opts.statusNow ? [{ status: opts.statusNow }] : [] })],
      [/FROM payment_intents\s+WHERE id/, () => ({ rows: opts.intent ? [opts.intent] : [] })],
    ]
  }

  // ── Legacy AllowanceModule rail retired by #1986 (epic #1440 slice 3) ──
  //
  // Every case below drives `POST /:id/sign` with a `pendingIntent()` whose
  // `execution_rail` is unset — i.e. the pre-migration legacy-intent shape.
  // `isRetiredAllowanceIntent` now fail-closes on that same shape (410,
  // nothing claimed, nothing executed) BEFORE the claim CAS, the mpp_demo
  // gate, or the expiry check ever run, so these characterize the refusal
  // rather than the (now-unreachable) legacy execution/claim/expiry paths
  // they originally proved. `rails/allowance-module.ts` and these cases are
  // scheduled for deletion in #1987.
  it('claims a pending signature intent before executing on-chain', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValue({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: '1.00', eur: '0.92' })

    primeDb(...signRoutes({ intent: pendingIntent(), claimWins: true }))

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('intent').body.error)
    // The rail refusal fires before the claim CAS — nothing was claimed or executed:
    expect(findCall(/SET signature[\s\S]*status = 'submitted'/)).toBeUndefined()
    expect(findCall(/SET status = 'confirmed'/)).toBeUndefined()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  // #1328 (review finding on #1339): a PRE-EXISTING mpp_demo intent must be
  // readable but never executable after the retirement — this generic sign
  // path was the remaining execution door. 410-with-nothing-written, same
  // contract as the session-rail gate. MUTATION PROOF: removing the
  // payment_rail/source guard in /:id/sign flips this to a live execution.
  //
  // #1986: `pendingIntent()` also carries no `execution_rail`, so the
  // Safe-rail retirement gate now fires FIRST — the mpp_demo guard this case
  // named is unreachable behind it. Kept anyway: an identical-looking 410
  // reached from a different gate is exactly what fail-closed means.
  it('refuses to sign a historical mpp_demo intent — 410, no claim, no on-chain call (#1328)', async () => {
    primeDb(...signRoutes({
      intent: pendingIntent({ payment_rail: 'mpp_demo', source: 'mpp_demo' }),
      claimWins: true,
    }))

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(410)
    // #1986 keeps #1328's OWN message here rather than swallowing it: an
    // mpp_demo intent is `execution_rail = null` too, so the Safe-rail
    // predicate would match it — the gate is deliberately ordered AFTER the
    // mpp_demo gate so the narrower, more informative rule speaks. Named, not
    // "some 410": both are 410, and only the body tells them apart.
    expect(response.json().error).toMatch(/mpp_demo/)
    expect(response.json().error).not.toBe(allowanceModuleRailRetired('intent').body.error)
    // Nothing written, nothing executed:
    expect(findCall(/SET signature[\s\S]*status = 'submitted'/)).toBeUndefined()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  // #717 (review B1 on #1119): this route claims the intent to 'submitted'
  // BEFORE executing — a budget 429 must release that claim or the row is
  // stuck unretryable forever, worse than any failure mode it replaced.
  //
  // #1986: the retirement gate now precedes the claim, so a legacy intent
  // never reaches `executeAllowanceTransfer` (and therefore never reaches
  // the 429 this case characterized) at all — it 410s first, with no claim
  // to release.
  it('releases the submitted claim on a relayer-budget 429 — the intent stays retryable', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    const { RelayerBudgetExceededError } = await import('../../infra/relayer-spend-guard.js')
    allowanceMocks.executeAllowanceTransfer.mockRejectedValueOnce(
      new RelayerBudgetExceededError('allowance_transfer', 60, 60),
    )

    primeDb(...signRoutes({ intent: pendingIntent(), claimWins: true }))

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('intent').body.error)
    // Nothing claimed, so nothing to release, and nothing burned to failed:
    expect(findCall(/SET signature[\s\S]*status = 'submitted'/)).toBeUndefined()
    expect(findCall(/SET status = 'pending_signature'/)).toBeUndefined()
    expect(findCall(/SET status = 'failed'/)).toBeUndefined()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  // #1986: the retirement gate fires before the claim → execute → confirm →
  // evidence pipeline this case exercised, so a legacy (`execution_rail`
  // unset) intent never reaches the evidence recorder at all.
  it('creates base evidence after a protocol payment is confirmed', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValue({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: '1.00', eur: '0.92' })

    const x402Fields = {
      payment_rail: 'x402',
      source: 'x402',
      payment_resource_url: 'https://merchant.example/data',
      merchant_address: RECIPIENT.toLowerCase(),
      machine_idempotency_key: 'x402:test',
    }
    primeDb(
      // The evidence recorder re-reads through its own projection
      // (`'payment_intent'::TEXT AS kind`) — answer it with the CONFIRMED row.
      [/AS kind,/, () => ({
        rows: [{
          kind: 'payment_intent',
          ...pendingIntent({
            ...x402Fields,
            status: 'confirmed',
            tx_hash: TX_HASH,
            confirmed_at: '2026-05-19T10:00:00.000Z',
          }),
        }],
      })],
      ...signRoutes({ intent: pendingIntent(x402Fields), claimWins: true }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('intent').body.error)
    // No evidence written — the payment never confirmed, never even claimed:
    expect(findCall(/machine_payment_evidence/)).toBeUndefined()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  // #1986: same gate, same reason — the confirmed status this case asserted
  // is unreachable for a legacy intent now.
  it('still returns confirmed when protocol evidence indexing fails', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValue({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: '1.00', eur: '0.92' })

    primeDb(
      [/machine_payment_evidence/, () => Promise.reject(new Error('evidence table unavailable'))],
      ...signRoutes({
        intent: pendingIntent({ payment_rail: 'x402', source: 'x402' }),
        claimWins: true,
      }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json()).toMatchObject({
      error: allowanceModuleRailRetired('intent').body.error,
    })
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  // #1986: the retirement gate fires before the claim CAS this case's
  // `claimWins: false` setup was meant to lose against — a legacy intent
  // never reaches the CAS (or its double-claim 409) at all.
  it('does not execute when another request already claimed the payment intent', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)

    primeDb(
      ...signRoutes({
        intent: pendingIntent(),
        claimWins: false, // the CAS was lost…
        overdueExpires: false, // …and not because the row was overdue
        statusNow: 'submitted',
      }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('intent').body.error)
    expect(findCall(/SET signature[\s\S]*status = 'submitted'/)).toBeUndefined()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  // #1986: the retirement gate runs BEFORE the "Check expiry" step this case
  // targeted — a legacy intent 410s on the rail refusal, never on expiry,
  // even when `overdueExpires: true` says the row is stale.
  it('returns expired when an intent expires before it can be claimed', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)

    primeDb(
      ...signRoutes({
        intent: pendingIntent(),
        claimWins: false,
        overdueExpires: true, // the losing branch's tie-breaker says: overdue
      }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('intent').body.error)
    // The expiry query never ran — the rail gate refused first:
    expect(findCall(/expires_at <= NOW\(\)/)).toBeUndefined()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  // #1986: the retirement gate fires before `executeAllowanceTransfer` is
  // ever called, so the on-chain-execution failure this case targeted never
  // happens for a legacy intent — nothing is claimed, so nothing is marked
  // failed either.
  it('only marks submitted payment intents failed after execution errors', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockRejectedValueOnce(new Error('relayer unavailable'))

    primeDb(...signRoutes({ intent: pendingIntent(), claimWins: true }))

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('intent').body.error)
    expect(findCall(/SET status = 'failed'/)).toBeUndefined()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  // ── GET /:id and GET / — status reads with lazy expiry ─────────────────

  it('expires stale pending signature intents when their status is read', async () => {
    primeDb(
      AUTH,
      [/SET status = 'expired'/, () => ({ rows: [{ status: 'expired' }] })],
      [/FROM payment_intents WHERE id/, () => ({
        rows: [pendingIntent({ expires_at: '2000-01-01T00:00:00.000Z' })],
      })],
    )

    const response = await app.inject({
      method: 'GET',
      url: `/payments/${PAYMENT_ID}`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'expired',
    })
    const expire = findCall(/SET status = 'expired'/)
    expect(expire).toBeDefined()
    expect(expire!.sql).toContain("status = 'pending_signature'")
  })

  it('surfaces the platform fee on a payment result so it is never silent (#386)', async () => {
    primeDb(
      AUTH,
      [/FROM payment_intents WHERE id/, () => ({
        rows: [pendingIntent({ status: 'confirmed', tx_hash: TX_HASH })],
      })],
    )

    const response = await app.inject({
      method: 'GET',
      url: `/payments/${PAYMENT_ID}`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    // Dark today: zero + not applied — but always present.
    expect(response.json().fee).toEqual({ amount: '0', token: 'xDAI', basis_points: 0, applied: false })
  })

  it('expires stale pending signature intents before listing payments', async () => {
    primeDb(
      AUTH,
      [/ORDER BY created_at DESC/, () => ({ rows: [pendingIntent({ status: 'expired' })] })],
    )

    const response = await app.inject({
      method: 'GET',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().payments).toEqual([
      expect.objectContaining({ payment_id: PAYMENT_ID, status: 'expired' }),
    ])
    // The lazy sweep ran before the list:
    const calls = sqlCalls()
    const sweepIdx = calls.findIndex((c) => /status = 'pending_signature'/.test(c.sql) && /expires_at < NOW\(\)/.test(c.sql))
    const listIdx = calls.findIndex((c) => /ORDER BY created_at DESC/.test(c.sql))
    expect(sweepIdx).toBeGreaterThanOrEqual(0)
    expect(listIdx).toBeGreaterThan(sweepIdx)
  })

  // POST /payments idempotency (#1207) — the same contract the MPP routes
  // carry, on the same key column (migration 020). A retry returns the FIRST
  // request's result: no second transfer, no second approval.
  //
  // #1986 (epic #1440 slice 3): every case in this block characterized the
  // legacy AllowanceModule rail — none of these fixtures mock the account's
  // CURRENT execution rail (`loadExecutionRailState`'s `FROM agents a` query),
  // so it resolves to `null`, which now fail-closes to `retired_allowance`
  // BEFORE the idempotency-replay lookup ever runs (the account gate, not the
  // intent gate — `allowanceModuleRailRetired('account')`). That includes the
  // "delegation-rail intent" replay case: the INTENT is pinned `delegation`,
  // but the ACCOUNT's current rail is what the early gate reads, and this
  // fixture never mocks it, so it 410s too. `rails/allowance-module.ts` and
  // these cases are scheduled for deletion in #1987.
  describe('POST /payments idempotency (#1207)', () => {
    const ONE_XDAI = 1_000_000_000_000_000_000n
    const KEY = 'agent-key-1'

    function keyedBody(overrides: Record<string, unknown> = {}) {
      return { token: 'xDAI', amount: '1', to: RECIPIENT, idempotency_key: KEY, ...overrides }
    }

    function sendReplayRow(overrides: Record<string, unknown> = {}) {
      return {
        id: PAYMENT_ID,
        status: 'pending_signature',
        expires_at: '2099-01-01T00:00:00.000Z',
        token_address: TOKEN,
        token_symbol: 'xDAI',
        to_address: RECIPIENT.toLowerCase(),
        amount_raw: '1000000000000000000',
        amount_human: '1',
        allowance_nonce: 7,
        sign_hash: SIGN_HASH,
        execution_rail: null,
        prepared_user_op: null,
        chain_id: AGENT.chain_id,
        ...overrides,
      }
    }

    const intentKeyLookup = (rows: unknown[]): DbRoute => [
      /send_idempotency_key = \$2[\s\S]*FROM payment_intents|FROM payment_intents[\s\S]*send_idempotency_key = \$2/,
      () => ({ rows }),
    ]
    const approvalKeyLookup = (rows: unknown[]): DbRoute => [
      /FROM approval_requests[\s\S]*send_idempotency_key = \$2|send_idempotency_key = \$2[\s\S]*FROM approval_requests/,
      () => ({ rows }),
    ]

    it('replays a still-signable legacy intent — same sign_data, no new transfer, no chain reads', async () => {
      primeDb(AUTH, intentKeyLookup([sendReplayRow()]))

      const response = await app.inject({
        method: 'POST', url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: keyedBody(),
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      // The whole point still holds, just via the account gate: nothing was
      // minted, no chain work ran, and the replay lookup itself never ran.
      expect(findCall(/INSERT INTO payment_intents/)).toBeUndefined()
      expect(findCall(/send_idempotency_key = \$2/)).toBeUndefined()
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
      expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    })

    it('replays a pending approval as 202 — a retry never opens a second approval', async () => {
      primeDb(
        AUTH,
        intentKeyLookup([]),
        approvalKeyLookup([
          {
            id: 'appr-1',
            status: 'pending',
            expires_at: '2099-01-01T00:00:00.000Z',
            token_symbol: 'xDAI',
            amount_human: '1',
            token_address: TOKEN,
            to_address: RECIPIENT.toLowerCase(),
            amount_raw: '1000000000000000000',
          },
        ]),
      )

      const response = await app.inject({
        method: 'POST', url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: keyedBody(),
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      expect(findCall(/INSERT INTO approval_requests/)).toBeUndefined()
      expect(findCall(/FROM approval_requests[\s\S]*send_idempotency_key = \$2|send_idempotency_key = \$2[\s\S]*FROM approval_requests/)).toBeUndefined()
    })

    it('409s a key reused for a DIFFERENT transfer', async () => {
      primeDb(AUTH, intentKeyLookup([sendReplayRow({ amount_raw: '999' })]))

      const response = await app.inject({
        method: 'POST', url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: keyedBody(),
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      expect(findCall(/INSERT INTO/)).toBeUndefined()
    })

    it('lazy-expires a stale pending row and creates fresh — the key never dead-ends (#961 M2)', async () => {
      allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 7 })
      allowanceMocks.getLatestBlockTimeSec.mockResolvedValue(1_900_000_000)
      allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: ONE_XDAI * 2n })
      allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)
      primeDb(
        AUTH,
        intentKeyLookup([sendReplayRow({ expires_at: '2020-01-01T00:00:00.000Z' })]),
        [/FROM agent_allowances/, () => ({ rows: [{ allowance_amount: '1000' }] })],
        [/INSERT INTO payment_intents/, () => ({ rows: [pendingIntent()] })],
      )

      const response = await app.inject({
        method: 'POST', url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: keyedBody(),
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      // Nothing lazily-expired and nothing freshly minted — the account gate
      // refuses before any of that machinery runs.
      expect(findCall(/UPDATE payment_intents[\s\S]*expired/)).toBeUndefined()
      expect(findCall(/INSERT INTO payment_intents/)).toBeUndefined()
    })

    it('a fresh create persists the key on the intent row', async () => {
      allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 7 })
      allowanceMocks.getLatestBlockTimeSec.mockResolvedValue(1_900_000_000)
      allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: ONE_XDAI * 2n })
      allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)
      primeDb(
        AUTH,
        intentKeyLookup([]),
        approvalKeyLookup([]),
        [/FROM agent_allowances/, () => ({ rows: [{ allowance_amount: '1000' }] })],
        [/INSERT INTO payment_intents/, () => ({ rows: [pendingIntent()] })],
      )

      const response = await app.inject({
        method: 'POST', url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: keyedBody(),
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      expect(findCall(/INSERT INTO payment_intents/)).toBeUndefined()
    })

    it('an idempotency-key race (23505) replays the winner instead of erroring', async () => {
      allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 7 })
      allowanceMocks.getLatestBlockTimeSec.mockResolvedValue(1_900_000_000)
      allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: ONE_XDAI * 2n })
      allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)
      let lookups = 0
      primeDb(
        AUTH,
        [
          /send_idempotency_key = \$2[\s\S]*FROM payment_intents|FROM payment_intents[\s\S]*send_idempotency_key = \$2/,
          // First lookup (pre-insert): nothing. Second (post-race): the winner.
          () => ({ rows: ++lookups === 1 ? [] : [sendReplayRow()] }),
        ],
        approvalKeyLookup([]),
        [/FROM agent_allowances/, () => ({ rows: [{ allowance_amount: '1000' }] })],
        [/INSERT INTO payment_intents/, () => {
          const err = new Error('duplicate key') as Error & { code: string }
          err.code = '23505'
          throw err
        }],
      )

      const response = await app.inject({
        method: 'POST', url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: keyedBody(),
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      // The race-retry machinery this case exercised never runs — the account
      // gate refuses before the first lookup, so `lookups` never increments
      // and `INSERT INTO payment_intents` is never attempted.
      expect(findCall(/INSERT INTO payment_intents/)).toBeUndefined()
    })

    it('replays a delegation-rail intent by REBUILDING the stored signing payload (#961 discipline)', async () => {
      // The highest-blast-radius replay path: the typed data must come from
      // the STORED UserOperation — a fresh estimation would be a different
      // payload than the one the intent pinned.
      // #1986 FIXTURE FIX, not a conversion. This case is the delegation
      // rail's replay proof and must keep proving it — so it is the one case
      // in this describe that stays GREEN, and it is a positive control for
      // the whole slice. It only ever pinned the INTENT's rail; the ACCOUNT's
      // rail (`FIND_EXECUTION_RAIL_FOR_AGENT_SQL`, the LEFT JOIN through
      // `agents.safe_id`) was never mocked and defaulted to null. That was
      // invisible while null meant "legacy" and legacy still paid; after the
      // retirement null means RETIRED, and leaving the fixture alone would
      // have silently turned a delegation-replay test into a third copy of
      // the refusal. The account rail is now mocked to match the intent.
      primeDb(
        AUTH,
        [/LEFT JOIN user_safes/, () => ({ rows: [{ execution_rail: 'delegation' }] })],
        intentKeyLookup([
          sendReplayRow({
            execution_rail: 'delegation',
            prepared_user_op: { sender: '0x' + 'dd'.repeat(20), nonce: '5', callData: '0xabcd' },
            chain_id: 8453,
          }),
        ]),
      )

      const response = await app.inject({
        method: 'POST', url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: keyedBody(),
      })

      // The replay is REBUILT from the stored UserOperation, not re-estimated:
      // a fresh estimation would be a different payload than the one the
      // intent pinned, and the client signed the pinned one.
      expect(response.statusCode).toBe(201)
      // Rebuilt from the STORED UserOperation — its sender is the fixture's,
      // which a fresh estimation could not have produced.
      expect(JSON.stringify(response.json().sign_data)).toContain('dd'.repeat(20))
      expect(findCall(/INSERT INTO payment_intents/)).toBeUndefined()
    })

    it('a key whose payment already progressed reports the REAL status, not a stale sign request', async () => {
      primeDb(
        AUTH,
        intentKeyLookup([sendReplayRow({ status: 'confirmed' })]),
        [/WHERE id = \$1 AND agent_id = \$2/, () => ({
          rows: [pendingIntent({ status: 'confirmed', tx_hash: TX_HASH, confirmed_at: '2026-05-13T10:05:00.000Z' })],
        })],
      )

      const response = await app.inject({
        method: 'POST', url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: keyedBody(),
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      expect(findCall(/INSERT INTO/)).toBeUndefined()
    })

    it('a request without a key behaves exactly as before — no lookups, no key persisted', async () => {
      allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 7 })
      allowanceMocks.getLatestBlockTimeSec.mockResolvedValue(1_900_000_000)
      allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: ONE_XDAI * 2n })
      allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)
      primeDb(
        AUTH,
        [/FROM agent_allowances/, () => ({ rows: [{ allowance_amount: '1000' }] })],
        [/INSERT INTO payment_intents/, () => ({ rows: [pendingIntent()] })],
      )

      const response = await app.inject({
        method: 'POST', url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { token: 'xDAI', amount: '1', to: RECIPIENT },
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      expect(findCall(/send_idempotency_key = \$2/)).toBeUndefined()
      expect(findCall(/INSERT INTO payment_intents/)).toBeUndefined()
    })
  })

  // POST /payments — the normal send/transfer flow. These pin the coverage
  // decision now routed through decideCoverage('allowance-only'): over-allowance
  // queues (202), within-allowance executes (201), and the inclusive boundary
  // (amount == remaining) executes — not queues.
  //
  // #1986 (epic #1440 slice 3): `createRoutes` never mocks the account's
  // current execution rail, so `loadExecutionRailState` resolves it to
  // `null`, which now fail-closes to `retired_allowance` before the coverage
  // decision this block characterizes is ever computed. `rails/
  // allowance-module.ts` and these cases are scheduled for deletion in #1987.
  describe('POST /payments (create)', () => {
    const ONE_XDAI = 1_000_000_000_000_000_000n // 1 xDAI, 18 decimals

    function createBody() {
      return { token: 'xDAI', amount: '1', to: RECIPIENT }
    }

    /** Create-path routes: rail state (none → legacy), allowance config, inserts. */
    const createRoutes: DbRoute[] = [
      AUTH,
      [/FROM agent_allowances/, () => ({ rows: [{ allowance_amount: '1000' }] })],
      [/INSERT INTO approval_requests/, () => ({
        rows: [{ id: 'appr-1', status: 'pending', expires_at: '2099-01-01T00:00:00.000Z' }],
      })],
      [/INSERT INTO payment_intents/, () => ({ rows: [pendingIntent()] })],
    ]

    it('queues for approval (202) when amount exceeds remaining allowance', async () => {
      allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 7 })
      allowanceMocks.getLatestBlockTimeSec.mockResolvedValue(1_900_000_000)
      allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: ONE_XDAI / 2n })

      primeDb(...createRoutes)

      const response = await app.inject({
        method: 'POST',
        url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: createBody(),
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      expect(findCall(/INSERT INTO approval_requests/), 'the retired rail must never open an approval').toBeUndefined()
      // generateTransferHash must NOT run on the refused path either.
      expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    })

    it('executes (201) when amount is within remaining allowance', async () => {
      allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 7 })
      allowanceMocks.getLatestBlockTimeSec.mockResolvedValue(1_900_000_000)
      allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: ONE_XDAI * 2n })
      allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)

      primeDb(...createRoutes)

      const response = await app.inject({
        method: 'POST',
        url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: createBody(),
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      expect(findCall(/INSERT INTO payment_intents/), 'the retired rail must never mint an intent').toBeUndefined()
    })

    it('executes (201) at the exact allowance boundary (amount == remaining)', async () => {
      // Inclusive boundary: amount == remaining must execute, not queue. Guards
      // against a `>=` slip in the shared decideCoverage decision.
      allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 7 })
      allowanceMocks.getLatestBlockTimeSec.mockResolvedValue(1_900_000_000)
      allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: ONE_XDAI })
      allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)

      primeDb(...createRoutes)

      const response = await app.inject({
        method: 'POST',
        url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: createBody(),
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    })
  })
})
