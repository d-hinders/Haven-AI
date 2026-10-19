/**
 * Real-DB tests for the owner-send record (#4099, migration 116).
 *
 * Everything here is an assertion about what Postgres does — the (chain,
 * hash, account) dedupe, the tenant-scoped read, case-folding — plus what the
 * enrichment step returns once a row exists, so it belongs on the real
 * harness rather than on mocks (epic #1219,
 * `docs/contributing/testing-strategy.md`).
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { findOwnerTransferMatches, recordOwnerTransfer } from '../owner-transfers.js'
import { enrichTransactionsWithAgents } from '../../../modules/transactions/enrichment.js'
import type { EnrichedTransaction } from '../../../modules/transactions/types.js'

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const CHAIN = 84532

let seq = 0

interface SeededAccount {
  userId: string
  accountId: string
  address: string
}

async function seedUser(): Promise<string> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`own${n}-${Date.now()}-${Math.random()}@test.example`],
  )
  return user.rows[0].id
}

async function seedAccount(userId: string): Promise<SeededAccount> {
  const n = ++seq
  const address = `0x${String(n).padStart(4, '0')}${'a'.repeat(36)}`
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, address, CHAIN],
  )
  return { userId, accountId: account.rows[0].id, address }
}

function hash(n: number): string {
  return `0x${String(n).padStart(4, '0')}${'F'.repeat(60)}`
}

function record(account: SeededAccount, txHash: string, chainId = CHAIN) {
  return recordOwnerTransfer({
    userId: account.userId,
    accountId: account.accountId,
    chainId,
    txHash,
    userOpHash: `0x${'E'.repeat(64)}`,
    tokenAddress: USDC,
    toAddress: `0x${'B'.repeat(40)}`,
    amountRaw: '1000000',
  })
}

/** An explorer row as aggregation tags it onto the account. */
function feedRow(account: SeededAccount, txHash: string, direction: 'in' | 'out'): EnrichedTransaction {
  return {
    hash: txHash,
    type: 'erc20',
    from: direction === 'out' ? account.address : `0x${'c'.repeat(40)}`,
    to: direction === 'out' ? `0x${'b'.repeat(40)}` : account.address,
    value: '1000000',
    valueFormatted: '1',
    asset: 'USDC',
    decimals: 6,
    direction,
    timestamp: 1_760_000_000,
    timestampSource: 'block',
    blockNumber: 1,
    isError: false,
    tokenAddress: USDC.toLowerCase(),
    tokenSymbol: 'USDC',
    chainId: CHAIN,
    accountId: account.accountId,
    accountAddress: account.address,
    accountName: 'My account',
  }
}

describeDb('owner_transfers record (#4099)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('persists the send lowercase, with what was sent', async () => {
    const account = await seedAccount(await seedUser())
    await record(account, hash(1))
    const { rows } = await db.query(
      `SELECT user_id, account_id, chain_id, tx_hash, user_op_hash, token_address, to_address, amount_raw
         FROM owner_transfers`,
    )
    expect(rows).toEqual([
      {
        user_id: account.userId,
        account_id: account.accountId,
        chain_id: CHAIN,
        tx_hash: hash(1).toLowerCase(),
        user_op_hash: `0x${'e'.repeat(64)}`,
        token_address: USDC.toLowerCase(),
        to_address: `0x${'b'.repeat(40)}`,
        amount_raw: '1000000',
      },
    ])
  })

  it('is idempotent per (chain, tx hash, account) — a retried record is not a second row', async () => {
    const account = await seedAccount(await seedUser())
    await record(account, hash(2))
    await record(account, hash(2).toLowerCase())
    const { rowCount } = await db.query(`SELECT id FROM owner_transfers`)
    expect(rowCount).toBe(1)
  })

  it('reads back only the caller’s own accounts — another tenant’s same-hash row never matches', async () => {
    const mine = await seedAccount(await seedUser())
    const theirs = await seedAccount(await seedUser())
    const shared = hash(3)
    await record(mine, shared)
    await record(theirs, shared)

    const matches = await findOwnerTransferMatches([shared.toLowerCase()], mine.userId, [mine.accountId, theirs.accountId])
    expect(matches).toEqual([
      {
        tx_hash: shared.toLowerCase(),
        account_id: mine.accountId,
        chain_id: CHAIN,
        token_address: USDC.toLowerCase(),
        to_address: `0x${'b'.repeat(40)}`,
        amount_raw: '1000000',
      },
    ])

    // Scoped by account id too: the user's own row on an account not asked for is not returned.
    expect(await findOwnerTransferMatches([shared.toLowerCase()], mine.userId, [theirs.accountId])).toEqual([])
  })

  it('an unlinked account takes its records with it', async () => {
    const account = await seedAccount(await seedUser())
    await record(account, hash(4))
    await db.query(`DELETE FROM smart_accounts WHERE id = $1`, [account.accountId])
    const { rowCount } = await db.query(`SELECT id FROM owner_transfers`)
    expect(rowCount).toBe(0)
  })

  it('enrichment returns a recorded send as initiatedBy=human, an unrecorded one as unknown', async () => {
    const userId = await seedUser()
    const sender = await seedAccount(userId)
    const reserve = await seedAccount(userId)
    await record(sender, hash(5))

    const enriched = await enrichTransactionsWithAgents(userId, [
      feedRow(sender, hash(5), 'out'),
      // An owner send from before the record existed: same shape, no row.
      feedRow(sender, hash(6), 'out'),
      // The receiving side of the recorded own-account transfer.
      feedRow(reserve, hash(5), 'in'),
      // Another outbound transfer in the SAME tx from the same account — an
      // agent redemption bundled beside the owner's UserOp. Not what the
      // owner sent, so not "You".
      { ...feedRow(sender, hash(5), 'out'), to: `0x${'d'.repeat(40)}`, value: '2500000' },
    ])
    expect(enriched.map((tx) => [tx.accountId, tx.hash, tx.to, tx.initiatedBy])).toEqual([
      [sender.accountId, hash(5), `0x${'b'.repeat(40)}`, 'human'],
      [sender.accountId, hash(6), `0x${'b'.repeat(40)}`, 'unknown'],
      [reserve.accountId, hash(5), reserve.address, undefined],
      [sender.accountId, hash(5), `0x${'d'.repeat(40)}`, 'unknown'],
    ])
  })
})
