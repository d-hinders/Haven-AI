/**
 * #3450 — two concurrent `POST /agents/:id/rekey/:rekeyId/issue` calls on the
 * SAME re-key must not both insert replacement `pending` rows. Before the
 * fix, both calls pass `assertStageAllows('issue')` on the stage `loadStep`
 * reads without a lock, and the stage only flips to `issued` once, at the
 * very END of a call's own loop (`markIssued`) — so a second call that reads
 * a fresh `nextDelegationVersion` after the first call's own insert has
 * already committed, but before that first call reaches `markIssued`, builds
 * a DIFFERENT hash for the same piece and lands a genuine duplicate row.
 * Completion then requires a signature for a hash the caller never received.
 *
 * ## Why this is a DETERMINISTIC test, not a statistical one
 *
 * The spec review's own reproduction (40 trials, 0–19 ms stagger) is
 * statistical because nothing pins the interleaving. This test pins it with
 * a real control point: `insertRekeyDelegation` is wrapped (real
 * implementation underneath, `importOriginal`) so the FIRST call across both
 * HTTP requests pauses immediately after it resolves — after whatever it did
 * actually happened against Postgres — until the test explicitly resumes it.
 * The second HTTP call is started only once that pause is confirmed, which is
 * exactly the "loser reads its version after the winner's first insert has
 * committed, and before the winner's `markIssued`" window the corrected issue
 * body requires. Which HTTP call actually finishes first is intentionally
 * NOT assumed — see the comment above the assertions — because the answer
 * differs between the buggy and fixed trees, and asserting a specific side
 * would make the test tree-shaped.
 *
 * ## How this test proves the FIX, not just the bug
 *
 * The exact same wrapper and interleaving run against whichever
 * `agent-rekey.ts` / `agent-rekeys.ts` are on disk. `regression.fails-on-dev.test.ts`-style
 * "run twice" isn't used here — instead this file's own `it` proves the FIX
 * (it runs against the fixed tree checked in), and the accompanying mutation
 * runbook (see the PR description) swaps in a `cp` backup of the pre-#3450
 * route + repository to show the identical assertions fail there. Real
 * Postgres throughout (`describeDb`) — only `computeHybridAccountAddress` is
 * mocked, matching the spec review's own reproduction.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import type { CarrySnapshotEntry } from '../../infra/repositories/agent-rekeys.js'

const { mockComputeAddress } = vi.hoisted(() => ({
  mockComputeAddress: vi.fn(),
}))

// Mutable pause-control state, reset in `beforeEach`. Module-scoped because
// the `vi.mock` factory below cannot close over per-test `let` bindings
// declared inside `it` — it runs once, at import time.
let pauseFirstInsert = false
let insertCallCount = 0
let firstInsertStarted!: () => void
let firstInsertStartedPromise: Promise<void>
let resumeWinner!: () => void
let resumeWinnerPromise: Promise<void>

vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return {
    ...actual,
    computeHybridAccountAddress: (...a: unknown[]) => mockComputeAddress(...a),
  }
})

vi.mock('../../infra/repositories/agent-rekeys.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../infra/repositories/agent-rekeys.js')>()
  return {
    ...actual,
    insertRekeyDelegation: async (
      ...args: Parameters<typeof actual.insertRekeyDelegation>
    ): ReturnType<typeof actual.insertRekeyDelegation> => {
      insertCallCount += 1
      const myIndex = insertCallCount
      const result = await actual.insertRekeyDelegation(...args)
      if (pauseFirstInsert && myIndex === 1) {
        firstInsertStarted()
        await resumeWinnerPromise
      }
      return result
    },
  }
})

const agentRekeyRoutes = (await import('../agent-rekey.js')).default

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const OLD_DELEGATE = '0x00000000000000000000000000000000000000d1'
const NEW_DELEGATE = '0x00000000000000000000000000000000000000d2'
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
const FAKE_SIG = ('0x' + 'ab'.repeat(65)) as `0x${string}`

let seq = 0

describeDb('two concurrent issue calls on one re-key (#3450)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(agentRekeyRoutes, { prefix: '/agents' })
  })
  beforeEach(async () => {
    await resetDb()
    insertCallCount = 0
    pauseFirstInsert = false
    firstInsertStartedPromise = new Promise<void>((resolve) => {
      firstInsertStarted = resolve
    })
    resumeWinnerPromise = new Promise<void>((resolve) => {
      resumeWinner = resolve
    })
    mockComputeAddress.mockReset()
    mockComputeAddress.mockResolvedValue(DELEGATE_ACCOUNT)
  })
  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })

  function userHeaders(userId: string): Record<string, string> {
    return { authorization: `Bearer ${app.jwt.sign({ sub: userId, email: 'u@test.dev' })}` }
  }

  async function seedAgent(): Promise<{ userId: string; agentId: string }> {
    const n = ++seq
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`rk-conc-${n}-${Date.now()}@test.example`],
    )
    const userId = user.rows[0].id
    const safe = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
       VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid') RETURNING id`,
      [userId, `0x${String(n).padStart(40, 'a')}`],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
       VALUES ($1, $2, 'Rekey agent', $3, $4, 'sk_agent_old', 'active') RETURNING id`,
      [userId, safe.rows[0].id, OLD_DELEGATE, `hash-${n}-${Date.now()}`],
    )
    return { userId, agentId: agent.rows[0].id }
  }

  /** A snapshot entry that plans BOTH a `carry` and a `steady` piece. */
  function snapshotEntry(): CarrySnapshotEntry {
    const nowSec = Math.floor(Date.now() / 1000)
    const DAY = 86_400
    return {
      delegation_hash: `0x${String(++seq).padStart(64, '0')}`,
      token_address: USDC,
      recipient_address: null,
      budget_atomic: '100000000',
      period_seconds: DAY,
      // Started an hour ago, so `meteredAtSec` (below) falls inside the
      // current period and the far-future expiry guarantees a steady grant
      // after the boundary.
      start_date: nowSec - 3_600,
      expires_at: nowSec + 365 * DAY,
      remaining_atomic: '40000000',
      from_chain: true,
    }
  }

  async function seedMeteredRekey(
    agentId: string,
    userId: string,
  ): Promise<{ rekeyId: string }> {
    const { openRekey, markRevoked, markMetered } = await import('../../infra/repositories/agent-rekeys.js')
    const rekey = await openRekey({
      agentId,
      userId,
      oldDelegateAddress: OLD_DELEGATE,
      newDelegateAddress: NEW_DELEGATE,
      residualAtomic: '0',
      residualTokenAddress: null,
      residualDisposition: 'none',
    })
    await markRevoked(rekey.id, agentId, '0xrevoketx')
    await markMetered(rekey.id, agentId, [snapshotEntry()])
    return { rekeyId: rekey.id }
  }

  it(
    'exactly one call inserts rows; completion with its signatures succeeds; no orphaned row from the loser',
    async () => {
      const { userId, agentId } = await seedAgent()
      const { rekeyId } = await seedMeteredRekey(agentId, userId)
      const issuePath = `/agents/${agentId}/rekey/${rekeyId}/issue`
      const headers = userHeaders(userId)

      pauseFirstInsert = true
      const firstCall = app.inject({ method: 'POST', url: issuePath, headers, payload: {} })
      // Do not await `firstCall` — it is deliberately paused mid-flight.
      await firstInsertStartedPromise

      const secondCall = app.inject({ method: 'POST', url: issuePath, headers, payload: {} })
      // Give the second call a moment to actually reach Postgres and (under
      // the fix) block on the row lock the paused call is holding — not load
      // bearing for correctness (real row locks serialise regardless of exact
      // JS scheduling), but it keeps the interleaving close to the AC's
      // wording.
      await new Promise((r) => setTimeout(r, 20))
      resumeWinner()

      const [firstRes, secondRes] = await Promise.all([firstCall, secondCall])
      const responses = [firstRes, secondRes]

      // Deliberately not asserting WHICH of the two HTTP calls is the one
      // that succeeds — under the pre-#3450 trees, the artificially-paused
      // call is not guaranteed to be the one that reaches `markIssued`
      // first (see the file header). What must hold on every tree that
      // passes this test is the OUTCOME shape: exactly one 201, exactly one
      // 409, and — the assertion that actually catches the bug — the
      // committed row count matches what the SUCCESSFUL call reported, not
      // more.
      const success = responses.find((r) => r.statusCode === 201)
      const failure = responses.find((r) => r.statusCode !== 201)
      expect(success).toBeDefined()
      expect(failure).toBeDefined()
      expect(failure!.statusCode).toBe(409)
      expect(failure!.json().error).toBe(
        'This re-key can no longer receive new budget delegations',
      )

      const delegations = success!.json().delegations as Array<{
        delegation_hash: string
        carry_role: string
      }>
      expect(delegations.map((d) => d.carry_role).sort()).toEqual(['carry', 'steady'])

      const rows = await db.query<{ delegation_hash: string; version: number }>(
        `SELECT delegation_hash, version FROM agent_delegations WHERE rekey_id = $1 ORDER BY version`,
        [rekeyId],
      )
      // THE assertion the pre-#3450 trees fail: the loser inserted nothing.
      expect(rows.rowCount).toBe(delegations.length)
      expect(new Set(rows.rows.map((r) => r.delegation_hash))).toEqual(
        new Set(delegations.map((d) => d.delegation_hash)),
      )
      // MUTATION TARGET (#3450) — `nextDelegationVersion` must run on the
      // transaction client: the `carry` and `steady` piece of the SAME call
      // share one (agent, token, recipient) slot, so the `steady` piece has
      // to see the `carry` piece's own still-uncommitted insert to get a
      // DIFFERENT version. On `pool` both pieces would read the same
      // committed MAX (nothing from this call's own uncommitted work) and
      // land the SAME version on both rows, corrupting the #827 salt.
      expect(rows.rows.map((r) => r.version)).toEqual([rows.rows[0].version, rows.rows[0].version + 1])

      // Completion with the successful call's own signatures must succeed —
      // the pre-#3450 defect this issue is about is a `400 missing_signature`
      // here, naming a hash the caller never received.
      const completeRes = await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/rekey/${rekeyId}/complete`,
        headers,
        payload: {
          signatures: delegations.map((d) => ({
            delegation_hash: d.delegation_hash,
            signature: FAKE_SIG,
          })),
        },
      })
      expect(completeRes.statusCode).toBe(200)
    },
    30_000,
  )
})
