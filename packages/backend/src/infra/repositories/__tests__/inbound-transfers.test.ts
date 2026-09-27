/**
 * Real-DB tests for the persisted inbound-transfer index (#3333, epic #3328).
 *
 * Everything here is an assertion about what Postgres does — the unique
 * (chain, hash, account) dedupe, the one-way match, the balance-consumed flag — so it
 * belongs on the real harness rather than on mocks (epic #1219,
 * `docs/contributing/testing-strategy.md`). The ingest pass and the matcher
 * both sit on top of these invariants; a module bug can route around them,
 * it cannot route around the index.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  insertInboundTransfer,
  findUnmatchedByTxHash,
  findUnmatchedInboundTransfers,
  matchInboundTransfer,
  markInboundTransferBalanceConsumed,
  inboundReceiveBalanceAtomic,
  listInboundTransfers,
} from '../inbound-transfers.js'
import { matchInboundTransferForAccount } from '../../../modules/transactions/receive.js'

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

let seq = 0

interface SeededAccount {
  userId: string
  accountId: string
  address: string
}

async function seedAccount(chainId = 8453): Promise<SeededAccount> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`rcv${n}-${Date.now()}-${Math.random()}@test.example`],
  )
  const userId = user.rows[0].id
  const address = `0x${String(n).padStart(4, '0')}${'a'.repeat(36)}`
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, address, chainId],
  )
  return { userId, accountId: account.rows[0].id, address }
}

function ingestInput(seeded: SeededAccount, over: Partial<Parameters<typeof insertInboundTransfer>[0]> = {}) {
  const n = ++seq
  return {
    accountId: seeded.accountId,
    userId: seeded.userId,
    chainId: 8453,
    txHash: `0x${String(n).padStart(4, '0')}${'f'.repeat(60)}`,
    payerAddress: `0x${String(n).padStart(4, '0')}${'b'.repeat(36)}`,
    tokenAddress: USDC,
    amountRaw: '1000000',
    blockTime: new Date('2026-09-27T10:00:00Z'),
    ...over,
  }
}

describeDb('inbound_transfers index (#3333)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('ingests an inbound USDC transfer with payer, amount, hash and block time', async () => {
    const seeded = await seedAccount()
    const id = await insertInboundTransfer(ingestInput(seeded))
    expect(id).not.toBeNull()
  })

  it('is idempotent per (chain, tx hash, account) — a re-read explorer window cannot double-count', async () => {
    const seeded = await seedAccount()
    const input = ingestInput(seeded)
    const first = await insertInboundTransfer(input)
    const second = await insertInboundTransfer(input)
    expect(first).not.toBeNull()
    expect(second).toBeNull()

    const rows = await db.query(`SELECT id FROM inbound_transfers WHERE account_id = $1`, [seeded.accountId])
    expect(rows.rowCount).toBe(1)
  })

  it('one tx paying two accounts yields one row per account, each matchable independently (round-2 F-2)', async () => {
    const first = await seedAccount()
    const second = await seedAccount()
    const sharedHash = `0x${'d'.repeat(64)}`

    const firstRow = (await insertInboundTransfer(ingestInput(first, { txHash: sharedHash })))!
    const secondRow = (await insertInboundTransfer(ingestInput(second, { txHash: sharedHash })))!
    expect(firstRow).not.toBeNull()
    expect(secondRow).not.toBeNull()

    // A re-read of the same explorer window duplicates nothing for either account.
    expect(await insertInboundTransfer(ingestInput(first, { txHash: sharedHash }))).toBeNull()
    expect(await insertInboundTransfer(ingestInput(second, { txHash: sharedHash }))).toBeNull()

    const rows = await db.query<{ account_id: string }>(
      `SELECT account_id FROM inbound_transfers WHERE LOWER(tx_hash) = LOWER($1)`,
      [sharedHash],
    )
    expect(rows.rowCount).toBe(2)
    expect(new Set(rows.rows.map((r) => r.account_id))).toEqual(new Set([first.accountId, second.accountId]))

    // Each leg is matchable independently — the second account's drop for the
    // shared hash lands on ITS row, never on the other account's.
    const forSecond = await matchInboundTransferForAccount({
      accountId: second.accountId,
      userId: second.userId,
      accountAddress: second.address,
      txHash: sharedHash,
      receiptId: '44444444-4444-4444-8444-444444444444',
    })
    expect(forSecond).toEqual({ ok: true, matchKind: 'receipt', transferId: secondRow })

    // The first account's row is untouched by the second account's match.
    const firstRows = await db.query<{ match_kind: string | null }>(
      `SELECT match_kind FROM inbound_transfers WHERE account_id = $1`,
      [first.accountId],
    )
    expect(firstRows.rows[0].match_kind).toBeNull()
  })

  it('matches by hash case-insensitively and lowercases stored addresses', async () => {
    const seeded = await seedAccount()
    const input = ingestInput(seeded, { txHash: `0x${'AB'.repeat(32)}`, payerAddress: '0xABCDEF0000000000000000000000000000000001' })
    await insertInboundTransfer(input)

    const row = await findUnmatchedByTxHash(seeded.accountId, seeded.userId, input.txHash.toLowerCase())
    expect(row).not.toBeNull()
    expect(row?.payer_address).toBe('0xabcdef0000000000000000000000000000000001')
  })

  it('findUnmatchedByTxHash pins the payer when asked — a drop cannot land on another payer', async () => {
    const seeded = await seedAccount()
    const payerA = `0x${'1'.repeat(40)}`
    // The (chain, hash, account) unique index keeps ONE row per account, and
    // the drop path pins the payer WITHIN an account's rows: a drop for
    // another payer of the same hash finds nothing to link rather than
    // linking the wrong leg. (A second receiving ACCOUNT of the same tx gets
    // its own row — the two-account test below.)
    const sharedHash = `0x${'9'.repeat(64)}`
    await insertInboundTransfer(ingestInput(seeded, { txHash: sharedHash, payerAddress: payerA }))

    const forA = await findUnmatchedByTxHash(seeded.accountId, seeded.userId, sharedHash, payerA)
    expect(forA?.payer_address).toBe(payerA)
    const forB = await findUnmatchedByTxHash(seeded.accountId, seeded.userId, sharedHash, `0x${'2'.repeat(40)}`)
    expect(forB).toBeNull()
    // Unpinned (the owner path) still finds it.
    const unpinned = await findUnmatchedByTxHash(seeded.accountId, seeded.userId, sharedHash)
    expect(unpinned?.payer_address).toBe(payerA)
  })

  it('the match is one-way: a set match is never overwritten, a racing second matcher loses', async () => {
    const seeded = await seedAccount()
    const id = (await insertInboundTransfer(ingestInput(seeded)))!

    const first = await matchInboundTransfer({
      transferId: id,
      userId: seeded.userId,
      matchKind: 'receipt',
      matchedReceiptId: '11111111-1111-4111-8111-111111111111',
      matchedPaymentIntentId: null,
    })
    expect(first).toBe(true)

    const second = await matchInboundTransfer({
      transferId: id,
      userId: seeded.userId,
      matchKind: 'x402_payto',
      matchedReceiptId: null,
      matchedPaymentIntentId: '22222222-2222-4222-8222-222222222222',
    })
    expect(second).toBe(false)

    const rows = await db.query<{ match_kind: string; matched_receipt_id: string | null; matched_payment_intent_id: string | null }>(
      `SELECT match_kind, matched_receipt_id, matched_payment_intent_id FROM inbound_transfers WHERE id = $1`,
      [id],
    )
    expect(rows.rows[0].match_kind).toBe('receipt')
    expect(rows.rows[0].matched_payment_intent_id).toBeNull()
  })

  it('balance-consumed marking is one-way and user-scoped', async () => {
    const seeded = await seedAccount()
    const other = await seedAccount()
    const id = (await insertInboundTransfer(ingestInput(seeded)))!

    expect(await markInboundTransferBalanceConsumed(id, other.userId)).toBe(false)
    expect(await markInboundTransferBalanceConsumed(id, seeded.userId)).toBe(true)
    expect(await markInboundTransferBalanceConsumed(id, seeded.userId)).toBe(false)
  })

  it('the receive balance sums only consumed (matched) rows and is user-scoped', async () => {
    const seeded = await seedAccount()
    const other = await seedAccount()
    const consumed = (await insertInboundTransfer(ingestInput(seeded, { amountRaw: '2500000' })))!
    const unconsumed = (await insertInboundTransfer(ingestInput(seeded, { amountRaw: '99000000' })))!
    await insertInboundTransfer(ingestInput(other, { amountRaw: '77000000' }))

    // Unmatched = unearned: nothing counts until the match lands.
    expect(await inboundReceiveBalanceAtomic(seeded.accountId, seeded.userId)).toBe('0')

    await markInboundTransferBalanceConsumed(consumed, seeded.userId)
    expect(await inboundReceiveBalanceAtomic(seeded.accountId, seeded.userId)).toBe('2500000')

    // The unconsumed row stays out of the sum even after the sibling is matched.
    const row = await db.query<{ balance_consumed: boolean }>(
      `SELECT balance_consumed FROM inbound_transfers WHERE id = $1`,
      [unconsumed],
    )
    expect(row.rows[0].balance_consumed).toBe(false)

    // Another owner reads zero against this account.
    expect(await inboundReceiveBalanceAtomic(seeded.accountId, other.userId)).toBe('0')
  })

  it('the unmatched worklist and the ledger are user-scoped and ordered newest first', async () => {
    const seeded = await seedAccount()
    const other = await seedAccount()
    await insertInboundTransfer(ingestInput(seeded, { blockTime: new Date('2026-09-25T10:00:00Z') }))
    await insertInboundTransfer(ingestInput(seeded, { blockTime: new Date('2026-09-27T10:00:00Z') }))
    await insertInboundTransfer(ingestInput(other))

    const unmatched = await findUnmatchedInboundTransfers(seeded.accountId, seeded.userId)
    expect(unmatched).toHaveLength(2)
    expect(unmatched[0].block_time.getTime()).toBeGreaterThan(unmatched[1].block_time.getTime())

    const ledger = await listInboundTransfers(seeded.accountId, seeded.userId, 100)
    expect(ledger).toHaveLength(2)
    expect(ledger[0].block_time.getTime()).toBeGreaterThan(ledger[1].block_time.getTime())
  })

  // ── The matcher (#3333 matching, on real SQL) ──────────────────────────────

  async function seedX402Settlement(input: {
    payerUserId: string
    payerAccountId: string
    payToAddress: string
    chainId: number
    txHash: string
  }): Promise<string> {
    const n = ++seq
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
       VALUES ($1, $2, 'Payer agent', $3, $4, $5, 'active') RETURNING id`,
      [input.payerUserId, input.payerAccountId, `0x${'d'.repeat(40)}`, `hash-x402-${n}`, 'sk_agent_payer'.slice(0, 12)],
    )
    const intent = await db.query<{ id: string }>(
      `INSERT INTO payment_intents
         (agent_id, user_id, account_address, chain_id, token_symbol, token_address, to_address,
          amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash, source,
          x402_merchant_address, tx_hash, status, confirmed_at, expires_at)
       VALUES ($1, $2, $3, $4, 'USDC', $5, $6, '1000000', '1.00', $3, 0, $7, 'x402', $6, $8, 'confirmed', NOW(), NOW() + interval '1 hour')
       RETURNING id`,
      [
        agent.rows[0].id,
        input.payerUserId,
        `0x${'e'.repeat(40)}`,
        input.chainId,
        USDC,
        input.payToAddress.toLowerCase(),
        `0x${'s'.repeat(64)}`,
        input.txHash,
      ],
    )
    return intent.rows[0].id
  }

  it('matchInboundTransferForAccount links the receipt, refuses an amount mismatch, and earns the row', async () => {
    const seeded = await seedAccount()
    const txHash = `0x${'7'.repeat(64)}`
    await insertInboundTransfer(ingestInput(seeded, { txHash, amountRaw: '1000000', payerAddress: '0x' + 'b'.repeat(40) }))

    // No settlement names this hash and no receipt supplied — nothing to match.
    const nothing = await matchInboundTransferForAccount({
      accountId: seeded.accountId,
      userId: seeded.userId,
      accountAddress: seeded.address,
      txHash,
    })
    expect(nothing).toEqual({ ok: false, failure: { status: 404, error: 'Nothing to match against — supply a receipt the transfer was paid for' } })

    // A mismatching document is refused BEFORE any link is written.
    const mismatch = await matchInboundTransferForAccount({
      accountId: seeded.accountId,
      userId: seeded.userId,
      accountAddress: seeded.address,
      txHash,
      receiptId: '44444444-4444-4444-8444-444444444444',
      expectedAmountRaw: '999',
    })
    expect(mismatch.ok).toBe(false)
    const failure = (mismatch as { failure: { status: 404 | 409; error: string } }).failure
    expect(failure.status).toBe(409)
    expect(failure.error).toMatch(/amount mismatch/)

    const ok = await matchInboundTransferForAccount({
      accountId: seeded.accountId,
      userId: seeded.userId,
      accountAddress: seeded.address,
      txHash,
      receiptId: '44444444-4444-4444-8444-444444444444',
      expectedAmountRaw: '1000000',
    })
    expect(ok).toEqual({ ok: true, matchKind: 'receipt', transferId: expect.any(String) })

    // Earned: the balance now counts the row; a second drop finds nothing to match.
    expect(await inboundReceiveBalanceAtomic(seeded.accountId, seeded.userId)).toBe('1000000')
    const again = await matchInboundTransferForAccount({
      accountId: seeded.accountId,
      userId: seeded.userId,
      accountAddress: seeded.address,
      txHash,
      receiptId: '44444444-4444-4444-8444-444444444444',
      expectedAmountRaw: '1000000',
    })
    expect(again.ok).toBe(false)
  })

  it('matchInboundTransferForAccount links an x402 settlement the account was payTo for — cross-user by construction', async () => {
    // The payer is a DIFFERENT user with their own account and agent; the
    // settlement intent belongs to THEM. The receiving account was payTo.
    const payer = await seedAccount()
    const receiver = await seedAccount()
    const txHash = `0x${'8'.repeat(64)}`
    const intentId = await seedX402Settlement({
      payerUserId: payer.userId,
      payerAccountId: payer.accountId,
      payToAddress: receiver.address,
      chainId: 8453,
      txHash,
    })
    await insertInboundTransfer(ingestInput(receiver, { txHash, amountRaw: '1000000' }))

    const result = await matchInboundTransferForAccount({
      accountId: receiver.accountId,
      userId: receiver.userId,
      accountAddress: receiver.address,
      txHash,
    })
    expect(result).toEqual({ ok: true, matchKind: 'x402_payto', transferId: expect.any(String) })

    const rows = await db.query<{ matched_payment_intent_id: string; balance_consumed: boolean }>(
      `SELECT matched_payment_intent_id, balance_consumed FROM inbound_transfers WHERE account_id = $1`,
      [receiver.accountId],
    )
    expect(rows.rows[0].matched_payment_intent_id).toBe(intentId)
    expect(rows.rows[0].balance_consumed).toBe(true)
    expect(await inboundReceiveBalanceAtomic(receiver.accountId, receiver.userId)).toBe('1000000')
  })

  it('matchInboundTransferForAccount refuses a settlement whose payTo is a DIFFERENT account', async () => {
    const payer = await seedAccount()
    const receiver = await seedAccount()
    const otherAddress = `0x${('f'.repeat(39))}1`
    const txHash = `0x${'6'.repeat(64)}`
    await seedX402Settlement({
      payerUserId: payer.userId,
      payerAccountId: payer.accountId,
      payToAddress: otherAddress,
      chainId: 8453,
      txHash,
    })
    await insertInboundTransfer(ingestInput(receiver, { txHash }))

    const result = await matchInboundTransferForAccount({
      accountId: receiver.accountId,
      userId: receiver.userId,
      accountAddress: receiver.address,
      txHash,
    })
    // No settlement names THIS account and no receipt came with the call.
    expect(result).toEqual({ ok: false, failure: { status: 404, error: 'Nothing to match against — supply a receipt the transfer was paid for' } })
  })
})
