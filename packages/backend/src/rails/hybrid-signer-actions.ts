/**
 * Hybrid DeleGator signer management — the rail's shared core (#1081).
 *
 * Enrol a backup passkey/EOA, or remove a passkey, as ACCOUNT ops (addKey /
 * removeKey / transferOwnership) prepared here and signed by an EXISTING
 * signer. Haven prepares, never signs (#824 invariant 12).
 *
 * This lives in lib rather than in a route because there are now TWO ways to
 * reach it: agent-scoped (`/agents/:id/account-signers/*`, #888) and
 * account-scoped (`/accounts/hybrid/:address/signers/*`, #1081, so recovery
 * setup does not require creating an agent first). They differ only in how
 * the account is resolved — the authority rules, the ≥2-signer floor, the
 * calldata encoding and the signed-op matching are identical, and must stay
 * that way. Two copies of a spend-authority rule is how they drift.
 */

import { encodeFunctionData, zeroAddress } from 'viem'
import type { Address, Hex } from 'viem'
import { isAddress as isValidAddress } from '@haven_ai/core'
import {
  addAccountPasskey,
  clearAccountOwnerAddress,
  removeAccountPasskey,
  setAccountOwnerAddress,
} from '../infra/repositories/hybrid-signers.js'
import { getChain } from '../domain/chains.js'
import type { HybridOwnerConfig } from './hybrid-provisioning.js'
import { createTreasuryOps, delegationRailBundlerUrl } from './delegation-rail.js'
import { redactVendorSecrets } from './execution-rail.js'

