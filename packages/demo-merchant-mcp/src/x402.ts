import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  parseSignature,
  verifyTypedData,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http'
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types'
import { USDC_ADDRESS, CHAIN_ID, USDC_DOMAIN_NAME, USDC_DOMAIN_VERSION } from './products.js'
import type { ProductId } from './products.js'

export { USDC_ADDRESS }

const NETWORK: `${string}:${string}` = `eip155:${CHAIN_ID}`
const MAX_TIMEOUT_SECONDS = 300
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/

export const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED'
export const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE'
export const LEGACY_PAYMENT_SIGNATURE_HEADER = 'X-PAYMENT'
export const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE'

const TRANSFER_WITH_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

const USDC_DOMAIN = {
  name: USDC_DOMAIN_NAME,
  version: USDC_DOMAIN_VERSION,
  chainId: CHAIN_ID,
  verifyingContract: USDC_ADDRESS,
} as const

const USDC_TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const

export interface Eip3009Authorization {
  from: string
  to: string
  value: string
  validAfter: string
  validBefore: string
  nonce: string
}

export interface SettledPayment {
  productId: ProductId
  from: Address
  to: Address
  value: bigint
  nonce: Hex
  txHash: Hex
  paymentResponse: SettleResponse
  paymentResponseHeader: string
}

export interface SettlementClient {
  submit(authorization: Eip3009Authorization, signature: Hex): Promise<Hex>
  waitForReceipt(txHash: Hex): Promise<void>
}

export interface X402PaymentProcessor {
  buildPaymentRequired(params: {
    merchantAddress: Address
    amountUsdc: bigint
    resource: string
    description: string
  }): PaymentRequired
  paymentRequiredHeader(paymentRequired: PaymentRequired): string
  paymentResponseHeader(response: SettleResponse): string
  verifyAndSettle(params: {
    productId: ProductId
    paymentHeader: string
    merchantAddress: Address
    expectedAmount: bigint
    paymentRequired: PaymentRequired
  }): Promise<SettledPayment>
}

interface SettledCacheEntry {
  productId: ProductId
  payment: SettledPayment
}

interface SettlementAttempt {
  productId: ProductId
  txHash?: Hex
  promise?: Promise<SettledCacheEntry>
}

export function createX402PaymentProcessor(settlementClient: SettlementClient): X402PaymentProcessor {
  const attempts = new Map<string, SettlementAttempt>()
  const settled = new Map<string, SettledCacheEntry>()

  async function settleOnce(params: {
    productId: ProductId
    payload: PaymentPayload
    authorization: Eip3009Authorization
    signature: Hex
    expectedAmount: bigint
    merchantAddress: Address
    paymentRequired: PaymentRequired
  }): Promise<SettledPayment> {
    const paymentKey = `${getAddress(params.authorization.from).toLowerCase()}:${params.authorization.nonce.toLowerCase()}`
    const productKey = `${paymentKey}:${params.productId}`

    const existing = settled.get(productKey)
    if (existing) return existing.payment
    if ([...settled.keys()].some((key) => key.startsWith(`${paymentKey}:`))) {
      throw new PaymentError('Payment authorization nonce has already settled a different product')
    }

    const attempt = attempts.get(paymentKey)
    if (attempt) {
      if (attempt.productId !== params.productId) {
        throw new PaymentError('Payment authorization nonce is already settling a different product')
      }
      if (attempt.promise) {
        return (await attempt.promise).payment
      }
      if (attempt.txHash) {
        const retry = confirmSubmittedPayment(params, productKey, attempt.txHash)
        attempt.promise = retry
        try {
          return (await retry).payment
        } finally {
          attempt.promise = undefined
        }
      }
    }

    const nextAttempt: SettlementAttempt = { productId: params.productId }
    attempts.set(paymentKey, nextAttempt)
    const promise = (async (): Promise<SettledCacheEntry> => {
      const txHash = await settlementClient.submit(params.authorization, params.signature)
      nextAttempt.txHash = txHash
      return confirmSubmittedPayment(params, productKey, txHash)
    })()

    nextAttempt.promise = promise
    try {
      return (await promise).payment
    } finally {
      nextAttempt.promise = undefined
      if (!nextAttempt.txHash && !settled.has(productKey)) {
        attempts.delete(paymentKey)
      }
    }
  }

  async function confirmSubmittedPayment(
    params: {
      productId: ProductId
      authorization: Eip3009Authorization
      expectedAmount: bigint
    },
    productKey: string,
    txHash: Hex,
  ): Promise<SettledCacheEntry> {
    await settlementClient.waitForReceipt(txHash)
    const response: SettleResponse = {
      success: true,
      payer: getAddress(params.authorization.from),
      transaction: txHash,
      network: NETWORK,
      amount: params.expectedAmount.toString(),
    }
    const payment: SettledPayment = {
      productId: params.productId,
      from: getAddress(params.authorization.from),
      to: getAddress(params.authorization.to),
      value: params.expectedAmount,
      nonce: params.authorization.nonce as Hex,
      txHash,
      paymentResponse: response,
      paymentResponseHeader: encodePaymentResponseHeader(response),
    }
    const entry = { productId: params.productId, payment }
    settled.set(productKey, entry)
    return entry
  }

  return {
    buildPaymentRequired,
    paymentRequiredHeader: encodePaymentRequiredHeader,
    paymentResponseHeader: encodePaymentResponseHeader,

    async verifyAndSettle(params) {
      const payload = decodePayment(params.paymentHeader)
      const accepted = payload.accepted
      const paymentOption = params.paymentRequired.accepts[0]
      const { authorization, signature } = parseExactEvmPayload(payload.payload)

      assertPaymentOptionMatches(accepted, paymentOption, params.merchantAddress, params.expectedAmount)
      assertResourceMatches(payload, params.paymentRequired)
      await verifyAuthorization(authorization, signature, params.merchantAddress, params.expectedAmount)

      return settleOnce({
        productId: params.productId,
        payload,
        authorization,
        signature,
        expectedAmount: params.expectedAmount,
        merchantAddress: params.merchantAddress,
        paymentRequired: params.paymentRequired,
      })
    },
  }
}

