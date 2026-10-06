// db-mock-exempt: the contract under test is "the retired-rail refusal answers before any chain read, and nothing is written" — the pool stand-in exists so writes can be asserted absent (the allowance-rail-retired.test.ts model)
/**
 * #3640 (epic #3634, Gnosis removal slice 2a) — a legacy chain-100 agent gets
 * the retired-rail 410, never a 500, once chain 100 leaves the registry.
 *
 * Today the 410 holds only by CALL ORDER: in `POST /payments` the rail gate
 * runs before `getChain(agent.chain_id)`. When the epic removes chain 100 from
 * the registry, every chain read for 100 throws or answers "unknown", so any
 * refactor that moved a chain read above the gate would turn every legacy
 * chain-100 account's clean 410 into a 500. The retired-rail suite
 * (`allowance-rail-retired.test.ts`) runs on 84532 only, so nothing pinned this.
 *
 * The simulation, switched on in `beforeAll` (after module load), covers both
 * registry layers:
 *   - backend `domain/chains.ts`: every exported per-chain reader
 *     (`getChain`, `getExplorerUrl`, `settlementTokenForChain`) throws for 100,
 *     and `isSupportedChain` / `isDeployableChain` answer false — the module's
 *     own `CHAINS` map is built at load, so its readers are wrapped here;
 *   - `@haven_ai/core`: `CHAIN_REGISTRY[100]` is deleted, so `getChainData`,
 *     `getTokenBySymbol` and `isRegisteredChain` behave as after removal
 *     (restored in `afterAll`).
 * NOT covered: values snapshotted at module load. Since #3669,
 * `SUPPORTED_CHAIN_IDS` is an explicit [8453, 84532] and `deployableChainIds()`
 * derives from it, so neither ever held 100 after that change; only
 * `REGISTRY_CHAIN_IDS` and the backend's `KNOWN_CHAIN_IDS` are registry-derived.
 * The switch flips in `beforeAll` so those are built from the full registry,
 * as in a pre-removal boot.
 * (Until #3642, `domain/tokens.ts` also read chain 100 at load; that is gone,
 * and `domain/__tests__/boot-without-chain-100.test.ts` pins it.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: async () => ({ remainingAtomic: '1000000000000', fromChain: true }),
}))

const { mockQuery, registry } = vi.hoisted(() => ({ mockQuery: vi.fn(), registry: { chain100Removed: false } }))
vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))
vi.mock('../../infra/fiat-values.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/fiat-values.js')>()
  return { ...actual, getFiatValuesForTokenAmount: async () => ({ usd: 0, eur: 0, sek: 0 }), getBookTimeCapture: async () => null }
})
// The backend layer of the simulation (see the header): every exported
// per-chain reader treats 100 as gone once the switch is on.
vi.mock('../../domain/chains.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../domain/chains.js')>()
  const gone = (chainId: number) => chainId === 100 && registry.chain100Removed
  const thrower =
    <A extends unknown[], R>(fn: (chainId: number, ...rest: A) => R) =>
    (chainId: number, ...rest: A): R => {
      if (gone(chainId)) throw new Error('Unsupported chain: 100')
      return fn(chainId, ...rest)
    }
  return {
    ...actual,
    getChain: thrower(actual.getChain),
    getExplorerUrl: thrower(actual.getExplorerUrl),
    settlementTokenForChain: thrower(actual.settlementTokenForChain),
    isSupportedChain: (chainId: number) => !gone(chainId) && actual.isSupportedChain(chainId),
    isDeployableChain: (chainId: number) => !gone(chainId) && actual.isDeployableChain(chainId),
  }
})

import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import paymentRoutes from '../payments.js'
import x402Routes from '../x402.js'
import machinePaymentRoutes from '../machine-payments.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { allowanceModuleRailRetired } from '../../rails/execution-rail.js'
import { getChain, getExplorerUrl, isSupportedChain } from '../../domain/chains.js'
import { CHAIN_REGISTRY, getChainData, isRegisteredChain } from '@haven_ai/core'

const RETIRED_ACCOUNT = allowanceModuleRailRetired('account').body.error
const RETIRED_INTENT = allowanceModuleRailRetired('intent').body.error

const CHAIN_100 = 100
const DELEGATE = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const EURE = '0xcB444e90D8198415266c6a2724b7900fb12FC56E'
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'

function agentRow(rail: string | null) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    user_id: '22222222-2222-2222-2222-222222222222',
    name: 'Legacy Gnosis Agent',
    delegate_address: DELEGATE,
    account_address: SAFE,
    chain_id: CHAIN_100,
    status: 'active',
    execution_rail: rail,
    account_type: 'legacy_safe',
  }
}

function intentRow() {
  return {
    id: PAYMENT_ID,
    agent_id: agentRow(null).id,
    user_id: agentRow(null).user_id,
    account_address: SAFE,
    chain_id: CHAIN_100,
    token_symbol: 'EURe',
    token_address: EURE,
    to_address: RECIPIENT.toLowerCase(),
    amount_raw: '10000000000000000',
    amount_human: '0.01',
    delegate_address: DELEGATE,
    allowance_nonce: 7,
    sign_hash: `0x${'cd'.repeat(32)}`,
    signature: null,
    tx_hash: null,
    status: 'pending_signature',
    error_message: null,
    created_at: '2026-08-24T10:00:00.000Z',
    signed_at: null,
    submitted_at: null,
    confirmed_at: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    execution_rail: null,
    payment_rail: null,
    source: 'direct',
  }
}

type DbRoute = [RegExp, () => { rows: unknown[] }]
function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown) => {
    const text = String(sql)
    for (const [re, handler] of routes) if (re.test(text)) return handler()
    return { rows: [] }
  })
}
const authRoute = (rail: string | null): DbRoute => [/api_key_hash = \$1/, () => ({ rows: [agentRow(rail)] })]
const railRoute = (rail: string | null): DbRoute => [/LEFT JOIN smart_accounts/, () => ({ rows: [{ execution_rail: rail }] })]
const intentRoute: DbRoute = [/FROM payment_intents/, () => ({ rows: [intentRow()] })]

const writes = () =>
  mockQuery.mock.calls.map((c) => String(c[0])).filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql.trim()))

/** `null` = no Safe row (LEFT JOIN null), and the literal marking. */
const LEGACY_RAILS: Array<[string, string | null]> = [
  ['a missing Safe row (LEFT JOIN null)', null],
  ['the literal allowance_module marking', 'allowance_module'],
]

