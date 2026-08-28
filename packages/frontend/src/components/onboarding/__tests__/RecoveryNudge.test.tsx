import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { RecoveryNudge } from '@/components/onboarding/RecoveryNudge'

beforeEach(() => window.localStorage.clear())

describe('RecoveryNudge (#889)', () => {
  it('urges adding a backup in outcome language', () => {
    render(<RecoveryNudge />)
    expect(screen.getByText('Add a backup soon')).toBeTruthy()
    expect(screen.getByText(/a lost device never means a lost account/)).toBeTruthy()
    // No jargon leads:
    expect(document.body.textContent).not.toMatch(/passkey signer|addKey|EOA|delegation/i)
  })

  it('is dismissible and stays dismissed (persisted)', () => {
    const { unmount } = render(<RecoveryNudge />)
    fireEvent.click(screen.getByText('Got it'))
    expect(screen.queryByText('Add a backup soon')).toBeNull()
    expect(window.localStorage.getItem('haven.recovery-nudge.dismissed')).toBe('1')

    unmount()
    render(<RecoveryNudge />)
    // A remount respects the stored dismissal — non-blocking, shown once.
    expect(screen.queryByText('Add a backup soon')).toBeNull()
  })

  /**
   * #1229's `rail="safe"` variant is DELETED (#1989, epic #1440) along with the
   * Approvers surface it pointed at. Asserted positively — the component names
   * the ONE destination it has — rather than as `queryByText('Approvers')`
   * being null, which would pass just as happily against a blank render.
   */
  it('names Backup & recovery as the only destination, with no rail fork', () => {
    render(<RecoveryNudge />)
    expect(screen.getByText('Add a backup soon')).toBeTruthy()
    expect(screen.getByText('Backup & recovery')).toBeTruthy()
    expect(screen.queryByText('Approvers')).toBeNull()
  })

  it('links to the recovery docs', () => {
    render(<RecoveryNudge />)
    const link = screen.getByRole('link', { name: 'How recovery works' })
    expect(link.getAttribute('href')).toContain('/product/account-recovery')
  })
})
