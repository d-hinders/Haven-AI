import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import { credentialIdFromKeyId, rememberPasskeyCredentialOnDevice } from '@/lib/signer'

/**
 * Settings → Signers (#3825). The rules a screenshot cannot see: every signer
 * once, with the accounts it approves; no address by default; "passkey",
 * never a platform brand; the ordinal fallback numbered across the
 * deduplicated list; the connected wallet named by its connector.
 *
 * #4472: each approved account is an outline pill link (`LinkChip`) to its
 * `?tab=security`, the network suffix is a SECTION decision (every pill or
 * none), and a passkey whose credential this device holds carries a neutral
 * "This device" badge.
 */

const { mockGet, accountRef, mockDisconnect, mockOpenConnect } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  accountRef: {
    current: { isConnected: false, address: undefined as string | undefined, connector: undefined as { name: string } | undefined },
  },
  mockDisconnect: vi.fn(),
  mockOpenConnect: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: { get: mockGet } }))
vi.mock('wagmi', () => ({
  useAccount: () => accountRef.current,
  useDisconnect: () => ({ disconnect: mockDisconnect }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: mockOpenConnect }) }))

const { SignersSection } = await import('../SignersSection')

const WALLET = '0x' + 'ee'.repeat(20)
const PASSKEY_KEY_ID = '0x' + '11'.repeat(32)
const SECOND_PASSKEY_KEY_ID = '0x' + '22'.repeat(32)
const BASE_MAIN = { account_id: 'a1', account_address: '0x' + 'a1'.repeat(20), account_name: 'Main', chain_id: 8453 }
const SEPOLIA_MAIN = { account_id: 'a2', account_address: '0x' + 'a2'.repeat(20), account_name: 'Main', chain_id: 84532 }

const SIGNERS = [
  { kind: 'passkey', key_id: PASSKEY_KEY_ID, created_at: '2026-10-09T12:00:00.000Z', accounts: [BASE_MAIN, SEPOLIA_MAIN] },
  { kind: 'passkey', key_id: SECOND_PASSKEY_KEY_ID, created_at: null, accounts: [BASE_MAIN] },
  { kind: 'wallet', address: WALLET, accounts: [BASE_MAIN] },
]

function renderSection() {
  return render(
    <LocaleProvider>
      <SignersSection />
    </LocaleProvider>,
  )
}

beforeEach(() => {
  mockGet.mockReset()
  mockGet.mockResolvedValue({ signers: SIGNERS })
  accountRef.current = { isConnected: false, address: undefined, connector: undefined }
  mockDisconnect.mockReset()
  mockOpenConnect.mockReset()
})