describe('#3640 — a legacy chain-100 agent gets the retired-rail 410, not a 500, after chain 100 leaves the registry', () => {
  let app: FastifyInstance
  const headers = { authorization: 'Bearer sk_agent_test' }

  let savedChain100: (typeof CHAIN_REGISTRY)[number] | undefined

  beforeAll(async () => {
    registry.chain100Removed = true
    savedChain100 = CHAIN_REGISTRY[100]
    delete CHAIN_REGISTRY[100]
    app = Fastify({ logger: false })
    // Production's enforced set (index.ts): payments, machine-payments, x402.
    installRequestValidation(app, {
      mode: 'enforce',
      enforcedModules: ['routes/payments.ts', 'routes/machine-payments.ts', 'routes/x402.ts'],
    })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(paymentRoutes, { prefix: '/payments' })
    await app.register(x402Routes, { prefix: '/x402' })
    await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
  })
  afterAll(async () => {
    await app.close()
    if (savedChain100) CHAIN_REGISTRY[100] = savedChain100
    registry.chain100Removed = false
  })
  beforeEach(() => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [] })
  })

  it('POSITIVE CONTROL — the simulation is live on both layers; Base and Base Sepolia still resolve', () => {
    expect(() => getChain(100)).toThrow('Unsupported chain: 100')
    expect(() => getExplorerUrl(100, 'tx', '0xabc')).toThrow('Unsupported chain: 100')
    expect(isSupportedChain(100)).toBe(false)
    expect(isRegisteredChain(100)).toBe(false)
    expect(() => getChainData(100)).toThrow()
    expect(getChain(8453).name).toBe('Base')
    expect(getChain(84532).name).toBe('Base Sepolia')
    expect(isRegisteredChain(84532)).toBe(true)
  })

  it.each(LEGACY_RAILS)('POST /payments — %s: 410, nothing written', async (_label, rail) => {
    primeDb(authRoute(rail), railRoute(rail))
    const res = await app.inject({ method: 'POST', url: '/payments', headers, payload: { token: 'EURe', amount: '0.01', to: RECIPIENT } })
    expect(res.statusCode).toBe(410)
    expect(res.json().error).toBe(RETIRED_ACCOUNT)
    expect(writes()).toEqual([])
  })

  it('POST /payments/:id/sign — a pending chain-100 legacy intent: 410, nothing written', async () => {
    primeDb(authRoute('allowance_module'), railRoute('allowance_module'), intentRoute)
    const res = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers,
      payload: { signature: `0x${'ab'.repeat(65)}` },
    })
    expect(res.statusCode).toBe(410)
    expect(res.json().error).toBe(RETIRED_INTENT)
    expect(writes()).toEqual([])
  })

  it.each(['/x402/authorize', '/x402'].flatMap((url) => LEGACY_RAILS.map(([label, rail]) => [url, label, rail] as const)))(
    'POST %s — %s: 410, nothing written',
    async (url, _label, rail) => {
    primeDb(authRoute(rail), railRoute(rail))
    const res = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { url: 'https://merchant.example/resource', payTo: RECIPIENT, amount: '10000', asset: EURE, network: 'eip155:100' },
    })
    expect(res.statusCode).toBe(410)
    expect(res.json().error).toBe(RETIRED_ACCOUNT)
    expect(writes()).toEqual([])
    },
  )

  it.each(LEGACY_RAILS)('POST /machine-payments/send — %s: 410, nothing written', async (_label, rail) => {
    primeDb(authRoute(rail), railRoute(rail))
    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/send',
      headers,
      payload: { asset: 'USDC', recipient: RECIPIENT, amount: '0.01' },
    })
    expect(res.statusCode).toBe(410)
    expect(res.json().error).toBe(RETIRED_ACCOUNT)
    expect(writes()).toEqual([])
  })

  it.each(LEGACY_RAILS)('GET /machine-payments/allowances — %s: 410, nothing written', async (_label, rail) => {
    primeDb(authRoute(rail), railRoute(rail))
    const res = await app.inject({ method: 'GET', url: '/machine-payments/allowances', headers })
    expect(res.statusCode).toBe(410)
    expect(res.json().error).toBe(RETIRED_ACCOUNT)
    expect(writes()).toEqual([])
  })
})
