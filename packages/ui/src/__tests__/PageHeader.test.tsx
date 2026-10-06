import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PageHeader } from '../PageHeader'

describe('PageHeader meta slot (#3692)', () => {
  it('renders the meta line UNDER the subtitle, in v2-text-meta / ink-3', () => {
    const { container } = render(
      <PageHeader
        title="Ampersand"
        subtitle="An agent connected through the Haven credential."
        meta={<span>My account · Base · Created 2 months ago</span>}
      />,
    )
    const subtitle = Array.from(container.querySelectorAll('p')).find((p) =>
      p.textContent?.includes('connected through'),
    )!
    const meta = container.querySelector('.v2-text-meta')!
    expect(meta).not.toBeNull()
    expect(meta.className).toContain('text-[var(--v2-ink-3)]')
    expect(meta.textContent).toContain('My account · Base · Created 2 months ago')
    // the subtitle precedes the meta line in DOM order
    expect(subtitle.compareDocumentPosition(meta)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('renders meta even when there is no subtitle', () => {
    const { container } = render(<PageHeader title="Ampersand" meta="My account · Base" />)
    const meta = container.querySelector('.v2-text-meta')!
    expect(meta).not.toBeNull()
    expect(meta.textContent).toBe('My account · Base')
  })

  it('renders no meta element when none is passed — existing callers are unchanged', () => {
    const { container } = render(<PageHeader title="Ampersand" subtitle="Just a subtitle." />)
    expect(container.querySelectorAll('.v2-text-meta').length).toBe(0)
    expect(container.textContent).toContain('Just a subtitle.')
  })
})
