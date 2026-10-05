/**
 * Real-DB coverage for the outcome-pending booking and the chain
 * reconciliation (#3564).
 *
 * `POST /payments/:id/sign` books a receipt-unconfirmed submit
 * outcome-PENDING — the row stays `submitted`, never `failed`, with the
 * userOpHash recorded — and `runSubmissionReconcileTick` resolves such a row
 * from the bundler's receipt. Both halves are BOOKKEEPING CONTRACTS about
 * what the database does with the row, not about what a handler returns, so
 * they are proven here on the real harness (#1219) and not on positional
 * mocks: the handler split is asserted in
 * `routes/__tests__/payments-session-rail.test.ts`, the tick's read in
 * `modules/payments/__tests__/submission-reconciler.test.ts`.
 *
 * The landed-and-confirmed case is THE mutation test for this issue: the old
 * world booked these rows `failed` and nothing ever corrected them, so the
 * test asserts the row reads `confirmed` with its tx_hash after a
 * landed-and-succeeded receipt — kill that write (or its CAS) and this goes
 * red, which is exactly the regression the issue exists to prevent.
 *
 * Zero mocks; real Postgres on the #1220 harness.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import {
  bookSubmittedOutcomePending,
  reconcileOutcomeConfirmed,
  reconcileOutcomeFailed,
  findOutcomePendingIntents,
} from '../../../infra/repositories/payment-intents.js'

let seq = 0

async function seedOwner(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`reconcile-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'reconcile agent') RETURNING id`,
    [userId],
  )
  return { agentId: agent.rows[0].id, userId }
}

interface SeedOptions {
  status?: string
  txHash?: string | null
  /** `machine_metadata` — the booking writes into this JSONB column. */
  metadata?: Record<string, unknown> | null
  /** `signed_at` offset from NOW, in seconds (negative = in the past). */
  signedAtOffset?: number
}

