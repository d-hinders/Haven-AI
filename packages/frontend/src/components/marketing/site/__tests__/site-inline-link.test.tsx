import Link from 'next/link'
import { isValidElement } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SiteInlineLink } from '../blocks'

/**
 * `SiteInlineLink` (#4713): the themed link inside running text, extracted
 * from three copies of one class string. jsdom renders `next/link` and a
 * plain `<a>` alike, so the element type is read off the returned element.
 */
describe('SiteInlineLink', () => {
  it('renders a plain <a> for a static file and next/link for a route', () => {
    const file = SiteInlineLink({ href: '/llms.txt', plain: true, children: '/llms.txt' })
    const route = SiteInlineLink({ href: '/releases', children: '/releases' })
    expect(isValidElement(file) && file.type).toBe('a')
    expect(isValidElement(route) && route.type).toBe(Link)
  })

  it('offsets the focus ring to the ground it sits on', () => {
    const { container } = render(
      <>
        <SiteInlineLink href="/a">on white</SiteInlineLink>
        <SiteInlineLink href="/b" ground="tint">on tint</SiteInlineLink>
      </>,
    )
    const [white, tint] = Array.from(container.querySelectorAll('a'))
    expect(white.className).toContain('focus-visible:ring-offset-[var(--v2-bg)]')
    expect(white.className).not.toContain('ring-offset-[var(--v2-surface)]')
    expect(tint.className).toContain('focus-visible:ring-offset-[var(--v2-surface)]')
    expect(tint.className).not.toContain('ring-offset-[var(--v2-bg)]')
  })

  it('the home page’s Step 3 call site passes `plain`', async () => {
    // A source read, because the rendered DOM cannot tell next/link from <a>
    // (the ring offset is asserted on the rendered page in new-home.test.tsx).
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '..', 'home', 'HomeSections.tsx'), 'utf8')
    expect(src).toContain('<SiteInlineLink href="/llms.txt" ground="tint" plain>')
  })
})
