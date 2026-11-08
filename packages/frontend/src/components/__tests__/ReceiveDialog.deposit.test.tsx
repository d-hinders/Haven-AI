import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SmartAccount } from '@/context/AuthContext'

/**
 * #4705: Receive notices the deposit. The overview is controlled here — each
 * `setOverview` + `rerender` is one poll — so every rule of the watch
 * (`lib/deposit-watch.ts`) and of "first" (`lib/first-money.ts`) is driven
 * through the real dialog.
 */

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr') },
}))
vi.mock('@/hooks/useEscapeToClose', () => ({ useEscapeToClose: vi.fn() }))

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }))

const mockUser = vi.hoisted(() => ({ current: { user: { id: 'user-1' } } as { user: { id: string } } | null }))
vi.mock('@/context/AuthContext', () => ({ useOptionalAuth: () => mockUser.current }))

type OverviewAccount = {
  accountId: string
  usdcBalanceAtomic: string | null
  usdcDecimals: number | null
  funded: boolean | null
}
const overview = vi.hoisted(() => ({ accounts: null as OverviewAccount[] | null }))
vi.mock('@/hooks/useDashboardOverview', () => ({
  useDashboardOverview: () => ({
    data: overview.accounts ? { accounts: overview.accounts } : null,
    loading: overview.accounts === null,
    error: null,
    refetch: vi.fn(),
  }),
}))

import ReceiveDialog from '@/components/ReceiveDialog'

const MAIN: SmartAccount = {
  id: 'acct-main',
  account_address: '0xa0e99A227fc546017Fd68D49711C1857208F0eB9',
  chain_id: 84532,
  name: 'My account',
  is_default: true,
  created_at: '2026-05-11T00:00:00Z',
}
const SAVINGS: SmartAccount = {
  ...MAIN,
  id: 'acct-savings',
  account_address: '0xb0e99A227fc546017Fd68D49711C1857208F0eB9',
  name: 'Savings',
  is_default: false,
}

function row(accountId: string, usdc: string | null, funded?: boolean | null): OverviewAccount {
  return {
    accountId,
    usdcBalanceAtomic: usdc,
    usdcDecimals: 6,
    funded: funded === undefined ? (usdc === null ? null : usdc !== '0') : funded,
  }
}

// Each call is one overview poll.
function setOverview(...rows: OverviewAccount[]) {
  overview.accounts = rows
}

function mount(props: Partial<Parameters<typeof ReceiveDialog>[0]> = {}) {
  const onClose = vi.fn()
  const element = (extra: Partial<Parameters<typeof ReceiveDialog>[0]> = {}) => (
    <ReceiveDialog open account={MAIN} onClose={onClose} {...props} {...extra} />
  )
  const utils = render(element())
  return {
    ...utils,
    onClose,
    poll: (...rows: OverviewAccount[]) => {
      setOverview(...rows)
      utils.rerender(element())
    },
    rerenderWith: (extra: Partial<Parameters<typeof ReceiveDialog>[0]>) => utils.rerender(element(extra)),
  }
}

function arrivedTitle() {
  return screen.queryByText(/USDC arrived$/)
}

function hasBloom(): boolean {
  return document.querySelector('.v2-animate-bloom') !== null
}

function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  overview.accounts = null
  mockUser.current = { user: { id: 'user-1' } }
  window.localStorage.clear()
  setReducedMotion(false)
})

afterEach(() => {
  setReducedMotion(true)
  window.localStorage.clear()
})

