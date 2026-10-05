/**
 * #3620 (epic #3615 S-E) — runs every applicable cell of `ENTRYPOINT_MATRIX`
 * through the real route against a real database.
 *
 * Each cell gets its own world: a paying agent B on the
 * delegation rail with its own open grant, a recipient-pinned grant, a task
 * budget whose parent is a separate grant, and a sub-budget chain from agent
 * A (A's budget → A's parent-child → B's grant). Real SQL resolves every scope:
 * the resolver, the idempotency lookups, the hourly cap and the intent
 * inserts. Mocked are only the seams that would leave the process: the
 * period-budget reader (steered per link), the task-cap spent reader, the
 * bundler-backed prepare, the hybrid-account derivation and deploy, and the
 * fiat price for the refusal ledger.
 *
 * Every replay state on the three authorize rows is made by the entrypoint
 * itself (the pre-check's rows are seeded directly: it creates none): a fresh
 * request under
 * an ample budget creates the real `pending_signature` row, which is then
 * replayed, moved to `failed`, or confirmed with a `tx_hash`. Every link is
 * made short before each replay, so an answer that consulted the budget
 * would show it.
 *
 * `MATRIX_MEASURE=1` prints the observed answer of every cell instead of
 * asserting — the instrument used to fill the table.
 */
import { createHash } from 'crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const { remaining, mockCompute, mockEnsureDeployed, mockCreateRail, mockPrepareFunding } = vi.hoisted(() => ({
  /** Remaining period budget per link marker (the delegation JSON's `salt`). */
  remaining: new Map<string, string>(),
  mockCompute: vi.fn(),
  mockEnsureDeployed: vi.fn(),
  mockCreateRail: vi.fn(),
  mockPrepareFunding: vi.fn(),
}))

vi.mock('../../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: async (_chainId: number, json: string) => {
    const salt = String((JSON.parse(json) as { salt?: unknown }).salt)
    const value = remaining.get(salt)
    if (value === undefined) throw new Error(`matrix: no remaining figure for link ${salt}`)
    return { remainingAtomic: value, fromChain: true }
  },
}))
vi.mock('../../../infra/chain/task-budget-spent-reader.js', () => ({ readTaskBudgetSpent: async () => 0n }))
vi.mock('../../../infra/fiat-values.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/fiat-values.js')>()
  return { ...actual, getFiatValuesForTokenAmount: async () => ({ usd: 0, eur: 0, sek: 0 }) }
})
vi.mock('../../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../rails/hybrid-provisioning.js')>()
  return {
    ...actual,
    computeHybridAccountAddress: (...a: unknown[]) => mockCompute(...a),
    ensureHybridDeployed: (...a: unknown[]) => mockEnsureDeployed(...a),
  }
})
vi.mock('../../../rails/delegation-rail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../rails/delegation-rail.js')>()
  return {
    ...actual,
    delegationRailBundlerUrl: () => 'https://bundler.example/x',
    createDelegationRail: (...a: unknown[]) => mockCreateRail(...a),
  }
})
vi.mock('../../../rails/delegation-authorization.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../rails/delegation-authorization.js')>()
  return { ...actual, prepareDelegationPayment: (...a: unknown[]) => mockPrepareFunding(...a) }
})

import Fastify, { type FastifyInstance } from 'fastify'
import { privateKeyToAccount } from 'viem/accounts'
import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { buildBudgetDelegation } from '../../../rails/delegation-policy.js'
import machinePaymentRoutes from '../../../routes/machine-payments.js'
import paymentRoutes from '../../../routes/payments.js'
import x402Routes from '../../../routes/x402.js'
import {
  ENTRYPOINT_MATRIX,
  MATRIX_ENTRYPOINTS,
  MATRIX_SCOPES,
  MATRIX_STATES,
  isNotApplicable,
  type MatrixEntrypoint,
  type MatrixScope,
  type MatrixState,
} from './entrypoint-matrix.js'

