/**
 * AllowanceModule contract bindings for the Haven backend — READS ONLY.
 *
 * **The execution half is deleted (#1987, epic #1440 slice 4.)** The Safe /
 * AllowanceModule rail is retired: #1986 made every agent-payment entry point
 * fail closed with HTTP 410, and this slice removed the code those entry
 * points used to reach — `executeAllowanceTransfer`, `generateTransferHash`
 * and `recoverSigner`, together with the `executeAllowanceTransfer` ABI
 * fragment and the relayer spend-guard / send-lock / allowance-nonce wiring
 * they needed. Nothing in this module can move a token any more.
 *
 * **Why the file survives rather than going with the rail.** Three of its
 * exports are not AllowanceModule code at all — `getProvider` and
 * `getRelayerWallet` are one-line delegations to `infra/relayer.ts` (#1533,
 * one nonce view per chain) and `getTokenBalance` is a generic native/ERC-20
 * balance read. They are shared with machinery the owner decision in #834
 * keeps alive while any funding-leg rail lives: sweep, the delegate-balance
 * monitor, and the #946 EIP-3009 bridge. Deliberately NOT re-homed here: that
 * is a refactor of live shared infrastructure, not a deletion, and it does
 * not belong in a money-path deletion slice. It is residue for #1993 once the
 * remaining read consumers go with #1989/#1992.
 *
 * The four remaining CONTRACT reads are live on purpose, not oversight:
 * `getTokenAllowance`, `getLatestBlockTimeSec`, `computeEffectiveAllowance`
 * and `getTokensForDelegate` back two surfaces #1986 deliberately left open —
 * `GET /machine-payments/allowances` (the epic's "accounts and history stay
 * READABLE" boundary; a report of spend authority, which grants and exercises
 * none) and `routes/agent-connection-setups.ts`'s legacy wallet-approval
 * authority check. Both are reads. Neither can spend.
 *
 * All functions accept a chainId to select the correct RPC and contract addresses.
 */

import { ethers } from 'ethers'
import { getChain } from '../domain/chains.js'
import { getRelayer, getProvider as getRelayerProvider } from '../infra/relayer.js'

// ── Constants ─────────────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// ── ABI Fragments ─────────────────────────────────────────────────

const ALLOWANCE_MODULE_ABI = [
  'function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])',
  'function getTokens(address safe, address delegate) view returns (address[])',
]

// Minimal ABI for the pre-flight balance read. Pulled out of any
// IERC20 import so this module stays dependency-light.
const ERC20_BALANCE_OF_ABI = [
  'function balanceOf(address) view returns (uint256)',
]

// ── Types ─────────────────────────────────────────────────────────

export interface AllowanceInfo {
  amount: bigint
  spent: bigint
  resetTimeMin: number
  lastResetMin: number
  nonce: number
}

export interface EffectiveAllowance {
  remaining: bigint
  effectiveSpent: bigint
  isResetPending: boolean
}

// ── Provider / Relayer Setup — DELEGATED, deliberately (#1533) ────
//
// This module used to keep its own `Map` of providers and relayer wallets,
// parallel to `infra/relayer.ts`'s. Same key, same EOA — two provider
// instances, each with an independent view of that EOA's pending nonce.
// `withRelayerSendLock` (shared) serialises submissions, but ethers takes
// each transaction's nonce from the provider its signing wallet is bound to,
// so the wallet bound to the less-trafficked provider submitted a nonce six
// behind the chain on 2026-08-18 (`nonce too low: next nonce 781, tx nonce
// 775` — the on-chain sequence was strictly sequential, so the stale view
// was ours, not the RPC's). The exports stay because eight modules import
// them; the instances they return are now the ONLY ones per chain.

export function getProvider(chainId: number): ethers.JsonRpcProvider {
  return getRelayerProvider(chainId)
}

/** The same instance `infra/relayer.ts` signs with — one nonce view per chain. */
export function getRelayerWallet(chainId: number): ethers.Wallet {
  return getRelayer(chainId)
}

/**
 * #1987: the optional `signerOrProvider` parameter went with
 * `executeAllowanceTransfer` — it existed only so the relayer wallet could be
 * bound for a WRITE. Every remaining caller is a read, so the provider is no
 * longer a choice.
 */
