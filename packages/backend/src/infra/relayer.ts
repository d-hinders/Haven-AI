import { JsonRpcProvider, Wallet, formatEther, parseEther, type Provider } from 'ethers'
import { relayerPrivateKeyForChain } from '../config.js'
import { getChain } from '../domain/chains.js'

const providers = new Map<number, JsonRpcProvider>()
const relayers = new Map<number, Wallet>()

// ── Per-chain send serialisation (#692/#718 interim fix) ──────────
//
// The relayer EOA's nonce is strictly sequential. Ethers populates it from
// `getTransactionCount(relayer, 'pending')` at submit time, so two concurrent
// submissions — even for unrelated Safes — read the same pending nonce and
// collide ("nonce too low" / "replacement underpriced"), failing one payment.
// Serialise the populate+broadcast window per chain. Confirmation waits MUST
// stay outside the lock so payments still confirm in parallel; only the short
// nonce-read→broadcast section is exclusive. Interim until the durable
// outbound-tx queue lands; in-process only, so multi-replica deployments
// still need one relayer key per replica or the queue.
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

function getProvider(chainId: number): JsonRpcProvider {
  let provider = providers.get(chainId)
  if (!provider) {
    provider = new JsonRpcProvider(getChain(chainId).rpcUrl)
    providers.set(chainId, provider)
  }
  return provider
}

/**
 * Returns a signer connected to the given chain's RPC, funded by the relayer key
 * for that chain — `RELAYER_PRIVATE_KEY_<chainId>` with a global
 * `RELAYER_PRIVATE_KEY` fallback (#640). This is the signer that submits Safe
 * **deploys** and **execTransaction**, so it must resolve per chain to honour the
 * per-chain relayer isolation; otherwise a single backend serving multiple chains
 * would deploy/exec on every chain with the same key (e.g. a prod Base Sepolia
 * deploy run by the mainnet relayer key → unfunded on Sepolia). Cached per chainId.
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