const CHAIN = 84532
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const OPEN_MERCHANT = '0x' + 'c1'.repeat(20)
const PINNED_MERCHANT = '0x' + 'c2'.repeat(20)
const TREASURY = '0x' + 'aa'.repeat(20)
const B_ACCT = '0x' + 'b0'.repeat(20)
const A_ACCT = '0x' + 'a0'.repeat(20)
const B_SIGNER = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)
const AMOUNT_ATOMIC = 100_000n
const AMPLE = '5000000'
const SHORT = '50000'
const NOW = Math.floor(Date.now() / 1000)

/** Link markers: each delegation JSON carries one as its `salt`. */
const LINK = {
  own: '0x101',
  pinned: '0x102',
  taskParent: '0x103',
  taskChild: '0x104',
  aBudget: '0x105',
  parentChild: '0x106',
  grant: '0x107',
} as const
type LinkName = keyof typeof LINK

function setAll(value: string) {
  for (const salt of Object.values(LINK)) remaining.set(salt, value)
}

let seq = 0
// A per-run nonce in the high bits, so a hash can never collide with a row an
// earlier run left behind if a reset is ever skipped.
const RUN = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
const hash = (n: number) => `0x${RUN}${n.toString(16).padStart(58, '0')}`

function budgetJson(link: LinkName, delegate: string, recipient: string | null): string {
  const built = buildBudgetDelegation({
    agentId: `matrix-${link}`,
    chainId: CHAIN,
    treasuryAddress: TREASURY as `0x${string}`,
    delegateAccountAddress: delegate as `0x${string}`,
    tokenAddress: USDC as `0x${string}`,
    budgetAtomic: 5_000_000n,
    periodSeconds: 86_400,
    startDate: NOW - 60,
    expiresAt: NOW + 86_400,
    version: 1,
    ...(recipient ? { recipient: recipient as `0x${string}` } : {}),
  })
  return JSON.stringify({ ...built, salt: LINK[link], signature: '0x' + 'ab'.repeat(65) })
}

function childJson(link: LinkName, delegate: string, delegator: string, authority: string): string {
  return JSON.stringify({ delegate, delegator, authority, caveats: [], salt: LINK[link], signature: '0x' + 'cd'.repeat(65) })
}

interface World {
  apiKey: string
  agentId: string
  userId: string
  taskBudgetId: string
  subBudgetId: string
}

async function seedAgent(label: string): Promise<{ userId: string; agentId: string; apiKey: string }> {
  const apiKey = `sk_agent_matrix_${label}_${++seq}_${Date.now()}`
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`matrix-${label}-${seq}-${Date.now()}-${Math.random()}@test.example`],
  )
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [user.rows[0].id, TREASURY, CHAIN],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, api_key_hash, api_key_prefix, account_id, status)
     VALUES ($1, $2, $3, $4, 'sk_agent_mtx', $5, 'active') RETURNING id`,
    [user.rows[0].id, `matrix ${label}`, B_SIGNER.address, createHash('sha256').update(apiKey).digest('hex'), account.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id, apiKey }
}

async function seedDelegation(agentId: string, delegationHash: string, json: string, recipient: string | null, expiresAt: number) {
  await db.query(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, recipient_address, delegation_hash,
        delegation_json, version, status, budget_atomic, period_seconds, start_date, expires_at)
     VALUES ($1, $2, LOWER($3), LOWER($4), $5, $6, 1, 'active', '5000000', 86400, 0, $7)`,
    [agentId, CHAIN, USDC, recipient, delegationHash, json, expiresAt],
  )
}

