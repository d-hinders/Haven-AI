/**
 * The erc7710 settlement-completion seam, end to end over the real evidence
 * pipeline (#2092).
 *
 * Real Postgres (the #1220 harness), because everything asserted here is
 * database behaviour: the intent transition, the `machine_payment_evidence`
 * row, its book-time FX capture, and the fee-ledger row. The CHAIN is a
 * collaborator this test does not own, so it is mocked — per
 * `docs/contributing/testing-strategy.md`'s layer map.
 *
 * The point of the negative cases: a reported settlement hash is CLIENT INPUT
 * that ends in the user's bookkeeping. Each one proves that a specific way of
 * lying about it leaves the intent exactly where it was, with no evidence row,
 * no fee row and no Fortnox feed call.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const feedSettledPaymentBestEffort = vi.fn()
const getTransactionReceipt = vi.fn()

vi.mock('../../reporting/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../reporting/index.js')>()),
  feedSettledPaymentBestEffort: (...args: unknown[]) => feedSettledPaymentBestEffort(...args),
}))

vi.mock('../../../rails/allowance-module.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../rails/allowance-module.js')>()),
  getProvider: () => ({ getTransactionReceipt }),
}))

vi.mock('../../../infra/prices.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/prices.js')>()),
  getTokenPrice: async () => ({ usd: 1, eur: 0.9, sek: 10 }),
}))

// Static imports are safe below the mocks: vitest hoists `vi.mock` above them.
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { attachMachinePaymentEvidence } from '../evidence.js'

const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const OTHER = '0x00000000000000000000000000000000000000ee'
const AMOUNT_RAW = '100000'
const RESOURCE = 'https://merchant.example/paid'
const HASH_A = `0x${'a'.repeat(64)}`
const HASH_B = `0x${'b'.repeat(64)}`

const TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

function transferLog(
  opts: { token?: string; from?: string; to?: string; value?: string } = {},
) {
  const encoded = TRANSFER_IFACE.encodeEventLog('Transfer', [
    opts.from ?? PAYER,
    opts.to ?? MERCHANT,
    BigInt(opts.value ?? AMOUNT_RAW),
  ])
  return { address: opts.token ?? TOKEN, topics: encoded.topics, data: encoded.data }
}

/** A successful receipt carrying exactly the settlement transfer we expect. */
function goodReceipt(overrides: Parameters<typeof transferLog>[0] = {}) {
  return { status: 1, logs: [transferLog(overrides)] }
}

