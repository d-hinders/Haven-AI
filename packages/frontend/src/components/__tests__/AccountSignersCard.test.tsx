import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseSigners } = vi.hoisted(() => ({ mockUseSigners: vi.fn() }))

vi.mock('@/hooks/useAccountSigners', () => ({ useAccountSigners: (...a: unknown[]) => mockUseSigners(...a) }))
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }),
}))

const AccountSignersCard = (await import('../AccountSignersCard')).default

const PROPS = { agentId: 'a1', chainId: 84532, userEmail: 'x@y.z' }

function base(overrides: Record<string, unknown> = {}) {
  return {
    signers: {
      account_address: '0x' + 'aa'.repeat(20),
      chain_id: 84532,
      owner_address: null,
      passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
    },
    busy: false,
    ready: true,
    enrollBackupPasskey: vi.fn().mockResolvedValue({ ok: true }),
    enrollOwnerWallet: vi.fn().mockResolvedValue({ ok: true }),
    removePasskey: vi.fn().mockResolvedValue({ ok: true }),
    reload: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => mockUseSigners.mockReset())

describe('AccountSignersCard (#888)', () => {
  it('warns when there is only one way to approve, and Remove is disabled there', async () => {
    mockUseSigners.mockReturnValue(base())
    render(<AccountSignersCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/only one way to approve/)).toBeTruthy())
    expect((screen.getByText('Remove') as HTMLButtonElement).disabled).toBe(true)
  })

  it('enrolls a backup passkey via one Face ID action', async () => {
    const enrollBackupPasskey = vi.fn().mockResolvedValue({ ok: true })
    mockUseSigners.mockReturnValue(base({ enrollBackupPasskey }))
    render(<AccountSignersCard {...PROPS} />)
    fireEvent.click(screen.getByText(/Add a backup with Face ID/))
    await waitFor(() => expect(enrollBackupPasskey).toHaveBeenCalled())
  })

  it('with two ways, Remove is enabled and calls removePasskey with the key id', async () => {
    const removePasskey = vi.fn().mockResolvedValue({ ok: true })
    mockUseSigners.mockReturnValue(
      base({
        removePasskey,
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    const remove = screen.getByText('Remove') as HTMLButtonElement
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)
    await waitFor(() => expect(removePasskey).toHaveBeenCalledWith('0x' + '11'.repeat(32)))
  })

  it('renders nothing while signers are loading (null)', () => {
    mockUseSigners.mockReturnValue(base({ signers: null }))
    const { container } = render(<AccountSignersCard {...PROPS} />)
    expect(container.textContent).toBe('')
  })

  it('copy is outcome language — no signer/passkey/addKey jargon leads', () => {
    mockUseSigners.mockReturnValue(base({ signers: { account_address: '0x' + 'aa'.repeat(20), chain_id: 84532, owner_address: '0x' + 'ee'.repeat(20), passkeys: [] } }))
    render(<AccountSignersCard {...PROPS} />)
    expect(document.body.textContent).not.toMatch(/addKey|removeKey|EOA|delegation|caveat/i)
  })
})
