import { ethers } from 'ethers'
import {
  buildSweepAuthorizationMessage,
  sweepUsdcAddress,
  sweepUsdcDomain,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  type SweepAuthorization,
  type SweepExpectedAuth,
} from '@haven_ai/sdk'
import { getRelayerWallet } from './allowance-module.js'

/**
 * Gasless delegate-sweep helpers (EIP-3009 `transferWithAuthorization`).
 *
 * The delegate signs an off-chain authorization; the relayer submits it and pays
 * gas. The relayer is only the gas payer here — it is never a spender and holds
 * no allowance, so a relayer compromise cannot move user funds. See
 * docs/bug-reports/sweep-delegate-split-signer-gap.md.
 */

/** How long a prepared authorization is valid for signing + relaying. */
export const SWEEP_VALIDITY_SECONDS = 300

const USDC_TRANSFER_WITH_AUTHORIZATION_ABI = [
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
]

/** A fresh random 32-byte EIP-3009 nonce (not sequential, per the spec). */
export function generateSweepNonce(): string {
  return ethers.hexlify(ethers.randomBytes(32))
}

/**
 * Build a `TransferWithAuthorization` paying the full stranded balance from the
 * delegate to its own Safe, valid for a short window from now.
 */
export function buildSweepAuthorization(params: {
  delegateAddress: string
  safeAddress: string
  chainId: number
  valueAtomic: bigint
  nowSec?: number
}): SweepAuthorization {
  const token = sweepUsdcAddress(params.chainId)
  const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000)
  return {
    from: params.delegateAddress,
    to: params.safeAddress,
    value: params.valueAtomic.toString(),
    validAfter: '0',
    validBefore: String(nowSec + SWEEP_VALIDITY_SECONDS),
    nonce: generateSweepNonce(),
    token,
    chainId: params.chainId,
  }
}

/**
 * Sign the authorization-context binding so the edge signer can confirm the
 * authorization came from Haven. Uses the same dedicated binding key as the
 * x402 expected-context (never the relayer key), under a distinct message
 * namespace so the two cannot cross-replay.
 */
export async function signSweepExpectedContext(
  auth: SweepAuthorization,
): Promise<SweepExpectedAuth> {
  const privateKey = process.env.X402_BINDING_PRIVATE_KEY
  if (!privateKey) {
    throw new Error(
      'X402_BINDING_PRIVATE_KEY must be set to authenticate sweep authorizations. ' +
        'Do not fall back to RELAYER_PRIVATE_KEY — the binding signer must be a dedicated key ' +
        'so that the edge signer can verify it against HAVEN_X402_BINDING_SIGNER.',
    )
  }
  const wallet = new ethers.Wallet(privateKey)
  const message = buildSweepAuthorizationMessage(auth)
  return {
    version: 1,
    message,
    signature: await wallet.signMessage(message),
    signer: wallet.address,
  }
}

/** Recover the EIP-712 signer of a `TransferWithAuthorization` signature. */
export function recoverSweepSigner(auth: SweepAuthorization, signature: string): string {
  const domain = sweepUsdcDomain(auth.chainId)
  return ethers.verifyTypedData(
    domain,
    TRANSFER_WITH_AUTHORIZATION_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
    {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature,
  )
}

/** Relay a signed sweep authorization on-chain. The relayer pays gas. */
export async function relaySweepAuthorization(
  auth: SweepAuthorization,
  signature: string,
): Promise<{ txHash: string }> {
  const relayer = getRelayerWallet(auth.chainId)
  const usdc = new ethers.Contract(auth.token, USDC_TRANSFER_WITH_AUTHORIZATION_ABI, relayer)
  const tx = await usdc.transferWithAuthorization(
    auth.from,
    auth.to,
    BigInt(auth.value),
    BigInt(auth.validAfter),
    BigInt(auth.validBefore),
    auth.nonce,
    signature,
  )
  const receipt = await tx.wait()
  return { txHash: receipt.hash }
}
