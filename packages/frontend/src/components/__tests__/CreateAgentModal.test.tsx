import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const {
  SAFE_ADDRESS,
  SECOND_SAFE_ADDRESS,
  DELEGATE_ADDRESS,
  SIGNER_ADDRESS,
  mockUseAuth,
  mockUsePublicClient,
  mockUseActiveSigner,
  mockUseSafeOperationGate,
  mockUseSafeDetails,
  mockApiPost,
  mockIsModuleEnabled,
  mockBuildAgentSetupTx,
  mockGetSafeNonce,
  mockSignSafeTx,
  mockExecuteSafeTx,
  mockProposeSafeTx,
  mockGetSafeTxHash,
} = vi.hoisted(() => ({
  SAFE_ADDRESS: '0x1111111111111111111111111111111111111111',
  SECOND_SAFE_ADDRESS: '0x4444444444444444444444444444444444444444',
  DELEGATE_ADDRESS: '0x2222222222222222222222222222222222222222',
  SIGNER_ADDRESS: '0x3333333333333333333333333333333333333333',
  mockUseAuth: vi.fn(),
  mockUsePublicClient: vi.fn(),
  mockUseActiveSigner: vi.fn(),
  mockUseSafeOperationGate: vi.fn(),
  mockUseSafeDetails: vi.fn(),
  mockApiPost: vi.fn(),
  mockIsModuleEnabled: vi.fn(),
  mockBuildAgentSetupTx: vi.fn(),
  mockGetSafeNonce: vi.fn(),
  mockSignSafeTx: vi.fn(),
  mockExecuteSafeTx: vi.fn(),
  mockProposeSafeTx: vi.fn(),
  mockGetSafeTxHash: vi.fn(),
}))

vi.mock('wagmi', () => ({
  usePublicClient: (args: unknown) => mockUsePublicClient(args),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: (safeAddress: string | null) => mockUseSafeDetails(safeAddress),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (args: unknown) => mockUseActiveSigner(args),
}))

vi.mock('@/hooks/useSafeOperationGate', () => ({
  useSafeOperationGate: (args: unknown) => mockUseSafeOperationGate(args),
}))

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => mockApiPost(...args),
  },
}))

vi.mock('@/lib/allowance-module', () => ({
  RESET_PERIODS: [
    { value: 1440, label: 'Daily' },
    { value: 10080, label: 'Weekly' },
  ],
  isModuleEnabled: (...args: unknown[]) => mockIsModuleEnabled(...args),
  buildAgentSetupTx: (...args: unknown[]) => mockBuildAgentSetupTx(...args),
}))

vi.mock('@/lib/safe-tx', () => ({
  getChainTokens: (chainId: number) =>
    chainId === 8453
      ? {
          ETH: {
            address: null,
            decimals: 18,
          },
          USDC: {
            address: '0x9999999999999999999999999999999999999999',
            decimals: 6,
          },
        }
      : {
          USDC: {
            address: '0x9999999999999999999999999999999999999999',
            decimals: 6,
          },
        },
  getSafeNonce: (...args: unknown[]) => mockGetSafeNonce(...args),
  signSafeTx: (...args: unknown[]) => mockSignSafeTx(...args),
  executeSafeTx: (...args: unknown[]) => mockExecuteSafeTx(...args),
  proposeSafeTx: (...args: unknown[]) => mockProposeSafeTx(...args),
  getSafeTxHash: (...args: unknown[]) => mockGetSafeTxHash(...args),
}))

vi.mock('@/hooks/useEscapeToClose', () => ({
  useEscapeToClose: vi.fn(),
}))

vi.mock('@/hooks/useFocusTrap', () => ({
  useFocusTrap: vi.fn(),
}))

vi.mock('@/components/NetworkGate', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/WalletButton', () => ({
  default: () => <button type="button">Connect wallet</button>,
}))

import CreateAgentModal from '@/components/CreateAgentModal'

const DEFAULT_SAFE = {
  id: 'safe-1',
  name: 'Operating wallet',
  safe_address: SAFE_ADDRESS,
  chain_id: 100,
  is_default: true,
  created_at: '2026-01-01T00:00:00.000Z',
}

const SECOND_SAFE = {
  id: 'safe-2',
  name: 'Base wallet',
  safe_address: SECOND_SAFE_ADDRESS,
  chain_id: 8453,
  is_default: false,
  created_at: '2026-01-02T00:00:00.000Z',
}

function setAuthSafes(safes = [DEFAULT_SAFE], activeSafe = safes[0]) {
  mockUseAuth.mockReturnValue({
    user: {
      safes,
    },
    activeSafe,
  })
}

function renderModal({
  onCreated = vi.fn(),
  onClose = vi.fn(),
  safeAddress = SAFE_ADDRESS,
  safeId = 'safe-1',
}: {
  onCreated?: ReturnType<typeof vi.fn>
  onClose?: ReturnType<typeof vi.fn>
  safeAddress?: string
  safeId?: string | null
} = {}) {
  render(
    <CreateAgentModal
      open
      onClose={onClose}
      safeAddress={safeAddress}
      safeId={safeId}
      onCreated={onCreated}
    />,
  )
}

