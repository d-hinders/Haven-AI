/**
 * AllowanceModule contract interaction for the Haven backend.
 *
 * Provides on-chain reads (allowance state, transfer hash generation),
 * signature verification, and transaction execution via relayer.
 */

import { ethers } from 'ethers'

// ── Constants ─────────────────────────────────────────────────────

export const ALLOWANCE_MODULE_ADDRESS = '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// ── ABI Fragments ─────────────────────────────────────────────────

const ALLOWANCE_MODULE_ABI = [
  'function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])',
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

// ── Provider / Relayer Setup ──────────────────────────────────────

let _provider: ethers.JsonRpcProvider | null = null
let _relayerWallet: ethers.Wallet | null = null

export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(
      process.env.RPC_URL ?? 'https://rpc.gnosischain.com',
    )
  }
  return _provider
}

export function getRelayerWallet(): ethers.Wallet {
  if (!_relayerWallet) {
    const key = process.env.RELAYER_PRIVATE_KEY
    if (!key) {
      throw new Error('RELAYER_PRIVATE_KEY environment variable is not set')
    }
    _relayerWallet = new ethers.Wallet(key, getProvider())
  }
  return _relayerWallet
}

function getContract(signerOrProvider?: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(
    ALLOWANCE_MODULE_ADDRESS,
    ALLOWANCE_MODULE_ABI,
    signerOrProvider ?? getProvider(),
  )
}

// ── Read Functions ────────────────────────────────────────────────

/**
 * Read the on-chain allowance state for a delegate + token pair.
 * Returns: [amount, spent, resetTimeMin, lastResetMin, nonce]
 */
export async function getTokenAllowance(
  safe: string,
  delegate: string,
  token: string,
): Promise<AllowanceInfo> {
  const contract = getContract()
  // Token address for native (xDAI) is the zero address
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
 * Compute effective remaining allowance accounting for reset logic.
 * Mirrors the frontend's computeEffectiveAllowance.
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
    // Reset period has elapsed — spent is effectively 0
    return { remaining: info.amount, effectiveSpent: 0n, isResetPending: true }
  }

  const remaining = info.amount > info.spent ? info.amount - info.spent : 0n
  return { remaining, effectiveSpent: info.spent, isResetPending: false }
}

// ── Hash & Signature ──────────────────────────────────────────────

/**
 * Call the on-chain generateTransferHash view function.
 * This returns the exact hash the delegate must sign.
 */
export async function generateTransferHash(
  safe: string,
  token: string,
  to: string,
  amount: bigint,
  paymentToken: string,
  payment: bigint,
  nonce: number,
): Promise<string> {
  const contract = getContract()
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
 * The AllowanceModule's checkSignature uses ecrecover(hash, v, r, s)
 * directly (no Ethereum signed message prefix).
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
  safe: string,
  token: string,
  to: string,
  amount: bigint,
  paymentToken: string,
  payment: bigint,
  delegate: string,
  signature: string,
): Promise<{ txHash: string }> {
  const relayer = getRelayerWallet()
  const contract = getContract(relayer)

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
