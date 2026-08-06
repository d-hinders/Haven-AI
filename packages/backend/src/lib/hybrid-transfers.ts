/**
 * Owner-initiated send from the treasury Hybrid (#1083).
 *
 * The delegation rail's "Send" is an ACCOUNT op: the treasury executes an
 * ERC-20 transfer as a sponsored UserOperation the OWNER signs (passkey or
 * EOA — the device's choice, the #1086 contract). Haven prepares and relays;
 * it never signs (#824 invariant 12), exactly like signer changes.
 *
 * Discipline shared with `hybrid-signer-actions.ts`:
 * - prepare/submit split; nothing on-chain until the owner's signature
 * - submit RE-DERIVES the transfer calldata from the claimed (token, to,
 *   amount) and requires it inside the signed UserOperation, so the
 *   submitted op can never diverge from what the owner approved
 * - signature_scheme requested by the device, validated against the signer
 *   set
 * - a COUNTERFACTUAL account works: the op carries initCode (#1106), so a
 *   user who received funds before ever creating an agent can still send —
 *   deploy + transfer ride one sponsored op.
 *
 * Gas: SPONSORED via the delegation-rail policy — consistent with every
 * other op on the rail (accounts hold USDC, not ETH; self-paid would
 * dead-end typical users). Policy caps bound the exposure; recorded as the
 * #1083 decision pending owner sign-off in the PR.
 */

import { encodeFunctionData } from 'viem'
import type { Address, Hex } from 'viem'
import { isAddress as isValidAddress } from '@haven_ai/core'
import { getChain } from './chains.js'
import { createTreasuryOps, delegationRailBundlerUrl } from './delegation-rail.js'
import { redactVendorSecrets } from './execution-rail.js'
import {
  resolveSignatureScheme,
  validateSignedSubmission,
  type SignerActionAccount,
  type SignerChangeFailure,
} from './hybrid-signer-actions.js'

const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

export interface TransferBody {
  token_address?: string
  to?: string
  amount_atomic?: string
  signature_scheme?: string
}

function safeDetails(err: unknown): string {
  return redactVendorSecrets(err instanceof Error ? err.message : String(err))
}

/** Validate the transfer request and encode the ERC-20 calldata. */
export function encodeTransfer(
  body: TransferBody,
): { token: Address; data: Hex; to: Address; amount: bigint } | { error: string } {
  if (!body.token_address || !isValidAddress(body.token_address)) {
    return { error: 'A valid token_address is required' }
  }
  if (!body.to || !isValidAddress(body.to)) {
    return { error: 'A valid to address is required' }
  }
  if (/^0x0{40}$/i.test(body.to)) {
    return { error: 'to must not be the zero address' }
  }
  let amount: bigint
  try {
    amount = BigInt(body.amount_atomic ?? '')
  } catch {
    return { error: 'amount_atomic must be a positive integer (atomic units)' }
  }
  if (amount <= 0n) return { error: 'amount_atomic must be a positive integer (atomic units)' }
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [body.to as Address, amount],
  })
  return { token: body.token_address as Address, data, to: body.to as Address, amount }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PreparedTransfer = Record<string, any>

export async function prepareTransfer(
  account: SignerActionAccount,
  body: TransferBody,
): Promise<{ ok: true; prepared: PreparedTransfer } | { ok: false; failure: SignerChangeFailure }> {
  const encoded = encodeTransfer(body)
  if ('error' in encoded) return { ok: false, failure: { status: 400, error: encoded.error } }

  const resolved = resolveSignatureScheme(body.signature_scheme, account.config)
  if ('error' in resolved) return { ok: false, failure: { status: 409, error: resolved.error } }

  try {
    const treasury = await createTreasuryOps({
      ownerAddress: account.config.ownerAddress,
      passkeys: account.config.passkeys,
      accountAddress: account.accountAddress,
      chainId: account.chainId,
      bundlerUrl: delegationRailBundlerUrl(account.chainId),
      rpcUrl: getChain(account.chainId).rpcUrl,
      sponsorshipPolicyId: process.env.DELEGATION_RAIL_SPONSORSHIP_POLICY_ID || undefined,
      signWith: resolved.scheme === 'webauthn_userop' ? 'passkey' : 'owner',
    })
    // The CALL TARGET is the token contract; gas estimation simulates the
    // transfer, so an insufficient balance fails here — before anything is
    // signed — rather than at submit.
    const prepared = await treasury.prepareCall(encoded.token, encoded.data)
    const user_operation = JSON.parse(
      JSON.stringify(prepared.userOperation, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    )
    if (resolved.scheme === 'webauthn_userop') {
      return {
        ok: true,
        prepared: {
          signature_scheme: 'webauthn_userop',
          user_op_hash: prepared.userOpHash,
          user_operation,
          instructions: 'Sign with the account passkey (WebAuthn), then POST the matching submit route',
        },
      }
    }
    return {
      ok: true,
      prepared: {
        signature_scheme: 'eip712_userop',
        signing_payload: prepared.signingTypedData,
        user_operation,
        instructions: 'Sign signing_payload (EIP-712) with the owner key, then POST the matching submit route',
      },
    }
  } catch (err) {
    return {
      ok: false,
      failure: { status: 502, error: 'Could not prepare the transfer', details: safeDetails(err) },
    }
  }
}

export async function submitTransfer(
  account: SignerActionAccount,
  body: TransferBody & { signature?: string; user_operation?: unknown },
): Promise<{ ok: true; txHash: string | null } | { ok: false; failure: SignerChangeFailure }> {
  const envelope = validateSignedSubmission(body)
  if (!envelope.ok) return envelope

  // Re-derive the calldata from the CLAIMED transfer and require it inside
  // the signed UserOperation — what lands on-chain is what the owner signed.
  const encoded = encodeTransfer(body)
  if ('error' in encoded) return { ok: false, failure: { status: 400, error: encoded.error } }
  const callData = String((body.user_operation as { callData?: string }).callData ?? '')
  if (!callData.toLowerCase().includes(encoded.data.slice(2).toLowerCase())) {
    return {
      ok: false,
      failure: { status: 400, error: 'user_operation does not match the requested transfer' },
    }
  }

  try {
    const treasury = await createTreasuryOps({
      ownerAddress: account.config.ownerAddress,
      passkeys: account.config.passkeys,
      accountAddress: account.accountAddress,
      chainId: account.chainId,
      bundlerUrl: delegationRailBundlerUrl(account.chainId),
      rpcUrl: getChain(account.chainId).rpcUrl,
      sponsorshipPolicyId: process.env.DELEGATION_RAIL_SPONSORSHIP_POLICY_ID || undefined,
    })
    const revived = JSON.parse(JSON.stringify(body.user_operation), (_k, v) =>
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    )
    const result = await treasury.submitCall(
      { userOperation: revived, userOpHash: '0x' as Hex, signingTypedData: null, treasuryAddress: treasury.treasuryAddress },
      body.signature as Hex,
    )
    return { ok: true, txHash: result.txHash }
  } catch (err) {
    return { ok: false, failure: { status: 502, error: 'Transfer failed', details: safeDetails(err) } }
  }
}
