/**
 * #2970 — status honesty: a `submitted` erc7710 x402 intent past its
 * settlement window with no verified evidence answers `awaiting_settlement_evidence`,
 * not `check_status_later`. `check_status_later` promises a resolution
 * nothing will produce once the window has passed, because nothing besides a
 * reported hash (`observeErc7710Settlement`, #2092) can ever move this row.
 *
 * #3420 — terminal honesty: past the sweep's LAST attribution chance (the
 * verifier's own `notAfterSec`: window + clock-skew, `settlement-observed.ts`)
 * even `awaiting_settlement_evidence` over-promises — the sweep's tick only
 * ever confirms a transaction mined inside the window, so the answer must go
 * terminal (`delivered_unverified` / `stop_and_tell_user`) instead of polling
 * forever. The same read carries `delivered: true` when the merchant's
 * response is recorded server-side (`merchant_leg_reported`), so the status
 * read matches what the settle call already reported.
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
import { CLOCK_SKEW_SECONDS } from '../../x402/settlement-observed.js'
import { type AgentContext } from '../../../middleware/agentAuth.js'

let seq = 0

interface SeedOptions {
  settlementScheme: 'erc7710' | 'eip3009'
  status: 'submitted' | 'confirmed'
  /** Seconds ago the intent was authorized (`created_at`). */
  authorizedSecondsAgo: number
  /** Seed the merchant-response evidence row that `merchant_leg_reported` reads. */
  withMerchantLegReported?: boolean
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

  if (opts.withMerchantLegReported) {
    // The row `merchant_leg_reported` reads: a merchant RESPONSE recorded on
    // this intent (`FIND_INTENT_STATUS_ROW_SQL`'s EXISTS probe). The base row
    // must exist first (`recordMachinePaymentEvidenceBase` is the writer the
    // real attach flow runs first).
    await db.query(
      `INSERT INTO machine_payment_evidence
         (payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id,
          resource_url, merchant_address, payer_address, settlement_address,
          token_symbol, token_address, amount_raw, amount_human)
       SELECT id, $2, $3, 'x402', 'merchant_response_observed', COALESCE(tx_hash, '0x' || repeat('ab', 32)), 84532,
              'https://merchant.example/resource',
              '0x00000000000000000000000000000000000000c1',
              '0x00000000000000000000000000000000000000d1',
              '0x00000000000000000000000000000000000000f1',
              'USDC', '0x036cbd53842c5426634e7929541ec2318f3dcf7e', '100000', '0.10'
       FROM payment_intents WHERE id = $1`,
      [paymentId, agentId, userId],
    )
  }

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
    // #2972: the remedy for an agent that holds the merchant's real hash.
    expect(status?.message).toMatch(/haven_report_settlement_evidence/)
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

  // ── #3420: the terminal cutover + delivered visibility ────────────────────

  it('#3420: INSIDE the attribution horizon (window + skew) the answer stays awaiting_settlement_evidence, with expiry-bounded wording', async () => {
    const { agent, paymentId } = await seedX402Intent({
      settlementScheme: 'erc7710',
      status: 'submitted',
      // Past the settlement window but INSIDE the verifier's last attribution
      // instant: authorize + window + skew is still ahead of now.
      authorizedSecondsAgo: MAX_SETTLEMENT_WINDOW_SECONDS + Math.floor(CLOCK_SKEW_SECONDS / 2),
    })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.next_action).toBe('awaiting_settlement_evidence')
    expect(status?.phase).toBe('payment_submitted')
    // #3420 wording: the horizon is bounded by the payment's own expiry (=
    // authorize + window), never the fixed "about two minutes".
    expect(status?.message).toMatch(/expiry/)
    expect(status?.message).not.toMatch(/about two minutes/)
    expect(status?.message).toMatch(/haven_report_settlement_evidence/)
  })

  it('#3420: a clock PAST the attribution horizon answers the TERMINAL shape — delivered_unverified, stop_and_tell_user, no poll', async () => {
    const { agent, paymentId } = await seedX402Intent({
      settlementScheme: 'erc7710',
      status: 'submitted',
      // An hour past the verifier's last attribution instant. Nothing — a
      // reported hash or a sweep tick — can confirm this settlement now.
      authorizedSecondsAgo: MAX_SETTLEMENT_WINDOW_SECONDS + CLOCK_SKEW_SECONDS + 3600,
    })
    const status = await getAgentPaymentStatus(agent, paymentId)
    // The terminal triple the issue pins: terminal phase, tool-less stop, and
    // a message that says polling is over.
    expect(status?.phase).toBe('delivered_unverified')
    expect(status?.next_action).toBe('stop_and_tell_user')
    expect(status?.message).toMatch(/delivered/i)
    expect(status?.message).toMatch(/cannot change this|Polling cannot/)
    // The one remedy that works at any age keeps its name, and no LIVE sweep
    // possibility remains: the only "sweep" mention explains what has PASSED.
    expect(status?.message).toMatch(/haven_report_settlement_evidence/)
    expect(status?.message).toMatch(/have both passed/)
    expect(status?.message).not.toMatch(/poll haven_get_payment_status/i)
    expect(status?.message).not.toMatch(/may still attribute|can still attribute/)
  })

  it('#3420: the terminal shape carries NO next tool by construction — the vocabulary test pins the pairing', async () => {
    // `stop_and_tell_user` is the only tool-less stop the enum ships; the
    // SDK's own next-step derivation maps it to no tool. This is the AC's
    // "names no further tool", pinned at the vocabulary level so a future
    // edit that pairs a tool with the terminal phase fails here.
    const { AgentPaymentNextAction } = await import('../../../domain/agent-payment-taxonomy.js')
    expect(AgentPaymentNextAction.StopAndTellUser).toBe('stop_and_tell_user')
  })

  it('#3420: delivered: true rides on the status read when the merchant response is recorded, and is ABSENT otherwise', async () => {
    // WITH the merchant-response evidence row: the settle call's
    // `delivered: true` now matches the status read.
    const delivered = await seedX402Intent({
      settlementScheme: 'erc7710',
      status: 'submitted',
      authorizedSecondsAgo: MAX_SETTLEMENT_WINDOW_SECONDS - 30,
      withMerchantLegReported: true,
    })
    const deliveredStatus = await getAgentPaymentStatus(delivered.agent, delivered.paymentId)
    expect(deliveredStatus?.delivered).toBe(true)

    // Without the row the key is OMITTED — an honest unknown, never a
    // claimed false.
    const silent = await seedX402Intent({
      settlementScheme: 'erc7710',
      status: 'submitted',
      authorizedSecondsAgo: MAX_SETTLEMENT_WINDOW_SECONDS - 30,
    })
    const silentStatus = await getAgentPaymentStatus(silent.agent, silent.paymentId)
    expect('delivered' in (silentStatus ?? {})).toBe(false)

    // eip3009 rows get the same additive field from the same probe.
    const eip3009 = await seedX402Intent({
      settlementScheme: 'eip3009',
      status: 'confirmed',
      authorizedSecondsAgo: 60,
      withMerchantLegReported: true,
    })
    const eip3009Status = await getAgentPaymentStatus(eip3009.agent, eip3009.paymentId)
    expect(eip3009Status?.delivered).toBe(true)
  })
})
