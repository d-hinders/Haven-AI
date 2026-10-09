import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #3812: the in-flow way out of a "connect the owner wallet" state. These
// tests drive the real component against stubbed wagmi/RainbowKit hooks and
// assert what each click REACHES — the picker, the disconnect — not markup.
const mocks = vi.hoisted(() => ({
  isConnected: false,
  openConnectModal: vi.fn() as undefined | (() => void),
  disconnectAsync: vi.fn(async () => {}),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: mocks.isConnected }),
  useDisconnect: () => ({ disconnectAsync: mocks.disconnectAsync }),
}))

vi.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: () => ({ openConnectModal: mocks.openConnectModal }),
}))

const WalletConnectAction = (await import('../WalletConnectAction')).default

beforeEach(() => {
  mocks.isConnected = false
  mocks.openConnectModal = vi.fn()
  // Disconnecting does not flip the connection by itself here: the test
  // flips it, to model wagmi committing `isConnected=false` on a later render.
  mocks.disconnectAsync = vi.fn(async () => {})
})

describe('WalletConnectAction (#3812)', () => {
  it('with no wallet connected, "Connect wallet" opens the connector picker', () => {
    render(<WalletConnectAction />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }))
    expect(mocks.openConnectModal).toHaveBeenCalledTimes(1)
    expect(mocks.disconnectAsync).not.toHaveBeenCalled()
  })

  it('with a (wrong) wallet connected, "Switch wallet" disconnects it, then opens the picker', async () => {
    mocks.isConnected = true
    const { rerender } = render(<WalletConnectAction />)
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch wallet' }))
    })
    expect(mocks.disconnectAsync).toHaveBeenCalledTimes(1)
    // RainbowKit refuses to open while a wallet is connected, so the picker
    // opens only once the disconnected render has committed.
    expect(mocks.openConnectModal).not.toHaveBeenCalled()
    mocks.isConnected = false
    await act(async () => {
      rerender(<WalletConnectAction />)
    })
    expect(mocks.openConnectModal).toHaveBeenCalledTimes(1)
  })

  it('stays inert, not broken, while RainbowKit has no picker to open', () => {
    mocks.openConnectModal = undefined
    render(<WalletConnectAction />)
    const button = screen.getByRole('button', { name: 'Connect wallet' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})
