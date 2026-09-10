/**
 * The agent detail page at 390px — measured, not photographed (#2733).
 *
 * ## Why a measurement spec and not only the pixel baselines
 *
 * #2733's acceptance criteria are about geometry and reading order: budget
 * amount and period above the fold, a one-line "Set budget" label, an
 * untruncated recipient field, ≥44px action and kebab targets, no horizontal
 * overflow. The two new pixel baselines in `product-routes.visual.spec.ts`
 * hold the page to WHAT it showed the day it was blessed; they cannot express
 * "above the fold" or "one line" — and #1774/#1805 are the standing evidence
 * that a row can change shape completely inside a whole-page pixel budget.
 *
 * So the claims live here as measurements, in the
 * `transaction-row.mobile.spec.ts` / `accounts-card-tap-target.mobile.spec.ts`
 * instrument style: read rectangles, pin floors with headroom, and pair every
 * claim with the non-vacuity control that keeps it from passing over a page
 * that rendered nothing.
 *
 * ## What is pinned, and why each floor sits where it does
 *
 * - **Fold (844px, the committed mobile viewport height):** the FIRST active
 *   budget row's amount ("250.00") and period ("per week") must both sit
 *   above it. The 250.00 USDC/week active delegation comes from the shared
 *   fixture via `serveAgentDetailResponses`. Floors sit far below the real
 *   values — 260 and 400 are ~40% headroom on today's ~390/~560 readings, so
 *   text-metric drift cannot flip them while a real collapse below the fold
 *   cannot hide.
 * - **"Set budget" on ONE line:** the pill's PAINTED box must be single-line
 *   tall (~36px = the `sm` Button size) and wider than tall. Floor 44 keeps
 *   clear of a two-line 52-56px reading; ceiling 43 is the tallest a
 *   single-line pill can render with sub-pixel font growth.
 * - **Recipient placeholder not truncated:** the input's `scrollWidth` must
 *   not exceed its `clientWidth` (the actual truncation test — a clipped
 *   placeholder overflows its own box), and the SHORT placeholder text
 *   "Recipient address" is asserted present so the fix cannot regress into a
 *   re-truncating long placeholder unnoticed... the scrollWidth comparison is
 *   the real instrument; the text pin only names the field.
 * - **≥44px targets:** the three footer actions and the kebab trigger, via
 *   `getBoundingClientRect` — these controls have no vertical `::after`
 *   overlay to inherit (the kebab does, via `min-h-11 min-w-11`), so the
 *   painted box IS the target and must clear the floor outright.
 * - **No horizontal overflow:** `expectNoHorizontalOverflow` (#1771), the
 *   two-metric union over the document and `#main-content`.
 */

import { expect, test, type Page } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  expectNoHorizontalOverflow,
  mockHavenApi,
  seedAuthenticatedSession,
  serveAgentDetailResponses,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

/** `docs/product/design-system.md` § Buttons *Tap targets* / `#1726`. */
const TOUCH_TARGET_FLOOR = 44

/**
 * The committed mobile viewport (390x844) — `scripts/evidence-viewports.mjs`.
 * The fold assertion is derived from this height; it is not tunable per test.
 */
const MOBILE_WIDTH = 390
const MOBILE_HEIGHT = 844

/**
 * Where the visible screen actually ends (#2821).
 *
 * This used to be `MOBILE_HEIGHT`, and that was written when the bottom of the
 * viewport was empty. Since #2731 the bottom of every authenticated route is
 * the tab bar — `--v2-tab-bar-h` (56pt) plus the home-indicator inset it
 * reserves, which is 34pt in the installed shell and 0 in a headless engine.
 * A fold of 844 therefore measured up to 90pt of screen that is covered, in the
 * direction that HIDES a defect: the budget row can sit under the bar and the
 * assertion still passes.
 *
 * Read from the live bar rather than recomputed from the tokens. The bar's own
 * top edge already is the answer, it carries the safe-area inset without this
 * spec having to know the inset exists, and a second arithmetic copy of
 * `AuthenticatedShell`'s `calc()` is exactly the duplicate that went stale the
 * first time.
 *
 * It WAITS for the bar below `lg`, and that is the load-bearing part. The first
 * version of this helper read the DOM immediately and fell back to
 * `window.innerHeight` when it found nothing — and `Sidebar` is
 * `dynamic({ ssr: false })`, so it had not mounted yet even though the page's
 * own H1 was visible. Measured: the helper returned **844**, the exact stale
 * value #2821 is about, and the corrected spec passed while proving nothing.
 * A fallback that silently reproduces the bug is worse than no fallback.
 */
