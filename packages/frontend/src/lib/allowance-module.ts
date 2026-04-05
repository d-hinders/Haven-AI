/**
 * Safe AllowanceModule integration for Haven agent spending limits.
 *
 * The AllowanceModule allows Safe owners to set up delegates (EOAs) that can
 * spend specific tokens up to defined allowances with optional reset periods.
 *
 * Haven uses this as the on-chain enforcement layer for agent spending limits.
 * All write operations go through Safe's execTransaction (owner signs).
 * The delegate (agent) can then spend via executeAllowanceTransfer.
 */

import {
  encodeFunctionData,
  concat,
  pad,
  numberToHex,
  type Address,
  type PublicClient,
} from 'viem'
import type { SafeTxParams } from './safe-tx'

// ── Contract addresses (deterministic across chains) ───────────────
export const ALLOWANCE_MODULE_ADDRESS =
  '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134' as Address

const MULTISEND_CALL_ONLY_ADDRESS =
  '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D' as Address

const ZERO_ADDRESS =
  '0x0000000000000000000000000000000000000000' as Address

// ── ABIs ───────────────────────────────────────────────────────────

const SAFE_MODULE_ABI = [
  {
    name: 'enableModule',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'module', type: 'address' }],
    outputs: [],
  },
  {
    name: 'isModuleEnabled',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'module', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

const ALLOWANCE_MODULE_ABI = [
  {
    name: 'addDelegate',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'delegate', type: 'address' }],
    outputs: [],
  },
  {
    name: 'removeDelegate',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'delegate', type: 'address' },
      { name: 'removeAllowances', type: 'bool' },
    ],
    outputs: [],
  },
  {
    name: 'setAllowance',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'delegate', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'allowanceAmount', type: 'uint96' },
      { name: 'resetTimeMin', type: 'uint16' },
      { name: 'resetBaseMin', type: 'uint32' },
    ],
    outputs: [],
  },
  {
    name: 'deleteAllowance',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'delegate', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [],
  },
  {
    name: 'getTokenAllowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'safe', type: 'address' },
      { name: 'delegate', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256[5]' }],
  },
  {
    name: 'getTokens',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'safe', type: 'address' },
      { name: 'delegate', type: 'address' },
    ],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    name: 'getDelegates',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'safe', type: 'address' },
      { name: 'start', type: 'uint48' },
      { name: 'pageSize', type: 'uint8' },
    ],
    outputs: [
      { name: 'results', type: 'address[]' },
      { name: 'next', type: 'uint48' },
    ],
  },
] as const

const MULTISEND_ABI = [
  {
    name: 'multiSend',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
  },
] as const

// ── Types ──────────────────────────────────────────────────────────

export interface AllowanceInfo {
  token: Address
  amount: bigint
  spent: bigint
  resetTimeMin: number
  lastResetMin: number
  nonce: number
}

export interface AllowanceSetup {
  token: Address
  tokenSymbol: string
  amount: bigint
  resetTimeMin: number
}

// Reset period presets (in minutes)
export const RESET_PERIODS = [
  { label: 'One-time', value: 0 },
  { label: 'Daily', value: 1440 },
  { label: 'Weekly', value: 10080 },
  { label: 'Monthly', value: 43200 },
] as const

// ── Read functions ─────────────────────────────────────────────────

export async function isModuleEnabled(
  publicClient: PublicClient,
  safeAddress: Address,
): Promise<boolean> {
  return publicClient.readContract({
    address: safeAddress,
    abi: SAFE_MODULE_ABI,
    functionName: 'isModuleEnabled',
    args: [ALLOWANCE_MODULE_ADDRESS],
  }) as Promise<boolean>
}

export async function getDelegates(
  publicClient: PublicClient,
  safeAddress: Address,
): Promise<Address[]> {
  const result = await publicClient.readContract({
    address: ALLOWANCE_MODULE_ADDRESS,
    abi: ALLOWANCE_MODULE_ABI,
    functionName: 'getDelegates',
    args: [safeAddress, 0, 255],
  })
  const delegates = (result as unknown as [Address[], bigint])[0]
  return delegates.filter((a) => a !== ZERO_ADDRESS)
}

export async function getTokensForDelegate(
  publicClient: PublicClient,
  safeAddress: Address,
  delegate: Address,
): Promise<Address[]> {
  return publicClient.readContract({
    address: ALLOWANCE_MODULE_ADDRESS,
    abi: ALLOWANCE_MODULE_ABI,
    functionName: 'getTokens',
    args: [safeAddress, delegate],
  }) as Promise<Address[]>
}

export async function getTokenAllowance(
  publicClient: PublicClient,
  safeAddress: Address,
  delegate: Address,
  token: Address,
): Promise<AllowanceInfo> {
  const raw = await publicClient.readContract({
    address: ALLOWANCE_MODULE_ADDRESS,
    abi: ALLOWANCE_MODULE_ABI,
    functionName: 'getTokenAllowance',
    args: [safeAddress, delegate, token],
  })
  const result = raw as unknown as bigint[]
  return {
    token,
    amount: result[0],
    spent: result[1],
    resetTimeMin: Number(result[2]),
    lastResetMin: Number(result[3]),
    nonce: Number(result[4]),
  }
}

