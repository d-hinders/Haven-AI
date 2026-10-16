import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BackLink } from '../BackLink'

describe('BackLink (#4028)', () => {
  it('links to the parent and is named by the parent alone', () => {
    const { getByRole } = render(<BackLink href="/marketplace" label="Marketplace" />)
    const link = getByRole('link', { name: 'Marketplace' })
    expect(link.getAttribute('href')).toBe('/marketplace')
    expect(link.textContent).toBe('Marketplace')
  })

  it('extends its hit area to 44px with the same ::after mechanism Button uses (#1726)', () => {
    const { getByRole } = render(<BackLink href="/agents" label="Agents" />)
    const cls = getByRole('link').className
    expect(cls).toContain('relative')
    expect(cls).toContain('after:h-11')
    expect(cls).toContain("after:content-['']")
    // drawn at text height, not as a 44px row
    expect(cls).toContain('leading-5')
    expect(cls.split(/\s+/)).not.toContain('h-11')
  })

  it('truncates a long label on one line instead of wrapping (#4028)', () => {
    const { getByRole } = render(
      <BackLink href="/agents/a1" label="A research agent with an unusually long name for a phone" />,
    )
    const link = getByRole('link', { name: 'A research agent with an unusually long name for a phone' })
    expect(link.className.split(/\s+/)).toContain('max-w-full')
    const span = link.querySelector('span')!
    expect(span.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']))
  })
})
