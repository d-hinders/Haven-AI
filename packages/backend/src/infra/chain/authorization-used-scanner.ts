/**
 * Reading the pinned token's `AuthorizationUsed` log — the EIP-3009 event the
 * passive eip3009 settlement sweeper (#3888) uses to attribute a settlement
 * nobody reported, by the payment itself.
 *
 * ## The attribution key the chain names
 *
 * An EIP-3009 settlement (the facilitator redeeming the agent's
 * `transferWithAuthorization`) burns the authorization with an
 * `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` log
 * on the token contract. Both arguments are indexed, so one `eth_getLogs`
 * filter names `(delegate EOA, nonce)` exactly — and since #3888 the nonce is
 * a pure function of the payment id (`deriveX402PaymentNonce` in the SDK edge
 * surface), the lookup key exists before the settlement does. This is the
 * eip3009 counterpart of the erc7710 sweeper's `RedeemedDelegation` lookup
 * (`redeemed-delegation-scanner.ts`): attribute by a key the chain names,
 * never by transfer shape.
 *
 * `authorizationState(authorizer, nonce)` is deliberately NOT proof and never
 * used as one — `cancelAuthorization` sets it too. It is only the cheap
 * pre-check the sweeper may run to skip `eth_getLogs` for a payment that has
 * not been redeemed yet; the tx the log names still goes through the full
 * transfer verifier downstream, exactly as an agent-reported hash does.
 *
 * ## What this module will NOT do
 *
 * - It never treats an RPC failure as "no logs". Every failure is
 *   `unavailable`, which the sweeper reads as "not known yet" and acts on by
 *   doing nothing — an outage must never be able to confirm or reject
 *   anything.
 * - It never resolves a nonce seen used by TWO different transactions. The
 *   token refuses a reused EIP-3009 nonce, so a second sighting is a fact we
 *   do not understand; it is surfaced as `ambiguous` and the sweeper refuses
 *   it rather than picking one.
 * - It applies no other judgement. Whether the transaction it proposes may
 *   confirm a payment is decided downstream by `verifySettlementTransferTx`
 *   and the guarded `UPDATE` (`eip3009-settlement-evidence.ts`), exactly as
 *   for an agent-reported hash.
 */
import { ethers } from 'ethers'
import { getProvider } from './relayer-reads.js'

/** The token's own single-use burn event; both arguments are indexed. */
export const AUTHORIZATION_USED_IFACE = new ethers.Interface([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
])

/** `topics[0]` of the event above — the `eth_getLogs` filter for the scan. */
export const AUTHORIZATION_USED_TOPIC =
  AUTHORIZATION_USED_IFACE.getEvent('AuthorizationUsed')!.topicHash

/**
 * An EIP-3009 nonce seen used by more than one distinct transaction. Never
 * expected — the token refuses a reused nonce — so it is surfaced as a
 * refusal rather than resolved by picking one.
 */
export const AMBIGUOUS = Symbol('ambiguous authorization use')

export type AuthorizationUseIndexEntry = string | typeof AMBIGUOUS

export interface ScanRange {
  fromBlock: number
  toBlock: number
}

export interface ScanOptions {
  /** Blocks per `eth_getLogs` call. Providers cap the span they will serve. */
  batchBlocks: number
  /** Hard ceiling on calls per scan, so one tick cannot become an unbounded walk. */
  maxBatches: number
}

/**
 * Every `(authorizer, nonce)` the token reports having used in
 * `[fromBlock, toBlock]`, mapped to the transaction that used it.
 *
 * Returns `null` — and ONLY `null` — when the chain could not be read. An
 * empty map means "nothing was used in this range", which is a real answer;
 * `null` is "we could not ask", which is not. Collapsing the two is the
 * mistake this signature exists to make impossible, because one is retryable
 * and the other is a fact.
 *
 * The map is keyed by `authorizer:nonce` — EIP-3009 nonce uniqueness is PER
 * AUTHORIZER, so two different delegates may legitimately burn the same
 * nonce value, and a nonce-only key would collide across them. Callers that
 * need one payment's answer name the authorizer, which narrows the
 * `eth_getLogs` filter to exactly that pair — the two indexed topics every
 * provider serves.
 */