/** A direct delegation-rail intent in whatever state the test needs. */
async function seedIntent(
  owner: { agentId: string; userId: string },
  opts: SeedOptions = {},
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, chain_id, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, execution_rail, delegation_hash, prepared_user_op,
       machine_metadata, status, expires_at, signed_at
     ) VALUES (
       $1, $2, '0x00000000000000000000000000000000000000f1', 84532, 'USDC',
       '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
       '0x00000000000000000000000000000000000000aa',
       '100000', '0.10', '0x00000000000000000000000000000000000000d1',
       0, $3, 'delegation', $4, '{}'::jsonb,
       $5::jsonb, $6, NOW() + interval '1 hour',
       NOW() + ($7 * interval '1 second')
     )
     RETURNING id`,
    [
      owner.agentId,
      owner.userId,
      `0x${String(++seq).padStart(64, 'b')}`.slice(0, 66),
      `0x${String(seq).padStart(64, 'e')}`.slice(0, 66),
      opts.metadata === undefined ? null : JSON.stringify(opts.metadata),
      opts.status ?? 'submitted',
      opts.signedAtOffset ?? -300,
    ],
  )
  return result.rows[0].id
}

async function readRow(id: string): Promise<Record<string, unknown>> {
  const result = await db.query(
    `SELECT status, tx_hash, error_message, confirmed_at, machine_metadata FROM payment_intents WHERE id = $1`,
    [id],
  )
  return result.rows[0] as unknown as Record<string, unknown>
}

describeDb('#3564 — outcome-pending booking and chain reconciliation', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('the booking keeps the row non-terminal and records the userOpHash for the reconciler', async () => {
    const owner = await seedOwner()
    const id = await seedIntent(owner)
    const hash = `0x${'ab'.repeat(32)}`

    const booked = await bookSubmittedOutcomePending({ userOpHash: hash, intentId: id, agentId: owner.agentId })
    expect(booked).toBe(true)

    const row = await readRow(id)
    expect(row.status).toBe('submitted')
    expect(row.tx_hash).toBeNull()
    expect((row.machine_metadata as Record<string, unknown>).user_op_hash).toBe(hash)
    expect((row.machine_metadata as Record<string, unknown>).submission_outcome).toBe('unknown')
  })

  it('the booking is a CAS: a confirmed or failed row is never touched', async () => {
    const owner = await seedOwner()
    const hash = `0x${'cd'.repeat(32)}`
    const failedId = await seedIntent(owner, { status: 'failed' })
    const confirmedId = await seedIntent(owner, { status: 'confirmed', txHash: `0x${'11'.repeat(32)}` })

    expect(await bookSubmittedOutcomePending({ userOpHash: hash, intentId: failedId, agentId: owner.agentId })).toBe(false)
    expect(await bookSubmittedOutcomePending({ userOpHash: hash, intentId: confirmedId, agentId: owner.agentId })).toBe(false)

    // The rows are byte-identical to their pre-booking state — the failed row
    // in particular must never grow submission metadata (it would re-enter
    // the reconciler's candidate set as a non-'0x'-guarded payload).
    expect(await readRow(failedId)).toMatchObject({ status: 'failed', machine_metadata: null })
    expect(await readRow(confirmedId)).toMatchObject({ status: 'confirmed', machine_metadata: null })
  })

  it('the booked row reads as OUTCOME PENDING on the status surface — check_status_later, never failed', async () => {
    const { getAgentPaymentStatus } = await import('../agent-payment-status.js')
    const owner = await seedOwner()
    const id = await seedIntent(owner)
    await bookSubmittedOutcomePending({ userOpHash: `0x${'ab'.repeat(32)}`, intentId: id, agentId: owner.agentId })

    const status = await getAgentPaymentStatus({ id: owner.agentId, user_id: owner.userId } as never, id)
    expect(status).not.toBeNull()
    expect(status?.status).toBe('submitted')
    expect(status?.phase).toBe('payment_submitted')
    expect(status?.next_action).toBe('check_status_later')
    expect(status?.message).toMatch(/on-chain outcome is not known yet/)
    expect(status?.message).toMatch(/Do not create a new payment/)
    expect(status?.submission_outcome_pending).toBe(true)
  })

  it('MUTATION — a landed-and-succeeded receipt confirms the row with its tx_hash', async () => {
    const owner = await seedOwner()
    const id = await seedIntent(owner)
    await bookSubmittedOutcomePending({ userOpHash: `0x${'ab'.repeat(32)}`, intentId: id, agentId: owner.agentId })
    const txHash = `0x${'ef'.repeat(32)}`

    const confirmed = await reconcileOutcomeConfirmed(id, txHash)
    expect(confirmed).toBe(true)

    const row = await readRow(id)
    expect(row.status).toBe('confirmed')
    expect(row.tx_hash).toBe(txHash)
    expect(row.confirmed_at).not.toBeNull()
  })

  it('the confirm is idempotent and concurrency-safe: the second write and a post-confirm write both lose the CAS', async () => {
    const owner = await seedOwner()
    const id = await seedIntent(owner)
    await bookSubmittedOutcomePending({ userOpHash: `0x${'ab'.repeat(32)}`, intentId: id, agentId: owner.agentId })
    const txHash = `0x${'ef'.repeat(32)}`

    expect(await reconcileOutcomeConfirmed(id, txHash)).toBe(true)
    // A second reconciler (or a replayed tick) finds no open row:
    expect(await reconcileOutcomeConfirmed(id, txHash)).toBe(false)
    // A revert arm racing a confirm cannot un-confirm it:
    expect(await reconcileOutcomeFailed(id, ' was included but reverted')).toBe(false)
    const row = await readRow(id)
    expect(row.status).toBe('confirmed')
    expect(row.tx_hash).toBe(txHash)
  })

  it('a landed-but-reverted receipt fails the row with the cause and the recorded hash', async () => {
    const owner = await seedOwner()
    const id = await seedIntent(owner)
    const hash = `0x${'ab'.repeat(32)}`
    await bookSubmittedOutcomePending({ userOpHash: hash, intentId: id, agentId: owner.agentId })

    expect(await reconcileOutcomeFailed(id, ' was included but reverted')).toBe(true)

    const row = await readRow(id)
    expect(row.status).toBe('failed')
    expect(row.tx_hash).toBeNull()
    expect(String(row.error_message)).toContain(hash)
    expect(String(row.error_message)).toContain('was included but reverted')
    expect((row.machine_metadata as Record<string, unknown>).submission_outcome).toBe('resolved')
  })

  it('a window-elapsed not-found resolves failed with that cause', async () => {
    const owner = await seedOwner()
    const id = await seedIntent(owner)
    await bookSubmittedOutcomePending({ userOpHash: `0x${'ab'.repeat(32)}`, intentId: id, agentId: owner.agentId })

    expect(await reconcileOutcomeFailed(id, ' was never seen on chain after the bounded reconciliation window')).toBe(true)

    const row = await readRow(id)
    expect(row.status).toBe('failed')
    expect(String(row.error_message)).toContain('was never seen on chain after the bounded reconciliation window')
    expect((row.machine_metadata as Record<string, unknown>).submission_outcome).toBe('resolved')
  })

  describe('findOutcomePendingIntents — the candidate scan', () => {
    it('admits an aged outcome-pending row and excludes everything that is not one', async () => {
      const owner = await seedOwner()
      const pendingId = await seedIntent(owner, {
        metadata: { user_op_hash: `0x${'ab'.repeat(32)}`, submission_outcome: 'unknown' },
        signedAtOffset: -120,
      })
      await seedIntent(owner, { signedAtOffset: -120 }) // plain submit, no metadata
      await seedIntent(owner, {
        metadata: { user_op_hash: `0x${'ab'.repeat(32)}`, submission_outcome: 'unknown' },
        signedAtOffset: -10, // younger than any sane min-age
      })
      await seedIntent(owner, {
        metadata: { user_op_hash: `0x${'ab'.repeat(32)}`, submission_outcome: 'resolved' },
        signedAtOffset: -120, // already reconciled
      })
      await seedIntent(owner, {
        metadata: { user_op_hash: 'not-a-hash', submission_outcome: 'unknown' },
        signedAtOffset: -120, // fails the 0x shape guard
      })

      const rows = await findOutcomePendingIntents(60, 100)
      expect(rows.map((r) => r.id)).toEqual([pendingId])
      expect(rows[0].user_op_hash).toBe(`0x${'ab'.repeat(32)}`)
      expect(rows[0].chain_id).toBe(84532)
    })

    it('orders oldest-first and honours the tick limit', async () => {
      const owner = await seedOwner()
      const older = await seedIntent(owner, {
        metadata: { user_op_hash: `0x${'aa'.repeat(32)}`, submission_outcome: 'unknown' },
        signedAtOffset: -600,
      })
      const newer = await seedIntent(owner, {
        metadata: { user_op_hash: `0x${'bb'.repeat(32)}`, submission_outcome: 'unknown' },
        signedAtOffset: -120,
      })
      // Both past the age gate; the limit takes the OLDEST first — the queue
      // a poison row would otherwise sit atop of every tick.
      const rows = await findOutcomePendingIntents(60, 1)
      expect(rows.map((r) => r.id)).toEqual([older])
      expect(await findOutcomePendingIntents(60, 10)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: older }),
          expect.objectContaining({ id: newer }),
        ]),
      )
    })
  })
})
