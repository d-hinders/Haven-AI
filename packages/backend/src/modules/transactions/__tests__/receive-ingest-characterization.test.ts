/**
 * The receive index's characterization, and the two changes that apply to
 * EVERY account (#4903, epic #4885).
 *
 * The issue is explicit about the order: characterization tests first, then one
 * test for each of the two changes. The reason is that the ingest and the row
 * identity are shared, so a change made for merchant accounts silently changes
 * every account's index — and "accounts that are not merchant accounts are
 * indexed as before" is only checkable against a pinned baseline.
 *
 * Pinned baseline (unchanged):
 * - one row per inbound USDC leg, keyed on the account's own address;
 * - the settlement asset by registry ADDRESS, so a contract that merely names
 *   itself USDC is not indexed;
 * - a re-read of the same explorer window inserts nothing (idempotent);
 * - one transaction paying two accounts lands one row per receiving account.
 *
 * The two changes, for every account:
 * - a transaction carrying several USDC transfers to the same account is
 *   counted in full (one row per leg, not one per transaction);
 * - a zero-value transfer is left out.
 *
 * Real database (`docs/contributing/testing-strategy.md`): the assertion is
 * that the rows PERSIST, not that a filter returned true.
 */
import type { FastifyBaseLogger } from 'fastify'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import db from '../../../db.js'
import { explorerRowsToLegs, ingestInboundTransfers } from '../receive.js'
import type { RawERC20Transfer } from '../../../infra/explorer-api.js'

/** The registry's Base Sepolia USDC contract (core chains.ts, verbatim). */
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const CHAIN = 84532

const log = { warn: () => {} } as unknown as FastifyBaseLogger

let seq = 0

async function seedAccount(): Promise<{
  userId: string
  accountId: string
  address: string
}> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`rcv-char-${n}-${Date.now()}-${Math.random()}@test.example`],
  )
  const userId = user.rows[0].id
  const address = `0x${String(n).padStart(4, '0')}${'a'.repeat(36)}`
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, address, CHAIN],
  )
  return { userId, accountId: account.rows[0].id, address }
}

function leg(accountAddress: string, over: Partial<RawERC20Transfer> = {}): RawERC20Transfer {
  const n = ++seq
  return {
    blockNumber: String(4_000_000 + n),
    timeStamp: '1790534400',
    hash: `0x${String(n).padStart(4, '0')}${'f'.repeat(60)}`,
    from: `0x${String(n).padStart(4, '0')}${'b'.repeat(36)}`,
    to: accountAddress,
    value: '1000000',
    contractAddress: BASE_SEPOLIA_USDC,
    tokenName: 'USD Coin',
    tokenSymbol: 'USDC',
    tokenDecimal: '6',
    ...over,
  }
}

async function rowsFor(accountId: string) {
  const result = await db.query<{
    tx_hash: string
    log_index: number | null
    payer_address: string
    amount_raw: string
    sender_is_own_address: boolean
  }>(
    `SELECT tx_hash, log_index, payer_address, amount_raw, sender_is_own_address
       FROM inbound_transfers
      WHERE account_id = $1
      ORDER BY tx_hash, log_index NULLS FIRST`,
    [accountId],
  )
  return result.rows
}

