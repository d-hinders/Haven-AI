import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #3812: the in-flow connect/switch control reads wagmi and RainbowKit, which
// these tests do not provide. Stub it so the test can assert WHEN a flow
// offers it; `WalletConnectAction.test.tsx` covers what it does.
vi.mock('@/components/WalletConnectAction', () => ({
  default: () => <button type="button">Connect wallet</button>,
}))

const { mockUseSigners } = vi.hoisted(() => ({ mockUseSigners: vi.fn() }))

vi.mock('@/hooks/useAccountSigners', () => ({ useAccountSigners: (...a: unknown[]) => mockUseSigners(...a) }))
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }),
}))

const AccountSignersCard = (await import('../AccountSignersCard')).default

const PROPS = { accountAddress: '0x' + 'aa'.repeat(20), chainId: 84532, userEmail: 'x@y.z' }

function base(overrides: Record<string, unknown> = {}) {
  return {
    signers: {
      account_address: '0x' + 'aa'.repeat(20),
      chain_id: 84532,
      owner_address: null,
      passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' }],
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
  it('warns when there is only one way to approve, and Remove is absent there (#4474)', async () => {
    mockUseSigners.mockReturnValue(base())
    render(<AccountSignersCard {...PROPS} />)
    await waitFor(() =>
      expect(screen.getByText('Only one passkey can approve this account')).toBeTruthy(),
    )
    expect(
      screen.getByText(/If you lose it, you lose the account and the money in it\. Add a backup now\./),
    ).toBeTruthy()
    // #4474: removing the last signer is refused on-chain anyway, so the
    // control is ABSENT rather than disabled — a disabled Remove on the only
    // row reads as a broken button.
    expect(screen.queryByText('Remove')).toBeNull()
  })

  it('names the WALLET when a wallet is the only way to approve (#4474)', () => {
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
    expect(screen.getByText('Only one wallet can approve this account')).toBeTruthy()
    expect(screen.queryByText(/Only one passkey/)).toBeNull()
  })

  it('shows Remove on every row once two signers can approve (#4474)', () => {
    mockUseSigners.mockReturnValue(
      base({
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' }],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    // Pinned so deleting Remove outright fails: with two ways to approve,
    // removing one stays possible as long as one remains.
    expect(screen.getAllByText('Remove')).toHaveLength(2)
    expect(screen.queryByText(/Only one (passkey|wallet) can approve/)).toBeNull()
  })

  it('renders ONE footer row: both add actions and the recovery-help link (#4474)', () => {
    mockUseSigners.mockReturnValue(base())
    render(<AccountSignersCard {...PROPS} />)
    expect(screen.getByRole('button', { name: /Add a backup passkey/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add a wallet/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Lost a device\?/ })).toBeTruthy()
    // The screen-lock helper line the mockup dropped is gone.
    expect(screen.queryByText(/Approve with your passkey/)).toBeNull()
  })

  it('hides Add a wallet once the account has one (#4474)', () => {
    mockUseSigners.mockReturnValue(
      base({
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' }],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    expect(screen.queryByRole('button', { name: /Add a wallet/ })).toBeNull()
  })

  it('enrolls a backup passkey via one action', async () => {
    const enrollBackupPasskey = vi.fn().mockResolvedValue({ ok: true })
    mockUseSigners.mockReturnValue(base({ enrollBackupPasskey }))
    render(<AccountSignersCard {...PROPS} />)
    fireEvent.click(screen.getByText('Add a backup passkey'))
    await waitFor(() => expect(enrollBackupPasskey).toHaveBeenCalled())
  })

  it('with two ways, passkey removal requires a consequence-naming confirmation (#1199)', async () => {
    const removePasskey = vi.fn().mockResolvedValue({ ok: true })
    mockUseSigners.mockReturnValue(
      base({
        removePasskey,
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' }],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    // Owner row renders first (#1087 added its Remove); the passkey row's is second.
    const removes = screen.getAllByText('Remove') as HTMLButtonElement[]
    const remove = removes[1]
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)
    expect(removePasskey).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/this account will have no recovery/i)).toBeTruthy()
    expect(screen.getByText(/Haven cannot restore access/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove anyway' }))
    await waitFor(() => expect(removePasskey).toHaveBeenCalledWith('0x' + '11'.repeat(32)))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('cancelling the passkey confirmation leaves the passkey in place (#1199)', () => {
    const removePasskey = vi.fn().mockResolvedValue({ ok: true })
    mockUseSigners.mockReturnValue(
      base({
        removePasskey,
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' }],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    const [, passkeyRemove] = screen.getAllByText('Remove') as HTMLButtonElement[]
    fireEvent.click(passkeyRemove)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(removePasskey).not.toHaveBeenCalled()
  })

  it('removes a passkey directly when at least two approval ways remain', async () => {
    const removePasskey = vi.fn().mockResolvedValue({ ok: true })
    mockUseSigners.mockReturnValue(
      base({
        removePasskey,
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [
            { key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' },
            { key_id: '0x' + '22'.repeat(32), x: '0x3', y: '0x4', created_at: '2026-05-10T09:00:00.000Z' },
          ],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    const removes = screen.getAllByText('Remove') as HTMLButtonElement[]
    fireEvent.click(removes[1])

    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(removePasskey).toHaveBeenCalledWith('0x' + '11'.repeat(32)))
  })

  it('the wallet owner can be removed when a passkey remains, behind a consequence-naming confirmation (#1087, #1153)', async () => {
    const removeOwner = vi.fn().mockResolvedValue({ ok: true })
    mockUseSigners.mockReturnValue(
      base({
        removeOwner,
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' }],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    // Recovery-accurate copy on the row:
    expect(screen.getByText(/passkeys become the only ways to approve/)).toBeTruthy()
    const [ownerRemove] = screen.getAllByText('Remove') as HTMLButtonElement[]
    expect(ownerRemove.disabled).toBe(false)

    // Removing this owner would drop the account to a single signer (one
    // remaining passkey) — the backend now permits that unconditionally
    // (#1153), so the frontend must name the consequence BEFORE calling it.
    fireEvent.click(ownerRemove)
    expect(removeOwner).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/this account will have no recovery/i)).toBeTruthy()
    expect(screen.getByText(/losing this device loses the funds|lose access to this account/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove anyway' }))
    await waitFor(() => expect(removeOwner).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('cancelling the single-signer confirmation leaves the wallet in place', async () => {
    const removeOwner = vi.fn().mockResolvedValue({ ok: true })
    mockUseSigners.mockReturnValue(
      base({
        removeOwner,
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' }],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    const [ownerRemove] = screen.getAllByText('Remove') as HTMLButtonElement[]
    fireEvent.click(ownerRemove)
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(removeOwner).not.toHaveBeenCalled()
  })

  it('does not show the single-signer confirmation when a backup passkey would still remain', async () => {
    const removeOwner = vi.fn().mockResolvedValue({ ok: true })
    mockUseSigners.mockReturnValue(
      base({
        removeOwner,
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [
            { key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' },
            { key_id: '0x' + '22'.repeat(32), x: '0x3', y: '0x4', created_at: '2026-05-10T09:00:00.000Z' },
          ],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    const [ownerRemove] = screen.getAllByText('Remove') as HTMLButtonElement[]
    fireEvent.click(ownerRemove)
    // Removing the wallet here still leaves two passkeys — ordinary
    // maintenance, no single-signer consequence to name.
    expect(screen.queryByRole('dialog')).toBeNull()
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
    // #4474: no Remove at all while the wallet is the only way to approve.
    expect(screen.queryByText('Remove')).toBeNull()
    // #3845: the row promises no passkeys the account does not have, and says
    // why Remove is unavailable.
    expect(screen.queryByText(/your passkeys become/)).toBeNull()
    expect(
      screen.getByText(
        "This wallet is the only way to approve this account, so it can't be removed until you add a backup.",
      ),
    ).toBeTruthy()
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
          // Passkey-free on purpose: with any passkey present the optimistic
          // fallback keeps `ready` true, so this state can't carry one (#1097).
          passkeys: [],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    expect(screen.getByText(/Connect your account owner wallet/)).toBeTruthy()
    // #3812: connect or switch here (the header pill is gone since #3825).
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy()
  })

  it('a ready (passkey) account offers no wallet connect (#3812)', () => {
    mockUseSigners.mockReturnValue(base())
    render(<AccountSignersCard {...PROPS} />)
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
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

  // ── #1679 / #4474: credential naming — the kind on line 1, "Added {date}"
  // on line 2, never positional in the old sense ──
  it('labels every passkey row with the kind on line 1 and "Added {date}" on line 2, and the EOA row "Browser wallet"', () => {
    mockUseSigners.mockReturnValue(
      base({
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: '0x' + 'ee'.repeat(20),
          passkeys: [
            { key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' },
            { key_id: '0x' + '22'.repeat(32), x: '0x3', y: '0x4', created_at: '2026-05-10T09:00:00.000Z' },
          ],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    // Two passkeys → the ordinal tells them apart, in enrollment order.
    expect(screen.getByText('Passkey 1')).toBeTruthy()
    expect(screen.getByText('Passkey 2')).toBeTruthy()
    expect(screen.getByText('Added 3 March 2026')).toBeTruthy()
    expect(screen.getByText('Added 10 May 2026')).toBeTruthy()
    expect(screen.getByText('Browser wallet')).toBeTruthy()
    // The banned platform-brand label and role words never render as names:
    expect(document.body.textContent).not.toMatch(/Face ID \/ Touch ID|External owner/)
  })

  // #3825: who your signers are is Settings → Signers' job; the account card
  // shows which signers approve THIS account, with no address or key id.
  it('shows no owner address or passkey key id', () => {
    const owner = '0x' + 'ee'.repeat(20)
    const keyId = '0x' + '11'.repeat(32)
    mockUseSigners.mockReturnValue(
      base({
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: owner,
          passkeys: [{ key_id: keyId, x: '0x1', y: '0x2', created_at: '2026-03-03T12:00:00.000Z' }],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    // Positive control: both signer rows rendered.
    expect(screen.getByText('Browser wallet')).toBeTruthy()
    expect(screen.getByText('Passkey')).toBeTruthy()
    expect(screen.getByText('Added 3 March 2026')).toBeTruthy()
    // The key id never renders; the owner address only inside a CLOSED
    // "Show address" disclosure (#3825 design review: the card asks for THE
    // owner wallet, so the user must be able to tell which one).
    expect(document.body.textContent ?? '').not.toMatch(/0x1111/i)
    const details = screen.getByText('Show address').closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.textContent).toContain(owner)
    const outside = Array.from(document.body.querySelectorAll('p')).filter((p) => !p.closest('details'))
    expect(outside.some((p) => /0xeeee/i.test(p.textContent ?? ''))).toBe(false)
  })

  it('REGRESSION (#1679): after a recovery removes the original key, the surviving backup keeps ITS OWN label', () => {
    // The old positional rule (`i === 0 ? 'Face ID / Touch ID' : 'Backup N'`)
    // relabeled the surviving backup as the primary the moment the original
    // key was removed. With date-based labels the row is stable: the same
    // credential carries the same date whatever its position.
    const backupOnly = {
      account_address: '0x' + 'aa'.repeat(20),
      chain_id: 84532,
      owner_address: null,
      // Only the SECOND-enrolled credential remains (index 0 now).
      passkeys: [{ key_id: '0x' + '22'.repeat(32), x: '0x3', y: '0x4', created_at: '2026-05-10T09:00:00.000Z' }],
    }
    mockUseSigners.mockReturnValue(base({ signers: backupOnly }))
    render(<AccountSignersCard {...PROPS} />)
    // One passkey left → no ordinal, and the date is the surviving key's own.
    expect(screen.getByText('Passkey')).toBeTruthy()
    expect(screen.getByText('Added 10 May 2026')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Face ID / Touch ID')
  })

  it('a passkey without a stored date falls back to ordinal "Passkey N" — never a platform name (#1679)', () => {
    mockUseSigners.mockReturnValue(
      base({
        signers: {
          account_address: '0x' + 'aa'.repeat(20),
          chain_id: 84532,
          owner_address: null,
          passkeys: [
            { key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2', created_at: null },
            { key_id: '0x' + '22'.repeat(32), x: '0x3', y: '0x4', created_at: null },
          ],
        },
      }),
    )
    render(<AccountSignersCard {...PROPS} />)
    expect(screen.getByText('Passkey 1')).toBeTruthy()
    expect(screen.getByText('Passkey 2')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Face ID / Touch ID')
  })

  it('copy is outcome language — no signer/passkey/addKey jargon leads', () => {
    mockUseSigners.mockReturnValue(base({ signers: { account_address: '0x' + 'aa'.repeat(20), chain_id: 84532, owner_address: '0x' + 'ee'.repeat(20), passkeys: [] } }))
    render(<AccountSignersCard {...PROPS} />)
    expect(document.body.textContent).not.toMatch(/addKey|removeKey|EOA|delegation|caveat/i)
  })
})
