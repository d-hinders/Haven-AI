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
 * The `SendModal` measurement that used to live here is DELETED (#1989, epic
 * #1440), together with its subject.
 *
 * It drove `/dashboard` → Send → the review step, then clamped a live
 * `TransactionMovement` on `/approvals` to the modal's measured width. Both
 * surfaces are gone with the legacy Safe rail: `SendModal`, `useSendTransaction`
 * and `ApprovalQueue` are deleted and `/approvals` no longer routes.
 *
 * Deleted rather than repointed at `DelegationSendModal`, deliberately. The
 * test's own recorded result was that the mutation it was written to catch
 * PASSES at `SendModal`'s width — 310px is roughly double the ~150px where the
 * arrow can strand — so it was kept only for being width-ADAPTIVE against a
 * future narrowing of a modal that no longer exists. Repointing it at a
 * different modal would carry the shape across while quietly re-baselining the
 * number it exists to keep honest, and would assert nothing the two route
 * sweeps above do not already assert at 320/390/393px.
 *
 * What the route sweeps still cover is unchanged: they are the assertions that
 * go red on the #1774 defect, and they were never the SendModal test's.
 */

/**
 * The amount rides UNDER the title below `md` (#2734).
 *
 * WHAT WAS BROKEN. `/transactions` rendered the amount as its own 110px column
 * at every width. The activity column is the only flexible one, so those 110px
 * plus gutters came straight off the title and the movement line: at 390px the
 * title had ~117px and wrapped to three lines ("Agent payment / by Research /
 * agent"), and the same shape rendered inside the agent detail's Recent
 * activity, which embeds this table.
 *
 * TWO ASSERTIONS, AND THE STRUCTURAL ONE IS THE LOAD-BEARING HALF. A line-count
 * ceiling alone is satisfiable by anything that gives the title room —
 * including shrinking the amount column rather than collapsing it, which is a
 * different change with a different desktop cost. So this also asserts WHERE
 * the amount is: in the same cell as the title. That is the property the fix
 * actually has, and it is the one a later refactor would silently drop.
 *
 * WHY NOT A SCREENSHOT: the same reason as every other reading in this file —
 * the visual gate renders `/design-system` at 1280 and 390 with a
 * `maxDiffPixelRatio` budget a whole row can move inside (#1805).
 */
// `/transactions` only, and the omission is deliberate rather than an
// oversight. #2734 names `/agents/agent-research` too, and the fix does reach
// it — the agent detail renders THIS component with
// `columns={['direction','activity','fromTo','date','amount','link']}`, so the
// amount column it collapses is the same one. What is missing is a way to
// DRIVE that route: `e2e/fixtures/haven-api.ts` serves no agent detail, and
// `/agents/agent-research` exists only in the screenshot harness's fixtures.
// Adding an agent to the shared e2e fixture is a change every other spec
// inherits, and it is outside this issue's file list. Recorded as an
// unasserted screen rather than covered by an assertion that cannot run; the
// `/design-system` legs above exercise the component in a second context.
for (const route of ['/transactions'] as const) {
test(`${route}: the amount rides under the title below md, and the title stops wrapping to three lines (#2734)`, async ({
  page,
}) => {
  const errors = collectBrowserErrors(page)
  await seedAuthenticatedSession(page)
  await mockHavenApi(page)
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(route)
  await dismissMobileSidebar(page)
  // `tbody tr`, not `getByRole('table')`: the LOADING SKELETON is also a table
  // with rows, and it has no title `<p>`, so waiting on the role measured the
  // skeleton and produced zero readings. The zero-guard below caught it, which
  // is the only reason this is a comment and not a false green.
  await page.waitForSelector('tbody tr td p', { timeout: 60_000 })

  const rows = await page.evaluate(() => {
    const visible = (el: Element) => el.getClientRects().length > 0
    return Array.from(document.querySelectorAll('tbody tr'))
      .filter(visible)
      .map((tr) => {
        const p = Array.from(tr.querySelectorAll('p')).filter(visible)[0]
        if (!p) return null
        const range = document.createRange()
        range.selectNodeContents(p)
        // Distinct rounded tops = line boxes, the idiom
        // `transaction-title-measure.spec.ts` established.
        const lines = new Set(
          Array.from(range.getClientRects()).map((r) => Math.round(r.top)),
        ).size
        const titleCell = p.closest('td')
        // Anchor on the rendered currency text, not on a class or a component
        // name: this file's own lesson is that a probe written against the
        // shape it was made for finds nothing after the shape changes.
        const amount = Array.from(tr.querySelectorAll('*')).filter(
          (el) =>
            visible(el) &&
            el.children.length === 0 &&
            /USDC|ETH/.test((el.textContent ?? '').trim()),
        )[0]
        return {
          text: (p.textContent ?? '').trim(),
          lines,
          cellWidth: titleCell ? +titleCell.getBoundingClientRect().width.toFixed(1) : 0,
          amountVisible: amount !== undefined,
          amountInTitleCell: amount !== undefined && amount.closest('td') === titleCell,
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
  })

  // Zero rows would pass every assertion below. Make the reading visible.
  expect(rows.length).toBeGreaterThan(0)

  // `expect.soft` so ONE run reports every property that broke. With hard
  // assertions the structural one fires first and aborts the loop, which is
  // how you end up unable to say whether the line ceiling is load-bearing —
  // measured: on the pre-#2734 component the structural check reddened and the
  // line count was never reached.
  for (const row of rows) {
    expect.soft(row.amountVisible, `no amount rendered for "${row.text}"`).toBe(true)
    expect
      .soft(row.lines, `"${row.text}" wraps to ${row.lines} lines at 390px`)
      .toBeLessThanOrEqual(2)
    expect
      .soft(
        row.amountInTitleCell,
        `the amount for "${row.text}" is still in its own column below md`,
      )
      .toBe(true)
  }

  // Printed, not asserted on its own: the number is what tells the next reader
  // whether the floor in MIN_ACTIVITY_CELL_PX above is still nowhere near the
  // real value.
  console.log(`${route} activity cell at 390px: ${rows.map((r) => r.cellWidth).join(', ')}px`)

  expect(unexpectedBrowserErrors(errors)).toEqual([])
})
}
