/**
 * The mobile transaction row's two horizontal-space defects (#1774, #1750).
 *
 * Both were found by measuring the same surface, and both are about the row
 * running out of width — so they are gated together here.
 *
 * WHY THESE ASSERTIONS AND NOT A SCREENSHOT: the *Design visual regression*
 * job compares `/design-system` with `maxDiffPixelRatio: 0.005` against a
 * ~29,000px-tall capture, which is a budget of ~56,000 pixels (#1805). A
 * transaction row can change shape completely inside that noise floor — the
 * three showcase rows collapsing from 233px to 181px is well under it. A green
 * pixel gate is not evidence about this row; these numbers are.
 *
 * TWO TRAPS PAID FOR ALREADY, both of which produce a guard that cannot fail:
 *
 *   1. Anchor on the ARROW GLYPH and walk up, never on a class string. The
 *      whole fix for #1774 is a change of nesting, so a probe written against
 *      `span.flex > [aria-hidden]` measures the shape it was written for and
 *      silently finds nothing afterwards — zero movements is not zero orphans.
 *      `expect(movements.length).toBeGreaterThan(0)` is what makes the
 *      difference visible.
 *   2. A `hidden md:table-cell` element is still in the DOM with its text
 *      intact and measures 0x0 — indistinguishable from "squeezed to nothing"
 *      by width alone (#1289 FYI 4). `/transactions` renders the movement
 *      TWICE below md: once in the activity cell and once in the hidden
 *      desktop `From / To` column. Filter on `getClientRects().length`, or the
 *      hidden copy reports a 0-width, single-line, "orphaned" arrow and the
 *      suite fails on a phantom.
 */
import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

/**
 * Widths swept inside the mobile project. This is a GEOMETRY sweep, which is
 * exactly what `mobile-nav-layering.mobile.spec.ts` established as legitimate
 * here — it compares rectangles, not pixels, so resizing away from Pixel 5's
 * 393 costs nothing. 320 is the narrowest phone still in the support matrix
 * and is where every one of these numbers is worst.
 */
const WIDTHS = [320, 390, 393] as const

/**
 * The floor the Activity cell must clear at 390px. Chosen from measurement,
 * not from taste: after the fix it measures 106px on `/transactions` and 106px
 * on the `/design-system` showcase, and before it, the showcase's cell was
 * **13px** — a 250px title ellipsised to nothing. 64px sits well clear of the
 * real value and well above the defect, so ordinary text-metric drift cannot
 * move it while a re-collapse cannot hide under it.
 */
const MIN_ACTIVITY_CELL_PX = 64

type Movement = {
  arrowWidth: number
  arrowAlone: boolean
  parts: number
}

async function readMovements(page: import('@playwright/test').Page): Promise<Movement[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => el.getClientRects().length > 0

    // Anchor on the glyph, then walk up to whichever ancestor first holds both
    // halves. Structural, so it survives the nesting change it exists to gate.
    const arrows = Array.from(document.querySelectorAll('[aria-hidden="true"]'))
      .filter((el) => (el.textContent ?? '').trim() === '→')
      .filter(visible)

    return arrows
      .map((arrow) => {
        let root: Element | null = arrow
        while (root) {
          const text = root.textContent ?? ''
          if (text.includes('From ') && text.includes('To ')) break
          root = root.parentElement
        }
        if (!root || !visible(root)) return null

        // The labelled HALF — the block holding `From ` AND its value — not
        // the label-only `<span>From </span>` inside it, and not the wrapper
        // that also contains the arrow.
        //
        // Getting this wrong makes the guard fail on the FIXED layout: the
        // point of `items-end` is that when the value wraps, the arrow sits
        // beside its LAST line, and a box that covers only the label stays on
        // line 1 — so the overlap test would report `arrowAlone` for exactly
        // the shape the fix produces. Excluding any ancestor of the arrow is
        // what stops the search from short-circuiting to a box that contains
        // the arrow and therefore overlaps it trivially.
        const half = (prefix: string) => {
          const depth = (el: Element) => {
            let d = 0
            for (let n = el.parentElement; n && n !== root; n = n.parentElement) d += 1
            return d
          }
          return Array.from(root.querySelectorAll('*'))
            .filter(
              (el) => (el.textContent ?? '').trim().startsWith(prefix) && !el.contains(arrow),
            )
            .sort((a, b) => depth(a) - depth(b))[0]
        }

        const parts = [half('From '), half('To ')].filter(
          (el): el is Element => el !== undefined && visible(el),
        )
        const arrowRect = arrow.getBoundingClientRect()

        // "Alone on its line" is a vertical-band question, not a line-count
        // one: the arrow is orphaned exactly when no labelled half overlaps
        // its band. Comparing rounded `y` instead would call an arrow that is
        // one subpixel off its neighbour's top an orphan.
        const arrowAlone = !parts.some((el) => {
          const r = el.getBoundingClientRect()
          return r.top < arrowRect.bottom && arrowRect.top < r.bottom
        })

        return { arrowWidth: +arrowRect.width.toFixed(1), arrowAlone, parts: parts.length }
      })
      .filter((m): m is Movement => m !== null)
  })
}