export const HYBRID_SIGNER_ABI = [
  { name: 'addKey', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_keyId', type: 'string' }, { name: '_x', type: 'uint256' }, { name: '_y', type: 'uint256' }], outputs: [] },
  { name: 'removeKey', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_keyId', type: 'string' }], outputs: [] },
  { name: 'transferOwnership', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newOwner', type: 'address' }], outputs: [] },
] as const

export type SignerAction = 'add_passkey' | 'remove_passkey' | 'add_owner' | 'remove_owner'

export interface SignerActionBody {
  action?: SignerAction
  passkey?: { key_id?: string; x?: string; y?: string }
  owner_address?: string
  signature_scheme?: string
}

/** The resolved account a signer change applies to, however it was reached. */
export interface SignerActionAccount {
  accountAddress: Address
  chainId: number
  userSafeId: string
  config: HybridOwnerConfig
  /**
   * The account's recorded single-signer waiver (#908), when loaded. Consulted
   * only by removals that would drop a value-bearing account below the signer
   * floor — the SAME waiver provisioning honours, so "may this account run
   * single-signer on mainnet" has exactly one answer.
   */
  singleSignerWaiverAt?: string | null
}

/** Vendor errors echo the bundler URL (which embeds the API key) — #764. */
function safeDetails(err: unknown): string {
  return redactVendorSecrets(err instanceof Error ? err.message : String(err))
}

/**
 * Resolve which signer the client will sign with (the #1086 multi-signer
 * fix): a Hybrid account with BOTH an EOA owner and passkeys accepts either
 * on-chain, and only the device knows what is available — "has an owner"
 * must never mean "must sign as the owner". The requested scheme is
 * validated against the account's actual signer set; omitted keeps the
 * legacy default (owner if present, else passkey) so old clients are
 * unaffected.
 */
export function resolveSignatureScheme(
  requested: string | undefined,
  config: HybridOwnerConfig,
): { scheme: 'eip712_userop' | 'webauthn_userop' } | { error: string } {
  const hasPasskeys = !!config.passkeys && config.passkeys.length > 0
  if (requested === undefined) {
    return { scheme: config.ownerAddress ? 'eip712_userop' : 'webauthn_userop' }
  }
  if (requested === 'webauthn_userop') {
    return hasPasskeys
      ? { scheme: 'webauthn_userop' }
      : { error: 'This account has no passkeys to sign with' }
  }
  if (requested === 'eip712_userop') {
    return config.ownerAddress
      ? { scheme: 'eip712_userop' }
      : { error: 'This account has no EOA owner to sign with' }
  }
  return { error: `Unknown signature_scheme: ${requested}` }
}

/**
 * Validate the action against the CURRENT signer set and encode the inner
 * calldata. Shared by prepare and submit — submit re-derives the calldata
 * and requires it inside the signed UserOperation, so the DB sync can never
 * record something other than what the owner actually signed.
 */
export function encodeSignerAction(
  body: SignerActionBody,
  owner: { config: { ownerAddress?: Address; passkeys?: Array<{ keyId: string; x: bigint; y: bigint }> } },
): { data: Hex } | { error: string } {
  const passkeys = owner.config.passkeys ?? []
  const signerCount = passkeys.length + (owner.config.ownerAddress ? 1 : 0)

  if (body.action === 'add_passkey') {
    const pk = body.passkey
    if (!pk?.key_id || !/^0x[0-9a-fA-F]+$/.test(pk.key_id) || !pk.x || !pk.y) {
      return { error: 'passkey with 0x-hex key_id, x and y is required' }
    }
    if (passkeys.some((k) => k.keyId.toLowerCase() === pk.key_id!.toLowerCase())) {
      return { error: 'This passkey is already enrolled' }
    }
    let x: bigint, y: bigint
    try { x = BigInt(pk.x); y = BigInt(pk.y) } catch { return { error: 'x and y must be numeric' } }
    return { data: encodeFunctionData({ abi: HYBRID_SIGNER_ABI, functionName: 'addKey', args: [pk.key_id, x, y] }) }
  }
  if (body.action === 'remove_passkey') {
    const keyId = body.passkey?.key_id
    if (!keyId) return { error: 'passkey.key_id is required' }
    if (!passkeys.some((k) => k.keyId.toLowerCase() === keyId.toLowerCase())) {
      return { error: 'No such passkey on this account' }
    }
    if (signerCount - 1 < 2) {
      // The chain itself only refuses removing the LAST signer (#884
      // CannotRemoveLastSigner) — do not claim the stricter rule is on-chain.
      //
      // This ≥2 refusal is now BRANCH-SPECIFIC, not account-wide (#1153).
      // `remove_owner`, a few lines below, permits dropping to one signer on
      // any chain — the owner ruled that a user may move to a single-signer
      // setup, and that relaxation was scoped to owner removal only. So a
      // reader here must not infer that ≥2 still holds for the account: it
      // does not. Whether this branch should match is #1199, an open product
      // question rather than an oversight.
      return {
        error: 'Removing this would leave fewer than two ways to approve — add a backup first.',
      }
    }
    return { data: encodeFunctionData({ abi: HYBRID_SIGNER_ABI, functionName: 'removeKey', args: [keyId] }) }
  }
  if (body.action === 'add_owner') {
    if (owner.config.ownerAddress) {
      return { error: 'This account already has a wallet owner' }
    }
    // Zero address = the "no owner" encoding; it must never be enrolled as
    // a signer (it would inflate the #908 floor count with a non-signer).
    if (body.owner_address && /^0x0{40}$/i.test(body.owner_address)) {
      return { error: 'owner_address must not be the zero address' }
    }
    if (!body.owner_address || !isValidAddress(body.owner_address)) {
      return { error: 'A valid owner_address is required' }
    }
    return { data: encodeFunctionData({ abi: HYBRID_SIGNER_ABI, functionName: 'transferOwnership', args: [body.owner_address as Address] }) }
  }
  if (body.action === 'remove_owner') {
    // #1087: enrolling an owner must not be a one-way door. On-chain this is
    // transferOwnership(address(0)) — the "no EOA owner" encoding, the same
    // zero address `add_owner` refuses as INPUT (there it would enrol a
    // non-signer; here it is the removal itself).
    if (!owner.config.ownerAddress) {
      return { error: 'This account has no wallet owner to remove' }
    }
    if (passkeys.length === 0) {
      return {
        error:
          'Removing the wallet would leave no way to approve anything — it is the only signer. ' +
          'Add a passkey first. The account itself refuses this on-chain.',
      }
    }
    return { data: encodeFunctionData({ abi: HYBRID_SIGNER_ABI, functionName: 'transferOwnership', args: [zeroAddress] }) }
  }
  return { error: 'action must be add_passkey, remove_passkey, add_owner or remove_owner' }
}

// #1153 removed `removeOwnerFloorFailure` from this file. It refused a
// `remove_owner` that would leave a value-bearing account with one signer
// (#908, applied here by #1087) unless a waiver was recorded.
//
// **Owner decision (2026-08-07, recorded verbatim on #1153):** "convert this
// from a block to a warning instead, the user should be able to move to a one
// signer set up."
//
// So the API permits it, and the consequence is delivered where a human can
// read it: the dashboard requires an explicit confirmation naming what is
// lost ("this account will have no recovery") before it calls. The
// alternative — an `acknowledge_single_signer` flag — was rejected on the
// issue because it is still a block to any non-UI caller, which is the thing
// being removed.
//
// What did NOT change: `encodeSignerAction` still refuses to remove the owner
// when there are ZERO passkeys behind it. That is a different guard — it
// mirrors an invariant the account itself enforces on-chain, and dropping to
// no signers bricks the account rather than merely making it unrecoverable.

export type SignerChangeFailure = { status: 409 | 400 | 502; error: string; details?: string }

/**
 * Shape-check the signed envelope a submit must carry.
 *
 * Callable BEFORE the account is resolved, because that is the order the
 * agent-scoped route has always used: a malformed body is a 400 whether or
 * not the account's signer config happens to load. Extracting the checks
 * without preserving that precedence would have silently turned those 400s
 * into 409s (caught in review).
 */
export function validateSignedSubmission(
  body: { signature?: string; user_operation?: unknown },
): { ok: true } | { ok: false; failure: SignerChangeFailure } {
  if (!body.signature || !/^0x[0-9a-fA-F]+$/.test(body.signature)) {
    return { ok: false, failure: { status: 400, error: 'signature is required' } }
  }
  if (!body.user_operation || typeof body.user_operation !== 'object') {
    return {
      ok: false,
      failure: { status: 400, error: 'user_operation (from the prepare step) is required' },
    }
  }
  return { ok: true }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PreparedSignerChange = Record<string, any>

/**
 * Prepare the sponsored UserOperation for a signer change. Nothing is signed
 * here — the caller returns the payload for an EXISTING signer to sign.
 */
export async function prepareSignerChange(
  account: SignerActionAccount,
  body: SignerActionBody,
): Promise<{ ok: true; prepared: PreparedSignerChange } | { ok: false; failure: SignerChangeFailure }> {
  const encoded = encodeSignerAction(body, { config: account.config })
  if ('error' in encoded) return { ok: false, failure: { status: 409, error: encoded.error } }

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
    const prepared = await treasury.prepareCall(account.accountAddress, encoded.data)
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
      failure: { status: 502, error: 'Could not prepare the signer change', details: safeDetails(err) },
    }
  }
}

/**
 * Submit the signed UserOperation and sync storage with the now-on-chain
 * signer set (#885 is the source the deploy/sign paths rebuild from — it
 * must track the chain).
 */
export async function submitSignerChange(
  account: SignerActionAccount,
  body: SignerActionBody & { signature?: string; user_operation?: unknown },
): Promise<{ ok: true; txHash: string | null } | { ok: false; failure: SignerChangeFailure }> {
  const { signature, user_operation } = body
  // Re-checked here as well as at the route: this is a public entry point and
  // must not assume a caller validated first.
  const envelope = validateSignedSubmission(body)
  if (!envelope.ok) return envelope

  // Re-derive the calldata from the CLAIMED action and require it inside
  // the signed UserOperation — the DB sync below can then never diverge
  // from what the owner actually signed.
  const encoded = encodeSignerAction(body, { config: account.config })
  if ('error' in encoded) return { ok: false, failure: { status: 409, error: encoded.error } }

  // Public entry point — the floor must hold here too, not just at prepare.
  const callData = String((user_operation as { callData?: string }).callData ?? '')
  if (!callData.toLowerCase().includes(encoded.data.slice(2).toLowerCase())) {
    return {
      ok: false,
      failure: { status: 400, error: 'user_operation does not match the requested signer change' },
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
    const revived = JSON.parse(JSON.stringify(user_operation), (_k, v) =>
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    )
    const result = await treasury.submitCall(
      { userOperation: revived, userOpHash: '0x' as Hex, signingTypedData: null, treasuryAddress: treasury.treasuryAddress },
      signature as Hex,
    )

    if (body.action === 'add_passkey' && body.passkey) {
      await addAccountPasskey(account.userSafeId, {
        keyId: String(body.passkey.key_id),
        x: String(body.passkey.x),
        y: String(body.passkey.y),
      })
    } else if (body.action === 'remove_passkey' && body.passkey) {
      await removeAccountPasskey(account.userSafeId, String(body.passkey.key_id))
    } else if (body.action === 'add_owner') {
      await setAccountOwnerAddress(account.userSafeId, String(body.owner_address))
    } else if (body.action === 'remove_owner') {
      await clearAccountOwnerAddress(account.userSafeId)
    }
    return { ok: true, txHash: result.txHash }
  } catch (err) {
    return { ok: false, failure: { status: 502, error: 'Signer change failed', details: safeDetails(err) } }
  }
}
