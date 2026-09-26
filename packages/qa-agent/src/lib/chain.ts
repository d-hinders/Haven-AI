/**
 * The chain facts the harness reads directly, in one place (#1530).
 *
 * These were duplicated across six scenario files. That is the same defect
 * #1526 fixed twice in one day — a rule kept by hand in N places has drifted
 * in at least one of them — and the preflight needed them too, so the choice
 * was to consolidate or to add a seventh copy.
 *
 * Testnet only. The harness runs against Base Sepolia by construction; a
 * mainnet address here would be a bug, not a configuration option.
 */

import { ethers } from 'ethers'

/**
 * The RPC node the harness OBSERVES through — the endpoint every on-chain
 * assertion in this suite reads (#2511).
 *
 * Default: the Base Sepolia public endpoint. Overridable with
 * `QA_RPC_URL_BASE_SEPOLIA` so an operator can move the observer to a
 * dedicated provider node when the public endpoint degrades.
 *
 * This is deliberately a SEPARATE knob from the backend's
 * `RPC_URL_BASE_SEPOLIA`: the harness deliberately reads a SECOND node (the
 * backend writes through its own `RPC_URL_BASE_SEPOLIA`), so an on-chain
 * assertion verified on the node the backend wrote through would only prove
 * the backend agrees with itself. Pointing both at the same endpoint would
 * quietly delete that independence — if you set this variable, set it to a
 * node the backend does NOT write through.
 */
export const BASE_SEPOLIA_RPC =
  process.env.QA_RPC_URL_BASE_SEPOLIA?.trim() || 'https://sepolia.base.org'

/**
 * Which observer node this run is watching, by CLASS — never by value (#2511).
 *
 * A provider URL embeds an API key (`…/v2/<KEY>`), so the endpoint itself must
 * never reach a log, a report or an issue body. What a triager actually needs
 * is one bit: was this run watching the shared public endpoint, whose outages
 * arrive as scenario failures rather than as Haven defects, or a dedicated one.
 *
 * It exists as a function rather than an inline ternary in `run.ts` so the
 * secret-safety property can be ASSERTED. The wiring it reports on was
 * unreachable from CI between PR #2553 and #2511 — `chain.ts` read the variable
 * and `qa-dev.yml` never passed it — and the reason nobody noticed is that a
 * set variable and an unset one produced identical logs.
 */
export function describeObserverRpc(raw = process.env.QA_RPC_URL_BASE_SEPOLIA): string {
  return raw?.trim()
    ? 'dedicated (QA_RPC_URL_BASE_SEPOLIA set)'
    : `PUBLIC ${'https://sepolia.base.org'} — outages here read as scenario failures`
}

/** Base Sepolia USDC — the asset every money-flow leg moves. */
export const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

/** Base Sepolia chain id. */
export const BASE_SEPOLIA_CHAIN_ID = 84532

/** Read-only ERC-20 surface; the harness never writes through this. */
export const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'] as const

/** USDC has 6 decimals; kept here so no caller re-derives it. */
export const USDC_DECIMALS = 6

// ── Reads the harness makes on the OBSERVER node (#3344) ─────────────────────
//
// Two gating legs used to claim an on-chain effect they never read from any
// node: `within-budget-settle` trusted the payment record's `confirmed`, and
// `delegation-lifecycle` trusted `revoked: true`. A backend defect that records
// the state without the chain effect then still passed the harness that gates
// promotion (#2968, #3294, #1754 are that class). These helpers read the chain
// itself, on the harness's own node — never the backend's.


/** DelegationManager on Base Sepolia (backend `rails/delegation-contracts.ts`). */
export const DELEGATION_MANAGER_BASE_SEPOLIA = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'

const DISABLED_DELEGATIONS_ABI = ['function disabledDelegations(bytes32) view returns (bool)'] as const
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

/** The observer node as an ethers provider. One per call: the harness is short-lived. */
export function observerProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)
}

/** The minimal read surface these helpers use, so tests can pass a fake. */
export interface ReceiptReader {
  getTransactionReceipt(hash: string): Promise<ethers.TransactionReceipt | null>
}

/**
 * Wait for a transaction receipt, tolerating an observer that has not yet
 * indexed a just-mined tx. Returns null on timeout; the caller names the leg.
 * The one copy (#3344) — two scenarios carried their own before.
 */
