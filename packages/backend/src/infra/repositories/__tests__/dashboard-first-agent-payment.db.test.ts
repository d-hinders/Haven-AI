/**
 * Real-DB proofs for `FIND_FIRST_AGENT_PAYMENT_SQL` (#4707).
 *
 * The ACs are claims about what POSTGRES returns — which row is earliest, and
 * which rows are excluded — so they belong on the #1220 harness, not on a
 * `vi.mock('db.js')` dispatcher (which would prove only what the caller does
 * with the rows). Zero mocks.
 *
 * The exclusions are the whole point of the statement, so each one has its own
 * probe and each probe is a row that WOULD qualify if its exclusion were
 * removed:
 *
 *   pending / failed / no tx_hash   — nothing moved
 *   funded-but-unsettled            — an open merchant_retry_rejected_after_payment
 *   awaiting merchant leg (eip3009) — confirmed, no settlement hash, no answer
 *   retired rail                    — a legacy Safe account's agent
 *   another user                    — tenant scope
 *
 * The EXPLAIN proof at the bottom is the PR artifact the issue asks for: no
 * migration, and the plan must stay a single scan of `payment_intents` bounded
 * by `LIMIT 1`. Set EXPLAIN_OUT=<path> to also write the plan to disk.
 */
import fs from 'node:fs'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { FIND_FIRST_AGENT_PAYMENT_SQL, findFirstAgentPayment } from '../dashboard.js'

const USDC_84532 = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
let seq = 0

interface Seed {
  userId: string
  accountId: string
  agentId: string
}

async function seedUser(): Promise<string> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`first-payment-4707-${n}-${Date.now()}@test.example`],
  )
  return user.rows[0].id
}

async function seedAccountAndAgent(
  userId: string,
  options: { accountType?: string; agentName?: string } = {},
): Promise<Seed> {
  const n = ++seq
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, 84532, 'delegation', $3) RETURNING id`,
    [userId, `0x${String(n).padStart(40, 'a')}`, options.accountType ?? 'delegator_hybrid'],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, delegate_address, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [
      userId,
      account.rows[0].id,
      options.agentName ?? `4707 agent ${n}`,
      `0x${String(n).padStart(40, 'b')}`,
    ],
  )
  return { userId, accountId: account.rows[0].id, agentId: agent.rows[0].id }
}

interface IntentOptions {
  status?: string
  /** `null` writes no tx_hash — a row that never moved. */
  txHash?: string | null
  /** Minutes before now; the ordering probe uses distinct values. */
  minutesAgo?: number
  rail?: string
  source?: string
  scheme?: string | null
  settlementTxHash?: string | null
  merchantAddress?: string | null
  x402ResourceUrl?: string | null
  usd?: string | null
  amountHuman?: string
}

/** A payment intent with only the columns this statement reads. */
async function intent(seed: Seed, options: IntentOptions = {}): Promise<string> {
  const n = ++seq
  const metadata: Record<string, unknown> = {}
  if (options.scheme !== null) metadata.settlement_scheme = options.scheme ?? 'erc7710'
  if (options.settlementTxHash) metadata.merchant_settlement_tx_hash = options.settlementTxHash
  const minutesAgo = options.minutesAgo ?? 0
  const row = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, status, tx_hash, confirmed_at, expires_at,
       chain_id, source, payment_rail, execution_rail, machine_metadata,
       usd_value, merchant_address, x402_resource_url
     ) VALUES (
       $1, $2, $3, 'USDC', $4,
       '0x00000000000000000000000000000000000000aa', '50000', $5,
       '0x00000000000000000000000000000000000000d1', 1, $6,
       $7, $8, NOW() - ($9 || ' minutes')::interval, NOW() + INTERVAL '10 minutes',
       84532, $10, $11, 'delegation', $12::jsonb,
       $13, $14, $15
     ) RETURNING id`,
    [
      seed.agentId,
      seed.userId,
      `0x${String(1e12 + n).padStart(40, '0').slice(-40)}`,
      USDC_84532,
      options.amountHuman ?? '0.05',
      `0x${String(n).padStart(64, 'a')}`,
      options.status ?? 'confirmed',
      options.txHash === null ? null : (options.txHash ?? `0x${String(n).padStart(64, 'c')}`),
      String(minutesAgo),
      options.source ?? 'x402',
      options.rail ?? 'x402',
      JSON.stringify(metadata),
      options.usd ?? '0.05',
      options.merchantAddress ?? null,
      options.x402ResourceUrl ?? null,
    ],
  )
  return row.rows[0].id
}

