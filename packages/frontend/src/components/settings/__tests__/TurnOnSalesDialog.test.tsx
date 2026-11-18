import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toHex } from 'viem'

const {
  mockUseMerchantServices,
  mockUseAccounts,
  mockUseUserSigners,
  mockGetPasskeyAssertion,
  mockChains,
} = vi.hoisted(() => ({
  mockUseMerchantServices: vi.fn(),
  mockUseAccounts: vi.fn(),
  mockUseUserSigners: vi.fn(),
  mockGetPasskeyAssertion: vi.fn(),
  mockChains: { current: [] as Array<{ chainId: number; name: string }> },
}))

vi.mock('@/hooks/useMerchantServices', () => ({ useMerchantServices: () => mockUseMerchantServices() }))
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
  }
})

import { LocaleProvider } from '@/context/LocaleContext'
import { MerchantServicesProvider } from '@/context/MerchantServicesContext'
import TurnOnSalesDialog from '@/components/settings/TurnOnSalesDialog'
import { base64UrlEncode, PasskeyCancelledError, PasskeyUnsupportedError } from '@/lib/passkey'
import { classifyTurnOnError } from '@/lib/merchant-services'
import { merchantServicesOff, merchantServicesOn } from '../../../../e2e/fixtures/haven-api'

const MAIN = {
  id: 'main1',
  account_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  name: 'Operating',
  is_default: true,
  created_at: '2026-06-01T00:00:00Z',
}

const RAW_A = new TextEncoder().encode('passkey-a')
const KEY_A = toHex(RAW_A)
const CRED_A = base64UrlEncode(RAW_A)

const SIGNERS = [
  {
    kind: 'passkey',
    key_id: KEY_A,
    created_at: null,
    accounts: [
      {
        account_id: MAIN.id,
        account_address: MAIN.account_address,
        account_name: MAIN.name,
        chain_id: MAIN.chain_id,
      },
    ],
  },
]

const SALES_ACCOUNT = merchantServicesOn.merchant_account!

let turnOn: ReturnType<typeof vi.fn>
let refreshAccounts: ReturnType<typeof vi.fn>

function serve({
  merchantAccount = null as typeof SALES_ACCOUNT | null,
  signers = SIGNERS as unknown[] | null,
  loadError = false,
} = {}) {
  mockUseMerchantServices.mockReturnValue({
    status: 'ready',
    state: merchantAccount ? merchantServicesOn : merchantServicesOff,
    enabled: merchantAccount !== null,
    merchantAccount,
    refresh: vi.fn(),
    turnOn,
    turnOff: vi.fn(),
  })
  mockUseAccounts.mockReturnValue({ accounts: [MAIN], refreshAccounts })
  mockUseUserSigners.mockReturnValue({ signers, loadError, reload: vi.fn() })
}

function renderDialog() {
  const onClose = vi.fn()
  render(
    <LocaleProvider>
      <MerchantServicesProvider>
        <TurnOnSalesDialog open onClose={onClose} />
      </MerchantServicesProvider>
    </LocaleProvider>,
  )
  return { onClose }
}

function assertsWith(credentialId: string) {
  mockGetPasskeyAssertion.mockResolvedValue({
    credentialId,
    signatureDER: '0x',
    authenticatorData: '0x',
    clientDataJSON: '0x',
  })
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Sales' }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockChains.current = [
    { chainId: 8453, name: 'Base' },
    { chainId: 84532, name: 'Base Sepolia' },
  ]
  turnOn = vi.fn().mockResolvedValue({ ok: true, state: { ...merchantServicesOn, created: true } })
  refreshAccounts = vi.fn().mockResolvedValue(true)
  assertsWith(CRED_A)
})

describe('TurnOnSalesDialog — the first turn-on (#4904)', () => {
  it('asks for the network, says it cannot change later, and has no name field', () => {
    serve()
    renderDialog()

    expect(screen.getByLabelText('Network')).toBeInTheDocument()
    expect(screen.getByText('The network cannot be changed later.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Account name')).not.toBeInTheDocument()
    expect(screen.getByText('The account is named Sales. You can rename it later.')).toBeInTheDocument()
  })

  it('runs ONE passkey assertion and sends the network, the source account and the key', async () => {
    serve()
    renderDialog()
    await submit()

    expect(mockGetPasskeyAssertion).toHaveBeenCalledTimes(1)
    expect(turnOn).toHaveBeenCalledWith({
      chain_id: 8453,
      source_account_id: MAIN.id,
      key_id: KEY_A,
    })
  })

  it('ends on the result state with the backup recommendation, which is never a gate', async () => {
    serve()
    renderDialog()
    await submit()

    expect(await screen.findByText('Sales is on')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Add a backup — a backup passkey or a wallet — so a lost device never means a lost account.',
      ),
    ).toBeInTheDocument()
    // The recommendation is a link, and the dialog's own actions work without it.
    expect(screen.getByRole('link', { name: /Add backup/ })).toHaveAttribute(
      'href',
      `/accounts/${SALES_ACCOUNT.id}`,
    )
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Sales account' })).toHaveAttribute(
      'href',
      `/accounts/${SALES_ACCOUNT.id}`,
    )
    // The account list is re-read so the new account shows behind the dialog.
    expect(refreshAccounts).toHaveBeenCalled()
  })

  it('a cancelled passkey prompt returns to the form with nothing to report', async () => {
    serve()
    renderDialog()
    mockGetPasskeyAssertion.mockRejectedValueOnce(new PasskeyCancelledError())
    await submit()

    expect(turnOn).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Network')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says so when this browser cannot use a passkey', async () => {
    serve()
    renderDialog()
    mockGetPasskeyAssertion.mockRejectedValueOnce(new PasskeyUnsupportedError())
    await submit()

    expect(turnOn).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        'This browser can’t use a passkey. Open Haven in Safari, Chrome, or Edge on the device that holds your passkey.',
      ),
    ).toBeInTheDocument()
  })
})

