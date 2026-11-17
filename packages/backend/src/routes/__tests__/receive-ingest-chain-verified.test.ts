// db-mock-exempt: no database behaviour is under test here. The ownership read,
// the chain read and the row insert are mocked at their seams, so this suite
// pins the ROUTE contract and the module's refusal logic: the ingest route reads
// the chain and refuses a caller's description of a transfer. The persistence is
// proven on the real-Postgres harness in
// `modules/transactions/__tests__/merchant-index.db.test.ts` and
// `receive-ingest-characterization.test.ts`.
/**
 * `POST /receive/{accountAddress}/ingest` — the #4903 decision, implemented.
 *
 * The route used to insert an inbound row from values the caller sent, with no
 * chain check. A row planted through it would block the real one, and could
 * then be matched as a sale. The issue required an explicit decision; this
 * suite pins the one taken: the route VERIFIES AGAINST THE CHAIN.
 *
 * What is pinned:
 *
 * 1. A body naming a payer, amount, token or block time is refused with 400 —
 *    not silently ignored, so a caller cannot believe it planted a row. The
 *    schema refuses it, and the handler refuses it too when request validation
 *    is shadow/off.
 * 2. The route indexes the legs the CHAIN reports, and nothing else.
 * 3. A transaction that did not pay the account is a 404 and writes nothing.
 * 4. An unreadable chain is a 503 and writes nothing — never "there is none".
 * 5. Ownership is still enforced: another user's account is a 403.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const mocks = vi.hoisted(() => ({
  findAccountOwnership: vi.fn(),
  readByHash: vi.fn(),
  insert: vi.fn(),
  ownAddresses: vi.fn(),
}))

vi.mock('../../infra/repositories/transaction-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/transaction-history.js')>()
  return { ...actual, findAccountOwnership: (...a: unknown[]) => mocks.findAccountOwnership(...a) }
})

vi.mock('../../modules/transactions/chain-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/transactions/chain-read.js')>()
  return {
    ...actual,
    readInboundTransfersByTxHash: (...a: unknown[]) => mocks.readByHash(...a),
  }
})

vi.mock('../../infra/repositories/inbound-transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/inbound-transfers.js')>()
  return {
    ...actual,
    insertInboundTransfer: (...a: unknown[]) => mocks.insert(...a),
    listOwnAccountAddresses: (...a: unknown[]) => mocks.ownAddresses(...a),
  }
})

import receiveRoutes from '../receive.js'
import { installRequestValidation } from '../../openapi/request-validation.js'

const ACCOUNT_ID = '9b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40'
const ACCOUNT = '0x' + 'aa'.repeat(20)
const TX = '0x' + '11'.repeat(32)
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

const LEG = {
  txHash: TX,
  logIndex: 3,
  payerAddress: '0x' + 'bb'.repeat(20),
  tokenAddress: USDC,
  amountRaw: '1000000',
  blockNumber: 100,
  blockTime: new Date('2026-11-17T00:00:00Z'),
}

describe('POST /receive/:accountAddress/ingest — chain-verified (#4903)', () => {
  let app: FastifyInstance
  let bareApp: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/receive.ts'] })
    await app.register(receiveRoutes, { prefix: '/receive', trustProxyHops: 0 })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })

    // The same routes with request validation OFF: the handler's own refusal is
    // what holds when the schema is switched to shadow or off
    // (`HAVEN_REQUEST_VALIDATION`), so it is pinned separately.
    bareApp = Fastify({ logger: false })
    await bareApp.register(fastifyJwt, { secret: 'test-secret' })
    installRequestValidation(bareApp, { mode: 'off' })
    await bareApp.register(receiveRoutes, { prefix: '/receive', trustProxyHops: 0 })
  })

  afterAll(async () => {
    await app.close()
    await bareApp.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findAccountOwnership.mockResolvedValue([{ id: ACCOUNT_ID }])
    mocks.readByHash.mockResolvedValue({ ok: true, legs: [LEG] })
    mocks.insert.mockResolvedValue('row-id')
    mocks.ownAddresses.mockResolvedValue([])
  })

  function post(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT}/ingest?chain_id=84532`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    })
  }

  it('indexes the legs the chain reports', async () => {
    const res = await post({ tx_hash: TX })

    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ ingested: true, legs_indexed: 1, tx_hash: TX })
    expect(mocks.readByHash).toHaveBeenCalledWith(84532, ACCOUNT, TX)
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    expect(mocks.insert.mock.calls[0]![0]).toMatchObject({
      accountId: ACCOUNT_ID,
      userId: 'user-1',
      chainId: 84532,
      txHash: TX,
      logIndex: 3,
      payerAddress: LEG.payerAddress,
      amountRaw: '1000000',
    })
  })

  it('refuses a caller-supplied payer, amount, token or block time', async () => {
    for (const field of ['payer_address', 'amount_raw', 'token_address', 'block_time', 'block_number']) {
      const res = await post({ tx_hash: TX, [field]: 'x' })
      expect(res.statusCode, `${field}: ${res.body}`).toBe(400)
    }
    expect(mocks.readByHash).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('refuses them in the HANDLER too, when request validation is off', async () => {
    for (const field of ['payer_address', 'amount_raw', 'token_address', 'block_time', 'block_number']) {
      const res = await bareApp.inject({
        method: 'POST',
        url: `/receive/${ACCOUNT}/ingest?chain_id=84532`,
        headers: { authorization: `Bearer ${token}` },
        payload: { tx_hash: TX, [field]: 'x' },
      })
      expect(res.statusCode, `${field}: ${res.body}`).toBe(400)
      expect(res.json().error).toMatch(/reads the chain/)
    }
    expect(mocks.readByHash).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('requires a well-formed tx_hash', async () => {
    expect((await post({})).statusCode).toBe(400)
    expect((await post({ tx_hash: '0xdeadbeef' })).statusCode).toBe(400)
    expect(mocks.readByHash).not.toHaveBeenCalled()
  })

  it('404s and writes nothing when the transaction did not pay the account', async () => {
    mocks.readByHash.mockResolvedValue({ ok: true, legs: [] })

    const res = await post({ tx_hash: TX })

    expect(res.statusCode, res.body).toBe(404)
    expect(res.json().error).toMatch(/No USDC transfer to this account/)
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('503s and writes nothing when the chain could not be read', async () => {
    mocks.readByHash.mockResolvedValue({ ok: false, reason: 'rpc_unavailable' })

    const res = await post({ tx_hash: TX })

    expect(res.statusCode, res.body).toBe(503)
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('403s another user account and never reads the chain', async () => {
    mocks.findAccountOwnership.mockResolvedValue([])

    const res = await post({ tx_hash: TX })

    expect(res.statusCode, res.body).toBe(403)
    expect(mocks.readByHash).not.toHaveBeenCalled()
  })
})