export async function scanAuthorizationUsed(
  chainId: number,
  tokenAddress: string,
  authorizer: string | undefined,
  range: ScanRange,
  options: ScanOptions,
): Promise<Map<string, AuthorizationUseIndexEntry> | null> {
  const index = new Map<string, AuthorizationUseIndexEntry>()
  const topics: string[] = [AUTHORIZATION_USED_TOPIC]
  if (authorizer !== undefined) {
    // topics[1] = authorizer (indexed address, left-padded to 32 bytes).
    topics.push(ethers.zeroPadValue(ethers.getAddress(authorizer.toLowerCase()), 32))
  }
  let cursor = Math.max(0, range.fromBlock)
  let batches = 0

  while (cursor <= range.toBlock && batches < options.maxBatches) {
    const to = Math.min(range.toBlock, cursor + options.batchBlocks - 1)
    let logs: Array<{ topics: readonly string[]; data: string; transactionHash: string }>
    try {
      const provider = getProvider(chainId)
      logs = (await provider.getLogs({
        address: tokenAddress,
        topics,
        fromBlock: cursor,
        toBlock: to,
      })) as never
    } catch {
      // A partial index is worse than none: the sweeper would read "absent"
      // as "not settled yet" for everything the failed batch would have
      // carried. Abandon the whole scan and let the next tick redo it.
      return null
    }

    for (const log of logs) {
      // topics[1] = authorizer (indexed address), topics[2] = nonce (indexed
      // bytes32). A log that does not decode is skipped, not fatal.
      if (log.topics.length < 3) continue
      const decoded: { authorizer: string; nonce: string } | undefined = (() => {
        try {
          return AUTHORIZATION_USED_IFACE.decodeEventLog(
            'AuthorizationUsed',
            log.data,
            log.topics as [string, string, string],
          ) as unknown as { authorizer: string; nonce: string }
        } catch {
          return undefined
        }
      })()
      if (!decoded?.nonce || !decoded.authorizer) continue
      const key = `${decoded.authorizer.toLowerCase()}:${decoded.nonce.toLowerCase()}`
      const existing = index.get(key)
      if (existing === undefined) {
        index.set(key, log.transactionHash)
      } else if (existing !== AMBIGUOUS && existing.toLowerCase() !== log.transactionHash.toLowerCase()) {
        index.set(key, AMBIGUOUS)
      }
    }

    cursor = to + 1
    batches += 1
  }

  return index
}

/**
 * The one-payment question: which transaction used `(authorizer, nonce)`?
 *
 * `unavailable` is an RPC failure — the sweeper must treat it as "not known
 * yet", never as a negative. `none` is a real answer over a fully-scanned
 * range. `ambiguous` is the poisoned entry above.
 */
export async function findAuthorizationUsedTx(
  chainId: number,
  tokenAddress: string,
  authorizer: string,
  nonce: string,
  range: ScanRange,
  options: ScanOptions,
): Promise<
  | { status: 'found'; txHash: string }
  | { status: 'none' }
  | { status: 'ambiguous' }
  | { status: 'unavailable' }
> {
  const index = await scanAuthorizationUsed(
    chainId,
    tokenAddress,
    ethers.getAddress(authorizer.toLowerCase()),
    range,
    options,
  )
  if (index === null) return { status: 'unavailable' }
  const entry = index.get(`${ethers.getAddress(authorizer.toLowerCase()).toLowerCase()}:${nonce.toLowerCase()}`)
  if (entry === undefined) return { status: 'none' }
  if (entry === AMBIGUOUS) return { status: 'ambiguous' }
  return { status: 'found', txHash: entry }
}

/**
 * The token's own `authorizationState(authorizer, nonce)` — the cheap
 * pre-check before a log scan. `null` on any failure (fail closed: the
 * caller must treat "could not ask" as "not known yet", never as `false`).
 * `true` alone is NOT proof of settlement — `cancelAuthorization` sets it —
 * so a `true` answer only licenses the log scan, never a record.
 */
export async function readAuthorizationState(
  chainId: number,
  tokenAddress: string,
  authorizer: string,
  nonce: string,
): Promise<boolean | null> {
  try {
    const provider = getProvider(chainId)
    const token = new ethers.Contract(
      tokenAddress,
      ['function authorizationState(address,bytes32) view returns (bool)'],
      provider,
    )
    return (await token.authorizationState(authorizer, nonce)) as boolean
  } catch {
    return null
  }
}
