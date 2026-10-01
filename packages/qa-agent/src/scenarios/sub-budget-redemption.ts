/** Deterministic A→B sub-budget redemption and grant-only refusal (#3505/#3519). */

import { signUserOpTypedDataForDelegation } from '@haven_ai/sdk'
import { SEPOLIA_USDC, proveUsdcTransfer, waitForDisabled } from '../lib/chain.js'
import { readOnchainDelegationBudget } from '../lib/delegation-budget.js'
import {
  payViaDelegation,
  signTyped,
  withThrowawayIdentity,
  type ThrowawayIdentity,
  type TypedData,
} from '../lib/throwaway-identity.js'
import { fail, pass, skip, type Scenario, type ScenarioResult } from './types.js'

const CHAIN_ID = 84532
const ROOT_BUDGET_ATOMIC = '10000'
const FUND_HUMAN = '0.006'
const PREDEPLOY_HUMAN = '0.001'
const REDEEM_HUMAN = '0.001'
const ONE_MILLI_USDC = 1_000n
const GRANT_ATOMIC = '3000'
export const TIMING = { receiptWaitMs: 60_000, pollIntervalMs: 3_000 }

type Json = Record<string, unknown>

async function call<T extends Json>(
  api: string,
  auth: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json().catch(() => ({}))) as T }
}

