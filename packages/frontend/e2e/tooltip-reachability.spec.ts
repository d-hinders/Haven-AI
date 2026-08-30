/**
 * `Tooltip` width and keyboard reach, measured in a real browser (#2038).
 *
 * ## Why this file exists
 *
 * Defect 2 — a `whitespace-nowrap` bubble with no width cap — is a text-layout
 * fact, and jsdom has no layout engine. There, a three-word label and a
 * 167-character one produce identical evidence, which is precisely how the
 * defect shipped: every gate the repo has either cannot see a closed tooltip
 * (the pixel gates, the rendered design review) or cannot measure an open one
 * (the unit suite). **This is the only assertion in the repo that fails on
 * long content specifically.**
 *
 * ## Why `/agents` and not a `/design-system` demo
 *
 * #1924's rule: a showcase would measure whatever the showcase author wrote,
 * not what the product passes. So the label under test has to be one a real
 * call site can hand `Tooltip`.
 *
 * ### The label changed in #2043, and the reason is worth keeping
 *
 * This test used to hover `McpServerName`'s null branch, whose 167-character
 * sentence was the longest label any caller passed. **#2043 deleted that
 * tooltip**: the copy explained an absence, it was essential rather than
 * elaboration, and `AgentCard`'s composite `role="link"` meant no keyboard or
 * touch user could ever reach it. It is visible text above the agent list now.
 *
 * The primitive's width contract did not change with it, so the test moves to
 * the longest label the product **can** pass rather than disappearing. That is
 * `McpServerName`'s OTHER tooltip — the one #2043 deliberately kept — at the
 * longest server name the backend will store: `normalizeMcpServerName`
 * refuses anything over 64 characters or outside
 * `/^haven(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/`
 * (`backend/src/routes/agent-connection-setups.ts:143-149`), and the label
 * appends the derived signer half, so `MAX_LENGTH_PAIR_LABEL` below is the
 * ceiling, not a number someone liked. The name is served by a per-test route
 * override rather than added to the shared fixture: a maximum-length name is a
 * legal edge, not what the default capture should photograph.
 *
 * ## Why a desktop project at a phone width
 *
 * This is a GEOMETRY sweep — rectangles, not pixels, and not a hit test — the
 * shape `transaction-row.mobile.spec.ts` and `mobile-nav-layering.mobile.spec.ts`
 * established as legitimate. The bubble is opened by HOVER, which the mobile
 * project's coarse pointer does not have; the touch half is proven in its own
 * project in `tooltip-reachability.mobile.spec.ts`. #1768's warning is about
 * borrowing a desktop proof for a touch claim, which this does not do.
 *
 * ## The numbers, and why these
 *
 * The width bound is the viewport minus the primitive's own 8px gutter per
 * side. Before the fix the same bubble measures **988px on a 320px screen** —
 * three times the viewport, not a metric wobble. `MIN_WRAPPED_HEIGHT_PX` is the other half
 * of the same claim and is what makes it long-content-specific: a bubble can
 * be narrow because it wrapped or because it was clipped, and only the height
 * tells those apart. One line of `text-[12px] leading-tight` plus `py-1.5` is
 * ~27px; the wrapped result is several times that. 40px sits above any single
 * line and far below the real value.
 *
 * ## If a test here fails in a batch and passes in isolation, suspect contention
 *
 * Recorded because the alternative reading is "regression", and twice now it
 * has not been one. Two separate observations, both first-hand:
 *
 * 1. During the #2038 review, two tests in this file failed on a first run and
 *    passed cleanly on their own. The cause was **confirmed, not inferred**: a
 *    second, unrequested Playwright process was driving the same dev server.
 * 2. During the #2038 fix-forward, `tooltip-reachability.mobile.spec.ts`'s
 *    composite-card test failed the same way with **no** second Playwright
 *    process running — five other worktrees' `next dev` servers were simply
 *    competing for CPU, and the run hit the route cold (38.2s, against 16.6s
 *    once warm). It passed in isolation and then 2/2 on a warm route.
 *
 * So the shared cause is contention, and a second Playwright process is one way
 * to get it rather than the only way. Warm the route and re-run before
 * diagnosing anything in this file. The per-worktree port reservation and
 * identity probe in `playwright.config.ts` (#1816) stop a run adopting a
 * *different* worktree's server; they do not stop two runs in the SAME worktree
 * from sharing one, and they do not buy CPU. Never "fix" this with an unscoped
 * `pkill -f`.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
  testAgent,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

/**
 * The longest `mcp_server_name` the backend will store: 64 characters, and
 * every character legal under `MCP_SERVER_NAME_RE`. Hyphenated rather than one
 * unbroken run because that is the shape the connector produces — and because
 * a single 64-character token would prove `break-words` rather than the cap.
 */
