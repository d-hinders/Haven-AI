/**
 * Characterization: `kind` is unconstructible as `'approval_request'` (#2085).
 *
 * Written BEFORE the deletions it licenses, per
 * `docs/contributing/ship-playbooks/money.md` §2 — five of the files #2085
 * touches are on the money-path perimeter, and "I read it and it looks dead"
 * is not evidence for deleting a branch on that perimeter.
 *
 * ## The invariant
 *
 * Two reads feed a `kind` discriminator into money-path code:
 * `findReconciliationIntent` (→ `modules/mpp/reconciliation.ts`) and
 * `findIntentForEvidenceScoped` (→ `modules/mpp/evidence.ts`). Both declare a
 * union of `'payment_intent' | 'approval_request'`, and both branch on it.
 *
 * Neither can ever yield the second member: the SQL selects
 * `'payment_intent'::TEXT AS kind` as a literal, `FROM payment_intents`, and
 * since #2055 there is no `approval_requests` table for a sibling read to
 * select from. So every `kind === 'approval_request'` branch downstream is
 * unreachable, and deleting them cannot change behaviour.
 *
 * ## Why on the real-DB harness rather than a mock
 *
 * The claim is about **what a query returns** — `testing-strategy.md` (epic
 * #1219) puts that class on real Postgres by rule. A mocked `pool.query` would
 * assert what the test author already believed, which is precisely the
 * reasoning this file exists to replace. Zero mocks; real Postgres (#1220).
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  FIND_INTENT_FOR_EVIDENCE_SQL,
  FIND_RECONCILIATION_INTENT_SQL,
  findIntentForEvidenceScoped,
  findReconciliationIntent,
} from '../machine-payments.js'

let seq = 0

async function seedIntent(): Promise<{ paymentId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`kind-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'kind agent') RETURNING id`,
    [userId],
  )
  const agentId = agent.rows[0].id
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, source, payment_rail, tx_hash)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000c1',
             '100000', '0.10', '0x00000000000000000000000000000000000000d1',
             0, '0xsign', 'confirmed', NOW() + interval '10 minutes',
             'x402', 'x402', $3)
     RETURNING id`,
    [agentId, userId, `0x${'ab'.repeat(32)}`],
  )
  return { paymentId: intent.rows[0].id, agentId }
}

describeDb('#2085 characterization — `kind` can only ever be payment_intent', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('findReconciliationIntent returns kind=payment_intent for a real row', async () => {
    const { paymentId, agentId } = await seedIntent()
    const row = await findReconciliationIntent(paymentId, agentId)
    expect(row).not.toBeNull()
    expect(row?.kind).toBe('payment_intent')
  })

  it('findIntentForEvidenceScoped returns kind=payment_intent for a real row', async () => {
    const { paymentId, agentId } = await seedIntent()
    const row = await findIntentForEvidenceScoped(paymentId, agentId)
    expect(row).not.toBeNull()
    expect(row?.kind).toBe('payment_intent')
  })

  it('both queries hardcode the literal — the value is not derived from data', async () => {
    // The behavioural assertions above would also pass if `kind` happened to
    // be a column that currently holds one value everywhere. It is not: it is
    // a SQL literal, which is what makes the other union member
    // unconstructible rather than merely unobserved. Pinned structurally so a
    // future edit that turns it into a real column has to confront this test.
    for (const sql of [FIND_RECONCILIATION_INTENT_SQL, FIND_INTENT_FOR_EVIDENCE_SQL]) {
      expect(sql).toContain("'payment_intent'::TEXT AS kind")
      expect(sql).toContain('FROM payment_intents')
      expect(sql).not.toMatch(/approval_request/i)
    }
  })

  it('there is no approval_requests table for a sibling read to select from', async () => {
    // The closing half of the argument. #2055 dropped the table (migration
    // 070), so even a NEW query could not produce the other kind without a
    // migration first — which would be a deliberate act, not a regression.
    const { rows } = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'approval_requests'
       ) AS exists`,
    )
    expect(rows[0].exists).toBe(false)
  })
})
