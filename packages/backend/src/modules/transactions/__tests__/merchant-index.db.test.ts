/**
 * The scheduled merchant inbound index (#4903, epic #4885), on the real
 * database.
 *
 * What is proven here and nowhere else:
 *
 * 1. A burst of 1,000 payments between two passes is indexed IN FULL — the
 *    premise of the slice is that the explorer's capped, newest-first read lost
 *    the older ones.
 * 2. The pass is idempotent, and safe with two replicas running: two concurrent
 *    passes over the same range converge on the same rows and the same cursor.
 * 3. The cursor advances, and a failed chain read leaves it where it was so the
 *    next tick retries the same range.
 * 4. Indexing continues while merchant services are turned OFF — the account
 *    list is the marker, not the setting.
 * 5. `sender_is_own_address` is decided at index time.
 * 6. The reconcile rule for rows collapsed before migration 127: a two-leg
 *    transaction replayed over an existing collapsed row adopts that row (it
 *    keeps its amount and its consumed flag) and inserts the missing leg, so
 *    the receive balance is UNCHANGED while every leg is indexed.
 *
 * The chain read is injected (`MerchantIndexDeps`), so no RPC is involved; the
 * persistence, the unique indexes and the cursor are the real thing.
 */
import type { FastifyBaseLogger } from 'fastify'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import db from '../../../db.js'
import {
  findInboundIndexCursor,
  inboundReceiveBalanceAtomic,
  listMerchantAccounts,
  upsertInboundIndexCursor,
} from '../../../infra/repositories/inbound-transfers.js'
import { ingestInboundTransfers } from '../receive.js'
import {
  runMerchantInboundIndexTick,
  type MerchantIndexDeps,
} from '../merchant-index.js'
import type { ChainInboundLeg, ChainReadResult } from '../chain-read.js'

const CHAIN = 84532
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const log = { warn: () => {}, info: () => {} } as unknown as FastifyBaseLogger

let seq = 0

interface Seeded {
  userId: string
  accountId: string
  address: string
}

async function seedAccount(opts: { merchant?: boolean; enabled?: boolean } = {}): Promise<Seeded> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`mch-idx-${n}-${Date.now()}-${Math.random()}@test.example`],
  )
  const userId = user.rows[0].id
  const address = `0x${String(n).padStart(4, '0')}${'a'.repeat(36)}`
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts
       (user_id, account_address, chain_id, execution_rail, account_type, is_merchant_account)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid', $4) RETURNING id`,
    [userId, address, CHAIN, opts.merchant ?? true],
  )
  if (opts.enabled !== undefined) {
    await db.query(
      `INSERT INTO merchant_service_settings (user_id, enabled, enabled_at, disabled_at)
       VALUES ($1, $2, $3, $4)`,
      [
        userId,
        opts.enabled,
        opts.enabled ? new Date() : null,
        opts.enabled ? null : new Date(),
      ],
    )
  }
  return { userId, accountId: account.rows[0].id, address }
}

function leg(over: Partial<ChainInboundLeg> = {}): ChainInboundLeg {
  const n = ++seq
  return {
    txHash: `0x${String(n).padStart(4, '0')}${'f'.repeat(60)}`,
    logIndex: 0,
    payerAddress: `0x${String(n).padStart(4, '0')}${'b'.repeat(36)}`,
    tokenAddress: USDC,
    amountRaw: '1000000',
    blockNumber: 4_000_000 + n,
    blockTime: new Date('2026-11-17T00:00:00Z'),
    ...over,
  }
}

/**
 * Deps with the real repository and a scripted chain read. `ranges` records
 * every (fromBlock, toBlock) the pass asked for, so the cursor behaviour is
 * observable.
 */
function deps(opts: {
  legs?: ChainInboundLeg[]
  latest?: number
  seedBlock?: number
  readOk?: boolean
  ranges?: Array<[number, number]>
}): MerchantIndexDeps {
  return {
    listMerchantAccounts: () => listMerchantAccounts(),
    findCursor: (accountId) => findInboundIndexCursor(accountId),
    saveCursor: (input) => upsertInboundIndexCursor(input),
    latestBlock: async () => opts.latest ?? 5_000_000,
    blockAtOrBefore: async () => opts.seedBlock ?? 4_000_000,
    readRange: async (_chainId, _address, fromBlock, toBlock): Promise<ChainReadResult> => {
      opts.ranges?.push([fromBlock, toBlock])
      if (opts.readOk === false) return { ok: false, reason: 'rpc_unavailable' }
      return { ok: true, legs: opts.legs ?? [] }
    },
    ingest: (account, legs, logger) => ingestInboundTransfers(account, legs, logger),
  }
}

async function countRows(accountId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM inbound_transfers WHERE account_id = $1',
    [accountId],
  )
  return Number(result.rows[0]!.count)
}

