import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DelegateBalance } from '@/hooks/useDelegateBalance'

const { mockApiGet, mockUseAgents } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockUseAgents: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

import SweepClient from '../SweepClient'

function balance(usdc: string, usdcAtomic: string): DelegateBalance {
  return {
    delegate_address: '0x2222222222222222222222222222222222222222',
    safe_address: '0x1111111111111111111111111111111111111111',
    chain_id: 8453,
    eth: '0',
    eth_atomic: '0',
    usdc,
    usdc_atomic: usdcAtomic,
    usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    sweep_min_usdc: '0.01',
  }
}

describe('SweepClient', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockUseAgents.mockReturnValue({ agents: [] })
  })

  it('does not render a superseded agent balance after navigation', async () => {
    let resolveOld: (value: DelegateBalance) => void = () => {}
    mockApiGet.mockImplementationOnce(
      () => new Promise<DelegateBalance>((resolve) => { resolveOld = resolve }),
    )

    const { rerender } = render(<SweepClient agentId="agent-old" />)

    mockApiGet.mockResolvedValueOnce(balance('1.00', '1000000'))
    rerender(<SweepClient agentId="agent-new" />)

    await waitFor(() => expect(screen.getByText('1.00')).toBeInTheDocument())

    await act(async () => {
      resolveOld(balance('999.00', '999000000'))
      await Promise.resolve()
    })

    expect(screen.getByText('1.00')).toBeInTheDocument()
    expect(screen.queryByText('999.00')).not.toBeInTheDocument()
  })

  it('keeps the loading state announced while the balance is pending', () => {
    mockApiGet.mockImplementation(() => new Promise<DelegateBalance>(() => {}))

    render(<SweepClient agentId="agent-1" />)

    expect(screen.getByRole('status', { name: 'Checking recovery balance' })).toBeInTheDocument()
  })

  it('hides raw errors and retries the recovery balance request', async () => {
    mockApiGet
      .mockRejectedValueOnce(new Error('Screenshot fixture: delegate balance unavailable'))
      .mockResolvedValueOnce(balance('1.00', '1000000'))

    render(<SweepClient agentId="agent-1" />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load recovery balance')
    expect(alert).toHaveTextContent("We couldn't check this agent's wallet right now. Please try again.")
    expect(alert).not.toHaveTextContent('Screenshot fixture')

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(screen.getByText('1.00')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
