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
import { deriveX402PaymentNonce } from '@haven_ai/sdk/edge'

const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const TREASURY = '0x00000000000000000000000000000000000000b1'
// #3925: the delegate is a REAL key now — the settlement report must carry an
// X-PAYMENT header whose authorization is signed by it, so the fixture wallet
// is fixed and `DELEGATE` is its address (the sweep/verifier compare
// case-insensitively; the funding seed stores it verbatim).
const DELEGATE_WALLET = new ethers.Wallet(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)
const DELEGATE = DELEGATE_WALLET.address
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const OTHER = '0x00000000000000000000000000000000000000ee'
const AMOUNT_RAW = '1000'
const RESOURCE = 'http://merchant.example/api/joke'
const SETTLE_A = `0x${'a'.repeat(64)}`
const SETTLE_B = `0x${'b'.repeat(64)}`
/** A nonce no payment derives — the default fixtures' shared burn. */
const TEST_NONCE = `0x${'77'.repeat(32)}`

const TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

const AUTHORIZATION_USED_IFACE = new ethers.Interface([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
])

function authorizationUsedLog(authorizer: string, nonce: string, token?: string) {
  const encoded = AUTHORIZATION_USED_IFACE.encodeEventLog('AuthorizationUsed', [authorizer, nonce])
  return { address: token ?? TOKEN, topics: encoded.topics, data: encoded.data }
}

/** The EIP-712 domain the pinned Base Sepolia USDC signs under. */
const SETTLEMENT_DOMAIN = {
  name: 'USDC',
  version: '2',
  chainId: 84532,
  verifyingContract: TOKEN,
} as const

const TRANSFER_WITH_AUTHORIZATION_TYPES: Record<string, ethers.TypedDataField[]> = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

/**
 * The X-PAYMENT header a settlement report posts: base64 JSON, `payload`
 * carrying the delegate's EIP-3009 signature over an authorization whose
 * nonce names the payment. Mirrors what `exact.evm.encodePayment` emits.
 */
async function settlementHeader(
  opts: {
    nonce: string
    signer?: ethers.Wallet
    from?: string
    to?: string
    value?: string
    validAfter?: string
    validBefore?: string
    domainVerifyingContract?: string
  },
): Promise<string> {
  const authorization = {
    from: opts.from ?? DELEGATE,
    to: opts.to ?? MERCHANT,
    value: opts.value ?? AMOUNT_RAW,
    validAfter: opts.validAfter ?? '0',
    validBefore: opts.validBefore ?? '9999999999',
    nonce: opts.nonce,
  }
  const signature = await (opts.signer ?? DELEGATE_WALLET).signTypedData(
    opts.domainVerifyingContract
      ? { ...SETTLEMENT_DOMAIN, verifyingContract: opts.domainVerifyingContract }
      : SETTLEMENT_DOMAIN,
    TRANSFER_WITH_AUTHORIZATION_TYPES,
    {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
    },
  )
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'eip155:84532',
      payload: { signature, authorization },
    }),
    'utf8',
  ).toString('base64')
}

/**
 * The default header: the payment's own derived nonce, signed by its
 * delegate — the shape a deriving client posts. The receipt mock must carry
 * the same nonce's `AuthorizationUsed` (see `settleReceipt`).
 */
const derivedSettlementHeader = (paymentId: string) =>
  settlementHeader({ nonce: deriveX402PaymentNonce(paymentId) })

function transferLog(opts: { token?: string; from?: string; to?: string; value?: string } = {}) {
  const encoded = TRANSFER_IFACE.encodeEventLog('Transfer', [
    opts.from ?? DELEGATE,
    opts.to ?? MERCHANT,
    BigInt(opts.value ?? AMOUNT_RAW),
  ])
  return { address: opts.token ?? TOKEN, topics: encoded.topics, data: encoded.data }
}

/**
 * A successful receipt carrying exactly the delegate → merchant settlement.
 * Since #3925 a recordable settlement also carries the token's own
 * `AuthorizationUsed` log for the burned nonce — `authUsed` lists them
 * (`undefined` plants the DEFAULT test nonce the default header burns; `[]`
 * is the explicit no-burn case-(c) receipt).
 */
function goodReceipt(
  overrides: Parameters<typeof transferLog>[0] = {},
  authUsed?: string[],
) {
  const used = authUsed === undefined ? [TEST_NONCE] : authUsed
  return {
    status: 1,
    blockNumber: 42,
    // #4061 review: FiatToken v2's real order — each authorization's
    // `AuthorizationUsed`, then its own `Transfer` (the verifier pairs them).
    logs:
      used.length === 0
        ? [transferLog(overrides)]
        : used.flatMap((nonce) => [authorizationUsedLog(DELEGATE, nonce), transferLog(overrides)]),
  }
}

