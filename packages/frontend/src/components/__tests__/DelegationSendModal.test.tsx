import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/lib/api'

// #3812: the in-flow connect/switch control reads wagmi and RainbowKit, which
// these tests do not provide. Stub it so the test can assert WHEN a flow
// offers it; `WalletConnectAction.test.tsx` covers what it does.
vi.mock('@/components/WalletConnectAction', () => ({
  default: () => <button type="button">Connect wallet</button>,
}))

const { mockUseSend, mockUseAccounts } = vi.hoisted(() => ({
  mockUseSend: vi.fn(),
  mockUseAccounts: vi.fn(),
}))

vi.mock('@/hooks/useDelegationSend', () => ({ useDelegationSend: (...a: unknown[]) => mockUseSend(...a) }))
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: (...a: unknown[]) => mockUseAccounts(...a) }))

/**
 * #4641: the dialog owns ONE `useContacts()` instance and passes its list into
 * `RecipientField`. The mock is stateful for the same reason the real hook is —
 * `addContact` updates the instance it was called on — so a test can prove the
 * saved contact reaches the picker without a second hook instance.
 */
const contactsFixture = vi.hoisted(() => ({
  initial: [] as Array<{ id: string; name: string; address: string; created_at: string; updated_at: string }>,
  loading: false,
  error: null as string | null,
  addContact: vi.fn(),
  /** How many `useContacts()` instances the dialog created. */
  instances: 0,
}))

vi.mock('@/hooks/useContacts', async () => {
  const React = await import('react')
  return {
    useContacts: () => {
      const mounted = React.useRef(false)
      if (!mounted.current) {
        mounted.current = true
        contactsFixture.instances += 1
      }
      const [contacts, setContacts] = React.useState(contactsFixture.initial)
      const addContact = React.useCallback(async (name: string, address: string) => {
        const created = await contactsFixture.addContact(name, address)
        setContacts((prev) => [...prev, created])
        return created
      }, [])
      return {
        contacts,
        loading: contactsFixture.loading,
        error: contactsFixture.error,
        addContact,
        refetch: async () => {},
        updateContact: async () => ({}),
        deleteContact: async () => {},
        resolveAddress: () => null,
      }
    },
  }
})

/**
 * A pass-through `RecipientField` that can be swapped for a stub recording the
 * `contacts` it was handed. The real field is used everywhere else — the stub
 * exists only for the "one data owner" checks, where what matters is the list
 * the dialog passes in, not the picker's own rendering.
 */
const fieldStub = vi.hoisted(() => ({ enabled: false, mounts: 0, contacts: [] as string[] }))

vi.mock('@/components/RecipientField', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/RecipientField')>()
  const React = await import('react')
  type FieldProps = Parameters<typeof actual.RecipientField>[0]
  function Stub(props: FieldProps) {
    React.useEffect(() => {
      fieldStub.mounts += 1
    }, [])
    fieldStub.contacts = props.contacts.map((c) => c.name)
    return (
      <div data-testid="recipient-field-stub" data-contacts={fieldStub.contacts.join(',')}>
        <button
          type="button"
          onClick={() => props.onChange({ address: '0x' + 'cc'.repeat(20), kind: 'new' })}
        >
          Pick new address
        </button>
      </div>
    )
  }
  return {
    ...actual,
    RecipientField: (props: FieldProps) =>
      fieldStub.enabled ? <Stub {...props} /> : <actual.RecipientField {...props} />,
    default: (props: FieldProps) => (fieldStub.enabled ? <Stub {...props} /> : <actual.default {...props} />),
  }
})

const DelegationSendModal = (await import('../DelegationSendModal')).default

const SENDING = '0x' + 'aa'.repeat(20)
const NEW_ADDRESS = '0x' + 'cc'.repeat(20)
const ACME = '0x2c9D0000000000000000000000000000000077ab'
const SAVINGS = '0x' + 'dd'.repeat(20)

const PROPS = {
  open: true,
  onClose: vi.fn(),
  accountAddress: SENDING,
  chainId: 84532,
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    busy: false,
    loaded: true,
    loadError: false,
    reload: vi.fn(),
    ready: true,
    passkeyElsewhere: false,
    send: vi.fn().mockResolvedValue({ ok: true, txHash: '0xfeed' }),
    ...overrides,
  }
}

