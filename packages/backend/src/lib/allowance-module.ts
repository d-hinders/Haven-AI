/**
 * AllowanceModule contract interaction for the Haven backend.
 *
 * Provides on-chain reads (allowance state, transfer hash generation),
 * signature verification, and transaction execution via relayer.
 *
 * All functions accept a chainId to select the correct RPC and contract addresses.
 */

import { ethers } from 'ethers'
import { config, relayerPrivateKeyForChain } from '../config.js'
import { getChain } from './chains.js'

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

// ── Provider / Relayer Setup (per-chain, cached) ──────────────────

const providers = new Map<number, ethers.JsonRpcProvider>()
const relayerWallets = new Map<number, ethers.Wallet>()

export function getProvider(chainId: number): ethers.JsonRpcProvider {
  let provider = providers.get(chainId)
  if (!provider) {
    const chain = getChain(chainId)
    provider = new ethers.JsonRpcProvider(chain.rpcUrl)
    providers.set(chainId, provider)
  }
  return provider
}

export function getRelayerWallet(chainId: number): ethers.Wallet {
  let wallet = relayerWallets.get(chainId)
  if (!wallet) {
    // Per-chain key (RELAYER_PRIVATE_KEY_<chainId>) with global fallback, so a
    // single backend can run isolated relayers per chain (#640).
    const key = relayerPrivateKeyForChain(chainId)
    if (!key) {
      throw new Error(
        `No relayer key for chain ${chainId} — set RELAYER_PRIVATE_KEY_${chainId} or RELAYER_PRIVATE_KEY`,
      )
    }
    wallet = new ethers.Wallet(key, getProvider(chainId))
    relayerWallets.set(chainId, wallet)
  }
  return wallet
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
): Promise<{ txHash: string }> {
  const relayer = getRelayerWallet(chainId)
  const contract = getContract(chainId, relayer)

  const tx = await contract.executeAllowanceTransfer(
    safe,
    token,
    to,
    amount,
    paymentToken,
    payment,
    delegate,
    signature,
  )

  const receipt = await tx.wait()
  return { txHash: receipt.hash }
}
