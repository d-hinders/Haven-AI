/**
 * The `/design-system` transaction row's title measure between `md` and `xl` (#1827).
 *
 * WHAT WAS BROKEN. At 768px the Failed row's title rendered in a **71.1px**
 * measure and stacked to **five lines** ("Failed / payment / by / Research /
 * assistant"), a 156px row. #1774/#1750 fixed the 320–430px half of the same
 * row and deliberately did not touch `md`+; this is that half.
 *
 * WHY A RANGE AND NOT ONE BREAKPOINT. The issue described it as happening "at
 * exactly 768px". Measurement says otherwise, and the shape of the answer
 * depends on it: the app shell's sidebar appears at `lg`, so the CONTENT width
 * available to this table is a SAWTOOTH in viewport width, not a ramp.
 * Measured on `dev`, Failed row, title measure / lines / row height:
 *
 *     767px   515.0px / 1 / 80     (below md: four columns, ellipsised)
 *     768px    71.1px / 5 / 156    <- defect
 *     800px    82.5px / 4 / 132
 *     900px   118.0px / 3 /  92
 *    1023px   161.8px / 2 /  84
 *    1024px    71.1px / 5 / 156    <- defect AGAIN: the sidebar lands
 *    1100px    98.1px / 4 / 112
 *    1279px   161.8px / 2 /  84
 *    1280px   162.1px / 2 /  84
 *
 * 768px and 1024px are byte-identical because both leave the table 717.9px of
 * content. A fix keyed to "the md breakpoint" would have left 1024px broken.
 * That is why this sweep covers a BAND, and why the fix defers columns to `xl`
 * — the first viewport where content is ≥ 974px on BOTH teeth of the sawtooth.
 *
 * WHY GEOMETRY AND NOT A SCREENSHOT — the same reason as
 * `transaction-row.mobile.spec.ts`: the *Design visual regression* job renders
 * `/design-system` at 1280 and 390 ONLY (`scripts/evidence-viewports.mjs`).
 * Every width this spec is about is between those two. No pixel gate can see
 * this defect, before or after.
 *
 * BOTH HALVES ARE ASSERTED TOGETHER, DELIBERATELY. Asserting only the measure
 * would pass for a "fix" that gives the title room by stacking the row taller;
 * asserting only the row height would pass for one that ellipsises the title
 * to nothing. #1827's own history has both failure modes in it — pinning the
 * `md`+ columns was tried during #1774 and grew desktop rows 85px -> 133px
 * while "fixing" the measure. So the band asserts measure ≥ floor AND lines ≤
 * 2 AND row height ≤ ceiling, and the desktop check asserts measure ≥ floor
 * AND row height ≤ ceiling at 1280 in the same breath.
 */
import { expect, test } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

/**
 * The band where all seven columns used to be revealed at once. Both teeth of
 * the sawtooth are in it: 768 (no sidebar, content 717.9px) and 1024 (sidebar
 * arrives, content back to 717.9px).
 */
const BAND_WIDTHS = [768, 800, 900, 1024, 1100, 1279] as const

/** The width the visual baselines are rendered at. Its numbers must not move. */
const DESKTOP_WIDTH = 1280

/**
 * Floors and ceilings, all chosen from measurement rather than taste.
 *
 * MEASURED AFTER THE FIX, Failed row: measure 141.7px at both 768 and 1024
 * (the band's worst), 247.3px at 1279; two lines everywhere in the band; row
 * height 100–101px in the band. BEFORE: 71.1px / 5 lines / 156px.
 *
 * 120 / 2 / 120 sits clear of the fixed values and clear of the defect on
 * every axis, so ordinary text-metric drift cannot move it and a regression
 * cannot hide under it.
 *
 * ONE CAVEAT, stated so the next person does not quietly widen it. The numbers
 * above are macOS-rendered; CI is Linux, where text metrics differ. The measure
 * and height bounds carry 15–20% headroom, but `MAX_TITLE_LINES = 2` carries
 * NONE by construction — the fixed layout wraps to exactly two lines at 768px.
 * If this goes red on CI and only on CI, the correct response is to find out
 * why the measure is tighter there, not to bump the ceiling to 3: at 900px the
 * defect state WAS three lines, so a ceiling of 3 would stop this spec seeing
 * it, and the measure floor's margin at that width is only 2px (118 -> 120).
 * The line ceiling is what makes 900px a real check.
 */