async function seedWorld(label: string): Promise<World> {
  const b = await seedAgent(`${label}-b`)
  const a = await seedAgent(`${label}-a`)
  const ownHash = hash(++seq), pinnedHash = hash(++seq), taskParentHash = hash(++seq)
  const aBudgetHash = hash(++seq), pcHash = hash(++seq), grantHash = hash(++seq), taskChildHash = hash(++seq)
  // B's own open grant expires FIRST, so the (token, recipient) selection
  // picks it over the task budget's parent (`ORDER BY … expires_at ASC`).
  await seedDelegation(b.agentId, ownHash, budgetJson('own', B_ACCT, null), null, 9_000_000_000)
  await seedDelegation(b.agentId, pinnedHash, budgetJson('pinned', B_ACCT, PINNED_MERCHANT), PINNED_MERCHANT, 9_000_000_000)
  await seedDelegation(b.agentId, taskParentHash, budgetJson('taskParent', B_ACCT, null), null, 9_999_999_999)
  await seedDelegation(a.agentId, aBudgetHash, budgetJson('aBudget', A_ACCT, null), null, 9_999_999_999)
  const task = await db.query<{ id: string }>(
    `INSERT INTO agent_task_budgets
       (agent_id, chain_id, token_address, recipient_address, parent_delegation_hash,
        delegation_hash, delegation_json, max_atomic, status, expires_at)
     VALUES ($1, $2, LOWER($3), NULL, $4, $5, $6, '5000000', 'open', $7) RETURNING id`,
    [b.agentId, CHAIN, USDC, taskParentHash, taskChildHash, childJson('taskChild', B_ACCT, B_ACCT, taskParentHash), NOW + 7200],
  )
  const pc = await db.query<{ id: string }>(
    `INSERT INTO agent_sub_budgets
       (agent_id, parent_agent_id, chain_id, token_address, recipient_address,
        parent_delegation_hash, delegation_hash, delegation_json, period_amount_atomic, status, expires_at)
     VALUES ($1, $1, $2, LOWER($3), NULL, $4, $5, $6, '5000000', 'open', $7) RETURNING id`,
    [a.agentId, CHAIN, USDC, aBudgetHash, pcHash, childJson('parentChild', A_ACCT, A_ACCT, aBudgetHash), NOW + 7200],
  )
  const grant = await db.query<{ id: string }>(
    `INSERT INTO agent_sub_budgets
       (agent_id, parent_agent_id, parent_sub_budget_id, chain_id, token_address, recipient_address,
        parent_delegation_hash, delegation_hash, delegation_json, period_amount_atomic, status, expires_at)
     VALUES ($1, $2, $3, $4, LOWER($5), NULL, $6, $7, $8, '5000000', 'open', $9) RETURNING id`,
    [b.agentId, a.agentId, pc.rows[0].id, CHAIN, USDC, pcHash, grantHash, childJson('grant', B_ACCT, A_ACCT, pcHash), NOW + 3600],
  )
  return { ...b, taskBudgetId: task.rows[0].id, subBudgetId: grant.rows[0].id }
}

/** The narrowest link each scope redeems — the one `fresh` makes short. */
const NARROWEST: Record<MatrixScope, LinkName> = {
  none: 'own',
  taskBudget: 'taskParent',
  // The MIDDLE link, not B's grant: periodPrecheckLinks returns the grant
  // first and A's budget last, so a short middle link is what both a
  // first-link-decides and a last-link-decides pre-check let through.
  subBudget: 'parentChild',
  merchantPin: 'pinned',
} as Record<MatrixScope, LinkName>

function merchantFor(scope: MatrixScope): string {
  return scope === 'merchantPin' ? PINNED_MERCHANT : OPEN_MERCHANT
}

function scopeIds(scope: MatrixScope, world: World, style: 'snake' | 'camel'): Record<string, string> {
  if (scope === 'taskBudget') return style === 'snake' ? { task_budget_id: world.taskBudgetId } : { taskBudgetId: world.taskBudgetId }
  if (scope === 'subBudget') return style === 'snake' ? { sub_budget_id: world.subBudgetId } : { subBudgetId: world.subBudgetId }
  return {}
}

/** Normalise an answer to the table's outcome vocabulary. */
function observe(status: number, body: Record<string, unknown>): string {
  if (typeof body.error_code === 'string') return `${status} ${body.error_code}`
  if (typeof body.sufficient === 'boolean') return `${status} sufficient=${body.sufficient}${body.replay ? ' replay' : ''}`
  if (body.sign_data) return `${status} sign_data`
  if (status === 200 && body.tx_hash) return '200 stored'
  return `${status}`
}

