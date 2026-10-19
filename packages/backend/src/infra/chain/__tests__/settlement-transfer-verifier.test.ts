/**
 * #4061 review (should-fix 1) — check 9 PAIRS the burned authorization with
 * its own `Transfer`.
 *
 * FiatToken v2's `_transferWithAuthorization` / `_receiveWithAuthorization`
 * call `_markAuthorizationAsUsed` (emits `AuthorizationUsed`) and then
 * `_transfer` (emits `Transfer`). So an authorization's Transfer is the log
 * immediately after its `AuthorizationUsed`, from the same token contract.
 * The first block pins that order against a REAL receipt — the live Base
 * Sepolia settlement the #4061 report was about — so the pairing rule is
 * measured, not assumed. The second proves what the pairing buys: a
 * transaction settling two of the delegate's authorizations cannot lend one
 * nonce the other's transfer.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { ethers } from 'ethers'
import { deriveX402PaymentNonce } from '@haven_ai/sdk/edge'

const getTransactionReceipt = vi.fn()
const getBlock = vi.fn()

vi.mock('../relayer-reads.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../relayer-reads.js')>()),
  getProvider: () => ({ getTransactionReceipt, getBlock }),
}))

import { verifySettlementTransferTx, type ExpectedSettlementTransfer } from '../settlement-transfer-verifier.js'

type FixtureLog = { address: string; topics: string[]; data: string; index: number }
const LIVE = JSON.parse(
  readFileSync(new URL('./fixtures/base-sepolia-eip3009-settlement-receipt.json', import.meta.url), 'utf8'),
) as { transactionHash: string; status: number; blockNumber: number; blockTimestamp: number; logs: FixtureLog[] }

/**
 * The nonce the live settlement burned: the one in the X-PAYMENT header the
 * agent sent (the #4061 dev run, payment 0d8099b4-…). It is NOT
 * `deriveX402PaymentNonce(payment id)` — that run's header carried a random
 * nonce — so the passive sweep cannot find this settlement, and a reported
 * header is the only way it can be attributed.
 */
const LIVE_NONCE = '0x0e2679d968658e8a963133464e4206e17f4f65e09f9a7a32aa0e1d124dd2045c'
const LIVE_PAYMENT_ID = '0d8099b4-dc9a-4f17-8358-03fdc9695bfd'
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' // Base Sepolia USDC
const LIVE_DELEGATE = ethers.getAddress('0xcb9a47e0d4784b0cdf0d3cda0447dbbca3465ba8')
const LIVE_MERCHANT = ethers.getAddress('0x041597826b16425ef835601abf1628b80b37b195')

const AUTHORIZATION_USED_TOPIC = ethers.id('AuthorizationUsed(address,bytes32)')
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

function expectedFor(overrides: Partial<ExpectedSettlementTransfer> = {}): ExpectedSettlementTransfer {
  return {
    chainId: 84532,
    notBeforeSec: LIVE.blockTimestamp - 60,
    notAfterSec: LIVE.blockTimestamp + 60,
    tokenAddress: TOKEN,
    fromAddress: LIVE_DELEGATE,
    toAddress: LIVE_MERCHANT,
    amountRaw: '1000',
    expectedAuthorizationUsed: { authorizer: LIVE_DELEGATE, nonce: LIVE_NONCE },
    ...overrides,
  }
}

function serve(logs: FixtureLog[]) {
  getTransactionReceipt.mockResolvedValue({ status: 1, blockNumber: LIVE.blockNumber, logs })
  getBlock.mockResolvedValue({ number: LIVE.blockNumber, timestamp: LIVE.blockTimestamp })
}

const word = (hex: string) => ethers.zeroPadValue(hex, 32)
function authorizationUsed(authorizer: string, nonce: string, index: number): FixtureLog {
  return { address: TOKEN, topics: [AUTHORIZATION_USED_TOPIC, word(authorizer), nonce], data: '0x', index }
}
function transfer(from: string, to: string, value: bigint, index: number): FixtureLog {
  return {
    address: TOKEN,
    topics: [TRANSFER_TOPIC, word(from), word(to)],
    data: ethers.zeroPadValue(ethers.toBeHex(value), 32),
    index,
  }
}

