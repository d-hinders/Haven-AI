import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toHex } from 'viem'

const { mockUseAccounts, mockUseUserSigners, mockGetPasskeyAssertion, mockCreatePasskey } = vi.hoisted(() => ({
  mockUseAccounts: vi.fn(),
  mockUseUserSigners: vi.fn(),
  mockGetPasskeyAssertion: vi.fn(),
  mockCreatePasskey: vi.fn(),
}))

vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => mockUseAccounts() }))
vi.mock('@/hooks/useUserSigners', () => ({ useUserSigners: () => mockUseUserSigners() }))
vi.mock('@/hooks/useDeployableChains', () => ({
  useDeployableChains: () => ({
    chains: [
      { chainId: 8453, name: 'Base' },
      { chainId: 84532, name: 'Base Sepolia' },
    ],
    loading: false,
  }),
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

let createAccount: ReturnType<typeof vi.fn>
let reloadSigners: ReturnType<typeof vi.fn>

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
  mockUseAccounts.mockReturnValue({ accounts, createAccount })
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
    fireEvent.click(screen.getByRole('button', { name: 'Create account with a passkey' }))
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
  createAccount = vi.fn().mockResolvedValue(CREATED)
  reloadSigners = vi.fn()
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
    expect(within(done).getByText('Reserve is ready on Base Sepolia')).toBeInTheDocument()
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

  it('shows the generic failure for anything else', async () => {
    const alert = await refusedWith(502, { error: 'Could not derive the account address' })
    expect(alert).toHaveTextContent('Haven couldn’t create the account. Try again: a retry won’t create a second one.')
  })

  it('clears a refusal once the inputs it described change', async () => {
    const alert = await refusedWith(422, { error: 'x', error_code: 'ACCOUNT_CAP_REACHED', cap: 10 })
    expect(alert).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Network'), { target: { value: '8453' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('NewAccountDialog — the idempotency key', () => {
  it('reuses the key when the same submission is retried, and mints a new one when it changes', async () => {
    createAccount.mockRejectedValueOnce(new ApiRequestError('Bad gateway', 502, { error: 'Bad gateway' }))
    createAccount.mockRejectedValueOnce(new ApiRequestError('Bad gateway', 502, { error: 'Bad gateway' }))
    setup()
    typeName('Reserve')
    await submit()
    await submit()
    const [first, retry] = createAccount.mock.calls.map((c) => c[0].idempotency_key)
    expect(retry).toBe(first)

    typeName('Savings')
    await submit()
    const changed = createAccount.mock.calls[2]![0].idempotency_key
    expect(changed).not.toBe(first)
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
    mockUseAccounts.mockReturnValue({ accounts: [MAIN], createAccount })
    mockUseUserSigners.mockReturnValue({ signers: SHARED_SIGNERS, loadError: false, reload: reloadSigners })
    render(<NewAccountDialog open={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    // Mounted only while open: the signer read does not run behind a closed dialog.
    expect(mockUseUserSigners).not.toHaveBeenCalled()
  })
})