async function activityCellWidths(page: import('@playwright/test').Page): Promise<number[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('tbody tr td'))
      .filter((td) => td.getClientRects().length > 0 && td.querySelector('p[title]'))
      .map((td) => +td.getBoundingClientRect().width.toFixed(1)),
  )
}

for (const route of ['/transactions', '/design-system'] as const) {
  test(`${route}: the movement arrow never sits alone on its own line`, async ({ page }) => {
    // `/design-system` is a very long page and both routes re-layout on every
    // width in the sweep; the default 60s is comfortable on CI and marginal on
    // a loaded dev machine.
    test.slow()
    const errors = collectBrowserErrors(page)
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    await page.goto(route)
    await page.waitForSelector('tbody tr', { timeout: 60_000 })
    await dismissMobileSidebar(page)

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 })
      // Let the table re-layout before reading rectangles off it.
      await page.waitForTimeout(200)

      const movements = await readMovements(page)

      // Without this the suite passes vacuously the moment the markup moves
      // under it — the #1774 fix is itself a markup move.
      expect(movements.length, `${route} @${width}px: no movement rendered to measure`).toBeGreaterThan(0)

      for (const movement of movements) {
        expect(movement.parts, `${route} @${width}px: movement lost a labelled half`).toBe(2)
        // A zero-width arrow is invisible without being absent, which would
        // satisfy "never alone" for the wrong reason (#1749's `w-8` trap).
        expect(movement.arrowWidth, `${route} @${width}px: arrow squeezed to nothing`).toBeGreaterThan(4)
        expect(movement.arrowAlone, `${route} @${width}px: arrow orphaned on its own line`).toBe(false)
      }
    }

    expect(unexpectedBrowserErrors(errors)).toEqual([])
  })

  test(`${route}: the activity cell keeps a readable measure at 390px`, async ({ page }) => {
    test.slow()
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    await page.goto(route)
    await page.waitForSelector('tbody tr', { timeout: 60_000 })
    await dismissMobileSidebar(page)

    await page.setViewportSize({ width: 390, height: 900 })
    await page.waitForTimeout(200)

    const widths = await activityCellWidths(page)

    expect(widths.length, `${route}: no activity cell rendered to measure`).toBeGreaterThan(0)
    for (const width of widths) {
      expect(width, `${route}: activity cell collapsed to ${width}px`).toBeGreaterThanOrEqual(
        MIN_ACTIVITY_CELL_PX,
      )
    }
  })
}

/**
 * `SendModal` is the one consumer of `TransactionMovement` that no URL reaches
 * and no screenshot scenario exists for (#1409's shape), so it had never been
 * measured at any width — the gap `haven-design-reviewer` named on #1835.
 *
 * It is also plausibly the TIGHTEST consumer, not the loosest: the modal is
 * `w-full max-w-md mx-4` (SendModal.tsx:427), so at 390px it is 358px, and the
 * review body is `p-6` (:834) with the movement inside a `-mx-6 ... px-6` block
 * (:847). That leaves the component LESS room than `ApprovalQueue`'s `p-4`
 * panel, which does have rendered evidence. Waiving it as "the wider case"
 * would have skipped the more dangerous one.
 *
 * The review step cannot be driven under the standard fixture — `Continue` is
 * `disabled` while `signingUnavailable`, and the fixture account's passkey is
 * on another device. So this measures the modal's real content width from the
 * step that IS reachable (same block geometry either way), then applies that
 * width to a REAL `TransactionMovement` instance and asserts the same two
 * properties the route guards assert.
 *
 * Deliberately NOT a hardcoded 310px. A constant copied out of a class-name
 * calculation is exactly the sort that quietly stops matching the layout; this
 * reads the number off the running modal every time.
 *
 * This is a headless equivalent, NOT a substitute for rendered evidence. A PNG
 * of the real review step is still owed and is filed separately.
 */
