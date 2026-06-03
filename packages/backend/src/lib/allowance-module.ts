/**
 * AllowanceModule contract interaction for the Haven backend.
 *
 * Provides on-chain reads (allowance state, transfer hash generation),
 * signature verification, and transaction execution via relayer.
 *
 * All functions accept a chainId to select the correct RPC and contract addresses.
 */

import { ethers } from 'ethers'
import { config } from '../config.js'
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
    const key = config.relayerPrivateKey
    if (!key) {
      throw new Error('RELAYER_PRIVATE_KEY environment variable is not set')
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
 * Compute effective remaining allowance accounting for reset logic.
 */
export function computeEffectiveAllowance(info: AllowanceInfo): EffectiveAllowance {
  if (info.resetTimeMin === 0) {
    const remaining = info.amount > info.spent ? info.amount - info.spent : 0n
    return { remaining, effectiveSpent: info.spent, isResetPending: false }
  }

  const lastResetSec = info.lastResetMin * 60
  const resetPeriodSec = info.resetTimeMin * 60
  const nowSec = Math.floor(Date.now() / 1000)

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
