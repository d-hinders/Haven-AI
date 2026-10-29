/**
 * AttentionList titles and subtitles: two lines, then an ellipsis, at every
 * width (#3861, then #3876).
 *
 * #3861 — rows passed `whitespace-normal line-clamp-2 sm:whitespace-nowrap
 * sm:line-clamp-none` to `Row`'s title, which always carries `truncate`.
 * Tailwind's `line-clamp-none` sets `overflow: visible`, and `text-overflow:
 * ellipsis` paints nothing without a hidden overflow — so on desktop a long
 * title ran under the trailing badge and was cut mid-word by the row's edge,
 * with no `…`. The fix scoped the clamp `max-sm:`, leaving a one-line
 * ellipsis from `sm` up.
 *
 * #3876 — that one line still hid the item: in the narrow desktop Needs attention
 * panel a title read "Haven paused spon…" and the subtitle truncated too, so
 * the full text was on screen nowhere. The owner chose a two-line clamp
 * everywhere, for the title AND the subtitle (2026-10-10), over a hover-only
 * `title` attribute. The old desktop arm here ("one line ending in an
 * ellipsis") is that rule reversed, so it was rewritten, not deleted.
 *
 * WHY GEOMETRY AND NOT A SCREENSHOT. The /design-system AttentionList clip
 * carries text that fits, and a class assertion cannot see this either —
 * #3861 was a class string that read correctly. So each arm writes text far
 * longer than two lines into one rendered paragraph and reads what the
 * browser computes. Every arm first proves the text really overflows
 * (`scrollHeight > clientHeight`) — without that, a clamp that never engages
 * passes — and keeps `overflow-x: hidden`, the #3861 guard.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

// At least 3x the widest body column the sample renders at 1280 (~700px), so
// it overflows two lines at both measured widths, for the 14px title and the
// 12px subtitle alike.
const LONG_TEXT = Array.from(
  { length: 4 },
  () => 'Research agent reached its budget for this period and approves nothing further until you raise or clear it.',
).join(' ')

// The title is Row's `font-medium` paragraph; the subtitle is its `text-xs`
// one. Separate locators, so the subtitle arm cannot measure the title twice.
const PARTS = {
  title: 'li p.font-medium',
  subtitle: 'li p.text-xs',
} as const

interface Metrics {
  overflowX: string
  whiteSpace: string
  lineClamp: string
  scrollHeight: number
  clientHeight: number
  height: number
  lineHeight: number
}

async function lengthen(page: Page, part: keyof typeof PARTS): Promise<Metrics> {
  const sample = page.getByTestId('ds-attention-list')
  await expect(sample.getByTestId(/^attention-dismiss-/)).toHaveCount(3)
  return sample
    .locator(PARTS[part])
    .first()
    .evaluate((el, text) => {
      el.textContent = text
      const cs = getComputedStyle(el)
      return {
        overflowX: cs.overflowX,
        whiteSpace: cs.whiteSpace,
        lineClamp: cs.getPropertyValue('-webkit-line-clamp'),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        height: el.getBoundingClientRect().height,
        lineHeight: parseFloat(cs.lineHeight),
      }
    }, LONG_TEXT)
}

const WIDTHS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile width', width: 390, height: 844 },
]

test.describe('AttentionList text overflow (#3861, #3876)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  for (const vp of WIDTHS) {
    for (const part of ['title', 'subtitle'] as const) {
      test(`${vp.name}: a long ${part} wraps and clamps to two lines`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height })
        await page.goto('/design-system')
        const m = await lengthen(page, part)
        // The text really runs past two lines — otherwise the clamp is untested.
        expect(m.scrollHeight).toBeGreaterThan(m.clientHeight)
        expect(m.whiteSpace).toBe('normal')
        expect(m.lineClamp).toBe('2')
        // `text-overflow` needs a hidden overflow to paint: the #3861 defect was `visible` here.
        expect(m.overflowX).toBe('hidden')
        expect(m.height).toBeGreaterThan(m.lineHeight * 1.5)
        expect(m.height).toBeLessThan(m.lineHeight * 2.5)
      })
    }
  }
})

/**
 * Centred in the row (#4019). The leading icon and, beside the body from `sm`
 * up, the trailing badge, action and dismiss are centred vertically in the
 * row — `Row`'s own `items-center` with its symmetric `py-3`. This reverses
 * #3880, which pinned them to the title's first line with 6px of padding
 * above and 12px below; the owner found that top-heavy (2026-10-16), so the
 * #3880 arm here was rewritten, not deleted.
 *
 * The reference is the Row root (`li > div`), never the `li`: in the
 * full-bleed sample the `li` carries the `divide-y` top border. Two rows are
 * measured — a badge-and-dismiss row and the "Review" action row (a 36px-tall
 * control, not the 32px dismiss) — each as rendered and with a body made two
 * lines taller than the icon, where centring on the row and centring on the
 * first line give different answers.
 */