describeDb('merchant inbound index (#4903)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('indexes all 1,000 payments that arrived between two passes', async () => {
    const seeded = await seedAccount()
    const legs = Array.from({ length: 1_000 }, () => leg())

    const tick = await runMerchantInboundIndexTick(log, deps({ legs }))

    expect(tick.accounts).toBe(1)
    expect(tick.indexed).toBe(1_000)
    expect(tick.failed).toBe(0)
    expect(await countRows(seeded.accountId)).toBe(1_000)
  }, 120_000)

  it('is idempotent: a second pass over the same range inserts nothing', async () => {
    const seeded = await seedAccount()
    const legs = Array.from({ length: 50 }, () => leg())

    const first = await runMerchantInboundIndexTick(log, deps({ legs }))
    const second = await runMerchantInboundIndexTick(log, deps({ legs }))

    expect(first.indexed).toBe(50)
    expect(second.indexed).toBe(0)
    expect(await countRows(seeded.accountId)).toBe(50)
  })

  it('is safe with two replicas running: concurrent passes converge on the same rows and cursor', async () => {
    const seeded = await seedAccount()
    const legs = Array.from({ length: 200 }, () => leg())

    const [a, b] = await Promise.all([
      runMerchantInboundIndexTick(log, deps({ legs })),
      runMerchantInboundIndexTick(log, deps({ legs })),
    ])

    expect(a.failed).toBe(0)
    expect(b.failed).toBe(0)
    expect(await countRows(seeded.accountId)).toBe(200)
    const cursor = await findInboundIndexCursor(seeded.accountId)
    expect(cursor?.lastIndexedBlock).toBe(4_009_999)
  })

  it('advances the cursor, and the next pass reads only the blocks after it', async () => {
    const seeded = await seedAccount()
    const ranges: Array<[number, number]> = []

    await runMerchantInboundIndexTick(log, deps({ legs: [leg()], latest: 4_000_500, ranges }))
    expect(ranges).toEqual([[4_000_000, 4_000_500]])

    await runMerchantInboundIndexTick(log, deps({ legs: [], latest: 4_000_600, ranges }))
    expect(ranges[1]).toEqual([4_000_501, 4_000_600])

    const cursor = await findInboundIndexCursor(seeded.accountId)
    expect(cursor?.lastIndexedBlock).toBe(4_000_600)
  })

  it('bounds one tick to MAX_BLOCKS_PER_PASS and continues from the cursor next tick', async () => {
    const seeded = await seedAccount()
    const ranges: Array<[number, number]> = []

    await runMerchantInboundIndexTick(log, deps({ legs: [], latest: 5_000_000, ranges }))
    expect(ranges[0]).toEqual([4_000_000, 4_009_999])

    await runMerchantInboundIndexTick(log, deps({ legs: [], latest: 5_000_000, ranges }))
    expect(ranges[1]).toEqual([4_010_000, 4_019_999])

    const cursor = await findInboundIndexCursor(seeded.accountId)
    expect(cursor?.lastIndexedBlock).toBe(4_019_999)
  })

  it('never moves the cursor backwards', async () => {
    const seeded = await seedAccount()
    await upsertInboundIndexCursor({
      accountId: seeded.accountId,
      chainId: CHAIN,
      lastIndexedBlock: 900,
    })
    await upsertInboundIndexCursor({
      accountId: seeded.accountId,
      chainId: CHAIN,
      lastIndexedBlock: 100,
    })
    const cursor = await findInboundIndexCursor(seeded.accountId)
    expect(cursor?.lastIndexedBlock).toBe(900)
  })

  it('leaves the cursor unchanged when the chain read fails, so the next tick retries', async () => {
    const seeded = await seedAccount()

    const failed = await runMerchantInboundIndexTick(log, deps({ readOk: false }))
    expect(failed.failed).toBe(1)
    expect(await findInboundIndexCursor(seeded.accountId)).toBeNull()

    const ranges: Array<[number, number]> = []
    await runMerchantInboundIndexTick(log, deps({ legs: [leg()], ranges }))
    expect(ranges[0]![0]).toBe(4_000_000)
  })

  it('keeps indexing while merchant services are turned off', async () => {
    const seeded = await seedAccount({ merchant: true, enabled: false })

    const tick = await runMerchantInboundIndexTick(log, deps({ legs: [leg(), leg()] }))

    expect(tick.indexed).toBe(2)
    expect(await countRows(seeded.accountId)).toBe(2)
  })

  it('does not touch accounts that are not merchant accounts', async () => {
    const merchant = await seedAccount({ merchant: true })
    const ordinary = await seedAccount({ merchant: false })

    await runMerchantInboundIndexTick(log, deps({ legs: [leg()] }))

    expect(await countRows(merchant.accountId)).toBe(1)
    expect(await countRows(ordinary.accountId)).toBe(0)
  })

  it('records whether the payer is one of the owner own addresses, at index time', async () => {
    const seeded = await seedAccount()
    const ownAddress = `0x${'d'.repeat(40)}`
    await db.query(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
       VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid')`,
      [seeded.userId, ownAddress, CHAIN],
    )

    await runMerchantInboundIndexTick(
      log,
      deps({
        legs: [
          leg({ payerAddress: ownAddress, amountRaw: '1000000' }),
          leg({ payerAddress: `0x${'e'.repeat(40)}`, amountRaw: '2000000' }),
        ],
      }),
    )

    const rows = await db.query<{ amount_raw: string; sender_is_own_address: boolean }>(
      `SELECT amount_raw, sender_is_own_address FROM inbound_transfers WHERE account_id = $1`,
      [seeded.accountId],
    )
    const byAmount = new Map(rows.rows.map((row) => [row.amount_raw, row.sender_is_own_address]))
    expect(byAmount.get('1000000')).toBe(true)
    expect(byAmount.get('2000000')).toBe(false)
  })

  it('replays a two-transfer transaction over an existing collapsed row without changing the balance', async () => {
    const seeded = await seedAccount()
    const sharedHash = `0x${'7'.repeat(64)}`
    const payer = `0x${'b'.repeat(40)}`

    // The pre-migration row: one row for the transaction, no log index, already
    // matched and counted in the balance. This is what migration 097's identity
    // wrote for a two-leg transaction.
    await db.query(
      `INSERT INTO inbound_transfers
         (account_id, user_id, chain_id, tx_hash, log_index, payer_address, token_address,
          amount_raw, block_number, block_time, match_kind, balance_consumed)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, '1000000', 4000000, NOW(), 'receipt', true)`,
      [seeded.accountId, seeded.userId, CHAIN, sharedHash, payer, USDC],
    )
    const balanceBefore = await inboundReceiveBalanceAtomic(seeded.accountId, seeded.userId)
    expect(balanceBefore).toBe('1000000')

    // The chain now reports both legs of that transaction.
    const tick = await runMerchantInboundIndexTick(
      log,
      deps({
        legs: [
          leg({ txHash: sharedHash, logIndex: 2, payerAddress: payer, amountRaw: '1000000' }),
          leg({ txHash: sharedHash, logIndex: 5, payerAddress: payer, amountRaw: '2500000' }),
        ],
      }),
    )

    expect(tick.indexed).toBe(1) // the adopted row is not a new row
    const rows = await db.query<{
      log_index: number | null
      amount_raw: string
      balance_consumed: boolean
      match_kind: string | null
    }>(
      `SELECT log_index, amount_raw, balance_consumed, match_kind
         FROM inbound_transfers
        WHERE account_id = $1
        ORDER BY log_index`,
      [seeded.accountId],
    )
    expect(rows.rows).toHaveLength(2)
    // The pre-existing row was ADOPTED: it kept its amount, its match and its
    // consumed flag, and gained the log index of the leg it was written from.
    expect(rows.rows[0]).toMatchObject({
      log_index: 2,
      amount_raw: '1000000',
      balance_consumed: true,
      match_kind: 'receipt',
    })
    // The missing leg is indexed, unearned until matched.
    expect(rows.rows[1]).toMatchObject({
      log_index: 5,
      amount_raw: '2500000',
      balance_consumed: false,
      match_kind: null,
    })

    // The receive balance is UNCHANGED.
    expect(await inboundReceiveBalanceAtomic(seeded.accountId, seeded.userId)).toBe('1000000')
  })

  it('does not adopt a row no leg matches (a row planted by the old caller-supplied route)', async () => {
    const seeded = await seedAccount()
    const sharedHash = `0x${'6'.repeat(64)}`

    await db.query(
      `INSERT INTO inbound_transfers
         (account_id, user_id, chain_id, tx_hash, log_index, payer_address, token_address,
          amount_raw, block_number, block_time)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, '999999999', 4000000, NOW())`,
      [seeded.accountId, seeded.userId, CHAIN, sharedHash, `0x${'1'.repeat(40)}`, USDC],
    )

    await runMerchantInboundIndexTick(
      log,
      deps({
        legs: [leg({ txHash: sharedHash, logIndex: 1, payerAddress: `0x${'2'.repeat(40)}` })],
      }),
    )

    const rows = await db.query<{ log_index: number | null; amount_raw: string }>(
      `SELECT log_index, amount_raw FROM inbound_transfers WHERE account_id = $1 ORDER BY log_index NULLS FIRST`,
      [seeded.accountId],
    )
    // The planted row keeps log_index NULL and is never adopted; the real leg
    // is a separate row.
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows[0]).toMatchObject({ log_index: null, amount_raw: '999999999' })
    expect(rows.rows[1]).toMatchObject({ log_index: 1, amount_raw: '1000000' })
  })
})
