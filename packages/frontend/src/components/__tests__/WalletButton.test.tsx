import { within, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  useOwnerDirectory: vi.fn(),
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

vi.mock('@/context/OwnerDirectoryContext', () => ({
  useOwnerDirectory: () => mocks.useOwnerDirectory(),
}))

vi.mock('@/lib/signer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/signer')>()
  return {
    ...actual,
    useActiveSigner: (args: unknown) => mocks.useActiveSigner(args),
  }
})

import WalletButton from '@/components/WalletButton'

function setConnectedWallet({
  address = EOA_ADDRESS,
  // Base is the only user-selectable chain; an EOA on a supported chain
  // should render the address pill (not "Wrong network").
  chain = { id: 8453, name: 'Base' },
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
    mocks.useOwnerDirectory.mockReturnValue({
      getOwnerAlias: vi.fn(() => null),
    })
    mocks.useActiveSigner.mockReturnValue(null)

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: mocks.writeText,
      },
    })
  })

  it('shows Passkey when a local passkey signer is active', () => {
    mocks.useActiveSigner.mockReturnValue({
      type: 'passkey',
      address: PASSKEY_ADDRESS,
      credentialId: 'credential-1',
      chainId: 100,
    })

    render(<WalletButton />)

    expect(screen.getByRole('button', { name: 'Passkey' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).not.toBeInTheDocument()
  })

  it('uses an owner alias for the active passkey label and dropdown', () => {
    mocks.useOwnerDirectory.mockReturnValue({
      getOwnerAlias: vi.fn((address: string) =>
        address.toLowerCase() === PASSKEY_ADDRESS.toLowerCase() ? 'Daniel passkey' : null,
      ),
    })
    mocks.useActiveSigner.mockReturnValue({
      type: 'passkey',
      address: PASSKEY_ADDRESS,
      credentialId: 'credential-1',
      chainId: 100,
    })

    render(<WalletButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Daniel passkey' }))

    expect(screen.getAllByText('Daniel passkey')).toHaveLength(2)
    expect(screen.getByText('0x0802…0ce2')).toBeInTheDocument()
  })

  it('opens a passkey dropdown with the passkey address and copy action', async () => {
    mocks.useActiveSigner.mockReturnValue({
      type: 'passkey',
      address: PASSKEY_ADDRESS,
      credentialId: 'credential-1',
      chainId: 100,
    })

    render(<WalletButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Passkey' }))

    const dialog = screen.getByRole('dialog', { name: 'Wallet menu' })
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText('Passkey')).toBeInTheDocument()
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

    expect(screen.getByRole('button', { name: 'Passkey' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Wrong network' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Passkey' }))

    expect(within(screen.getByRole('dialog', { name: 'Wallet menu' })).getByText('Passkey')).toBeInTheDocument()
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

  it('uses an owner alias for the connected wallet label and dropdown', () => {
    setConnectedWallet()
    mocks.useOwnerDirectory.mockReturnValue({
      getOwnerAlias: vi.fn((address: string) =>
        address.toLowerCase() === EOA_ADDRESS.toLowerCase() ? 'Ledger main' : null,
      ),
    })
    mocks.useActiveSigner.mockReturnValue({
      type: 'eoa',
      address: EOA_ADDRESS,
      walletClient: {},
    })

    render(<WalletButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Ledger main' }))

    expect(screen.getByRole('dialog', { name: 'Wallet menu' })).toBeInTheDocument()
    expect(screen.getAllByText('Ledger main')).toHaveLength(2)
    expect(screen.getByText('0x5555…5555')).toBeInTheDocument()
  })

  it('shows a passkey unavailable note in the connected-wallet dropdown', () => {
    setConnectedWallet()
    mocks.useAuth.mockReturnValue({
      activeSafe: ACTIVE_SAFE,
      passkeys: [
        {
          id: 'passkey-1',
          credential_id: 'credential-1',
          signer_address: PASSKEY_ADDRESS,
          chain_id: ACTIVE_SAFE.chain_id,
          safe_address: ACTIVE_SAFE.safe_address,
          created_at: '2026-05-05T00:00:00.000Z',
        },
      ],
    })
    mocks.useActiveSigner.mockReturnValue({
      type: 'eoa',
      address: EOA_ADDRESS,
      walletClient: {},
    })

    render(<WalletButton />)

    fireEvent.click(screen.getByRole('button', { name: '0x5555…5555' }))

    expect(
      screen.getByText('This account uses a passkey that is not available here.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Connected wallet')).toBeInTheDocument()
  })

  it('shows Wrong network only when EOA is the active approval method', () => {
    setConnectedWallet({
      chain: { id: 999, name: 'Unsupported Chain', unsupported: true },
    })

    render(<WalletButton />)

    expect(screen.getByRole('button', { name: 'Wrong network' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Passkey' })).not.toBeInTheDocument()
  })


  /**
   * #1803 — the label is not rendered below `sm`, so every state must carry an
   * EXPLICIT `aria-label`.
   *
   * Written as an attribute assertion on purpose. jsdom applies no CSS, so the
   * `hidden sm:inline` span still has its text here and every `getByRole(…,
   * { name })` test above would keep passing on that text alone, at the exact
   * width where the real browser renders none of it. Asserting the attribute is
   * what makes the accessible name checkable in a DOM with no layout; the
   * rendered half — that the label really is 0px wide and the name survives it
   * anyway — is measured in `e2e/mobile-nav-tap-target.mobile.spec.ts`
   * assertion 10, which is a different question and needs a real engine.
   *
   * Every branch of the component is covered, because the collapse applies to
   * all of them and each builds its label differently.
   */
  describe('accessible name survives the label collapse below sm (#1803)', () => {
    const nameOf = (button: HTMLElement) => button.getAttribute('aria-label')

    it('names the connect call to action', () => {
      render(<WalletButton />)

      expect(nameOf(screen.getByRole('button', { name: 'Connect wallet' }))).toBe('Connect wallet')
    })

    it('names the wrong-network state', () => {
      setConnectedWallet({
        chain: { id: 999, name: 'Unsupported Chain', unsupported: true },
      })

      render(<WalletButton />)

      expect(nameOf(screen.getByRole('button', { name: 'Wrong network' }))).toBe('Wrong network')
    })

    it('names the passkey state, and follows the owner alias when there is one', () => {
      mocks.useActiveSigner.mockReturnValue({
        type: 'passkey',
        address: PASSKEY_ADDRESS,
        credentialId: 'credential-1',
        chainId: 100,
      })

      const plain = render(<WalletButton />)
      expect(nameOf(screen.getByRole('button', { name: 'Passkey' }))).toBe('Passkey')
      plain.unmount()

      mocks.useOwnerDirectory.mockReturnValue({
        getOwnerAlias: vi.fn((address: string) =>
          address.toLowerCase() === PASSKEY_ADDRESS.toLowerCase() ? 'Daniel passkey' : null,
        ),
      })

      render(<WalletButton />)
      expect(nameOf(screen.getByRole('button', { name: 'Daniel passkey' }))).toBe('Daniel passkey')
    })

    it('names the Hybrid DeleGator state', () => {
      mocks.useActiveSigner.mockReturnValue({
        type: 'delegator_passkey',
        accountAddress: '0x' + 'aa'.repeat(20),
        chainId: 84532,
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: null,
          passkeys: [],
        },
      })

      render(<WalletButton />)

      expect(nameOf(screen.getByRole('button', { name: 'Passkey' }))).toBe('Passkey')
    })

    it('names the connected wallet with exactly what the pill displays', () => {
      setConnectedWallet()
      mocks.useActiveSigner.mockReturnValue({
        type: 'eoa',
        address: EOA_ADDRESS,
        walletClient: {},
      })

      const truncated = render(<WalletButton />)
      // No alias, no ENS: the truncated address IS the label, so the name must
      // be the same string rather than a generic "Wallet".
      expect(nameOf(screen.getByRole('button', { name: '0x5555…5555' }))).toBe('0x5555…5555')
      truncated.unmount()

      mocks.useOwnerDirectory.mockReturnValue({
        getOwnerAlias: vi.fn((address: string) =>
          address.toLowerCase() === EOA_ADDRESS.toLowerCase() ? 'Ledger main' : null,
        ),
      })

      render(<WalletButton />)
      expect(nameOf(screen.getByRole('button', { name: 'Ledger main' }))).toBe('Ledger main')
    })
  })

  // #1126: the Hybrid DeleGator branch — the PR's core deliverable. The
  // 'Signing with' block names the on-device credential WITHOUT an address
  // (Hybrid passkeys are raw P256 coordinates; none exists).
  it('Hybrid dropdown: honest account label + address-free Signing with block', async () => {
    const KEY_A = '0x' + '11'.repeat(32)
    const KEY_B = '0x' + '22'.repeat(32)
    const ACCOUNT = '0x' + 'aa'.repeat(20)
    // Mark the SECOND passkey as the on-device credential. The
    // marker is keyed by the base64url CREDENTIAL id, not the raw key_id —
    // use the real conversion so this test exercises the same path signing
    // does.
    const { credentialIdFromKeyId } = await import('@/lib/signer')
    window.localStorage.setItem('haven_passkey_device_' + credentialIdFromKeyId(KEY_B), '1')
    mocks.useActiveSigner.mockReturnValue({
      type: 'delegator_passkey',
      accountAddress: ACCOUNT,
      chainId: 84532,
      signers: {
        account_address: ACCOUNT,
        chain_id: 84532,
        owner_address: null,
        passkeys: [
          { key_id: KEY_A, x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' },
          { key_id: KEY_B, x: '0x3', y: '0x4', created_at: '2026-05-10T09:00:00.000Z' },
        ],
      },
    })

    render(<WalletButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Passkey' }))
    const dialog = screen.getByRole('dialog', { name: 'Wallet menu' })
    expect(within(dialog).getByText('Haven account')).toBeInTheDocument()
    expect(within(dialog).queryByText('Haven account (passkey)')).not.toBeInTheDocument()
    expect(within(dialog).getByText('Signing with')).toBeInTheDocument()
    // #1679: the credential is named by kind + enrollment date, never
    // positionally ("Backup 1") and never by platform brand.
    expect(within(dialog).getByText('Passkey · added May 10, 2026')).toBeInTheDocument()
    // The block identifies the credential by truncated key id, never an address:
    expect(within(dialog).getByText('0x2222…2222')).toBeInTheDocument()
    // #1952: the matched rendering must NOT carry the fallback's words, or the
    // two facts are indistinguishable in the direction that matters least
    // visibly — a positive-only assertion on 'Signing with' would pass against
    // BOTH renderings, since the fallback eyebrow contains that substring.
    expect(
      within(dialog).queryByText('No passkey enrolled on this device'),
    ).not.toBeInTheDocument()
    expect(
      within(dialog).queryByText('Your browser may ask you to choose a different one.'),
    ).not.toBeInTheDocument()
    window.localStorage.removeItem('haven_passkey_device_' + credentialIdFromKeyId(KEY_B))
  })

  /**
   * #1952 — the state the popover used to render as NOTHING.
   *
   * The defect was an inversion: `WalletButton` drove the block from
   * `hybridPasskeyOnDevice`, which returns `null` when no enrolled passkey
   * carries this device's marker, so `signingWith` went `undefined` and the
   * whole section vanished. That is precisely when signing falls back to
   * `passkeys[0]` — an arbitrary credential chosen by POSITION. The UI named
   * the credential when the choice was unambiguous and went silent when it was
   * arbitrary, on an authority-bearing action.
   *
   * The fix is a routing change, not a copy change: display now asks
   * `hybridPasskeyToSignWith` — the same selector `delegationPasskeySigner`
   * signs through (#1933) — so display and signing cannot name different keys.
   *
   * ── What these tests do and do not prove ────────────────────────────────
   *
   * They prove the COMPONENT's contract, because they hand `WalletButton` a
   * `delegator_passkey` through the mocked `useActiveSigner` directly. They do
   * NOT prove a reachable production state, and that distinction is stated
   * rather than glossed: the real `useActiveSigner` refuses to return a
   * `delegator_passkey` at all unless `hybridPasskeyOnDevice` already matched
   * (`lib/signer.ts`, pinned by `signer.test.ts` > "does NOT resolve the hybrid
   * signer when the device marker is missing"). So there is no fixture — and no
   * `npm run screenshot` scenario — that can drive a real browser into this
   * render, and none is faked here to make the acceptance criterion look met.
   * The upstream gate is filed separately.
   */
  it('Hybrid dropdown: names the passkeys[0] fallback and says it IS a fallback (#1952)', () => {
    const KEY_A = '0x' + '11'.repeat(32)
    const KEY_B = '0x' + '22'.repeat(32)
    const ACCOUNT = '0x' + 'aa'.repeat(20)
    // No device marker for EITHER key — the case the old code rendered blank.
    mocks.useActiveSigner.mockReturnValue({
      type: 'delegator_passkey',
      accountAddress: ACCOUNT,
      chainId: 84532,
      signers: {
        account_address: ACCOUNT,
        chain_id: 84532,
        owner_address: null,
        passkeys: [
          { key_id: KEY_A, x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' },
          { key_id: KEY_B, x: '0x3', y: '0x4', created_at: '2026-05-10T09:00:00.000Z' },
        ],
      },
    })

    render(<WalletButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Passkey' }))
    const dialog = screen.getByRole('dialog', { name: 'Wallet menu' })

    // The credential is NAMED rather than hidden, and it is the one signing
    // will actually use — passkeys[0], not the second key.
    const marker = within(dialog).getByText('No passkey enrolled on this device')
    expect(marker).toBeInTheDocument()
    expect(within(dialog).getByText('Signing with')).toBeInTheDocument()
    expect(within(dialog).getByText('Passkey · added March 3, 2026')).toBeInTheDocument()
    expect(within(dialog).getByText('0x1111…1111')).toBeInTheDocument()
    expect(
      within(dialog).getByText('Your browser may ask you to choose a different one.'),
    ).toBeInTheDocument()

    // The marker must be a DESIGNED one, not a longer sentence: the design pass
    // measured that an eyebrow-only distinction rested on incidental text wrap
    // at 288px. Assert the structural half — the left rule — so a revision that
    // keeps the words and drops the treatment fails here rather than passing as
    // "the copy is still there". The icon is asserted as a rendered svg for the
    // same reason.
    const block = marker.closest('div')
    expect(block?.className).toContain('border-l-2')
    expect(marker.querySelector('svg')).not.toBeNull()
    // The second key is not the one signing: naming it here would be the same
    // defect wearing different copy.
    expect(within(dialog).queryByText('0x2222…2222')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Passkey · added May 10, 2026')).not.toBeInTheDocument()
  })

  it('Hybrid dropdown: names no credential when the signer set is empty (#1952)', () => {
    const ACCOUNT = '0x' + 'aa'.repeat(20)
    mocks.useActiveSigner.mockReturnValue({
      type: 'delegator_passkey',
      accountAddress: ACCOUNT,
      chainId: 84532,
      signers: {
        account_address: ACCOUNT,
        chain_id: 84532,
        owner_address: null,
        passkeys: [],
      },
    })

    render(<WalletButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Passkey' }))
    const dialog = screen.getByRole('dialog', { name: 'Wallet menu' })

    // Nothing can sign, so there is no credential to name — and the fallback
    // copy must not claim one. This is the ONLY case where silence is correct,
    // which is why it is pinned: it is what stops the fix from being written as
    // "always render something".
    expect(within(dialog).queryByText('Signing with')).not.toBeInTheDocument()
    expect(
      within(dialog).queryByText('No passkey enrolled on this device'),
    ).not.toBeInTheDocument()
    expect(
      within(dialog).queryByText('Your browser may ask you to choose a different one.'),
    ).not.toBeInTheDocument()
  })
})
