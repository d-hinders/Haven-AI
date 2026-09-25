import { JsonRpcProvider, Wallet, formatEther, parseEther, type Provider } from 'ethers'
import { relayerPrivateKeyForChain } from '../config.js'
import { getChain } from '../domain/chains.js'
import { secondaryRpcUrl } from './chain/rpc-transport.js'

const providers = new Map<number, JsonRpcProvider>()
const relayers = new Map<number, Wallet>()

// ── Per-chain send serialisation (#692/#718; role narrowed by #1559) ─────────
//
// The relayer EOA's nonce is strictly sequential; two concurrent submissions
// reading the same pending nonce collide and fail one of them. This lock
// serialises the nonce-read→broadcast window per chain, in-process.
// Confirmation waits MUST stay outside it so payments confirm in parallel.
//
// Since #1559 (epic #1554) this is no longer the only — or the main — line of
// defence. Every relayer broadcast goes through `outbound-queue.ts`'s
// `submitRecorded`. The inline submitters (sweep, hybrid deploy, passport
// attest and revoke) and lane cancel pass a record id: sign → STAMP the
// durable row under the partial UNIQUE (chain, nonce) live-broadcast index →
// broadcast, so Postgres arbitrates the nonce lane and a stamped submission is
// cross-replica safe. The bump worker passes a null id — it stamps its own
// rows — and runs under its leader lock: a same-nonce replacement re-uses the
// row's explicit nonce, an orphan re-send reads a fresh one. Here this lock
// is the cheap in-process belt. The Safe-bound sites that once relied on the
// lock alone were deleted with the rail (#1440).
//
// Two paths still pick a FRESH nonce under this lock alone, unstamped:
// an inline submitter whose `openOutboundRecord` failed open (a database
// error, by the policy in `outbound-queue.ts`'s header), and the bump
// worker's orphan re-send (the leader lock serialises bump ticks, not other
// replicas' inline sends). Across replicas either can collide with a stamped
// send — a failed broadcast, not a misdirected one — so multi-replica
// correctness is closed EXCEPT on those two paths.
const sendLocks = new Map<number, Promise<unknown>>()

export async function withRelayerSendLock<T>(
  chainId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sendLocks.get(chainId) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  // The chain entry must never reject, or every later submit would inherit
  // this submit's failure.
  sendLocks.set(chainId, run.catch(() => undefined))
  return run
}

// ── Fee overrides with headroom ───────────────────────────────────

/**
 * Explicit EIP-1559 fee fields with headroom for relayed submissions.
 *
 * Without overrides a tx inherits the provider's point-in-time estimate; a
 * base-fee spike right after leaves it stuck in the mempool, and with no bump
 * path (yet) the stuck tx blocks the relayer's nonce lane — every following
 * payment fails until it clears. Doubling the estimated maxFeePerGas keeps
 * the tx includable through short spikes (the EIP-1559 refund means we never
 * overpay the actual base fee). Returns `{}` on non-1559 responses so legacy
 * gas-price chains keep provider defaults.
 */
export async function getRelayerFeeOverrides(
  provider: Provider,
): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
  const feeData = await provider.getFeeData()
  if (feeData.maxFeePerGas == null || feeData.maxPriorityFeePerGas == null) {
    return {}
  }
  return {
    maxFeePerGas: feeData.maxFeePerGas * 2n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  }
}

/**
 * The ONE provider per chain that backs every relayer submission (#1533).
 *
 * Exported so `infra/chain/relayer-reads.ts` can delegate instead of keeping a
 * second `Map` of its own. Two provider instances for one relayer EOA is how
 * the 2026-08-18 stale-nonce failure happened: `withRelayerSendLock`
 * serialises SUBMISSIONS, but ethers populates each transaction's nonce from
 * the provider the signing wallet is bound to — and two providers only ever
 * observe their own traffic. The wallet bound to one drifted six nonces
 * behind the chain while the other kept submitting. A lock cannot fix nonce
 * provenance; a single view can.
 *
 * #3255 deliberately left this provider OFF the failover transport the viem
 * clients use (`infra/chain/rpc-transport.ts`): a pending transaction
 * broadcast to one node is invisible to a second, and the log scanners and
 * receipt verifier behind `relayer-reads.ts` would read "no log" from a
 * lagging fallback rather than fail. A quota-dead `RPC_URL_BASE*` still fails
 * the ethers side; configuring a healthy endpoint is the remedy there. The one
 * provider refusal handled in code is dRPC's "No label `flashblocks`" (#2769),
 * at two points. On the `pending` nonce read, `readNextRelayerNonce` in
 * `outbound-queue.ts` walks up from this same provider's `latest` count over
 * the live-broadcast ledger. On `eth_sendRawTransaction`, `broadcastSigned`
 * sends the identical signed bytes through the configured second provider
 * (`RPC_URL_BASE*_FALLBACK`), while every read and receipt wait stays here.
 *
 * JSON-RPC batching is OFF (`batchMaxCount: 1`). By default ethers bundles
 * every call made within about 10 ms into ONE request of up to 100 calls.
 * dRPC's free plan, the dev primary since 2026-09-24, refuses any batch over
 * three and returns code 31 on every item ("Batch of more than 3 requests are
 * not allowed on free plan"). Whether a read landed in a large batch depended
 * on what else fired in the same 10 ms. As a result, dashboard balances
 * flickered to zero, and sweep relays and account deploys failed
 * intermittently (#2769). Providers bill per call either way, so batching
 * saved only round trips.
 *
 * `staticNetwork: true` goes with it. Without it, ethers sends an
 * `eth_chainId` before each call, which used to travel inside the same batch.
 * With batching off, that would double the request count on a rate-limited
 * free plan. With it, the chain is detected once, on first use, and then
 * cached.
 */