describe('ReceiveDialog — the deposit watch (#4705)', () => {
  it('says it is watching while open', () => {
    setOverview(row(MAIN.id, '0'))
    mount()
    expect(screen.getByText('Watching for your deposit…')).toBeInTheDocument()
  })

  it('no arrival on open with an existing balance, nor on a poll that reads the same', () => {
    setOverview(row(MAIN.id, '25000000'))
    const { poll } = mount()
    poll(row(MAIN.id, '25000000'))
    expect(arrivedTitle()).toBeNull()
    expect(screen.getByText('Watching for your deposit…')).toBeInTheDocument()
  })

  it('a rise is an arrival, for the difference, announced through role="status"', () => {
    setOverview(row(MAIN.id, '10000000'))
    const { poll } = mount()
    poll(row(MAIN.id, '35000000'))
    const status = screen.getByRole('status')
    expect(within(status).getByText('25.00 USDC arrived')).toBeInTheDocument()
    expect(within(status).getByText("It's in My account on Base Sepolia.")).toBeInTheDocument()
    expect(screen.queryByText('Watching for your deposit…')).toBeNull()
    // The address screen gives way to the arrived state.
    expect(screen.queryByRole('button', { name: 'Copy address' })).toBeNull()
  })

  it('null → value does not fire: the first successful read seeds', () => {
    setOverview(row(MAIN.id, null))
    const { poll } = mount()
    poll(row(MAIN.id, '25000000'))
    expect(arrivedTitle()).toBeNull()
    // …and a null mid-watch changes nothing either.
    poll(row(MAIN.id, null))
    poll(row(MAIN.id, '25000000'))
    expect(arrivedTitle()).toBeNull()
  })

  it('an overview that has not loaded yet seeds nothing', () => {
    const { poll } = mount()
    poll(row(MAIN.id, '25000000'))
    expect(arrivedTitle()).toBeNull()
  })

  it('switching accounts does not fire, and the new account is watched from its own balance', () => {
    setOverview(row(MAIN.id, '0'), row(SAVINGS.id, '90000000'))
    const { poll } = mount({ accounts: [MAIN, SAVINGS] })
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), { target: { value: SAVINGS.id } })
    expect(arrivedTitle()).toBeNull()
    poll(row(MAIN.id, '0'), row(SAVINGS.id, '90000000'))
    expect(arrivedTitle()).toBeNull()
    // Money landing on the account NOT shown is not this dialog's arrival.
    poll(row(MAIN.id, '5000000'), row(SAVINGS.id, '90000000'))
    expect(arrivedTitle()).toBeNull()
    poll(row(MAIN.id, '5000000'), row(SAVINGS.id, '92000000'))
    expect(screen.getByText('2.00 USDC arrived')).toBeInTheDocument()
    expect(screen.getByText("It's in Savings on Base Sepolia.")).toBeInTheDocument()
  })

  it('a drop then a smaller deposit fires for the deposit amount', () => {
    setOverview(row(MAIN.id, '50000000'))
    const { poll } = mount()
    poll(row(MAIN.id, '20000000'))
    expect(arrivedTitle()).toBeNull()
    poll(row(MAIN.id, '30000000'))
    expect(screen.getByText('10.00 USDC arrived')).toBeInTheDocument()
  })

  it('reports the account it shows, and null on close', () => {
    const onShowingAccountChange = vi.fn()
    setOverview(row(MAIN.id, '0'), row(SAVINGS.id, '0'))
    const { rerenderWith } = mount({ accounts: [MAIN, SAVINGS], onShowingAccountChange })
    expect(onShowingAccountChange).toHaveBeenLastCalledWith(MAIN.id)
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), { target: { value: SAVINGS.id } })
    expect(onShowingAccountChange).toHaveBeenLastCalledWith(SAVINGS.id)
    rerenderWith({ open: false })
    expect(onShowingAccountChange).toHaveBeenLastCalledWith(null)
  })

  it('calls onArrived once with the account', () => {
    const onArrived = vi.fn()
    setOverview(row(MAIN.id, '0'))
    const { poll } = mount({ onArrived })
    poll(row(MAIN.id, '25000000'))
    poll(row(MAIN.id, '25000000'))
    expect(onArrived).toHaveBeenCalledOnce()
    expect(onArrived).toHaveBeenCalledWith(MAIN.id)
  })
})

