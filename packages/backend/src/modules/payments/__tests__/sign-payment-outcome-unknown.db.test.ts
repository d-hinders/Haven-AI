/**
 * #4817 — through the REAL `signPayment`, a lost send answer books the payment
 * outcome-PENDING instead of `failed`.
 *
 * This is the end-to-end criterion the issue states: the real sign module, the
 * real delegation rail, the real booking writes, and a real Postgres row. The
 * only stand-ins are the two network seams (a loopback chain RPC and a
 * loopback bundler that accepts `eth_sendUserOperation` and never answers).
 *
 * Before the change the same run answered `502 onchain_execution_failed`, left
 * the row `failed` with no hash, and `findOutcomePendingIntents` returned 0
 * rows — the funds-moved-but-recorded-failed shape the issue exists to stop.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { findOutcomePendingIntents } from '../../../infra/repositories/payment-intents.js'
import { serializeUserOp } from '../../../rails/execution-rail.js'
import {
  bundlerWith,
  chainAnswer,
  startStandIn,
  type StandIn,
} from '../../../rails/__tests__/helpers/bundler-stand-in.js'

const CHAIN_ID = 84532
const DELEGATE_ADDRESS = `0x${'11'.repeat(20)}`
const ACCOUNT_ADDRESS = `0x${'aa'.repeat(20)}`
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const RECIPIENT = `0x${'44'.repeat(20)}`
const SIGNATURE = `0x${'ab'.repeat(97)}`

const { rpcUrlRef } = vi.hoisted(() => ({ rpcUrlRef: { current: '' } }))

// The chain RPC is the one seam mocked: the rail's public client is built from
// `rpcTransport`, and a real node is not part of this test.
vi.mock('../../../infra/chain/rpc-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/chain/rpc-transport.js')>()
  const { http } = await import('viem')
  return { ...actual, rpcTransport: () => http(rpcUrlRef.current) }
})

const { signPayment } = await import('../sign-payment.js')

let seq = 0

async function seedOwner(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`sign-outcome-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'sign outcome agent') RETURNING id`,
    [userId],
  )
  return { agentId: agent.rows[0].id, userId }
}

/** A delegation-rail intent waiting for its signature, with a prepared UserOp. */
async function seedPendingIntent(owner: { agentId: string; userId: string }): Promise<string> {
  const preparedUserOp = serializeUserOp({
    sender: ACCOUNT_ADDRESS,
    nonce: 7n,
    callData: '0xdeadbeef',
    callGasLimit: 100_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 1_000_000n,
    maxPriorityFeePerGas: 1_000n,
    paymaster: `0x${'22'.repeat(20)}`,
    paymasterVerificationGasLimit: 30_000n,
    paymasterPostOpGasLimit: 10_000n,
    paymasterData: '0x',
    signature: '0x',
  })
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, chain_id, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, execution_rail, delegation_hash, prepared_user_op,
       payment_rail, status, expires_at
     ) VALUES (
       $1, $2, $3, $4, 'USDC', $5,
       $6, '100000', '0.10', $7,
       0, $8, 'delegation', $9, $10,
       'direct', 'pending_signature', NOW() + interval '1 hour'
     )
     RETURNING id`,
    [
      owner.agentId,
      owner.userId,
      ACCOUNT_ADDRESS,
      CHAIN_ID,
      USDC,
      RECIPIENT,
      DELEGATE_ADDRESS,
      `0x${String(++seq).padStart(64, 'b')}`.slice(0, 66),
      `0x${String(seq).padStart(64, 'e')}`.slice(0, 66),
      preparedUserOp,
    ],
  )
  return result.rows[0].id
}

async function readRow(id: string): Promise<Record<string, unknown>> {
  const result = await db.query(
    `SELECT status, tx_hash, error_message, machine_metadata FROM payment_intents WHERE id = $1`,
    [id],
  )
  return result.rows[0] as unknown as Record<string, unknown>
}

describeDb('#4817 — a lost send answer through the real signPayment', () => {
  let chain: StandIn

  beforeAll(async () => {
    await initDbHarness()
    chain = await startStandIn(chainAnswer)
    rpcUrlRef.current = chain.url
  })

  afterAll(async () => {
    await chain.close()
  })

  beforeEach(resetDb)

  it('answers 502 submission_outcome_unknown with a user_op_hash, leaves the row submitted, and the reconciler finds it', async () => {
    const bundler = await startStandIn(bundlerWith({ eth_sendUserOperation: () => ({ hang: true }) }))
    process.env.DELEGATION_RAIL_BUNDLER_URL_84532 = bundler.url
    try {
      const owner = await seedOwner()
      const paymentId = await seedPendingIntent(owner)
      const agent = {
        id: owner.agentId,
        user_id: owner.userId,
        name: 'sign outcome agent',
        delegate_address: DELEGATE_ADDRESS,
        account_address: ACCOUNT_ADDRESS,
        chain_id: CHAIN_ID,
        status: 'active',
        account_type: 'delegator_hybrid',
        execution_rail: 'delegation',
      }

      const decided = await signPayment({
        agent,
        paymentId,
        signature: SIGNATURE,
        log: { warn: () => {} },
        mppDemoRetired: () => ({ statusCode: 410, body: { error: 'retired' } }),
        recordMachinePaymentEvidence: async () => undefined,
      })

      expect(decided.code).toBe(502)
      const body = decided.body as Record<string, unknown>
      expect(body.error_code).toBe('submission_outcome_unknown')
      expect(body.status).toBe('submitted')
      expect(body.user_op_hash).toMatch(/^0x[0-9a-f]{64}$/)

      const row = await readRow(paymentId)
      expect(row.status).toBe('submitted')
      expect(row.tx_hash).toBeNull()
      const metadata = row.machine_metadata as Record<string, unknown>
      expect(metadata.submission_outcome).toBe('unknown')
      expect(metadata.user_op_hash).toBe(body.user_op_hash)

      // The reconciler's candidate query sees it once it is past the minimum
      // age (the claim stamps `signed_at = NOW()`, so 0 seconds is enough).
      const candidates = await findOutcomePendingIntents(0, 10)
      expect(candidates.map((candidate) => candidate.id)).toContain(paymentId)
    } finally {
      delete process.env.DELEGATION_RAIL_BUNDLER_URL_84532
      await bundler.close()
    }
  }, 60_000)
})
