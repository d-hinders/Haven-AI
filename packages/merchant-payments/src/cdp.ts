/**
 * #4851: settlement through Coinbase's hosted x402 facilitator (CDP).
 *
 * This module holds what the CDP path needs from the outside world — the
 * facilitator client, a read of the chain, a bounded wait — so the payment
 * processor can be tested against fakes of exactly these. The ordering
 * decisions (the merchant's own checks first, the chain read after any
 * failure) live in `cdp-settlement.ts`.
 *
 * #4890: moved from `packages/demo-merchant-mcp/src/cdp.ts`. The chain and the
 * USDC address are parameters, and every chain read is bounded (below).
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
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types'
import { DEFAULT_LOG_SPAN_BLOCKS, LogWindows } from './log-range.js'

/** The facilitator calls the merchant makes. `HTTPFacilitatorClient` from
 *  `@x402/core/server` (which `createCdpFacilitatorClient` returns) satisfies it. */
export interface CdpFacilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>
  /**
   * The facilitator's supported kinds (#5008). `HTTPFacilitatorClient` has it,
   * and `@coinbase/x402`'s config signs a CDP JWT for `GET …/supported`, so the
   * call is authenticated. Optional, so a test fake need not implement it: the
   * pre-flight `check` reports `not verified` when it is absent rather than
   * casting.
   */
  getSupported?(): Promise<SupportedResponse>
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

/**
 * #4890: the bound on ONE chain read, retries included. The viem `http()`
 * transport's own timeout is per attempt and it retries a timed-out read, so a
 * single hung read could take about 41 s; every read the reader makes is raced
 * against this instead (and the client built here sets `retryCount: 0`).
 */
export const CHAIN_READ_TIMEOUT_MS = 10_000

/**
 * #4890: the bound on the whole search for the transaction that used an
 * authorization (`findAuthorizationOutcome`), whatever window the buyer signed.
 * Past it the search REJECTS, which the caller reads as "outcome unknown".
 */
export const SETTLE_RESOLVE_MS = 30_000

export type CdpOperation = 'verify' | 'settle' | 'chain_read'

/** The merchant gave up waiting for the facilitator or the chain. The outcome is unknown. */
export class CdpTimeoutError extends Error {
  constructor(readonly operation: CdpOperation, readonly timeoutMs: number) {
    super(
      operation === 'chain_read'
        ? `Chain read did not answer within ${timeoutMs} ms`
        : `Coinbase facilitator ${operation} did not answer within ${timeoutMs} ms`,
    )
    this.name = 'CdpTimeoutError'
  }
}

export async function withCdpTimeout<T>(
  operation: CdpOperation,
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
 *
 * `options.timeoutMs` bounds each request. `getSupported`'s own default is 90 s
 * and it retries a 429 three times; the pre-flight `check` (#5008) sets a short
 * one, because it is a pre-flight and not a payment.
 */
export async function createCdpFacilitator(
  credentials: {
    apiKeyId: string
    apiKeySecret: string
  },
  options: { timeoutMs?: number } = {},
): Promise<CdpFacilitator> {
  const [{ createFacilitatorConfig }, { HTTPFacilitatorClient }] = await Promise.all([
    import('@coinbase/x402'),
    import('@x402/core/server'),
  ])
  const config = createFacilitatorConfig(credentials.apiKeyId, credentials.apiKeySecret)
  return new HTTPFacilitatorClient({
    ...config,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  })
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
/**
 * Many RPC plans refuse a wider `eth_getLogs` range; search in windows of at
 * most this size. #4866: narrowed by `ETH_GETLOGS_MAX_BLOCK_RANGE` and by the
 * provider's own refusal (the public Base Sepolia RPC serves 200), see
 * `log-range.ts`.
 */
const LOG_CHUNK_BLOCKS = DEFAULT_LOG_SPAN_BLOCKS
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

/**
 * The viem client the reader uses, for a supported chain. There is no default
 * chain: the caller names it, and an unsupported one throws. The transport has
 * a 10 s timeout and no retries, so a hung read ends at the bound.
 */
export function createViemChainReadClient(rpcUrl: string, chainId: number): ChainReadClient {
  const chain = chainId === 8453 ? base : chainId === 84532 ? baseSepolia : undefined
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: CHAIN_READ_TIMEOUT_MS, retryCount: 0 }),
  }) as ChainReadClient
}

export interface CdpChainReaderOptions {
  /** The USDC contract whose events and `authorizationState` are read. */
  usdcAddress: Address
  // #4866: one window state per RPC client, so a limit learned from this
  // provider's refusal narrows every later search on it.
  logWindows?: LogWindows
  /** Upper bound on each chain read, ms. Default `CHAIN_READ_TIMEOUT_MS`. */
  readTimeoutMs?: number
  /** Upper bound on one `findAuthorizationOutcome`, ms. Default `SETTLE_RESOLVE_MS`. */
  resolveTimeoutMs?: number
}

