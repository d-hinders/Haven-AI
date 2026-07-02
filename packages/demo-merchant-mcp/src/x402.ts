import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  isAddress,
  keccak256,
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
const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})+$/
const ZERO_TX_HASH = `0x${'0'.repeat(64)}` as Hex

// Verify-without-settle test hook (#603). Product ids listed here are verified
// but not settled on-chain — used by the QA sweep-recovery scenario to strand the
// delegate deterministically. Off (empty) by default; set on the dev merchant only.
const SKIP_SETTLE_PRODUCTS = new Set(
  (process.env.MERCHANT_SKIP_SETTLE_PRODUCT ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

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

// ── Experimental ERC-7710 rail (#747, epic #452) ─────────────────────────────
// x402 exact-EVM `assetTransferMethod: 'erc7710'`: the payer is a smart account
// that signed an ERC-7710 delegation; verification is by *simulating*
// `delegationManager.redeemDelegations(...)` (no ECDSA recovery), and settlement
// submits that same call from the settlement key — so the settlement key is the
// redeemer and any redeemer caveat in the delegation must name it. Testnet-only:
// the flag is enforced at the composition root (index.ts) to Base Sepolia.

export const ERC7710_TRANSFER_METHOD = 'erc7710'

// ERC-7579 "simple single call" execution mode (callType 0x00, execType 0x00).
const ERC7579_SINGLE_CALL_MODE = `0x${'0'.repeat(64)}` as Hex

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

// ERC-7710: redeemDelegations(bytes[] _permissionContexts, ModeCode[] _modes,
// bytes[] _executionCallDatas) where ModeCode is an ERC-7579 bytes32 mode.
const DELEGATION_MANAGER_ABI = [
  {
    type: 'function',
    name: 'redeemDelegations',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_permissionContexts', type: 'bytes[]' },
      { name: '_modes', type: 'bytes32[]' },
      { name: '_executionCallDatas', type: 'bytes[]' },
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

/** Parsed erc7710 payment payload (x402 exact-EVM, assetTransferMethod 'erc7710'). */
export interface Erc7710Payment {
  delegator: Address
  delegationManager: Address
  permissionContext: Hex
}

/** One redeemDelegations invocation — shared by verification (simulate) and settlement (submit). */
export interface Erc7710RedeemCall {
  delegationManager: Address
  permissionContext: Hex
  mode: Hex
  executionCallData: Hex
}

export interface Erc7710SettlementClient {
  /** Verify by simulation per the x402 spec: must reject (throw) when the
   *  delegation does not authorize the transfer or the delegator cannot fund it. */
  simulateRedeemDelegations(call: Erc7710RedeemCall): Promise<void>
  submitRedeemDelegations(call: Erc7710RedeemCall): Promise<Hex>
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
  /** Present only when the experimental ERC-7710 rail is configured. */
  erc7710?: Erc7710SettlementClient
}

export interface X402PaymentProcessorOptions {
  /** Advertise + accept the experimental erc7710 assetTransferMethod.
   *  Chain gating (Base Sepolia only) is enforced at the composition root. */
  erc7710?: {
    /** The only DelegationManager contract this merchant will simulate against
     *  and settle through. The payload's delegationManager is attacker-supplied;
     *  without pinning it, a no-op contract at that address would "verify" and
     *  "settle" successfully while moving zero USDC. */
    delegationManager: Address
  }
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

/** Rail-agnostic description of one verified payment, ready to settle exactly once. */
interface VerifiedPayment {
  /** In-process dedupe key. EIP-3009: payer + authorization nonce (on-chain replay
   *  protection). erc7710: delegator + permissionContext hash — one redemption per
   *  delegation in this demo; multi-redemption budget delegations are intentionally
   *  not supported here, the on-chain caveats are the real enforcement. */
  paymentKey: string
  payer: Address
  payTo: Address
  nonce: Hex
  submit: () => Promise<Hex>
}

export function createX402PaymentProcessor(
  settlementClient: SettlementClient,
  options: X402PaymentProcessorOptions = {},
): X402PaymentProcessor {
  const attempts = new Map<string, SettlementAttempt>()
  const settled = new Map<string, SettledCacheEntry>()

  async function settleOnce(params: {
    productId: ProductId
    verified: VerifiedPayment
    expectedAmount: bigint
  }): Promise<SettledPayment> {
    const { paymentKey } = params.verified
    const productKey = `${paymentKey}:${params.productId}`

    const existing = settled.get(productKey)
    if (existing) return existing.payment
    if ([...settled.keys()].some((key) => key.startsWith(`${paymentKey}:`))) {
      throw new PaymentError('Payment authorization has already settled a different product')
    }

    const attempt = attempts.get(paymentKey)
    if (attempt) {
      if (attempt.productId !== params.productId) {
        throw new PaymentError('Payment authorization is already settling a different product')
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
      const txHash = await params.verified.submit()
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
      verified: VerifiedPayment
      expectedAmount: bigint
    },
    productKey: string,
    txHash: Hex,
  ): Promise<SettledCacheEntry> {
    await settlementClient.waitForReceipt(txHash)
    const payment = buildSettledPayment(params, txHash)
    const entry = { productId: params.productId, payment }
    settled.set(productKey, entry)
    return entry
  }

  function buildSettledPayment(
    params: { productId: ProductId; verified: VerifiedPayment; expectedAmount: bigint },
    txHash: Hex,
  ): SettledPayment {
    const response: SettleResponse = {
      success: true,
      payer: params.verified.payer,
      transaction: txHash,
      network: NETWORK,
      amount: params.expectedAmount.toString(),
    }
    return {
      productId: params.productId,
      from: params.verified.payer,
      to: params.verified.payTo,
      value: params.expectedAmount,
      nonce: params.verified.nonce,
      txHash,
      paymentResponse: response,
      paymentResponseHeader: encodePaymentResponseHeader(response),
    }
  }

  async function verifyEip3009Payment(params: {
    payload: PaymentPayload
    merchantAddress: Address
    expectedAmount: bigint
    paymentRequired: PaymentRequired
  }): Promise<VerifiedPayment> {
    const { authorization, signature } = parseExactEvmPayload(params.payload.payload)
    assertPaymentOptionMatches(
      params.payload.accepted,
      params.paymentRequired.accepts[0],
      params.merchantAddress,
      params.expectedAmount,
      'eip3009',
    )
    assertResourceMatches(params.payload, params.paymentRequired)
    await verifyAuthorization(authorization, signature, params.merchantAddress, params.expectedAmount)
    return {
      paymentKey: `${getAddress(authorization.from).toLowerCase()}:${authorization.nonce.toLowerCase()}`,
      payer: getAddress(authorization.from),
      payTo: getAddress(authorization.to),
      nonce: authorization.nonce as Hex,
      submit: () => settlementClient.submit(authorization, signature),
    }
  }

  async function verifyErc7710Payment(params: {
    payload: PaymentPayload
    merchantAddress: Address
    expectedAmount: bigint
    paymentRequired: PaymentRequired
  }): Promise<VerifiedPayment> {
    if (!options.erc7710) {
      throw new PaymentError('ERC-7710 payments are not enabled on this merchant')
    }
    const erc7710Client = settlementClient.erc7710
    if (!erc7710Client) {
      throw new PaymentError('ERC-7710 settlement is not configured on this merchant')
    }
    const expectedOption = params.paymentRequired.accepts.find(
      (option) => option.extra?.assetTransferMethod === ERC7710_TRANSFER_METHOD,
    )
    if (!expectedOption) {
      throw new PaymentError('This merchant did not offer an erc7710 payment option')
    }
    assertPaymentOptionMatches(
      params.payload.accepted,
      expectedOption,
      params.merchantAddress,
      params.expectedAmount,
      ERC7710_TRANSFER_METHOD,
    )
    assertResourceMatches(params.payload, params.paymentRequired)
    const payment = parseErc7710Payload(params.payload.payload)
    if (!sameAddress(payment.delegationManager, options.erc7710.delegationManager)) {
      throw new PaymentError('Payment delegationManager is not the delegation manager trusted by this merchant')
    }
    const redeemCall = buildRedeemCall(payment, params.merchantAddress, params.expectedAmount)
    try {
      await erc7710Client.simulateRedeemDelegations(redeemCall)
    } catch (err) {
      throw new PaymentError(
        `ERC-7710 delegation redemption simulation failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const contextHash = keccak256(payment.permissionContext)
    return {
      paymentKey: `erc7710:${payment.delegator.toLowerCase()}:${contextHash.toLowerCase()}`,
      payer: payment.delegator,
      payTo: getAddress(params.merchantAddress),
      nonce: contextHash,
      submit: () => erc7710Client.submitRedeemDelegations(redeemCall),
    }
  }

  return {
    buildPaymentRequired: (params) => buildPaymentRequired({ ...params, erc7710: Boolean(options.erc7710) }),
    paymentRequiredHeader: encodePaymentRequiredHeader,
    paymentResponseHeader: encodePaymentResponseHeader,

    async verifyAndSettle(params) {
      const payload = decodePayment(params.paymentHeader)
      const method = paymentMethod(payload.accepted)

      let verified: VerifiedPayment
      if (method === ERC7710_TRANSFER_METHOD) {
        verified = await verifyErc7710Payment({ ...params, payload })
      } else if (method === 'eip3009') {
        verified = await verifyEip3009Payment({ ...params, payload })
      } else {
        throw new PaymentError(`Unsupported x402 assetTransferMethod: ${method}`)
      }

      // Verify-without-settle test hook (#603 sweep-recovery QA). For products in
      // MERCHANT_SKIP_SETTLE_PRODUCT, verify the payment but do NOT submit the
      // on-chain transfer — leaving the payer's funds stranded so the sweep path
      // can be exercised deterministically. Off by default; per-product so the
      // normal x402 settle path is unaffected. Testnet/dev only.
      if (SKIP_SETTLE_PRODUCTS.has(params.productId)) {
        return buildSettledPayment(
          { productId: params.productId, verified, expectedAmount: params.expectedAmount },
          ZERO_TX_HASH,
        )
      }

      return settleOnce({
        productId: params.productId,
        verified,
        expectedAmount: params.expectedAmount,
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

    erc7710: {
      // Verification-by-simulation from the settlement (redeemer) account; a
      // delegation that does not cover the transfer, or a delegator that cannot
      // fund it, makes the simulated USDC transfer revert.
      async simulateRedeemDelegations(call) {
        await publicClient.simulateContract({
          account,
          address: call.delegationManager,
          abi: DELEGATION_MANAGER_ABI,
          functionName: 'redeemDelegations',
          args: [[call.permissionContext], [call.mode], [call.executionCallData]],
        })
      },

      async submitRedeemDelegations(call) {
        return walletClient.writeContract({
          address: call.delegationManager,
          abi: DELEGATION_MANAGER_ABI,
          functionName: 'redeemDelegations',
          args: [[call.permissionContext], [call.mode], [call.executionCallData]],
        })
      },
    },
  }
}

export function buildPaymentRequired(params: {
  merchantAddress: Address
  amountUsdc: bigint
  resource: string
  description: string
  erc7710?: boolean
}): PaymentRequired {
  const eip3009Option: PaymentRequirements = {
    scheme: 'exact',
    network: NETWORK,
    amount: params.amountUsdc.toString(),
    payTo: params.merchantAddress,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: USDC_ADDRESS,
    extra: { name: USDC_DOMAIN_NAME, version: USDC_DOMAIN_VERSION },
  }
  // The EIP-3009 option stays accepts[0] — existing clients pick the first entry
  // and the default (no assetTransferMethod) is 'eip3009' per the exact-EVM spec.
  const accepts: PaymentRequirements[] = [eip3009Option]
  if (params.erc7710 === true) {
    accepts.push({
      ...eip3009Option,
      extra: { assetTransferMethod: ERC7710_TRANSFER_METHOD },
    })
  }
  return {
    x402Version: 2,
    resource: {
      url: params.resource,
      description: params.description,
      mimeType: 'application/json',
      serviceName: 'Haven Demo Merchant',
    },
    accepts,
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

function paymentMethod(accepted: PaymentRequirements): string {
  const method = accepted.extra?.assetTransferMethod
  if (method === undefined) return 'eip3009'
  if (typeof method !== 'string') throw new PaymentError('Invalid payment header: assetTransferMethod must be a string')
  return method
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

function parseErc7710Payload(payload: Record<string, unknown>): Erc7710Payment {
  const { delegator, delegationManager, permissionContext } = payload
  if (typeof delegator !== 'string' || !isAddress(delegator)) {
    throw new PaymentError('Invalid erc7710 payment field: delegator must be an address')
  }
  if (typeof delegationManager !== 'string' || !isAddress(delegationManager)) {
    throw new PaymentError('Invalid erc7710 payment field: delegationManager must be an address')
  }
  if (typeof permissionContext !== 'string' || !HEX_BYTES_RE.test(permissionContext)) {
    throw new PaymentError('Invalid erc7710 payment field: permissionContext must be 0x-prefixed bytes')
  }
  return {
    delegator: getAddress(delegator),
    delegationManager: getAddress(delegationManager),
    permissionContext: permissionContext as Hex,
  }
}

function buildRedeemCall(
  payment: Erc7710Payment,
  merchantAddress: Address,
  amount: bigint,
): Erc7710RedeemCall {
  const transferData = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [getAddress(merchantAddress), amount],
  })
  // ERC-7579 single-call execution calldata: packed (target, value, callData).
  const executionCallData = encodePacked(
    ['address', 'uint256', 'bytes'],
    [USDC_ADDRESS, 0n, transferData],
  )
  return {
    delegationManager: payment.delegationManager,
    permissionContext: payment.permissionContext,
    mode: ERC7579_SINGLE_CALL_MODE,
    executionCallData,
  }
}

function assertPaymentOptionMatches(
  accepted: PaymentRequirements,
  expected: PaymentRequirements,
  merchantAddress: Address,
  expectedAmount: bigint,
  method: string,
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
  if (method === ERC7710_TRANSFER_METHOD) {
    if (accepted.extra?.assetTransferMethod !== ERC7710_TRANSFER_METHOD) {
      throw new PaymentError('Payment accepted option does not echo assetTransferMethod erc7710')
    }
  } else if (
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