describe('SignersSection (#3825)', () => {
  it('lists every signer once with the accounts it approves', async () => {
    renderSection()
    const passkeys = await screen.findAllByTestId('signer-row-passkey')
    expect(passkeys).toHaveLength(2)
    expect(screen.getAllByTestId('signer-row-wallet')).toHaveLength(1)
    expect(mockGet).toHaveBeenCalledWith('/user/signers')
    // One passkey approving the account on two networks reads as ONE row —
    // each account a pill link to its ?tab=security (#4358, pills #4472).
    // These accounts span Base and Base Sepolia, so the section appends the
    // network to EVERY pill (owner decision 2026-10-27).
    expect(within(passkeys[0]).getByRole('link', { name: 'Main (Base)' })).toBeInTheDocument()
    expect(within(passkeys[0]).getByRole('link', { name: 'Main (Base Sepolia)' })).toBeInTheDocument()
  })

  it('renders each approved account through the LinkChip primitive, with no "Approves" run', async () => {
    renderSection()
    const [first] = await screen.findAllByTestId('signer-row-passkey')
    const links = within(first).getAllByRole('link')
    expect(links).toHaveLength(2)
    for (const link of links) {
      // The pill's shape lives in the primitive, never re-created here.
      expect(link.className).toContain('rounded-full')
      expect(link.className).toContain('border')
      // The trailing arrow is lucide through `Icon`, decorative.
      expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    }
    // The comma-joined "Approves …" text run is gone.
    expect(within(first).queryByText(/Approves/)).toBeNull()
  })

  it('appends the network to every pill only when the accounts span more than one chain', async () => {
    mockGet.mockResolvedValue({
      signers: [
        { kind: 'passkey', key_id: '0x01', created_at: null, accounts: [BASE_MAIN] },
        { kind: 'wallet', address: WALLET, accounts: [{ ...BASE_MAIN, account_id: 'a3', account_name: 'Reserve' }] },
      ],
    })
    renderSection()
    // One chain across the whole section: the name alone, on every row.
    expect(await screen.findByRole('link', { name: 'Main' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Reserve' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Main (Base)' })).toBeNull()
  })

  it('names passkeys by enrollment date, numbering the fallback across the list, never a platform brand', async () => {
    renderSection()
    const [first, second] = await screen.findAllByTestId('signer-row-passkey')
    expect(within(first).getByText('Passkey · added 9 October 2026')).toBeInTheDocument()
    // The second passkey in the deduplicated list, with no stored date.
    expect(within(second).getByText('Passkey 2')).toBeInTheDocument()
    expect(screen.queryByText(/Face ID|Touch ID|Windows Hello/)).toBeNull()
  })

  it('shows no address by default, and reveals a wallet address only behind Show address', async () => {
    const { container } = renderSection()
    const wallet = await screen.findByTestId('signer-row-wallet')
    expect(within(wallet).getByText('Browser wallet')).toBeInTheDocument()
    // The address is in a closed disclosure; key ids are never rendered.
    const details = wallet.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(within(details).getByText(WALLET)).toBeInTheDocument()
    expect(container.textContent).not.toContain('11'.repeat(32))
    // Nothing outside that disclosure carries a 0x address. The pill row is a
    // flex `div`, not a `p` (#4472), so the guard reads every text node
    // outside `<details>` rather than only paragraphs.
    const outside = container.cloneNode(true) as HTMLElement
    outside.querySelectorAll('details').forEach((d) => d.remove())
    expect(outside.textContent ?? '').not.toMatch(/0x[0-9a-f]{6,}/i)
  })

  it('marks a passkey "This device" only when this device holds its credential', async () => {
    // The marker the enrollment flow writes, for the FIRST passkey only.
    rememberPasskeyCredentialOnDevice(credentialIdFromKeyId(PASSKEY_KEY_ID))
    renderSection()
    const [first, second] = await screen.findAllByTestId('signer-row-passkey')
    expect(within(first).getByText('This device')).toBeInTheDocument()
    expect(within(second).queryByText('This device')).toBeNull()
    // Wallet rows never get the badge.
    expect(within(screen.getByTestId('signer-row-wallet')).queryByText('This device')).toBeNull()
  })

  it('names the wallet by its connector when it is the one connected here', async () => {
    accountRef.current = { isConnected: true, address: WALLET.toUpperCase().replace('0X', '0x'), connector: { name: 'MetaMask' } }
    renderSection()
    const wallet = await screen.findByTestId('signer-row-wallet')
    expect(within(wallet).getByText('Browser wallet · MetaMask')).toBeInTheDocument()
  })

  it('a different connected wallet does not rename the signer row', async () => {
    accountRef.current = { isConnected: true, address: '0x' + '99'.repeat(20), connector: { name: 'MetaMask' } }
    renderSection()
    const wallet = await screen.findByTestId('signer-row-wallet')
    expect(within(wallet).getByText('Browser wallet')).toBeInTheDocument()
  })

  it('connects and disconnects a browser wallet from the connection row', async () => {
    const { unmount } = renderSection()
    const row = await screen.findByTestId('signer-wallet-connection')
    expect(within(row).getByText('Approve with a browser wallet? Connect it on this device.')).toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: 'Connect wallet' }))
    expect(mockOpenConnect).toHaveBeenCalledTimes(1)
    unmount()

    accountRef.current = { isConnected: true, address: WALLET, connector: { name: 'MetaMask' } }
    renderSection()
    const connected = await screen.findByTestId('signer-wallet-connection')
    expect(within(connected).getByText('MetaMask is connected on this device.')).toBeInTheDocument()
    fireEvent.click(within(connected).getByRole('button', { name: 'Disconnect' }))
    expect(mockDisconnect).toHaveBeenCalledTimes(1)
  })

  it('a failed read offers a retry that reads again', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'))
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getAllByTestId('signer-row-passkey')).toHaveLength(2))
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  // #3825 design review: the connection control must not read as one more
  // signer — it is not a signer row and carries no row label.
  it('the wallet connection is a footer line, not a signer row', async () => {
    renderSection()
    const row = await screen.findByTestId('signer-wallet-connection')
    expect(row.querySelector('p.font-medium')).toBeNull()
    expect(screen.getAllByTestId(/^signer-row-/)).toHaveLength(3)
  })

  it('never says "signer" outside the section title', async () => {
    const { container } = renderSection()
    await screen.findAllByTestId('signer-row-passkey')
    const heading = screen.getByRole('heading', { level: 2 })
    // #4358: the section is titled "Passkeys and wallets" — the one place
    // the word "signer" is allowed at all (copy-guidelines.md).
    expect(heading.textContent).toBe('Passkeys and wallets')
    const rest = (container.textContent ?? '').replace(heading.textContent ?? '', '')
    expect(rest).not.toMatch(/signer/i)
  })

  it('an account without a name reads as "Account"', async () => {
    mockGet.mockResolvedValue({
      signers: [{ kind: 'passkey', key_id: '0x01', created_at: null, accounts: [{ ...BASE_MAIN, account_name: null }] }],
    })
    renderSection()
    // #4472: one chain in the section, so the pill carries the name alone —
    // the fallback label, with no network suffix.
    const link = await screen.findByRole('link', { name: 'Account' })
    expect(link).toHaveAttribute('href', `/accounts/${BASE_MAIN.account_id}?tab=security`)
  })
})
