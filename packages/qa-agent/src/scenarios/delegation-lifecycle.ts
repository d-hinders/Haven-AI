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

import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'
import {
  provisionThrowawayIdentity,
  payViaDelegation,
  signTyped,
  type TypedData,
} from '../lib/throwaway-identity.js'

const CHAIN_ID = 84532

/** Small enough to be cheap, big enough for two 0.002 payments. */
const FUND_HUMAN = '0.006'
const PAY_HUMAN = '0.002'
const BUDGET_ATOMIC = '10000' // 0.01 USDC/day — the throwaway grant

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

    // ── throwaway identity for THIS run (lib since #1674's second consumer) ──
    const identity = await provisionThrowawayIdentity(api, {
      chainId: CHAIN_ID, budgetAtomic: BUDGET_ATOMIC, label: 'lifecycle',
    })
    if ('error' in identity) return fail(identity.error)
    const { owner, delegate, token, agentId, grantAndActivate } = identity
    const agentKey = identity.agentApiKey
    const safe = { safe_address: identity.safeAddress }

    async function userCall<T>(method: string, path: string, jwt: string | null, body?: unknown) {
      const res = await fetch(`${api}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: res.status, json: (await res.json().catch(() => ({}))) as T }
    }

    const payAs = (apiKey: string, delegateKey: string, to: string, human: string) =>
      payViaDelegation(api, apiKey, delegateKey, to, human)

    // ── fund the throwaway treasury from the STANDING identity ───────────────
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
