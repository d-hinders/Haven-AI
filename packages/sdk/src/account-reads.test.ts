import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountReads } from './account-reads.js'
import { HavenApiTransport } from './haven-api-transport.js'
import { AgentPaymentWarningCode, type PaymentStatusResult } from './types.js'

const BASE_URL = 'https://haven.test'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function agent(executionRail = 'legacy') {
  return {
    id: 'agent_1', name: 'Read agent', status: 'active',
    account_address: '0xsafe', delegate_address: '0xdelegate', chain_id: 8453,
    execution_rail: executionRail,
  }
}

function allowance(remaining = '4960000') {
  return {
    agent_id: 'agent_1', account_address: '0xsafe', delegate_address: '0xdelegate', chain_id: 8453,
    allowances: [{
      id: 'allowance_1', token_address: USDC, token_symbol: 'USDC', configured_amount: '5000000', reset_period_min: 1440,
      onchain: { amount: '5000000', spent: '40000', remaining, effective_spent: '40000', reset_time_min: 1440, last_reset_min: 0, nonce: 1, is_reset_pending: false },
    }],
  }
}

function reads(getPaymentStatus: (id: string) => Promise<PaymentStatusResult>) {
  return new AccountReads({
    transport: new HavenApiTransport({ apiKey: 'sk_agent_test', baseUrl: BASE_URL }),
    getPaymentStatus,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AccountReads', () => {
  it('coalesces concurrent agent reads but leaves sequential reads fresh', async () => {
    let resolveFirst!: (response: Response) => void
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveFirst = resolve }))
    vi.stubGlobal('fetch', fetch)
    const service = reads(async () => ({}) as PaymentStatusResult)

    const first = service.getAgent()
    const second = service.getAgent()
    expect(fetch).toHaveBeenCalledTimes(1)
    resolveFirst(json(agent()))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(agent())))
    await service.getAgent()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('maps allowance rows and derives the same ready summary from the live authority read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent())
      if (path === '/machine-payments/allowances') return json(allowance())
      if (path === '/task-budgets') return json({ task_budgets: [] })
      throw new Error(`Unexpected ${path}`)
    }))
    const service = reads(async () => ({}) as PaymentStatusResult)

    await expect(service.getAgentSummary()).resolves.toMatchObject({
      executionRail: 'legacy', readiness: 'ready', spend_authority_readiness: 'ready',
      allowances: [{ remainingAtomic: '4960000', remainingDisplay: '4.96 USDC' }],
    })
  })

  // #3329 / #3093: the task-budget read must fail SOFT — a 404, a
  // transport error, an undefined/null body, or a missing/non-array
  // `task_budgets` key all degrade to `taskBudgets: []`, never a thrown
  // getAgentSummary().
  it('degrades task budgets to [] on a 404 (a backend that predates #3329)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent())
      if (path === '/machine-payments/allowances') return json(allowance())
      if (path === '/task-budgets') return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      throw new Error(`Unexpected ${path}`)
    }))
    const service = reads(async () => ({}) as PaymentStatusResult)
    await expect(service.getAgentSummary()).resolves.toMatchObject({ taskBudgets: [] })
  })

  it('degrades task budgets to [] on an undefined/null response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent())
      if (path === '/machine-payments/allowances') return json(allowance())
      if (path === '/task-budgets') return json(null)
      throw new Error(`Unexpected ${path}`)
    }))
    const service = reads(async () => ({}) as PaymentStatusResult)
    await expect(service.getAgentSummary()).resolves.toMatchObject({ taskBudgets: [] })
  })

  it('degrades task budgets to [] when task_budgets is missing or not an array', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent())
      if (path === '/machine-payments/allowances') return json(allowance())
      if (path === '/task-budgets') return json({ task_budgets: 'not-an-array' })
      throw new Error(`Unexpected ${path}`)
    }))
    const service = reads(async () => ({}) as PaymentStatusResult)
    await expect(service.getAgentSummary()).resolves.toMatchObject({ taskBudgets: [] })
  })

  it('degrades task budgets to [] on ANY transport error (network failure, not just 404)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent())
      if (path === '/machine-payments/allowances') return json(allowance())
      if (path === '/task-budgets') throw new Error('network down')
      throw new Error(`Unexpected ${path}`)
    }))
    const service = reads(async () => ({}) as PaymentStatusResult)
    await expect(service.getAgentSummary()).resolves.toMatchObject({ taskBudgets: [] })
  })

  // #3501: the summary rows carry the budget-visibility figures — what the
  // chain will still allow through each open task budget — so an agent
  // reading getAgentSummary can tell BEFORE its next payment whether the
  // task budget will refuse it.
  it('maps task-budget spent/remaining with the honesty flag and a matching display (#3501)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent('delegation'))
      if (path === '/machine-payments/allowances') return json(allowance())
      if (path === '/task-budgets') {
        return json({ task_budgets: [{
          id: 'tb-1', agent_id: 'agent_1', chain_id: 8453, token_address: USDC,
          recipient_address: null, parent_delegation_hash: `0x${'ab'.repeat(32)}`,
          delegation_hash: `0x${'cd'.repeat(32)}`, label: 'Research', max_atomic: '1500',
          // The issue's reproduction: 1000 + 500 spent under a 1500 cap.
          spent_atomic: '1500', remaining_atomic: '0', remaining_is_from_chain: true,
          status: 'open', expires_at: 9999999999, is_expired: false,
          created_at: '2026-09-30T00:00:00.000Z', opened_at: '2026-09-30T00:00:00.000Z',
          closed_at: null, close_tx_hash: null,
        }] })
      }
      throw new Error(`Unexpected ${path}`)
    }))
    const service = reads(async () => ({}) as PaymentStatusResult)
    const summary = await service.getAgentSummary()
    expect(summary.taskBudgets).toHaveLength(1)
    const row = summary.taskBudgets[0]
    expect(row.spentAtomic).toBe('1500')
    expect(row.remainingAtomic).toBe('0')
    expect(row.remainingIsFromChain).toBe(true)
    // formatAtomicAmount keeps one decimal place — the shared SDK formatter,
    // same shape maxDisplay uses.
    expect(row.remainingDisplay).toBe('0.0 USDC')
    expect(row.maxDisplay).toBe('0.0015 USDC')
  })

  it('#3501: a failed on-chain read (null figures, false flag) maps to null remaining — never the full cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent('delegation'))
      if (path === '/machine-payments/allowances') return json(allowance())
      if (path === '/task-budgets') {
        return json({ task_budgets: [{
          id: 'tb-1', agent_id: 'agent_1', chain_id: 8453, token_address: USDC,
          recipient_address: null, parent_delegation_hash: `0x${'ab'.repeat(32)}`,
          delegation_hash: `0x${'cd'.repeat(32)}`, label: 'Research', max_atomic: '1500',
          spent_atomic: null, remaining_atomic: null, remaining_is_from_chain: false,
          status: 'open', expires_at: 9999999999, is_expired: false,
          created_at: '2026-09-30T00:00:00.000Z', opened_at: '2026-09-30T00:00:00.000Z',
          closed_at: null, close_tx_hash: null,
        }] })
      }
      throw new Error(`Unexpected ${path}`)
    }))
    const service = reads(async () => ({}) as PaymentStatusResult)
    const summary = await service.getAgentSummary()
    const row = summary.taskBudgets[0]
    expect(row.spentAtomic).toBeNull()
    expect(row.remainingAtomic).toBeNull()
    expect(row.remainingDisplay).toBeNull()
    expect(row.remainingIsFromChain).toBe(false)
    expect(row.remainingAtomic).not.toBe('1500')
  })

  it('#3501: a backend without the new keys maps to the honest degraded shape (nulls, false flag)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent('delegation'))
      if (path === '/machine-payments/allowances') return json(allowance())
      if (path === '/task-budgets') {
        return json({ task_budgets: [{
          id: 'tb-1', agent_id: 'agent_1', chain_id: 8453, token_address: USDC,
          recipient_address: null, parent_delegation_hash: `0x${'ab'.repeat(32)}`,
          delegation_hash: `0x${'cd'.repeat(32)}`, label: 'Research', max_atomic: '1500',
          status: 'open', expires_at: 9999999999, is_expired: false,
          created_at: '2026-09-30T00:00:00.000Z', opened_at: '2026-09-30T00:00:00.000Z',
          closed_at: null, close_tx_hash: null,
        }] })
      }
      throw new Error(`Unexpected ${path}`)
    }))
    const service = reads(async () => ({}) as PaymentStatusResult)
    const summary = await service.getAgentSummary()
    const row = summary.taskBudgets[0]
    expect(row.spentAtomic).toBeNull()
    expect(row.remainingAtomic).toBeNull()
    expect(row.remainingIsFromChain).toBe(false)
    expect(row.remainingDisplay).toBeNull()
  })

  it('keeps a settled status when the best-effort allowance read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent('delegation'))
      if (path === '/machine-payments/allowances') return new Response(JSON.stringify({ error: 'offline' }), { status: 503 })
      throw new Error(`Unexpected ${path}`)
    }))
    const payment = { paymentId: 'pay_1', asset: USDC, x402: undefined } as PaymentStatusResult
    const service = reads(async () => payment)

    await expect(service.getPostPurchaseAllowanceSummary('pay_1')).resolves.toMatchObject({
      payment,
      allowance: null,
      warnings: [{ code: AgentPaymentWarningCode.AllowanceCheckUnavailable }],
    })
  })

  it('does not expose a payment when malformed allowance data prevents the final match', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent())
      if (path === '/machine-payments/allowances') return json(allowance())
      throw new Error(`Unexpected ${path}`)
    }))
    const payment = { paymentId: 'pay_1', asset: 12 as unknown as string } as PaymentStatusResult
    const service = reads(async () => payment)

    await expect(service.getPostPurchaseAllowanceSummary('pay_1')).resolves.toMatchObject({
      payment: null,
      allowance: null,
      warnings: [{ code: AgentPaymentWarningCode.AllowanceCheckUnavailable }],
    })
  })

  // ── #3518: the settle summary reports the budget that PAID ──────────────
  // The payment status carries `budgetDelegationHash` (recorded at authorize,
  // migration 053); the allowance row whose `delegationHash` equals it is the
  // one whose remaining figure is honest. The fixture is the issue's own
  // two-budget shape — an OPEN allowance created FIRST and a PINNED one for
  // the same token — so the first token row is deliberately NOT the one that
  // paid, which is exactly what the old first-match rule reported.
  const OPEN_BUDGET_HASH = `0x${'aa'.repeat(32)}`
  const PINNED_BUDGET_HASH = `0x${'bb'.repeat(32)}`
  const PINNED_MERCHANT = '0x' + 'ee'.repeat(20)

  /** The issue's fixture: open 0.001 created first, pinned 5,000,000 second. */
  function twoBudgetAllowance() {
    return {
      agent_id: 'agent_1', account_address: '0xsafe', delegate_address: '0xdelegate', chain_id: 8453,
      allowances: [
        {
          id: 'allowance_open', token_address: USDC, token_symbol: 'USDC',
          configured_amount: '1000', reset_period_min: 1440,
          delegation_hash: OPEN_BUDGET_HASH, recipient_address: null, merchant_id: null,
          reserved_haven_atomic: '0',
          onchain: { amount: '1000', spent: '0', remaining: '1000', effective_spent: '0', reset_time_min: 1440, last_reset_min: 0, nonce: 1, is_reset_pending: false },
        },
        {
          id: 'allowance_pinned', token_address: USDC, token_symbol: 'USDC',
          configured_amount: '5000000000000', reset_period_min: 1440,
          delegation_hash: PINNED_BUDGET_HASH, recipient_address: PINNED_MERCHANT, merchant_id: null,
          reserved_haven_atomic: '0',
          onchain: { amount: '5000000000000', spent: '0', remaining: '5000000000000', effective_spent: '0', reset_time_min: 1440, last_reset_min: 0, nonce: 1, is_reset_pending: false },
        },
      ],
    }
  }

  function settleReads(payment: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent('delegation'))
      if (path === '/machine-payments/allowances') return json(twoBudgetAllowance())
      throw new Error(`Unexpected ${path}`)
    }))
    return reads(async () => payment as unknown as PaymentStatusResult)
  }

  it('#3518: the recorded budget_delegation_hash picks the PINNED row — the one that paid, not the first token row', async () => {
    const service = settleReads({
      paymentId: 'pay_1', asset: USDC, status: 'settled',
      budgetDelegationHash: PINNED_BUDGET_HASH,
    })
    const summary = await service.getPostPurchaseAllowanceSummary('pay_1')
    expect(summary.allowance).not.toBeNull()
    // The pinned budget paid: its remaining (5,000,000,000,000), never the
    // open row's 1000 that first-match would have named.
    expect(summary.allowance?.remaining_atomic).toBe('5000000000000')
    expect(summary.allowance?.tokenAddress).toBe(USDC)
    expect(summary.warnings).toEqual([])
  })

  it('#3518: a payment whose recorded hash names its task-budget PARENT still keys on the hash, not the payee', async () => {
    // A task-budget payment meters its PARENT by hash; the parent here is the
    // OPEN budget (a task payment matches no pin at all — the case where a
    // re-derived (token, payee) rule would answer the pinned row).
    const service = settleReads({
      paymentId: 'pay_1', asset: USDC, status: 'settled',
      budgetDelegationHash: OPEN_BUDGET_HASH,
    })
    const summary = await service.getPostPurchaseAllowanceSummary('pay_1')
    expect(summary.allowance?.remaining_atomic).toBe('1000')
  })

  it('#3518: a status payload from an older backend (no recorded hash) keeps the token first-match fallback', async () => {
    const service = settleReads({ paymentId: 'pay_1', asset: USDC, status: 'settled' })
    const summary = await service.getPostPurchaseAllowanceSummary('pay_1')
    // No paying hash on the wire: the legacy first-match behaviour, kept only
    // where nothing better exists.
    expect(summary.allowance?.remaining_atomic).toBe('1000')
  })

  it('#3518: a recorded hash that matches none of the agent\'s rows is unavailable — never another budget\'s figure', async () => {
    // A sub-budget payment meters the PARENT agent's budget, and a re-key
    // between pay and settle retires the hash: either way the caller's first
    // per-token row did not pay, and reporting it is the #3518 bug.
    const service = settleReads({
      paymentId: 'pay_1', asset: USDC, status: 'settled',
      budgetDelegationHash: `0x${'cc'.repeat(32)}`,
    })
    const summary = await service.getPostPurchaseAllowanceSummary('pay_1')
    expect(summary.allowance).toBeNull()
    expect(summary.warnings).toHaveLength(1)
    expect(summary.warnings[0].code).toBe('ALLOWANCE_CHECK_UNAVAILABLE')
    expect(summary.warnings[0].message).toContain("not one of this agent's own budgets")
  })

  // #3518: the agent read's task-budget list asks for `status=live` (the
  // backend bounds it) and ALSO filters client-side — closing rows always
  // ride, closed and expired rows drop — so a backend that refuses `live`
  // and is re-asked for `status=all` yields the same list. Every mapped row
  // carries its lifecycle status.
  it.each([
    ['a backend that answers status=live', false],
    ['an older backend that refuses status=live (falls back to status=all)', true],
  ])('#3518: a closing or pending task budget rides getAgentSummary with its status; closed and expired rows drop — %s', async (_label, refusesLive) => {
    const taskBudgetQueries: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const path = url.pathname
      if (path === '/machine-payments/agent') return json(agent('delegation'))
      if (path === '/machine-payments/allowances') return json(allowance())
      if (path === '/task-budgets') {
        taskBudgetQueries.push(url.search)
        if (refusesLive && url.searchParams.get('status') === 'live') {
          return json({ error: 'querystring/status must be equal to one of the allowed values' }, 400)
        }
        const row = (id: string, status: string, isExpired: boolean) => ({
          id, agent_id: 'agent_1', chain_id: 8453, token_address: USDC,
          recipient_address: null, parent_delegation_hash: `0x${'ab'.repeat(32)}`,
          delegation_hash: `0x${'cd'.repeat(32)}`, label: id, max_atomic: '1500',
          status, expires_at: isExpired ? 1000 : 9999999999, is_expired: isExpired,
          created_at: '2026-09-30T00:00:00.000Z', opened_at: '2026-09-30T00:00:00.000Z',
          closed_at: status === 'closed' ? '2026-09-30T01:00:00.000Z' : null, close_tx_hash: null,
        })
        return json({ task_budgets: [
          row('tb-pending', 'pending', false),
          row('tb-open', 'open', false),
          row('tb-closing-expired', 'closing', true), // closing ALWAYS rides, expired or not
          row('tb-closed', 'closed', false),          // terminal — drops
          row('tb-open-expired', 'open', true),       // reserves nothing — drops
        ] })
      }
      throw new Error(`Unexpected ${path}`)
    }))
    const service = reads(async () => ({}) as PaymentStatusResult)
    const summary = await service.getAgentSummary()
    expect(summary.taskBudgets.map((row) => row.id)).toEqual(['tb-pending', 'tb-open', 'tb-closing-expired'])
    expect(summary.taskBudgets.map((row) => row.status)).toEqual(['pending', 'open', 'closing'])
    expect(summary.taskBudgets.map((row) => row.isExpired)).toEqual([false, false, true])
    expect(taskBudgetQueries).toEqual(refusesLive ? ['?status=live', '?status=all'] : ['?status=live'])
  })

  // #3518: the allowance rows carry each budget's SCOPE (the recipient pin,
  // the merchant lock) and the Haven-side reservation beside the on-chain
  // figure — the fields that let an agent name the merchant-locked budget
  // BEFORE paying. Additive: an older backend's rows keep them absent.
  it('#3518: allowance rows expose delegationHash/recipientAddress/merchantId/reservedHavenAtomic, absent on an older backend', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent('delegation'))
      if (path === '/machine-payments/allowances') return json(twoBudgetAllowance())
      throw new Error(`Unexpected ${path}`)
    }))
    const service = reads(async () => ({}) as PaymentStatusResult)
    const { allowances } = await service.getAllowances()
    expect(allowances).toHaveLength(2)
    const [openRow, pinnedRow] = allowances
    expect(openRow.delegationHash).toBe(OPEN_BUDGET_HASH)
    expect(openRow.recipientAddress).toBeNull()
    expect(openRow.merchantId).toBeNull()
    expect(openRow.reservedHavenAtomic).toBe('0')
    expect(pinnedRow.delegationHash).toBe(PINNED_BUDGET_HASH)
    expect(pinnedRow.recipientAddress).toBe(PINNED_MERCHANT)

    // The old shape: no scope fields on the wire → absent, never null-typed.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent('delegation'))
      if (path === '/machine-payments/allowances') return json(allowance())
      throw new Error(`Unexpected ${path}`)
    }))
    const legacy = await service.getAllowances()
    expect(legacy.allowances[0].delegationHash).toBeUndefined()
    expect(legacy.allowances[0].recipientAddress).toBeUndefined()
    expect(legacy.allowances[0].merchantId).toBeUndefined()
    expect(legacy.allowances[0].reservedHavenAtomic).toBeUndefined()
  })

  it('maps receipt history without exposing proof headers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ receipts: [{
      id: 'receipt_1', payment_id: 'pay_1', rail: 'x402', proof_status: 'settled', tx_hash: '0xtx', chain_id: 8453,
      resource_url: 'https://merchant.test', merchant_address: null, payer_address: '0xpayer', settlement_address: '0xsettlement',
      token_symbol: 'USDC', token_address: USDC, amount_raw: '1000000', amount_human: '1', challenge_id: null,
      idempotency_key: null, payment_proof_header_name: 'X-PAYMENT', protocol_receipt_header_name: null, merchant_status: 200,
      confirmed_at: null, created_at: '2026-08-20T00:00:00.000Z', updated_at: '2026-08-20T00:00:00.000Z',
    }] })))
    const service = reads(async () => ({}) as PaymentStatusResult)

    await expect(service.listReceipts({ limit: 5 })).resolves.toMatchObject([{ paymentId: 'pay_1', amount: '1' }])
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0])).toContain('/machine-payments/receipts?limit=5')
  })

  it('verifies receipt bundles locally instead of trusting a server verification claim', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ receipt: {
      version: 'haven-receipt-1', paymentId: 'pay_1',
      payment: { token: 'USDC', tokenAddress: USDC, amount: '1', amountSek: null, recipient: '0xmerchant', account: '0xsafe', chainId: 8453, settledAt: null, resourceUrl: null },
      authorization: { delegate: '0xdelegate', signHash: '0xhash', signature: null },
      onChain: { txHash: null, chainId: 8453 },
    }, verification: { verified: true } })))
    const service = reads(async () => ({}) as PaymentStatusResult)

    await expect(service.getReceipt('pay_1')).resolves.toMatchObject({
      receipt: { paymentId: 'pay_1' },
      verification: { verified: false, reason: 'missing_signature' },
    })
  })
})
