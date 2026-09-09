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
 * The fold assertion IS this height; it is not tunable per test.
 */
const MOBILE_WIDTH = 390
const MOBILE_HEIGHT = 844

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
    const fold = MOBILE_HEIGHT
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

    // ── 5. No horizontal overflow, both metrics (#1771) ────────────────────
    const overflow = await expectNoHorizontalOverflow(page)
    expect(overflow).toMatchObject({ hasOverflow: false })

    // The page made no unexpected API noise while being measured.
    expect(unexpectedBrowserErrors(errors)).toEqual([])
  })
})
