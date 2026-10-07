import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BudgetMeter } from '@/components/haven/BudgetMeter'

function meterEl(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[role="progressbar"]')!
}

function fillEl(container: HTMLElement) {
  return meterEl(container).firstElementChild as HTMLElement
}

describe('BudgetMeter (#3692)', () => {
  it('clamps below zero to 0 — an overdrawn read cannot push the fill past its track', () => {
    const { container } = render(<BudgetMeter usedPercent={-5} label="USDC budget used" />)
    expect(meterEl(container).getAttribute('aria-valuenow')).toBe('0')
    expect(fillEl(container).style.width).toBe('0%')
  })

  it('clamps above 100 to 100 — the ARIA value never leaves its own declared range', () => {
    const { container } = render(<BudgetMeter usedPercent={140} label="USDC budget used" />)
    expect(meterEl(container).getAttribute('aria-valuenow')).toBe('100')
    expect(fillEl(container).style.width).toBe('100%')
  })

  it('passes the measurement through unclamped inside the range', () => {
    const { container } = render(<BudgetMeter usedPercent={40} label="USDC budget used" />)
    expect(meterEl(container).getAttribute('aria-valuenow')).toBe('40')
    expect(fillEl(container).style.width).toBe('40%')
  })

  it('is a progressbar with the full ARIA contract and the caller label', () => {
    const { container } = render(<BudgetMeter usedPercent={40} label="USDC budget used" />)
    const el = meterEl(container)
    expect(el.getAttribute('role')).toBe('progressbar')
    expect(el.getAttribute('aria-valuemin')).toBe('0')
    expect(el.getAttribute('aria-valuemax')).toBe('100')
    expect(el.getAttribute('aria-label')).toBe('USDC budget used')
  })

  it('renders the caption line under the bar when given', () => {
    const { container } = render(
      <BudgetMeter usedPercent={40} label="USDC budget used" caption="1.20 of 3.00 USDC used" />,
    )
    const caption = Array.from(container.querySelectorAll('p')).find((p) =>
      p.textContent?.includes('1.20 of 3.00 USDC used'),
    )
    expect(caption).toBeDefined()
    expect(caption!.className).toContain('text-[var(--v2-ink-3)]')
    // the bar precedes the caption in DOM order
    expect(meterEl(container).compareDocumentPosition(caption!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('renders no caption element when none is given', () => {
    const { container } = render(<BudgetMeter usedPercent={40} label="USDC budget used" />)
    expect(container.querySelectorAll('p').length).toBe(0)
  })
})
