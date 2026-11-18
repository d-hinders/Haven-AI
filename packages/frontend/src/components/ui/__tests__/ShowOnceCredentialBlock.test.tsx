import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: { error: toastError } }) }))

import { ShowOnceCredentialBlock } from '../ShowOnceCredentialBlock'

const original = navigator.clipboard
afterEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: original })
})

describe('ShowOnceCredentialBlock (#4905)', () => {
  it('shows the value, with its actions outside the tinted box', () => {
    render(<ShowOnceCredentialBlock value="sk_secret" maskedValue="sk_••••" label="credential" />)
    const code = screen.getByText('sk_secret')
    expect(code.parentElement?.contains(screen.getByRole('button', { name: 'Copy credential' }))).toBe(false)
  })

  it('opens masked when revealable, and Show / Hide toggles it', () => {
    render(<ShowOnceCredentialBlock value="sk_secret" maskedValue="sk_••••" label="credential" revealable />)
    expect(screen.queryByText('sk_secret')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByText('sk_secret')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByText('sk_secret')).toBeNull()
  })

  it('with no value shows the masked form and the fallback, never a Copy', () => {
    render(
      <ShowOnceCredentialBlock value={null} maskedValue="sk_••••" label="credential" fallback={<button>Rotate</button>} />,
    )
    expect(screen.getByText('sk_••••')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull()
  })

  it('toasts a failed copy and does not fire onCopied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    const onCopied = vi.fn()
    render(<ShowOnceCredentialBlock value="sk_secret" maskedValue="" label="Sales key" onCopied={onCopied} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy Sales key' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not copy Sales key'))
    expect(onCopied).not.toHaveBeenCalled()
  })
})
