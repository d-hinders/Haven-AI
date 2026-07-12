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

  it('links to the recovery docs', () => {
    render(<RecoveryNudge />)
    const link = screen.getByRole('link', { name: 'How recovery works' })
    expect(link.getAttribute('href')).toContain('/product/account-recovery')
  })
})
