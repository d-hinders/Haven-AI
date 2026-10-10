/**
 * The eip3009 merchant-settlement report (#3475), end to end over the real
 * evidence pipeline.
 *
 * Real Postgres (the #1220 harness), because what is asserted is database
 * behaviour: which intent carries the verified hash, that the funding hash and
 * the evidence row's proof status never move, the per-hash uniqueness, and that
 * an unreported payment blocks no later one. The CHAIN is a collaborator this test does not own, so it
 * is mocked, per `docs/contributing/testing-strategy.md`.
 *
 * Each negative case is a way of lying about a settlement hash, and each one
 * proves the payment is left exactly as it was.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const getTransactionReceipt = vi.fn()
const getBlock = vi.fn()

vi.mock('../../../infra/chain/relayer-reads.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/chain/relayer-reads.js')>()),
  getProvider: () => ({ getTransactionReceipt, getBlock }),
  // The residue check reads the delegate balance; nothing is stranded here.
  getTokenBalance: async () => 0n,
}))

vi.mock('../../../infra/prices.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/prices.js')>()),
  getTokenPrice: async () => ({ usd: 1, eur: 0.9, sek: 10 }),
}))

vi.mock('../../accounting/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../accounting/index.js')>()),
  feedSettledPaymentBestEffort: vi.fn(),
}))

// Static imports are safe below the mocks: vitest hoists `vi.mock` above them.
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { attachEvidenceHandler, attachMachinePaymentEvidence, listReceipts } from '../evidence.js'
import { RECORD_EIP3009_MERCHANT_SETTLEMENT_SQL } from '../../../infra/repositories/x402-authorizations.js'
import { feedSettledPaymentBestEffort } from '../../accounting/index.js'

const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const TREASURY = '0x00000000000000000000000000000000000000b1'
const DELEGATE = '0x00000000000000000000000000000000000000d1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const OTHER = '0x00000000000000000000000000000000000000ee'
const AMOUNT_RAW = '1000'
const RESOURCE = 'http://merchant.example/api/joke'
const SETTLE_A = `0x${'a'.repeat(64)}`
const SETTLE_B = `0x${'b'.repeat(64)}`

const TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

function transferLog(opts: { token?: string; from?: string; to?: string; value?: string } = {}) {
  const encoded = TRANSFER_IFACE.encodeEventLog('Transfer', [
    opts.from ?? DELEGATE,
    opts.to ?? MERCHANT,
    BigInt(opts.value ?? AMOUNT_RAW),
  ])
  return { address: opts.token ?? TOKEN, topics: encoded.topics, data: encoded.data }
}

/** A successful receipt carrying exactly the delegate → merchant settlement. */
function goodReceipt(overrides: Parameters<typeof transferLog>[0] = {}) {
  return { status: 1, blockNumber: 42, logs: [transferLog(overrides)] }
}

/** The settlement block, mined `offsetSec` from now. */
const blockAt = (offsetSec = 0) => ({ number: 42, timestamp: Math.floor(Date.now() / 1000) + offsetSec })