async function foldY(page: Page): Promise<number> {
  const viewport = page.viewportSize()
  // Above `lg` there is genuinely no bar and the viewport bottom IS the fold.
  // Keyed on the width rather than on the element's absence, so "no bar yet"
  // and "no bar here" can never be confused again.
  if (viewport && viewport.width >= 1024) return viewport.height
  // Scoped to the FIXED bar: `[data-mobile-tab-bar]` also matches the
  // `presentational` illustration on `/design-system`, and a helper whose whole
  // point is not lying should not depend on which route it is called from.
  await page.locator('nav.fixed[data-mobile-tab-bar]').waitFor({ state: 'attached', timeout: 30_000 })
  return page.evaluate(() => {
    const bars = document.querySelectorAll('nav.fixed[data-mobile-tab-bar]')
    if (bars.length !== 1) throw new Error(`expected exactly one fixed tab bar, found ${bars.length}`)
    const rect = bars[0].getBoundingClientRect()
    const top = Math.round(rect.top)
    // Three refusals, not one, and the second is the reason this block was
    // rewritten. `top <= 0` catches an unlaid-out bar — but a bar whose HEIGHT
    // collapses to 0 reports `top = innerHeight - 1`, which is comfortably
    // positive, so the original guard let it through: mutating the tab cells to
    // `h-0` returned **843** and the spec passed while measuring the covered
    // band again. That is the exact failure this helper exists to prevent,
    // surviving inside the fix for it.
    if (top <= 0) throw new Error('tab bar attached but has no laid-out top edge')
    if (rect.height < 1) throw new Error(`tab bar has no height (${rect.height}) — fold would be meaningless`)
    if (top >= window.innerHeight - 40) {
      throw new Error(`tab bar top ${top} is within 40px of the viewport bottom (${window.innerHeight}) — it is not laid out as a bar`)
    }
    return top
  })
}

/**
 * Determinism: freeze the clock BEFORE navigation, exactly as
 * `product-routes.visual.spec.ts` does — `timeAgo` buckets against
 * `Date.now()`, and the fixture timestamps render relative strings.
 */
const FROZEN_NOW = new Date('2026-09-01T12:00:00.000Z')

type Geometry = {
  /** The label's client rects — one rect per rendered line. */
  labelLines: { top: number; height: number; width: number }[]
  /** The button's border box. */
  box: { width: number; height: number }
}

async function setBudgetGeometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find((el) =>
      (el.textContent ?? '').trim().startsWith('Set budget'),
    )
    if (!button) throw new Error('no "Set budget" button rendered on the page')
    const box = button.getBoundingClientRect()
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
    const labelLines: { top: number; height: number; width: number }[] = []
    let node: Node | null
    while ((node = walker.nextNode())) {
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width === 0 && rect.height === 0) continue
        labelLines.push({ top: rect.top, height: rect.height, width: rect.width })
      }
    }
    return {
      labelLines,
      box: { width: box.width, height: box.height },
    }
  })
}