let app: FastifyInstance

async function send(entrypoint: MatrixEntrypoint, scope: MatrixScope, world: World, key: string) {
  const auth = { authorization: `Bearer ${world.apiKey}` }
  const merchant = merchantFor(scope)
  if (entrypoint === 'payments') {
    return app.inject({
      method: 'POST', url: '/payments', headers: auth,
      payload: { token: 'USDC', amount: '0.1', to: merchant, idempotency_key: key, ...scopeIds(scope, world, 'snake') },
    })
  }
  if (entrypoint === 'budget-precheck') {
    return app.inject({
      method: 'POST', url: '/machine-payments/budget-precheck', headers: auth,
      payload: { chainId: CHAIN, token: USDC, amountAtomic: AMOUNT_ATOMIC.toString(), merchantTo: merchant, resourceUrl: 'https://merchant.example/matrix', idempotencyKey: key },
    })
  }
  const funding = entrypoint === 'x402-funding'
  return app.inject({
    method: 'POST', url: '/x402/authorize', headers: auth,
    payload: {
      url: 'https://merchant.example/matrix',
      payTo: funding ? B_SIGNER.address : merchant,
      ...(funding ? { merchantPayTo: merchant } : {}),
      amount: AMOUNT_ATOMIC.toString(),
      asset: USDC,
      network: `eip155:${CHAIN}`,
      idempotencyKey: key,
      ...scopeIds(scope, world, 'camel'),
    },
  })
}

/** Seed the budget-precheck's keyed row directly — the pre-check creates none. */
async function seedPrecheckRow(scope: MatrixScope, world: World, key: string, status: string, txHash: string | null) {
  const merchant = merchantFor(scope).toLowerCase()
  await db.query(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, expires_at, execution_rail, chain_id, source, payment_rail,
        x402_resource_url, x402_merchant_address, machine_metadata,
        x402_idempotency_key, task_budget_id, sub_budget_id)
     VALUES ($1, $2, $3, 'USDC', LOWER($4), $5, $6, '0.1', $7, 0, $8,
             $9, $10, NOW() + interval '10 minutes', 'delegation', $11, 'x402', 'x402',
             'https://merchant.example/matrix', $5, $12, $13, $14, $15)`,
    [
      world.agentId, world.userId, TREASURY, USDC, merchant, AMOUNT_ATOMIC.toString(), B_SIGNER.address,
      hash(++seq), status, txHash, CHAIN, JSON.stringify({ network: `eip155:${CHAIN}`, settlement_scheme: 'erc7710' }), key,
      scope === 'taskBudget' ? world.taskBudgetId : null,
      scope === 'subBudget' ? world.subBudgetId : null,
    ],
  )
}

async function intentIdForKey(agentId: string, key: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM payment_intents WHERE agent_id = $1
       AND (x402_idempotency_key = $2 OR send_idempotency_key = $2 OR machine_idempotency_key = $2)
     ORDER BY created_at DESC LIMIT 1`,
    [agentId, key],
  )
  return rows[0]?.id ?? null
}

