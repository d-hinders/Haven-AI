import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Input } from '../Input'

describe('Input', () => {
  it('forwards a ref to the <input> itself, not its wrapper (#3687)', () => {
    const ref = createRef<HTMLInputElement>()
    render(<Input ref={ref} aria-label="Name" helperText="Shown to you only" />)

    expect(ref.current).toBe(screen.getByLabelText('Name'))
  })

  it('draws a visible border by default', () => {
    render(<Input aria-label="Email" />)

    expect(screen.getByLabelText('Email')).toHaveClass('border')
    expect(screen.getByLabelText('Email')).toHaveClass('border-[var(--v2-border)]')
  })

  it('says `invalid` to assistive tech, not only in colour (#2903)', () => {
    const { rerender } = render(<Input aria-label="Account" invalid />)
    expect(screen.getByLabelText('Account')).toHaveAttribute('aria-invalid', 'true')
    rerender(<Input aria-label="Account" />)
    expect(screen.getByLabelText('Account')).not.toHaveAttribute('aria-invalid')
    // An explicit caller value wins over the derived one.
    rerender(<Input aria-label="Account" invalid aria-invalid={false} />)
    expect(screen.getByLabelText('Account')).toHaveAttribute('aria-invalid', 'false')
  })

  it('gives the helper text the id a caller passes, so aria-describedby can point at it', () => {
    render(<Input aria-label="Account" helperText="Four digits" helperTextId="account-help" aria-describedby="account-help" />)
    expect(screen.getByText('Four digits')).toHaveAttribute('id', 'account-help')
    expect(screen.getByLabelText('Account')).toHaveAccessibleDescription('Four digits')
  })
})
