/**
 * #4851: settlement through Coinbase's hosted x402 facilitator (CDP).
 *
 * This module holds what the CDP path needs from the outside world — the
 * facilitator client, a read of the chain, a bounded wait — so the payment
 * processor (`x402.ts`) can be tested against fakes of exactly these. The
 * ordering decisions (the merchant's own checks first, the chain read after any
 * failure) live in the processor, next to the own-key path they mirror.
 *
 * No secret passes through here except into the Coinbase client constructor,
 * and nothing here logs a credential.
 */
import {
  createPublicClient,
  getAddress,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { base, baseSepolia } from 'viem/chains'
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from '@x402/core/types'
import { CHAIN_ID, USDC_ADDRESS } from './products.js'

/** The two facilitator calls the merchant makes. `HTTPFacilitatorClient` from
 *  `@x402/core/server` (which `createCdpFacilitatorClient` returns) satisfies it. */
export interface CdpFacilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>
}

/**
 * What the chain says consumed one EIP-3009 authorization whose nonce
 * `authorizationState` reports used. That flag is also set by a CANCELLED
 * authorization (`cancelAuthorization`), and by any other authorization that
 * spent the same nonce, so USDC's `AuthorizationUsed` event decides.
 *
 * The search covers the authorization's OWN validity window: USDC executes a
 * `transferWithAuthorization` only while `validAfter < now < validBefore`, so
 * if this payment moved, its event is in that window.
 * - `settled`: an `AuthorizationUsed` for (payer, nonce) in the window, and its
 *   transaction moved exactly `value` from the payer to the merchant.
 * - `used_elsewhere`: an `AuthorizationUsed` in the window whose transaction did
 *   not pay the merchant this amount.
 * - `not_in_window`: the whole window was searched and holds no
 *   `AuthorizationUsed`. The nonce was consumed by something that is not this
 *   payment — a cancellation, or another authorization with the same nonce.
 */
export type AuthorizationOutcome =
  | { kind: 'settled'; txHash: Hex }
  | { kind: 'used_elsewhere'; txHash: Hex }
  | { kind: 'not_in_window' }

export interface CdpChainReader {
  /** USDC `authorizationState(authorizer, nonce)`: true once used OR cancelled. */
  authorizationUsed(authorizer: Address, nonce: Hex): Promise<boolean>
  /**
   * Find what consumed the authorization. `null` when the window could not be
   * searched in full — longer than `MAX_SEARCH_BLOCKS`, or closed too recently
   * to rule out a lagging RPC node; a read that fails throws. In both cases the caller serves the buyer with no reference rather
   * than refuse one whose money may have moved.
   */
  findAuthorizationOutcome(params: {
    authorizer: Address
    nonce: Hex
    to: Address
    value: bigint
    validAfter: bigint
    validBefore: bigint
  }): Promise<AuthorizationOutcome | null>
}

export interface CdpSettlementConfig {
  facilitator: CdpFacilitator
  chain: CdpChainReader
  /** Upper bound on each facilitator call, ms. Default `CDP_CALL_TIMEOUT_MS`. */
  timeoutMs?: number
}

/**
 * The merchant's own bound on a facilitator call. The x402 client's default is
 * 90 s; an MCP tool call that waits that long is one most clients have already
 * abandoned. On expiry the call is treated like any other failure: the chain is
 * read, and the buyer is served, or told to retry the same header.
 */
export const CDP_CALL_TIMEOUT_MS = 30_000

/** The merchant gave up waiting for the facilitator. The outcome is unknown. */
export class CdpTimeoutError extends Error {
  constructor(readonly operation: 'verify' | 'settle', readonly timeoutMs: number) {
    super(`Coinbase facilitator ${operation} did not answer within ${timeoutMs} ms`)
    this.name = 'CdpTimeoutError'
  }
}