function getContract(chainId: number) {
  const chain = getChain(chainId)
  return new ethers.Contract(chain.contracts.allowanceModule, ALLOWANCE_MODULE_ABI, getProvider(chainId))
}

// ── Read Functions ────────────────────────────────────────────────

/**
 * Read the on-chain allowance state for a delegate + token pair.
 * Returns: [amount, spent, resetTimeMin, lastResetMin, nonce]
 */
export async function getTokenAllowance(
  chainId: number,
  safe: string,
  delegate: string,
  token: string,
): Promise<AllowanceInfo> {
  const contract = getContract(chainId)
  const tokenAddr = token || ZERO_ADDRESS
  const result: bigint[] = await contract.getTokenAllowance(safe, delegate, tokenAddr)
  return {
    amount: result[0],
    spent: result[1],
    resetTimeMin: Number(result[2]),
    lastResetMin: Number(result[3]),
    nonce: Number(result[4]),
  }
}

/**
 * Read an on-chain token balance for an arbitrary holder.
 *
 * Used by the x402 pre-flight check to decide whether the delegate EOA
 * already holds enough of the requested token to pay the merchant. Native
 * balances (`token === ZERO_ADDRESS`) are read directly from the provider;
 * ERC-20 balances use a minimal `balanceOf` ABI to avoid pulling in a heavy
 * IERC20 import for what is otherwise a single read.
 */
export async function getTokenBalance(
  chainId: number,
  holder: string,
  token: string,
): Promise<bigint> {
  const provider = getProvider(chainId)
  if (!token || token === ZERO_ADDRESS) {
    return await provider.getBalance(holder)
  }
  const contract = new ethers.Contract(token, ERC20_BALANCE_OF_ABI, provider)
  const balance: bigint = await contract.balanceOf(holder)
  return balance
}

/**
 * Read the latest block timestamp (seconds) for a chain.
 *
 * This is the clock source for allowance reset decisions: it mirrors the
 * `block.timestamp` the AllowanceModule will see when it applies its reset
 * branch, unlike the relayer's wall clock (`Date.now()`) which can drift from
 * chain time and flip the routing decision near a reset boundary.
 */
export async function getLatestBlockTimeSec(chainId: number): Promise<number> {
  const provider = getProvider(chainId)
  const block = await provider.getBlock('latest')
  if (!block) {
    throw new Error('Failed to read latest block for allowance reset timing')
  }
  return Number(block.timestamp)
}

/**
 * Read every token slot configured for a delegate on a Safe.
 */
export async function getTokensForDelegate(
  chainId: number,
  safe: string,
  delegate: string,
): Promise<string[]> {
  const contract = getContract(chainId)
  const result: string[] = await contract.getTokens(safe, delegate)
  return result
}

/**
 * Compute effective remaining allowance accounting for the AllowanceModule's
 * reset logic.
 *
 * `nowSec` MUST be chain time — a block `timestamp` in seconds, e.g. from
 * `getLatestBlockTimeSec` — NOT the relayer's wall clock. The on-chain reset
 * branch keys off `block.timestamp`; deciding auto-execute-vs-queue against
 * `Date.now()` lets server clock skew flip the decision near a reset boundary
 * (skew ahead → false auto-execute → on-chain revert; skew behind → a valid
 * in-budget payment is needlessly queued).
 */
export function computeEffectiveAllowance(
  info: AllowanceInfo,
  nowSec: number,
): EffectiveAllowance {
  if (info.resetTimeMin === 0) {
    const remaining = info.amount > info.spent ? info.amount - info.spent : 0n
    return { remaining, effectiveSpent: info.spent, isResetPending: false }
  }

  const lastResetSec = info.lastResetMin * 60
  const resetPeriodSec = info.resetTimeMin * 60

  if (nowSec >= lastResetSec + resetPeriodSec) {
    return { remaining: info.amount, effectiveSpent: 0n, isResetPending: true }
  }

  const remaining = info.amount > info.spent ? info.amount - info.spent : 0n
  return { remaining, effectiveSpent: info.spent, isResetPending: false }
}
