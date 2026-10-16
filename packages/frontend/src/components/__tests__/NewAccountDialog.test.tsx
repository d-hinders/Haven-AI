import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toHex } from 'viem'

const BOTH_CHAINS = [
  { chainId: 8453, name: 'Base' },
  { chainId: 84532, name: 'Base Sepolia' },
]
const { mockUseAccounts, mockUseUserSigners, mockGetPasskeyAssertion, mockCreatePasskey, mockChains } = vi.hoisted(() => ({
  mockChains: { current: [] as Array<{ chainId: number; name: string }> },
  mockUseAccounts: vi.fn(),
  mockUseUserSigners: vi.fn(),
  mockGetPasskeyAssertion: vi.fn(),
  mockCreatePasskey: vi.fn(),
}))

vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => mockUseAccounts() }))
vi.mock('@/hooks/useUserSigners', () => ({ useUserSigners: () => mockUseUserSigners() }))
vi.mock('@/hooks/useDeployableChains', () => ({
  useDeployableChains: () => ({ chains: mockChains.current, loading: false }),
}))
vi.mock('@/lib/passkey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/passkey')>()
  return {
    ...actual,
    getPasskeyAssertion: (...args: unknown[]) => mockGetPasskeyAssertion(...args),
    createPasskey: (...args: unknown[]) => mockCreatePasskey(...args),
  }
})

import NewAccountDialog from '../NewAccountDialog'
import { ApiRequestError } from '@/lib/api'
import { base64UrlEncode, PasskeyCancelledError, PasskeyUnsupportedError } from '@/lib/passkey'

function account(id: string, name: string, chainId: number, isDefault = false) {
  return {
    id,
    account_address: `0x${id.padEnd(40, '0')}`,
    chain_id: chainId,
    name,
    is_default: isDefault,
    created_at: '2026-06-01T00:00:00Z',
  }
}

const MAIN = account('main1', 'Operating', 84532, true)
const OTHER = account('other1', 'Projects', 8453)
const WALLET = account('wallet1', 'Wallet account', 84532)

const RAW_A = new TextEncoder().encode('passkey-a')
const RAW_B = new TextEncoder().encode('passkey-b')
const KEY_A = toHex(RAW_A)
const KEY_B = toHex(RAW_B)
const CRED_A = base64UrlEncode(RAW_A)
const CRED_B = base64UrlEncode(RAW_B)

function approved(a: ReturnType<typeof account>) {
  return { account_id: a.id, account_address: a.account_address, account_name: a.name, chain_id: a.chain_id }
}

/** Both accounts behind passkey A — the common case after one create. */
const SHARED_SIGNERS = [{ kind: 'passkey', key_id: KEY_A, created_at: null, accounts: [approved(MAIN), approved(OTHER)] }]
/** Different passkeys per account — the source is worth asking about. */
const SPLIT_SIGNERS = [
  { kind: 'passkey', key_id: KEY_A, created_at: null, accounts: [approved(MAIN)] },
  { kind: 'passkey', key_id: KEY_B, created_at: null, accounts: [approved(OTHER)] },
]

const CREATED = {
  id: 'new1',
  account_address: '0x4024000000000000000000000000000000000001',
  chain_id: 84532,
  account_type: 'delegator_hybrid',
  deployed: false,
  created_at: '2026-10-16T00:00:00Z',
}

const UNKNOWN =
  'Haven couldn’t confirm the account. It may have been created anyway. Check again before trying again: trying again here won’t create a second one.'
const LOCKED = 'To keep this from creating a second account, the details are locked until Haven knows what happened.'

let createAccount: ReturnType<typeof vi.fn>
let reloadSigners: ReturnType<typeof vi.fn>
let refreshAccounts: ReturnType<typeof vi.fn>

function setup({
  accounts = [MAIN, OTHER],
  signers = SHARED_SIGNERS as unknown[] | null,
  loadError = false,
  preferredSourceAccountId,
}: {
  accounts?: ReturnType<typeof account>[]
  signers?: unknown[] | null
  loadError?: boolean
  preferredSourceAccountId?: string
} = {}) {
  mockUseAccounts.mockReturnValue({ accounts, createAccount, refreshAccounts })
  mockUseUserSigners.mockReturnValue({ signers, loadError, reload: reloadSigners })
  const onClose = vi.fn()
  render(<NewAccountDialog open onClose={onClose} preferredSourceAccountId={preferredSourceAccountId} />)
  return { onClose }
}

