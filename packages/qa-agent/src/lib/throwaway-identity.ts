/**
 * A fresh, disposable delegation-rail identity for one QA run (#1065's
 * pattern, absorbed here when #1674 became its second consumer).
 *
 * signup → hybrid account → agent → EOA-signed budget grant → activate.
 * Owner and delegate keys are ephemeral in-scenario wallets; all signing is
 * client-side, so non-custody holds even in QA. The isolation argument is the
 * same one delegation-lifecycle established: the standing QA identity's open
 * budget is what every other leg depends on, so scenarios that need to
 * mutate or exhaust authority provision their own identity — which also makes
 * QA_MAX_ATTEMPTS retries trivially safe — and revoke its agent when they end
 * (#3459).
 *
 * Errors return as values rather than throws, matching the scenarios'
 * pass/fail idiom: the caller turns them into `fail(...)` with its own
 * context attached.
 */

import { ethers } from 'ethers'
import { signUserOpTypedDataForDelegation } from '@haven_ai/sdk'
import { SEPOLIA_USDC } from './chain.js'
import { thrownErrorDetail } from './thrown-error-detail.js'
import { fail, type ScenarioResult } from '../scenarios/types.js'

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
  accountId: string
  accountAddress: string
  agentId: string
  agentApiKey: string
  /**
   * The delegate HYBRID account — the budget delegation's delegate and the
   * erc7710 child's delegator (#1667). Captured from the grant build so a
   * scenario can assert its on-chain state BEFORE any payment exists.
   */
  delegateAccountAddress: string | null
  grantHash: string
  /** The signed grant's delegation message, retained for direct observer reads. */
  grantDelegation: Record<string, unknown>
  /**
   * Create another agent on the same throwaway Haven account. The new id is
   * registered for cleanup before this returns, so a later scenario failure
   * cannot leak it (#3505/#3459).
   */
  createAdditionalAgent(label: string): Promise<ThrowawayAdditionalAgent | { error: string }>
  /** Build + owner-sign + activate a replacement grant in the same slot. */
  grantAndActivate(): Promise<{ hash: string } | { error: string }>
  /**
   * `POST /agents/:id/revoke` as the throwaway user (#3459). Never throws;
   * resolves to a warning naming the agent id when the revoke did not land.
   */
  revoke(): Promise<string | null>
}

export interface ThrowawayAdditionalAgent {
  delegate: ethers.HDNodeWallet
  agentId: string
  agentApiKey: string
}

/** Provisioning failed; `cleanupWarning` is set when the half-built agent could not be revoked. */
export interface ThrowawayError {
  error: string
  cleanupWarning?: string
}

/**
 * Revoke a throwaway agent as its owning user (#3459). Every qa-dev run
 * otherwise leaves active agents behind, and each one is scanned by the
 * background monitors forever. Returns a warning rather than throwing — a
 * failed cleanup must never change a scenario's verdict.
 */
export async function revokeThrowawayAgent(
  apiUrl: string,
  token: string,
  agentId: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl}/agents/${agentId}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      // A JSON content type with no body is refused by Fastify before the
      // route runs (400 FST_ERR_CTP_EMPTY_JSON_BODY) — the frontend sends `{}`
      // for the same reason.
      body: '{}',
    })
    if (res.ok) return null
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    return `throwaway agent ${agentId} was NOT revoked (${res.status}): ${body.error ?? ''}`
  } catch (e) {
    return `throwaway agent ${agentId} was NOT revoked: ${e instanceof Error ? e.message : String(e)}`
  }
}

/**
 * The only way a scenario should hold a throwaway identity: provision, run
 * the leg, and revoke the agent when it ends — pass, fail or throw — AFTER
 * the leg's own assertions. A thrown error is turned into the failing result
 * the harness would have made of it, so the cleanup warning has a result to
 * ride on. A failed revoke only sets `cleanupWarning`; verdict and `detail`
 * are the leg's own.
 */
export async function withThrowawayIdentity(
  apiUrl: string,
  options: { chainId: number; budgetAtomic: string; label: string },
  leg: (identity: ThrowawayIdentity) => Promise<ScenarioResult>,
): Promise<ScenarioResult> {
  const identity = await provisionThrowawayIdentity(apiUrl, options)
  if ('error' in identity) {
    const failed = fail(identity.error)
    return identity.cleanupWarning ? { ...failed, cleanupWarning: identity.cleanupWarning } : failed
  }
  let result: ScenarioResult
  try {
    result = await leg(identity)
  } catch (e) {
    result = fail(thrownErrorDetail(e))
  }
  const warning = await identity.revoke()
  return warning ? { ...result, cleanupWarning: warning } : result
}