describe('ReceiveDialog — Peak for first money, Step after (#4705)', () => {
  it('first deposit plays Peak and offers Connect your first agent when the host passes it', () => {
    const onConnectFirstAgent = vi.fn()
    setOverview(row(MAIN.id, '0'), row(SAVINGS.id, '0'))
    const { poll, onClose } = mount({ onConnectFirstAgent })
    poll(row(MAIN.id, '25000000'), row(SAVINGS.id, '0'))
    expect(screen.getByText('25.00 USDC arrived')).toBeInTheDocument()
    expect(hasBloom()).toBe(true)
    expect(window.localStorage.getItem('haven-first-money-seen:user-1')).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: 'Connect your first agent' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onConnectFirstAgent).toHaveBeenCalledOnce()
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onConnectFirstAgent.mock.invocationCallOrder[0])
  })

  it('first deposit without the handler: Peak, and just Done', () => {
    setOverview(row(MAIN.id, '0'))
    const { poll } = mount()
    poll(row(MAIN.id, '25000000'))
    expect(hasBloom()).toBe(true)
    expect(screen.queryByRole('button', { name: 'Connect your first agent' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  it('Peak plays once: the next deposit, in a later open, is Step with just Done', () => {
    const onConnectFirstAgent = vi.fn()
    setOverview(row(MAIN.id, '0'))
    const first = mount({ onConnectFirstAgent })
    first.poll(row(MAIN.id, '25000000'))
    expect(hasBloom()).toBe(true)
    first.unmount()

    setOverview(row(MAIN.id, '25000000'))
    const second = mount({ onConnectFirstAgent })
    second.poll(row(MAIN.id, '40000000'))
    expect(screen.getByText('15.00 USDC arrived')).toBeInTheDocument()
    expect(hasBloom()).toBe(false)
    expect(document.querySelector('.animate-check-pop')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect your first agent' })).toBeNull()
  })

  it('Step plays once too: a later poll does not replay it', () => {
    setOverview(row(MAIN.id, '25000000'))
    const onArrived = vi.fn()
    const { poll } = mount({ onArrived })
    poll(row(MAIN.id, '40000000'))
    poll(row(MAIN.id, '60000000'))
    expect(onArrived).toHaveBeenCalledOnce()
    expect(screen.getByText('15.00 USDC arrived')).toBeInTheDocument()
  })

  it('any account already funded at open means the next deposit is Step, and records the marker', () => {
    setOverview(row(MAIN.id, '0'), row(SAVINGS.id, '5000000'))
    const { poll } = mount({ onConnectFirstAgent: vi.fn() })
    expect(window.localStorage.getItem('haven-first-money-seen:user-1')).toBe('1')
    poll(row(MAIN.id, '25000000'), row(SAVINGS.id, '5000000'))
    expect(hasBloom()).toBe(false)
    expect(screen.queryByRole('button', { name: 'Connect your first agent' })).toBeNull()
  })

  it('an unknown account at open is not "first": Step', () => {
    setOverview(row(MAIN.id, '0'), row(SAVINGS.id, null))
    const { poll } = mount()
    poll(row(MAIN.id, '25000000'), row(SAVINGS.id, null))
    expect(screen.getByText('25.00 USDC arrived')).toBeInTheDocument()
    expect(hasBloom()).toBe(false)
  })

  // The spec review's replay path: the first deposit lands with Receive
  // closed (the dashboard's overview sets the marker), the account is drained,
  // and a refill arrives with Receive open. Every account reads empty at open,
  // but the money is not the first: Step.
  it('regression: first deposit seen with Receive closed → drain → refill with Receive open is Step, not Peak', () => {
    // What the dashboard does on its funded read (DashboardClient.test.tsx
    // pins that it does): the marker is set.
    window.localStorage.setItem('haven-first-money-seen:user-1', '1')
    setOverview(row(MAIN.id, '0'))
    const { poll } = mount({ onConnectFirstAgent: vi.fn() })
    poll(row(MAIN.id, '25000000'))
    expect(screen.getByText('25.00 USDC arrived')).toBeInTheDocument()
    expect(hasBloom()).toBe(false)
    expect(screen.queryByRole('button', { name: 'Connect your first agent' })).toBeNull()
  })

  it('with no signed-in user there is no marker to key: Step', () => {
    mockUser.current = null
    setOverview(row(MAIN.id, '0'))
    const { poll } = mount({ onConnectFirstAgent: vi.fn() })
    poll(row(MAIN.id, '25000000'))
    expect(screen.getByText('25.00 USDC arrived')).toBeInTheDocument()
    expect(hasBloom()).toBe(false)
  })

  it('reduced motion shows the final arrived state with nothing animating', () => {
    setReducedMotion(true)
    setOverview(row(MAIN.id, '0'))
    const { poll } = mount({ onConnectFirstAgent: vi.fn() })
    poll(row(MAIN.id, '25000000'))
    expect(screen.getByRole('status')).toHaveTextContent('25.00 USDC arrived')
    expect(screen.getByRole('button', { name: 'Connect your first agent' })).toBeInTheDocument()
    expect(hasBloom()).toBe(false)
    expect(document.querySelector('.animate-check-pop')).toBeNull()
  })
})

describe('ReceiveDialog — the arrived state actions (#4705)', () => {
  it('View transaction goes to the account activity and closes the dialog', () => {
    setOverview(row(MAIN.id, '25000000'))
    const { poll, onClose } = mount()
    poll(row(MAIN.id, '30000000'))
    fireEvent.click(screen.getByRole('button', { name: 'View transaction' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(mockPush).toHaveBeenCalledWith(`/accounts/${MAIN.id}?tab=activity`)
  })

  it('Done closes the dialog, and reopening watches again', () => {
    setOverview(row(MAIN.id, '25000000'))
    const { poll, onClose, rerenderWith } = mount()
    poll(row(MAIN.id, '30000000'))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledOnce()
    act(() => rerenderWith({ open: false }))
    act(() => rerenderWith({ open: true }))
    expect(arrivedTitle()).toBeNull()
    expect(screen.getByText('Watching for your deposit…')).toBeInTheDocument()
  })
})
