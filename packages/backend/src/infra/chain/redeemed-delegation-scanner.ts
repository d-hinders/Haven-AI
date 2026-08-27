/**
 * Reading the pinned DelegationManager's `RedeemedDelegation` log — the ABI,
 * the re-hash, and the BOUNDED backwards scan the passive settlement sweeper
 * (#2117) uses to run attribution in the direction #2096 could not.
 *
 * ## Two directions, one piece of evidence
 *
 * #2096/#2094 answer "given a hash, is it THIS payment?" — the agent reports a
 * settlement transaction and `settlement-transfer-verifier.ts` re-hashes the
 * `Delegation` struct the manager emitted and requires this intent's stored
 * `delegation_hash` to be among them (check 8).
 *
 * #2117 needs the reverse: "given a payment, which transaction settled it?"
 * Nobody reports anything, so the sweeper has to FIND the transaction. Since
 * #2094 the settlement child is salted `keccak256("haven-x402-settlement:" ||
 * <intent id>)` and its hash is stored on the row at authorize time, so the
 * lookup key already exists and is intent-unique. This module turns the
 * manager's own logs over a block range into `delegation hash → settlement
 * transaction`, and the sweeper looks its candidates up in that map.
 *
 * **The attribution path is the SAME piece of evidence in both directions** —
 * the pinned manager's `RedeemedDelegation` event, re-hashed with the kit's own
 * `hashDelegation`. There is deliberately no second path: the sweeper never
 * searches for `Transfer` logs of the right shape, because transfer shape
 * cannot say WHICH payment a settlement paid for, and guessing on an accounting
 * feed turns "sometimes missing" into "sometimes wrong". A route that emits no
 * decodable manager log is simply not discoverable here, and the payments on it
 * stay exactly where #2096 left them.
 *
 * ## What this module will NOT do
 *
 * - It never treats an RPC failure as "no logs". Every failure returns `null`,
 *   which the sweeper reads as "not known yet" and acts on by doing nothing.
 *   An outage must never be able to confirm — or to permanently reject —
 *   anything.
 * - It never returns a hash it saw redeemed by TWO different transactions.
 *   A settlement child carries an exact-amount caveat and cannot legitimately
 *   be redeemed twice, so a second sighting is a fact we do not understand;
 *   the entry is poisoned to `AMBIGUOUS` and the sweeper refuses it.
 * - It applies no other judgement. Whether a discovered transaction may confirm
 *   a payment is decided downstream by the full verifier (checks 1–8) and the
 *   database's replay and ambiguity guards, exactly as for an agent-reported
 *   hash. This module only proposes candidates.
 */
import { ethers } from 'ethers'
import { hashDelegation } from '@metamask/smart-accounts-kit/utils'
import { getProvider } from '../../rails/allowance-module.js'
import { getDelegationContracts } from '../../rails/delegation-contracts.js'

/**
 * The pinned DelegationManager's redemption event (#2094). The `Delegation`
 * tuple is emitted in full and NOT indexed, so the struct can be decoded and
 * re-hashed rather than merely matched on a topic.
 */
export const REDEEMED_DELEGATION_IFACE = new ethers.Interface([
  'event RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, ' +
    '(address delegate,address delegator,bytes32 authority,' +
    '(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature) delegation)',
])

/** `topics[0]` of the event above — the `eth_getLogs` filter for the scan. */
export const REDEEMED_DELEGATION_TOPIC =
  REDEEMED_DELEGATION_IFACE.getEvent('RedeemedDelegation')!.topicHash

/** A log shape both `ethers.Log` and a plain receipt log satisfy. */
export interface DecodableLog {
  address: string
  topics: readonly string[]
  data: string
}

/**
 * The lowercased delegation hash a `RedeemedDelegation` log names, or `null`
 * when the log is not one / cannot be re-hashed.
 *
 * `signature` is excluded from the hash by construction (`hashDelegation`
 * hashes the EIP-712 struct, which has no signature member), so the emitted
 * struct re-hashes to exactly what `buildSettlementDelegation` stored.
 *
 * Returning `null` rather than throwing is load-bearing in both callers: a
 * struct the kit cannot hash tells us nothing, and must not be able to turn
 * into either a match or a refusal.
 */