export async function waitForReceipt(
  provider: ReceiptReader,
  hash: string,
  { timeoutMs, intervalMs = 3_000 }: { timeoutMs: number; intervalMs?: number },
): Promise<ethers.TransactionReceipt | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const receipt = await provider.getTransactionReceipt(hash).catch(() => null)
    if (receipt) return receipt
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Every USDC `Transfer` in a receipt, decoded. */
export function usdcTransfers(receipt: Pick<ethers.TransactionReceipt, 'logs'>): Array<{ from: string; to: string; value: bigint }> {
  const out: Array<{ from: string; to: string; value: bigint }> = []
  for (const log of receipt.logs ?? []) {
    if (log.address?.toLowerCase() !== SEPOLIA_USDC.toLowerCase()) continue
    if (log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue
    out.push({
      from: ethers.getAddress(ethers.dataSlice(log.topics[1], 12)),
      to: ethers.getAddress(ethers.dataSlice(log.topics[2], 12)),
      value: BigInt(log.data),
    })
  }
  return out
}

/**
 * Prove a settlement on the observer: the receipt exists, has status 1, and
 * carries the exact USDC `Transfer(from → to, amount)`.
 *
 * `status` alone is not proof. On the delegation rail the tx hash Haven records
 * is the ERC-4337 bundler transaction (`waitForUserOperationReceipt`), and a
 * user operation whose inner call reverts still leaves that transaction at
 * status 1. The Transfer log is the money moving.
 */
export async function proveUsdcTransfer(
  txHash: string,
  expected: { from: string; to: string; amount: bigint },
  { timeoutMs, intervalMs, provider = observerProvider() }: { timeoutMs: number; intervalMs?: number; provider?: ReceiptReader },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const receipt = await waitForReceipt(provider, txHash, { timeoutMs, intervalMs })
  if (!receipt) {
    return { ok: false, error: `no receipt for ${txHash} on the observer node within ${Math.round(timeoutMs / 1000)}s (observer: ${describeObserverRpc()})` }
  }
  if (receipt.status !== 1) return { ok: false, error: `receipt ${txHash} has status ${receipt.status} on the observer node` }
  const seen = usdcTransfers(receipt)
  const match = seen.find(
    (t) => t.from.toLowerCase() === expected.from.toLowerCase() && t.to.toLowerCase() === expected.to.toLowerCase() && t.value === expected.amount,
  )
  if (match) return { ok: true }
  const saw = seen.length ? seen.map((t) => `${t.from}→${t.to} ${t.value}`).join(', ') : 'none'
  return {
    ok: false,
    error:
      `receipt ${txHash} (status 1) carries no USDC Transfer ${expected.from}→${expected.to} of ${expected.amount} ` +
      `(USDC transfers in it: ${saw}) — a 4337 user operation whose inner call reverted still leaves the bundler tx at status 1`,
  }
}

/** One read of `DelegationManager.disabledDelegations(hash)` at `latest` on the observer. */
export function readDisabled(hash: string): Promise<boolean> {
  return new ethers.Contract(DELEGATION_MANAGER_BASE_SEPOLIA, DISABLED_DELEGATIONS_ABI, observerProvider()).disabledDelegations(hash, {
    blockTag: 'latest',
  }) as Promise<boolean>
}

/**
 * Wait until the DelegationManager reports a delegation hash as disabled, read
 * at `latest` on the observer (which can lag the node the backend wrote to).
 * `read` is injectable for tests; the default is the real contract read.
 */
export async function waitForDisabled(
  delegationHash: string,
  {
    timeoutMs,
    intervalMs = 3_000,
    read = readDisabled,
  }: { timeoutMs: number; intervalMs?: number; read?: (hash: string) => Promise<boolean> },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const deadline = Date.now() + timeoutMs
  let last: string = 'no read yet'
  for (;;) {
    try {
      if ((await read(delegationHash)) === true) return { ok: true }
      last = 'disabledDelegations returned false'
    } catch (err) {
      last = `read failed: ${(err as Error)?.message ?? err}`
    }
    if (Date.now() >= deadline) {
      return { ok: false, error: `delegation ${delegationHash} is not disabled on-chain after ${Math.round(timeoutMs / 1000)}s (${last}; observer: ${describeObserverRpc()})` }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
