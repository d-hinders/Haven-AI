import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SettingsSection, SettingsRow } from '../SettingsSection'

describe('SettingsSection', () => {
  it('renders the heading OUTSIDE the card, inside a section root that wraps both (#4357)', () => {
    // The detail-page section rule applied to settings: the heading and its
    // description sit ABOVE the card so the card can load, swap or be
    // replaced without moving its heading. Mutation: wrap the h2 inside the
    // Card (or drop the section root) → red. The `<section>` root with the
    // heading in it is also what the settings e2e specs and
    // `screenshot.mjs` locate by — `page.locator('section', { has: heading })`.
    const { container } = render(
      <SettingsSection title="Accounting" description="Connect your accounting provider.">
        <SettingsRow label="Fortnox" detail="Connected." />
      </SettingsSection>,
    )
    const section = container.firstElementChild as HTMLElement
    expect(section.tagName).toBe('SECTION')

    const heading = section.querySelector('h2')
    expect(heading).not.toBeNull()
    expect(heading?.textContent).toBe('Accounting')

    const card = section.querySelector('.rounded-\\[10px\\]')
    expect(card).not.toBeNull()
    // The heading is not a descendant of the card.
    expect(card?.contains(heading as Node)).toBe(false)
    // The section root wraps both — heading and card are siblings' ancestors.
    expect(section.contains(heading as Node)).toBe(true)
    expect(section.contains(card as Node)).toBe(true)
  })

  it('uses the sentence-case v2-text-h3 heading — no uppercase band (#4357)', () => {
    // Mutation: keep the old `text-[13px] uppercase tracking-widest` band
    // title → red.
    const { container } = render(
      <SettingsSection title="Preferences">
        <SettingsRow label="Currency" />
      </SettingsSection>,
    )
    const heading = container.querySelector('h2') as HTMLElement
    expect(heading.className).toMatch(/\bv2-text-h3\b/)
    expect(heading.className).not.toMatch(/\buppercase\b/)
    expect(heading.className).not.toMatch(/\btracking-widest\b/)
  })

  it('renders the description and note ABOVE the card, with the card holding only the divided rows', () => {
    const { container } = render(
      <SettingsSection
        title="Accounting"
        description="Connect your accounting provider."
        note="Fortnox is the only live provider."
      >
        <SettingsRow label="Fortnox" />
      </SettingsSection>,
    )
    const section = container.firstElementChild as HTMLElement
    const card = section.querySelector('.rounded-\\[10px\\]') as HTMLElement
    const description = Array.from(section.querySelectorAll('p')).find((p) =>
      p.textContent?.includes('Connect your accounting'),
    ) as HTMLElement
    const note = Array.from(section.querySelectorAll('p')).find((p) =>
      p.textContent?.includes('Fortnox is the only live'),
    ) as HTMLElement
    expect(description).toBeTruthy()
    expect(card.contains(description)).toBe(false)
    expect(note).toBeTruthy()
    expect(card.contains(note)).toBe(false)
    // The description uses the detail-page classes (manage-pattern specimen).
    expect(description.className).toMatch(/\bmt-0\.5\b/)
    expect(description.className).toMatch(/\bmb-3\b/)
    expect(description.className).toMatch(/\btext-sm\b/)
    expect(description.className).toMatch(/text-\[var\(--v2-ink-muted\)\]/)
    // The note is quieter still.
    expect(note.className).toMatch(/\btext-xs\b/)
    expect(note.className).toMatch(/text-\[var\(--v2-ink-3\)\]/)
  })

  it('keeps SettingsRow unchanged — label, detail, action, and the testid/status passthrough', () => {
    const { getByTestId, getByText } = render(
      <SettingsSection title="Accounting">
        <SettingsRow
          label="Fortnox"
          detail="Connected to ACME AB."
          action={<button type="button">Disconnect</button>}
          data-testid="connection-actions-fortnox"
          data-status="connected"
        />
      </SettingsSection>,
    )
    expect(getByTestId('connection-actions-fortnox').getAttribute('data-status')).toBe('connected')
    expect(getByText('Fortnox').tagName).toBe('P')
    expect(getByText('Disconnect').tagName).toBe('BUTTON')
  })

  it('renders the card without the old Card.Header band — no tinted header surface', () => {
    // Mutation: re-add `<Card.Header padding="spacious">` (the grey band) →
    // red: the card must contain only the divided row list.
    const { container } = render(
      <SettingsSection title="Accounting">
        <SettingsRow label="Fortnox" />
      </SettingsSection>,
    )
    const card = container.querySelector('.rounded-\\[10px\\]') as HTMLElement
    expect(card.className).not.toMatch(/bg-\[var\(--v2-surface\)\]/)
    expect(card.textContent).not.toContain('Accounting')
  })
})