export async function withCdpTimeout<T>(
  operation: 'verify' | 'settle',
  timeoutMs: number,
  call: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CdpTimeoutError(operation, timeoutMs)), timeoutMs)
  })
  try {
    return await Promise.race([call(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Build the CDP facilitator client: `createFacilitatorConfig` from
 * `@coinbase/x402` (CDP's endpoint and per-request JWT auth) inside
 * `HTTPFacilitatorClient` from `@x402/core/server` — the pairing Stripe's
 * machine-payments sample uses. Not `@coinbase/cdp-sdk/x402`'s
 * `createCdpFacilitatorClient`: that entry point imports every x402 scheme
 * package (`@x402/evm`, `@x402/svm`, `@x402/extensions`) at load, which this
 * merchant would have to install only to settle EIP-3009 on Base.
 *
 * Loaded lazily, so a merchant without CDP credentials never imports either.
 * The credentials go to the config constructor and nowhere else; the client
 * signs a fresh JWT per request, so nothing reaches Coinbase until a payment.
 */
export async function createCdpFacilitator(credentials: {
  apiKeyId: string
  apiKeySecret: string
}): Promise<CdpFacilitator> {
  const [{ createFacilitatorConfig }, { HTTPFacilitatorClient }] = await Promise.all([
    import('@coinbase/x402'),
    import('@x402/core/server'),
  ])
  return new HTTPFacilitatorClient(createFacilitatorConfig(credentials.apiKeyId, credentials.apiKeySecret))
}

const AUTHORIZATION_USED_EVENT = parseAbiItem(
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
)
const AUTHORIZATION_STATE_ABI = [
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const
/** keccak256("Transfer(address,address,uint256)"): `Transfer(address indexed from, address indexed to, uint256 value)`. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** Base produces a block every 2 s; used only to turn the signed window into a block range. */
const BASE_BLOCK_TIME_SECONDS = 2n
/** Blocks searched either side of the estimate, for clock skew and the estimate's error. */
const BLOCK_MARGIN = 150n
/** Many RPC plans refuse a wider `eth_getLogs` range; search in chunks of this size. */
const LOG_CHUNK_BLOCKS = 500n
/** Never search more than this many blocks, whatever the window says (about 12 h). */
const MAX_SEARCH_BLOCKS = 21_600n

/**
 * Review of #4851: the longest signed window (`validBefore - validAfter`) the
 * CDP path accepts — the span the event search can cover in full, less its
 * margin on both sides. A longer window would leave the search incomplete, and
 * an incomplete search serves the buyer (it cannot prove the payment did not
 * land), so a payer could cancel the nonce and still be served. This
 * merchant's own quote (300 s) never comes close.
 */
export const CDP_MAX_AUTHORIZATION_WINDOW_SECONDS = Number(
  (MAX_SEARCH_BLOCKS - 2n * BLOCK_MARGIN) * BASE_BLOCK_TIME_SECONDS,
)

/** The viem public client the reader uses. Tests pass a real one over a stub transport. */
export type ChainReadClient = PublicClient

export function createViemChainReadClient(rpcUrl: string): ChainReadClient {
  const chain = CHAIN_ID === 84532 ? baseSepolia : base
  return createPublicClient({ chain, transport: http(rpcUrl) }) as ChainReadClient
}

export function createCdpChainReader(client: ChainReadClient): CdpChainReader {
  return {
    authorizationUsed(authorizer, nonce) {
      return client.readContract({
        address: USDC_ADDRESS,
        abi: AUTHORIZATION_STATE_ABI,
        functionName: 'authorizationState',
        args: [getAddress(authorizer), nonce.toLowerCase() as Hex],
      })
    },

    async findAuthorizationOutcome(params) {
      // Review of #4851: the nonce is normalised before it becomes a topic. The
      // merchant accepts any hex case, and a topic match is exact; an uppercase
      // nonce would otherwise never match its own event.
      const nonce = params.nonce.toLowerCase() as Hex
      const latest = await client.getBlock({ blockTag: 'latest' })
      const blockAt = (unixSeconds: bigint): bigint => {
        const behind = (latest.timestamp - unixSeconds) / BASE_BLOCK_TIME_SECONDS
        const estimate = latest.number - (behind > 0n ? behind : 0n)
        return estimate > 0n ? estimate : 0n
      }
      // The authorization's own validity window, plus a margin for the
      // estimate. A window longer than MAX_SEARCH_BLOCKS is searched from its
      // END only, and then an empty result proves nothing (`complete: false`).
      const windowEnd = blockAt(params.validBefore) + BLOCK_MARGIN
      const toBlock = windowEnd < latest.number ? windowEnd : latest.number
      const windowStart = blockAt(params.validAfter)
      let fromBlock = windowStart > BLOCK_MARGIN ? windowStart - BLOCK_MARGIN : 0n
      // Review of #4851: an empty result REFUSES the buyer, so it must be
      // proof. A load-balanced RPC can answer the log read from a node a few
      // blocks behind the one that said "used"; a payment that just landed
      // would then be missing. Only a window that closed at least
      // BLOCK_MARGIN blocks before this node's head counts as fully searched;
      // a recent one returns `null`, and the buyer is served without a reference.
      let complete = windowEnd + BLOCK_MARGIN <= latest.number
      if (toBlock - fromBlock > MAX_SEARCH_BLOCKS) {
        fromBlock = toBlock - MAX_SEARCH_BLOCKS
        complete = false
      }

      for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
        const end = start + LOG_CHUNK_BLOCKS - 1n < toBlock ? start + LOG_CHUNK_BLOCKS - 1n : toBlock
        // Review of #4851: ONE event per query. Given `events: [...]`, viem
        // drops `args` from the topics and filters client-side, so the RPC
        // would return every such event in the range. With `event:` the
        // authorizer and nonce are encoded as topics and the node filters.
        const logs = await client.getLogs({
          address: USDC_ADDRESS,
          event: AUTHORIZATION_USED_EVENT,
          args: { authorizer: getAddress(params.authorizer), nonce },
          fromBlock: start,
          toBlock: end,
        })
        const used = logs.find((log) => log.transactionHash)
        if (used?.transactionHash) {
          const receipt = await client.getTransactionReceipt({ hash: used.transactionHash })
          return paidMerchant(receipt, params)
            ? { kind: 'settled', txHash: used.transactionHash }
            : { kind: 'used_elsewhere', txHash: used.transactionHash }
        }
      }
      if (complete) return { kind: 'not_in_window' }
      return null
    },
  }
}

/** Did this receipt move exactly `value` USDC from the payer to `to`? */
function paidMerchant(
  receipt: Awaited<ReturnType<ChainReadClient['getTransactionReceipt']>>,
  params: { authorizer: Address; to: Address; value: bigint },
): boolean {
  if (receipt.status !== 'success') return false
  return receipt.logs.some((log) => {
    if (getAddress(log.address) !== getAddress(USDC_ADDRESS)) return false
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length !== 3) return false
    const from = getAddress(`0x${log.topics[1]!.slice(26)}`)
    const to = getAddress(`0x${log.topics[2]!.slice(26)}`)
    return from === getAddress(params.authorizer) && to === getAddress(params.to) && BigInt(log.data) === params.value
  })
}

/**
 * #4851: read the CDP credentials from the environment's two values.
 *
 * Both are required together. With neither, CDP is simply off and nothing is
 * said. With only one, the merchant warns and leaves CDP off — it never refuses
 * to start, following the passport configuration (`index.ts`), so a typo in
 * one variable cannot take the other products, or the production canary, down.
 * The warning names the variables, never their values.
 */
export function resolveCdpCredentials(
  apiKeyIdRaw: string | undefined,
  apiKeySecretRaw: string | undefined,
  warn: (message: string) => void = console.warn,
): { apiKeyId: string; apiKeySecret: string } | undefined {
  const apiKeyId = apiKeyIdRaw?.trim()
  const apiKeySecret = apiKeySecretRaw?.trim()
  if (apiKeyId && apiKeySecret) return { apiKeyId, apiKeySecret }
  if (apiKeyId || apiKeySecret) {
    warn(
      'Coinbase facilitator (CDP) settlement is disabled: set BOTH CDP_API_KEY_ID and CDP_API_KEY_SECRET. ' +
        'The CDP-settled joke product is not offered until both are set; every other product is unaffected.',
    )
  }
  return undefined
}