function atomicToHuman(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const fraction = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

export const subBudgetRedemption: Scenario = {
  name: 'sub-budget-redemption',
  invariant:
    'A sub-agent can redeem a signed A→B grant, and an amount above only that grant is refused by the live grant precheck with typed 403.',
  async run(ctx) {
    const { delegationAgentApiKey, delegationDelegateKey } = ctx.cfg
    if (!delegationAgentApiKey || !delegationDelegateKey) {
      return skip(
        'QA_DELEGATION_AGENT_API_KEY / QA_DELEGATION_DELEGATE_PRIVATE_KEY not set — ' +
          'the sub-budget leg needs the standing identity only as its funding source',
      )
    }
    return withThrowawayIdentity(
      ctx.cfg.apiUrl,
      { chainId: CHAIN_ID, budgetAtomic: ROOT_BUDGET_ATOMIC, label: 'sub-budget' },
      (identity) => runSubBudget(ctx.cfg.apiUrl, identity, {
        apiKey: delegationAgentApiKey,
        delegateKey: delegationDelegateKey,
      }),
    )
  },
}

async function runSubBudget(
  api: string,
  identity: ThrowawayIdentity,
  standing: { apiKey: string; delegateKey: string },
): Promise<ScenarioResult> {
  const additional = await identity.createAdditionalAgent('sub-agent-b')
  if ('error' in additional) return fail(additional.error)

  const funded = await payViaDelegation(
    api, standing.apiKey, standing.delegateKey, identity.accountAddress, FUND_HUMAN,
  )
  if (!funded.ok) return fail(`funding A failed: ${funded.error}`)

  const standingInfo = await call<{ account_address?: string }>(
    api, standing.apiKey, 'GET', '/machine-payments/agent',
  )
  const treasury = standingInfo.json.account_address
  if (standingInfo.status !== 200 || !treasury) return fail('could not resolve the standing treasury')

  // Deploy A's delegate account and consume only A's root budget before the
  // grant exists. This leaves the root strictly wider than the 0.003 grant.
  const predeploy = await payViaDelegation(
    api, identity.agentApiKey, identity.delegate.privateKey, treasury, PREDEPLOY_HUMAN,
  )
  if (!predeploy.ok || !predeploy.tx) return fail(`A predeploy payment failed: ${predeploy.ok ? 'no tx hash' : predeploy.error}`)
  const predeployTransfer = await proveUsdcTransfer(
    predeploy.tx,
    { from: identity.accountAddress, to: treasury, amount: ONE_MILLI_USDC },
    { timeoutMs: TIMING.receiptWaitMs, intervalMs: TIMING.pollIntervalMs },
  )
  if (!predeployTransfer.ok) return fail(`A predeploy payment has no exact Transfer: ${predeployTransfer.error}`)

  const issued = await call<{
    sub_budget?: { id?: string; delegation_hash?: string }
    parent_child_sub_budget?: { id?: string; delegation_hash?: string }
    error?: string
  }>(api, identity.token, 'POST', `/agents/${identity.agentId}/sub-budgets`, {
    sub_agent_id: additional.agentId,
    token_address: SEPOLIA_USDC,
    period_amount_atomic: GRANT_ATOMIC,
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
    recipient_address: treasury,
    label: 'qa A→B grant',
  })
  const grantId = issued.json.sub_budget?.id
  const grantHash = issued.json.sub_budget?.delegation_hash
  const parentId = issued.json.parent_child_sub_budget?.id
  const parentHash = issued.json.parent_child_sub_budget?.delegation_hash
  if (issued.status !== 201 || !grantId || !grantHash || !parentId || !parentHash) {
    return fail(`sub-budget issue failed (${issued.status}): ${issued.json.error ?? ''}`)
  }

  const delegations = new Map<string, Record<string, unknown>>()
  for (const id of [parentId, grantId]) {
    const context = await call<{ sign_data?: { typed_data?: TypedData }; error?: string }>(
      api, identity.agentApiKey, 'GET', `/sub-budgets/${id}/sign-context`,
    )
    const typedData = context.json.sign_data?.typed_data
    if (context.status !== 200 || !typedData) {
      return fail(`sub-budget ${id} sign-context failed (${context.status}): ${context.json.error ?? ''}`)
    }
    delegations.set(id, typedData.message)
    const signature = await signTyped(identity.delegate, typedData)
    const relayed = await call<{ status?: string; error?: string }>(
      api, identity.token, 'POST', `/agents/${identity.agentId}/sub-budgets/${id}/sign`, { signature },
    )
    if (relayed.status !== 200 || relayed.json.status !== 'open') {
      return fail(`sub-budget ${id} signature relay failed (${relayed.status}): ${relayed.json.error ?? ''}`)
    }
  }

  const paid = await payViaDelegation(
    api, additional.agentApiKey, additional.delegate.privateKey, treasury, REDEEM_HUMAN,
    { subBudgetId: grantId },
  )
  if (!paid.ok || !paid.tx) return fail(`B redemption failed: ${paid.ok ? 'no tx hash' : paid.error}`)
  const transfer = await proveUsdcTransfer(
    paid.tx,
    { from: identity.accountAddress, to: treasury, amount: ONE_MILLI_USDC },
    { timeoutMs: TIMING.receiptWaitMs, intervalMs: TIMING.pollIntervalMs },
  )
  if (!transfer.ok) return fail(`B redemption has no exact Transfer: ${transfer.error}`)

  const grant = await readOnchainDelegationBudget(CHAIN_ID, grantHash, delegations.get(grantId)!, GRANT_ATOMIC)
  if ('error' in grant) return fail(`grant live-read failed: ${grant.error}`)
  const parent = await readOnchainDelegationBudget(CHAIN_ID, parentHash, delegations.get(parentId)!, GRANT_ATOMIC)
  if ('error' in parent) return fail(`parent-child live-read failed: ${parent.error}`)
  const root = await readOnchainDelegationBudget(
    CHAIN_ID, identity.grantHash, identity.grantDelegation, ROOT_BUDGET_ATOMIC,
  )
  if ('error' in root) return fail(`A root live-read failed: ${root.error}`)

  if (grant.remaining !== parent.remaining) {
    return fail(
      `the equal-cap child links diverged: grant ${grant.remaining}, parent-child ${parent.remaining}`,
    )
  }
  const refusedAtomic = grant.remaining + 1n
  if (refusedAtomic > root.remaining) {
    return fail(
      `cannot isolate the grant refusal: amount ${refusedAtomic}, grant ${grant.remaining}, ` +
        `parent-child ${parent.remaining}, A root ${root.remaining}`,
    )
  }
  if (grant.remaining >= root.remaining || parent.remaining >= root.remaining) {
    return fail(
      `child-link remaining grant=${grant.remaining}/parent=${parent.remaining} is not strictly below A root ${root.remaining}`,
    )
  }

  const refused = await payViaDelegation(
    api, additional.agentApiKey, additional.delegate.privateKey, treasury, atomicToHuman(refusedAtomic),
    { subBudgetId: grantId },
  )
  if (refused.ok) return fail(`grant-over-budget payment unexpectedly succeeded (${refused.tx ?? 'no tx'})`)
  if (refused.status === 502) {
    return fail(
      `grant-over-budget payment returned 502: the per-link precheck read failed open, then the ` +
        `on-chain enforcer caught the over-budget redemption (${refused.error})`,
    )
  }
  if (refused.status !== 403 || refused.data.error_code !== 'delegation_budget_exceeded') {
    return fail(`grant-over-budget payment returned ${refused.status}/${String(refused.data.error_code)} instead of 403/delegation_budget_exceeded`)
  }
  if (String(refused.data.remaining_atomic) !== grant.remaining.toString()) {
    return fail(
      `403 remaining_atomic ${String(refused.data.remaining_atomic)} does not equal grant live remaining ${grant.remaining}`,
    )
  }
  if (String(refused.data.remaining_atomic) !== parent.remaining.toString()) {
    return fail(
      `403 remaining_atomic ${String(refused.data.remaining_atomic)} does not equal parent-child live remaining ${parent.remaining}`,
    )
  }

  const close = await call<{ error?: string }>(api, identity.agentApiKey, 'POST', `/sub-budgets/${grantId}/close`, {})
  if (close.status !== 200) return fail(`grant close prepare failed (${close.status}): ${close.json.error ?? ''}`)
  const closeContext = await call<{ sign_data?: { typed_data?: TypedData }; error?: string }>(
    api, identity.agentApiKey, 'GET', `/sub-budgets/${grantId}/sign-context`,
  )
  const closeTypedData = closeContext.json.sign_data?.typed_data
  if (closeContext.status !== 200 || !closeTypedData) {
    return fail(`grant close sign-context failed (${closeContext.status}): ${closeContext.json.error ?? ''}`)
  }
  const closeSignature = await signUserOpTypedDataForDelegation(identity.delegate.privateKey, closeTypedData as never)
  const closed = await call<{ status?: string; close_tx_hash?: string; error?: string }>(
    api, identity.agentApiKey, 'POST', `/sub-budgets/${grantId}/submit`, { signature: closeSignature },
  )
  if (closed.status !== 200 || closed.json.status !== 'closed' || !closed.json.close_tx_hash) {
    return fail(`grant close submit did not return closed + close_tx_hash (${closed.status}): ${closed.json.error ?? ''}`)
  }
  const disabled = await waitForDisabled(grantHash, {
    timeoutMs: TIMING.receiptWaitMs, intervalMs: TIMING.pollIntervalMs,
  })
  if (!disabled.ok) return fail(`grant close was reported but the grant is not disabled: ${disabled.error}`)

  return pass(
    `B redeemed 0.001 USDC through grant ${grantHash}; ${refusedAtomic} atomic was above its live ` +
      `${grant.remaining} but within parent ${parent.remaining} and A root ${root.remaining}, and was refused ` +
      `403 delegation_budget_exceeded before the grant closed on-chain in ${closed.json.close_tx_hash}`,
  )
}