const CENTRE_TOLERANCE_PX = 1

const CENTRED_ROWS = [
  { name: 'a badge-and-dismiss row', id: 'budget-reached', hasAction: false },
  { name: 'the action row', id: 'payment-failed', hasAction: true },
] as const

test.describe('AttentionList centred in the row (#4019)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  for (const row of CENTRED_ROWS) {
    for (const lengthenBody of [false, true]) {
      test(`desktop: ${row.name}${lengthenBody ? ' with a four-line body' : ''} centres the icon and the trailing controls`, async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 })
        await page.goto('/design-system')
        const sample = page.getByTestId('ds-attention-list')
        await expect(sample.getByTestId(/^attention-dismiss-/)).toHaveCount(3)
        const m = await sample
          .getByTestId(`attention-dismiss-${row.id}`)
          .evaluate(
            (dismiss, { text, lengthenBody }) => {
              const li = dismiss.closest('li') as HTMLElement
              const root = li.querySelector(':scope > div') as HTMLElement
              const title = root.querySelector('p.font-medium') as HTMLElement
              const subtitle = root.querySelector('p.text-xs') as HTMLElement
              if (lengthenBody) {
                title.textContent = text
                subtitle.textContent = text
              }
              const icon = root.querySelector(':scope > span[aria-hidden="true"]') as HTMLElement
              const controls = dismiss.parentElement as HTMLElement
              const action = controls.querySelector('button:not([data-attention-dismiss]), a') as HTMLElement | null
              const badge = controls.firstElementChild as HTMLElement
              const centre = (el: Element) => {
                const r = el.getBoundingClientRect()
                return r.top + r.height / 2
              }
              const r = root.getBoundingClientRect()
              const cs = getComputedStyle(root)
              return {
                rootCentre: r.top + r.height / 2,
                paddingTop: parseFloat(cs.paddingTop),
                paddingBottom: parseFloat(cs.paddingBottom),
                bodyHeight: subtitle.getBoundingClientRect().bottom - title.getBoundingClientRect().top,
                iconHeight: icon.getBoundingClientRect().height,
                lineHeight: parseFloat(getComputedStyle(title).lineHeight),
                iconCentre: centre(icon),
                badgeCentre: centre(badge),
                dismissCentre: centre(dismiss),
                actionCentre: action ? centre(action) : null,
                actionHeight: action ? action.getBoundingClientRect().height : null,
                controlsBesideBody: controls.getBoundingClientRect().top < subtitle.getBoundingClientRect().bottom,
              }
            },
            { text: LONG_TEXT, lengthenBody },
          )
        expect(m.paddingTop).toBe(12)
        expect(m.paddingBottom).toBe(12)
        expect(m.controlsBesideBody, 'at 1280 the trailing controls sit beside the body').toBe(true)
        if (lengthenBody) {
          // Precondition: centring on the row and on the first line now differ.
          expect(m.bodyHeight).toBeGreaterThanOrEqual(m.iconHeight + 2 * m.lineHeight)
        }
        expect(Math.abs(m.iconCentre - m.rootCentre)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX)
        expect(Math.abs(m.badgeCentre - m.rootCentre)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX)
        expect(Math.abs(m.dismissCentre - m.rootCentre)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX)
        if (row.hasAction) {
          expect(m.actionHeight, 'the measured action is the 36px "Review" button').toBe(36)
          expect(Math.abs((m.actionCentre as number) - m.rootCentre)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX)
        } else {
          expect(m.actionCentre).toBeNull()
        }
      })
    }
  }

  // The narrow desktop Needs attention panel wraps the controls of most rows onto
  // their own line. Aligning controls that sit BESIDE the body must not pull
  // wrapped ones toward the text: the #3880 code review caught a `-mt-1.5`
  // version shrinking this gap from Row's 12px to 6px on three of the four
  // dashboard rows.
  test('desktop: controls that wrap onto their own line keep the row gap', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/design-system')
    const sample = page.getByTestId('ds-attention-list')
    await expect(sample.getByTestId(/^attention-dismiss-/)).toHaveCount(3)
    const m = await sample.evaluate((el) => {
      const li = el.querySelector('li') as HTMLElement
      const subtitle = li.querySelector('p.text-xs') as HTMLElement
      const trailing = (li.querySelector('[data-attention-dismiss]') as HTMLElement).closest('div.flex-shrink-0') as HTMLElement
      // Narrow the sample until the controls cannot sit beside the body (the
      // dashboard panel wraps rows with an action the same way): leave room
      // for the icon and gaps but not for the trailing slot.
      ;(el as HTMLElement).style.width = `${Math.ceil(trailing.getBoundingClientRect().width) + 40}px`
      const rowGap = parseFloat(getComputedStyle(trailing.parentElement as HTMLElement).rowGap)
      return {
        gap: trailing.getBoundingClientRect().top - subtitle.getBoundingClientRect().bottom,
        rowGap,
        wrapped: trailing.getBoundingClientRect().top >= subtitle.getBoundingClientRect().bottom,
      }
    })
    expect(m.wrapped, 'the narrowed row wraps its controls under the body').toBe(true)
    expect(Math.abs(m.gap - m.rowGap)).toBeLessThanOrEqual(1)
  })
})

