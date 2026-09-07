import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import machinePaymentRoutes from '../machine-payments.js'

const { mockQuery, allowanceMocks, sweepMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenBalance: vi.fn(),
  },
  sweepMocks: {
    buildSweepAuthorization: vi.fn(),
    signSweepExpectedContext: vi.fn(),
    recoverSweepSigner: vi.fn(),
    relaySweepAuthorization: vi.fn(),
  },
}))

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))
vi.mock('../../rails/allowance-module.js', () => allowanceMocks)
vi.mock('../../rails/sweep.js', () => sweepMocks)

const DELEGATE = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ATTACKER = '0x000000000000000000000000000000000000bEEF'
const NONCE = `0x${'ab'.repeat(32)}`
const SIG = `0x${'cd'.repeat(65)}`
const TX = `0x${'ef'.repeat(32)}`

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Payment Agent',
  delegate_address: DELEGATE,
  safe_address: SAFE,
  chain_id: 8453,
  status: 'active',
}

const AUTHZ = {
  from: DELEGATE,
  to: SAFE,
  value: '40000',
  validAfter: '0',
  validBefore: '4000000000',
  nonce: NONCE,
  token: USDC,
  chainId: 8453,
}

function preparedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '99999999-9999-9999-9999-999999999999',
    chain_id: 8453,
    token_address: USDC.toLowerCase(),
    from_address: DELEGATE.toLowerCase(),
    to_address: SAFE.toLowerCase(),
    value_atomic: '40000',
    valid_after: '0',
    valid_before: '4000000000',
    nonce: NONCE,
    status: 'prepared',
    tx_hash: null,
    ...overrides,
  }
}

// ── Content-dispatch DB stub (#1226) — see payments.test.ts for the model. ──
// The sweep-claim CAS itself (exactly one winner, release-on-refusal,
// submitted-is-terminal) is proven against real Postgres in the repository
// suite (machine-payments.test.ts); these tests own the HANDLER: status
// codes, relay-called-or-not, and the order of the writes it asks for.

type DbRoute = [RegExp, (sql: string, params: unknown[]) => { rows: unknown[] }]

function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const text = String(sql)
    for (const [re, handler] of routes) {
      if (re.test(text)) return handler(text, params)
    }
    return { rows: [] }
  })
}

const sqlCalls = () => mockQuery.mock.calls.map((c) => ({ sql: String(c[0]), params: c[1] as unknown[] }))
const findCall = (re: RegExp) => sqlCalls().find((c) => re.test(c.sql))

const AUTH_ROUTE: DbRoute = [/api_key_hash = \$1/, () => ({ rows: [AGENT] })]
const BOUND_AGENT_ROUTE: DbRoute = [/FOR UPDATE OF a/, () => ({ rows: [{ safe_address: SAFE }] })]

/** Sweep routes: the prepared-row read (optionally different after a lost claim) + the claim CAS. */
function sweepRoutes(opts: {
  prepared?: Record<string, unknown> | null
  preparedAfterLostClaim?: Record<string, unknown>
  claimWins?: boolean
}): DbRoute[] {
  let reads = 0
  return [
    AUTH_ROUTE,
    BOUND_AGENT_ROUTE,
    [/SET status = 'submitting'/, () => ({ rows: opts.claimWins ? [{ id: 'sweep-id' }] : [] })],
    [/FROM delegate_sweeps/, () => {
      reads += 1
      const row = reads > 1 && opts.preparedAfterLostClaim ? opts.preparedAfterLostClaim : opts.prepared
      return { rows: row ? [row] : [] }
    }],
  ]
}

