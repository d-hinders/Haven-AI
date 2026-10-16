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

describe('PageHeader back link (#4028)', () => {
  it('renders the back link ABOVE the title row, not inside the title column', () => {
    const { container, getByRole } = render(
      <PageHeader
        title="Research agent"
        back={{ href: '/agents', label: 'Agents' }}
        actions={<button type="button">Pause payments</button>}
      />,
    )
    const link = getByRole('link', { name: 'Agents' })
    expect(link.getAttribute('href')).toBe('/agents')
    const header = container.querySelector('header')!
    const h1 = container.querySelector('h1')!
    // the link is a direct child of the header, and precedes the title
    expect(link.parentElement).toBe(header)
    expect(link.compareDocumentPosition(h1)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    // the title column does not contain the link, so actions stay centred on the title
    expect(h1.parentElement!.contains(link)).toBe(false)
  })

  it('renders the same markup as before when no back is passed — existing callers are unchanged', () => {
    const { container } = render(
      <PageHeader title="Agents" actions={<button type="button">New</button>} />,
    )
    const header = container.querySelector('header')!
    expect(container.querySelectorAll('a').length).toBe(0)
    // the header is still itself the flex row
    expect(header.className).toBe(
      'mb-6 flex gap-4 sm:flex-row sm:items-center sm:justify-between flex-col',
    )
    expect(header.firstElementChild!.querySelector('h1')).not.toBeNull()
  })
})
