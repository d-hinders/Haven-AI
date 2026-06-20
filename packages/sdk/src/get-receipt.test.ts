import { afterEach, describe, expect, it, vi } from 'vitest'
import { Wallet } from 'ethers'
import { HavenClient } from './client.js'
import { RECEIPT_VERSION, type PaymentReceipt } from './receipt.js'

const baseUrl = 'https://haven.example'
const DELEGATE = new Wallet(`0x${'11'.repeat(32)}`)
const SIGN_HASH = `0x${'ab'.repeat(32)}`

function receipt(signature: string | null): PaymentReceipt {
  return {
    version: RECEIPT_VERSION,
    paymentId: 'pi1',
    payment: {
      token: 'USDC', tokenAddress: '0xtok', amount: '1', amountSek: '10.60',
      recipient: '0xmerchant', safe: '0xsafe', chainId: 8453,
      settledAt: '2026-06-20T10:00:00.000Z', resourceUrl: 'https://api.example/r',
    },
    authorization: { delegate: DELEGATE.address, signHash: SIGN_HASH, signature },
    onChain: { txHash: '0xabc', chainId: 8453 },
  }
}

describe('client.getReceipt — verifies locally, not trusting the server', () => {
  afterEach(() => vi.restoreAllMocks())

  it('fetches the bundle and verifies it independently', async () => {
    const signature = DELEGATE.signingKey.sign(SIGN_HASH).serialized
    // Server claims verified:false, but the client re-verifies locally and wins.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ receipt: receipt(signature), verification: { verified: false } })),
    )
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const { verification } = await haven.getReceipt('pi1')
    expect(verification.verified).toBe(true)
  })

  it('reports unverified when the receipt has no signature', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ receipt: receipt(null) })),
    )
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const { verification } = await haven.getReceipt('pi1')
    expect(verification.verified).toBe(false)
  })
})