/**
 * Point the receipt mock at the settlement of ONE payment: the transfer plus
 * `AuthorizationUsed(delegate, deriveX402PaymentNonce(id))` — the pair the
 * default derived header proves.
 */
const settleReceiptFor = (paymentId: string) =>
  getTransactionReceipt.mockResolvedValue(goodReceipt({}, [deriveX402PaymentNonce(paymentId)]))

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

/**
 * What `haven_report_settlement_evidence` posts: rail, hash — and since
 * #3925 the X-PAYMENT header proving the burned nonce. The default header
 * signs the DEFAULT test nonce (the one `goodReceipt()` plants in the
 * receipt); tests pass an explicit header for any other proof shape.
 */
const report = async (agentId: string, paymentId: string, txHash: string, header?: string) =>
  attachMachinePaymentEvidence({
    agentId,
    paymentId,
    rail: 'x402',
    txHash,
    paymentProofHeader: header ?? (await settlementHeader({ nonce: TEST_NONCE })),
  })

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
      // Once only: a lasting implementation would leak an unawaited DB read
      // into every later test that fires the feed, racing its resetDb().
      ;(feedSettledPaymentBestEffort as ReturnType<typeof vi.fn>).mockImplementationOnce(
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

      const result = await attachEvidenceHandler(agentId, {
        paymentId: id,
        rail: 'x402',
        txHash: SETTLE_A,
        paymentProofHeader: await settlementHeader({ nonce: TEST_NONCE }),
      })

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

      const written = await db.query(RECORD_EIP3009_MERCHANT_SETTLEMENT_SQL, [holder.funding, id, agentId, null])

      expect(written.rows).toHaveLength(0)
      expect(await recordedHash(id)).toBeNull()
    })

    it('a refusal names its reason and does not claim the payment is unconfirmed', async () => {
      getTransactionReceipt.mockResolvedValue(goodReceipt())
      const { agentId, userId } = await seedAgent()
      const first = await seedFunded({ agentId, userId })
      const second = await seedFunded({ agentId, userId })
      await report(agentId, first.id, SETTLE_A)

      const result = await attachEvidenceHandler(agentId, {
        paymentId: second.id,
        rail: 'x402',
        txHash: SETTLE_A,
        paymentProofHeader: await settlementHeader({ nonce: TEST_NONCE }),
      })

      expect(result.statusCode).toBe(409)
      const body = result.body as { error: string; reason: string }
      expect(body.reason).toMatch(/already recorded for another payment/)
      expect(body.error).not.toMatch(/not confirmed/)
      // #4061: only the missing-header refusal carries a code — a client that
      // re-reports on the code must never be told to re-report this one.
      expect(body).not.toHaveProperty('error_code')
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

  describe('nonce attribution (#3925)', () => {
    // #4061 review (should-fix 1): one transaction settling TWO of the
    // delegate's authorizations. FiatToken emits each authorization's
    // `AuthorizationUsed` immediately followed by its own `Transfer`
    // (`_markAuthorizationAsUsed`, then `_transfer`). Here the header's nonce
    // was burned for a transfer to SOMEONE ELSE; the delegate → merchant
    // transfer of this payment's amount belongs to the OTHER authorization.
    it('a nonce burned in a two-authorization tx cannot borrow the other authorization’s transfer', async () => {
      const { agentId, userId } = await seedAgent()
      const a = await seedFunded({ agentId, userId })
      const OTHER_NONCE = `0x${'88'.repeat(32)}`
      getTransactionReceipt.mockResolvedValue({
        status: 1,
        blockNumber: 42,
        logs: [
          authorizationUsedLog(DELEGATE, TEST_NONCE),
          transferLog({ to: OTHER }),
          authorizationUsedLog(DELEGATE, OTHER_NONCE),
          transferLog(),
        ],
      })

      const answered = await attachEvidenceHandler(agentId, {
        paymentId: a.id,
        rail: 'x402',
        txHash: SETTLE_A,
        paymentProofHeader: await settlementHeader({ nonce: TEST_NONCE }),
      })

      expect(answered.statusCode).toBe(409)
      expect((answered.body as { reason?: string }).reason).toMatch(/that authorization's own Transfer/)
      expect(await recordedHash(a.id)).toBeNull()
    })

    it('in the same two-authorization tx, the nonce whose OWN transfer pays this merchant records', async () => {
      const { agentId, userId } = await seedAgent()
      const a = await seedFunded({ agentId, userId })
      const OTHER_NONCE = `0x${'88'.repeat(32)}`
      getTransactionReceipt.mockResolvedValue({
        status: 1,
        blockNumber: 42,
        logs: [
          authorizationUsedLog(DELEGATE, OTHER_NONCE),
          transferLog({ to: OTHER }),
          authorizationUsedLog(DELEGATE, TEST_NONCE),
          transferLog(),
        ],
      })

      await report(agentId, a.id, SETTLE_A) // default header: TEST_NONCE

      expect(await recordedHash(a.id)).toBe(SETTLE_A)
    })

    it('a hash whose receipt burned A’s nonce is refused against same-shaped B — the sibling accusation, nothing written (red on 641f527d)', async () => {
      const { agentId, userId } = await seedAgent()
      const a = await seedFunded({ agentId, userId })
      const b = await seedFunded({ agentId, userId })
      // The transaction burned A's derived nonce; B's own header names B.
      getTransactionReceipt.mockResolvedValue(goodReceipt({}, [deriveX402PaymentNonce(a.id)]))

      const answered = await attachEvidenceHandler(agentId, {
        paymentId: b.id,
        rail: 'x402',
        txHash: SETTLE_A,
        paymentProofHeader: await derivedSettlementHeader(b.id),
      })

      expect(answered.statusCode).toBe(409)
      // The burned nonce IS the derived nonce of B's same-shaped sibling.
      expect((answered.body as { reason?: string }).reason).toMatch(/settles another payment/)
      expect(await recordedHash(b.id)).toBeNull()
      expect(await recordedHash(a.id)).toBeNull()
    })

    // #4061: a header LIFTED from a same-agent sibling. Same delegate, so the
    // payer and signature checks pass; the nonce it names is A's own derived
    // nonce, and the transaction (A's settlement) really burned it — so the
    // burned-nonce check passes too, against B.
    it('a header lifted from same-shaped sibling A, reported with A’s settlement against B, is refused before the chain is read', async () => {
      const { agentId, userId } = await seedAgent()
      const a = await seedFunded({ agentId, userId })
      const b = await seedFunded({ agentId, userId })
      getTransactionReceipt.mockResolvedValue(goodReceipt({}, [deriveX402PaymentNonce(a.id)]))

      const answered = await attachEvidenceHandler(agentId, {
        paymentId: b.id,
        rail: 'x402',
        txHash: SETTLE_A,
        paymentProofHeader: await derivedSettlementHeader(a.id),
      })

      expect(answered.statusCode).toBe(409)
      expect((answered.body as { reason?: string }).reason).toMatch(/derived nonce of another payment/)
      // Not the missing-header code: re-reporting this header re-refuses.
      expect(answered.body).not.toHaveProperty('error_code')
      expect(getTransactionReceipt).not.toHaveBeenCalled()
      expect(await recordedHash(b.id)).toBeNull()
      // A keeps its own settlement: reported with its own header, it records.
      await report(agentId, a.id, SETTLE_A, await derivedSettlementHeader(a.id))
      expect(await recordedHash(a.id)).toBe(SETTLE_A)
    })

    it('the same hash against A — the payment whose nonce it burned — is recorded, nonce-bound', async () => {
      const { agentId, userId } = await seedAgent()
      const a = await seedFunded({ agentId, userId })
      getTransactionReceipt.mockResolvedValue(goodReceipt({}, [deriveX402PaymentNonce(a.id)]))

      await report(agentId, a.id, SETTLE_A, await derivedSettlementHeader(a.id))

      expect(await recordedHash(a.id)).toBe(SETTLE_A)
      const meta = (await readIntent(a.id)).machine_metadata
      expect(meta.merchant_settlement_nonce_bound).toBe(true)
    })

    it('a header whose nonce equals the payment’s derived nonce records the consistency flag', async () => {
      const { agentId, userId } = await seedAgent()
      const a = await seedFunded({ agentId, userId })
      settleReceiptFor(a.id)

      await report(agentId, a.id, SETTLE_A, await derivedSettlementHeader(a.id))

      expect(await recordedHash(a.id)).toBe(SETTLE_A)
      const meta = (await readIntent(a.id)).machine_metadata
      expect(meta.merchant_settlement_nonce_derived).toBe(true)
    })

    it('a header nonce that is properly signed and burned but NOT derived records nonceBound without the derived flag', async () => {
      const { agentId, userId } = await seedAgent()
      const a = await seedFunded({ agentId, userId })
      getTransactionReceipt.mockResolvedValue(goodReceipt({}, [TEST_NONCE]))

      await report(agentId, a.id, SETTLE_A) // default header: TEST_NONCE, signed by the delegate

      expect(await recordedHash(a.id)).toBe(SETTLE_A)
      const meta = (await readIntent(a.id)).machine_metadata
      expect(meta.merchant_settlement_nonce_bound).toBe(true)
      expect(meta.merchant_settlement_nonce_derived).toBeUndefined()
    })

    it('a header signed by a key other than the delegate is refused before the chain is used', async () => {
      const { agentId, userId } = await seedAgent()
      const a = await seedFunded({ agentId, userId })
      const impostor = new ethers.Wallet(ethers.Wallet.createRandom().privateKey)
      getTransactionReceipt.mockResolvedValue(goodReceipt({}, [TEST_NONCE]))

      await expect(
        report(agentId, a.id, SETTLE_A, await settlementHeader({ nonce: TEST_NONCE, signer: impostor })),
      ).rejects.toThrow('settlement_unverified')

      expect(await recordedHash(a.id)).toBeNull()
    })

    it('a report with no header is refused, the reason naming the header and the retry that carries it', async () => {
      const { agentId, userId } = await seedAgent()
      const a = await seedFunded({ agentId, userId })
      settleReceiptFor(a.id)

      const answered = await attachEvidenceHandler(agentId, {
        paymentId: a.id,
        rail: 'x402',
        txHash: SETTLE_A,
      })

      expect(answered.statusCode).toBe(409)
      expect((answered.body as { reason?: string }).reason).toMatch(/no X-PAYMENT payment header/)
      expect((answered.body as { reason?: string }).reason).toMatch(/payment header that was sent to the merchant/)
      // #4061: the refusal carries a machine code, so a client branches on
      // the code (re-report WITH the header), never on the sentence.
      expect((answered.body as { error_code?: string }).error_code).toBe('settlement_proof_header_missing')
      expect(await recordedHash(a.id)).toBeNull()
    })

    it('a receipt whose Transfer burns no AuthorizationUsed for the delegate is refused as not an EIP-3009 settlement (case c)', async () => {
      const { agentId, userId } = await seedAgent()
      const a = await seedFunded({ agentId, userId })
      getTransactionReceipt.mockResolvedValue(goodReceipt({}, []))

      const answered = await attachEvidenceHandler(agentId, {
        paymentId: a.id,
        rail: 'x402',
        txHash: SETTLE_A,
        paymentProofHeader: await settlementHeader({ nonce: TEST_NONCE }),
      })

      expect(answered.statusCode).toBe(409)
      expect((answered.body as { reason?: string }).reason).toMatch(/not an EIP-3009 settlement/)
      expect(await recordedHash(a.id)).toBeNull()
    })

    it('an AuthorizationUsed from a contract other than the payment’s token binds nothing', async () => {
      const { agentId, userId } = await seedAgent()
      const a = await seedFunded({ agentId, userId })
      getTransactionReceipt.mockResolvedValue({
        status: 1,
        blockNumber: 42,
        logs: [authorizationUsedLog(DELEGATE, TEST_NONCE, OTHER), transferLog()],
      })

      const answered = await attachEvidenceHandler(agentId, {
        paymentId: a.id,
        rail: 'x402',
        txHash: SETTLE_A,
        paymentProofHeader: await settlementHeader({ nonce: TEST_NONCE }),
      })

      expect(answered.statusCode).toBe(409)
      expect((answered.body as { reason?: string }).reason).toMatch(/not an EIP-3009 settlement/)
      expect(await recordedHash(a.id)).toBeNull()
    })

    it('a burned nonce that matches no sibling’s derived nonce is refused as a plain nonce mismatch', async () => {
      const { agentId, userId } = await seedAgent()
      const a = await seedFunded({ agentId, userId })
      // The receipt burned TEST_NONCE; the header names A's derived nonce; no
      // sibling holds that nonce, so the refusal stays a nonce mismatch.
      getTransactionReceipt.mockResolvedValue(goodReceipt({}, [TEST_NONCE]))

      const answered = await attachEvidenceHandler(agentId, {
        paymentId: a.id,
        rail: 'x402',
        txHash: SETTLE_A,
        paymentProofHeader: await derivedSettlementHeader(a.id),
      })

      expect(answered.statusCode).toBe(409)
      expect((answered.body as { reason?: string }).reason).toMatch(/nonce does not match the reported authorization/)
      expect((answered.body as { reason?: string }).reason).not.toMatch(/settles another payment/)
      expect(await recordedHash(a.id)).toBeNull()
    })
  })
})
