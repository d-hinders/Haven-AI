import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import { HavenApiError } from './types.js'

/**
 * #3506 — the agent completes a sub-budget itself: `submitSubBudget` /
 * `closeSubBudget` hit the agent routes, and `getAgentSummary()` carries the
 * rows this agent still has to sign (`pendingSubBudgetSignatures`).
 */
const baseUrl = 'https://haven.example'
const SIG = `0x${'ab'.repeat(65)}`
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function rawRow(over: Record<string, unknown> = {}) {
  return {
    id: 'sb-1',
    agent_id: 'agent-b',
    parent_agent_id: 'agent-a',
    parent_sub_budget_id: 'sb-0',
    chain_id: 8453,
    token_address: USDC,
    recipient_address: null,
    parent_delegation_hash: `0x${'1'.repeat(64)}`,
    delegation_hash: `0x${'2'.repeat(64)}`,
    label: null,
    period_amount_atomic: '500000',
    status: 'open',
    expires_at: 4102444800,
    is_expired: false,
    created_at: '2026-10-01T00:00:00Z',
    opened_at: '2026-10-01T00:01:00Z',
    closed_at: null,
    close_tx_hash: null,
    ...over,
  }
}

describe('HavenClient sub-budget agent calls (#3506)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('submitSubBudget POSTs the signature to /sub-budgets/:id/submit and maps the row', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ sub_budget: rawRow(), status: 'open' }),
    )
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

    const result = await haven.submitSubBudget('sb-1', SIG)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${baseUrl}/sub-budgets/sb-1/submit`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ signature: SIG })
    expect(result.status).toBe('open')
    expect(result.subBudget).toMatchObject({
      id: 'sb-1',
      agentId: 'agent-b',
      parentAgentId: 'agent-a',
      parentSubBudgetId: 'sb-0',
      periodAmountAtomic: '500000',
      status: 'open',
      isExpired: false,
    })
    expect(result.closeTxHash).toBeUndefined()
  })

  it('submitSubBudget carries close_tx_hash as closeTxHash when a close lands', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ sub_budget: rawRow({ status: 'closed' }), status: 'closed', close_tx_hash: '0xabc' }),
    )
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

    const result = await haven.submitSubBudget('sb-1', SIG)
    expect(result.status).toBe('closed')
    expect(result.closeTxHash).toBe('0xabc')
  })

  it('submitSubBudget URL-encodes the id and maps a backend refusal to HavenApiError', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ error: 'signature_mismatch', error_code: 'signature_mismatch' }, 400),
    )
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

    await expect(haven.submitSubBudget('a/b', SIG)).rejects.toBeInstanceOf(HavenApiError)
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`${baseUrl}/sub-budgets/a%2Fb/submit`)
  })

  it('closeSubBudget POSTs to /sub-budgets/:id/close and returns the sign data for a live child', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        sub_budget: rawRow({ status: 'closing' }),
        sign_data: { signature_scheme: 'eip712_userop', typed_data: { primaryType: 'PackedUserOperation' }, user_op_hash: '0xdead' },
        next_action: 'sign_then_submit',
      }),
    )
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

    const result = await haven.closeSubBudget('sb-1')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${baseUrl}/sub-budgets/sb-1/close`)
    expect(init.method).toBe('POST')
    expect(result.status).toBeUndefined()
    expect(result.signData?.user_op_hash).toBe('0xdead')
    expect(result.nextAction).toBe('sign_then_submit')
    expect(result.subBudget.status).toBe('closing')
  })

  it('closeSubBudget reports a trivial close', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ sub_budget: rawRow({ status: 'closed' }), status: 'closed' }),
    )
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

    const result = await haven.closeSubBudget('sb-1')
    expect(result.status).toBe('closed')
    expect(result.signData).toBeUndefined()
  })

  it('listPendingSubBudgetSignatures reads the delegating-side filter and THROWS on a transport failure (unlike the summary)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ sub_budgets: [rawRow({ id: 'sb-0', agent_id: 'agent-a', parent_sub_budget_id: null, status: 'pending' })] }),
    )
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

    const rows = await haven.listPendingSubBudgetSignatures()
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`${baseUrl}/sub-budgets?status=awaiting_signature`)
    expect(rows.map((r) => r.subBudgetId)).toEqual(['sb-0'])

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
    await expect(haven.listPendingSubBudgetSignatures()).rejects.toBeInstanceOf(HavenApiError)
  })

  describe('getAgentSummary().pendingSubBudgetSignatures', () => {
    function stubSummary(subBudgetsResponse: () => Response | Promise<Response>) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const u = String(input)
        if (u.includes('/machine-payments/agent')) {
          return jsonResponse({
            id: 'agent-a', name: 'A', status: 'active', account_address: '0xSafe',
            delegate_address: '0xDelegate', chain_id: 8453, execution_rail: 'delegation',
          })
        }
        if (u.includes('/machine-payments/allowances')) {
          return jsonResponse({ agent_id: 'agent-a', account_address: '0xSafe', delegate_address: '0xDelegate', chain_id: 8453, allowances: [] })
        }
        if (u.includes('/task-budgets')) return jsonResponse({ task_budgets: [] })
        if (u.includes('/sub-budgets')) return subBudgetsResponse()
        throw new Error(`Unexpected ${u}`)
      })
    }

    it('asks the delegating-side filter and maps each row to a sign target (parent-child and grant, open and close)', async () => {
      const fetchMock = stubSummary(() =>
        jsonResponse({
          sub_budgets: [
            rawRow({ id: 'sb-0', agent_id: 'agent-a', parent_sub_budget_id: null, status: 'pending' }),
            rawRow({ id: 'sb-1', status: 'pending' }),
            rawRow({ id: 'sb-2', status: 'closing', expires_at: 4102444801 }),
          ],
        }),
      )
      const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

      const summary = await haven.getAgentSummary()

      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls).toContain(`${baseUrl}/sub-budgets?status=awaiting_signature`)
      expect(summary.pendingSubBudgetSignatures).toEqual([
        { subBudgetId: 'sb-0', parentSubBudgetId: null, purpose: 'open', what: 'parent-child', subAgentId: null, tokenAddress: USDC, recipientAddress: null, periodAmountAtomic: '500000', expiresAt: 4102444800, isExpired: false },
        { subBudgetId: 'sb-1', parentSubBudgetId: 'sb-0', purpose: 'open', what: 'grant', subAgentId: 'agent-b', tokenAddress: USDC, recipientAddress: null, periodAmountAtomic: '500000', expiresAt: 4102444800, isExpired: false },
        { subBudgetId: 'sb-2', parentSubBudgetId: 'sb-0', purpose: 'close', what: 'grant', subAgentId: 'agent-b', tokenAddress: USDC, recipientAddress: null, periodAmountAtomic: '500000', expiresAt: 4102444801, isExpired: false },
      ])
    })

    it('is empty when nothing is owed', async () => {
      stubSummary(() => jsonResponse({ sub_budgets: [] }))
      const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
      expect((await haven.getAgentSummary()).pendingSubBudgetSignatures).toEqual([])
    })

    it('fails SOFT: a 404, a network error or a malformed body degrade to [], never a failed summary', async () => {
      for (const respond of [
        () => jsonResponse({ error: 'not found' }, 404),
        () => { throw new Error('network down') },
        () => jsonResponse({ sub_budgets: 'nope' }),
      ]) {
        vi.restoreAllMocks()
        stubSummary(respond)
        const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
        const summary = await haven.getAgentSummary()
        expect(summary.pendingSubBudgetSignatures).toEqual([])
        expect(summary.id).toBe('agent-a')
      }
    })
  })
})
