/**
 * A settled chain vantage point (#3293, extracted from
 * `modules/passport/attestation.ts`, where #1745 and #1758 introduced it).
 * Lives in `infra/chain/` so the outbound bump worker and the passport probes
 * share one definition of "a block whose state will not be un-shown".
 */

/**
 * How far back chain state is read when the node cannot name a finalized
 * block.
 *
 * A fallback, not the preferred path. Base and Base Sepolia are OP-stack and
 * expose `finalized`, which is the honest answer; this exists so a provider
 * that does not understand the tag degrades to something conservative rather
 * than to reading the head. At 2 s blocks this is ~10 minutes of burial,
 * comfortably past any ordinary reorg, and the latency costs nothing for
 * any reader: each is judging a transaction that has already been stuck for
 * minutes.
 *
 * Three readers share it, and deliberately so: #1745's nonce read (is the
 * attest still mineable), #1758's revocation read (is the attestation revoked)
 * and #3293's bump-worker nonce read (was this row's nonce consumed by another
 * transaction).
 * They ask different questions of the chain but need the identical property
 * from the vantage point — that what it shows will not be un-shown — so a
 * second constant would be the same number argued twice.
 */
export const SETTLED_CHAIN_READ_DEPTH_BLOCKS = 300

/**
 * A block old enough that what it shows will not be un-shown — a nonce
 * consumed as of it stays consumed, an attestation revoked as of it stays
 * revoked.
 *
 * Returns null when no such vantage point exists (a chain shorter than the
 * fallback depth), which every caller reads as "no evidence" — never as a
 * conclusion.
 *
 * The `finalized` result is sanity-checked against the head rather than
 * trusted: a node that does not implement the tag may echo the latest block
 * back, and silently reading the head is precisely the reorg exposure this
 * function exists to remove.
 */
export async function settledReadBlock(provider: {
  getBlockNumber: () => Promise<number>
  getBlock: (tag: string) => Promise<{ number: number } | null>
}): Promise<number | null> {
  const head = await provider.getBlockNumber()
  try {
    const finalized = await provider.getBlock('finalized')
    if (finalized && finalized.number < head) return finalized.number
  } catch {
    // Tag unsupported — fall through to the depth fallback.
  }
  const buried = head - SETTLED_CHAIN_READ_DEPTH_BLOCKS
  return buried > 0 ? buried : null
}