export function getProvider(chainId: number): JsonRpcProvider {
  let provider = providers.get(chainId)
  if (!provider) {
    provider = newEthersProvider(getChain(chainId).rpcUrl)
    providers.set(chainId, provider)
  }
  return provider
}

/** The ONE place an ethers provider is constructed (`rpc-transport-guard`). */
function newEthersProvider(url: string): JsonRpcProvider {
  return new JsonRpcProvider(url, undefined, { batchMaxCount: 1, staticNetwork: true })
}

const fallbackBroadcastProviders = new Map<number, JsonRpcProvider>()

/**
 * The provider for the chain's configured second endpoint
 * (`RPC_URL_BASE*_FALLBACK`), or null when none is configured (#2769). It is
 * used for ONE thing: re-sending an already signed raw transaction that the
 * primary refused with dRPC's flashblocks error (`broadcastSigned` in
 * `outbound-queue.ts`). The relayer wallet is never bound to it, so it never
 * picks a nonce, signs, or answers a read: the single nonce view above holds.
 */
export function getFallbackBroadcastProvider(chainId: number): JsonRpcProvider | null {
  const url = secondaryRpcUrl(chainId)
  if (!url) return null
  let provider = fallbackBroadcastProviders.get(chainId)
  if (!provider) {
    provider = newEthersProvider(url)
    fallbackBroadcastProviders.set(chainId, provider)
  }
  return provider
}

/**
 * Returns a signer connected to the given chain's RPC, funded by the relayer key
 * for that chain — `RELAYER_PRIVATE_KEY_<chainId>` with a global
 * `RELAYER_PRIVATE_KEY` fallback (#640). This is the signer that submits
 * relayed transactions on that chain — delegator activation, passport
 * attestations and revocations, sweeps, and the outbound queue's own fee bumps
 * and stuck-lane cancels — so it must resolve per chain to honour the
 * per-chain relayer isolation; otherwise a single backend serving multiple
 * chains would submit on every chain with the same key. Agent payments are
 * NOT among them: those are paymaster-sponsored UserOps (`rails/delegation-rail.ts`).
 * Cached per chainId.
 */
export function getRelayer(chainId: number): Wallet {
  let relayer = relayers.get(chainId)
  if (!relayer) {
    const key = relayerPrivateKeyForChain(chainId)
    if (!key) {
      throw new Error(
        `No relayer key for chain ${chainId} — set RELAYER_PRIVATE_KEY_${chainId} or RELAYER_PRIVATE_KEY`,
      )
    }
    relayer = new Wallet(key, getProvider(chainId))
    relayers.set(chainId, relayer)
  }
  return relayer
}

/**
 * Low-water mark shared with the relayer balance monitor — enough native
 * balance for hundreds of transfers on Gnosis/Base at typical fees.
 */
export const RELAYER_LOW_BALANCE_WEI = parseEther('0.01')

export async function warnIfRelayerLow(
  chainId: number,
  minBalanceWei: bigint = RELAYER_LOW_BALANCE_WEI,
): Promise<void> {
  const relayer = getRelayer(chainId)
  const provider = relayer.provider
  if (!provider) {
    throw new Error(`Relayer provider not configured for chain ${chainId}`)
  }
  const balance = await provider.getBalance(relayer.address)

  if (balance < minBalanceWei) {
    console.warn(
      `Relayer balance is low on chain ${chainId}: ${formatEther(balance)} < ${formatEther(minBalanceWei)}`,
    )
  }
}
