// db-mock-exempt: module-level resolver test (scope/refusal codes) — the DB behaviours it composes are proven in infra/repositories/__tests__ on the real-DB harness
/**
 * #3616 — the budget-scope resolver, characterized against the direct route
 * (the reference semantics) and the two x402 copies:
 *
 * - `routes/__tests__/payments-task-budget.test.ts` and
 *   `payments-sub-budget.test.ts` own the route-level status/code matrix —
 *   every status and error_code asserted here is lifted from those suites.
 * - The refusal messages are pinned verbatim: both current copies of the
 *   tables (`routes/payments.ts`, `modules/x402/delegation-authorize.ts`)
 *   are byte-identical today; this module becomes their one home.
 * - The merchant pin (#3331) is asserted as an EXPLICIT output (`pinned`),
 *   mirroring `SELECT_DELEGATION_FOR_PAYMENT_SQL`'s
 *   `ORDER BY (recipient_address IS NULL)` preference.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  mockTaskFind,
  mockSubFind,
  mockPcFind,
  mockSelectDelegation,
  mockSelectByHash,
} = vi.hoisted(() => ({
  mockTaskFind: vi.fn(),
  mockSubFind: vi.fn(),
  mockPcFind: vi.fn(),
  mockSelectDelegation: vi.fn(),
  mockSelectByHash: vi.fn(),
}))

vi.mock('../../../infra/repositories/task-budgets.js', () => ({
  findForAgent: (...a: unknown[]) => mockTaskFind(...a),
}))
vi.mock('../../../infra/repositories/sub-budgets.js', () => ({
  findForAgent: (...a: unknown[]) => mockSubFind(...a),
  findOpenParentChildByHash: (...a: unknown[]) => mockPcFind(...a),
}))
vi.mock('../../../rails/delegation-authorization.js', () => ({
  selectDelegation: (...a: unknown[]) => mockSelectDelegation(...a),
  selectDelegationByHash: (...a: unknown[]) => mockSelectByHash(...a),
  prepareDelegationPayment: vi.fn(),
}))

const { resolveBudgetScope, refuseBothScopeIds, periodPrecheckLinks } = await import('../index.js')

const AGENT_ID = '11111111-1111-1111-1111-111111111111'
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const RECIPIENT = '0x' + 'cc'.repeat(20)
const BUDGET_HASH = `0x${'ab'.repeat(32)}`
const CHILD_HASH = `0x${'cd'.repeat(32)}`
const PC_HASH = `0x${'ef'.repeat(32)}`
const PARENT_AGENT_ID = '22222222-2222-2222-2222-222222222222'

const delegationJson = (delegator: string, salt: string) =>
  JSON.stringify({
    delegate: '0x' + 'dd'.repeat(20),
    delegator,
    authority: `0x${'ff'.repeat(32)}`,
    caveats: [],
    salt,
    signature: `0x${'ab'.repeat(65)}`,
  })

const BUDGET_ROW = {
  delegation_hash: BUDGET_HASH,
  delegation_json: delegationJson('0x' + 'aa'.repeat(20), '1'),
  recipient_address: null,
  budget_atomic: '10000',
}
const CHILD_JSON = delegationJson('0x' + 'dd'.repeat(20), '2')
const PC_JSON = delegationJson('0x' + 'aa'.repeat(20), '3')
const GRANT_JSON = delegationJson('0x' + 'bb'.repeat(20), '4')

const TASK_ROW = {
  id: 'tb-1',
  agent_id: AGENT_ID,
  chain_id: 84532,
  token_address: TOKEN,
  recipient_address: null,
  parent_delegation_hash: BUDGET_HASH,
  delegation_hash: CHILD_HASH,
  delegation_json: CHILD_JSON,
  label: 'Test task',
  max_atomic: '1000000',
  status: 'open',
  expires_at: String(Math.floor(Date.now() / 1000) + 3600),
  prepared_user_op: null,
  close_tx_hash: null,
  created_at: '2026-09-30T00:00:00.000Z',
  updated_at: '2026-09-30T00:00:00.000Z',
  opened_at: '2026-09-30T00:00:00.000Z',
  closed_at: null,
}

const GRANT_ROW = {
  id: 'sb-1',
  agent_id: AGENT_ID,
  chain_id: 84532,
  token_address: TOKEN,
  recipient_address: null,
  parent_delegation_hash: PC_HASH,
  delegation_hash: `0x${'01'.repeat(32)}`,
  delegation_json: GRANT_JSON,
  status: 'open',
  expires_at: String(Math.floor(Date.now() / 1000) + 3600),
  created_at: '2026-09-30T00:00:00.000Z',
}

const PC_ROW = {
  id: 'sb-pc-1',
  agent_id: PARENT_AGENT_ID,
  token_address: TOKEN,
  parent_delegation_hash: BUDGET_HASH,
  delegation_hash: PC_HASH,
  delegation_json: PC_JSON,
  status: 'open',
  expires_at: String(Math.floor(Date.now() / 1000) + 3600),
}

const resolve = (extra: Record<string, unknown> = {}) =>
  resolveBudgetScope({
    agentId: AGENT_ID,
    tokenAddress: TOKEN,
    recipient: RECIPIENT,
    ...extra,
  })

beforeEach(() => {
  vi.clearAllMocks()
  mockSelectByHash.mockResolvedValue(BUDGET_ROW)
  mockSelectDelegation.mockResolvedValue(BUDGET_ROW)
})

describe('both ids (#3330: exactly one authorizing child)', () => {
  it('refuses with 400 and no error_code, like both entrypoints', async () => {
    const r = await resolve({ taskBudgetId: 'tb-1', subBudgetId: 'sb-1' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.refusal.code).toBe('both_scope_ids')
    expect(r.refusal.status).toBe(400)
    expect(r.refusal.message).toBe('Pass exactly one of taskBudgetId or subBudgetId — never both')
  })

  it('refuseBothScopeIds: the verbatim bodies both surfaces answer today', () => {
    // routes/payments.ts:447
    expect(refuseBothScopeIds('payments')).toEqual({
      status: 400,
      body: { error: 'Pass exactly one of task_budget_id or sub_budget_id — never both' },
    })
    // delegation-authorize.ts:386
    expect(refuseBothScopeIds('x402')).toEqual({
      status: 400,
      body: { error: 'Pass exactly one of taskBudgetId or subBudgetId — never both' },
    })
  })
})

describe('task-budget scope (#3329)', () => {
  it('returns child + by-hash parent + the task-cap input', async () => {
    mockTaskFind.mockResolvedValue(TASK_ROW)
    const r = await resolve({ taskBudgetId: 'tb-1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scope.kind).toBe('taskBudget')
    expect(r.scope.taskBudget!.childDelegation).toEqual(JSON.parse(CHILD_JSON))
    // #3329 review finding E: the parent comes from the by-hash lookup, and
    // the child never re-derives it by (token, recipient).
    expect(mockSelectByHash).toHaveBeenCalledWith(AGENT_ID, BUDGET_HASH)
    expect(mockSelectDelegation).not.toHaveBeenCalled()
    expect(r.scope.taskBudget!.parentDelegation).toEqual(BUDGET_ROW)
    expect(r.scope.taskBudget!.taskCap).toEqual({
      taskBudgetId: 'tb-1',
      delegationHash: CHILD_HASH,
      maxAtomic: '1000000',
    })
  })

  it('passes the LOWERCASED recipient into the payment checks', async () => {
    mockTaskFind.mockResolvedValue(TASK_ROW)
    await resolveBudgetScope({ agentId: AGENT_ID, tokenAddress: TOKEN, recipient: RECIPIENT.toUpperCase(), taskBudgetId: 'tb-1' })
    // The service checks compare case-insensitively, but the route lowercases
    // before calling (`resolveTaskBudgetChildForPayment(row, token, to.toLowerCase(), …)`)
    // — the module keeps that shape.
    expect(mockTaskFind).toHaveBeenCalledWith('tb-1', AGENT_ID)
  })

  // Statuses and codes lifted from payments-task-budget.test.ts (lines 222-283).
  it('404 task_budget_not_found', async () => {
    mockTaskFind.mockResolvedValue(null)
    const r = await resolve({ taskBudgetId: 'tb-1' })
    expect(r).toMatchObject({ ok: false, refusal: { code: 'task_budget_not_found', status: 404, message: 'Task budget not found' } })
  })

  it('409 task_budget_parent_mismatch when the by-hash parent lookup answers null', async () => {
    mockTaskFind.mockResolvedValue(TASK_ROW)
    mockSelectByHash.mockResolvedValue(null)
    const r = await resolve({ taskBudgetId: 'tb-1' })
    expect(r).toMatchObject({
      ok: false,
      refusal: {
        code: 'task_budget_parent_mismatch',
        status: 409,
        message: 'The task budget was not carved from the budget delegation selected for this payment',
      },
    })
  })

  for (const [code, status] of [
    ['task_budget_not_open', 409],
    ['task_budget_token_mismatch', 409],
    ['task_budget_recipient_mismatch', 409],
  ] as const) {
    it(`passes the service refusal through: ${code} (${status})`, async () => {
      mockTaskFind.mockResolvedValue({
        ...TASK_ROW,
        status: code === 'task_budget_not_open' ? 'closed' : 'open',
        token_address: code === 'task_budget_token_mismatch' ? '0x' + '11'.repeat(20) : TOKEN,
        recipient_address: code === 'task_budget_recipient_mismatch' ? '0x' + '22'.repeat(20) : null,
        expires_at: code === 'task_budget_not_open' ? String(Math.floor(Date.now() / 1000) - 10) : TASK_ROW.expires_at,
      })
      const r = await resolve({ taskBudgetId: 'tb-1' })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.refusal.code).toBe(code)
      expect(r.refusal.status).toBe(status)
    })
  }
})

describe('sub-budget scope (#3330)', () => {
  it('returns grant + parent-child + by-hash parent — the three redemption links', async () => {
    mockSubFind.mockResolvedValue(GRANT_ROW)
    mockPcFind.mockResolvedValue(PC_ROW)
    const r = await resolve({ subBudgetId: 'sb-1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scope.kind).toBe('subBudget')
    expect(r.scope.subBudget!.grantDelegation).toEqual(JSON.parse(GRANT_JSON))
    expect(r.scope.subBudget!.parentChildDelegation).toEqual(JSON.parse(PC_JSON))
    // Both by-hash hops, per #3329 review finding E twice over.
    expect(mockPcFind).toHaveBeenCalledWith(PC_HASH, expect.any(Number))
    expect(mockSelectByHash).toHaveBeenCalledWith(PARENT_AGENT_ID, BUDGET_HASH)
    expect(mockSelectDelegation).not.toHaveBeenCalled()
    expect(r.scope.subBudget!.parentDelegation).toEqual(BUDGET_ROW)
  })

  it('404 sub_budget_not_found (payments-sub-budget.test.ts:242)', async () => {
    mockSubFind.mockResolvedValue(null)
    const r = await resolve({ subBudgetId: 'sb-1' })
    expect(r).toMatchObject({ ok: false, refusal: { code: 'sub_budget_not_found', status: 404, message: 'Sub-budget not found' } })
  })

  it('409 sub_budget_parent_mismatch when the middle link is gone (payments-sub-budget.test.ts:305)', async () => {
    mockSubFind.mockResolvedValue(GRANT_ROW)
    mockPcFind.mockResolvedValue(null)
    const r = await resolve({ subBudgetId: 'sb-1' })
    expect(r).toMatchObject({
      ok: false,
      refusal: {
        code: 'sub_budget_parent_mismatch',
        status: 409,
        message:
          "The sub-budget's chain is broken — its parent-child link is closed or it was not carved from the budget delegation selected for this payment",
      },
    })
  })

  it("409 sub_budget_parent_mismatch when A's budget grant is no longer active (:317)", async () => {
    mockSubFind.mockResolvedValue(GRANT_ROW)
    mockPcFind.mockResolvedValue(PC_ROW)
    mockSelectByHash.mockResolvedValue(null)
    const r = await resolve({ subBudgetId: 'sb-1' })
    expect(r).toMatchObject({ ok: false, refusal: { code: 'sub_budget_parent_mismatch', status: 409 } })
  })

  it('409 sub_budget_parent_mismatch on a broken hash binding (the service checks, :332)', async () => {
    // The grant names a parent-child hash that is NOT the row resolved —
    // checkSubBudgetForPayment edge 1.
    mockSubFind.mockResolvedValue({ ...GRANT_ROW, parent_delegation_hash: `0x${'99'.repeat(32)}` })
    mockPcFind.mockResolvedValue(PC_ROW)
    const r = await resolve({ subBudgetId: 'sb-1' })
    expect(r).toMatchObject({ ok: false, refusal: { code: 'sub_budget_parent_mismatch', status: 409 } })
  })

  it('passes the service token/recipient refusals through with their statuses', async () => {
    mockSubFind.mockResolvedValue({ ...GRANT_ROW, token_address: '0x' + '11'.repeat(20) })
    mockPcFind.mockResolvedValue(PC_ROW)
    let r = await resolve({ subBudgetId: 'sb-1' })
    expect(r).toMatchObject({ ok: false, refusal: { code: 'sub_budget_token_mismatch', status: 409 } })

    mockSubFind.mockResolvedValue({ ...GRANT_ROW, recipient_address: '0x' + '22'.repeat(20) })
    r = await resolve({ subBudgetId: 'sb-1' })
    expect(r).toMatchObject({ ok: false, refusal: { code: 'sub_budget_recipient_mismatch', status: 409 } })
  })
})

describe('none scope (the (token, recipient) selection)', () => {
  it('returns the selection and answers the (agent, token, recipient) selection once', async () => {
    const r = await resolve()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scope.kind).toBe('none')
    expect(r.scope.delegation).toEqual(BUDGET_ROW)
    expect(mockSelectDelegation).toHaveBeenCalledWith(AGENT_ID, TOKEN, RECIPIENT.toLowerCase())
    expect(mockSelectByHash).not.toHaveBeenCalled()
  })

  it('flags the MERCHANT PIN (#3331): a recipient-pinned selection says so', async () => {
    mockSelectDelegation.mockResolvedValue({ ...BUDGET_ROW, recipient_address: RECIPIENT })
    const r = await resolve()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // The pin preference lives in SELECT_DELEGATION_FOR_PAYMENT_SQL's
    // `ORDER BY (recipient_address IS NULL)` — the module surfaces WHICH
    // selection it got instead of letting adopters inherit it silently.
    expect(r.scope.pinned).toBe(true)
  })

  it('an open (unpinned) selection is not flagged pinned', async () => {
    const r = await resolve()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scope.pinned).toBe(false)
  })

  it('no applicable grant: delegation null, no refusal — the caller answers its own 403', async () => {
    mockSelectDelegation.mockResolvedValue(null)
    const r = await resolve()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scope.delegation).toBeNull()
    expect(r.scope.pinned).toBe(false)
  })
})

describe('periodPrecheckLinks (#3617: one link rule for every entrypoint)', () => {
  const row = (json: string) => ({ delegation_hash: BUDGET_HASH, delegation_json: json, recipient_address: null, budget_atomic: '1' })
  const grant = { delegate: '0x' + 'b1'.repeat(20), delegator: '0x' + 'a1'.repeat(20), authority: PC_HASH, caveats: [], salt: '0x1', signature: '0x' }
  const pc = { delegate: '0x' + 'a1'.repeat(20), delegator: '0x' + 'a1'.repeat(20), authority: BUDGET_HASH, caveats: [], salt: '0x2', signature: '0x' }

  it('a sub-budget reads all three links of the chain it redeems, leaf first', () => {
    const parent = row(delegationJson('0x' + 'aa'.repeat(20), '0x3'))
    expect(
      periodPrecheckLinks({ kind: 'subBudget', subBudget: { grantDelegation: grant as never, parentChildDelegation: pc as never, parentDelegation: parent } }),
    ).toEqual([JSON.stringify(grant), JSON.stringify(pc), parent.delegation_json])
  })

  it('a task budget reads only its parent (the child cap is the separate taskCap check)', () => {
    const parent = row(delegationJson('0x' + 'aa'.repeat(20), '0x4'))
    expect(
      periodPrecheckLinks({
        kind: 'taskBudget',
        taskBudget: { childDelegation: grant as never, parentDelegation: parent, taskCap: { taskBudgetId: 't', delegationHash: CHILD_HASH, maxAtomic: '1' } },
      }),
    ).toEqual([parent.delegation_json])
  })

  it('the none scope reads its selection, or nothing when there is none', () => {
    const sel = row(delegationJson('0x' + 'aa'.repeat(20), '0x5'))
    expect(periodPrecheckLinks({ kind: 'none', delegation: sel })).toEqual([sel.delegation_json])
    expect(periodPrecheckLinks({ kind: 'none', delegation: null })).toEqual([])
  })
})
