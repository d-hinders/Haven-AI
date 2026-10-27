import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SectionHeading } from '../SectionHeading'

describe('SectionHeading', () => {
  it('renders the heading as a bare h2 when there is no action — no wrapper (#4475)', () => {
    // The heading, the prose and the card stay SIBLINGS inside the caller's
    // <section>: SettingsSection's own test asserts `heading.nextElementSibling`
    // is the card, and the settings e2e specs locate the section by its
    // heading. Mutation: wrap the heading in a div unconditionally → red.
    const { container } = render(<SectionHeading title="Signers" />)
    const heading = container.firstElementChild as HTMLElement
    expect(heading.tagName).toBe('H2')
    expect(heading.textContent).toBe('Signers')
    expect(heading.className).toMatch(/\bv2-text-h3\b/)
  })

  it('puts the trailing action on the heading’s own line, in one wrapping row (#4475)', () => {
    // Mutation: render the action below the heading (a block sibling) → red:
    // the link would read as a second paragraph, not as the section's action.
    const { container, getByText } = render(
      <SectionHeading
        title="Signers"
        description="Accounts that can approve payments from this Haven account."
        action={<a href="/accounts">View all</a>}
      />,
    )
    const row = container.firstElementChild as HTMLElement
    expect(row.tagName).toBe('DIV')
    expect(row.className).toMatch(/\bflex\b/)
    expect(row.className).toMatch(/\bflex-wrap\b/)
    expect(row.className).toMatch(/\bitems-baseline\b/)
    expect(row.className).toMatch(/\bjustify-between\b/)

    const heading = row.querySelector('h2') as HTMLElement
    expect(heading.textContent).toBe('Signers')
    // The action is INSIDE the heading row, after the heading.
    const action = getByText('View all')
    expect(row.contains(action)).toBe(true)
    expect(heading.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // …and the description is NOT in the row — it stays a sibling below it.
    expect(row.textContent).not.toContain('Accounts that can approve')
  })

  it('takes a link, not a button — the action is whatever the caller passes, and the specimen passes an anchor', () => {
    // The slot is navigation to the fuller surface. The primitive holds no
    // copy and no href; this pins the element the pattern documents.
    const { getByText } = render(
      <SectionHeading title="Signers" action={<a href="/accounts">View all</a>} />,
    )
    expect(getByText('View all').tagName).toBe('A')
  })

  it('keeps the heading-to-card gap when there is no prose, action or not (#4476)', () => {
    // The gap rides on the heading's `mb-3` when nothing else supplies it. In
    // the action row the heading is a flex item, so its bottom margin is part
    // of the row's height — the card still starts 12px below the heading.
    for (const action of [undefined, <a key="a" href="/accounts">View all</a>]) {
      const { container, unmount } = render(<SectionHeading title="Data" action={action} />)
      const heading = container.querySelector('h2') as HTMLElement
      expect(heading.className).toMatch(/\bmb-3\b/)
      unmount()
    }
  })

  it('does not double the gap when a description is present (#4476)', () => {
    const { container } = render(
      <SectionHeading title="Accounting" description="Connect your accounting provider." />,
    )
    const heading = container.querySelector('h2') as HTMLElement
    expect(heading.className).not.toMatch(/\bmb-3\b/)
  })

  it('renders the description and note under the heading, in the detail-page classes', () => {
    const { container } = render(
      <SectionHeading
        title="Accounting"
        description="Connect your accounting provider."
        note="Fortnox and Accounted are live."
      />,
    )
    const paragraphs = Array.from(container.querySelectorAll('p')) as HTMLElement[]
    const description = paragraphs.find((p) => p.textContent?.includes('Connect your accounting')) as HTMLElement
    const note = paragraphs.find((p) => p.textContent?.includes('Fortnox and Accounted are live')) as HTMLElement
    expect(description.className).toMatch(/\bmt-0\.5\b/)
    expect(description.className).toMatch(/\bmb-3\b/)
    expect(description.className).toMatch(/\btext-sm\b/)
    expect(description.className).toMatch(/text-\[var\(--v2-ink-2\)\]/)
    expect(note.className).toMatch(/\btext-xs\b/)
    expect(note.className).toMatch(/text-\[var\(--v2-ink-3\)\]/)
  })
})
