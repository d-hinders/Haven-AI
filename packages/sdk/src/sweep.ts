import { HavenSigningError } from './types.js'

/**
 * Gasless delegate-sweep primitives — the single source of truth shared by the
 * edge signer (which signs) and the Haven backend (which relays).
 *
 * A stranded delegate EOA holds USDC but no ETH, so a raw ERC-20 transfer can't
 * pay for its own gas. Instead the delegate signs an *off-chain* EIP-3009
 * `TransferWithAuthorization` and the Haven relayer submits it on-chain and pays
 * gas. The relayer is only a gas payer: it holds no allowance and is never a
 * spender, so a relayer compromise cannot move user funds.
 *
 * Framework-neutral on purpose: `buildSweepTypedData` returns a plain
 * `{ domain, types, primaryType, message }` that both viem
 * (`signTypedData`/`recoverTypedDataAddress`) and ethers v6
 * (`signTypedData`/`verifyTypedData`) accept, so the signer (viem) and backend
 * (ethers) stay in lockstep without sharing a crypto library.
 */

/** Base mainnet. The only chain Haven sweeps today. */
export const SWEEP_BASE_CHAIN_ID = 8453

/** Base Sepolia testnet — used by the dev environment / QA harness. */
export const SWEEP_BASE_SEPOLIA_CHAIN_ID = 84532

/** Canonical Circle USDC on Base (FiatTokenV2_2). */
export const SWEEP_BASE_USDC_ADDRESS =
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** Circle's canonical Base Sepolia testnet USDC. */
export const SWEEP_BASE_SEPOLIA_USDC_ADDRESS =
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

/**
 * EIP-712 domain per chain. `name`/`version` are the on-chain `FiatTokenV2_2`
 * values; a mismatch makes the relayer's `transferWithAuthorization` revert, so
 * each is pinned to the known-good, **on-chain-verified** USDC values. Base
 * mainnet is "USD Coin"/"2"; Base Sepolia is "USDC"/"2" (verified via `name()`/
 * `version()`). Add a chain here only after verifying its USDC EIP-712 domain.
 */
const USDC_EIP712_DOMAIN_BY_CHAIN: Record<number, SweepEip712Domain> = {
  [SWEEP_BASE_CHAIN_ID]: {
    name: 'USD Coin',
    version: '2',
    chainId: SWEEP_BASE_CHAIN_ID,
    verifyingContract: SWEEP_BASE_USDC_ADDRESS,
  },
  [SWEEP_BASE_SEPOLIA_CHAIN_ID]: {
    name: 'USDC',
    version: '2',
    chainId: SWEEP_BASE_SEPOLIA_CHAIN_ID,
    verifyingContract: SWEEP_BASE_SEPOLIA_USDC_ADDRESS,
  },
}

/** USDC contract per sweepable chain. */
const USDC_ADDRESS_BY_CHAIN: Record<number, string> = {
  [SWEEP_BASE_CHAIN_ID]: SWEEP_BASE_USDC_ADDRESS,
  [SWEEP_BASE_SEPOLIA_CHAIN_ID]: SWEEP_BASE_SEPOLIA_USDC_ADDRESS,
}

/** Sweepable chains, for error messages. */
const SWEEPABLE_CHAIN_IDS = Object.keys(USDC_ADDRESS_BY_CHAIN).map(Number)

/** True when the gasless sweep supports a chain (its USDC domain + address are known). */
export function isSweepableChain(chainId: number): boolean {
  return chainId in USDC_ADDRESS_BY_CHAIN
}

/** EIP-712 `TransferWithAuthorization` struct, per EIP-3009. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export interface SweepEip712Domain {
  name: string
  version: string
  chainId: number
  verifyingContract: string
}

/**
 * A fully-specified EIP-3009 authorization. All amounts/times are decimal
 * strings (JSON-safe) and `nonce` is a 0x-prefixed 32-byte hex value. `token`
 * and `chainId` are carried explicitly so the signer can assert they are
 * canonical before signing.
 */
export interface SweepAuthorization {
  /** Delegate EOA the funds are swept FROM. */
  from: string
  /** Originating Safe the funds are swept TO. */
  to: string
  /** Atomic USDC amount (decimal string). */
  value: string
  /** Unix seconds the authorization becomes valid (decimal string, usually "0"). */
  validAfter: string
  /** Unix seconds the authorization expires (decimal string). */
  validBefore: string
  /** Random 0x-prefixed 32-byte hex nonce. */
  nonce: string
  /** USDC contract address. */
  token: string
  /** Chain id (8453 today). */
  chainId: number
}