const MIN_TITLE_MEASURE_PX = 120
const MAX_TITLE_LINES = 2
const MAX_ROW_HEIGHT_PX = 120

/**
 * Desktop density. MEASURED at 1280 both before and after the fix, and
 * IDENTICAL: measure 162.1px, 2 lines, row height 84–85px. The fix defers
 * columns below `xl` only, so 1280 renders exactly what it rendered before and
 * no visual baseline moves. These bounds are what stops a later change from
 * buying band headroom with desktop paint.
 */
const DESKTOP_MIN_TITLE_MEASURE_PX = 150
const DESKTOP_MAX_ROW_HEIGHT_PX = 90

type TitleReading = {
  text: string
  measure: number
  lines: number
  rowHeight: number
  hasBadge: boolean
  truncated: boolean
}

/**
 * Anchor on the title `<p title=…>` inside a `tbody` row and walk up, never on
 * a class string — trap 1 from `transaction-row.mobile.spec.ts`, and this fix
 * is again a change of which cells render.
 *
 * `getClientRects().length` filters the `hidden xl:table-cell` copies, which
 * are in the DOM with their text intact and measure 0x0 — trap 2 from the same
 * file. Line count comes from a Range's client rects (one box per line box),
 * not from dividing height by a guessed line-height.
 */
async function readTitles(page: import('@playwright/test').Page): Promise<TitleReading[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => el.getClientRects().length > 0
    return Array.from(document.querySelectorAll('tbody tr'))
      .filter(visible)
      .map((tr) => {
        const p = tr.querySelector('p[title]')
        if (!p || !visible(p)) return null
        const range = document.createRange()
        range.selectNodeContents(p)
        const lines = new Set(
          Array.from(range.getClientRects()).map((r) => Math.round(r.top)),
        ).size
        // The badge is what makes this row the hard case: it is held on the
        // title's line and takes 58px of the measure. A reading taken from a
        // row that lost its badge would be about a different layout.
        const hasBadge = Array.from(tr.querySelectorAll('*')).some(
          (el) => visible(el) && (el.textContent ?? '').trim() === 'Failed' && el !== p,
        )
        return {
          text: (p.textContent ?? '').trim(),
          measure: +p.getBoundingClientRect().width.toFixed(1),
          lines,
          rowHeight: +tr.getBoundingClientRect().height.toFixed(1),
          hasBadge,
          // Ellipsised rather than shown in full. This is what stops the
          // measure floor from being satisfiable by clipping the title down
          // to one short line (see STARVED below).
          truncated: p.scrollWidth > p.clientWidth + 1,
        }
      })
      .filter((r): r is TitleReading => r !== null)
  })
}