function typeName(value: string) {
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value } })
}

async function submit() {
  await act(async () => {
    // After an unknown outcome the same button reads "Try again".
    fireEvent.click(screen.getByRole('button', { name: /^(Create account with a passkey|Try again)$/ }))
  })
}

function assertsWith(credentialId: string) {
  mockGetPasskeyAssertion.mockResolvedValue({
    credentialId,
    signatureDER: '0x',
    authenticatorData: '0x',
    clientDataJSON: '0x',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockChains.current = BOTH_CHAINS
  createAccount = vi.fn().mockResolvedValue(CREATED)
  reloadSigners = vi.fn()
  refreshAccounts = vi.fn().mockResolvedValue(true)
  assertsWith(CRED_A)
})

describe('NewAccountDialog — the happy path (#4024)', () => {
  it('runs ONE passkey assertion restricted to the source account, then creates and confirms the account', async () => {
    setup()
    typeName('Reserve')
    await submit()

    // One assertion, no new credential.
    expect(mockGetPasskeyAssertion).toHaveBeenCalledTimes(1)
    expect(mockCreatePasskey).not.toHaveBeenCalled()
    const assertionArgs = mockGetPasskeyAssertion.mock.calls[0]![0] as { allowCredentialIds: string[]; challenge: Uint8Array }
    expect(assertionArgs.allowCredentialIds).toEqual([CRED_A])
    expect(assertionArgs.challenge).toHaveLength(32)

    expect(createAccount).toHaveBeenCalledTimes(1)
    const body = createAccount.mock.calls[0]![0]
    expect(body).toMatchObject({
      // The default account is the source; its passkey is the key the device returned.
      source_account_id: 'main1',
      key_id: KEY_A,
      chain_id: 84532,
      name: 'Reserve',
    })
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/)

    const done = await screen.findByTestId('new-account-created')
    expect(within(done).getByText('Reserve was created on Base Sepolia')).toBeInTheDocument()
    expect(within(done).getByText(/has no backup yet/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open account' })).toHaveAttribute('href', '/accounts/new1')
  })

  it('sends the key the device asserted, not the first one the source lists', async () => {
    // The source holds two passkeys; the device answers with the second.
    setup({ signers: [{ kind: 'passkey', key_id: KEY_A, created_at: null, accounts: [approved(MAIN)] }, { kind: 'passkey', key_id: KEY_B, created_at: null, accounts: [approved(MAIN)] }], accounts: [MAIN] })
    assertsWith(CRED_B)
    typeName('Reserve')
    await submit()
    expect((mockGetPasskeyAssertion.mock.calls[0]![0] as { allowCredentialIds: string[] }).allowCredentialIds).toEqual([CRED_A, CRED_B])
    expect(createAccount.mock.calls[0]![0].key_id).toBe(KEY_B)
  })

  it('remembers the asserted credential on this device', async () => {
    setup()
    typeName('Reserve')
    await submit()
    await screen.findByTestId('new-account-created')
    expect(localStorage.getItem(`haven_passkey_device_${CRED_A}`)).toBe('1')
  })

  it('sends the chosen network', async () => {
    setup()
    typeName('Reserve')
    fireEvent.change(screen.getByLabelText('Network'), { target: { value: '8453' } })
    await submit()
    expect(createAccount.mock.calls[0]![0].chain_id).toBe(8453)
  })

  it('starts on the scoped account when the caller names one', async () => {
    setup({ preferredSourceAccountId: 'other1' })
    typeName('Reserve')
    // The network follows the source account until the user picks one.
    expect(screen.getByLabelText('Network')).toHaveValue('8453')
    await submit()
    expect(createAccount.mock.calls[0]![0].source_account_id).toBe('other1')
  })
})

describe('NewAccountDialog — the copy (#4024 acceptance)', () => {
  it('says the passkey secures it, backups are per account, and nothing is set up until first use', () => {
    setup()
    const facts = screen.getByTestId('new-account-facts')
    expect(within(facts).getByText('Secured by the passkey you use next.')).toBeInTheDocument()
    expect(facts).toHaveTextContent('it becomes the only way to approve actions in the new account')
    expect(within(facts).getByText('Backups don’t carry over.')).toBeInTheDocument()
    expect(facts).toHaveTextContent('A backup passkey or wallet on another account doesn’t protect this one')
    expect(facts).toHaveTextContent('Signers, in Settings, shows which accounts each passkey and wallet approves.')
    expect(within(facts).getByText('Nothing is set up on Base Sepolia yet.')).toBeInTheDocument()
  })
})

describe('NewAccountDialog — the source choice', () => {
  it('asks nothing when every account holds the same passkey', () => {
    setup({ signers: SHARED_SIGNERS })
    expect(screen.queryByLabelText('Use a passkey from')).toBeNull()
  })

  it('offers the source when accounts hold different passkeys, and restricts the prompt to the picked one', async () => {
    setup({ signers: SPLIT_SIGNERS })
    const picker = screen.getByLabelText('Use a passkey from')
    expect(picker).toHaveValue('main1')
    fireEvent.change(picker, { target: { value: 'other1' } })
    typeName('Reserve')
    assertsWith(CRED_B)
    await submit()

    expect((mockGetPasskeyAssertion.mock.calls[0]![0] as { allowCredentialIds: string[] }).allowCredentialIds).toEqual([CRED_B])
    expect(createAccount.mock.calls[0]![0]).toMatchObject({ source_account_id: 'other1', key_id: KEY_B })
  })
})

describe('NewAccountDialog — nothing is sent without a name or a passkey', () => {
  it('requires a name before asking for the passkey', async () => {
    setup()
    await submit()
    expect(screen.getByRole('alert')).toHaveTextContent('Give the account a name.')
    expect(mockGetPasskeyAssertion).not.toHaveBeenCalled()
  })

  it('a cancelled passkey prompt returns to the form with no error', async () => {
    mockGetPasskeyAssertion.mockRejectedValue(new PasskeyCancelledError())
    setup()
    typeName('Reserve')
    await submit()

    expect(createAccount).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create account with a passkey' })).toBeEnabled()
    expect(screen.getByLabelText('Account name')).toHaveValue('Reserve')
  })

  it('treats the browser’s NotAllowedError as a cancellation too', async () => {
    mockGetPasskeyAssertion.mockRejectedValue(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'))
    setup()
    typeName('Reserve')
    await submit()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(createAccount).not.toHaveBeenCalled()
  })

  it('says the passkey could not be read when the prompt fails for another reason', async () => {
    mockGetPasskeyAssertion.mockRejectedValue(new Error('WebAuthn assertion returned an unexpected response.'))
    setup()
    typeName('Reserve')
    await submit()
    expect(screen.getByRole('alert')).toHaveTextContent('Your passkey couldn’t be read. Try again.')
    expect(createAccount).not.toHaveBeenCalled()
  })

  it('says so when this browser cannot use a passkey', async () => {
    mockGetPasskeyAssertion.mockRejectedValue(new PasskeyUnsupportedError())
    setup()
    typeName('Reserve')
    await submit()
    expect(screen.getByRole('alert')).toHaveTextContent('This browser can’t use a passkey.')
    expect(createAccount).not.toHaveBeenCalled()
  })

  it('refuses, without sending it, a passkey that is not on the source account', async () => {
    assertsWith(CRED_B)
    setup({ signers: SHARED_SIGNERS })
    typeName('Reserve')
    await submit()
    expect(createAccount).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('That passkey isn’t one of Operating’s.')
  })
})

describe('NewAccountDialog — typed refusals', () => {
  async function refusedWith(status: number, body: Record<string, unknown>) {
    createAccount.mockRejectedValue(new ApiRequestError(String(body.error ?? ''), status, body))
    setup()
    typeName('Reserve')
    await submit()
    return screen.getByRole('alert')
  }

  it('shows the per-user cap, not a generic error', async () => {
    const alert = await refusedWith(422, { error: 'whatever the sentence says', error_code: 'ACCOUNT_CAP_REACHED', cap: 10 })
    expect(alert).toHaveTextContent('You already have 10 accounts on Base Sepolia, the most Haven allows on one network.')
    expect(alert).toHaveTextContent('Choose another network')
    expect(alert).not.toHaveTextContent('couldn’t create')
  })

  it('shows the cap without a number when the code carries none', async () => {
    const alert = await refusedWith(422, { error: 'x', error_code: 'ACCOUNT_CAP_REACHED' })
    expect(alert).toHaveTextContent('You already have the most accounts Haven allows on Base Sepolia.')
  })

  it('names the source when it no longer has a passkey', async () => {
    const alert = await refusedWith(422, { error: 'x', error_code: 'SOURCE_HAS_NO_PASSKEY' })
    expect(alert).toHaveTextContent('Operating no longer has a passkey, so it can’t secure a new account.')
  })

  it('names the source when the server says the key is not on it', async () => {
    const alert = await refusedWith(422, { error: 'x', error_code: 'KEY_NOT_ON_SOURCE' })
    expect(alert).toHaveTextContent('That passkey isn’t one of Operating’s.')
  })

  it('says the source could not be found', async () => {
    const alert = await refusedWith(404, { error: 'x', error_code: 'SOURCE_ACCOUNT_NOT_FOUND' })
    expect(alert).toHaveTextContent('Haven couldn’t find Operating among your accounts.')
  })

  it('falls back on a code-less 422 to "could not create", passing the sentence through', async () => {
    const alert = await refusedWith(422, { error: 'This user already has 10 accounts on chain 84532' })
    expect(alert).toHaveTextContent(
      'Haven couldn’t create the account. Details: This user already has 10 accounts on chain 84532',
    )
  })

  it('says to wait at the rate limit', async () => {
    const alert = await refusedWith(429, { error: 'Too Many Requests' })
    expect(alert).toHaveTextContent('Too many attempts in a short time.')
  })

  it('treats a 5xx as an unknown outcome: says the account may exist and offers Check again', async () => {
    const alert = await refusedWith(502, { error: 'Could not derive the account address' })
    expect(alert).toHaveTextContent(UNKNOWN)
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('treats no answer at all as an unknown outcome too', async () => {
    createAccount.mockRejectedValue(new TypeError('Failed to fetch'))
    setup()
    typeName('Reserve')
    await submit()
    expect(screen.getByRole('alert')).toHaveTextContent(UNKNOWN)
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it('makes no retry promise for a definite code-less refusal, and does not re-read the list', async () => {
    const alert = await refusedWith(404, { error: 'Source account not found' })
    expect(alert).toHaveTextContent('Haven couldn’t create the account. Details: Source account not found')
    expect(alert).not.toHaveTextContent('second one')
    expect(alert).not.toHaveTextContent('may have been created')
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    expect(refreshAccounts).not.toHaveBeenCalled()
  })

  it('clears a refusal once the inputs it described change', async () => {
    const alert = await refusedWith(422, { error: 'x', error_code: 'ACCOUNT_CAP_REACHED', cap: 10 })
    expect(alert).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Network'), { target: { value: '8453' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('NewAccountDialog — states without a form', () => {
  it('explains that a passkey account is needed when every account is wallet-only', () => {
    setup({
      accounts: [WALLET],
      signers: [{ kind: 'wallet', address: '0x1111111111111111111111111111111111111111', accounts: [approved(WALLET)] }],
    })
    const panel = screen.getByTestId('new-account-needs-passkey')
    expect(within(panel).getByText('A new account needs a passkey')).toBeInTheDocument()
    expect(panel).toHaveTextContent('none of yours has one yet')
    expect(screen.queryByRole('button', { name: 'Create account with a passkey' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Open Wallet account' })).toHaveAttribute('href', '/accounts/wallet1')
  })

  it('shows a loading state while the passkeys load', () => {
    setup({ signers: null })
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('button', { name: 'Create account with a passkey' })).toBeNull()
  })

  it('offers a retry when the passkeys fail to load', async () => {
    setup({ signers: null, loadError: true })
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load your passkeys')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(reloadSigners).toHaveBeenCalledTimes(1))
  })

  it('renders nothing while closed', () => {
    mockUseAccounts.mockReturnValue({ accounts: [MAIN], createAccount, refreshAccounts })
    mockUseUserSigners.mockReturnValue({ signers: SHARED_SIGNERS, loadError: false, reload: reloadSigners })
    render(<NewAccountDialog open={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    // Mounted only while open: the signer read does not run behind a closed dialog.
    expect(mockUseUserSigners).not.toHaveBeenCalled()
  })
})

describe('NewAccountDialog — closing is blocked mid-flight', () => {
  /** Every way out of the dialog, tried while it is busy. */
  function tryToClose() {
    fireEvent.keyDown(document, { key: 'Escape' })
    const backdrop = document.querySelector('.v2-modal-backdrop')
    expect(backdrop, 'the Modal backdrop handle moved').not.toBeNull()
    fireEvent.click(backdrop!)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  }

  it('while the passkey prompt is open', async () => {
    let resolveAssertion!: (value: unknown) => void
    mockGetPasskeyAssertion.mockReturnValue(new Promise((resolve) => (resolveAssertion = resolve)))
    const { onClose } = setup()
    typeName('Reserve')
    await submit()

    expect(screen.getByRole('button', { name: 'Waiting for your passkey…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    tryToClose()
    expect(onClose).not.toHaveBeenCalled()

    // Non-vacuity: once the flow settles, the same Escape does close.
    await act(async () => {
      resolveAssertion({ credentialId: CRED_A, signatureDER: '0x', authenticatorData: '0x', clientDataJSON: '0x' })
    })
    await screen.findByTestId('new-account-created')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a second click while the prompt is open does not start a second create', async () => {
    let resolveAssertion!: (value: unknown) => void
    mockGetPasskeyAssertion.mockReturnValue(new Promise((resolve) => (resolveAssertion = resolve)))
    setup()
    typeName('Reserve')
    await submit()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Waiting for your passkey…' }))
    })
    await act(async () => {
      resolveAssertion({ credentialId: CRED_A, signatureDER: '0x', authenticatorData: '0x', clientDataJSON: '0x' })
    })
    await screen.findByTestId('new-account-created')
    expect(mockGetPasskeyAssertion).toHaveBeenCalledTimes(1)
    expect(createAccount).toHaveBeenCalledTimes(1)
  })

  it('while the create call is in flight', async () => {
    let resolveCreate!: (value: unknown) => void
    createAccount.mockReturnValue(new Promise((resolve) => (resolveCreate = resolve)))
    const { onClose } = setup()
    typeName('Reserve')
    await submit()

    expect(screen.getByRole('button', { name: 'Setting up your account…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
    tryToClose()
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      resolveCreate(CREATED)
    })
    await screen.findByTestId('new-account-created')
    fireEvent.click(document.querySelector('.v2-modal-backdrop')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('NewAccountDialog — the unknown submission', () => {
  const BAD_GATEWAY = () => new ApiRequestError('Bad gateway', 502, { error: 'Bad gateway' })

  async function reachUnknown() {
    createAccount.mockRejectedValueOnce(BAD_GATEWAY())
    const rendered = setup()
    typeName('Reserve')
    await submit()
    expect(screen.getByTestId('new-account-unknown')).toHaveTextContent(UNKNOWN)
    return rendered
  }

  const unknownShown = () => screen.queryByTestId('new-account-unknown') !== null
  const sentKeys = () => createAccount.mock.calls.map((c) => c[0].idempotency_key)

  function nextReadReturns(accounts: ReturnType<typeof account>[]) {
    refreshAccounts.mockImplementation(async () => {
      mockUseAccounts.mockReturnValue({ accounts, createAccount, refreshAccounts })
      return true
    })
  }

  async function checkAgain() {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    })
  }

  it('shows the alert, why the details are locked, Check again and Try again', async () => {
    await reachUnknown()
    expect(screen.getByTestId('new-account-unknown')).toHaveTextContent(LOCKED)
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('locks the name, network and passkey source while it stands', async () => {
    await reachUnknown()
    expect(screen.getByLabelText('Account name')).toBeDisabled()
    expect(screen.getByLabelText('Account name')).toHaveValue('Reserve')
    expect(screen.getByLabelText('Network')).toBeDisabled()
  })

  it('locks the source picker too, when there is one', async () => {
    createAccount.mockRejectedValueOnce(BAD_GATEWAY())
    setup({ signers: SPLIT_SIGNERS })
    typeName('Reserve')
    await submit()
    expect(screen.getByLabelText('Use a passkey from')).toBeDisabled()
  })

  it('sends the recorded key on every retry, across a cancelled passkey in between', async () => {
    await reachUnknown()
    mockGetPasskeyAssertion.mockRejectedValueOnce(new PasskeyCancelledError())
    await submit() // cancelled: nothing sent
    createAccount.mockRejectedValueOnce(BAD_GATEWAY())
    await submit() // unknown again
    createAccount.mockResolvedValueOnce(CREATED)
    await submit() // 201

    expect(createAccount).toHaveBeenCalledTimes(3)
    const [first, second, third] = sentKeys()
    expect(second).toBe(first)
    expect(third).toBe(first)
    for (const call of createAccount.mock.calls) {
      expect(call[0]).toMatchObject({ name: 'Reserve', chain_id: 84532, source_account_id: 'main1' })
    }
    expect(await screen.findByTestId('new-account-created')).toBeInTheDocument()
  })

  it('keeps the source pinned when the default it came from changes', async () => {
    createAccount.mockRejectedValueOnce(BAD_GATEWAY())
    mockUseAccounts.mockReturnValue({ accounts: [MAIN, OTHER], createAccount, refreshAccounts })
    mockUseUserSigners.mockReturnValue({ signers: SHARED_SIGNERS, loadError: false, reload: reloadSigners })
    const { rerender } = render(<NewAccountDialog open onClose={vi.fn()} />)
    typeName('Reserve')
    await submit()
    // The caller now scopes the dialog to the other account.
    rerender(<NewAccountDialog open onClose={vi.fn()} preferredSourceAccountId="other1" />)
    createAccount.mockResolvedValueOnce(CREATED)
    await submit()
    expect(createAccount.mock.calls.map((c) => c[0].source_account_id)).toEqual(['main1', 'main1'])
  })

  it('says so and disables Try again once the pinned source is no longer a source', async () => {
    createAccount.mockRejectedValueOnce(BAD_GATEWAY())
    mockUseAccounts.mockReturnValue({ accounts: [MAIN, OTHER], createAccount, refreshAccounts })
    mockUseUserSigners.mockReturnValue({ signers: SHARED_SIGNERS, loadError: false, reload: reloadSigners })
    const { rerender } = render(<NewAccountDialog open onClose={vi.fn()} />)
    typeName('Reserve')
    await submit()
    // main1 lost its passkey; other1 still has one. No fallback to it.
    mockUseUserSigners.mockReturnValue({
      signers: [{ kind: 'passkey', key_id: KEY_A, created_at: null, accounts: [approved(OTHER)] }],
      loadError: false,
      reload: reloadSigners,
    })
    rerender(<NewAccountDialog open onClose={vi.fn()} />)

    expect(screen.getByTestId('new-account-unknown')).toHaveTextContent(
      'Operating can no longer secure a new account, so Haven can’t try again from here. Check again to see whether the account was created anyway.',
    )
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    // The network stays the record's, not the first option.
    expect(screen.getByLabelText('Network')).toHaveValue('84532')
    await submit()
    expect(createAccount).toHaveBeenCalledTimes(1)
    expect(mockGetPasskeyAssertion).toHaveBeenCalledTimes(1)
  })

  it('sends the record’s network on a retry even after the deployable chains change', async () => {
    createAccount.mockRejectedValueOnce(BAD_GATEWAY())
    mockUseAccounts.mockReturnValue({ accounts: [MAIN, OTHER], createAccount, refreshAccounts })
    mockUseUserSigners.mockReturnValue({ signers: SHARED_SIGNERS, loadError: false, reload: reloadSigners })
    const { rerender } = render(<NewAccountDialog open onClose={vi.fn()} />)
    typeName('Reserve')
    await submit()
    expect(createAccount.mock.calls[0]![0].chain_id).toBe(84532)

    // `/chains` answers late and narrows the list: Base Sepolia is gone.
    mockChains.current = [{ chainId: 8453, name: 'Base' }]
    rerender(<NewAccountDialog open onClose={vi.fn()} />)
    // The locked field still shows the network the retry will send.
    expect(screen.getByLabelText('Network')).toHaveValue('84532')
    createAccount.mockResolvedValueOnce(CREATED)
    await submit()
    expect(createAccount.mock.calls[1]![0]).toMatchObject({ chain_id: 84532, idempotency_key: createAccount.mock.calls[0]![0].idempotency_key })
  })

  it('mints a fresh key for a new submission when nothing is unknown', async () => {
    createAccount.mockRejectedValueOnce(new ApiRequestError('x', 422, { error: 'x', error_code: 'SOURCE_HAS_NO_PASSKEY' }))
    setup()
    typeName('Reserve')
    await submit()
    expect(unknownShown()).toBe(false)
    await submit()
    const [first, second] = sentKeys()
    expect(second).not.toBe(first)
  })

  describe('survives every kind of refusal on a retry, with that refusal shown beside it', () => {
    const cases: Array<[string, () => unknown, RegExp]> = [
      ['a coded cap', () => new ApiRequestError('x', 422, { error: 'x', error_code: 'ACCOUNT_CAP_REACHED', cap: 10 }), /You already have 10 accounts/],
      ['a code-less 422 cap sentence', () => new ApiRequestError('x', 422, { error: 'This user already has 10 accounts on chain 84532' }), /Details: This user already has 10 accounts on chain 84532/],
      ['a code-less 404', () => new ApiRequestError('x', 404, { error: 'Source account not found' }), /Details: Source account not found/],
      ['a coded key refusal', () => new ApiRequestError('x', 422, { error: 'x', error_code: 'KEY_NOT_ON_SOURCE' }), /That passkey isn’t one of Operating’s/],
      ['a code-less 409', () => new ApiRequestError('x', 409, { error: 'Account already registered' }), /Details: Account already registered/],
      ['a 429', () => new ApiRequestError('x', 429, { error: 'Too Many Requests' }), /Too many attempts in a short time/],
    ]
    for (const [label, refusal, message] of cases) {
      it(label, async () => {
        await reachUnknown()
        createAccount.mockRejectedValueOnce(refusal())
        await submit()
        expect(createAccount).toHaveBeenCalledTimes(2)
        expect(unknownShown()).toBe(true)
        expect(screen.getByText(message)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
      })
    }
  })

  it('survives a cancelled passkey prompt, which shows no message of its own', async () => {
    await reachUnknown()
    mockGetPasskeyAssertion.mockRejectedValueOnce(new PasskeyCancelledError())
    await submit()
    expect(unknownShown()).toBe(true)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('survives a passkey read failure and the client key check', async () => {
    await reachUnknown()
    mockGetPasskeyAssertion.mockRejectedValueOnce(new Error('WebAuthn assertion returned an unexpected response.'))
    await submit()
    expect(unknownShown()).toBe(true)
    expect(screen.getByText('Your passkey couldn’t be read. Try again.')).toBeInTheDocument()

    assertsWith(CRED_B)
    await submit()
    expect(unknownShown()).toBe(true)
    expect(screen.getByText(/That passkey isn’t one of Operating’s/)).toBeInTheDocument()
  })

  it('clears on a 201', async () => {
    await reachUnknown()
    createAccount.mockResolvedValueOnce(CREATED)
    await submit()
    expect(await screen.findByTestId('new-account-created')).toHaveTextContent('Reserve was created on Base Sepolia')
  })

  it('clears on detection: Check again finds the account by name on the chain', async () => {
    await reachUnknown()
    nextReadReturns([MAIN, OTHER, account('created1', 'Reserve', 84532)])
    await checkAgain()
    const done = await screen.findByTestId('new-account-created')
    expect(within(done).getByText('Reserve was created on Base Sepolia')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open account' })).toHaveAttribute('href', '/accounts/created1')
  })

  it('is not resolved by accounts already there, another name, or another chain', async () => {
    await reachUnknown()
    nextReadReturns([
      { ...MAIN, name: 'Reserve' }, // in the baseline
      OTHER,
      account('savings1', 'Savings', 84532), // new, another name
      account('elsewhere1', 'Reserve', 8453), // new, another chain
    ])
    await checkAgain()
    expect(screen.queryByTestId('new-account-created')).toBeNull()
    expect(unknownShown()).toBe(true)
    expect(screen.getByTestId('new-account-check')).toHaveTextContent('No new account named Reserve on Base Sepolia yet.')
  })

  it('reports a failed re-read as a failed read, never as "No new account"', async () => {
    await reachUnknown()
    refreshAccounts.mockResolvedValueOnce(false)
    await checkAgain()
    const status = screen.getByTestId('new-account-check')
    expect(status).toHaveTextContent('Couldn’t read your accounts just now. Check again in a moment.')
    expect(status).not.toHaveTextContent('No new account')
    expect(unknownShown()).toBe(true)
  })

  it('does not detect while an attempt is in flight: the attempt answers first', async () => {
    createAccount.mockRejectedValueOnce(BAD_GATEWAY())
    mockUseAccounts.mockReturnValue({ accounts: [MAIN, OTHER], createAccount, refreshAccounts })
    mockUseUserSigners.mockReturnValue({ signers: SHARED_SIGNERS, loadError: false, reload: reloadSigners })
    const { rerender } = render(<NewAccountDialog open onClose={vi.fn()} />)
    typeName('Reserve')
    await submit()

    let finishCreate!: (err: unknown) => void
    createAccount.mockReturnValueOnce(new Promise((_, reject) => (finishCreate = reject)))
    await submit() // the retry waits on the create call
    // Something else refreshes the session meanwhile, and the account is in it.
    mockUseAccounts.mockReturnValue({
      accounts: [MAIN, OTHER, account('created1', 'Reserve', 84532)],
      createAccount,
      refreshAccounts,
    })
    rerender(<NewAccountDialog open onClose={vi.fn()} />)
    expect(screen.queryByTestId('new-account-created')).toBeNull()
    expect(screen.getByRole('button', { name: 'Setting up your account…' })).toBeDisabled()

    await act(async () => {
      finishCreate(BAD_GATEWAY())
    })
    expect(screen.getByTestId('new-account-created')).toHaveTextContent('Reserve was created on Base Sepolia')
  })

  it('disables Try again while a check is in flight', async () => {
    await reachUnknown()
    let finishRead!: (ok: boolean) => void
    refreshAccounts.mockReturnValueOnce(new Promise<boolean>((resolve) => (finishRead = resolve)))
    await checkAgain()
    expect(screen.getByTestId('new-account-check')).toHaveTextContent('Checking your accounts…')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled()
    await act(async () => {
      finishRead(true)
    })
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('disables Check again while an attempt is in flight', async () => {
    await reachUnknown()
    mockGetPasskeyAssertion.mockReturnValueOnce(new Promise(() => undefined))
    await submit()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled()
  })

  it('Close drops the record: reopened, the dialog starts clean', async () => {
    createAccount.mockRejectedValueOnce(BAD_GATEWAY())
    mockUseAccounts.mockReturnValue({ accounts: [MAIN, OTHER], createAccount, refreshAccounts })
    mockUseUserSigners.mockReturnValue({ signers: SHARED_SIGNERS, loadError: false, reload: reloadSigners })
    const onClose = vi.fn()
    const { rerender } = render(<NewAccountDialog open onClose={onClose} />)
    typeName('Reserve')
    await submit()
    expect(unknownShown()).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(<NewAccountDialog open={false} onClose={onClose} />)
    rerender(<NewAccountDialog open onClose={onClose} />)

    expect(unknownShown()).toBe(false)
    expect(screen.getByLabelText('Account name')).toBeEnabled()
    expect(screen.getByLabelText('Account name')).toHaveValue('')
    typeName('Reserve')
    createAccount.mockResolvedValueOnce(CREATED)
    await submit()
    const [first, afterReopen] = sentKeys()
    expect(afterReopen).not.toBe(first)
  })
})
