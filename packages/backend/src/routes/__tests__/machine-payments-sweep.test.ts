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
vi.mock('../../lib/allowance-module.js', () => allowanceMocks)
vi.mock('../../lib/sweep.js', () => sweepMocks)

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

const AUTH = {
  from: DELEGATE,
  to: SAFE,
  value: '40000',
  validAfter: '0',
  validBefore: '4000000000',
  nonce: NONCE,
  token: USDC,
  chainId: 8453,
}

function authRow() {
  return { rows: [AGENT] }
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
    it('returns nothing_stranded when the delegate is empty (no row inserted)', async () => {
      mockQuery.mockResolvedValueOnce(authRow())
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(0n)

      const res = await app.inject({ method: 'POST', url: '/machine-payments/sweep/prepare', headers })

      expect(res.statusCode).toBe(200)
      expect(res.json().nothing_stranded).toBe(true)
      // only the auth query ran — no INSERT
      expect(mockQuery).toHaveBeenCalledTimes(1)
      expect(sweepMocks.buildSweepAuthorization).not.toHaveBeenCalled()
    })

    it('builds an authorization and binding when funds are stranded', async () => {
      mockQuery.mockResolvedValueOnce(authRow())
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(40000n)
      sweepMocks.buildSweepAuthorization.mockReturnValueOnce(AUTH)
      const expectedAuth = { version: 1, message: 'm', signature: '0xaa', signer: ATTACKER }
      sweepMocks.signSweepExpectedContext.mockResolvedValueOnce(expectedAuth)

      const res = await app.inject({ method: 'POST', url: '/machine-payments/sweep/prepare', headers })

      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body.authorization).toEqual(AUTH)
      expect(body.expected_auth).toEqual(expectedAuth)
      expect(body.amount).toBe('0.04')
      expect(body.amount_atomic).toBe('40000')
    })

    it('parks the sweep when the stranded balance exceeds the auto-sweep cap (#700)', async () => {
      mockQuery.mockResolvedValueOnce(authRow())
      allowanceMocks.getTokenBalance.mockResolvedValueOnce(2_000_000n) // 2 USDC > 1 cap

      const res = await app.inject({ method: 'POST', url: '/machine-payments/sweep/prepare', headers })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.parked).toBe(true)
      expect(body.authorization).toBeUndefined()
      expect(body.amount).toBe('2.0')
      expect(body.cap_usdc).toBe('1')
    })
  })

  describe('POST /sweep/submit', () => {
    it('relays when the signature recovers the delegate and balance covers it', async () => {
      mockQuery.mockResolvedValueOnce(authRow()) // auth
      mockQuery.mockResolvedValueOnce({ rows: [preparedRow()] }) // SELECT prepared
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'sweep-id' }] }) // claim (won)
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
      mockQuery.mockResolvedValueOnce(authRow()) // auth
      mockQuery.mockResolvedValueOnce({ rows: [preparedRow()] }) // SELECT prepared
      mockQuery.mockResolvedValueOnce({ rows: [] }) // claim lost (no row updated)
      mockQuery.mockResolvedValueOnce({ rows: [preparedRow({ status: 'submitting' })] }) // re-read
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
      mockQuery.mockResolvedValueOnce(authRow()) // auth
      mockQuery.mockResolvedValueOnce({ rows: [preparedRow()] }) // SELECT prepared
      mockQuery.mockResolvedValueOnce({ rows: [] }) // claim lost
      mockQuery.mockResolvedValueOnce({
        rows: [preparedRow({ status: 'submitted', tx_hash: TX })],
      }) // re-read: winner already finished
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
      mockQuery.mockResolvedValueOnce(authRow())
      mockQuery.mockResolvedValueOnce({ rows: [preparedRow()] })
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
      mockQuery.mockResolvedValueOnce(authRow())
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: NONCE }, signature: SIG },
      })

      expect(res.statusCode).toBe(404)
    })

    it('returns 409 balance_changed when the delegate no longer covers the value', async () => {
      mockQuery.mockResolvedValueOnce(authRow())
      mockQuery.mockResolvedValueOnce({ rows: [preparedRow()] })
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
      mockQuery.mockResolvedValueOnce(authRow())
      mockQuery.mockResolvedValueOnce({ rows: [preparedRow({ status: 'submitted', tx_hash: TX })] })

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
      mockQuery.mockResolvedValueOnce(authRow())

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/sweep/submit',
        headers,
        payload: { authorization: { nonce: '0xdead' }, signature: SIG },
      })

      expect(res.statusCode).toBe(400)
    })
  })
})