let seq = 0

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`e3009-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'eip3009 agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

function fundingHash(): string {
  return `0x${String(++seq).padStart(64, 'f')}`.slice(0, 66)
}

/**
 * A FUNDED eip3009 intent: `confirmed`, Haven's funding hash in `tx_hash`,
 * funding recipient the delegate, merchant separately recorded — the shape
 * `delegation-authorize.ts` writes and the funding confirm completes.
 */
async function seedFunded(seed: {
  agentId: string
  userId: string
  scheme?: string
  confirmedOffsetSec?: number
  /** Signing deadline, seconds from now (default +600). */
  expiresOffsetSec?: number
  amountRaw?: string
  merchant?: string
  /** Default 'confirmed' (the funded shape). 'submitted' seeds an UNfunded one. */
  status?: string
  /** The stored funding tx_hash; `null` seeds a hash-less (erc7710-shaped) row. */
  txHash?: string | null
}): Promise<{ id: string; funding: string }> {
  const funding = fundingHash()
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, confirmed_at, expires_at, source, payment_rail, execution_rail, machine_metadata,
        x402_resource_url, payment_resource_url, merchant_address, x402_merchant_address)
     VALUES ($1, $2, $3, 84532, 'USDC', $4, $5, $6, '0.001', $5, 0, $7,
             $13, $14, NOW() + ($8 * interval '1 second'), NOW() + ($12 * interval '1 second'),
             'x402', 'x402', 'delegation', $9::jsonb,
             $10, $10, $11, $11)
     RETURNING id`,
    [
      seed.agentId,
      seed.userId,
      TREASURY,
      TOKEN,
      DELEGATE,
      seed.amountRaw ?? AMOUNT_RAW,
      `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
      seed.confirmedOffsetSec ?? 0,
      JSON.stringify({ settlement_scheme: seed.scheme ?? 'eip3009' }),
      RESOURCE,
      seed.merchant ?? MERCHANT,
      seed.expiresOffsetSec ?? 600,
      seed.status ?? 'confirmed',
      seed.txHash === undefined ? funding : seed.txHash,
    ],
  )
  return { id: result.rows[0].id, funding }
}

/** What `haven_report_settlement_evidence` posts: rail and hash, nothing else. */
const report = (agentId: string, paymentId: string, txHash: string) =>
  attachMachinePaymentEvidence({ agentId, paymentId, rail: 'x402', txHash })

/** What `haven_report_x402_outcome` records first: the merchant answered 200. */
const reportOutcome = (agentId: string, paymentId: string, funding: string) =>
  attachMachinePaymentEvidence({ agentId, paymentId, rail: 'x402', txHash: funding, resourceUrl: RESOURCE, merchantStatus: 200 })

async function readIntent(id: string) {
  return (await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])).rows[0]
}
async function readEvidence(id: string) {
  return (await db.query(`SELECT * FROM machine_payment_evidence WHERE payment_intent_id = $1`, [id])).rows
}
async function recordedHash(id: string): Promise<string | null> {
  return (await readIntent(id)).machine_metadata?.merchant_settlement_tx_hash ?? null
}

describeDb('eip3009 merchant settlement report → evidence (#3475)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
    getTransactionReceipt.mockReset()
    getBlock.mockReset().mockResolvedValue(blockAt(30))
  })

  describe('a verified settlement', () => {
    it('is recorded beside the funding hash, which stays, and the receipt names both', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const { id, funding } = await seedFunded({ agentId, userId })
      await reportOutcome(agentId, id, funding)

      const evidence = await report(agentId, id, SETTLE_A)

      expect(evidence).not.toBeNull()
      const intent = await readIntent(id)
      expect(intent.status).toBe('confirmed')
      expect(intent.tx_hash).toBe(funding)
      expect(intent.machine_metadata.merchant_settlement_tx_hash).toBe(SETTLE_A)

      const page = await listReceipts(agentId, 10)
      expect(page?.receipts).toHaveLength(1)
      expect(page?.receipts[0]).toMatchObject({ funding_tx_hash: funding, settlement_tx_hash: SETTLE_A })
    })

    it('fires the accounting feed exactly once, AFTER the settlement hash is written (B1: no pre-settlement race)', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const { id, funding } = await seedFunded({ agentId, userId })
      await reportOutcome(agentId, id, funding)

      // Capture the intent's recorded hash AT THE MOMENT the feed fires: if
      // the feed ever ran before the UPDATE, it would read a settlement-less
      // entry and defer a payment that is already verified.
      const metadataAtFire: Array<string | null> = []
      ;(feedSettledPaymentBestEffort as ReturnType<typeof vi.fn>).mockImplementation(
        async (_userId: string, paymentId: string) => {
          const intent = await readIntent(paymentId)
          metadataAtFire.push((intent.machine_metadata?.merchant_settlement_tx_hash as string | undefined) ?? null)
        },
      )
      // reportOutcome is itself a settlement report (the self-settling case)
      // and fired its own feed — count only THIS report's fire.
      ;(feedSettledPaymentBestEffort as ReturnType<typeof vi.fn>).mockClear()
      metadataAtFire.length = 0

      await report(agentId, id, SETTLE_A)

      expect(feedSettledPaymentBestEffort).toHaveBeenCalledTimes(1)
      expect(feedSettledPaymentBestEffort).toHaveBeenCalledWith(userId, id)
      // The feed is fire-and-forget, so `report` resolves before the mock's
      // own read does: wait for that read rather than racing it.
      await vi.waitFor(() => expect(metadataAtFire).toEqual([SETTLE_A]))
    })

    it('leaves the evidence row as it was: a settlement is not a merchant response', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const { id, funding } = await seedFunded({ agentId, userId })
      await reportOutcome(agentId, id, funding)
      const before = (await readEvidence(id))[0]

      await report(agentId, id, SETTLE_A)

      const after = await readEvidence(id)
      expect(after).toHaveLength(1)
      expect(after[0].proof_status).toBe(before.proof_status)
      expect(after[0].proof_status).toBe('merchant_response_observed')
      expect(after[0].tx_hash).toBe(funding)
      expect(after[0].protocol_receipt_payload).toBeNull()
      expect(after[0].merchant_status).toBe(200)
    })

    it('is idempotent: the same hash again succeeds and changes nothing', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const { id } = await seedFunded({ agentId, userId })

      await report(agentId, id, SETTLE_A)
      const first = await readIntent(id)
      await expect(report(agentId, id, SETTLE_A)).resolves.not.toBeNull()
      expect((await readIntent(id)).machine_metadata).toEqual(first.machine_metadata)
    })

    it('echoes the settlement hash in the evidence 202', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const { id, funding } = await seedFunded({ agentId, userId })

      const result = await attachEvidenceHandler(agentId, { paymentId: id, rail: 'x402', txHash: SETTLE_A })

      expect(result.statusCode).toBe(202)
      expect((result.body as { evidence: Record<string, unknown> }).evidence).toMatchObject({
        funding_tx_hash: funding,
        settlement_tx_hash: SETTLE_A,
      })
    })
  })

  describe('a hash that does not settle this payment is refused and records no hash', () => {
    const cases: Array<[string, () => unknown]> = [
      ['paid from the treasury, not the delegate', () => goodReceipt({ from: TREASURY })],
      ['paid to another address', () => goodReceipt({ to: OTHER })],
      ['a different amount', () => goodReceipt({ value: '999' })],
      ['another token', () => goodReceipt({ token: OTHER })],
      ['reverted', () => ({ status: 0, blockNumber: 42, logs: [transferLog()] })],
    ]
    for (const [name, receipt] of cases) {
      it(name, async () => {
        getTransactionReceipt.mockResolvedValue(receipt())
        const { agentId, userId } = await seedAgent()
        const { id, funding } = await seedFunded({ agentId, userId })

        await expect(report(agentId, id, SETTLE_A)).rejects.toThrow('settlement_unverified')

        const intent = await readIntent(id)
        expect(intent.tx_hash).toBe(funding)
        expect(intent.machine_metadata.merchant_settlement_tx_hash).toBeUndefined()
      })
    }

    it('mined before this payment was funded', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      getBlock.mockResolvedValue(blockAt(-600))
      const { agentId, userId } = await seedAgent()
      const { id } = await seedFunded({ agentId, userId })

      await expect(report(agentId, id, SETTLE_A)).rejects.toThrow('settlement_unverified')
      expect(await recordedHash(id)).toBeNull()
    })

    it('mined after the report was made', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      // The far edge is the report itself (plus 120 s skew): a block from the
      // future cannot be a settlement that already happened.
      getBlock.mockResolvedValue(blockAt(600))
      const { agentId, userId } = await seedAgent()
      const { id } = await seedFunded({ agentId, userId })

      await expect(report(agentId, id, SETTLE_A)).rejects.toThrow('settlement_unverified')
      expect(await recordedHash(id)).toBeNull()
    })

    it('a different hash once one is recorded', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const { id } = await seedFunded({ agentId, userId })
      await report(agentId, id, SETTLE_A)

      await expect(report(agentId, id, SETTLE_B)).rejects.toThrow('settlement_unverified')
      expect(await recordedHash(id)).toBe(SETTLE_A)
    })

    it('a hash another payment already holds', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt({ value: '2000' }))
      const { agentId, userId } = await seedAgent()
      const first = await seedFunded({ agentId, userId, amountRaw: '2000' })
      await report(agentId, first.id, SETTLE_A)
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const second = await seedFunded({ agentId, userId })

      await expect(report(agentId, second.id, SETTLE_A)).rejects.toThrow('settlement_unverified')
      expect(await recordedHash(second.id)).toBeNull()
    })

    it("another payment's FUNDING hash", async () => {
      const { agentId, userId } = await seedAgent()
      const other = await seedFunded({ agentId, userId, amountRaw: '2000' })
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { id } = await seedFunded({ agentId, userId })

      await expect(report(agentId, id, other.funding)).rejects.toThrow('settlement_unverified')
      expect(await recordedHash(id)).toBeNull()
    })

    it('another agent cannot report onto this payment', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const owner = await seedAgent()
      const stranger = await seedAgent()
      const { id } = await seedFunded(owner)

      await expect(report(stranger.agentId, id, SETTLE_A)).resolves.toBeNull()
      expect(await recordedHash(id)).toBeNull()
    })
  })

  describe('late and repeated payments', () => {
    it('a settlement long after the signing deadline is recorded (a resumed funded-merchant retry)', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      // Funded two hours ago, signing deadline 110 minutes ago; the agent
      // re-signed through the funded-retry path and the merchant settled ten
      // minutes ago.
      getBlock.mockResolvedValue(blockAt(-600))
      const { agentId, userId } = await seedAgent()
      const { id } = await seedFunded({ agentId, userId, confirmedOffsetSec: -7200, expiresOffsetSec: -6600 })

      await expect(report(agentId, id, SETTLE_A)).resolves.not.toBeNull()
      expect(await recordedHash(id)).toBe(SETTLE_A)
    })

    it('one payment that is never reported blocks none of the later same-price payments', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      // A: funded first, merchant never answered with a transaction, so it is
      // never reported. B and C: same price, same merchant, overlapping.
      const a = await seedFunded({ agentId, userId, confirmedOffsetSec: -40 })
      const b = await seedFunded({ agentId, userId, confirmedOffsetSec: -20 })
      const c = await seedFunded({ agentId, userId })

      await expect(report(agentId, c.id, SETTLE_B)).resolves.not.toBeNull()
      await expect(report(agentId, b.id, SETTLE_A)).resolves.not.toBeNull()
      expect(await recordedHash(a.id)).toBeNull()
      expect(await recordedHash(b.id)).toBe(SETTLE_A)
      expect(await recordedHash(c.id)).toBe(SETTLE_B)
    })

    it('a mixed-case report of a recorded hash is the same hash', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const first = await seedFunded({ agentId, userId })
      const second = await seedFunded({ agentId, userId })
      const upper = `0x${'A'.repeat(64)}`

      await report(agentId, first.id, upper)
      expect(await recordedHash(first.id)).toBe(SETTLE_A)
      // Idempotent on the same payment, refused on another, whatever the case.
      await expect(report(agentId, first.id, SETTLE_A)).resolves.not.toBeNull()
      await expect(report(agentId, second.id, SETTLE_A)).rejects.toThrow('settlement_unverified')
    })

    it('two concurrent reports of one hash for two payments record it exactly once', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const first = await seedFunded({ agentId, userId })
      const second = await seedFunded({ agentId, userId })

      const results = await Promise.allSettled([
        report(agentId, first.id, SETTLE_A),
        report(agentId, second.id, SETTLE_A),
      ])

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const holders = [await recordedHash(first.id), await recordedHash(second.id)].filter(Boolean)
      expect(holders).toEqual([SETTLE_A])
    })

    it("the UPDATE's own guard refuses a hash another payment holds, without the classification", async () => {
      const { agentId, userId } = await seedAgent()
      const holder = await seedFunded({ agentId, userId })
      const { id } = await seedFunded({ agentId, userId })

      const written = await db.query(RECORD_EIP3009_MERCHANT_SETTLEMENT_SQL, [holder.funding, id, agentId])

      expect(written.rows).toHaveLength(0)
      expect(await recordedHash(id)).toBeNull()
    })

    it('a refusal names its reason and does not claim the payment is unconfirmed', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const first = await seedFunded({ agentId, userId })
      const second = await seedFunded({ agentId, userId })
      await report(agentId, first.id, SETTLE_A)

      const result = await attachEvidenceHandler(agentId, { paymentId: second.id, rail: 'x402', txHash: SETTLE_A })

      expect(result.statusCode).toBe(409)
      const body = result.body as { error: string; reason: string }
      expect(body.reason).toMatch(/already recorded for another payment/)
      expect(body.error).not.toMatch(/not confirmed/)
    })

    // #3529: the hosted tool classifies on the REASON's PRESENCE — a
    // reason-bearing 409 can only come from the eip3009 settlement seam, which
    // fires on a payment whose funding is confirmed. These two pins are the
    // other half of that contract: the ordinary refusals the
    // DELIVERED_UNSETTLED wording was written for must never gain a reason,
    // or the discriminator collapses and a reasonless classification would
    // claim a confirmed funding it cannot know.
    it('a payment_not_confirmed 409 carries NO reason — the discriminator the hosted tool keys on', async () => {
      const { agentId, userId } = await seedAgent()
      const { id, funding } = await seedFunded({ agentId, userId, status: 'submitted' })

      const result = await attachEvidenceHandler(agentId, { paymentId: id, rail: 'x402', txHash: funding })

      expect(result.statusCode).toBe(409)
      const body = result.body as { error: string; reason?: string }
      expect(body.error).toMatch(/requires a confirmed payment/)
      expect(body).not.toHaveProperty('reason')
    })

    it('a plain (non-eip3009-seam) settlement_unverified 409 carries NO reason', async () => {
      // The erc7710 seam's refusal is a plain `Error` (not a
      // SettlementReportRefusal): a submitted, hash-less erc7710 intent whose
      // reported transaction does not verify. The body must stay reason-free
      // even though the verifier HAS a reason internally — the relay is bound
      // to the eip3009 seam's refusal shape, and widening it would hand the
      // reasonless DELIVERED_UNSETTLED arm's wording a confirmed-funding claim
      // it cannot make.
      getTransactionReceipt.mockResolvedValue(goodReceipt({ from: TREASURY, to: OTHER }))
      const { agentId, userId } = await seedAgent()
      const { id } = await seedFunded({ agentId, userId, scheme: 'erc7710', status: 'submitted', txHash: null })

      const result = await attachEvidenceHandler(agentId, { paymentId: id, rail: 'x402', txHash: SETTLE_A })

      expect(result.statusCode).toBe(409)
      const body = result.body as { error: string; reason?: string }
      expect(body.error).toMatch(/settlement transaction does not match this payment on-chain/)
      expect(body).not.toHaveProperty('reason')
    })
  })

  describe('what stays unchanged', () => {
    it('a transaction not mined yet is retryable and records no hash', async () => {
      getTransactionReceipt.mockResolvedValue(null)
      const { agentId, userId } = await seedAgent()
      const { id } = await seedFunded({ agentId, userId })

      await expect(report(agentId, id, SETTLE_A)).rejects.toThrow('settlement_unobservable')
      expect(await recordedHash(id)).toBeNull()
    })

    it('the funding hash itself still takes the existing attach path', async () => {
      const { agentId, userId } = await seedAgent()
      const { id, funding } = await seedFunded({ agentId, userId })

      await reportOutcome(agentId, id, funding)

      expect(getTransactionReceipt).not.toHaveBeenCalled()
      expect((await readEvidence(id))[0].proof_status).toBe('merchant_response_observed')
      expect(await recordedHash(id)).toBeNull()
    })

    it('a mismatched rail is refused before the chain is read', async () => {
      const { agentId, userId } = await seedAgent()
      const { id } = await seedFunded({ agentId, userId })

      // A protocol rail, so the refusal is this seam's, not `unsupported_rail`.
      await expect(
        attachMachinePaymentEvidence({ agentId, paymentId: id, rail: 'mpp_crypto', txHash: SETTLE_A }),
      ).rejects.toThrow('rail_mismatch')
      expect(getTransactionReceipt).not.toHaveBeenCalled()
      expect(await recordedHash(id)).toBeNull()
    })

    it('a mismatched resource URL is refused before the chain is read', async () => {
      const { agentId, userId } = await seedAgent()
      const { id } = await seedFunded({ agentId, userId })

      await expect(
        attachMachinePaymentEvidence({
          agentId, paymentId: id, rail: 'x402', txHash: SETTLE_A, resourceUrl: 'https://elsewhere.example/',
        }),
      ).rejects.toThrow('resource_mismatch')
      expect(getTransactionReceipt).not.toHaveBeenCalled()
      expect(await recordedHash(id)).toBeNull()
    })

    it('a payment that cannot carry an evidence row is refused before the hash is committed', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const { id } = await seedFunded({ agentId, userId })
      await db.query(
        `UPDATE payment_intents SET x402_resource_url = NULL, payment_resource_url = NULL WHERE id = $1`,
        [id],
      )

      await expect(report(agentId, id, SETTLE_A)).rejects.toThrow('resource_missing')
      const answered = await attachEvidenceHandler(agentId, { paymentId: id, rail: 'x402', txHash: SETTLE_A })
      expect(answered.statusCode).toBe(409)
      expect(getTransactionReceipt).not.toHaveBeenCalled()
      expect(await recordedHash(id)).toBeNull()
    })

    it('an unfunded eip3009 intent is not this seam', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const { id } = await seedFunded({ agentId, userId })
      await db.query(`UPDATE payment_intents SET status = 'submitted', tx_hash = NULL WHERE id = $1`, [id])

      await expect(report(agentId, id, SETTLE_A)).rejects.toThrow('payment_not_confirmed')
      expect(getTransactionReceipt).not.toHaveBeenCalled()
      expect(await recordedHash(id)).toBeNull()
    })
  })
})
