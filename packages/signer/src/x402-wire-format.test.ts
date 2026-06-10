/**
 * EIP-3009 + EIP-712 wire-format invariant tests for the edge signer (#323).
 *
 * The SDK's signing path is covered by `packages/sdk/src/x402-signing.test.ts`;
 * this file exercises the *same invariants* against the edge signer's
 * `buildX402PaymentHeader` so the two signing paths cannot silently diverge.
 * Both ultimately call `exact.evm.createPaymentHeader` from the x402 library,
 * but they wrap it independently — a divergence in either wrapper (option
 * selection, header re-encoding, asset normalization) would break exactly one
 * path and these tests localize which.
 *
 * See the SDK test file's header comment for why each invariant matters.
 * Do not weaken these assertions to permissive matchers.
 */
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress } from 'viem'
import { buildX402ExpectedMessage } from '@haven_ai/sdk'
import { createEdgeSigner } from './core.js'

// Well-known test keys (Hardhat accounts). Never used for real funds.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address
const FUNDING_HASH = '0x' + 'cd'.repeat(32)

// Base USDC, verbatim checksummed — EIP-712 hashes are byte-sensitive.
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const ACCEPTED = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: BASE_USDC,
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}

const PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: 'https://merchant.test/paid', description: 'wire-format fixture' },
  accepts: [ACCEPTED],
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

const BASE_USDC_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: BASE_USDC as `0x${string}`,
}

interface DecodedHeader {
  x402Version: number
  accepted: typeof ACCEPTED
  payload: {
    signature: `0x${string}`
    authorization: {
      from: `0x${string}`
      to: `0x${string}`
      value: string
      validAfter: string
      validBefore: string
      nonce: `0x${string}`
    }
  }
}

function decodeHeader(header: string): DecodedHeader {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as DecodedHeader
}

async function expectedX402() {
  const context = {
    paymentId: 'pay_x402_wire',
    payloadHash: FUNDING_HASH,
    resourceUrl: PAYMENT_REQUIRED.resource.url,
    merchantTo: ACCEPTED.payTo,
    amount: ACCEPTED.amount,
    asset: ACCEPTED.asset,
    network: ACCEPTED.network,
  }
  const message = buildX402ExpectedMessage(context)
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    ...context,
    auth: {
      version: 1 as const,
      message,
      signature: await account.signMessage({ message }),
      signer: account.address,
    },
  }
}

async function buildHeader(): Promise<{ header: DecodedHeader; delegateAddress: string }> {
  const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
  const funding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402())
  const result = await signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding)
  return { header: decodeHeader(result.paymentHeader), delegateAddress: signer.delegateAddress }
}

function recover(
  header: DecodedHeader,
  domain: typeof BASE_USDC_DOMAIN = BASE_USDC_DOMAIN,
): Promise<`0x${string}`> {
  const auth = header.payload.authorization
  return recoverTypedDataAddress({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature: header.payload.signature,
  })
}

describe('edge signer EIP-3009 authorization fields', () => {
  it('carries exact from/to/value matching the delegate and the accepted option', async () => {
    const { header, delegateAddress } = await buildHeader()
    const auth = header.payload.authorization

    expect(auth.from.toLowerCase()).toBe(delegateAddress.toLowerCase())
    expect(auth.to).toBe(ACCEPTED.payTo)
    expect(auth.value).toBe(ACCEPTED.amount)
    expect(typeof auth.value).toBe('string')
  })

  it('sets a sane validAfter/validBefore window', async () => {
    const before = Math.floor(Date.now() / 1000)
    const { header } = await buildHeader()
    const after = Math.floor(Date.now() / 1000)
    const auth = header.payload.authorization

    const validAfter = Number(auth.validAfter)
    const validBefore = Number(auth.validBefore)

    expect(validAfter).toBeLessThanOrEqual(after + 60)
    expect(validBefore).toBeGreaterThan(before)
    expect(validBefore).toBeLessThanOrEqual(after + ACCEPTED.maxTimeoutSeconds + 60)
  })

  it('uses a fresh 32-byte hex nonce per signing', async () => {
    const first = await buildHeader()
    const second = await buildHeader()

    expect(first.header.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(first.header.payload.authorization.nonce).not.toBe(
      second.header.payload.authorization.nonce,
    )
  })
})

describe('edge signer EIP-712 signature recovery', () => {
  it('recovers to the delegate address under the Base USDC domain', async () => {
    const { header, delegateAddress } = await buildHeader()
    const recovered = await recover(header)

    expect(recovered.toLowerCase()).toBe(delegateAddress.toLowerCase())
    expect(recovered.toLowerCase()).toBe(header.payload.authorization.from.toLowerCase())
  })

  it('does not recover to the delegate under a wrong-chain domain', async () => {
    const { header, delegateAddress } = await buildHeader()
    const recovered = await recover(header, { ...BASE_USDC_DOMAIN, chainId: 1 })
    expect(recovered.toLowerCase()).not.toBe(delegateAddress.toLowerCase())
  })

  it('does not recover to the delegate under a wrong verifyingContract', async () => {
    const { header, delegateAddress } = await buildHeader()
    const recovered = await recover(header, {
      ...BASE_USDC_DOMAIN,
      verifyingContract: '0x0000000000000000000000000000000000000001',
    })
    expect(recovered.toLowerCase()).not.toBe(delegateAddress.toLowerCase())
  })
})

describe('edge signer asset address byte-sensitivity', () => {
  it('echoes the accepted asset address verbatim (checksummed, not lowercased)', async () => {
    const { header } = await buildHeader()
    expect(header.accepted.asset).toBe(BASE_USDC)
  })
})
