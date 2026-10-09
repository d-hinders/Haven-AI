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

/**
 * The currency mode's exact code points (#3805), including the NBSP that
 * `Intl` emits — sv-SE and de-DE set a no-break space before the symbol, and
 * a test that typed a plain space would pass a render that reads differently
 * from the pinned one. The mode formats through `formatFiat` and nothing
 * else: the figures below are byte-for-byte what that formatter produces.
 */
describe('Amount — currency mode (#3805)', () => {
  it('formats the magnitude through formatFiat in the given currency', () => {
    expect(renderAmount({ amount: 9.09, currency: 'SEK' }).textContent).toBe('9,09\u00a0kr')
    expect(renderAmount({ amount: 0.96, currency: 'USD' }).textContent).toBe('$0.96')
    expect(renderAmount({ amount: 0.88, currency: 'EUR' }).textContent).toBe('0,88\u00a0\u20ac')
  })

  it('adds the sign from direction — never from the value', () => {
    expect(renderAmount({ amount: 0.96, currency: 'USD', direction: 'in' }).textContent).toBe('+$0.96')
    expect(renderAmount({ amount: 9.09, currency: 'SEK', direction: 'out' }).textContent).toBe(
      '-9,09\u00a0kr',
    )
  })

  it('does not double-sign a negative magnitude', () => {
    // A negative `amount` is a caller bug or a signed feed; the magnitude is
    // formatted through its absolute value so the sign stays `direction`'s
    // alone.
    expect(renderAmount({ amount: -9.09, currency: 'SEK', direction: 'out' }).textContent).toBe(
      '-9,09\u00a0kr',
    )
    expect(renderAmount({ amount: -9.09, currency: 'SEK', direction: 'in' }).textContent).toBe(
      '+9,09\u00a0kr',
    )
    expect(renderAmount({ amount: -9.09, currency: 'SEK' }).textContent).toBe('9,09\u00a0kr')
  })

  it('puts ≈ before the sign, with the conversion disclosure in its title', () => {
    const el = renderAmount({ amount: 9.09, currency: 'SEK', direction: 'out', approx: true })
    expect(el.textContent).toBe('\u2248 -9,09\u00a0kr')
    const mark = el.querySelector('span')!
    expect(mark.getAttribute('title')).toBe("Converted at today's rate")
  })

  it('renders — for null in secondary ink, never 0,00 kr', () => {
    const el = renderAmount({ amount: null, currency: 'SEK', direction: 'out' })
    expect(el.textContent).toBe('\u2014')
    expect(el.className).toContain('text-[var(--v2-ink-3)]')
    // No sign on an unknown: the state is "no valuation", not a signed zero.
    expect(el.textContent).not.toContain('-')
  })

  it('renders — for a non-finite value too', () => {
    expect(renderAmount({ amount: Number.NaN, currency: 'USD' }).textContent).toBe('\u2014')
    expect(renderAmount({ amount: Number.POSITIVE_INFINITY, currency: 'USD' }).textContent).toBe(
      '\u2014',
    )
  })

  it('renders 0 as a real valuation — zero is a fact, unknown is not', () => {
    expect(renderAmount({ amount: 0, currency: 'SEK' }).textContent).toBe('0,00\u00a0kr')
  })

  it('keeps the size and tabular contracts of the token mode', () => {
    const el = renderAmount({ amount: 320.0, currency: 'USD', direction: 'out', size: 'lg' })
    expect(el.className).toContain('text-2xl')
    expect(el.className).toContain('v2-tabular')
  })
})
