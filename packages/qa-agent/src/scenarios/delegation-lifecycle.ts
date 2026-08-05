/**
 * Delegation lifecycle — authority can be TAKEN AWAY (#1065).
 *
 * The other delegation legs prove payments settle; this one proves the
 * user's only circuit breaker works end to end: grant → activate → pay →
 * replace (exactly ONE active row — the #1053-finding-4 regression, where a
 * non-transactional activate could leave a slot with zero active grants
 * while the old one stayed valid on-chain) → revoke → the same payment
 * shape is REFUSED with 403 "no active budget delegation". The 403/502
 * distinction is the point: a 502 would mean authority was still being
 * OFFERED to the chain and only the caveats stopped it.
 *
 * Isolation: the standing QA identity's open budget is what every other leg
 * depends on, so this scenario NEVER touches it. Each run provisions a fresh
 * throwaway identity (signup → hybrid account → agent → grant), funds it
 * with a small payment FROM the standing identity, and abandons it — which
 * also makes QA_MAX_ATTEMPTS retries trivially safe. Owner keys are
 * ephemeral in-scenario wallets; all signing is client-side (non-custody
 * preserved even in QA).
 */

import { ethers } from 'ethers'
import { signUserOpTypedDataForDelegation } from '@haven_ai/sdk'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'

const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const CHAIN_ID = 84532

/** Small enough to be cheap, big enough for two 0.002 payments. */
const FUND_HUMAN = '0.006'
const PAY_HUMAN = '0.002'
const BUDGET_ATOMIC = '10000' // 0.01 USDC/day — the throwaway grant

interface TypedData {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType?: string
  message: Record<string, unknown>
}

async function signTyped(wallet: ethers.Wallet | ethers.HDNodeWallet, td: TypedData): Promise<string> {
  const types = Object.fromEntries(Object.entries(td.types).filter(([k]) => k !== 'EIP712Domain'))
  return wallet.signTypedData(td.domain as never, types as never, td.message as never)
}

