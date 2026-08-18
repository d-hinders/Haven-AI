/**
 * AllowanceModule contract interaction for the Haven backend.
 *
 * Provides on-chain reads (allowance state, transfer hash generation),
 * signature verification, and transaction execution via relayer.
 *
 * All functions accept a chainId to select the correct RPC and contract addresses.
 */

import { assertRelayerBudget, recordRelayerSpend, finishRelayerSpend, type RelayerAttribution } from '../infra/relayer-spend-guard.js'
import { ethers } from 'ethers'
import { config } from '../config.js'
import { getChain } from '../domain/chains.js'
import { recordAllowanceNonce } from './allowance-nonce-coordinator.js'
import {
  withRelayerSendLock,
  getRelayerFeeOverrides,
  getRelayer,
  getProvider as getRelayerProvider,
} from '../infra/relayer.js'

// ── Constants ─────────────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// ── ABI Fragments ─────────────────────────────────────────────────

const ALLOWANCE_MODULE_ABI = [
  'function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])',
  'function getTokens(address safe, address delegate) view returns (address[])',
  'function generateTransferHash(address safe, address token, address to, uint96 amount, address paymentToken, uint96 payment, uint16 nonce) view returns (bytes32)',
  'function executeAllowanceTransfer(address safe, address token, address payable to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)',
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

function getContract(chainId: number, signerOrProvider?: ethers.Signer | ethers.Provider) {
  const chain = getChain(chainId)
  return new ethers.Contract(
    chain.contracts.allowanceModule,
    ALLOWANCE_MODULE_ABI,
    signerOrProvider ?? getProvider(chainId),
  )
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

// ── Hash & Signature ──────────────────────────────────────────────

/**
 * Call the on-chain generateTransferHash view function.
 */
export async function generateTransferHash(
  chainId: number,
  safe: string,
  token: string,
  to: string,
  amount: bigint,
  paymentToken: string,
  payment: bigint,
  nonce: number,
): Promise<string> {
  const contract = getContract(chainId)
  return contract.generateTransferHash(
    safe,
    token,
    to,
    amount,
    paymentToken,
    payment,
    nonce,
  )
}

/**
 * Recover the signer address from a raw ECDSA signature over a hash.
 */
export function recoverSigner(hash: string, signature: string): string {
  return ethers.recoverAddress(hash, signature)
}

// ── Transaction Execution ─────────────────────────────────────────

/**
 * Execute an allowance transfer via the relayer wallet.
 * The relayer pays gas; the delegate's signature authorises the transfer.
 */
export async function executeAllowanceTransfer(
  chainId: number,
  safe: string,
  token: string,
  to: string,
  amount: bigint,
  paymentToken: string,
  payment: bigint,
  delegate: string,
  signature: string,
  /** #717: who this transfer is billed to (relayer gas budget + attribution). */
  attribution?: RelayerAttribution,
): Promise<{ txHash: string }> {
  // #717: budget check before any relayer work — over-cap throws
  // RelayerBudgetExceededError (routes map it to 429).
  await assertRelayerBudget('allowance_transfer', attribution ?? {})
  const relayer = getRelayerWallet(chainId)
  const contract = getContract(chainId, relayer)
  const args = [safe, token, to, amount, paymentToken, payment, delegate, signature] as const

  // Preflight (#692): a stale allowance nonce — the signature was built against a
  // nonce a prior transfer already consumed (cross-RPC propagation) — makes
  // executeAllowanceTransfer revert with no reason. Static-call first so a doomed
  // transfer never lands or burns gas. This turns a masked "On-chain execution
  // failed" into a clear, retry-safe error: nothing was submitted, so re-reading
  // the nonce and re-signing cannot double-spend.
  try {
    await contract.executeAllowanceTransfer.staticCall(...args)
  } catch {
    throw new Error(
      'Allowance transfer would revert before submission — likely a stale allowance ' +
        'nonce; re-read the allowance and re-sign before retrying.',
    )
  }

  const provider = relayer.provider
  if (!provider) {
    throw new Error(`Relayer provider not configured for chain ${chainId}`)
  }

  // Broadcast under the per-chain send lock so concurrent transfers can't
  // populate the same relayer EOA nonce (#692/#718). Explicit fee headroom so
  // a base-fee spike can't strand the tx and block the nonce lane. The
  // confirmation wait below stays OUTSIDE the lock — only the nonce-read→
  // broadcast window is exclusive.
  // #717: the attempt row lands BEFORE broadcast so concurrent bursts see
  // each other in the count; the receipt stamps it below.
  const spendId = await recordRelayerSpend({
    operation: 'allowance_transfer',
    chainId,
    agentId: attribution?.agentId,
    userId: attribution?.userId,
  })
  const tx = await withRelayerSendLock(chainId, async () => {
    const feeOverrides = await getRelayerFeeOverrides(provider)
    return contract.executeAllowanceTransfer(...args, feeOverrides)
  })

  // tx.wait() can return null on a lagging RPC even when the tx confirmed (#690);
  // poll by hash with a timeout, then assert it didn't revert. The nonce is then
  // confirmed-visible on this provider for the next transfer's read.
  const receipt = await provider.waitForTransaction(tx.hash, 1, 90_000)
  await finishRelayerSpend(spendId, {
    txHash: tx.hash,
    gasUsed: receipt ? BigInt(receipt.gasUsed.toString()) : null,
    effectiveGasPrice: receipt?.gasPrice != null ? BigInt(receipt.gasPrice.toString()) : null,
  })
  if (!receipt) {
    throw new Error(`Allowance transfer ${tx.hash} not confirmed within 90s`)
  }
  if (receipt.status === 0) {
    throw new Error(`Allowance transfer ${tx.hash} reverted`)
  }

  // Record the post-transfer nonce so the next build for this delegate waits for
  // it to be visible before signing, avoiding the stale-nonce race (#692).
  // Best-effort — never fail a confirmed transfer over the bookkeeping read.
  try {
    const { nonce } = await getTokenAllowance(chainId, safe, delegate, token)
    recordAllowanceNonce(chainId, safe, delegate, token, nonce)
  } catch {
    // The preflight + retry still cover a stale next-read.
  }
  return { txHash: tx.hash }
}