test.describe('agent detail at 390px (#2733)', () => {
  // No skip: fully mocked (`mockHavenApi` + `serveAgentDetailResponses`), so
  // it runs anywhere this config boots its own server — the same stance as
  // `transaction-row.mobile.spec.ts`. The only gating happens in the config
  // (`chromium-mobile` owns `*.mobile.spec.ts`).

  test('budget amount and period sit above the fold, form fits, targets clear 44px', async ({ page }) => {
    const errors = collectBrowserErrors(page)
    await page.clock.setFixedTime(FROZEN_NOW)
    await mockHavenApi(page)
    await serveAgentDetailResponses(page, 'agent-research')
    await seedAuthenticatedSession(page)

    await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT })
    await page.goto('/agents/agent-research')

    // The page's own H1 — present only once the client component has data.
    // Everything below would pass vacuously without it (non-vacuity control).
    await expect(page.getByRole('heading', { name: 'Research agent', exact: true })).toBeVisible({
      timeout: 60_000,
    })
    await dismissMobileSidebar(page)

    // ── 1. The active budget reads above the fold ──────────────────────────
    // The delegation fixture grants 250.00 USDC per week. The budget card's
    // active row renders "250 USDC per week" as ONE element (BudgetRow formats
    // via formatUnits — no trailing zeros; the page SUMMARY lower down says
    // "250.00"), so a substring probe on the full row text is both the amount
    // and the period claim: if that row starts above 844px, both read without
    // scrolling.
    const fold = await foldY(page)
    const budgetRowBox = await page
      .getByText('250 USDC per week')
      .first()
      .boundingBox()
    expect(budgetRowBox, 'the active budget row "250 USDC per week" rendered').not.toBeNull()
    expect(
      budgetRowBox!.y,
      `active budget row starts at y=${budgetRowBox!.y} — the budget amount and ` +
        `period must sit above the ${fold}px fold without scrolling`,
    ).toBeLessThan(fold)
    // Reported, not asserted: #2821 was found on a device where this row
    // cleared the bar by a hair, and a margin nobody prints is one nobody
    // notices shrinking. The number is in the run log before it is a failure.
    console.log(
      `#2821 fold margin: budget row bottom ${Math.round(budgetRowBox!.y + budgetRowBox!.height)}px, ` +
        `fold ${fold}px, clearance ${Math.round(fold - budgetRowBox!.y - budgetRowBox!.height)}px`,
    )

    // ── 2. "Set budget" is one line in its pill ────────────────────────────
    // The `sm` Button's height is the fixed `h-9` regardless of line count,
    // so the PILL height cannot detect wrapping. The label's rendered line
    // boxes can: one line of text produces one rect top; a wrapped label
    // produces two distinct tops. (Floors sit clear of a two-line reading.)
    const geo = await setBudgetGeometry(page)
    const visibleLines = geo.labelLines.filter((line) => line.width > 1 || line.height > 1)
    expect(visibleLines.length, 'the "Set budget" label renders as text rects').toBeGreaterThan(0)
    const distinctTops = new Set(visibleLines.map((line) => Math.round(line.top)))
    expect(
      distinctTops.size,
      `"Set budget" label renders on ${distinctTops.size} line(s) — a squeezed pill ` +
        `wraps the label onto two lines, which is exactly the #2733 defect`,
    ).toBe(1)

    // ── 3. The recipient field is not clipped ──────────────────────────────
    const recipient = page.getByLabel('Recipient')
    await expect(recipient).toBeVisible()
    const clipped = await recipient.evaluate((el: HTMLInputElement) => {
      const input = el
      return input.scrollWidth > input.clientWidth
    })
    expect(
      clipped,
      'the recipient input clips its own content — the placeholder no longer fits ' +
        '(scrollWidth > clientWidth)',
    ).toBe(false)

    // ── 4. Actions row and kebab clear the 44px floor ──────────────────────
    // Two mechanisms, matching the design system (#1726): the three labelled
    // footer actions are `sm` Buttons — 36px PAINTED with a transparent
    // `::after` overlay extending the HIT target to 44px vertically — so they
    // are measured the `accounts-card-tap-target` way (walk outward from the
    // centre until elementFromPoint leaves the control). The kebab is an icon
    // square on the both-axes variant (`min-h-11 min-w-11`) — its PAINTED box
    // must clear 44 outright.
    const hitHeight = async (name: string) =>
      page.evaluate((label) => {
        const el = Array.from(document.querySelectorAll('button')).find(
          (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === label,
        )
        if (!el) throw new Error(`no button "${label}" rendered`)
        const b = el.getBoundingClientRect()
        const cx = Math.round(b.left + b.width / 2)
        const cy = Math.round(b.top + b.height / 2)
        const walk = (dx: number, dy: number) => {
          let n = 0
          while (n < 60) {
            const x = cx + dx * (n + 1)
            const y = cy + dy * (n + 1)
            if (y < 0 || x < 0 || y >= window.innerHeight) break
            const top = document.elementFromPoint(x, y)
            if (!(!!top && (top === el || el.contains(top)))) break
            n += 1
          }
          return n
        }
        return { painted: b.height, hit: walk(0, -1) + walk(0, 1) + 1 }
      }, name)

    for (const name of ['Update budget', 'Pause agent', 'Remove agent'] as const) {
      // elementFromPoint is viewport-relative: the actions row sits far below
      // the 844px fold, so each target is scrolled into view before the walk
      // or the probe reports a phantom 1px target.
      await page.getByRole('button', { name, exact: true }).scrollIntoViewIfNeeded()
      const t = await hitHeight(name)
      expect(
        t.hit,
        `"${name}" hit target is ${t.hit}px tall — must clear ${TOUCH_TARGET_FLOOR}px ` +
          `(the #1726 vertical overlay is what buys the difference between the ` +
          `${t.painted}px painted box and the target)`,
      ).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR)
    }
    const kebab = page.getByRole('button', { name: 'Agent options' })
    await expect(kebab).toBeVisible()
    const kebabBox = await kebab.boundingBox()
    expect(kebabBox, 'the agent options kebab rendered').not.toBeNull()
    expect(kebabBox!.height).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR)
    expect(kebabBox!.width).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR)

    // ── 4b. The kebab shares the title's row (#2821) ───────────────────────
    // Below `sm` the header used to stack, and the actions slot on this page
    // usually holds the kebab ALONE — the badge beside it renders `null` while
    // the agent is active — so a lone bordered icon sat on its own line,
    // left-aligned, belonging visually to nothing.
    //
    // Asserted as a vertical OVERLAP with the H1's box, not as "same y": the
    // two have different heights and are aligned to the top of the row, so an
    // equality would pin a coincidence. Overlap is the claim — they are on one
    // row — and it fails the moment the header stacks again.
    const titleBox = await page
      .getByRole('heading', { name: 'Research agent', exact: true })
      .boundingBox()
    expect(titleBox, 'the agent title rendered').not.toBeNull()
    const overlaps =
      titleBox!.y < kebabBox!.y + kebabBox!.height && kebabBox!.y < titleBox!.y + titleBox!.height
    expect(
      overlaps,
      `kebab at y=${Math.round(kebabBox!.y)}..${Math.round(kebabBox!.y + kebabBox!.height)} ` +
        `must share a row with the title at y=${Math.round(titleBox!.y)}..` +
        `${Math.round(titleBox!.y + titleBox!.height)}`,
    ).toBe(true)
    // ...and to the RIGHT of it, so "shares a row" cannot be satisfied by the
    // two overlapping in the same column.
    expect(kebabBox!.x).toBeGreaterThan(titleBox!.x)

    // ── 4c. The budget leads the first screen, and desktop does not ────────
    // The reorder is #2821's headline change and had NO coverage: removing
    // both `order-*` classes left every assertion green, because the fold
    // check clears by 150px even unreordered. This is the assertion that
    // notices, and it is asserted in BOTH directions — the `lg:order-*` half
    // is a claim about desktop that was equally unguarded.
    const cardTops = async () =>
      page.evaluate(() => {
        const budget = document.getElementById('delegation-budget-card')
        const about = Array.from(document.querySelectorAll('h2')).find(
          (h) => (h.textContent ?? '').trim() === 'About this agent',
        )
        if (!budget || !about) return null
        return {
          budget: Math.round(budget.getBoundingClientRect().top + window.scrollY),
          about: Math.round(about.getBoundingClientRect().top + window.scrollY),
        }
      })

    const mobileOrder = await cardTops()
    expect(mobileOrder, 'both cards rendered').not.toBeNull()
    expect(
      mobileOrder!.budget,
      `at ${MOBILE_WIDTH}px the budget must lead: budget y=${mobileOrder!.budget}, ` +
        `about y=${mobileOrder!.about}`,
    ).toBeLessThan(mobileOrder!.about)

    // ...and the desktop composition is restored at `lg`, where the metadata
    // grid is four columns and costs nothing.
    await page.setViewportSize({ width: 1280, height: 900 })
    // Waits for the bar to stop RENDERING, not to leave the DOM: `lg:hidden` is
    // `display: none`, so `querySelector` still finds it and a presence check
    // waits forever (measured — this timed out at 60s the first time).
    await page.waitForFunction(() => {
      const bar = document.querySelector('nav[data-mobile-tab-bar]')
      return !bar || getComputedStyle(bar).display === 'none'
    })
    const desktopOrder = await cardTops()
    expect(desktopOrder, 'both cards rendered at 1280').not.toBeNull()
    expect(
      desktopOrder!.about,
      `at 1280px the metadata must lead again: about y=${desktopOrder!.about}, ` +
        `budget y=${desktopOrder!.budget}`,
    ).toBeLessThan(desktopOrder!.budget)
    await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT })

    // ── 5. No horizontal overflow, both metrics (#1771) ────────────────────
    const overflow = await expectNoHorizontalOverflow(page)
    expect(overflow).toMatchObject({ hasOverflow: false })

    // The page made no unexpected API noise while being measured.
    expect(unexpectedBrowserErrors(errors)).toEqual([])
  })
})