/** An open `merchant_retry_rejected_after_payment` event — `funded_but_unsettled`. */
async function markFundedButUnsettled(seed: Seed, intentId: string): Promise<void> {
  await db.query(
    `INSERT INTO machine_payment_reconciliation_events (
       agent_id, user_id, payment_intent_id, rail, event_type, status
     ) VALUES ($1, $2, $3, 'x402', 'merchant_retry_rejected_after_payment', 'open')`,
    [seed.agentId, seed.userId, intentId],
  )
}

/** A recorded merchant answer — `merchant_leg_reported`. */
async function recordMerchantAnswer(seed: Seed, intentId: string, proofStatus: string): Promise<void> {
  const n = ++seq
  await db.query(
    `INSERT INTO machine_payment_evidence (
       payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id,
       resource_url, payer_address, settlement_address, token_symbol, token_address,
       amount_raw, amount_human
     ) VALUES (
       $1, $2, $3, 'x402', $4, $5, 84532,
       'https://research.example/paper', '0x00000000000000000000000000000000000000d1',
       '0x00000000000000000000000000000000000000d1', 'USDC', $6,
       '50000', '0.05'
     )`,
    [
      intentId,
      seed.agentId,
      seed.userId,
      proofStatus,
      `0x${String(n).padStart(64, 'd')}`,
      USDC_84532,
    ],
  )
}