describe('check 9 pairs AuthorizationUsed with its own Transfer (#4061 review)', () => {
  describe('the live Base Sepolia settlement receipt', () => {
    it('emits AuthorizationUsed, then its Transfer, consecutively from the token — the order the pairing relies on', () => {
      expect(LIVE.status).toBe(1)
      const [used, moved] = LIVE.logs
      expect(LIVE.logs).toHaveLength(2)
      expect(used!.topics[0]).toBe(AUTHORIZATION_USED_TOPIC)
      expect(moved!.topics[0]).toBe(TRANSFER_TOPIC)
      expect(moved!.index).toBe(used!.index + 1)
      expect(used!.address.toLowerCase()).toBe(TOKEN.toLowerCase())
      expect(moved!.address.toLowerCase()).toBe(TOKEN.toLowerCase())
      // The header's nonce — and not the payment-id-derived one (see LIVE_NONCE).
      expect(used!.topics[2]).toBe(LIVE_NONCE)
      expect(used!.topics[2]).not.toBe(deriveX402PaymentNonce(LIVE_PAYMENT_ID).toLowerCase())
    })

    it('verifies, nonce-bound, against its own payment', async () => {
      serve(LIVE.logs)
      await expect(verifySettlementTransferTx(LIVE.transactionHash, expectedFor())).resolves.toMatchObject({
        outcome: 'verified',
        nonceBound: true,
      })
    })

    it('is refused when the same logs arrive in the other order — the pairing reads the log AFTER the burn', async () => {
      serve([{ ...LIVE.logs[1]!, index: 37 }, { ...LIVE.logs[0]!, index: 38 }])
      const verdict = await verifySettlementTransferTx(LIVE.transactionHash, expectedFor())
      expect(verdict.outcome).toBe('mismatch')
      expect((verdict as { reason: string }).reason).toMatch(/cannot be identified/)
    })
  })

  describe('one transaction settling two of the delegate’s authorizations', () => {
    const NONCE_MINE = `0x${'11'.repeat(32)}`
    const NONCE_OTHER = `0x${'22'.repeat(32)}`
    const ELSEWHERE = ethers.getAddress(`0x${'ee'.repeat(20)}`)
    const expectedMine = () =>
      expectedFor({ expectedAuthorizationUsed: { authorizer: LIVE_DELEGATE, nonce: NONCE_MINE } })

    it('refuses a nonce whose own transfer went elsewhere, even though the OTHER authorization paid this merchant this amount', async () => {
      serve([
        authorizationUsed(LIVE_DELEGATE, NONCE_MINE, 0),
        transfer(LIVE_DELEGATE, ELSEWHERE, 1000n, 1),
        authorizationUsed(LIVE_DELEGATE, NONCE_OTHER, 2),
        transfer(LIVE_DELEGATE, LIVE_MERCHANT, 1000n, 3),
      ])
      const verdict = await verifySettlementTransferTx(LIVE.transactionHash, expectedMine())
      expect(verdict.outcome).toBe('mismatch')
      expect((verdict as { reason: string }).reason).toMatch(/that authorization's own Transfer/)
    })

    it('verifies the nonce whose own transfer is the delegate → merchant payment', async () => {
      serve([
        authorizationUsed(LIVE_DELEGATE, NONCE_OTHER, 0),
        transfer(LIVE_DELEGATE, ELSEWHERE, 1000n, 1),
        authorizationUsed(LIVE_DELEGATE, NONCE_MINE, 2),
        transfer(LIVE_DELEGATE, LIVE_MERCHANT, 1000n, 3),
      ])
      await expect(verifySettlementTransferTx(LIVE.transactionHash, expectedMine())).resolves.toMatchObject({
        outcome: 'verified',
        nonceBound: true,
      })
    })

    it('refuses a pair whose log indices are not consecutive (something sat between them)', async () => {
      serve([authorizationUsed(LIVE_DELEGATE, NONCE_MINE, 0), transfer(LIVE_DELEGATE, LIVE_MERCHANT, 1000n, 2)])
      const verdict = await verifySettlementTransferTx(LIVE.transactionHash, expectedMine())
      expect(verdict.outcome).toBe('mismatch')
    })

    it('without an expected authorization (no check 9), any matching Transfer still verifies — unchanged', async () => {
      serve([transfer(LIVE_DELEGATE, LIVE_MERCHANT, 1000n, 0)])
      await expect(
        verifySettlementTransferTx(LIVE.transactionHash, expectedFor({ expectedAuthorizationUsed: undefined })),
      ).resolves.toMatchObject({ outcome: 'verified' })
    })
  })
})