test('/design-system: the transaction title keeps a readable measure across the md–xl band', async ({
  page,
}) => {
  // `/design-system` is ~29,000px tall and re-lays out on every width here.
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await page.goto('/design-system')
  await page.waitForSelector('tbody tr', { timeout: 60_000 })

  for (const width of [...BAND_WIDTHS, DESKTOP_WIDTH]) {
    await page.setViewportSize({ width, height: 900 })
    // Settle until two consecutive reads agree. A fixed wait produced a STALE
    // reading (1440 byte-identical to 1280) while this fix was being measured,
    // which is a silent wrong answer rather than a failure.
    let readings = await readTitles(page)
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(150)
      const again = await readTitles(page)
      if (JSON.stringify(again) === JSON.stringify(readings)) break
      readings = again
    }

    // Without this the spec passes vacuously the moment the showcase markup
    // moves under it — and this fix IS a change of which cells render.
    expect(readings.length, `@${width}px: no transaction title rendered to measure`).toBeGreaterThan(0)

    const failed = readings.find((r) => r.text.startsWith('Failed payment'))
    expect(failed, `@${width}px: the Failed showcase row is not rendering`).toBeDefined()
    // The badge is the whole reason this row is the tight one (#1827). Without
    // it the measure would be healthy for a reason the fix had nothing to do
    // with, and the assertions below would prove nothing.
    expect(failed!.hasBadge, `@${width}px: the Failed badge is not rendered`).toBe(true)

    const isDesktop = width === DESKTOP_WIDTH
    const minMeasure = isDesktop ? DESKTOP_MIN_TITLE_MEASURE_PX : MIN_TITLE_MEASURE_PX
    const maxHeight = isDesktop ? DESKTOP_MAX_ROW_HEIGHT_PX : MAX_ROW_HEIGHT_PX

    for (const reading of readings) {
      // STARVED: the title did not get the room its content asked for — it
      // wrapped, or it was clipped. A one-line title rendered in full is not
      // starved however narrow its box is ("Received payment" is 125.2px of
      // content inside a 199.8px cell at 768px), and holding it to a floor
      // would assert about the string rather than the layout.
      //
      // `truncated` is the half that matters: without it, "wrapped" alone
      // would exempt exactly the regression this floor exists to catch —
      // ellipsising a long title to one short line.
      const starved = reading.lines > 1 || reading.truncated
      // Both halves, together and per width. Either one alone is satisfiable
      // by a change that destroys the other.
      if (starved) {
        expect(
          reading.measure,
          `@${width}px: "${reading.text}" measures ${reading.measure}px`,
        ).toBeGreaterThanOrEqual(minMeasure)
      }
      expect(
        reading.lines,
        `@${width}px: "${reading.text}" wraps to ${reading.lines} lines`,
      ).toBeLessThanOrEqual(MAX_TITLE_LINES)
      expect(
        reading.rowHeight,
        `@${width}px: "${reading.text}" row is ${reading.rowHeight}px tall`,
      ).toBeLessThanOrEqual(maxHeight)
    }
  }
})

/**
 * The instrument's control, kept in the suite rather than in a commit message.
 *
 * `TransactionsTable` on `/transactions` is the component this showcase
 * documents, it renders correctly across this whole band, and it reaches a
 * readable result a DIFFERENT way — it truncates to one line unconditionally
 * (measured 89.6px at 768px, 225.1px at 1280px, always 1 line). So a reading
 * of "2 lines, 141.7px" from the showcase is a reading and not silence: the
 * same probe, on the same page structure, reports the healthy shape here.
 *
 * The showcase's floor deliberately does NOT apply: 89.6px is a correct
 * ellipsised measure for a component whose title is one line with a `title`
 * tooltip. What is asserted is the property the two share.
 */
test('/transactions: the control the showcase is measured against reads healthy', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await page.goto('/transactions')
  await page.waitForSelector('tbody tr', { timeout: 60_000 })

  for (const width of [768, 1024, DESKTOP_WIDTH]) {
    await page.setViewportSize({ width, height: 900 })
    let readings = await readTitles(page)
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(150)
      const again = await readTitles(page)
      if (JSON.stringify(again) === JSON.stringify(readings)) break
      readings = again
    }

    expect(readings.length, `@${width}px: no /transactions title rendered to measure`).toBeGreaterThan(0)
    for (const reading of readings) {
      expect(reading.measure, `@${width}px: "${reading.text}" measured 0`).toBeGreaterThan(0)
      expect(
        reading.lines,
        `@${width}px: "${reading.text}" wraps to ${reading.lines} lines`,
      ).toBeLessThanOrEqual(MAX_TITLE_LINES)
    }
  }
})