describeDb('receive ingest characterization (#4903)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('indexes one row per inbound USDC leg, and nothing else (baseline)', async () => {
    const seeded = await seedAccount()
    const account = {
      id: seeded.accountId,
      userId: seeded.userId,
      accountAddress: seeded.address,
      chainId: CHAIN,
    }
    const stranger = `0x${'c'.repeat(40)}`

    const rows = [
      leg(seeded.address),
      // Outbound: not this index's business.
      leg(stranger, { from: seeded.address, to: stranger }),
      // A contract that merely names itself USDC is not the settlement asset.
      leg(seeded.address, { contractAddress: stranger, tokenSymbol: 'USDC' }),
    ]

    const inserted = await ingestInboundTransfers(account, explorerRowsToLegs(account, rows), log)

    expect(inserted).toBe(1)
    const persisted = await rowsFor(seeded.accountId)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.amount_raw).toBe('1000000')
  })

  it('is idempotent: a re-read of the same window inserts nothing (baseline)', async () => {
    const seeded = await seedAccount()
    const account = {
      id: seeded.accountId,
      userId: seeded.userId,
      accountAddress: seeded.address,
      chainId: CHAIN,
    }
    const rows = [leg(seeded.address), leg(seeded.address)]

    const first = await ingestInboundTransfers(account, explorerRowsToLegs(account, rows), log)
    const second = await ingestInboundTransfers(account, explorerRowsToLegs(account, rows), log)

    expect(first).toBe(2)
    expect(second).toBe(0)
    expect(await rowsFor(seeded.accountId)).toHaveLength(2)
  })

  it('lands one row per receiving account when one transaction pays two accounts (baseline)', async () => {
    const first = await seedAccount()
    const second = await seedAccount()
    const sharedHash = `0x${'9'.repeat(64)}`

    for (const seeded of [first, second]) {
      const account = {
        id: seeded.accountId,
        userId: seeded.userId,
        accountAddress: seeded.address,
        chainId: CHAIN,
      }
      await ingestInboundTransfers(
        account,
        explorerRowsToLegs(account, [leg(seeded.address, { hash: sharedHash })]),
        log,
      )
    }

    expect(await rowsFor(first.accountId)).toHaveLength(1)
    expect(await rowsFor(second.accountId)).toHaveLength(1)
  })

  it('CHANGE 1 — a transaction with several USDC transfers to the same account is counted in full', async () => {
    const seeded = await seedAccount()
    const account = {
      id: seeded.accountId,
      userId: seeded.userId,
      accountAddress: seeded.address,
      chainId: CHAIN,
    }
    const sharedHash = `0x${'7'.repeat(64)}`

    // Two legs of ONE transaction, both to this account. Before #4903 the
    // second hit ON CONFLICT DO NOTHING and was dropped.
    const rows = [
      leg(seeded.address, { hash: sharedHash, value: '1000000', logIndex: 2 }),
      leg(seeded.address, { hash: sharedHash, value: '2500000', logIndex: 5 }),
    ]

    const inserted = await ingestInboundTransfers(account, explorerRowsToLegs(account, rows), log)

    expect(inserted).toBe(2)
    const persisted = await rowsFor(seeded.accountId)
    expect(persisted).toHaveLength(2)
    expect(persisted.map((row) => row.log_index)).toEqual([2, 5])
    expect(persisted.map((row) => row.amount_raw)).toEqual(['1000000', '2500000'])
  })

  it('CHANGE 1 — two legs with no log index are still two rows (payer/amount identity)', async () => {
    const seeded = await seedAccount()
    const account = {
      id: seeded.accountId,
      userId: seeded.userId,
      accountAddress: seeded.address,
      chainId: CHAIN,
    }
    const sharedHash = `0x${'8'.repeat(64)}`

    const rows = [
      leg(seeded.address, { hash: sharedHash, value: '1000000' }),
      leg(seeded.address, { hash: sharedHash, value: '2500000' }),
    ]

    const inserted = await ingestInboundTransfers(account, explorerRowsToLegs(account, rows), log)

    expect(inserted).toBe(2)
    expect(await rowsFor(seeded.accountId)).toHaveLength(2)
  })

  it('CHANGE 2 — a zero-value transfer is left out', async () => {
    const seeded = await seedAccount()
    const account = {
      id: seeded.accountId,
      userId: seeded.userId,
      accountAddress: seeded.address,
      chainId: CHAIN,
    }

    const rows = [
      leg(seeded.address, { value: '0' }),
      leg(seeded.address, { value: '000' }),
      leg(seeded.address, { value: '1' }),
    ]

    const inserted = await ingestInboundTransfers(account, explorerRowsToLegs(account, rows), log)

    expect(inserted).toBe(1)
    const persisted = await rowsFor(seeded.accountId)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.amount_raw).toBe('1')
  })

  it('records whether the payer is one of the owner own addresses, at index time', async () => {
    const seeded = await seedAccount()
    // A second account the same user owns — the payer of one leg.
    const own = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
       VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
      [seeded.userId, `0x${'d'.repeat(40)}`, CHAIN],
    )
    expect(own.rows[0]!.id).toBeTruthy()

    const account = {
      id: seeded.accountId,
      userId: seeded.userId,
      accountAddress: seeded.address,
      chainId: CHAIN,
    }
    const rows = [
      leg(seeded.address, { from: `0x${'d'.repeat(40)}`, value: '1000000' }),
      leg(seeded.address, { from: `0x${'e'.repeat(40)}`, value: '2000000' }),
    ]

    await ingestInboundTransfers(account, explorerRowsToLegs(account, rows), log)

    const persisted = await rowsFor(seeded.accountId)
    const byAmount = new Map(persisted.map((row) => [row.amount_raw, row.sender_is_own_address]))
    expect(byAmount.get('1000000')).toBe(true)
    expect(byAmount.get('2000000')).toBe(false)
  })
})