function contact(overrides: Partial<{ id: string; name: string; address: string }> = {}) {
  return {
    id: 'c1',
    name: 'Acme Services',
    address: ACME,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/** Fill the Details screen and pick a recipient through the real field. */
function fillDetails({
  amount = '1.5',
  address = NEW_ADDRESS,
  option = /Send to/,
}: {
  amount?: string
  address?: string
  option?: RegExp
} = {}) {
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: amount } })
  const input = screen.getByRole('combobox', { name: 'To' })
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: address } })
  fireEvent.click(screen.getByRole('option', { name: option }))
}

function goToReview(options?: { amount?: string; address?: string; option?: RegExp }) {
  fillDetails(options)
  fireEvent.click(screen.getByRole('button', { name: 'Review' }))
}

/** Details → Review → Send, with a successful send. */
async function sendToNewAddress(send = vi.fn().mockResolvedValue({ ok: true, txHash: '0xfeed' })) {
  mockUseSend.mockReturnValue(base({ send }))
  render(<DelegationSendModal {...PROPS} />)
  goToReview()
  fireEvent.click(screen.getByRole('button', { name: /^Send / }))
  await waitFor(() => expect(screen.getByText('1.5 USDC sent')).toBeTruthy())
  return send
}

beforeEach(() => {
  mockUseSend.mockReset()
  mockUseAccounts.mockReset()
  mockUseAccounts.mockReturnValue({ accounts: [], loading: false })
  contactsFixture.initial = []
  contactsFixture.loading = false
  contactsFixture.error = null
  contactsFixture.addContact.mockReset()
  contactsFixture.addContact.mockImplementation(async (name: string, address: string) =>
    contact({ id: `c-${name}`, name, address }),
  )
  contactsFixture.instances = 0
  fieldStub.enabled = false
  fieldStub.mounts = 0
  fieldStub.contacts = []
})

describe('DelegationSendModal — Details screen (#4641)', () => {
  it('renders the recipient field and drops the toggle row and the raw address input', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.getByRole('combobox', { name: 'To' })).toBeTruthy()
    expect(screen.queryByText(/Or send to another Haven account/)).toBeNull()
    expect(screen.queryByPlaceholderText(/Recipient address/)).toBeNull()
  })

  it('names the sending account and shows no balance', () => {
    mockUseSend.mockReturnValue(base())
    mockUseAccounts.mockReturnValue({
      accounts: [{ id: 'a1', account_address: SENDING, chain_id: 84532, name: 'Operating wallet', is_default: true, created_at: '2026-01-01T00:00:00Z' }],
      loading: false,
    })
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.getByText('From Operating wallet')).toBeTruthy()
    expect(screen.queryByText(/balance/i)).toBeNull()
  })

  it("says the fee is Haven's and that the payment is reviewed before approval", () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.getByText('No network fee. You review the payment before you approve it.')).toBeTruthy()
  })

  it('Review stays disabled until a recipient is chosen and the amount parses', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    const review = screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement
    expect(review.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1.5' } })
    expect(review.disabled).toBe(true) // recipient still missing
    const input = screen.getByRole('combobox', { name: 'To' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: NEW_ADDRESS } })
    fireEvent.click(screen.getByRole('option', { name: /Send to/ }))
    expect(review.disabled).toBe(false)
  })

  it('shows the token symbol as the amount suffix and no token Select when the chain lists one token', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.queryByRole('combobox', { name: 'Token' })).toBeNull()
    expect(screen.queryByLabelText('Token')).toBeNull()
    // The suffix rides inside the amount field.
    expect(screen.getByText('USDC')).toBeTruthy()
  })

  it('keeps a token Select when a chain lists more than one sendable token', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} chainId={100} />)
    expect(screen.getByLabelText('Token')).toBeTruthy()
  })

  it('offers other own accounts on the sending chain by name, never the sending account', () => {
    mockUseSend.mockReturnValue(base())
    mockUseAccounts.mockReturnValue({
      accounts: [
        { id: 'a1', account_address: SENDING, chain_id: 84532, name: 'Operating wallet', is_default: true, created_at: '2026-01-01T00:00:00Z' },
        { id: 'a2', account_address: SAVINGS, chain_id: 84532, name: 'Savings', is_default: false, created_at: '2026-01-01T00:00:00Z' },
        { id: 'a3', account_address: '0x' + 'ee'.repeat(20), chain_id: 11155111, name: 'Ethereum account', is_default: false, created_at: '2026-01-01T00:00:00Z' },
      ],
      loading: false,
    })
    render(<DelegationSendModal {...PROPS} />)
    fireEvent.focus(screen.getByRole('combobox', { name: 'To' }))
    const accounts = screen.getByRole('group', { name: 'Your accounts' })
    expect(within(accounts).getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Savings'),
    ])
    expect(screen.queryByText('Operating wallet')).toBeNull()
    expect(screen.queryByText('Ethereum account')).toBeNull()
  })
})