/** Fetch all allowances for a delegate across all tokens */
export async function getAllAllowances(
  publicClient: PublicClient,
  safeAddress: Address,
  delegate: Address,
): Promise<AllowanceInfo[]> {
  const tokens = await getTokensForDelegate(publicClient, safeAddress, delegate)
  if (tokens.length === 0) return []
  return Promise.all(
    tokens.map((token) =>
      getTokenAllowance(publicClient, safeAddress, delegate, token),
    ),
  )
}

// ── MultiSend encoding ─────────────────────────────────────────────

/**
 * Encode a single inner transaction for MultiSend.
 *
 * Binary layout (tightly packed, no ABI padding):
 *   uint8  operation   (1 byte)   — 0 = CALL
 *   address to         (20 bytes)
 *   uint256 value      (32 bytes)
 *   uint256 dataLength (32 bytes)
 *   bytes   data       (dataLength bytes)
 *
 * We build this manually to avoid any ambiguity with encodePacked.
 */
function encodeInnerTx(
  to: Address,
  data: `0x${string}`,
): `0x${string}` {
  const operation = '0x00' as `0x${string}`                             // 1 byte
  const toBytes = to.toLowerCase().slice(2) as string                   // 20 bytes (no 0x)
  const value = pad(numberToHex(0), { size: 32 })                      // 32 bytes
  const dataSize = data === '0x' ? 0 : (data.length - 2) / 2
  const length = pad(numberToHex(dataSize), { size: 32 })              // 32 bytes
  const rawData = data === '0x' ? '' : data.slice(2)                   // N bytes (no 0x)
  return `0x${operation.slice(2)}${toBytes}${value.slice(2)}${length.slice(2)}${rawData}` as `0x${string}`
}

// ── Transaction builders ───────────────────────────────────────────

/**
 * Build a batched Safe transaction that sets up an agent:
 * 1. enableModule (if needed)
 * 2. addDelegate
 * 3. setAllowance for each token
 *
 * Uses MultiSendCallOnly to batch into a single Safe tx / wallet popup.
 */
export function buildAgentSetupTx(
  safeAddress: Address,
  delegate: Address,
  allowances: AllowanceSetup[],
  needsModuleEnable: boolean,
  nonce: bigint,
): SafeTxParams {
  const innerTxs: `0x${string}`[] = []

  // 1. Enable AllowanceModule on Safe (self-call)
  if (needsModuleEnable) {
    innerTxs.push(
      encodeInnerTx(
        safeAddress,
        encodeFunctionData({
          abi: SAFE_MODULE_ABI,
          functionName: 'enableModule',
          args: [ALLOWANCE_MODULE_ADDRESS],
        }),
      ),
    )
  }

  // 2. Add delegate
  innerTxs.push(
    encodeInnerTx(
      ALLOWANCE_MODULE_ADDRESS,
      encodeFunctionData({
        abi: ALLOWANCE_MODULE_ABI,
        functionName: 'addDelegate',
        args: [delegate],
      }),
    ),
  )

  // 3. Set allowance for each token
  for (const a of allowances) {
    innerTxs.push(
      encodeInnerTx(
        ALLOWANCE_MODULE_ADDRESS,
        encodeFunctionData({
          abi: ALLOWANCE_MODULE_ABI,
          functionName: 'setAllowance',
          args: [delegate, a.token, a.amount, a.resetTimeMin, 0],
        }),
      ),
    )
  }

  const packed = concat(innerTxs)
  const multiSendData = encodeFunctionData({
    abi: MULTISEND_ABI,
    functionName: 'multiSend',
    args: [packed],
  })

  return {
    to: MULTISEND_CALL_ONLY_ADDRESS,
    value: 0n,
    data: multiSendData,
    operation: 1, // DelegateCall into MultiSend
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  }
}

/**
 * Build a Safe tx to revoke an agent delegate and all its allowances.
 */
export function buildAgentRevokeTx(
  delegate: Address,
  nonce: bigint,
): SafeTxParams {
  return {
    to: ALLOWANCE_MODULE_ADDRESS,
    value: 0n,
    data: encodeFunctionData({
      abi: ALLOWANCE_MODULE_ABI,
      functionName: 'removeDelegate',
      args: [delegate, true],
    }),
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  }
}

/**
 * Build a Safe tx to update an existing allowance for a delegate.
 */
export function buildSetAllowanceTx(
  delegate: Address,
  token: Address,
  amount: bigint,
  resetTimeMin: number,
  nonce: bigint,
): SafeTxParams {
  // For updating, resetBaseMin must be > lastResetMin.
  // Use current time in minutes as a safe value.
  const resetBaseMin = Math.floor(Date.now() / 60000)
  return {
    to: ALLOWANCE_MODULE_ADDRESS,
    value: 0n,
    data: encodeFunctionData({
      abi: ALLOWANCE_MODULE_ABI,
      functionName: 'setAllowance',
      args: [delegate, token, amount, resetTimeMin, resetBaseMin],
    }),
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  }
}