export const delegationLifecycle: Scenario = {
  name: 'delegation-lifecycle',
  invariant:
    'A budget grant can be activated, replaced (exactly one active row), and revoked — ' +
    'after revoke the same payment shape is refused with 403, never offered to the chain.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.delegationAgentApiKey || !ctx.cfg.delegationDelegateKey) {
      return skip(
        'QA_DELEGATION_AGENT_API_KEY / QA_DELEGATION_DELEGATE_PRIVATE_KEY not set — ' +
          'the lifecycle needs the standing delegation identity as its funding source (#1063)',
      )
    }
    const api = ctx.cfg.apiUrl

    // ── throwaway identity for THIS run ──────────────────────────────────────
    const owner = ethers.Wallet.createRandom()
    const delegate = ethers.Wallet.createRandom()
    const email = `qa-lifecycle-${Math.random().toString(36).slice(2, 10)}@haven.test`
    const password = 'Qa-' + ethers.Wallet.createRandom().privateKey.slice(2, 26)

    async function userCall<T>(method: string, path: string, token: string | null, body?: unknown) {
      const res = await fetch(`${api}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: res.status, json: (await res.json().catch(() => ({}))) as T }
    }

    const signup = await userCall<{ token?: string }>('POST', '/auth/signup', null, {
      name: 'QA lifecycle (throwaway)', email, password,
    })
    const token = signup.json.token
    if (!token) return fail(`throwaway signup failed (${signup.status})`)

    const hybrid = await userCall<{ error?: string }>('POST', '/accounts/hybrid', token, {
      chain_id: CHAIN_ID, owner_address: owner.address,
    })
    if (hybrid.status !== 201) return fail(`hybrid provisioning failed (${hybrid.status}): ${hybrid.json.error ?? ''}`)
    const me = await userCall<{ safes?: Array<{ id: string; safe_address: string; account_type?: string }> }>(
      'GET', '/auth/me', token,
    )
    const safe = me.json.safes?.find((s) => s.account_type === 'delegator_hybrid')
    if (!safe) return fail('provisioned account missing from /auth/me')

    const agentRes = await userCall<{ id?: string; api_key?: string }>('POST', '/agents', token, {
      name: 'QA lifecycle agent', delegate_address: delegate.address, safe_id: safe.id,
      allowances: [{ token_address: SEPOLIA_USDC, token_symbol: 'USDC', allowance_amount: BUDGET_ATOMIC, reset_period_min: 1440 }],
    })
    const agentId = agentRes.json.id
    const agentKey = agentRes.json.api_key
    if (!agentId || !agentKey) return fail(`throwaway agent creation failed (${agentRes.status})`)

    // ── grant + activate (owner signs; activation relayer-deploys) ───────────
    async function grantAndActivate(): Promise<{ hash: string } | { error: string }> {
      const built = await userCall<{ delegation_hash?: string; signing_payload?: TypedData; error?: string }>(
        'POST', `/agents/${agentId}/delegations/build`, token!,
        { token_address: SEPOLIA_USDC, budget_atomic: BUDGET_ATOMIC, period_seconds: 86_400 },
      )
      if (!built.json.delegation_hash || !built.json.signing_payload) {
        return { error: `grant build failed (${built.status}): ${built.json.error ?? ''}` }
      }
      const signature = await signTyped(owner, built.json.signing_payload)
      const act = await userCall<{ error?: string }>(
        'POST', `/agents/${agentId}/delegations/${built.json.delegation_hash}/activate`, token!, { signature },
      )
      if (act.status !== 200) return { error: `activate failed (${act.status}): ${act.json.error ?? ''}` }
      return { hash: built.json.delegation_hash }
    }

    const grant1 = await grantAndActivate()
    if ('error' in grant1) return fail(grant1.error)

    // ── fund the throwaway treasury from the STANDING identity ───────────────
    async function payAs(apiKey: string, delegateKey: string, to: string, human: string) {
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
      const auth = await fetch(`${api}/payments`, {
        method: 'POST', headers, body: JSON.stringify({ token: 'USDC', amount: human, to }),
      })
      const intent = (await auth.json().catch(() => ({}))) as {
        payment_id?: string
        sign_data?: { typed_data?: TypedData }
        error?: string
      }
      if (!auth.ok || !intent.payment_id || !intent.sign_data?.typed_data) {
        return { ok: false as const, status: auth.status, error: intent.error ?? `authorize ${auth.status}` }
      }
      const signature = await signUserOpTypedDataForDelegation(delegateKey, intent.sign_data.typed_data as never)
      const submit = await fetch(`${api}/payments/${intent.payment_id}/sign`, {
        method: 'POST', headers, body: JSON.stringify({ signature }),
      })
      const done = (await submit.json().catch(() => ({}))) as { tx_hash?: string; status?: string; error?: string }
      if (!submit.ok) return { ok: false as const, status: submit.status, error: done.error ?? `sign ${submit.status}` }
      return { ok: true as const, status: submit.status, tx: done.tx_hash }
    }

    const funding = await payAs(
      ctx.cfg.delegationAgentApiKey, ctx.cfg.delegationDelegateKey, safe.safe_address, FUND_HUMAN,
    )
    if (!funding.ok) return fail(`funding the throwaway treasury failed: ${funding.error}`)

    // ── 1. within-budget payment settles (recipient: the standing treasury) ──
    const standingTreasury = await (async () => {
      const res = await fetch(`${api}/machine-payments/agent`, {
        headers: { authorization: `Bearer ${ctx.cfg.delegationAgentApiKey}` },
      })
      const data = (await res.json().catch(() => ({}))) as { safe_address?: string }
      return data.safe_address
    })()
    if (!standingTreasury) return fail('could not resolve the standing treasury as payment recipient')

    const pay1 = await payAs(agentKey, delegate.privateKey, standingTreasury, PAY_HUMAN)
    if (!pay1.ok) return fail(`post-activate payment failed: ${pay1.error}`)

    // ── 2. replace: same slot → EXACTLY ONE active row (#1053 finding 4) ─────
    const grant2 = await grantAndActivate()
    if ('error' in grant2) return fail(`replacement grant failed: ${grant2.error}`)
    const list = await userCall<{ delegations?: Array<{ status: string; delegation_hash: string }> }>(
      'GET', `/agents/${agentId}/delegations`, token,
    )
    const active = (list.json.delegations ?? []).filter((d) => d.status === 'active')
    if (active.length !== 1) {
      return fail(
        `after replacement the slot has ${active.length} active grants, expected exactly 1 — ` +
          'the transactional-activate regression (#1053 finding 4)',
      )
    }
    if (active[0].delegation_hash !== grant2.hash) {
      return fail('the surviving active grant is not the replacement')
    }

    // ── 3. revoke (owner signs the treasury op) ──────────────────────────────
    const prep = await userCall<{
      signature_scheme?: string
      signing_payload?: TypedData
      user_operation?: unknown
      error?: string
    }>('POST', `/agents/${agentId}/delegations/${grant2.hash}/revoke`, token, {
      signature_scheme: 'eip712_userop',
    })
    if (prep.json.signature_scheme !== 'eip712_userop' || !prep.json.signing_payload) {
      return fail(`revoke prepare failed (${prep.status}): ${prep.json.error ?? ''}`)
    }
    const revokeSig = await signTyped(owner, prep.json.signing_payload)
    const submit = await userCall<{ revoked?: boolean; error?: string }>(
      'POST', `/agents/${agentId}/delegations/${grant2.hash}/revoke/submit`, token,
      { signature: revokeSig, user_operation: prep.json.user_operation },
    )
    if (!submit.json.revoked) return fail(`revoke submit failed (${submit.status}): ${submit.json.error ?? ''}`)

    // ── 4. the SAME payment shape is now REFUSED — 403, never 502 ────────────
    const pay2 = await payAs(agentKey, delegate.privateKey, standingTreasury, PAY_HUMAN)
    if (pay2.ok) {
      return fail(`payment SUCCEEDED after revoke (${pay2.tx ?? 'no tx'}) — the circuit breaker did not break`)
    }
    if (pay2.status !== 403) {
      return fail(
        `post-revoke payment was rejected with ${pay2.status}, expected 403 — a 502 here means ` +
          `authority was still offered to the chain (${pay2.error})`,
      )
    }
    if (!/no active budget delegation/i.test(pay2.error ?? '')) {
      return fail(`post-revoke 403 carried the wrong reason: ${pay2.error}`)
    }

    return pass(
      `lifecycle proven on a throwaway identity: grant activated (deploy + pay ${PAY_HUMAN} USDC, ` +
        `tx ${pay1.tx ?? 'submitted'}), replacement left exactly 1 active row, revoke flipped the ` +
        `same payment shape to 403 "no active budget delegation" — never a chain-side rejection`,
    )
  },
}
