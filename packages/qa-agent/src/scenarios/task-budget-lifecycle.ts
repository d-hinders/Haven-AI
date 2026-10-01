/** Deterministic task-budget open/close lifecycle (#3505). */

import { signUserOpTypedDataForDelegation } from '@haven_ai/sdk'
import { waitForDisabled } from '../lib/chain.js'
import {
  signTyped,
  withThrowawayIdentity,
  type ThrowawayIdentity,
  type TypedData,
} from '../lib/throwaway-identity.js'
import { fail, pass, type Scenario, type ScenarioResult } from './types.js'

const CHAIN_ID = 84532
const BUDGET_ATOMIC = '10000'
export const TIMING = { disabledWaitMs: 60_000, pollIntervalMs: 3_000 }

type Json = Record<string, unknown>

async function agentCall<T extends Json>(
  api: string,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json().catch(() => ({}))) as T }
}

export const taskBudgetLifecycle: Scenario = {
  name: 'task-budget-lifecycle',
  invariant:
    'A task budget can be opened and closed using freshly fetched sign-context bytes, and the child is disabled on-chain.',
  run(ctx) {
    return withThrowawayIdentity(
      ctx.cfg.apiUrl,
      { chainId: CHAIN_ID, budgetAtomic: BUDGET_ATOMIC, label: 'task-budget' },
      (identity) => runTaskBudgetLifecycle(ctx.cfg.apiUrl, identity),
    )
  },
}

async function runTaskBudgetLifecycle(api: string, identity: ThrowawayIdentity): Promise<ScenarioResult> {
  const created = await agentCall<{
    task_budget?: { id?: string; delegation_hash?: string }
    sign_data?: unknown
    error?: string
  }>(api, identity.agentApiKey, 'POST', '/task-budgets', {
    max_amount_atomic: '3000',
    ttl_seconds: 86_400,
    label: 'qa lifecycle',
  })
  const id = created.json.task_budget?.id
  const hash = created.json.task_budget?.delegation_hash
  if (created.status !== 201 || !id || !hash) {
    return fail(`task-budget create failed (${created.status}): ${created.json.error ?? ''}`)
  }

  // Deliberately ignore POST's inline sign_data. The portable recovery path is
  // the byte-free, re-servable sign-context endpoint (#3491).
  const openContext = await agentCall<{
    typed_data?: TypedData
    error?: string
  }>(api, identity.agentApiKey, 'GET', `/task-budgets/${id}/sign-context`)
  const openTypedData = openContext.json.typed_data
  if (openContext.status !== 200 || !openTypedData) {
    return fail(`task-budget open sign-context failed (${openContext.status}): ${openContext.json.error ?? ''}`)
  }
  const openSignature = await signTyped(identity.delegate, openTypedData)
  const opened = await agentCall<{ status?: string; error?: string }>(
    api, identity.agentApiKey, 'POST', `/task-budgets/${id}/submit`, { signature: openSignature },
  )
  if (opened.status !== 200 || opened.json.status !== 'open') {
    return fail(`task-budget open submit failed (${opened.status}): ${opened.json.error ?? ''}`)
  }

  const close = await agentCall<{ sign_data?: unknown; error?: string }>(
    api, identity.agentApiKey, 'POST', `/task-budgets/${id}/close`, {},
  )
  if (close.status !== 200) return fail(`task-budget close prepare failed (${close.status}): ${close.json.error ?? ''}`)

  // Ignore close's inline bytes too: stale/restarted clients must recover from
  // GET sign-context, and a 500 here is the pre-#3491 regression.
  const closeContext = await agentCall<{
    typed_data?: TypedData
    error?: string
  }>(api, identity.agentApiKey, 'GET', `/task-budgets/${id}/sign-context`)
  const closeTypedData = closeContext.json.typed_data
  if (closeContext.status !== 200 || !closeTypedData) {
    return fail(`task-budget close sign-context failed (${closeContext.status}): ${closeContext.json.error ?? ''}`)
  }
  const closeSignature = await signUserOpTypedDataForDelegation(identity.delegate.privateKey, closeTypedData as never)
  const closed = await agentCall<{ status?: string; close_tx_hash?: string; error?: string }>(
    api, identity.agentApiKey, 'POST', `/task-budgets/${id}/submit`, { signature: closeSignature },
  )
  if (closed.status !== 200 || closed.json.status !== 'closed' || !closed.json.close_tx_hash) {
    return fail(
      `task-budget close submit did not return closed + close_tx_hash (${closed.status}): ${closed.json.error ?? ''}`,
    )
  }
  const disabled = await waitForDisabled(hash, {
    timeoutMs: TIMING.disabledWaitMs,
    intervalMs: TIMING.pollIntervalMs,
  })
  if (!disabled.ok) return fail(`task-budget close was reported but the child is not disabled: ${disabled.error}`)

  return pass(`task budget ${id} opened and closed via both sign-context reads; child ${hash} disabled in tx ${closed.json.close_tx_hash}`)
}