describe('machine payment sweep routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [] })
    for (const m of Object.values(allowanceMocks)) m.mockReset()
    for (const m of Object.values(sweepMocks)) m.mockReset()
  })

  const headers = { authorization: 'Bearer sk_agent_test' }

  describe('POST /sweep/prepare', () => {
    it('fails closed when the agent no longer has a bound Safe', async () => {
      primeDb([/api_key_hash = \$1/, () => ({ rows: [{ ...AGENT, has_bound_safe: false }] })])

      const res = await app.inject({ method: 'POST', url: '/machine-payments/sweep/prepare', headers })

      expect(res.statusCode).toBe(403)
      expect(res.json().error).toBe('Agent is no longer linked to a Haven wallet')
      expect(allowanceMocks.getTokenBalance).not.toHaveBeenCalled()
    })

    it('returns nothing_stranded when the delegate is empty (no row inserted)', async () => {
      primeDb(AUTH_ROUTE)
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(0n)

      const res = await app.inject({ method: 'POST', url: '/machine-payments/sweep/prepare', headers })

      expect(res.statusCode).toBe(200)
      expect(res.json().nothing_stranded).toBe(true)
      // only the auth query ran — no INSERT
      expect(mockQuery).toHaveBeenCalledTimes(1)
      expect(sweepMocks.buildSweepAuthorization).not.toHaveBeenCalled()
    })

    it('builds an authorization and binding when funds are stranded above the floor', async () => {
      primeDb(AUTH_ROUTE, BOUND_AGENT_ROUTE)
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(2_000_000n) // 2 USDC ≥ 0.01 floor
      sweepMocks.buildSweepAuthorization.mockReturnValueOnce(AUTHZ)
      const expectedAuth = { version: 1, message: 'm', signature: '0xaa', signer: ATTACKER }
      sweepMocks.signSweepExpectedContext.mockResolvedValueOnce(expectedAuth)

      const res = await app.inject({ method: 'POST', url: '/machine-payments/sweep/prepare', headers })

      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body.authorization).toEqual(AUTHZ)
      expect(body.expected_auth).toEqual(expectedAuth)
      expect(body.amount).toBe('2.0')
      expect(body.amount_atomic).toBe('2000000')
    })

    it('builds an authorization when the balance is exactly the 0.01 USDC floor', async () => {
      primeDb(AUTH_ROUTE, BOUND_AGENT_ROUTE)
      allowanceMocks.getTokenBalance.mockResolvedValue(10_000n)
      sweepMocks.buildSweepAuthorization.mockReturnValueOnce({ ...AUTHZ, value: '10000' })
      sweepMocks.signSweepExpectedContext.mockResolvedValue({ version: 1 })

      const res = await app.inject({ method: 'POST', url: '/machine-payments/sweep/prepare', headers })

      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ amount: '0.01', amount_atomic: '10000' })
      expect(sweepMocks.buildSweepAuthorization).toHaveBeenCalledOnce()
    })

    it('sweeps a DELEGATION-rail agent to its treasury Hybrid — 3009-mode reconciliation (#946)', async () => {
      // The #946 EIP-3009 fallback reintroduces a bounded funding leg on the
      // delegation rail and leans on THIS route for verify-without-settle
      // reconciliation: agent.safe_address is the treasury Hybrid for
      // delegator accounts, and the route must stay rail-agnostic.
      const TREASURY_HYBRID = '0x' + '77'.repeat(20)
      const treasuryAuthRoute: DbRoute = [
        /api_key_hash = \$1/,
        () => ({
          rows: [{
            ...AGENT,
            safe_address: TREASURY_HYBRID,
            execution_rail: 'delegation',
            account_type: 'delegator_hybrid',
            chain_id: 84532,
          }],
        }),
      ]
      const treasuryBindingRoute: DbRoute = [
        /FOR UPDATE OF a/,
        () => ({ rows: [{ safe_address: TREASURY_HYBRID }] }),
      ]
      primeDb(treasuryAuthRoute, treasuryBindingRoute)
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(2_000_000n)
      sweepMocks.buildSweepAuthorization.mockReturnValueOnce({ ...AUTHZ, to: TREASURY_HYBRID, chainId: 84532 })
      sweepMocks.signSweepExpectedContext.mockResolvedValueOnce('0xsigned')

      const res = await app.inject({ method: 'POST', url: '/machine-payments/sweep/prepare', headers })

      expect(res.statusCode).toBe(201)
      expect(sweepMocks.buildSweepAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({ safeAddress: TREASURY_HYBRID, chainId: 84532 }),
      )
    })

    it('leaves dust below the sweep floor un-swept (#700 floor)', async () => {
      primeDb(AUTH_ROUTE)
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(5_000n) // 0.005 USDC < 0.01 floor

      const res = await app.inject({ method: 'POST', url: '/machine-payments/sweep/prepare', headers })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.below_min).toBe(true)
      expect(body.authorization).toBeUndefined()
      expect(body.amount).toBe('0.005')
      expect(body.amount_atomic).toBe('5000')
      expect(body.min_usdc).toBe('0.01')
      expect(body.message).toContain('0.005 USDC')
      expect(body.message).toContain('0.01 USDC')
      expect(body.message).toMatch(/additional stranded funds.*at least the floor/i)
    })
  })

  describe('POST /sweep/submit', () => {
    it('relays when the signature recovers the delegate and balance covers it', async () => {
      primeDb(...sweepRoutes({ prepared: preparedRow(), claimWins: true }))
      sweepMocks.recoverSweepSigner.mockReturnValueOnce(DELEGATE)
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(40000n)
      sweepMocks.relaySweepAuthorization.mockResolvedValueOnce({ txHash: TX })

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: NONCE }, signature: SIG },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().tx_hash).toBe(TX)
      expect(sweepMocks.relaySweepAuthorization).toHaveBeenCalledOnce()
    })

    it('does not relay when a concurrent submitter already claimed the sweep', async () => {
      primeDb(
        ...sweepRoutes({
          prepared: preparedRow(),
          claimWins: false,
          preparedAfterLostClaim: preparedRow({ status: 'submitting' }),
        }),
      )
      sweepMocks.recoverSweepSigner.mockReturnValueOnce(DELEGATE)
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(40000n)

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: NONCE }, signature: SIG },
      })

      expect(res.statusCode).toBe(409)
      expect(sweepMocks.relaySweepAuthorization).not.toHaveBeenCalled()
    })

    it('replays the winner tx when the claim is lost but the sweep already submitted', async () => {
      primeDb(
        ...sweepRoutes({
          prepared: preparedRow(),
          claimWins: false,
          preparedAfterLostClaim: preparedRow({ status: 'submitted', tx_hash: TX }),
        }),
      )
      sweepMocks.recoverSweepSigner.mockReturnValueOnce(DELEGATE)
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(40000n)

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: NONCE }, signature: SIG },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ tx_hash: TX, idempotent_replay: true })
      expect(sweepMocks.relaySweepAuthorization).not.toHaveBeenCalled()
    })

    it('rejects with 403 when the signature does not recover the delegate', async () => {
      primeDb(...sweepRoutes({ prepared: preparedRow() }))
      sweepMocks.recoverSweepSigner.mockReturnValueOnce(ATTACKER)

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: NONCE }, signature: SIG },
      })

      expect(res.statusCode).toBe(403)
      expect(sweepMocks.relaySweepAuthorization).not.toHaveBeenCalled()
      expect(allowanceMocks.getTokenBalance).not.toHaveBeenCalled()
    })

    it('returns 404 when no prepared sweep matches the nonce', async () => {
      primeDb(...sweepRoutes({ prepared: null }))

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: NONCE }, signature: SIG },
      })

      expect(res.statusCode).toBe(404)
    })

    it('returns 409 balance_changed when the delegate no longer covers the value', async () => {
      primeDb(...sweepRoutes({ prepared: preparedRow() }))
      sweepMocks.recoverSweepSigner.mockReturnValueOnce(DELEGATE)
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(100n)

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: NONCE }, signature: SIG },
      })

      expect(res.statusCode).toBe(409)
      expect(res.json().error_code).toBe('balance_changed')
      expect(sweepMocks.relaySweepAuthorization).not.toHaveBeenCalled()
    })

    it('idempotently replays an already-submitted sweep', async () => {
      primeDb(...sweepRoutes({ prepared: preparedRow({ status: 'submitted', tx_hash: TX }) }))

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: NONCE }, signature: SIG },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().idempotent_replay).toBe(true)
      expect(sweepMocks.relaySweepAuthorization).not.toHaveBeenCalled()
    })

    it('rejects a malformed nonce with 400', async () => {
      primeDb(AUTH_ROUTE)

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: '0xdead' }, signature: SIG },
      })

      expect(res.statusCode).toBe(400)
    })

    // ── CAS lifecycle: relay outcomes (#997 characterization — the #717 ──────
    // budget-release path and the generic-failure path had ZERO coverage
    // before this pass; see routes/machine-payments.ts's
    // `RelayerBudgetExceededError` branch, preserved verbatim in
    // modules/mpp/sweep.ts).

    it('#717: a relayer-budget refusal RELEASES the claim back to prepared (429), not markSweepFailed', async () => {
      primeDb(...sweepRoutes({ prepared: preparedRow(), claimWins: true }))
      sweepMocks.recoverSweepSigner.mockReturnValueOnce(DELEGATE)
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(40000n)
      const { RelayerBudgetExceededError } = await import('../../infra/relayer-spend-guard.js')
      sweepMocks.relaySweepAuthorization.mockRejectedValueOnce(
        new RelayerBudgetExceededError('sweep', 30, 60),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: NONCE }, signature: SIG },
      })

      expect(res.statusCode).toBe(429)
      expect(res.json().error).toMatch(/budget/i)

      // The claim MUST release back to 'prepared', never 'failed' — a
      // 'failed' sweep here would strand the funds path (#717).
      const releaseCall = findCall(/SET status = 'prepared'/)
      expect(releaseCall).toBeDefined()
      expect(releaseCall!.sql).toContain("WHERE id = $1 AND status = 'submitting'")
      expect(releaseCall!.params).toEqual([preparedRow().id])

      expect(findCall(/SET status = 'failed'/)).toBeUndefined()
    })

    it('a non-budget relay failure marks the sweep failed (502), releasing nothing', async () => {
      primeDb(...sweepRoutes({ prepared: preparedRow(), claimWins: true }))
      sweepMocks.recoverSweepSigner.mockReturnValueOnce(DELEGATE)
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(40000n)
      sweepMocks.relaySweepAuthorization.mockRejectedValueOnce(new Error('relayer RPC timed out'))

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: NONCE }, signature: SIG },
      })

      expect(res.statusCode).toBe(502)
      expect(res.json()).toMatchObject({ error: 'Sweep relay failed', details: 'relayer RPC timed out' })

      const failCall = findCall(/SET status = 'failed'/)
      expect(failCall).toBeDefined()
      expect(failCall!.sql).toContain("WHERE id = $2 AND status = 'submitting'")
      expect(failCall!.params).toEqual(['relayer RPC timed out', preparedRow().id])

      expect(findCall(/SET status = 'prepared'/)).toBeUndefined()
    })

    it('expires a prepared sweep past validBefore (409), never reaching claim or relay', async () => {
      primeDb(
        ...sweepRoutes({
          prepared: preparedRow({ valid_before: String(Math.floor(Date.now() / 1000) - 60) }),
        }),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: NONCE }, signature: SIG },
      })

      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/expired/i)

      const expireCall = findCall(/SET status = 'expired'/)
      expect(expireCall).toBeDefined()
      expect(expireCall!.sql).toContain("WHERE id = $1 AND status = 'prepared'")
      expect(sweepMocks.recoverSweepSigner).not.toHaveBeenCalled()
      expect(sweepMocks.relaySweepAuthorization).not.toHaveBeenCalled()
      expect(allowanceMocks.getTokenBalance).not.toHaveBeenCalled()
    })

    it('a successful relay resolves any open stranded-funds reconciliation for the agent', async () => {
      primeDb(...sweepRoutes({ prepared: preparedRow(), claimWins: true }))
      sweepMocks.recoverSweepSigner.mockReturnValueOnce(DELEGATE)
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(40000n)
      sweepMocks.relaySweepAuthorization.mockResolvedValueOnce({ txHash: TX })

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: NONCE }, signature: SIG },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().tx_hash).toBe(TX)

      const calls = sqlCalls()
      const submittedIndex = calls.findIndex((c) => /SET status = 'submitted'/.test(c.sql))
      const resolveIndex = calls.findIndex(
        (c) => /machine_payment_reconciliation_events/.test(c.sql) && /status = 'resolved'/.test(c.sql),
      )
      expect(submittedIndex).toBeGreaterThanOrEqual(0)
      expect(resolveIndex).toBeGreaterThanOrEqual(0)
      expect(calls[resolveIndex].params).toEqual([AGENT.id])
      // Ordering: markSweepSubmitted before the reconciliation resolve — a
      // sweep that fails to record 'submitted' must not silently resolve
      // reconciliation for a transfer that never landed.
      expect(submittedIndex).toBeLessThan(resolveIndex)
    })
  })
})