export function createViemSettlementClient(params: {
  baseRpcUrl: string
  settlementPrivateKey: Hex
}): SettlementClient {
  const account = privateKeyToAccount(params.settlementPrivateKey) as PrivateKeyAccount
  const transport = http(params.baseRpcUrl)
  // viem validates the chain id against the RPC before submitting, so this must
  // match BASE_RPC_URL's chain (Base mainnet vs Base Sepolia per MERCHANT_CHAIN_ID).
  const chain = CHAIN_ID === 84532 ? baseSepolia : base
  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ account, chain, transport })

  return {
    async submit(authorization, signature) {
      const parsed = parseSignature(signature)
      if (parsed.v === undefined) {
        throw new PaymentError('Payment signature is missing v value')
      }
      return walletClient.writeContract({
        address: USDC_ADDRESS,
        abi: USDC_TRANSFER_WITH_AUTHORIZATION_ABI,
        functionName: 'transferWithAuthorization',
        args: [
          getAddress(authorization.from),
          getAddress(authorization.to),
          BigInt(authorization.value),
          BigInt(authorization.validAfter),
          BigInt(authorization.validBefore),
          authorization.nonce as Hex,
          Number(parsed.v),
          parsed.r,
          parsed.s,
        ],
      })
    },

    async waitForReceipt(txHash) {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      })
      if (receipt.status !== 'success') {
        throw new PaymentError(`USDC settlement transaction failed: ${txHash}`)
      }
    },
  }
}

export function buildPaymentRequired(params: {
  merchantAddress: Address
  amountUsdc: bigint
  resource: string
  description: string
}): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: params.resource,
      description: params.description,
      mimeType: 'application/json',
      serviceName: 'Haven Demo Merchant',
    },
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK,
        amount: params.amountUsdc.toString(),
        payTo: params.merchantAddress,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        asset: USDC_ADDRESS,
        extra: { name: USDC_DOMAIN_NAME, version: USDC_DOMAIN_VERSION },
      },
    ],
    error: 'Payment required',
  }
}

function decodePayment(header: string): PaymentPayload {
  try {
    return decodePaymentSignatureHeader(header)
  } catch {
    throw new PaymentError('Invalid payment header: could not decode base64/JSON x402 payload')
  }
}

