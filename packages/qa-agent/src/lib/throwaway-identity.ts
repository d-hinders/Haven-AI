/**
 * A fresh, disposable delegation-rail identity for one QA run (#1065's
 * pattern, absorbed here when #1674 became its second consumer).
 *
 * signup → hybrid account → agent → EOA-signed budget grant → activate.
 * Owner and delegate keys are ephemeral in-scenario wallets; all signing is
 * client-side, so non-custody holds even in QA. The isolation argument is the
 * same one delegation-lifecycle established: the standing QA identity's open
 * budget is what every other leg depends on, so scenarios that need to
 * mutate or exhaust authority provision their own identity and abandon it —
 * which also makes QA_MAX_ATTEMPTS retries trivially safe.
 *
 * Errors return as values rather than throws, matching the scenarios'
 * pass/fail idiom: the caller turns them into `fail(...)` with its own
 * context attached.
 */

import { ethers } from 'ethers'
import { signUserOpTypedDataForDelegation } from '@haven_ai/sdk'
import { SEPOLIA_USDC } from './chain.js'

export interface TypedData {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType?: string
  message: Record<string, unknown>
}

export async function signTyped(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  td: TypedData,
): Promise<string> {
  const types = Object.fromEntries(Object.entries(td.types).filter(([k]) => k !== 'EIP712Domain'))
  return wallet.signTypedData(td.domain as never, types as never, td.message as never)
}

export interface ThrowawayIdentity {
  owner: ethers.HDNodeWallet
  delegate: ethers.HDNodeWallet
  token: string
  safeId: string
  safeAddress: string
  agentId: string
  agentApiKey: string
  /**
   * The delegate HYBRID account — the budget delegation's delegate and the
   * erc7710 child's delegator (#1667). Captured from the grant build so a
   * scenario can assert its on-chain state BEFORE any payment exists.
   */
  delegateAccountAddress: string | null
  grantHash: string
  /** Build + owner-sign + activate a replacement grant in the same slot. */
  grantAndActivate(): Promise<{ hash: string } | { error: string }>
}

export async function provisionThrowawayIdentity(
  apiUrl: string,
  options: { chainId: number; budgetAtomic: string; label: string },
): Promise<ThrowawayIdentity | { error: string }> {
  const owner = ethers.Wallet.createRandom()
  const delegate = ethers.Wallet.createRandom()
  const email = `qa-${options.label}-${Math.random().toString(36).slice(2, 10)}@haven.test`
  const password = 'Qa-' + ethers.Wallet.createRandom().privateKey.slice(2, 26)

  async function userCall<T>(method: string, path: string, token: string | null, body?: unknown) {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json().catch(() => ({}))) as T }
  }

  const signup = await userCall<{ token?: string; error?: string }>('POST', '/auth/signup', null, {
    name: `QA ${options.label} (throwaway)`, email, password,
  })
  const token = signup.json.token
  if (!token) return { error: `throwaway signup failed (${signup.status}): ${signup.json.error ?? ''}` }

  const hybrid = await userCall<{ error?: string }>('POST', '/accounts/hybrid', token, {
    chain_id: options.chainId, owner_address: owner.address,
  })
  if (hybrid.status !== 201) {
    return { error: `hybrid provisioning failed (${hybrid.status}): ${hybrid.json.error ?? ''}` }
  }
  const me = await userCall<{ safes?: Array<{ id: string; safe_address: string; account_type?: string }> }>(
    'GET', '/auth/me', token,
  )
  const safe = me.json.safes?.find((s) => s.account_type === 'delegator_hybrid')
  if (!safe) return { error: 'provisioned account missing from /auth/me' }

  // #2020 retired the per-token `allowances` mirror: POST /agents now REFUSES a
  // non-empty array rather than silently dropping it. The budget this throwaway
  // actually spends is the delegation granted by grantAndActivate() below, so
  // there is nothing to send here.
  const agentRes = await userCall<{ id?: string; api_key?: string; error?: string }>(
    'POST', '/agents', token,
    { name: `QA ${options.label} agent`, delegate_address: delegate.address, safe_id: safe.id },
  )
  const agentId = agentRes.json.id
  const agentApiKey = agentRes.json.api_key
  if (!agentId || !agentApiKey) {
    return { error: `throwaway agent creation failed (${agentRes.status}): ${agentRes.json.error ?? ''}` }
  }

  let delegateAccountAddress: string | null = null

  async function grantAndActivate(): Promise<{ hash: string } | { error: string }> {
    const built = await userCall<{
      delegation_hash?: string
      signing_payload?: TypedData
      delegate_account_address?: string
      error?: string
    }>(
      'POST', `/agents/${agentId}/delegations/build`, token!,
      { token_address: SEPOLIA_USDC, budget_atomic: options.budgetAtomic, period_seconds: 86_400 },
    )
    if (!built.json.delegation_hash || !built.json.signing_payload) {
      return { error: `grant build failed (${built.status}): ${built.json.error ?? ''}` }
    }
    if (built.json.delegate_account_address) {
      delegateAccountAddress = built.json.delegate_account_address
    }
    const signature = await signTyped(owner, built.json.signing_payload)
    const act = await userCall<{ error?: string }>(
      'POST', `/agents/${agentId}/delegations/${built.json.delegation_hash}/activate`, token!, { signature },
    )
    if (act.status !== 200) return { error: `activate failed (${act.status}): ${act.json.error ?? ''}` }
    return { hash: built.json.delegation_hash }
  }

  const grant = await grantAndActivate()
  if ('error' in grant) return grant

  return {
    owner,
    delegate,
    token,
    safeId: safe.id,
    safeAddress: safe.safe_address,
    agentId,
    agentApiKey,
    delegateAccountAddress,
    grantHash: grant.hash,
    grantAndActivate,
  }
}

/**
 * A delegation-rail payment as an agent: authorize → delegate signs the
 * UserOp typed data → submit. Used both to FUND a throwaway treasury from the
 * standing identity and by scenarios paying as the throwaway.
 */
export async function payViaDelegation(
  apiUrl: string,
  apiKey: string,
  delegateKey: string,
  to: string,
  human: string,
): Promise<{ ok: true; status: number; tx?: string } | { ok: false; status: number; error: string }> {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  const auth = await fetch(`${apiUrl}/payments`, {
    method: 'POST', headers, body: JSON.stringify({ token: 'USDC', amount: human, to }),
  })
  const intent = (await auth.json().catch(() => ({}))) as {
    payment_id?: string
    sign_data?: { typed_data?: TypedData }
    error?: string
  }
  if (!auth.ok || !intent.payment_id || !intent.sign_data?.typed_data) {
    return { ok: false, status: auth.status, error: intent.error ?? `authorize ${auth.status}` }
  }
  const signature = await signUserOpTypedDataForDelegation(delegateKey, intent.sign_data.typed_data as never)
  const submit = await fetch(`${apiUrl}/payments/${intent.payment_id}/sign`, {
    method: 'POST', headers, body: JSON.stringify({ signature }),
  })
  const done = (await submit.json().catch(() => ({}))) as { tx_hash?: string; status?: string; error?: string }
  if (!submit.ok) return { ok: false, status: submit.status, error: done.error ?? `sign ${submit.status}` }
  return { ok: true, status: submit.status, tx: done.tx_hash }
}
