import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseSigners } = vi.hoisted(() => ({ mockUseSigners: vi.fn() }))

vi.mock('@/hooks/useAccountSigners', () => ({ useAccountSigners: (...a: unknown[]) => mockUseSigners(...a) }))
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }),
}))

const AccountSignersCard = (await import('../AccountSignersCard')).default

const PROPS = { safeAddress: '0x' + 'aa'.repeat(20), chainId: 84532, userEmail: 'x@y.z' }

function base(overrides: Record<string, unknown> = {}) {
  return {
    signers: {
      account_address: '0x' + 'aa'.repeat(20),
      chain_id: 84532,
      owner_address: null,
      passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
    },
    loadError: false,
    busy: false,
    ready: true,
    enrollBackupPasskey: vi.fn().mockResolvedValue({ ok: true }),
    enrollOwnerWallet: vi.fn().mockResolvedValue({ ok: true }),
    removePasskey: vi.fn().mockResolvedValue({ ok: true }),
    removeOwner: vi.fn().mockResolvedValue({ ok: true }),
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
    // Owner row renders first (#1087 added its Remove); the passkey row's is second.
    const removes = screen.getAllByText('Remove') as HTMLButtonElement[]
    const remove = removes[1]
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)
    await waitFor(() => expect(removePasskey).toHaveBeenCalledWith('0x' + '11'.repeat(32)))
  })

  it('the wallet owner can be removed when a passkey remains (#1087)', async () => {
    const removeOwner = vi.fn().mockResolvedValue({ ok: true })
    mockUseSigners.mockReturnValue(
      base({
        removeOwner,
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    // Recovery-accurate copy on the row:
    expect(screen.getByText(/passkeys become the only ways to approve/)).toBeTruthy()
    const [ownerRemove] = screen.getAllByText('Remove') as HTMLButtonElement[]
    expect(ownerRemove.disabled).toBe(false)
    fireEvent.click(ownerRemove)
    await waitFor(() => expect(removeOwner).toHaveBeenCalled())
  })

  it('the wallet owner cannot be removed when it is the only way to approve', async () => {
    mockUseSigners.mockReturnValue(
      base({
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    const [ownerRemove] = screen.getAllByText('Remove') as HTMLButtonElement[]
    expect(ownerRemove.disabled).toBe(true)
  })

  it('surfaces the honest "Lost a device?" recovery explainer behind a help modal', async () => {
    mockUseSigners.mockReturnValue(base())
    render(<AccountSignersCard {...PROPS} />)
    // Not shown until the help affordance is opened — no raw <details> left in the DOM.
    expect(document.querySelector('details')).toBeNull()
    expect(screen.queryByText(/Haven can.t do this for you/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Lost a device\?/ }))

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/Haven can.t do this for you/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'How recovery works' }).getAttribute('href')).toContain('/product/account-recovery')

    // Every other Modal in the app has a visible close affordance — this one
    // must too, not just backdrop-click/Escape.
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders nothing while signers are loading (null)', () => {
    mockUseSigners.mockReturnValue(base({ signers: null }))
    const { container } = render(<AccountSignersCard {...PROPS} />)
    expect(container.textContent).toBe('')
  })

  it('shows a retry affordance when the signer set fails to load', async () => {
    const reload = vi.fn()
    mockUseSigners.mockReturnValue(base({ signers: null, loadError: true, reload }))
    render(<AccountSignersCard {...PROPS} />)
    expect(screen.getByText(/could not load/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reload).toHaveBeenCalled()
  })

  it('names the real not-ready blocker: owner wallet for an EOA-backed account', () => {
    mockUseSigners.mockReturnValue(
      base({
        ready: false,
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    expect(screen.getByText(/Connect your account owner wallet/)).toBeTruthy()
  })

  // #1097: the passkey optimistic fallback keeps `ready` true, so cross-device
  // is a HINT next to a working action, never a blocker.
  it('shows the cross-device hint when ready but no passkey is on this device', () => {
    mockUseSigners.mockReturnValue(base({ passkeyElsewhere: true }))
    render(<AccountSignersCard {...PROPS} />)
    expect(screen.getByText(/may be on another device/)).toBeTruthy()
    expect(screen.queryByText(/Connect your account owner wallet/)).toBeNull()
  })

  it('shows no cross-device hint when a passkey is on this device', () => {
    mockUseSigners.mockReturnValue(base({ passkeyElsewhere: false }))
    render(<AccountSignersCard {...PROPS} />)
    expect(screen.queryByText(/may be on another device/)).toBeNull()
  })

  it('copy is outcome language — no signer/passkey/addKey jargon leads', () => {
    mockUseSigners.mockReturnValue(base({ signers: { account_address: '0x' + 'aa'.repeat(20), chain_id: 84532, owner_address: '0x' + 'ee'.repeat(20), passkeys: [] } }))
    render(<AccountSignersCard {...PROPS} />)
    expect(document.body.textContent).not.toMatch(/addKey|removeKey|EOA|delegation|caveat/i)
  })
})
