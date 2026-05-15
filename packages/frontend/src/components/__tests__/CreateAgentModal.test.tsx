import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const {
  SAFE_ADDRESS,
  DELEGATE_ADDRESS,
  SIGNER_ADDRESS,
  mockUsePublicClient,
  mockUseActiveSigner,
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
  DELEGATE_ADDRESS: '0x2222222222222222222222222222222222222222',
  SIGNER_ADDRESS: '0x3333333333333333333333333333333333333333',
  mockUsePublicClient: vi.fn(),
  mockUseActiveSigner: vi.fn(),
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
  useAuth: () => ({
    user: {
      safes: [
        {
          id: 'safe-1',
          name: 'Operating wallet',
          safe_address: SAFE_ADDRESS,
          chain_id: 100,
          is_default: true,
        },
      ],
    },
    activeSafe: {
      id: 'safe-1',
      name: 'Operating wallet',
      safe_address: SAFE_ADDRESS,
      chain_id: 100,
      is_default: true,
    },
  }),
}))

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: (safeAddress: string | null) => mockUseSafeDetails(safeAddress),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (args: unknown) => mockUseActiveSigner(args),
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
  getChainTokens: () => ({
    USDC: {
      address: '0x9999999999999999999999999999999999999999',
      decimals: 6,
    },
  }),
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

function renderModal(onCreated = vi.fn()) {
  render(
    <CreateAgentModal
      open
      onClose={vi.fn()}
      safeAddress={SAFE_ADDRESS}
      safeId="safe-1"
      onCreated={onCreated}
    />,
  )
}

async function completeReviewStep() {
  fireEvent.change(screen.getByPlaceholderText('e.g. Research Agent'), {
    target: { value: 'Research Agent' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))

  fireEvent.change(screen.getByPlaceholderText('Amount'), {
    target: { value: '10' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review credential' }))

  fireEvent.click(screen.getByRole('button', { name: 'Use an existing credential address instead' }))
  fireEvent.change(screen.getByPlaceholderText('0x...'), {
    target: { value: DELEGATE_ADDRESS },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review agent rules' }))

  expect(await screen.findByText('Review agent rules')).toBeInTheDocument()
}

describe('CreateAgentModal recovery', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockUsePublicClient.mockReturnValue({})
    mockUseActiveSigner.mockReturnValue({
      type: 'eoa',
      address: SIGNER_ADDRESS as Address,
      walletClient: {},
    })
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

    renderModal(onCreated)
    await completeReviewStep()

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
})
