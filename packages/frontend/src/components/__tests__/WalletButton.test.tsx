import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const PASSKEY_ADDRESS = '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2'
const EOA_ADDRESS = '0x5555555555555555555555555555555555555555'
const ACTIVE_SAFE = {
  id: 'safe-1',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 100,
  name: 'Main account',
  is_default: true,
  created_at: '2026-05-05T00:00:00.000Z',
}

const mocks = vi.hoisted(() => ({
  connectState: {
    account: undefined as
      | {
          address: string
          ensName?: string | null
          ensAvatar?: string | null
        }
      | undefined,
    chain: undefined as
      | {
          id: number
          name: string
          unsupported?: boolean
        }
      | undefined,
    mounted: true,
    authenticationStatus: 'authenticated' as 'authenticated' | 'loading' | undefined,
  },
  disconnectAsync: vi.fn(),
  openChainModal: vi.fn(),
  openConnectModal: vi.fn(),
  openConnectModalHook: vi.fn(),
  useActiveSigner: vi.fn(),
  useAuth: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: {
    Custom: ({ children }: { children: (args: unknown) => ReactNode }) =>
      children({
        ...mocks.connectState,
        openChainModal: mocks.openChainModal,
        openConnectModal: mocks.openConnectModal,
      }),
  },
  useConnectModal: () => ({
    openConnectModal: mocks.openConnectModalHook,
  }),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({
    isConnected: Boolean(mocks.connectState.account),
  }),
  useDisconnect: () => ({
    disconnectAsync: mocks.disconnectAsync,
  }),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mocks.useAuth(),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (args: unknown) => mocks.useActiveSigner(args),
}))

import WalletButton from '@/components/WalletButton'

function setConnectedWallet({
  address = EOA_ADDRESS,
  chain = { id: 100, name: 'Gnosis Chain' },
}: {
  address?: string
  chain?: { id: number; name: string; unsupported?: boolean }
} = {}) {
  mocks.connectState.account = {
    address,
    ensName: null,
    ensAvatar: null,
  }
  mocks.connectState.chain = chain
}

describe('WalletButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.connectState.account = undefined
    mocks.connectState.chain = undefined
    mocks.connectState.mounted = true
    mocks.connectState.authenticationStatus = 'authenticated'
    mocks.disconnectAsync.mockResolvedValue(undefined)
    mocks.useAuth.mockReturnValue({
      activeSafe: ACTIVE_SAFE,
      passkeys: [],
    })
    mocks.useActiveSigner.mockReturnValue(null)

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: mocks.writeText,
      },
    })
  })

  it('shows Passkey ready when a local passkey signer is active', () => {
    mocks.useActiveSigner.mockReturnValue({
      type: 'passkey',
      address: PASSKEY_ADDRESS,
      credentialId: 'credential-1',
      chainId: 100,
    })

    render(<WalletButton />)

    expect(screen.getByRole('button', { name: 'Passkey ready' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).not.toBeInTheDocument()
  })

  it('opens a passkey dropdown with the passkey address and copy action', async () => {
    mocks.useActiveSigner.mockReturnValue({
      type: 'passkey',
      address: PASSKEY_ADDRESS,
      credentialId: 'credential-1',
      chainId: 100,
    })

    render(<WalletButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Passkey ready' }))

    expect(screen.getByRole('dialog', { name: 'Wallet menu' })).toBeInTheDocument()
    expect(screen.getByText('Passkey')).toBeInTheDocument()
    expect(screen.getByText('0x0802…0ce2')).toBeInTheDocument()
    expect(screen.getByText('Gnosis Chain')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => {
      expect(mocks.writeText).toHaveBeenCalledWith(PASSKEY_ADDRESS)
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet instead' }))

    expect(mocks.openConnectModalHook).toHaveBeenCalled()
    expect(mocks.openConnectModal).not.toHaveBeenCalled()
  })

  it('keeps passkey primary when an EOA wallet is also connected', () => {
    setConnectedWallet({
      chain: { id: 999, name: 'Unsupported Chain', unsupported: true },
    })
    mocks.useActiveSigner.mockReturnValue({
      type: 'passkey',
      address: PASSKEY_ADDRESS,
      credentialId: 'credential-1',
      chainId: 100,
    })

    render(<WalletButton />)

    expect(screen.getByRole('button', { name: 'Passkey ready' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Wrong network' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Passkey ready' }))

    expect(screen.getByText('Passkey')).toBeInTheDocument()
    expect(screen.getByText('Connected wallet')).toBeInTheDocument()
    expect(screen.getByText('0x0802…0ce2')).toBeInTheDocument()
    expect(screen.getByText('0x5555…5555')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch wallet' })).toBeInTheDocument()
  })

  it('shows Connect wallet when there is no local passkey signer or connected wallet', () => {
    render(<WalletButton />)

    const button = screen.getByRole('button', { name: 'Connect wallet' })

    expect(button).toBeInTheDocument()

    fireEvent.click(button)

    expect(mocks.openConnectModal).toHaveBeenCalled()
  })

  it('keeps the existing EOA wallet address behavior without a passkey signer', () => {
    setConnectedWallet()
    mocks.useActiveSigner.mockReturnValue({
      type: 'eoa',
      address: EOA_ADDRESS,
      walletClient: {},
    })

    render(<WalletButton />)

    fireEvent.click(screen.getByRole('button', { name: '0x5555…5555' }))

    expect(screen.getByRole('dialog', { name: 'Wallet menu' })).toBeInTheDocument()
    expect(screen.getByText('Connected wallet')).toBeInTheDocument()
    expect(screen.getAllByText('0x5555…5555')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Switch wallet' })).toBeInTheDocument()
  })

  it('shows Wrong network only when EOA is the active approval method', () => {
    setConnectedWallet({
      chain: { id: 999, name: 'Unsupported Chain', unsupported: true },
    })

    render(<WalletButton />)

    expect(screen.getByRole('button', { name: 'Wrong network' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Passkey ready' })).not.toBeInTheDocument()
  })
})