let seq = 0

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`e7710-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'erc7710 agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

async function seedIntent(seed: {
  agentId: string
  userId: string
  scheme?: string
  executionRail?: string | null
}): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, safe_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, source, payment_rail, execution_rail, machine_metadata,
        x402_resource_url, payment_resource_url, merchant_address, x402_merchant_address)
     VALUES ($1, $2, $3, 84532, 'USDC', $4, $5, $6, '0.10',
             '0x00000000000000000000000000000000000000d1', 0, $7,
             'submitted', NOW() + interval '10 minutes', 'x402', 'x402', $8, $9::jsonb,
             $10, $10, $5, $5)
     RETURNING id`,
    [
      seed.agentId,
      seed.userId,
      PAYER,
      TOKEN,
      MERCHANT,
      AMOUNT_RAW,
      `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
      seed.executionRail === undefined ? 'delegation' : seed.executionRail,
      JSON.stringify({ settlement_scheme: seed.scheme ?? 'erc7710' }),
      RESOURCE,
    ],
  )
  return result.rows[0].id
}

const attach = (agentId: string, paymentId: string, txHash = HASH_A) =>
  attachMachinePaymentEvidence({
    agentId,
    paymentId,
    rail: 'x402',
    txHash,
    resourceUrl: RESOURCE,
    merchantStatus: 200,
    protocolReceiptHeaderName: 'PAYMENT-RESPONSE',
    protocolReceiptHeader: 'eyJ0cmFuc2FjdGlvbiI6IjB4YWEifQ==',
  })

async function readIntent(id: string) {
  return (await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])).rows[0]
}
async function readEvidence(id: string) {
  return (
    await db.query(`SELECT * FROM machine_payment_evidence WHERE payment_intent_id = $1`, [id])
  ).rows
}
async function readFees(id: string) {
  return (await db.query(`SELECT * FROM payment_fees WHERE payment_id = $1`, [id])).rows
}

describeDb('erc7710 settlement completion → evidence pipeline (#2092)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
    feedSettledPaymentBestEffort.mockReset()
    getTransactionReceipt.mockReset()
  })

  // ── The seam ────────────────────────────────────────────────────────────

  describe('a verified settlement', () => {
    it('confirms the intent, writes evidence with book-time FX, records the fee row, and fires the Fortnox feed', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const intentId = await seedIntent({ agentId, userId })

      const evidence = await attach(agentId, intentId)

      const intent = await readIntent(intentId)
      expect(intent.status).toBe('confirmed')
      expect(intent.tx_hash).toBe(HASH_A)
      expect(intent.confirmed_at).not.toBeNull()

      expect(evidence).not.toBeNull()
      const rows = await readEvidence(intentId)
      expect(rows).toHaveLength(1)
      expect(rows[0].tx_hash).toBe(HASH_A)
      expect(rows[0].rail).toBe('x402')
      expect(rows[0].proof_status).toBe('protocol_receipt_attached')
      // Book-time FX captured at settlement — the value the Fortnox feed uses.
      expect(Number(rows[0].amount_sek)).toBeCloseTo(1.0)
      expect(Number(rows[0].fx_rate_sek)).toBeCloseTo(10)
      expect(rows[0].fx_source).toBe('coingecko_spot')
      // The evidence row carries the intent's confirmed_at, not a fresh clock.
      expect(new Date(rows[0].confirmed_at).getTime()).toBe(
        new Date(intent.confirmed_at).getTime(),
      )

      expect(await readFees(intentId)).toHaveLength(1)
      expect(feedSettledPaymentBestEffort).toHaveBeenCalledWith(userId, intentId)
    })
  })

  // ── Fail closed ─────────────────────────────────────────────────────────

  describe('an unverifiable settlement never confirms', () => {
    async function expectRefused(marker: string, intentId: string, agentId: string, hash = HASH_A) {
      await expect(attach(agentId, intentId, hash)).rejects.toThrow(marker)
      const intent = await readIntent(intentId)
      expect(intent.status).toBe('submitted')
      expect(intent.tx_hash).toBeNull()
      expect(await readEvidence(intentId)).toHaveLength(0)
      expect(await readFees(intentId)).toHaveLength(0)
      expect(feedSettledPaymentBestEffort).not.toHaveBeenCalled()
    }

    it('a bogus hash that is not on chain at all leaves the intent submitted', async () => {
      getTransactionReceipt.mockResolvedValue(null)
      const { agentId, userId } = await seedAgent()
      const intentId = await seedIntent({ agentId, userId })
      await expectRefused('settlement_unobservable', intentId, agentId)
    })

    it('an RPC outage is NOT a confirmation — and is reported as retryable', async () => {
      getTransactionReceipt.mockRejectedValue(new Error('ECONNREFUSED'))
      const { agentId, userId } = await seedAgent()
      const intentId = await seedIntent({ agentId, userId })
      await expectRefused('settlement_unobservable', intentId, agentId)
    })

    it('a reverted transaction does not confirm', async () => {
      getTransactionReceipt.mockResolvedValue({ status: 0, logs: [transferLog()] })
      const { agentId, userId } = await seedAgent()
      const intentId = await seedIntent({ agentId, userId })
      await expectRefused('settlement_unverified', intentId, agentId)
    })

    it('a successful transaction with NO transfer log does not confirm', async () => {
      getTransactionReceipt.mockResolvedValue({ status: 1, logs: [] })
      const { agentId, userId } = await seedAgent()
      const intentId = await seedIntent({ agentId, userId })
      await expectRefused('settlement_unverified', intentId, agentId)
    })

    it('a transfer to a DIFFERENT recipient does not confirm', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt({ to: OTHER }))
      const { agentId, userId } = await seedAgent()
      const intentId = await seedIntent({ agentId, userId })
      await expectRefused('settlement_unverified', intentId, agentId)
    })

    it('a transfer from a DIFFERENT account does not confirm', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt({ from: OTHER }))
      const { agentId, userId } = await seedAgent()
      const intentId = await seedIntent({ agentId, userId })
      await expectRefused('settlement_unverified', intentId, agentId)
    })

    it('a transfer of a DIFFERENT amount does not confirm', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt({ value: '99999' }))
      const { agentId, userId } = await seedAgent()
      const intentId = await seedIntent({ agentId, userId })
      await expectRefused('settlement_unverified', intentId, agentId)
    })

    it('a transfer emitted by a DIFFERENT token contract does not confirm', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt({ token: OTHER }))
      const { agentId, userId } = await seedAgent()
      const intentId = await seedIntent({ agentId, userId })
      await expectRefused('settlement_unverified', intentId, agentId)
    })
  })

  // ── Replay ──────────────────────────────────────────────────────────────

  it('a settlement hash that already confirmed one intent cannot confirm a second', async () => {
    getTransactionReceipt.mockResolvedValue(goodReceipt())
    const { agentId, userId } = await seedAgent()
    const first = await seedIntent({ agentId, userId })
    const second = await seedIntent({ agentId, userId })

    await attach(agentId, first, HASH_A)
    await expect(attach(agentId, second, HASH_A)).rejects.toThrow('settlement_unverified')

    const secondRow = await readIntent(second)
    expect(secondRow.status).toBe('submitted')
    expect(secondRow.tx_hash).toBeNull()
    expect(await readEvidence(second)).toHaveLength(0)
  })

  // ── Other schemes are untouched ─────────────────────────────────────────

  it('an eip3009 intent still refuses with payment_not_confirmed, and the chain is never consulted', async () => {
    getTransactionReceipt.mockResolvedValue(goodReceipt())
    const { agentId, userId } = await seedAgent()
    const intentId = await seedIntent({ agentId, userId, scheme: 'eip3009' })

    await expect(attach(agentId, intentId, HASH_B)).rejects.toThrow('payment_not_confirmed')
    expect(getTransactionReceipt).not.toHaveBeenCalled()
    expect((await readIntent(intentId)).status).toBe('submitted')
  })

  it('a legacy-rail intent still refuses with payment_not_confirmed, and the chain is never consulted', async () => {
    getTransactionReceipt.mockResolvedValue(goodReceipt())
    const { agentId, userId } = await seedAgent()
    const intentId = await seedIntent({ agentId, userId, executionRail: null, scheme: 'eip3009' })

    await expect(attach(agentId, intentId, HASH_B)).rejects.toThrow('payment_not_confirmed')
    expect(getTransactionReceipt).not.toHaveBeenCalled()
  })
})