async function fillAgentRules() {
  await startBudgetStep()

  fireEvent.change(screen.getByPlaceholderText('Amount'), {
    target: { value: '10' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review agent rules' }))
}

async function startBudgetStep() {
  fireEvent.change(screen.getByPlaceholderText('e.g. Research Agent'), {
    target: { value: 'Research Agent' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
  expect(await screen.findByText('Add at least one agent budget to continue')).toBeInTheDocument()
}

async function completeGeneratedCredentialReviewStep() {
  await fillAgentRules()

  expect(await screen.findByText('Review agent rules')).toBeInTheDocument()
}

describe('CreateAgentModal recovery', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let clipboardWriteText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    clipboardWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWriteText,
      },
    })
    mockUsePublicClient.mockReturnValue({})
    setAuthSafes()
    mockUseActiveSigner.mockReturnValue({
      type: 'eoa',
      address: SIGNER_ADDRESS as Address,
      walletClient: {},
    })
    mockUseSafeOperationGate.mockReturnValue({ kind: 'ready' })
    mockUseSafeDetails.mockReturnValue({
      details: {
        address: SAFE_ADDRESS,
        threshold: 1,
        owners: [SIGNER_ADDRESS],
        nonce: 1,
      },
    })
    mockIsModuleEnabled.mockResolvedValue(false)
    mockBuildAgentSetupTx.mockReturnValue({ to: SAFE_ADDRESS, data: '0x' })
    mockGetSafeNonce.mockResolvedValue(1n)
    mockSignSafeTx.mockResolvedValue('0xsig')
    mockExecuteSafeTx.mockResolvedValue({ txHash: '0xhash' })
    mockProposeSafeTx.mockResolvedValue(undefined)
    mockGetSafeTxHash.mockReturnValue('0xsafetx')
    mockApiPost.mockResolvedValue({
      id: 'agent-1',
      name: 'Research Agent',
      api_key: 'sk_test',
      delegate_address: DELEGATE_ADDRESS,
    })
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('preserves wallet success and retries only the Haven save when backend save fails', async () => {
    const onCreated = vi.fn()
    mockApiPost
      .mockRejectedValueOnce(new Error('Backend unavailable'))
      .mockResolvedValueOnce({
        id: 'agent-1',
        name: 'Research Agent',
        api_key: 'sk_test',
        delegate_address: DELEGATE_ADDRESS,
      })

    renderModal({ onCreated })
    await completeGeneratedCredentialReviewStep()

    fireEvent.click(screen.getByRole('button', { name: 'Connect agent' }))

    expect(await screen.findByText('Finish saving this agent')).toBeInTheDocument()
    expect(screen.getByText(/agent rules were created in your Haven wallet/i)).toBeInTheDocument()
    expect(screen.getByText('Backend unavailable')).toBeInTheDocument()
    expect(mockExecuteSafeTx).toHaveBeenCalledTimes(1)
    expect(mockApiPost).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Finish saving' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Your agent is ready')).toBeInTheDocument()
    expect(mockExecuteSafeTx).toHaveBeenCalledTimes(1)
    expect(mockApiPost).toHaveBeenCalledTimes(2)
  })

  it('shows the hosted-MCP connect card and unlocks Done when the signing key is saved', async () => {
    const onCreated = vi.fn()
    const onClose = vi.fn()

    renderModal({ onCreated, onClose })
    await completeGeneratedCredentialReviewStep()

    fireEvent.click(screen.getByRole('button', { name: 'Connect agent' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Your agent is ready')).toBeInTheDocument()

    // The new hosted Connect card is the primary post-creation surface (#187).
    // Tile accessible name is "<label><tagline>" concatenated — anchor on the
    // label since no registry entry's label is a prefix of another's.
    expect(screen.getByRole('tab', { name: /^Claude Code/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Claude Desktop/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Cursor/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Other \/ SDK/ })).toBeInTheDocument()

    // The backup credential download is now demoted to a backup line.
    expect(screen.getByRole('button', { name: 'Download backup' })).toBeInTheDocument()
    expect(screen.getByText(/credentials are shown once/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled()

    // The two-credential split stays hidden until a client is picked.
    expect(screen.queryByRole('button', { name: /Save signing key/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /^Claude Code/ }))

    // Copying the connect snippet flips the close-without-saving gate. The
    // Save-signing-key path also flips it, exercised in HostedConnectCard.test.tsx.
    fireEvent.click(screen.getAllByRole('button', { name: /^Copy$/i })[0])
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1))
    expect(clipboardWriteText).toHaveBeenCalledWith(expect.stringContaining('sk_test'))
    expect(screen.getByRole('button', { name: 'Done' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preserves the developer guide as an advanced disclosure', async () => {
    renderModal()
    await completeGeneratedCredentialReviewStep()
    fireEvent.click(screen.getByRole('button', { name: 'Connect agent' }))
    expect(await screen.findByText('Your agent is ready')).toBeInTheDocument()

    // The Markdown developer guide is no longer the primary download but it
    // must still be reachable for SDK users.
    fireEvent.click(screen.getByText(/Advanced — developer guide/))
    expect(screen.getByRole('button', { name: 'Open developer guide' })).toBeInTheDocument()
    // The redundant "Copy raw credential JSON" action has been removed —
    // the inline tile copy and the Download credentials button cover it.
    expect(screen.queryByRole('button', { name: /Copy raw credential/i })).not.toBeInTheDocument()
  })

  it('skips wallet selection for one account and uses a 3-step counter', async () => {
    renderModal()

    expect(screen.getByLabelText('Step 1 of 3')).toBeInTheDocument()
    expect(screen.queryByText('Choose the Haven wallet this agent can spend from')).not.toBeInTheDocument()

    await startBudgetStep()

    expect(screen.getByLabelText('Step 2 of 3')).toBeInTheDocument()
    expect(screen.queryByText('Operating wallet')).not.toBeInTheDocument()
  })

  it('shows wallet selection for multiple accounts and uses a 4-step counter', async () => {
    setAuthSafes([DEFAULT_SAFE, SECOND_SAFE], DEFAULT_SAFE)
    renderModal()

    expect(screen.getByLabelText('Step 1 of 4')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('e.g. Research Agent'), {
      target: { value: 'Research Agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))

    expect(await screen.findByText('Choose the Haven wallet this agent can spend from')).toBeInTheDocument()
    expect(screen.getByLabelText('Step 2 of 4')).toBeInTheDocument()

    const walletSelect = screen.getByLabelText('Haven wallet')
    expect(walletSelect).toHaveTextContent('Operating wallet')
    expect(walletSelect).toHaveTextContent('Base wallet')
    expect(walletSelect).not.toHaveTextContent('0x1111')
    expect(walletSelect).not.toHaveTextContent('Gnosis Chain')
  })

  it('uses the selected wallet for budget tokens and review summary', async () => {
    setAuthSafes([DEFAULT_SAFE, SECOND_SAFE], DEFAULT_SAFE)
    renderModal()

    fireEvent.change(screen.getByPlaceholderText('e.g. Research Agent'), {
      target: { value: 'Research Agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))

    fireEvent.change(await screen.findByLabelText('Haven wallet'), {
      target: { value: 'safe-2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))

    expect(await screen.findByText('Add at least one agent budget to continue')).toBeInTheDocument()
    expect(screen.queryByText('Base wallet')).not.toBeInTheDocument()
    expect(screen.queryByText('Base')).not.toBeInTheDocument()

    const [tokenSelect] = screen.getAllByRole('combobox')
    expect(tokenSelect).toHaveTextContent('ETH')
    fireEvent.change(tokenSelect, {
      target: { value: 'ETH' },
    })
    fireEvent.change(screen.getByPlaceholderText('Amount'), {
      target: { value: '1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    expect(screen.getByText('1 ETH per day')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Review agent rules' }))

    expect(await screen.findByText('Base wallet on Base')).toBeInTheDocument()
    expect(screen.getByText('1 ETH per day')).toBeInTheDocument()
    expect(mockUseSafeDetails).toHaveBeenLastCalledWith(SECOND_SAFE_ADDRESS)
  })

  it('validates budget amounts before allowing review', async () => {
    renderModal()
    await startBudgetStep()

    expect(screen.getByRole('button', { name: 'Review agent rules' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add budget' })).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('Amount'), {
      target: { value: '0' },
    })

    expect(await screen.findByText('Enter an amount greater than 0')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add budget' })).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('Amount'), {
      target: { value: '1.1234567' },
    })

    expect(await screen.findByText('USDC supports up to 6 decimal places')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add budget' })).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('Amount'), {
      target: { value: '.5' },
    })

    expect(screen.queryByText('Enter an amount greater than 0')).not.toBeInTheDocument()
    expect(screen.queryByText('USDC supports up to 6 decimal places')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add budget' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))

    expect(screen.getByText('0.5 USDC per day')).toBeInTheDocument()
    expect(screen.queryByText('From wallet')).not.toBeInTheDocument()
    expect(screen.queryByText('Manual above budget')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review agent rules' })).not.toBeDisabled()
  })

  it('removes credential input from review and posts a generated delegate address', async () => {
    renderModal()
    await completeGeneratedCredentialReviewStep()

    expect(screen.queryByText('Credential')).not.toBeInTheDocument()
    expect(screen.queryByText('Use an existing credential address instead')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Connect agent' }))

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledTimes(1))
    expect(mockApiPost).toHaveBeenCalledWith(
      '/agents',
      expect.objectContaining({
        delegate_address: expect.stringMatching(/^0x[a-fA-F0-9]{40}$/),
      }),
    )
  })
})