/** Run one cell and return its observed answer (or a setup failure). */
async function runCell(entrypoint: MatrixEntrypoint, scope: MatrixScope, state: MatrixState): Promise<string> {
  const world = await seedWorld(`${entrypoint}-${scope}-${state}`)
  const key = `matrix-${entrypoint}-${scope}-${state}-${++seq}`
  if (state === 'fresh') {
    setAll(AMPLE)
    remaining.set(LINK[NARROWEST[scope]], SHORT)
    const res = await send(entrypoint, scope, world, key)
    return observe(res.statusCode, res.json())
  }
  // Every replay starts from a row under this key.
  if (entrypoint === 'budget-precheck') {
    const status = state === 'settledReplay' ? 'confirmed' : state === 'pendingReplay' ? 'pending_signature' : 'failed'
    await seedPrecheckRow(scope, world, key, status, state === 'settledReplay' ? hash(++seq) : null)
  } else {
    setAll(AMPLE)
    const created = await send(entrypoint, scope, world, key)
    if (created.statusCode !== 201) return `SETUP ${observe(created.statusCode, created.json())}`
    const id = await intentIdForKey(world.agentId, key)
    if (!id) return 'SETUP no intent row'
    if (state === 'settledReplay') {
      await db.query(`UPDATE payment_intents SET status = 'confirmed', tx_hash = $2 WHERE id = $1`, [id, hash(++seq)])
    } else if (state === 'terminalReplay') {
      await db.query(`UPDATE payment_intents SET status = 'failed' WHERE id = $1`, [id])
    }
  }
  setAll(SHORT)
  const res = await send(entrypoint, scope, world, key)
  return observe(res.statusCode, res.json())
}

const MEASURE = process.env.MATRIX_MEASURE === '1'

describeDb('#3620 entrypoint × scope × state matrix (real routes, real resolver SQL)', () => {
  beforeAll(async () => {
    process.env.X402_BINDING_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
    await initDbHarness()
    await resetDb()
    mockCompute.mockResolvedValue(B_ACCT)
    mockEnsureDeployed.mockResolvedValue({ address: B_ACCT, alreadyDeployed: true })
    mockCreateRail.mockResolvedValue({
      delegateAccountAddress: B_ACCT,
      prepareRedemption: vi.fn().mockResolvedValue({
        userOperation: { sender: B_ACCT, nonce: 1n, callData: '0x' },
        userOpHash: `0x${'11'.repeat(32)}`,
        signingTypedData: {
          domain: { chainId: CHAIN, name: 'HybridDeleGator', version: '1', verifyingContract: B_ACCT },
          types: { PackedUserOperation: [{ name: 'sender', type: 'address' }] },
          primaryType: 'PackedUserOperation',
          message: { sender: B_ACCT },
        },
        delegateAccountAddress: B_ACCT,
      }),
      prepareAccountCall: vi.fn(),
      submitRedemption: vi.fn(),
    })
    mockPrepareFunding.mockImplementation(async () => ({
      delegationHash: hash(1),
      prepared: {
        userOpHash: `0x${'aa'.repeat(32)}`,
        userOperation: { sender: B_ACCT, nonce: 1n, callData: '0x' },
        signingTypedData: {
          domain: { chainId: CHAIN, name: 'HybridDeleGator', version: '1', verifyingContract: B_ACCT },
          types: { PackedUserOperation: [{ name: 'sender', type: 'address' }] },
          primaryType: 'PackedUserOperation',
          message: { sender: B_ACCT },
        },
        delegateAccountAddress: B_ACCT,
      },
    }))
    app = Fastify({ logger: false })
    await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
    await app.register(paymentRoutes, { prefix: '/payments' })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })

  if (MEASURE) {
    it('measures every cell', async () => {
      const out: string[] = []
      for (const e of MATRIX_ENTRYPOINTS) for (const s of MATRIX_SCOPES) for (const st of MATRIX_STATES) {
        let observed: string
        try { observed = await runCell(e, s, st) } catch (err) { observed = `THREW ${(err as Error).message.slice(0, 160)}` }
        out.push(`${e} | ${s} | ${st} | ${observed}`)
      }
      console.log('MATRIX-MEASURE\n' + out.join('\n'))
    }, 600_000)
    return
  }

  for (const entrypoint of MATRIX_ENTRYPOINTS) {
    for (const scope of MATRIX_SCOPES) {
      for (const state of MATRIX_STATES) {
        const entry = ENTRYPOINT_MATRIX[entrypoint]?.[scope]?.[state]
        if (!entry || isNotApplicable(entry)) continue
        it(`${entrypoint} × ${scope} × ${state} → ${entry.outcome}`, async () => {
          expect(await runCell(entrypoint, scope, state)).toBe(entry.outcome)
        }, 60_000)
      }
    }
  }
})