export function createCdpChainReader(client: ChainReadClient, options: CdpChainReaderOptions): CdpChainReader {
  const { usdcAddress } = options
  const logWindows = options.logWindows ?? new LogWindows({ defaultSpan: LOG_CHUNK_BLOCKS })
  const readTimeoutMs = options.readTimeoutMs ?? CHAIN_READ_TIMEOUT_MS
  const resolveTimeoutMs = options.resolveTimeoutMs ?? SETTLE_RESOLVE_MS

  /** One chain read, raced against the per-read bound (and an overall deadline, when given). */
  function read<T>(call: () => Promise<T>, deadline?: number): Promise<T> {
    let bound = readTimeoutMs
    if (deadline !== undefined) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return Promise.reject(new CdpTimeoutError('chain_read', resolveTimeoutMs))
      bound = Math.min(bound, remaining)
    }
    return withCdpTimeout('chain_read', bound, call)
  }

  async function search(
    params: Parameters<CdpChainReader['findAuthorizationOutcome']>[0],
    deadline: number,
  ): Promise<AuthorizationOutcome | null> {
    // Review of #4851: the nonce is normalised before it becomes a topic. The
    // merchant accepts any hex case, and a topic match is exact; an uppercase
    // nonce would otherwise never match its own event.
    const nonce = params.nonce.toLowerCase() as Hex
    const latest = await read(() => client.getBlock({ blockTag: 'latest' }), deadline)
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
    // would then be missing. Only a window whose `validBefore` is at least
    // 2 × BLOCK_MARGIN blocks (300, about 10 minutes) behind this node's head
    // counts as fully searched;
    // a recent one returns `null`, and the buyer is served without a reference.
    let complete = windowEnd + BLOCK_MARGIN <= latest.number
    if (toBlock - fromBlock > MAX_SEARCH_BLOCKS) {
      fromBlock = toBlock - MAX_SEARCH_BLOCKS
      complete = false
    }

    // #4866: contiguous windows the provider will serve. A refusal that
    // names a narrower range is learned and the window asked again; any
    // other failure throws, and the caller serves the buyer without a
    // reference, exactly as before.
    const found = await logWindows.scan(
      fromBlock,
      toBlock,
      async (start, end) => {
        // #4890: no window is started once the deadline has passed.
        // Review of #4851: ONE event per query. Given `events: [...]`, viem
        // drops `args` from the topics and filters client-side, so the RPC
        // would return every such event in the range. With `event:` the
        // authorizer and nonce are encoded as topics and the node filters.
        const logs = await read(
          () =>
            client.getLogs({
              address: usdcAddress,
              event: AUTHORIZATION_USED_EVENT,
              args: { authorizer: getAddress(params.authorizer), nonce },
              fromBlock: start,
              toBlock: end,
            }),
          deadline,
        )
        return logs.find((log) => log.transactionHash)?.transactionHash ?? null
      },
      (txHash) => txHash !== null,
    )
    const usedTxHash = found.find((txHash): txHash is Hex => txHash !== null)
    if (usedTxHash) {
      const receipt = await read(() => client.getTransactionReceipt({ hash: usedTxHash }), deadline)
      return paidMerchant(receipt, params, usdcAddress)
        ? { kind: 'settled', txHash: usedTxHash }
        : { kind: 'used_elsewhere', txHash: usedTxHash }
    }
    if (complete) return { kind: 'not_in_window' }
    return null
  }

  return {
    authorizationUsed(authorizer, nonce) {
      return read(() =>
        client.readContract({
          address: usdcAddress,
          abi: AUTHORIZATION_STATE_ABI,
          functionName: 'authorizationState',
          args: [getAddress(authorizer), nonce.toLowerCase() as Hex],
        }),
      )
    },

    // #4890: the whole search, the check that the event paid the merchant
    // included, is bounded at `resolveTimeoutMs`. Past it this REJECTS, which
    // the caller reads as "outcome unknown"; the scan itself also stops
    // between windows (`read` refuses to start a read after the deadline).
    findAuthorizationOutcome(params) {
      const deadline = Date.now() + resolveTimeoutMs
      return withCdpTimeout('chain_read', resolveTimeoutMs, () => search(params, deadline))
    },
  }
}

/** Did this receipt move exactly `value` USDC from the payer to `to`? */
function paidMerchant(
  receipt: Awaited<ReturnType<ChainReadClient['getTransactionReceipt']>>,
  params: { authorizer: Address; to: Address; value: bigint },
  usdcAddress: Address,
): boolean {
  if (receipt.status !== 'success') return false
  return receipt.logs.some((log) => {
    if (getAddress(log.address) !== getAddress(usdcAddress)) return false
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
  /** Appended to the warning: what being off means for this merchant's products. */
  disabledNote = '',
): { apiKeyId: string; apiKeySecret: string } | undefined {
  const apiKeyId = apiKeyIdRaw?.trim()
  const apiKeySecret = apiKeySecretRaw?.trim()
  if (apiKeyId && apiKeySecret) return { apiKeyId, apiKeySecret }
  if (apiKeyId || apiKeySecret) {
    warn(
      (
        'Coinbase facilitator (CDP) settlement is disabled: set BOTH CDP_API_KEY_ID and CDP_API_KEY_SECRET. ' +
        disabledNote
      ).trimEnd(),
    )
  }
  return undefined
}
