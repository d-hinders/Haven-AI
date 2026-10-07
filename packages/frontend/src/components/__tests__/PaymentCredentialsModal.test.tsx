import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import PaymentCredentialsModal from '@/components/PaymentCredentialsModal'

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }),
}))
vi.mock('@/lib/api', () => ({ api: { post: vi.fn(), get: vi.fn() } }))

describe('PaymentCredentialsModal leak guidance (#3722)', () => {
  const agent = {
    id: 'agent-1',
    name: 'Research Agent',
    api_key_prefix: 'sk_agent_ab',
    delegate_address: '0x1111111111111111111111111111111111111111',
    created_at: '2026-10-07T00:00:00Z',
  }

  it('points a compromised key at Replace signing key or Remove agent…, never "revoke the agent and create a new one"', () => {
    const { container } = render(<PaymentCredentialsModal open onClose={() => {}} agent={agent} />)
    const text = (container.ownerDocument.body.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('If you suspect this key is compromised, open the agent and choose Replace signing key, or Remove agent… to end its budgets.')
    expect(text).toContain('The key also controls any funds already at this address; ending the budget does not recover them.')
    expect(text).not.toMatch(/revoke the agent and create a new one/)
  })
})