const MAX_LENGTH_SERVER_NAME = 'haven-research-eu-west-invoices-vendor-payments-team-two-alpha13'

/** Asserted, not trusted: the ceiling is the point of this fixture. */
if (MAX_LENGTH_SERVER_NAME.length !== 64) {
  throw new Error(
    `the max-length fixture must be exactly 64 characters, got ${MAX_LENGTH_SERVER_NAME.length}`,
  )
}

/**
 * What `McpServerName` hands `Tooltip` for that name — the longest label any
 * call site in the product can produce (~153 characters). Built with the
 * component's own pair rule rather than pasted, so a change to either side of
 * the naming rule reaches this test.
 */
const MAX_LENGTH_PAIR_LABEL = `MCP servers: ${MAX_LENGTH_SERVER_NAME} and haven-signer-${MAX_LENGTH_SERVER_NAME.slice(
  'haven-'.length,
)}`

/** The narrowest phone width in the support matrix, and 390 beside it. */
const NARROW_WIDTHS = [320, 390] as const

/** `Tooltip`'s own keep-inside-the-viewport gutter, per side. */
const VIEWPORT_MARGIN_PX = 8

/** Above one line of `text-[12px] leading-tight` + `py-1.5` (~27px). */
const MIN_WRAPPED_HEIGHT_PX = 40

/** `/design-system`'s sample address, and its `truncate()` display form. */
const SAMPLE_ADDRESS = '0x8f4F0f6d712C5c5C9Bb02F4a5B5c0D7F462A6f4C'
const SAMPLE_TRUNCATED = '0x8f4F…6f4C'

/**
 * One `/design-system` demo section, addressed by its own unique `<h2>`.
 *
 * `/design-system` renders every primitive against the SAME `sampleAddress`, so
 * the page is full of near-identical text. The section heading is the one thing
 * on it that says which demo you are looking at, which makes it the right
 * anchor for "this component's trigger" — and the reason a positional locator
 * was wrong here rather than merely brittle.
 */
const designSystemSection = (page: Page, title: string) =>
  page.locator('section').filter({
    has: page.getByRole('heading', { level: 2, name: title, exact: true }),
  })

