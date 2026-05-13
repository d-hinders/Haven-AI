import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Input } from '../Input'

describe('Input', () => {
  it('draws a visible border by default', () => {
    render(<Input aria-label="Email" />)

    expect(screen.getByLabelText('Email')).toHaveClass('border')
    expect(screen.getByLabelText('Email')).toHaveClass('border-[var(--v2-border)]')
  })
})
