import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Amount } from '@/components/haven/Amount'

function renderAmount(props: Parameters<typeof Amount>[0]) {
  const { container } = render(<Amount {...props} />)
  return container.querySelector('span')!
}

describe('Amount (#853)', () => {
  it('renders a signless neutral figure by default (budgets, balances)', () => {
    const el = renderAmount({ value: '250.00', symbol: 'USDC' })
    expect(el.textContent).toBe('250.00 USDC')
    expect(el.className).toContain('text-[var(--v2-ink)]')
    expect(el.className).toContain('v2-tabular')
  })

  it('incoming gets + and the success tone', () => {
    const el = renderAmount({ value: '12.00', symbol: 'USDC', direction: 'in' })
    expect(el.textContent).toBe('+12.00 USDC')
    expect(el.className).toContain('text-[var(--v2-success)]')
  })

  it('outgoing gets − but STAYS neutral ink — money is calm', () => {
    const el = renderAmount({ value: '12.00', symbol: 'USDC', direction: 'out' })
    expect(el.textContent).toBe('-12.00 USDC')
    expect(el.className).toContain('text-[var(--v2-ink)]')
    // The debit colour belongs to DirectionMark, never the number:
    expect(el.className).not.toContain('debit')
  })

  it('failed renders danger regardless of direction — the only red money gets', () => {
    const el = renderAmount({ value: '80.00', symbol: 'USDC', direction: 'in', failed: true })
    expect(el.className).toContain('text-[var(--v2-danger)]')
    expect(el.className).not.toContain('success')
  })

  it('size="lg" renders the detail-panel headline scale', () => {
    const el = renderAmount({ value: '320.00', symbol: 'USDC', direction: 'out', size: 'lg' })
    expect(el.className).toContain('text-2xl')
  })

  it('omits the symbol cleanly when not provided', () => {
    const el = renderAmount({ value: '1.5', direction: 'out' })
    expect(el.textContent).toBe('-1.5')
  })
})