/**
 * One trailing column. The dashboard mixed a dismissible "Needs setup" row
 * with a non-dismissible "Low balance" row, and the second row's badge and
 * action slid right by the dismiss's 40px, so neither lined up. The sample's
 * failure row has no dismiss, so this measures the real mixed shape: the
 * dismiss (or the reserved slot) ends every row on one edge, and the rows
 * with an action end their actions — and, at the shared minimum width, their
 * badges — on one edge too.
 */
const COLUMN_TOLERANCE_PX = 1

test.describe('AttentionList one trailing column', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('desktop: mixed dismissible rows share the trailing edges', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/design-system')
    const sample = page.getByTestId('ds-attention-list')
    await expect(sample.getByTestId(/^attention-dismiss-/)).toHaveCount(3)
    const rows = await sample.locator('li').evaluateAll((lis) =>
      lis.map((li) => {
        const end = li.querySelector('[data-attention-dismiss], [data-attention-dismiss-slot]') as HTMLElement | null
        const action = li.querySelector('button:not([data-attention-dismiss]), a') as HTMLElement | null
        const badge = action?.parentElement?.previousElementSibling as HTMLElement | null
        // The trailing wrapper is Row's only direct-child `div.flex-shrink-0`.
        const hasTrailing = li.querySelector(':scope > div > div.flex-shrink-0') !== null
        return {
          hasTrailing,
          isSlot: end?.hasAttribute('data-attention-dismiss-slot') ?? false,
          endRight: end ? end.getBoundingClientRect().right : null,
          endWidth: end ? end.getBoundingClientRect().width : null,
          actionRight: action ? action.getBoundingClientRect().right : null,
          // A badge-less action row's previousElementSibling is the sr-only
          // tone word, not a badge — no badge edge to align there (#4033).
          badgeRight: action && badge && !badge.className.includes('sr-only') ? badge.getBoundingClientRect().right : null,
        }
      }),
    )
    // Precondition: the list really is mixed — one reserved slot among Xs.
    expect(rows.filter((r) => r.isSlot)).toHaveLength(1)
    // A row with nothing visible to align (#4033) renders no trailing slot at
    // all — it has no edge to share and is not part of the column.
    expect(rows.filter((r) => !r.hasTrailing).length).toBe(1)
    const aligned = rows.filter((r) => r.hasTrailing)
    const ends = aligned.map((r) => r.endRight)
    expect(ends.every((x) => x !== null)).toBe(true)
    for (const r of aligned) {
      expect(r.endWidth).toBe(32)
      expect(Math.abs((r.endRight as number) - (ends[0] as number))).toBeLessThanOrEqual(COLUMN_TOLERANCE_PX)
    }
    const withAction = aligned.filter((r) => r.actionRight !== null)
    expect(withAction.length).toBeGreaterThanOrEqual(2)
    for (const r of withAction) {
      expect(Math.abs((r.actionRight as number) - (withAction[0].actionRight as number))).toBeLessThanOrEqual(COLUMN_TOLERANCE_PX)
    }
    const withBadge = withAction.filter((r) => r.badgeRight !== null)
    expect(withBadge.length).toBeGreaterThanOrEqual(2)
    for (const r of withBadge) {
      expect(Math.abs((r.badgeRight as number) - (withBadge[0].badgeRight as number))).toBeLessThanOrEqual(COLUMN_TOLERANCE_PX)
    }
  })
})