/**
 * Haven's signature over the sweep authorization context, signed with the same
 * binding key the x402 expected-context uses. Lets the edge signer verify the
 * authorization actually came from Haven (and wasn't crafted by a compromised
 * hosted server pointing `to` at an attacker) before it signs.
 */
export interface SweepExpectedAuth {
  version: 1
  message: string
  signature: string
  signer: string
}

/** What `POST /machine-payments/sweep/prepare` returns when funds are stranded. */
export interface SweepPreparation {
  authorization: SweepAuthorization
  expectedAuth: SweepExpectedAuth
}

/** Wire response from `POST /machine-payments/sweep/prepare` (snake_case). */
export interface SweepPrepareResponse {
  /** Present and true when the delegate holds nothing to recover. */
  nothing_stranded?: boolean
  /**
   * Present and true when the stranded balance exceeds the auto-sweep cap (#700)
   * and was parked for manual recovery — no `authorization` is built. `cap_usdc`
   * carries the configured cap.
   */
  parked?: boolean
  cap_usdc?: string
  /** The authorization to sign — absent when nothing is stranded or parked. */
  authorization?: SweepAuthorization
  /** Haven's binding over the authorization — absent when nothing is stranded. */
  expected_auth?: SweepExpectedAuth
  asset?: string
  amount?: string
  amount_atomic?: string
  chain_id: number
  sign_instructions?: string
  message?: string
}

/** Wire response from `POST /machine-payments/sweep/submit` (snake_case). */
export interface SweepSubmitResponse {
  tx_hash: string
  asset: string
  amount: string
  amount_atomic: string
  from_address: string
  to_address: string
  chain_id: number
  explorer_url: string
  idempotent_replay?: boolean
}

/** Result of a submitted gasless sweep. */
export interface SweepSubmitResult {
  txHash: string
  amount: string
  amountAtomic: string
  asset: string
  fromAddress: string
  toAddress: string
  chainId: number
  explorerUrl: string
}

export interface SweepTypedData {
  domain: SweepEip712Domain
  types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES
  primaryType: 'TransferWithAuthorization'
  message: {
    from: string
    to: string
    value: bigint
    validAfter: bigint
    validBefore: bigint
    nonce: string
  }
}

/** Resolve the canonical USDC contract for a sweepable chain, or throw. */
export function sweepUsdcAddress(chainId: number): string {
  const address = USDC_ADDRESS_BY_CHAIN[chainId]
  if (!address) {
    throw new HavenSigningError(
      `Sweep is not supported on chain ${chainId}. Supported: ${SWEEPABLE_CHAIN_IDS.join(', ')}.`,
    )
  }
  return address
}

/** Resolve the USDC EIP-712 domain for a sweepable chain, or throw. */
export function sweepUsdcDomain(chainId: number): SweepEip712Domain {
  const domain = USDC_EIP712_DOMAIN_BY_CHAIN[chainId]
  if (!domain) {
    throw new HavenSigningError(
      `Sweep is not supported on chain ${chainId}. Supported: ${SWEEPABLE_CHAIN_IDS.join(', ')}.`,
    )
  }
  return domain
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Build the EIP-712 typed data for an authorization, validating that the token
 * and chain are canonical (the domain's `verifyingContract` must match the
 * authorization's `token`). Returns bigint-valued fields so both viem and
 * ethers v6 sign/recover identically.
 */
export function buildSweepTypedData(auth: SweepAuthorization): SweepTypedData {
  const domain = sweepUsdcDomain(auth.chainId)
  const expectedToken = sweepUsdcAddress(auth.chainId)
  if (!sameAddress(auth.token, expectedToken)) {
    throw new HavenSigningError(
      `Sweep token ${auth.token} is not the canonical USDC contract for chain ${auth.chainId}.`,
    )
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) {
    throw new HavenSigningError('Sweep nonce must be a 0x-prefixed 32-byte hex string.')
  }
  return {
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  }
}

/**
 * Canonical, deterministic string the backend signs and the signer re-derives
 * for the authorization binding. The `Haven sweep authorization v1` namespace
 * (and `kind`) is distinct from the x402 expected-context namespace so an x402
 * binding can never be replayed as a sweep authorization even though they share
 * a signing key.
 */
export function buildSweepAuthorizationMessage(auth: SweepAuthorization): string {
  return `Haven sweep authorization v1\n${stableStringify({
    version: 1,
    kind: 'haven.sweep.authorization',
    from: auth.from.toLowerCase(),
    to: auth.to.toLowerCase(),
    value: auth.value,
    validAfter: auth.validAfter,
    validBefore: auth.validBefore,
    nonce: auth.nonce.toLowerCase(),
    token: auth.token.toLowerCase(),
    chainId: auth.chainId,
  })}`
}

/** Deterministic JSON: object keys sorted, no incidental whitespace. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`
}