export function delegationHashFromLog(log: DecodableLog): string | null {
  let parsed: ethers.LogDescription | null = null
  try {
    parsed = REDEEMED_DELEGATION_IFACE.parseLog({ topics: [...log.topics], data: log.data })
  } catch {
    return null // some other event on this contract
  }
  if (parsed?.name !== 'RedeemedDelegation') return null
  const d = parsed.args.delegation
  try {
    return hashDelegation({
      delegate: d.delegate,
      delegator: d.delegator,
      authority: d.authority,
      caveats: d.caveats.map((c: { enforcer: string; terms: string; args: string }) => ({
        enforcer: c.enforcer,
        terms: c.terms,
        args: c.args,
      })),
      salt: d.salt,
      signature: '0x',
    } as never).toLowerCase()
  } catch {
    return null
  }
}

/**
 * A delegation hash seen redeemed by more than one distinct transaction. Never
 * expected — the exact-amount caveat makes a settlement child single-use — so
 * it is surfaced as a refusal rather than resolved by picking one.
 */
export const AMBIGUOUS = Symbol('ambiguous redemption')

export type RedemptionIndex = Map<string, string | typeof AMBIGUOUS>

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
 * Every delegation hash the pinned DelegationManager reports having redeemed in
 * `[fromBlock, toBlock]`, mapped to the transaction that redeemed it.
 *
 * Returns `null` — and ONLY `null` — when the chain could not be read, or when
 * no manager is pinned for this chain. An empty map means "the manager redeemed
 * nothing in this range", which is a real answer; `null` is "we could not ask",
 * which is not. Collapsing the two is the mistake this signature exists to make
 * impossible, because one of them is retryable and the other is a fact.
 *
 * ## Query shape and cost
 *
 * One `eth_getLogs` per batch, filtered by `address` (the pinned manager) and
 * `topics[0]` (the redemption event) — the two filters every provider indexes.
 * The `rootDelegator` topic is deliberately NOT used to narrow further: it
 * would be a correctness assumption (that the chain's root delegator is always
 * the payer smart account) bought for a cost saving, and a wrong assumption
 * there fails SILENTLY as "no candidate found". The block range is what bounds
 * this scan, and it is bounded by the caller from the settlement windows of the
 * candidates it actually holds.
 */
export async function scanRedeemedDelegations(
  chainId: number,
  range: ScanRange,
  options: ScanOptions,
): Promise<RedemptionIndex | null> {
  let manager: string
  try {
    manager = getDelegationContracts(chainId).delegationManager
  } catch {
    return null // no manager pinned for this chain — nothing to read
  }

  const index: RedemptionIndex = new Map()
  let cursor = Math.max(0, range.fromBlock)
  let batches = 0

  while (cursor <= range.toBlock && batches < options.maxBatches) {
    const to = Math.min(range.toBlock, cursor + options.batchBlocks - 1)
    let logs: Array<{ address: string; topics: readonly string[]; data: string; transactionHash: string }>
    try {
      const provider = getProvider(chainId)
      logs = (await provider.getLogs({
        address: manager,
        topics: [REDEEMED_DELEGATION_TOPIC],
        fromBlock: cursor,
        toBlock: to,
      })) as never
    } catch {
      // A partial index is worse than none: the sweeper would read "hash absent"
      // as "not settled yet" for everything the failed batch would have carried,
      // which is indistinguishable from a real negative. Abandon the whole scan
      // and let the next tick redo it.
      return null
    }

    for (const log of logs) {
      const hash = delegationHashFromLog(log)
      if (!hash) continue
      const existing = index.get(hash)
      if (existing === undefined) {
        index.set(hash, log.transactionHash)
      } else if (existing !== AMBIGUOUS && existing.toLowerCase() !== log.transactionHash.toLowerCase()) {
        index.set(hash, AMBIGUOUS)
      }
    }

    cursor = to + 1
    batches += 1
  }

  return index
}