/**
 * A row with nothing visible to align (#4033): no badge, no action, not
 * dismissible. (It was the dashboard's `haven-paused` shape until #4324 made
 * that item dismissible and gave it a "Review" action; the sample keeps the
 * shape so the no-trailing path stays guarded.) It used to render a trailing
 * wrapper holding only the sr-only tone word: a 0px flex line that still took
 * `Row`'s 12px row gap below `sm` (and a 12px column gap from `sm` up), so
 * the row read as ~12px above the text and ~24px below. It renders no
 * trailing slot at all now and the tone word rides in the body — equal space
 * above the title and below the subtitle, at both measured widths.
 */
test.describe('AttentionList row with nothing to align (#4033)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  for (const vp of WIDTHS) {
    test(`${vp.name}: the nothing-to-align row has equal space above and below its body`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      const sample = page.getByTestId('ds-attention-list')
      await expect(sample.getByTestId(/^attention-dismiss-/)).toHaveCount(3)
      const li = sample.locator('li').filter({ hasText: 'No summary this week' })
      await expect(li).toHaveCount(1)
      const m = await li.evaluate((li) => {
        const root = li.querySelector(':scope > div') as HTMLElement
        const title = root.querySelector('p.font-medium') as HTMLElement
        const subtitle = root.querySelector('p.text-xs') as HTMLElement
        const tone = subtitle.querySelector('span.sr-only')
        const r = root.getBoundingClientRect()
        return {
          spaceAbove: title.getBoundingClientRect().top - r.top,
          spaceBelow: r.bottom - subtitle.getBoundingClientRect().bottom,
          hasTrailing: root.querySelector(':scope > div.flex-shrink-0') !== null,
          toneInBody: tone?.textContent === 'Informational',
        }
      })
      expect(m.hasTrailing, 'no trailing wrapper, not even a 0px one').toBe(false)
      expect(m.toneInBody, 'the tone word still exists, riding in the body').toBe(true)
      expect(Math.abs(m.spaceAbove - m.spaceBelow)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX)
    })
  }

  // The dismiss-only shape — a badge-less, dismissible row with no action —
  // put a lone × on its own line below `sm`. Since #4324 one product case has
  // it: `haven-paused` when the latest sponsorship refusal's agent is unknown
  // (an old response), which drops its "Review" action and stays
  // dismissible. That is accepted for the old-response fallback; the sample
  // does not draw it, so at 390px no row's trailing line holds nothing
  // visible but the dismiss.
  test('mobile width: no row renders a trailing line whose only visible content is the dismiss', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/design-system')
    const sample = page.getByTestId('ds-attention-list')
    await expect(sample.getByTestId(/^attention-dismiss-/)).toHaveCount(3)
    const rows = await sample.locator('li').evaluateAll((lis) =>
      lis.map((li) => {
        const root = li.querySelector(':scope > div') as HTMLElement
        const trailing = root.querySelector(':scope > div.flex-shrink-0')
        if (!trailing) return { dismissOnly: false }
        const visible = Array.from(trailing.children).filter((child) => !(child as HTMLElement).className.includes('sr-only'))
        const dismiss = trailing.querySelector('[data-attention-dismiss]')
        return { dismissOnly: Boolean(dismiss) && visible.length === 1 && visible[0] === dismiss }
      }),
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.dismissOnly, 'no lone-× trailing line').toBe(false)
    }
  })
})