describe('TurnOnSalesDialog — turning Sales back on (#4904)', () => {
  it('shows no network choice and no passkey prompt, and sends an empty body', async () => {
    serve({ merchantAccount: SALES_ACCOUNT })
    renderDialog()

    expect(screen.queryByLabelText('Network')).not.toBeInTheDocument()
    expect(screen.getByText(/Sales is on Base\. The network cannot be changed later\./)).toBeInTheDocument()

    await submit()
    expect(mockGetPasskeyAssertion).not.toHaveBeenCalled()
    expect(turnOn).toHaveBeenCalledWith({})
    expect(await screen.findByText('Sales is on')).toBeInTheDocument()
  })
})

describe('TurnOnSalesDialog — every refusal says what to do, and never shows a code (#4904)', () => {
  const cases: Array<[string, number, Record<string, unknown>, string]> = [
    [
      'no such account',
      404,
      { error_code: 'SOURCE_ACCOUNT_NOT_FOUND' },
      'Haven couldn’t find the account this passkey belongs to. Reload the page and try again.',
    ],
    [
      'no passkey on the existing account',
      422,
      { error_code: 'SOURCE_HAS_NO_PASSKEY' },
      'That account no longer has a passkey, so it can’t secure Sales. Reload the page to see your accounts as they are now.',
    ],
    [
      'passkey not on that account',
      422,
      { error_code: 'KEY_NOT_ON_SOURCE' },
      'That passkey isn’t one of that account’s. Try again and pick a passkey saved for it.',
    ],
    [
      'account limit reached',
      422,
      { error_code: 'ACCOUNT_CAP_REACHED', cap: 10 },
      'You already have 10 accounts on Base, the most Haven allows on one network. Choose another network, or remove an account you no longer use from its page.',
    ],
    [
      'unsupported network',
      400,
      { error_code: 'UNSUPPORTED_NETWORK', supported: [84532] },
      'Sales is not available on that network yet. Choose Base Sepolia.',
    ],
    [
      'merchant account already on another network',
      409,
      { error_code: 'MERCHANT_ACCOUNT_ON_OTHER_NETWORK', chain_id: 84532 },
      'Sales is already on Base Sepolia. The network cannot be changed later.',
    ],
  ]

  for (const [label, status, body, sentence] of cases) {
    it(label, async () => {
      serve()
      renderDialog()
      // The hook resolves a typed refusal (it never rejects); the dialog renders
      // it. The code→kind mapping itself is pinned in
      // `lib/__tests__/merchant-services.test.ts`.
      turnOn.mockResolvedValueOnce({
        ok: false,
        refusal: classifyTurnOnError(Object.assign(new Error('refused'), { status, body })),
      })
      await submit()

      expect(await screen.findByText(sentence)).toBeInTheDocument()
      // No raw error code is ever shown.
      expect(screen.queryByText(/[A-Z_]{8,}/)).not.toBeInTheDocument()
      // The form is still there, so the user can act on the advice.
      expect(screen.getByLabelText('Network')).toBeInTheDocument()
    })
  }

  it('a repeat is not an error: the result state, not a refusal', async () => {
    serve()
    renderDialog()
    turnOn.mockResolvedValueOnce({ ok: true, state: { ...merchantServicesOn, created: false } })
    await submit()

    expect(await screen.findByText('Sales is on')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('TurnOnSalesDialog — no passkey anywhere (#4904)', () => {
  it('explains the way forward instead of offering a form', () => {
    serve({ signers: [] })
    renderDialog()

    expect(screen.getByText('Sales needs a passkey')).toBeInTheDocument()
    expect(screen.queryByLabelText('Network')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Sales account' })).toHaveAttribute(
      'href',
      `/accounts/${MAIN.id}`,
    )
  })

  it('a failed signer read offers a retry', () => {
    serve({ signers: null, loadError: true })
    renderDialog()

    expect(
      screen.getByText('Couldn’t load your passkeys, so Haven can’t tell which account can secure Sales.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