test('SendModal: the movement holds its shape at the modal measured width', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/dashboard')
  await page.waitForSelector('main', { timeout: 60_000 })
  await dismissMobileSidebar(page)

  await page.getByRole('button', { name: /^Send$/i }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Send payment' })
  await dialog.waitFor({ timeout: 30_000 })

  const modalContentWidth = await dialog.evaluate(
    (el) => +(el.getBoundingClientRect().width - 48).toFixed(1),
  )

  // MEASURED: 310px at a 390px viewport. That is the number this test exists
  // to keep honest, and it carries a result that inverts the concern which
  // prompted it.
  //
  // MUTATION EVIDENCE, reported because it PASSED and that is informative:
  // flattening `TransactionMovement` back to the orphaning three-sibling shape
  // leaves these assertions GREEN. The test is not weak — the assertions are
  // the same ones that go red on `/transactions` and `/design-system`. The
  // mutated line is simply NOT EXERCISED at this width: the arrow can only
  // strand below roughly 150px of container, and `SendModal` gives the
  // primitive about double that. `From Operating wallet` (168px) + an 8px gap
  // + a 17px arrow is 193px, which fits on one line inside 310px with room to
  // spare.
  //
  // So the reviewer's worry that `SendModal` might be the TIGHTER and
  // therefore more dangerous consumer is half right and half wrong: it IS
  // tighter than `ApprovalQueue`'s `p-4` panel, and it is still comfortably
  // above the threshold where #1774's defect can appear. That was established
  // by measuring, not by arguing from class names.
  //
  // The test is kept rather than deleted because it is width-ADAPTIVE: it
  // reads the modal's real width every run, so if `SendModal` is ever narrowed
  // to where the defect can bite, these assertions start doing real work
  // automatically. What it must not be read as today is proof that the fix is
  // what keeps this surface correct — the width is.
  expect(modalContentWidth).toBeGreaterThan(200)
  expect(modalContentWidth).toBeLessThan(390)

  await page.keyboard.press('Escape')

  await page.goto('/approvals')
  await page.waitForSelector('main', { timeout: 60_000 })
  await dismissMobileSidebar(page)
  // `main` resolves before the approval card's data has rendered, so wait for
  // the glyph itself rather than the shell — otherwise the clamp finds nothing
  // and the test fails for a reason that has nothing to do with geometry.
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('[aria-hidden="true"]')).some(
        (el) => (el.textContent ?? '').trim() === '\u2192' && el.getClientRects().length > 0,
      ),
    undefined,
    { timeout: 30_000 },
  )

  const clamped = await page.evaluate((width) => {
    const arrow = Array.from(document.querySelectorAll('[aria-hidden="true"]')).find(
      (el) => (el.textContent ?? '').trim() === '\u2192' && el.getClientRects().length > 0,
    )
    if (!arrow) return false
    let root: Element | null = arrow
    while (root) {
      const t = root.textContent ?? ''
      if (t.includes('From ') && t.includes('To ')) break
      root = root.parentElement
    }
    if (!root || !(root.parentElement instanceof HTMLElement)) return false
    root.parentElement.style.width = width + 'px'
    root.parentElement.style.maxWidth = width + 'px'
    return true
  }, modalContentWidth)

  expect(clamped, 'no live TransactionMovement found on /approvals to clamp').toBe(true)
  await page.waitForTimeout(200)

  const movements = await readMovements(page)
  expect(movements.length).toBeGreaterThan(0)
  for (const movement of movements) {
    expect(movement.parts, 'at ' + modalContentWidth + 'px: movement lost a labelled half').toBe(2)
    expect(movement.arrowWidth, 'at ' + modalContentWidth + 'px: arrow squeezed to nothing').toBeGreaterThan(4)
    expect(movement.arrowAlone, 'at ' + modalContentWidth + 'px: arrow orphaned on its own line').toBe(false)
  }
})
