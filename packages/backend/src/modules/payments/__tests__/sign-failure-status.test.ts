/**
 * #3494 — two status-surface gaps on a DIRECT (non-x402/mpp) payment_intents
 * row, proven on the real-DB harness (the claim is what a seeded row reads
 * back as, which `docs/contributing/testing-strategy.md` puts on real
 * Postgres):
 *
 * 1. `failure_reason` — a `failed` row's `error_message` was never selected
 *    by `FIND_INTENT_STATUS_ROW_SQL` (`payment-intents.ts`), so
 *    `/machine-payments/:id/status` carried no cause at all. Now selected,
 *    and bounded+redacted into `failure_reason` at the read (`boundFailureMessage`).
 * 2. `send_idempotency_key` — a direct row's own idempotency key was never
 *    surfaced on status (`railContext` returned `{}` for the direct rail);
 *    `statusFromRow` now passes it through and `railContext` answers it.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { getAgentPaymentStatus, FAILURE_MESSAGE_MAX_LENGTH } from '../agent-payment-status.js'
import { type AgentContext } from '../../../middleware/agentAuth.js'

let seq = 0

async function seed(overrides: {
  status?: string
  errorMessage?: string | null
  sendIdempotencyKey?: string | null
}): Promise<{ agent: AgentContext; paymentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`sign-failure-status-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agentRow = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'sign failure status agent') RETURNING id`,
    [userId],
  )
  const agentId = agentRow.rows[0].id
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, error_message, send_idempotency_key)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000c1',
             '100000', '0.10', '0x00000000000000000000000000000000000000d1',
             0, '0xsign', $3, NOW() + interval '10 minutes', $4, $5)
     RETURNING id`,
    [agentId, userId, overrides.status ?? 'pending_signature', overrides.errorMessage ?? null, overrides.sendIdempotencyKey ?? null],
  )
  return {
    agent: {
      id: agentId,
      user_id: userId,
      name: 'sign failure status agent',
      delegate_address: '0x00000000000000000000000000000000000000d1',
      account_address: '0x00000000000000000000000000000000000000f1',
      chain_id: 8453,
      status: 'active',
    },
    paymentId: intent.rows[0].id,
  }
}

describeDb('#3494 — direct-rail failure_reason and send_idempotency_key on status', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('a failed row surfaces its (bounded) error_message as failure_reason', async () => {
    const longMessage = 'reverted with callData 0x' + 'ab'.repeat(500)
    expect(longMessage.length).toBeGreaterThan(FAILURE_MESSAGE_MAX_LENGTH)
    const { agent, paymentId } = await seed({ status: 'failed', errorMessage: longMessage })

    const result = await getAgentPaymentStatus(agent, paymentId)

    expect(result?.status).toBe('failed')
    expect(result?.failure_reason).not.toBeNull()
    expect(result!.failure_reason!.length).toBeLessThanOrEqual(FAILURE_MESSAGE_MAX_LENGTH + 1)
    expect(longMessage.startsWith(result!.failure_reason!.slice(0, -1))).toBe(true)
  })

  it('a failed row with no stored error_message surfaces failure_reason: null, not omitted', async () => {
    const { agent, paymentId } = await seed({ status: 'failed', errorMessage: null })

    const result = await getAgentPaymentStatus(agent, paymentId)

    expect(result?.status).toBe('failed')
    expect('failure_reason' in (result as object)).toBe(true)
    expect(result?.failure_reason).toBeNull()
  })

  for (const status of ['pending_signature', 'submitted', 'confirmed', 'expired']) {
    it(`a ${status} row never carries failure_reason, even if error_message is somehow set`, async () => {
      const { agent, paymentId } = await seed({ status, errorMessage: 'leftover text' })

      const result = await getAgentPaymentStatus(agent, paymentId)

      expect('failure_reason' in (result as object)).toBe(false)
    })
  }

  it('a direct row surfaces its own send_idempotency_key on status', async () => {
    const { agent, paymentId } = await seed({ sendIdempotencyKey: 'agent-chosen-key-1' })

    const result = await getAgentPaymentStatus(agent, paymentId)

    expect(result?.rail).toBe('direct')
    expect(result?.idempotency_key).toBe('agent-chosen-key-1')
  })

  it('a direct row with no send_idempotency_key surfaces idempotency_key: null, not a stale value', async () => {
    const { agent, paymentId } = await seed({ sendIdempotencyKey: null })

    const result = await getAgentPaymentStatus(agent, paymentId)

    expect(result?.rail).toBe('direct')
    expect(result?.idempotency_key ?? null).toBeNull()
  })
})