describeDb('#4707 first agent payment', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('returns null when the user has no payment at all', async () => {
    const userId = await seedUser()
    await seedAccountAndAgent(userId)
    expect(await findFirstAgentPayment(userId)).toBeNull()
  })

  it('returns the EARLIEST qualifying row by confirmed_at, not the newest', async () => {
    const seed = await seedAccountAndAgent(await seedUser())
    await intent(seed, { minutesAgo: 30, amountHuman: '0.30' })
    await intent(seed, { minutesAgo: 90, amountHuman: '0.90' })
    await intent(seed, { minutesAgo: 5, amountHuman: '0.05' })

    const row = await findFirstAgentPayment(seed.userId)
    expect(row?.amount_human).toBe('0.90')
  })

  it('excludes pending, failed and tx_hash-less rows', async () => {
    const seed = await seedAccountAndAgent(await seedUser())
    await intent(seed, { status: 'pending_signature', minutesAgo: 120 })
    await intent(seed, { status: 'submitted', minutesAgo: 110 })
    await intent(seed, { status: 'failed', minutesAgo: 100 })
    await intent(seed, { status: 'expired', minutesAgo: 90 })
    await intent(seed, { txHash: null, minutesAgo: 80 })
    expect(await findFirstAgentPayment(seed.userId)).toBeNull()

    // Positive control: the same fixture plus one real payment.
    await intent(seed, { minutesAgo: 70, amountHuman: '0.07' })
    expect((await findFirstAgentPayment(seed.userId))?.amount_human).toBe('0.07')
  })

  it('excludes a funded-but-unsettled row (open merchant_retry_rejected_after_payment)', async () => {
    const seed = await seedAccountAndAgent(await seedUser())
    const rejected = await intent(seed, { minutesAgo: 60, amountHuman: '0.60' })
    await markFundedButUnsettled(seed, rejected)
    expect(await findFirstAgentPayment(seed.userId)).toBeNull()

    // A CLOSED event is not the exclusion — the merchant was asked and the
    // reconciliation is resolved, so the row is no longer "unsettled".
    await db.query(
      `UPDATE machine_payment_reconciliation_events SET status = 'resolved'
        WHERE payment_intent_id = $1`,
      [rejected],
    )
    expect((await findFirstAgentPayment(seed.userId))?.amount_human).toBe('0.60')
  })

  it('excludes an EIP-3009 row whose merchant leg is not proven', async () => {
    const seed = await seedAccountAndAgent(await seedUser())
    await intent(seed, { scheme: 'eip3009', minutesAgo: 60, amountHuman: '0.60' })
    expect(await findFirstAgentPayment(seed.userId)).toBeNull()
  })

  it('includes an EIP-3009 row once a settlement hash is recorded', async () => {
    const seed = await seedAccountAndAgent(await seedUser())
    await intent(seed, {
      scheme: 'eip3009',
      settlementTxHash: `0x${'e'.repeat(64)}`,
      minutesAgo: 60,
      amountHuman: '0.60',
    })
    expect((await findFirstAgentPayment(seed.userId))?.amount_human).toBe('0.60')
  })

  it('includes an EIP-3009 row once the merchant answer is recorded', async () => {
    const seed = await seedAccountAndAgent(await seedUser())
    const id = await intent(seed, { scheme: 'eip3009', minutesAgo: 60, amountHuman: '0.60' })
    await recordMerchantAnswer(seed, id, 'merchant_response_observed')
    expect((await findFirstAgentPayment(seed.userId))?.amount_human).toBe('0.60')
  })

  it('does not treat the funding-confirm base evidence row as a merchant answer', async () => {
    // `payment_confirmed` is the row the backend writes at funding-confirm —
    // it says the funding leg landed, not that the merchant answered.
    const seed = await seedAccountAndAgent(await seedUser())
    const id = await intent(seed, { scheme: 'eip3009', minutesAgo: 60 })
    await recordMerchantAnswer(seed, id, 'payment_confirmed')
    expect(await findFirstAgentPayment(seed.userId)).toBeNull()
  })

  it('includes a non-EIP-3009 x402 row on confirmation alone', async () => {
    const seed = await seedAccountAndAgent(await seedUser())
    await intent(seed, { scheme: 'erc7710', minutesAgo: 60, amountHuman: '0.60' })
    expect((await findFirstAgentPayment(seed.userId))?.amount_human).toBe('0.60')
  })

  it('includes a direct-rail row, which has no merchant leg at all', async () => {
    const seed = await seedAccountAndAgent(await seedUser())
    await intent(seed, {
      rail: 'direct',
      source: 'direct',
      scheme: null,
      minutesAgo: 60,
      amountHuman: '0.60',
    })
    expect((await findFirstAgentPayment(seed.userId))?.amount_human).toBe('0.60')
  })

  it('never names a retired-rail agent', async () => {
    const userId = await seedUser()
    const legacy = await seedAccountAndAgent(userId, { accountType: 'legacy_safe' })
    await intent(legacy, { minutesAgo: 60, amountHuman: '0.60' })
    expect(await findFirstAgentPayment(userId)).toBeNull()

    // Positive control: a delegation-rail agent on the same user qualifies.
    const delegation = await seedAccountAndAgent(userId)
    await intent(delegation, { minutesAgo: 30, amountHuman: '0.30' })
    expect((await findFirstAgentPayment(userId))?.amount_human).toBe('0.30')
  })

  it('is tenant-scoped — another user\'s payment is never returned', async () => {
    const mine = await seedAccountAndAgent(await seedUser())
    const theirs = await seedAccountAndAgent(await seedUser())
    await intent(theirs, { minutesAgo: 60, amountHuman: '0.60' })
    expect(await findFirstAgentPayment(mine.userId)).toBeNull()
    expect((await findFirstAgentPayment(theirs.userId))?.amount_human).toBe('0.60')
  })

  it('returns the counterparty identity and the booked fiat the card reads', async () => {
    const seed = await seedAccountAndAgent(await seedUser(), { agentName: 'Research agent' })
    await intent(seed, {
      minutesAgo: 10,
      amountHuman: '0.05',
      usd: '0.05',
      merchantAddress: '0x00000000000000000000000000000000000000cc',
      x402ResourceUrl: 'https://research.example/paper',
    })

    const row = await findFirstAgentPayment(seed.userId)
    expect(row).not.toBeNull()
    expect(row?.agent_name).toBe('Research agent')
    expect(row?.token_symbol).toBe('USDC')
    expect(row?.amount_human).toBe('0.05')
    expect(row?.usd_value).toBe('0.050000')
    expect(row?.merchant_address).toBe('0x00000000000000000000000000000000000000cc')
    expect(row?.x402_resource_url).toBe('https://research.example/paper')
    expect(row?.confirmed_at).toBeInstanceOf(Date)
  })

  it('falls back to the recipient address when no merchant address is recorded', async () => {
    const seed = await seedAccountAndAgent(await seedUser())
    await intent(seed, { minutesAgo: 10, merchantAddress: null })
    const row = await findFirstAgentPayment(seed.userId)
    expect(row?.merchant_address).toBe('0x00000000000000000000000000000000000000aa')
  })
})

describeDb('#4707 EXPLAIN artifact (no migration)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('plans as a single payment_intents scan bounded by LIMIT 1', async () => {
    const userId = await seedUser()
    const agents = []
    for (let i = 0; i < 5; i++) agents.push(await seedAccountAndAgent(userId))
    for (const agent of agents) {
      for (let i = 0; i < 200; i++) {
        await intent(agent, { minutesAgo: i })
      }
    }

    const result = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF) ${FIND_FIRST_AGENT_PAYMENT_SQL}`,
      [userId],
    )
    const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n')
    // Any scan kind (Seq/Index/Bitmap) — the point is the COUNT: the statement
    // is one pass over payment_intents, never a per-agent loop.
    const scans = (plan.match(/Scan on payment_intents/g) ?? []).length
    expect(scans).toBeLessThanOrEqual(1)
    expect(plan).toContain('Limit')

    const artifact = process.env.EXPLAIN_OUT
    if (artifact) fs.writeFileSync(artifact, plan + '\n')
  })
})
