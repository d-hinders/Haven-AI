/**
 * Real-DB test for #3307: the receipt's Haven-owned addresses are EIP-55
 * checksummed at its read boundary (`mapEvidence`), the same rule the
 * transactions feed applies since #3129 — while storage stays lowercase.
 *
 * `upsertEvidenceBase → listReceipts` end to end on the #1220 harness, zero
 * mocks. The addresses are LETTER-BEARING and written MIXED-CASE: a digit-only
 * address is unchanged by checksumming and would pass on the old code too.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { ethers } from 'ethers'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { upsertEvidenceBase } from '../../../infra/repositories/machine-payments.js'
import { listReceipts, mapEvidence } from '../evidence.js'

let seq = 0
/** A letter-bearing address written in a deliberately WRONG mixed case. */
const MIXED = (pair: string) => `0x${pair.repeat(20)}`
const MERCHANT = MIXED('aB')
const PAYER = MIXED('cD')
const SETTLEMENT = MIXED('eF')
const TOKEN = MIXED('Fa')
const DELEGATE = MIXED('bC')
const DELEGATE_ACCOUNT = MIXED('dE')
const checksum = (a: string) => ethers.getAddress(a.toLowerCase())

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`rcase-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'machine agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

async function seedIntent(agentId: string, userId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, payment_rail, machine_metadata)
     VALUES ($1, $2, $3, 'USDC', $4, $5, '100000', '0.10', $6, 1, $7,
             'confirmed', NOW() + interval '10 minutes', 'mpp', $8::jsonb)
     RETURNING id`,
    [
      agentId,
      userId,
      PAYER.toLowerCase(),
      TOKEN.toLowerCase(),
      SETTLEMENT.toLowerCase(),
      DELEGATE.toLowerCase(),
      `0x${String(++seq).padStart(64, 'a')}`.slice(0, 66),
      JSON.stringify({ settlement_scheme: 'eip3009', delegate_account_address: DELEGATE_ACCOUNT.toLowerCase() }),
    ],
  )
  return r.rows[0].id
}

describeDb('receipt addresses are checksummed at the read boundary, stored lowercase (#3307)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('listReceipts returns every Haven-owned address checksummed — top level and parties — while storage stays lowercase', async () => {
    const agent = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId)
    const txHash = `0x${'Ab'.repeat(32)}`

    await upsertEvidenceBase({
      paymentIntentId: intentId,
      approvalRequestId: null,
      agentId: agent.agentId,
      userId: agent.userId,
      rail: 'x402',
      txHash,
      chainId: 84532,
      resourceUrl: 'https://merchant.example/r',
      merchantAddress: MERCHANT,
      payerAddress: PAYER,
      settlementAddress: SETTLEMENT,
      tokenSymbol: 'USDC',
      tokenAddress: TOKEN,
      amountRaw: '100000',
      amountHuman: '0.10',
      challengeId: null,
      idempotencyKey: null,
      challengePayload: null,
      confirmedAt: null,
      amountSek: null,
      fxRateSek: null,
      fxSource: null,
      fxAt: null,
      fxRates: null,
    })

    const [receipt] = (await listReceipts(agent.agentId, 10))!.receipts
    // (b) the read boundary checksums.
    expect(receipt.merchant_address).toBe(checksum(MERCHANT))
    expect(receipt.payer_address).toBe(checksum(PAYER))
    expect(receipt.settlement_address).toBe(checksum(SETTLEMENT))
    expect(receipt.token_address).toBe(checksum(TOKEN))
    expect(receipt.parties).toEqual({
      treasury_account: checksum(PAYER),
      delegate: checksum(DELEGATE),
      delegate_account: checksum(DELEGATE_ACCOUNT),
      merchant: checksum(MERCHANT),
    })
    // A hash is not an address: it stays as stored (lowercase).
    expect(receipt.tx_hash).toBe(txHash.toLowerCase())

    // (c) storage is untouched — a write-side "fix" would turn this red.
    const raw = await db.query<Record<string, string>>(
      `SELECT merchant_address, payer_address, settlement_address, token_address
         FROM machine_payment_evidence WHERE payment_intent_id = $1`,
      [intentId],
    )
    expect(raw.rows[0]).toEqual({
      merchant_address: MERCHANT.toLowerCase(),
      payer_address: PAYER.toLowerCase(),
      settlement_address: SETTLEMENT.toLowerCase(),
      token_address: TOKEN.toLowerCase(),
    })
  })

  it('the POST /evidence echo shape (mapEvidence on a stored row) is checksummed too, and relayed merchant objects stay byte-for-byte', () => {
    const relayed = { payer: MERCHANT.toLowerCase(), transaction: `0x${'ab'.repeat(32)}` }
    const echo = mapEvidence({
      id: 'e1',
      payment_intent_id: 'p1',
      approval_request_id: null,
      rail: 'x402',
      proof_status: 'protocol_receipt_attached',
      tx_hash: `0x${'ab'.repeat(32)}`,
      chain_id: 84532,
      resource_url: 'https://merchant.example/r',
      merchant_address: MERCHANT.toLowerCase(),
      payer_address: PAYER.toLowerCase(),
      settlement_address: SETTLEMENT.toLowerCase(),
      token_symbol: 'USDC',
      token_address: TOKEN.toLowerCase(),
      amount_raw: '100000',
      amount_human: '0.10',
      challenge_payload: { payTo: MERCHANT.toLowerCase() },
      selected_payment: { payTo: MERCHANT.toLowerCase() },
      protocol_receipt_payload: relayed,
      intent_delegate_address: DELEGATE.toLowerCase(),
      intent_delegate_account_address: null,
    } as never)
    expect(echo.merchant_address).toBe(checksum(MERCHANT))
    expect(echo.token_address).toBe(checksum(TOKEN))
    expect(echo.parties.delegate).toBe(checksum(DELEGATE))
    expect(echo.parties.delegate_account).toBeNull()
    // #3125: the merchant's objects are relayed verbatim — never re-cased.
    expect(echo.protocol_receipt_payload).toEqual(relayed)
    expect(echo.challenge_payload).toEqual({ payTo: MERCHANT.toLowerCase() })
    expect(echo.selected_payment).toEqual({ payTo: MERCHANT.toLowerCase() })
  })
})
