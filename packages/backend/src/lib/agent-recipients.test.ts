import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

const { loadAgentRecipients } = await import('./agent-recipients.js')

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

function row(overrides: Record<string, unknown> = {}) {
  return {
    recipient_address: '0x' + 'ab'.repeat(20),
    token_address: USDC,
    label: null,
    budget_amount: null,
    allowance_amount: '5000000', // 5 USDC atomic — the agent's token allowance
    ...overrides,
  }
}

beforeEach(() => {
  mockQuery.mockReset()
  // Pattern-matched, not positional (#775): dispatch on the SQL fragment.
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM agent_recipients/.test(sql)) return Promise.resolve({ rows: [] })
    return Promise.resolve({ rows: [] })
  })
})

describe('loadAgentRecipients — budget inheritance (#784, alternative A)', () => {
  it('returns [] for an agent with no stored recipients (default-empty)', async () => {
    expect(await loadAgentRecipients('agent-1', USDC)).toEqual([])
  })

  it('a NULL budget_amount inherits the full token allowance', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] })
    const [r] = await loadAgentRecipients('agent-1', USDC)
    expect(r.budgetAtomic).toBe(5000000n)
  })

  it('an explicit per-row budget wins over the allowance (the split case)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        row({ budget_amount: '2000000' }),
        row({ recipient_address: '0x' + 'cd'.repeat(20), budget_amount: '3000000' }),
      ],
    })
    const recipients = await loadAgentRecipients('agent-1', USDC)
    expect(recipients.map((r) => r.budgetAtomic)).toEqual([2000000n, 3000000n])
  })

  it('a recipient row without any matching allowance resolves to a zero budget (fail-closed)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ allowance_amount: null })] })
    const [r] = await loadAgentRecipients('agent-1', USDC)
    expect(r.budgetAtomic).toBe(0n)
  })

  it('is read-only: only SELECTs', async () => {
    await loadAgentRecipients('agent-1', USDC)
    for (const [sql] of mockQuery.mock.calls) {
      expect(String(sql).trim().toUpperCase().startsWith('SELECT')).toBe(true)
    }
  })
})