test.describe('Tooltip width and keyboard reach (#2038)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('the longest label the product can pass wraps inside a phone viewport instead of one unbroken bar', async ({
    page,
  }) => {
    const browserErrors = collectBrowserErrors(page)

    // Registered after `mockHavenApi`, so this handler wins for `/agents`.
    await page.route('**/api/agents', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [{ ...testAgent, mcp_server_name: MAX_LENGTH_SERVER_NAME }],
        }),
      })
    })

    await page.setViewportSize({ width: NARROW_WIDTHS[0], height: 800 })
    await page.goto('/agents')
    const trigger = page.getByText(MAX_LENGTH_SERVER_NAME).first()
    await expect(trigger).toBeVisible()

    for (const width of NARROW_WIDTHS) {
      await page.setViewportSize({ width, height: 800 })
      // Below `lg` the nav drawer overlays the page and intercepts the hover.
      await dismissMobileSidebar(page)
      await trigger.hover()

      const bubble = page.locator('[role="tooltip"]')
      await expect(bubble).toHaveText(MAX_LENGTH_PAIR_LABEL)
      const box = await bubble.boundingBox()
      if (!box) throw new Error(`the open tooltip must have a box to measure at ${width}px`)

      // Wrapped, not one line: the width is capped AND the height grew.
      expect(box.width, `bubble width at ${width}px`).toBeLessThanOrEqual(
        width - 2 * VIEWPORT_MARGIN_PX,
      )
      expect(box.height, `bubble height at ${width}px`).toBeGreaterThanOrEqual(
        MIN_WRAPPED_HEIGHT_PX,
      )

      // Capping the width is not enough on its own — a capped bubble centred
      // on a trigger near the screen edge still hangs off it. The gutter, not
      // merely zero, is the primitive's stated contract, and asserting the
      // contract is what makes the clamp provable: a dead clamp leaves this
      // bubble two pixels from the left edge, which `>= 0` would wave through.
      expect(box.x, `bubble left edge at ${width}px`).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX)
      expect(box.x + box.width, `bubble right edge at ${width}px`).toBeLessThanOrEqual(
        width - VIEWPORT_MARGIN_PX,
      )

      // Leave the hover before the next width, so each pass re-opens rather
      // than measuring a bubble positioned for the previous viewport.
      await page.mouse.move(0, 0)
      await expect(bubble).toHaveCount(0)
    }

    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })

  // Both of `/design-system`'s standalone triggers, not one: `Address` renders
  // its trigger as a bare `<span>` and `WalletIdentityBlock` as a `<p>`. They
  // are the two shapes every other standalone call site reuses, so covering
  // both here is what makes the shared-code-path inference for
  // `AccountDetailClient` and `AgentDetailClient` an inference about markup
  // that has actually been rendered rather than only read.
  //
  // ## Why these are scoped locators and not `nth(index)`
  //
  // The first version of this block addressed the two triggers positionally —
  // `getByText(SAMPLE_TRUNCATED).nth(0)` and `.nth(1)`. That string resolves to
  // SIX elements on this page, in document order: `Address`' three demo rows
  // (`<span>`, `<span>`, `<a>`), two unrelated `Base · 0x8f4F…6f4C` `<p>`s, and
  // only THEN `WalletIdentityBlock`'s `<p>`. So `nth(1)` was `Address`' own
  // check-pop copy row — **a second test of `Address`** — while the test's name,
  // the pull request body and the commit message all claimed it covered
  // `WalletIdentityBlock`. The `<p>` shape was exercised by neither test nor
  // render (#2038 fix-forward, after PR #2047 merged).
  //
  // An ordinal into an ambiguous match is a coverage claim that retargets
  // **silently** whenever the demo page gains, loses, or reorders a row — the
  // test stays green while quietly measuring something else. So each case now
  // names its component by identity instead:
  //
  //   1. scoped to the owning `Section` via that section's unique `<h2>`, the
  //      idiom `marketing-cta-focus.spec.ts:201` already uses;
  //   2. `exact: true`, which drops the two `Base · …` rows outright;
  //   3. `toHaveCount(1)`, so a future page edit that reintroduces ambiguity
  //      FAILS instead of silently picking one;
  //   4. an explicit tag assertion, so a case named "(p trigger)" cannot pass
  //      against a `<span>`.
  //
  // (3) and (4) are the part that cannot drift: the locator does not merely
  // happen to be right today, it refuses to run against anything but the shape
  // it names.
  for (const { name, tag, locate } of [
    {
      name: 'Address (span trigger)',
      tag: 'span',
      locate: (page: Page) =>
        designSystemSection(page, 'Amount & Address — the two core display objects')
          .locator('p')
          .filter({ hasText: '— hover for the full address' })
          .getByText(SAMPLE_TRUNCATED, { exact: true }),
    },
    {
      name: 'WalletIdentityBlock (p trigger)',
      tag: 'p',
      locate: (page: Page) =>
        designSystemSection(page, 'Wallet and activity').getByText(SAMPLE_TRUNCATED, {
          exact: true,
        }),
    },
  ] as const) {
    test(`${name} is in the tab order, rings on focus, and exposes its content`, async ({
      page,
    }) => {
      await page.goto('/design-system')

      const trigger = locate(page)
      // Identity, asserted — not assumed. See the block comment above.
      await expect(trigger, `${name}: the scoped locator must resolve to exactly one element`).toHaveCount(1)
      await expect(trigger).toBeVisible()
      expect(
        await trigger.evaluate((el) => el.tagName.toLowerCase()),
        `${name}: the trigger must be the markup shape this case is named for`,
      ).toBe(tag)

      // The wrapper the primitive renders. `tabindex="0"` on a visible,
      // enabled element IS the tab-order claim, in the real DOM rather than in
      // jsdom's model of it.
      const wrapper = trigger.locator('xpath=ancestor::*[@tabindex="0"][1]')
      await expect(wrapper).toHaveCount(1)

      // Set keyboard modality before focusing, or `:focus-visible` does not
      // engage and the ring assertion below measures the wrong state.
      await page.keyboard.press('Tab')
      await wrapper.focus()

      await expect(page.locator('[role="tooltip"]')).toHaveText(SAMPLE_ADDRESS)
      // The description is wired to the focused element, which is what an
      // assistive technology follows.
      const describedBy = await wrapper.getAttribute('aria-describedby')
      expect(describedBy).toBe(await page.locator('[role="tooltip"]').getAttribute('id'))

      // This primitive is what made the element focusable, so the focus
      // treatment is part of this change. Read the COMPUTED shadow rather than
      // screenshotting: a ring paints OUTSIDE the border box, so a capture
      // scoped to the trigger clips exactly the thing being shown (#1873).
      const ring = await wrapper.evaluate((el) => getComputedStyle(el).boxShadow)
      expect(ring, 'brand focus ring on the newly focusable trigger').not.toBe('none')
    })
  }
})
