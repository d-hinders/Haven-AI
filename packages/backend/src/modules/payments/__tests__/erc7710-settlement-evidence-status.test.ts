/**
 * #2970 — status honesty: a `submitted` erc7710 x402 intent past its
 * settlement window with no verified evidence answers `awaiting_settlement_evidence`,
 * not `check_status_later`. `check_status_later` promises a resolution
 * nothing will produce once the window has passed, because nothing besides a
 * reported hash (`observeErc7710Settlement`, #2092) can ever move this row.
 *
 * Real Postgres, per `docs/contributing/testing-strategy.md`: the claim under
 * test is a property of `FIND_INTENT_STATUS_ROW_SQL` (which this issue adds
 * `created_at` to) and of `isPastSettlementEvidenceWindowErc7710`'s reading of
 * it, not something a mock can stand in for.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { getAgentPaymentStatus } from '../agent-payment-status.js'
import { MAX_SETTLEMENT_WINDOW_SECONDS } from '../../x402/x402-delegation.js'
import { type AgentContext } from '../../../middleware/agentAuth.js'

let seq = 0

interface SeedOptions {
  settlementScheme: 'erc7710' | 'eip3009'
  status: 'submitted' | 'confirmed'
  /** Seconds ago the intent was authorized (`created_at`). */
  authorizedSecondsAgo: number
}

async function seedX402Intent(opts: SeedOptions): Promise<{ agent: AgentContext; paymentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`erc7710-status-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agentRow = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'erc7710 status agent') RETURNING id`,
    [userId],
  )
  const agentId = agentRow.rows[0].id
  const metadata = { settlement_scheme: opts.settlementScheme }
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, created_at, expires_at, source, payment_rail,
        x402_resource_url, x402_merchant_address, machine_metadata)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000c1',
             '100000', '0.10', '0x00000000000000000000000000000000000000d1',
             0, '0xsign', $3, NULL,
             NOW() - ($4 || ' seconds')::interval,
             NOW() + interval '1 hour', 'x402', 'x402',
             'https://merchant.example/resource',
             '0x00000000000000000000000000000000000000c1', $5::jsonb)
     RETURNING id`,
    [agentId, userId, opts.status, String(opts.authorizedSecondsAgo), JSON.stringify(metadata)],
  )
  const paymentId = intent.rows[0].id

  return {
    agent: {
      id: agentId,
      user_id: userId,
      name: 'erc7710 status agent',
      delegate_address: '0x00000000000000000000000000000000000000d1',
      account_address: '0x00000000000000000000000000000000000000f1',
      chain_id: 84532,
      status: 'active',
    } as AgentContext,
    paymentId,
  }
}

describeDb('#2970 — erc7710 settlement-evidence status honesty', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('a submitted erc7710 intent INSIDE its settlement window still answers check_status_later', async () => {
    const { agent, paymentId } = await seedX402Intent({
      settlementScheme: 'erc7710',
      status: 'submitted',
      authorizedSecondsAgo: MAX_SETTLEMENT_WINDOW_SECONDS - 30,
    })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.next_action).toBe('check_status_later')
  })

  it('a submitted erc7710 intent PAST its settlement window answers awaiting_settlement_evidence, with an actionable message', async () => {
    const { agent, paymentId } = await seedX402Intent({
      settlementScheme: 'erc7710',
      status: 'submitted',
      authorizedSecondsAgo: MAX_SETTLEMENT_WINDOW_SECONDS + 30,
    })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.next_action).toBe('awaiting_settlement_evidence')
    // #2970 review: the old copy pointed at a remedy
    // (`haven_report_x402_outcome`) that does not exist for this scheme — it
    // takes no hash and refuses a non-`confirmed` intent. The honest message
    // names the settlement sweep's own residual attribution window instead.
    expect(status?.message).toMatch(/settlement sweep/i)
    expect(status?.message).not.toMatch(/haven_report_x402_outcome/)
    expect(status?.message).not.toMatch(/^Poll/)
  })

  it('a CONFIRMED erc7710 intent is unaffected — the window predicate only fires on submitted', async () => {
    const { agent, paymentId } = await seedX402Intent({
      settlementScheme: 'erc7710',
      status: 'confirmed',
      authorizedSecondsAgo: MAX_SETTLEMENT_WINDOW_SECONDS + 3600,
    })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.next_action).toBe('none')
  })

  it('a submitted EIP-3009 intent past the same window is unaffected — the predicate is erc7710-only', async () => {
    const { agent, paymentId } = await seedX402Intent({
      settlementScheme: 'eip3009',
      status: 'submitted',
      authorizedSecondsAgo: MAX_SETTLEMENT_WINDOW_SECONDS + 3600,
    })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.next_action).toBe('check_status_later')
  })
})