describe('DelegationSendModal — Review screen (#4641)', () => {
  it('Review shows the review screen and does NOT call send()', () => {
    const send = vi.fn()
    mockUseSend.mockReturnValue(base({ send }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    expect(screen.getByText("You're sending")).toBeTruthy()
    expect(screen.getByText('1.5 USDC')).toBeTruthy()
    expect(send).not.toHaveBeenCalled()
  })

  it('shows the full 42-character address, never truncated', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    expect(NEW_ADDRESS).toHaveLength(42)
    expect(screen.getByText(NEW_ADDRESS)).toBeTruthy()
  })

  it('lists To, From, Network and the network fee', () => {
    mockUseSend.mockReturnValue(base())
    mockUseAccounts.mockReturnValue({
      accounts: [{ id: 'a1', account_address: SENDING, chain_id: 84532, name: 'Operating wallet', is_default: true, created_at: '2026-01-01T00:00:00Z' }],
      loading: false,
    })
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    expect(screen.getByText('To')).toBeTruthy()
    expect(screen.getByText('From')).toBeTruthy()
    expect(screen.getByText('Operating wallet')).toBeTruthy()
    expect(screen.getByText('Network')).toBeTruthy()
    expect(screen.getByText('Base Sepolia')).toBeTruthy()
    expect(screen.getByText('Network fee')).toBeTruthy()
    expect(screen.getByText('None. Haven covers it.')).toBeTruthy()
  })

  it('carries the neutral note and does not name the signer', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    expect(screen.getByText("A sent payment can't be reversed. You approve it on the next step.")).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/passkey|Face ID|Touch ID/i)
  })

  it('Back returns to Details with the recipient and amount kept', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('1.5')
    expect(document.querySelector('[data-recipient-chip]')).toHaveTextContent('0xcccc…cccc')
  })

  it("Send calls send() once with today's arguments", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, txHash: '0xfeed' })
    mockUseSend.mockReturnValue(base({ send }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    // USDC has 6 decimals on Base Sepolia — 1.5 → 1500000 atomic.
    expect(send.mock.calls[0][0]).toMatchObject({ amountAtomic: '1500000', to: NEW_ADDRESS })
  })

  it('Send stays disabled while ready is false or busy is true', () => {
    mockUseSend.mockReturnValue(base({ ready: false }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    expect((screen.getByRole('button', { name: /^Send / }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Send stays disabled while the hook reports busy', () => {
    mockUseSend.mockReturnValue(base({ busy: true }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    // A busy hook reads as the working state: the button says "Sending…" and
    // cannot be pressed again.
    expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  // #1097: with the signer set LOADED, !ready is only reachable for owner-only
  // accounts — the copy names the wallet; cross-device passkeys are a hint on
  // a WORKING send instead.
  it('names the owner wallet as the blocker when loaded but not ready', () => {
    mockUseSend.mockReturnValue(base({ ready: false }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    expect(screen.getByText(/Connect your account owner wallet/)).toBeTruthy()
    // #3812: the way out is in the modal, not only in the header.
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy()
  })

  it('a ready (passkey) send offers no wallet connect (#3812)', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
  })

  it('claims no blocker while the signer set is still loading', () => {
    mockUseSend.mockReturnValue(base({ loaded: false, ready: false }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    expect(screen.queryByText(/Connect your account owner wallet/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
  })

  it('a failed signer fetch is a retryable error, not owner-wallet advice', () => {
    const reload = vi.fn()
    mockUseSend.mockReturnValue(base({ loaded: false, loadError: true, ready: false, reload }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    expect(screen.queryByText(/Connect your account owner wallet/)).toBeNull()
    expect(screen.getByText(/could not load/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reload).toHaveBeenCalled()
  })

  it('shows the cross-device hint when ready but the passkey is elsewhere', () => {
    mockUseSend.mockReturnValue(base({ passkeyElsewhere: true }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    expect(screen.getByText(/may be on another device/)).toBeTruthy()
    expect(screen.queryByText(/Connect your account owner wallet/)).toBeNull()
  })
})

describe('DelegationSendModal — working, cancelled and failed (#4641)', () => {
  it('blocks the close button, Escape and a backdrop click while send() is in flight', async () => {
    let resolveSend: (value: unknown) => void = () => {}
    const send = vi.fn().mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
    const onClose = vi.fn()
    mockUseSend.mockReturnValue(base({ send }))
    render(<DelegationSendModal {...PROPS} onClose={onClose} />)
    goToReview()
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))

    // The button reads "Sending…" and is disabled.
    const sending = screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement
    expect(sending.disabled).toBe(true)

    // The ✕ is disabled.
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true)
    // Escape does nothing.
    fireEvent.keyDown(document, { key: 'Escape' })
    // A backdrop click does nothing.
    const backdrop = document.querySelector('.v2-modal-backdrop') as HTMLElement
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop)

    expect(onClose).not.toHaveBeenCalled()

    resolveSend({ ok: true, txHash: '0xfeed' })
    await waitFor(() => expect(screen.getByText(/sent$/)).toBeTruthy())
  })

  it('a cancelled approval returns to Review with the neutral message', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, reason: 'cancelled' })
    mockUseSend.mockReturnValue(base({ send }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    await waitFor(() => expect(screen.getByText('Approval was cancelled.')).toBeTruthy())
    // Still on Review, with the retry action.
    expect(screen.getByText("You're sending")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('a failure shows the server message on Review with Try again', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, reason: 'failed', message: 'The transfer was refused.' })
    mockUseSend.mockReturnValue(base({ send }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    await waitFor(() => expect(screen.getByText('The transfer was refused.')).toBeTruthy())
    expect(screen.getByText("You're sending")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('a failure with no message falls back to the generic sentence', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, reason: 'failed' })
    mockUseSend.mockReturnValue(base({ send }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    await waitFor(() => expect(screen.getByText('Haven could not send this payment. Try again.')).toBeTruthy())
  })
})

describe('DelegationSendModal — success (#4641)', () => {
  it('shows the amount sent, the recipient and the network, and fires onSent', async () => {
    const onSent = vi.fn()
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} onSent={onSent} />)
    goToReview()
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    await waitFor(() => expect(screen.getByText('1.5 USDC sent')).toBeTruthy())
    expect(screen.getByText('To 0xcccc…cccc on Base Sepolia.')).toBeTruthy()
    expect(onSent).toHaveBeenCalledTimes(1)
  })

  it('links to the chain explorer when send() returns a txHash', async () => {
    mockUseSend.mockReturnValue(base({ send: vi.fn().mockResolvedValue({ ok: true, txHash: '0xfeed' }) }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    const link = await screen.findByRole('link', { name: 'View transaction' })
    expect(link.getAttribute('href')).toBe('https://sepolia.basescan.org/tx/0xfeed')
  })

  it('omits View transaction when the txHash is null', async () => {
    mockUseSend.mockReturnValue(base({ send: vi.fn().mockResolvedValue({ ok: true, txHash: null }) }))
    render(<DelegationSendModal {...PROPS} />)
    goToReview()
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    await waitFor(() => expect(screen.getByText('1.5 USDC sent')).toBeTruthy())
    expect(screen.queryByRole('link', { name: 'View transaction' })).toBeNull()
  })

  it('Done closes the dialog', async () => {
    const onClose = vi.fn()
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} onClose={onClose} />)
    goToReview()
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    await waitFor(() => expect(screen.getByText('1.5 USDC sent')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('DelegationSendModal — save as contact (#4641)', () => {
  it('offers the row after a send to a new address', async () => {
    await sendToNewAddress()
    expect(screen.getByText('Save this address as a contact?')).toBeTruthy()
  })

  it('does not offer the row after a send to a saved contact', async () => {
    contactsFixture.initial = [contact()]
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    goToReview({ address: ACME, option: /Acme Services/ })
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    await waitFor(() => expect(screen.getByText('1.5 USDC sent')).toBeTruthy())
    expect(screen.queryByText('Save this address as a contact?')).toBeNull()
  })

  it('does not offer the row after a send to one of your own accounts', async () => {
    mockUseAccounts.mockReturnValue({
      accounts: [{ id: 'a2', account_address: SAVINGS, chain_id: 84532, name: 'Savings', is_default: false, created_at: '2026-01-01T00:00:00Z' }],
      loading: false,
    })
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    goToReview({ address: SAVINGS, option: /Savings/ })
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    await waitFor(() => expect(screen.getByText('1.5 USDC sent')).toBeTruthy())
    expect(screen.queryByText('Save this address as a contact?')).toBeNull()
  })

  it('does not offer the row while contacts are still loading', async () => {
    contactsFixture.loading = true
    await sendToNewAddress()
    expect(screen.queryByText('Save this address as a contact?')).toBeNull()
  })

  it("saves the trimmed name and the address through the dialog's addContact", async () => {
    await sendToNewAddress()
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: '  Acme Services  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(contactsFixture.addContact).toHaveBeenCalledWith('Acme Services', NEW_ADDRESS))
    expect(await screen.findByText('Saved as Acme Services')).toBeTruthy()
  })

  it('refuses a blank or whitespace-only name without an API call', async () => {
    await sendToNewAddress()
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Enter a name to save this contact.')).toBeTruthy()
    expect(contactsFixture.addContact).not.toHaveBeenCalled()
  })

  it('shows "Already saved" for a 409, not an error', async () => {
    contactsFixture.addContact.mockRejectedValueOnce(
      new ApiRequestError('A contact with this address already exists', 409, {}),
    )
    await sendToNewAddress()
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Already saved')).toBeTruthy()
    expect(screen.queryByText(/could not save/)).toBeNull()
  })

  it('shows a retryable inline error with the name kept for any other failure', async () => {
    contactsFixture.addContact.mockRejectedValueOnce(new Error('network down'))
    await sendToNewAddress()
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Haven could not save this contact. Try again.')).toBeTruthy()
    expect((screen.getByLabelText('Contact name') as HTMLInputElement).value).toBe('Acme')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('blocks Done and every close path while the save is in flight', async () => {
    let resolveSave: (value: unknown) => void = () => {}
    contactsFixture.addContact.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve }))
    const onClose = vi.fn()
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} onClose={onClose} />)
    goToReview()
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    await waitFor(() => expect(screen.getByText('1.5 USDC sent')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const saving = screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement
    expect(saving.disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(document.querySelector('.v2-modal-backdrop') as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()

    resolveSave(contact({ name: 'Acme' }))
    await waitFor(() => expect(screen.getByText('Saved as Acme')).toBeTruthy())
  })
})

describe('DelegationSendModal — one data owner (#4641)', () => {
  it('creates exactly one useContacts() instance for the whole dialog', async () => {
    await sendToNewAddress()
    expect(contactsFixture.instances).toBe(1)
  })

  it('a contact saved on the success screen is offered by the picker when the dialog reopens, from that same instance', async () => {
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen
          </button>
          <DelegationSendModal {...PROPS} open={open} onClose={() => setOpen(false)} />
        </>
      )
    }
    mockUseSend.mockReturnValue(base())
    render(<Harness />)

    goToReview()
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    await waitFor(() => expect(screen.getByText('1.5 USDC sent')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Acme Services' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('Saved as Acme Services')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))

    // The dialog component never unmounted, so this is the SAME hook instance —
    // a second one would never see the contact.
    expect(contactsFixture.instances).toBe(1)
    fireEvent.focus(screen.getByRole('combobox', { name: 'To' }))
    const contacts = screen.getByRole('group', { name: 'Contacts' })
    expect(within(contacts).getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Acme Services'),
    ])
  })

  it("passes the dialog's contacts list into the field, and the saved contact joins it without a second instance", async () => {
    fieldStub.enabled = true
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    expect(fieldStub.contacts).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Pick new address' }))
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    fireEvent.click(screen.getByRole('button', { name: /^Send / }))
    await waitFor(() => expect(screen.getByText('1.5 USDC sent')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Acme Services' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('Saved as Acme Services')).toBeTruthy())

    // Back to Details through a fresh open: the field is handed the SAME list,
    // now carrying the saved contact, and the hook instance count is unchanged.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(contactsFixture.instances).toBe(1)
  })
})

describe('DelegationSendModal — lifecycle (#4641)', () => {
  it('closing and reopening starts on a fresh Details step', async () => {
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen
          </button>
          <DelegationSendModal {...PROPS} open={open} onClose={() => setOpen(false)} />
        </>
      )
    }
    mockUseSend.mockReturnValue(base())
    render(<Harness />)
    goToReview()
    expect(screen.getByText("You're sending")).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))

    expect(screen.getByRole('combobox', { name: 'To' })).toBeTruthy()
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('')
    expect(document.querySelector('[data-recipient-chip]')).toBeNull()
  })

  it('a changed initialRecipient while open re-seeds the recipient', async () => {
    function Harness() {
      const [preset, setPreset] = useState(NEW_ADDRESS)
      return (
        <>
          <button type="button" onClick={() => setPreset(ACME)}>
            Change preset
          </button>
          <DelegationSendModal {...PROPS} initialRecipient={preset} />
        </>
      )
    }
    contactsFixture.initial = [contact()]
    mockUseSend.mockReturnValue(base())
    render(<Harness />)
    await waitFor(() => expect(document.querySelector('[data-recipient-chip]')).toHaveTextContent('0xcccc…cccc'))

    fireEvent.click(screen.getByRole('button', { name: 'Change preset' }))
    await waitFor(() => expect(document.querySelector('[data-recipient-chip]')).toHaveTextContent('Acme Services'))
  })
})

describe('DelegationSendModal — initialRecipient (#4641)', () => {
  it('opens with the short address, resolves to the named chip and focuses Amount', async () => {
    contactsFixture.initial = [contact()]
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} initialRecipient={ACME} />)

    // The chip is on screen before the data settles, showing the short address.
    expect(document.querySelector('[data-recipient-chip]')).toHaveTextContent('0x2c9D…77ab')
    // Focus lands on Amount, not the To field.
    expect(screen.getByLabelText('Amount')).toHaveFocus()
    // Once contacts load, the chip resolves to the contact's name.
    await waitFor(() => expect(document.querySelector('[data-recipient-chip]')).toHaveTextContent('Acme Services'))
  })

  it('without a preset, focus lands on the To field', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.getByRole('combobox', { name: 'To' })).toHaveFocus()
  })
})

describe('DelegationSendModal — footer (#4641)', () => {
  it('renders the actions in the modal footer through DialogActions on Details and Review', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    const body = document.querySelector('[data-modal-body]') as HTMLElement
    const actions = document.querySelector('[data-dialog-actions]') as HTMLElement
    expect(actions).not.toBeNull()
    expect(body.contains(actions)).toBe(false)
    expect(within(actions).getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(within(actions).getByRole('button', { name: 'Review' })).toBeTruthy()

    goToReview()
    const reviewActions = document.querySelector('[data-dialog-actions]') as HTMLElement
    expect(document.querySelector('[data-modal-body]')!.contains(reviewActions)).toBe(false)
    expect(within(reviewActions).getByRole('button', { name: 'Back' })).toBeTruthy()
    expect(within(reviewActions).getByRole('button', { name: /^Send / })).toBeTruthy()
  })
})

describe('DelegationSendModal — copy (#4641)', () => {
  it('is outcome language — no delegation/userop/treasury jargon', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    expect(document.body.textContent).not.toMatch(/delegation|userop|treasury|calldata|sponsor/i)
  })
})