export async function provisionThrowawayIdentity(
  apiUrl: string,
  options: { chainId: number; budgetAtomic: string; label: string },
): Promise<ThrowawayIdentity | ThrowawayError> {
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
  const me = await userCall<{ accounts?: Array<{ id: string; account_address: string; account_type?: string }> }>(
    'GET', '/auth/me', token,
  )
  const safe = me.json.accounts?.find((s) => s.account_type === 'delegator_hybrid')
  if (!safe) return { error: 'provisioned account missing from /auth/me' }
  const accountId = safe.id

  // #2020 retired the per-token `allowances` mirror: POST /agents now REFUSES a
  // non-empty array rather than silently dropping it. The budget this throwaway
  // actually spends is the delegation granted by grantAndActivate() below, so
  // there is nothing to send here.
  const agentRes = await userCall<{ id?: string; api_key?: string; error?: string }>(
    'POST', '/agents', token,
    { name: `QA ${options.label} agent`, delegate_address: delegate.address, account_id: accountId },
  )
  const agentId = agentRes.json.id
  const agentApiKey = agentRes.json.api_key
  if (!agentId || !agentApiKey) {
    return { error: `throwaway agent creation failed (${agentRes.status}): ${agentRes.json.error ?? ''}` }
  }

  let delegateAccountAddress: string | null = null
  let grantDelegation: Record<string, unknown> = {}
  const trackedAgentIds = [agentId]

  async function createAdditionalAgent(
    label: string,
  ): Promise<ThrowawayAdditionalAgent | { error: string }> {
    const additionalDelegate = ethers.Wallet.createRandom()
    const created = await userCall<{ id?: string; api_key?: string; error?: string }>(
      'POST', '/agents', token!,
      {
        name: `QA ${options.label} ${label} agent`,
        delegate_address: additionalDelegate.address,
        account_id: accountId,
      },
    )
    if (created.json.id) trackedAgentIds.push(created.json.id)
    if (!created.json.id || !created.json.api_key) {
      return {
        error: `throwaway ${label} agent creation failed (${created.status}): ${created.json.error ?? ''}`,
      }
    }
    return {
      delegate: additionalDelegate,
      agentId: created.json.id,
      agentApiKey: created.json.api_key,
    }
  }

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
    grantDelegation = built.json.signing_payload.message
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

  // The agent exists from here on, and the caller never receives its id on an
  // error return: revoke it on the way out (#3459).
  const grant = await grantAndActivate().catch((e): { error: string } => ({ error: thrownErrorDetail(e) }))
  if ('error' in grant) {
    const cleanupWarning = await revokeThrowawayAgent(apiUrl, token, agentId)
    return cleanupWarning ? { error: grant.error, cleanupWarning } : { error: grant.error }
  }

  return {
    owner,
    delegate,
    token,
    accountId,
    accountAddress: safe.account_address,
    agentId,
    agentApiKey,
    delegateAccountAddress,
    grantHash: grant.hash,
    grantDelegation,
    createAdditionalAgent,
    grantAndActivate,
    revoke: async () => {
      const warnings = (
        await Promise.all(
          [...trackedAgentIds].reverse().map((id) => revokeThrowawayAgent(apiUrl, token, id)),
        )
      ).filter((warning): warning is string => warning !== null)
      return warnings.length > 0 ? warnings.join('; ') : null
    },
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
  options: { taskBudgetId?: string; subBudgetId?: string } = {},
): Promise<
  | { ok: true; status: number; tx?: string }
  | { ok: false; status: number; error: string; data: Record<string, unknown> }
> {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  const auth = await fetch(`${apiUrl}/payments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      token: 'USDC',
      amount: human,
      to,
      ...(options.taskBudgetId ? { task_budget_id: options.taskBudgetId } : {}),
      ...(options.subBudgetId ? { sub_budget_id: options.subBudgetId } : {}),
    }),
  })
  const intent = (await auth.json().catch(() => ({}))) as {
    payment_id?: string
    sign_data?: { typed_data?: TypedData }
    error?: string
  }
  if (!auth.ok || !intent.payment_id || !intent.sign_data?.typed_data) {
    return {
      ok: false,
      status: auth.status,
      error: intent.error ?? `authorize ${auth.status}`,
      data: intent as Record<string, unknown>,
    }
  }
  const signature = await signUserOpTypedDataForDelegation(delegateKey, intent.sign_data.typed_data as never)
  const submit = await fetch(`${apiUrl}/payments/${intent.payment_id}/sign`, {
    method: 'POST', headers, body: JSON.stringify({ signature }),
  })
  const done = (await submit.json().catch(() => ({}))) as { tx_hash?: string; status?: string; error?: string }
  if (!submit.ok) {
    return {
      ok: false,
      status: submit.status,
      error: done.error ?? `sign ${submit.status}`,
      data: done as Record<string, unknown>,
    }
  }
  return { ok: true, status: submit.status, tx: done.tx_hash }
}
