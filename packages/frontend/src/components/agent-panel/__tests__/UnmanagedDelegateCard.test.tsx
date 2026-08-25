/**
 * #1980: the revoke affordance on a delegate Haven does not manage.
 *
 * The card shows a live on-chain budget against the user's account, and
 * /custody's "Revoke an agent — or an unmanaged delegate — on-chain from
 * Agents" copy points here. These tests pin that the promise is kept: a
 * genuinely external delegate gets a Revoke control behind the established
 * confirm pattern, and the mid-setup (`pendingHavenSetup`) branch does NOT —
 * that delegate is about to be adopted by the setup flow, and tearing it
 * down from this card would fight it.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const { UnmanagedDelegateCard } = await import('../UnmanagedDelegateCard')

const DELEGATE = '0x' + '44'.repeat(20)

function renderCard({
  pendingHavenSetup = false,
  onRevoke = vi.fn(),
  revoking = false,
}: {
  pendingHavenSetup?: boolean
  onRevoke?: () => void
  revoking?: boolean
} = {}) {
  render(
    <UnmanagedDelegateCard
      delegate={DELEGATE}
      allowances={[
        {
          token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amount: 200_000000n,
          spent: 45_000000n,
          resetTimeMin: 1440,
          lastResetMin: 0,
          nonce: 1,
        },
      ]}
      chainTimeSec={1_700_000_000}
      chainId={84532}
      pendingHavenSetup={pendingHavenSetup}
      onRevoke={onRevoke}
      revoking={revoking}
    />,
  )
  return { onRevoke }
}

describe('UnmanagedDelegateCard revoke affordance (#1980)', () => {
  it('an external delegate gets a Revoke control', () => {
    renderCard()
    expect(
      screen.getByRole('button', { name: `Revoke delegate ${DELEGATE}` }),
    ).toBeTruthy()
  })

  it('revoke goes through the confirm dialog: nothing fires on the button alone', () => {
    const { onRevoke } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: `Revoke delegate ${DELEGATE}` }))

    // The click opened the dialog, not the action.
    expect(onRevoke).not.toHaveBeenCalled()
    expect(screen.getByText('Revoke this delegate?')).toBeTruthy()
    // The dialog states the authority being removed — this is money copy,
    // not decoration (copy-guidelines § Money and authority copy).
    expect(screen.getByText(/removes its network spending authority/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke delegate' }))
    expect(onRevoke).toHaveBeenCalledTimes(1)
  })

  it('cancel closes the dialog without revoking', () => {
    const { onRevoke } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: `Revoke delegate ${DELEGATE}` }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onRevoke).not.toHaveBeenCalled()
    expect(screen.queryByText('Revoke this delegate?')).toBeNull()
  })

  it('the pendingHavenSetup branch has NO revoke control', () => {
    renderCard({ pendingHavenSetup: true })
    expect(
      screen.queryByRole('button', { name: `Revoke delegate ${DELEGATE}` }),
    ).toBeNull()
  })

  it('while revoking, the control is disabled and says so', () => {
    renderCard({ revoking: true })
    const button = screen.getByRole('button', {
      name: `Revoke delegate ${DELEGATE}`,
    }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('Revoking...')
  })
})