function parseExactEvmPayload(payload: Record<string, unknown>): {
  authorization: Eip3009Authorization
  signature: Hex
} {
  const authorization = payload.authorization as Partial<Eip3009Authorization> | undefined
  const signature = payload.signature
  if (!authorization || typeof authorization !== 'object') {
    throw new PaymentError('Invalid payment header: missing EIP-3009 authorization')
  }
  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    throw new PaymentError('Invalid payment header: missing EIP-3009 signature')
  }
  for (const field of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as const) {
    if (typeof authorization[field] !== 'string' || authorization[field] === '') {
      throw new PaymentError(`Invalid payment authorization field: ${field}`)
    }
  }
  return { authorization: authorization as Eip3009Authorization, signature: signature as Hex }
}

function assertPaymentOptionMatches(
  accepted: PaymentRequirements,
  expected: PaymentRequirements,
  merchantAddress: Address,
  expectedAmount: bigint,
): void {
  if (accepted.scheme !== 'exact') throw new PaymentError(`Unsupported x402 scheme: ${accepted.scheme}`)
  if (accepted.network !== NETWORK) throw new PaymentError(`Unsupported x402 network: ${accepted.network}`)
  if (accepted.amount !== expectedAmount.toString()) {
    throw new PaymentError(`Payment amount does not match: expected ${expectedAmount}, got ${accepted.amount}`)
  }
  if (accepted.amount !== expected.amount) {
    throw new PaymentError('Payment accepted option does not match the quoted amount')
  }
  if (!sameAddress(accepted.payTo, merchantAddress) || !sameAddress(accepted.payTo, expected.payTo)) {
    throw new PaymentError('Payment accepted option does not match merchant recipient')
  }
  if (!sameAddress(accepted.asset, USDC_ADDRESS) || !sameAddress(accepted.asset, expected.asset)) {
    throw new PaymentError('Payment accepted option does not match Base USDC')
  }
  if (accepted.maxTimeoutSeconds !== expected.maxTimeoutSeconds) {
    throw new PaymentError('Payment accepted option does not match timeout')
  }
  if (
    (accepted.extra?.name ?? null) !== USDC_DOMAIN_NAME ||
    (accepted.extra?.version ?? null) !== USDC_DOMAIN_VERSION
  ) {
    throw new PaymentError('Payment accepted option is missing the expected USDC domain metadata')
  }
}

function assertResourceMatches(payload: PaymentPayload, paymentRequired: PaymentRequired): void {
  if (!payload.resource) return
  if (payload.resource.url !== paymentRequired.resource.url) {
    throw new PaymentError('Payment resource does not match quoted resource')
  }
}

async function verifyAuthorization(
  authorization: Eip3009Authorization,
  signature: Hex,
  merchantAddress: Address,
  expectedAmount: bigint,
): Promise<void> {
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const validBefore = parseBigIntField(authorization.validBefore, 'validBefore')
  const validAfter = parseBigIntField(authorization.validAfter, 'validAfter')
  const value = parseBigIntField(authorization.value, 'value')

  if (!isAddress(authorization.from)) throw new PaymentError('Payment payer address is invalid')
  if (!isAddress(authorization.to)) throw new PaymentError('Payment recipient address is invalid')
  if (!NONCE_RE.test(authorization.nonce)) throw new PaymentError('Payment nonce must be 32 bytes')
  if (validBefore > 0n && nowSec >= validBefore) throw new PaymentError('Payment authorization has expired')
  if (nowSec < validAfter) throw new PaymentError('Payment authorization is not valid yet')
  if (!sameAddress(authorization.to, merchantAddress)) throw new PaymentError('Payment is not addressed to this merchant')
  if (value !== expectedAmount) {
    throw new PaymentError(`Payment amount does not match: expected ${expectedAmount}, got ${value}`)
  }

  let valid = false
  try {
    valid = await verifyTypedData({
      address: getAddress(authorization.from),
      domain: USDC_DOMAIN,
      types: TRANSFER_WITH_AUTH_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: getAddress(authorization.from),
        to: getAddress(authorization.to),
        value,
        validAfter,
        validBefore,
        nonce: authorization.nonce as Hex,
      },
      signature,
    })
  } catch {
    valid = false
  }
  if (!valid) throw new PaymentError('Invalid EIP-3009 signature')
}

function parseBigIntField(value: string, field: string): bigint {
  try {
    return BigInt(value)
  } catch {
    throw new PaymentError(`Invalid payment authorization field: ${field}`)
  }
}

function sameAddress(a: string, b: string): boolean {
  return isAddress(a) && isAddress(b) && getAddress(a).toLowerCase() === getAddress(b).toLowerCase()
}

export class PaymentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentError'
  }
}
