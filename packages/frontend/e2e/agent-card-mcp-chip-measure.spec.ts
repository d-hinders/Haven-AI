/**
 * `/agents`: the MCP chip on a narrow card is distinguishable (#2325).
 *
 * WHAT WAS BROKEN. #2251 (PR #2324) stopped the card growing past its grid
 * track, and that exposed the next defect in the same header row. At 390 the
 * card's header row is 300px wide, and it divides as:
 *
 *   bot tile 36 + gap 12 + block 121.2 + gap 12 + "Last activity 1mo ago" 118.8
 *
 * The stamp is `ml-auto shrink-0`, so it takes 118.8px and will not yield, and
 * the `min-w-0 flex-1` block gets the remaining 121.2px. Inside the block the
 * MCP chip gets 38.5px — which ellipsises even a SHORT slug: `haven-research`
 * (measured 113px) renders as `haven…`. Every card on the page shows the same
 * stub, the opposite of what #1878 added the chip for (mapping a card to an
 * entry in your MCP config). (Every figure above was RE-MEASURED on this
 * branch's merged base — `dev` 75e48448, which carries #2298/#2319/#2328/#2416
 * — by reverting the two classes and reading the live geometry, not carried
 * over from an earlier base. The 36/12/121.2/12/118.8 header split is the same
 * one the issue recorded on #2324's branch; what moved is the chip inside the
 * block, 62.5px there against 38.5px here, as the page scaffold changed under
 * it. The defect class is unchanged — the stamp cannot yield and the chip
 * truncates — and the spec below asserts against the render, never a literal.)
 *
 * THE DECISION. What `/agents` shows first on a narrow card is an
 * information-priority choice, and this is it: **the MCP wiring outranks the
 * last-activity stamp.** On a narrow card the stamp drops to its own line
 * below the name/account/MCP block, so the block gets the row's full width and
 * the chip is distinguishable. The stamp is not deleted — it moves down, still
 * visible, still right-aligned, still carrying its `title` tooltip.
 *
 * The mechanism is two classes, and neither alone does the job (both were
 * measured not to, on #2324's branch — do not re-derive them):
 *
 *   - `flex-wrap` on the header row ALONE does nothing. Wrapping is decided on
 *     base sizes, and the block's flex-basis is `0%` (`flex-1`), so it never
 *     pushes the stamp onto a second line.
 *   - `flex-shrink: 1` on the stamp ALONE does nothing. Free space at this
 *     width is positive (the block absorbs what is left), and flex shrinking
 *     only engages when free space is negative.
 *
 * So the fix is `flex-wrap` on the row PLUS `basis-full sm:basis-auto` on the
 * stamp: `basis-full` makes the stamp a full-width flex item, which is what
 * forces the wrap, and `sm:basis-auto` restores the on-the-line layout at `sm`
 * (640px) and up, where the card is wide enough that the stamp and the block
 * share the row. Below `sm` the stamp is on its own line; at `sm` and up it is
 * on the line. The tablet/desktop layout is unchanged.
 *
 * THE MEASURED MINIMUM. The acceptance bar is stated as a measured width, not
 * a class string: **the chip must render at least the natural (untruncated)
 * width of the seeded slug, so the whole slug is visible and two agents with
 * different slugs are distinguishable.** The seed is `haven-research`, the same
 * value `scripts/screenshot.mjs:485` seeds for the `/agents` mobile capture,
 * which measures **113px** (the value this spec re-measures at runtime, so the
 * bar is not a literal tuned to one renderer). Below that — the 38.5px the
 * broken layout gives — the chip is a `haven…` stub and two agents are
 * indistinguishable. Above it, the whole slug shows. The assertion compares the
 * chip's rendered width against its own `scrollWidth` (readable even while
 * ellipsised), so it is renderer-robust: it does not hard-code 113px.
 *
 * WHY GEOMETRY AND NOT A SCREENSHOT. The one committed baseline on this surface
 * is a `-desktop` capture, where the chip has 200.5px and `haven-research`
 * needs 113 — so no pixel gate at desktop can see the 390 defect, and there is
 * no `/agents` mobile baseline at all. A class assertion cannot see it either:
 * `basis-full` is present or absent in the string whether or not the stamp
 * actually drops to a second line. This spec reads the rendered geometry — the
 * chip's width against its natural width, and the stamp's line relative to the
 * block — in a real engine.
 *
 * WHICH ARM CATCHES WHAT — measured, not assumed:
 *
 *   @390   the PRIMARY arm goes red on the reverted layout. The stamp is on
 *          the line, the chip is 38.5px, and 38.5 < 113, so "the chip renders
 *          whole" fails. The "stamp on its own line" guard fails too.
 *   @768   the CONTROL arm: the stamp is on the line (`sm:basis-auto`), the
 *          chip is whole, and the card fits its track. This is green on the
 *          fixed layout and would go red if the breakpoint swap were wrong in
 *          either direction (stamp stuck below at 768, or chip squeezed at 768).
 *
 * NO #2251 REGRESSION. Giving the block more width must not come from letting
 * the card overflow its track again. This spec asserts the card still fits its
 * grid track (cardWidth <= trackWidth) and the chip does not spill past the
 * card's right edge, at 390. `e2e/agent-card-fit-measure.spec.ts` is the
 * standing guard for the track itself and must stay green alongside this one.
 *
 * MUTATION PROOF. Reverting the layout change (removing `flex-wrap` from the
 * row and `basis-full sm:basis-auto` from the stamp) drops the chip back to
 * 38.5px at 390, which is below the 113px natural width, so the primary
 * assertion goes red; the stamp returns to the line (stamp top 263px against
 * a block bottom of 347px), so the "stamp on its own line" guard goes red too.
 * Both are checked by running the revert, not by reading the diff.
 *
 * FIXTURE FIDELITY. `mcp_server_name` is selected as `a.mcp_server_name` by
 * `listAgentsForUserAllStatuses` (`infra/repositories/agents.ts:184`), typed
 * `string | null` there and declared `type: ['string','null']` in
 * `openapi/spec.ts:6142`; `status`, `account_type` and `safe_name` come from
 * the same row. `haven-research` is a legal value: 14 chars (<= 64) and
 * matching `/^haven(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/`
 * (`backend/src/routes/agent-connection-setups.ts:143-149`).
 */
import { expect, test, type Page } from '@playwright/test'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession, testAgent, testSafe } from './fixtures/haven-api'

/** The mobile width #2325 is about, plus a below-`lg` tablet as the control. */
const MOBILE = 390
const TABLET = 768

/**
 * The seed, chosen to match `scripts/screenshot.mjs:485` so the spec and the
 * `/agents` mobile capture evidence are the same case. Measured 113px at 390 —
 * the natural width the chip must reach to render the whole slug.
 */
const SEED = 'haven-research'

function agentSeed(id: string, over: Record<string, unknown> = {}) {
  return {
    ...testAgent,
    id,
    name: `Agent ${id}`,
    description: null,
    account_type: 'delegator_hybrid',
    safe_id: testSafe.id,
    safe_name: testSafe.name,
    mcp_server_name: `haven-${id}`,
    mcp_last_seen_at: '2026-07-10T08:12:00.000Z',
    has_stranded_funds: false,
    status: 'active',
    ...over,
  }
}

/**
 * Two cards, because the chip's width is a property of the COLUMN, not of one
 * card: the widest min-content in the grid sets the track for every sibling.
 * The first carries the seed this spec measures; the second carries a different
 * slug so the page shows two distinguishable chips, which is the user-visible
 * point of #1878.
 */
const AGENTS = [
  agentSeed('research', { name: 'Research agent', mcp_server_name: SEED }),
  agentSeed('nightly', { name: 'Nightly reconciliation', mcp_server_name: 'haven-nightly' }),
]

type Reading = {
  /** The chip's rendered width — what the layout actually gave it. */
  width: number
  /** The chip's NATURAL width, readable even while it is ellipsised. */
  natural: number
  truncated: boolean
  /** How far the chip's right edge sits past the card's own right edge. */
  spillPastCard: number
  /** The card's rendered width. */
  cardWidth: number
  /** The card's share of the grid's CONTENT box — not the inflated column. */
  trackWidth: number
  /** Top of the name/account/MCP block. */
  blockTop: number
  /** Bottom of the block. */
  blockBottom: number
  /** Top of the "Last activity" stamp. */
  stampTop: number
  /** The stamp's text, so a layout that deleted it cannot pass silently. */
  stampText: string
}

/**
 * Anchor on the surviving card testid and on the value the chip renders —
 * never on a class string: the class strings are what this fix changes, so a
 * probe that read them would be measuring the diff instead of the layout.
 * (`role="link"` on the card died with #2331's retire-legacy-Safe-surfaces
 * restructure; `data-testid="agent-card"` is the stable anchor on `dev`.)
 *
 * The block and the stamp are located structurally (the header row's second and
 * third children), not by class, so the probe reads the same elements under the
 * full revert — which is what lets the header's numbers be compared like for
 * like.
 */
async function readChip(page: Page, value: string): Promise<Reading> {
  return page.evaluate((mcpName) => {
    const chip = Array.from(document.querySelectorAll('span')).find(
      (el) => el.children.length === 0 && (el.textContent ?? '').trim() === mcpName,
    ) as HTMLElement | undefined
    if (!chip) throw new Error(`no MCP chip rendering "${mcpName}"`)
    const card = chip.closest('[data-testid="agent-card"]') as HTMLElement | null
    if (!card) throw new Error('the MCP chip is not inside an /agents card')

    // The header row is the card's first child; its children are the bot tile,
    // the name/account/MCP block, and the "Last activity" stamp, in that order.
    const header = card.children[0] as HTMLElement
    const block = header.children[1] as HTMLElement
    const stamp = header.children[2] as HTMLElement
    if (!block || !stamp) throw new Error('the card header has no block or stamp')

    // The track a card is ENTITLED to: the grid's own content box, divided by
    // the column count and less the gaps. Same reasoning as
    // `agent-card-fit-measure.spec.ts` — deliberately not the resolved
    // `grid-template-columns` value, which is the box the #2251 defect itself
    // inflates, and not `grid.clientWidth` alone, which is meaningless at a
    // two-column width.
    const grid = card.parentElement as HTMLElement
    const style = getComputedStyle(grid)
    const columnCount = style.gridTemplateColumns
      .split(' ')
      .filter((v) => Number.isFinite(Number.parseFloat(v))).length
    if (columnCount === 0) throw new Error('the agents grid resolved no columns')
    const columnGap = Number.parseFloat(style.columnGap) || 0
    const trackWidth = +((grid.clientWidth - columnGap * (columnCount - 1)) / columnCount).toFixed(1)

    const chipBox = chip.getBoundingClientRect()
    const cardBox = card.getBoundingClientRect()
    const blockBox = block.getBoundingClientRect()
    const stampBox = stamp.getBoundingClientRect()

    return {
      width: +chipBox.width.toFixed(1),
      natural: chip.scrollWidth,
      truncated: chip.scrollWidth > chip.clientWidth + 1,
      spillPastCard: +(chipBox.right - cardBox.right).toFixed(1),
      cardWidth: +cardBox.width.toFixed(1),
      trackWidth,
      blockTop: +blockBox.top.toFixed(1),
      blockBottom: +blockBox.bottom.toFixed(1),
      stampTop: +stampBox.top.toFixed(1),
      stampText: (stamp.textContent ?? '').trim(),
    }
  }, value)
}

/** Settle until two consecutive reads agree — a fixed wait yields stale numbers. */
async function settled<T>(read: () => Promise<T>): Promise<T> {
  let value = await read()
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const again = await read()
    if (JSON.stringify(again) === JSON.stringify(value)) break
    value = again
  }
  return value
}

async function openAgents(page: Page) {
  await mockHavenApi(page)
  // Registered AFTER `mockHavenApi`, so it wins — Playwright consults the most
  // recently added handler first. Nothing in the shared fixture is edited and
  // `scripts/screenshot.mjs` is untouched, so no other spec and no capture
  // scenario moves.
  await page.route('**/api/agents', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agents: AGENTS }),
    })
  })
  await seedAuthenticatedSession(page)
  await page.goto('/agents')
  await page.getByRole('heading', { name: 'Research agent', exact: true }).waitFor({ timeout: 60_000 })
}

/** Below `lg` the nav drawer overlays the grid (#1749); the helper is a no-op at 768. */
async function atWidth(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 })
  await dismissMobileSidebar(page)
}

test('/agents: the MCP chip is distinguishable at 390', async ({ page }) => {
  test.slow()
  await openAgents(page)
  await atWidth(page, MOBILE)
  const reading = await settled(() => readChip(page, SEED))

  // Non-vacuity #1: we must really be in the one-column mobile layout. If the
  // track were the full viewport this would pass for a page that simply never
  // narrowed, which is the failure #2251 warns about — evidence captured at the
  // wrong viewport.
  expect(
    reading.trackWidth,
    `@${MOBILE}px: the grid track is ${reading.trackWidth}px — this is not the mobile layout the issue is about`,
  ).toBeLessThan(MOBILE)

  // Non-vacuity #2: the seed must genuinely stress the chip. Its natural width
  // must exceed the 38.5px the broken layout gives, so that reverting the fix
  // makes the chip truncate. Stated against the rendered natural width rather
  // than a literal, so it is renderer-robust.
  expect(
    reading.natural,
    `@${MOBILE}px: the seeded slug "${SEED}" measures ${reading.natural}px — it must be wide enough that the ` +
      `broken layout (38.5px) would truncate it, or nothing below is under test`,
  ).toBeGreaterThan(38.5)

  // The stamp must still be present — the fix moves it, it does not delete it.
  expect(
    reading.stampText,
    `@${MOBILE}px: the "Last activity" stamp renders "${reading.stampText}" — it must not be deleted`,
  ).toMatch(/Last activity|No activity yet/)

  // THE DECISION, stated as the user sees it: at 390 the stamp is on its own
  // line, below the block. This is the mechanism guard — on the reverted layout
  // the stamp is on the line and this fails.
  expect(
    reading.stampTop,
    `@${MOBILE}px: the stamp's top is ${reading.stampTop}px against the block's bottom at ${reading.blockBottom}px ` +
      `— the stamp is on the line with the block, not below it, so the block is still paying for the stamp's width`,
  ).toBeGreaterThanOrEqual(reading.blockBottom - 2)

  // THE MEASURED MINIMUM: the chip renders at least the natural width of the
  // seeded slug, so the whole slug is visible and two agents with different
  // slugs are distinguishable. On the reverted layout the chip is 38.5px, below
  // the 113px natural width, so this goes red.
  expect(
    reading.width,
    `@${MOBILE}px: the "${SEED}" chip renders ${reading.width}px of its ${reading.natural}px natural width ` +
      `— it is a stub, and two agents with different slugs are indistinguishable`,
  ).toBeGreaterThanOrEqual(reading.natural - 1)
  expect(
    reading.truncated,
    `@${MOBILE}px: the "${SEED}" chip is ellipsised into ${reading.width}px of a ${reading.natural}px slug`,
  ).toBe(false)

  // NO #2251 REGRESSION: giving the block more width must not come from letting
  // the card overflow its track again. The card fits its track and the chip
  // does not spill past the card's right edge.
  expect(
    reading.cardWidth,
    `@${MOBILE}px: the card renders ${reading.cardWidth}px in a ${reading.trackWidth}px track — it overflows by ` +
      `${(reading.cardWidth - reading.trackWidth).toFixed(1)}px and is clipped by the overflow-hidden ancestor`,
  ).toBeLessThanOrEqual(reading.trackWidth + 0.5)
  expect(
    reading.spillPastCard,
    `@${MOBILE}px: the MCP chip's right edge sits ${reading.spillPastCard}px past its card's — it is spilling out ` +
      `of the card instead of sitting inside it`,
  ).toBeLessThanOrEqual(0.5)
})

test('/agents: the stamp stays on the line at 768 (control)', async ({ page }) => {
  test.slow()
  await openAgents(page)
  await atWidth(page, TABLET)
  const reading = await settled(() => readChip(page, SEED))

  // A CONTROL, honestly labelled as one: this is green on the fixed layout and
  // pins the breakpoint. At 768 (>= `sm`) the stamp is `basis-auto` and sits on
  // the line with the block, so the tablet layout is unchanged. It would go red
  // if the breakpoint swap were wrong in either direction — the stamp stuck
  // below at 768, or the chip squeezed by a stamp that should have dropped.
  expect(
    reading.stampTop,
    `@${TABLET}px: the stamp's top is ${reading.stampTop}px against the block's top at ${reading.blockTop}px — ` +
      `the stamp is below the block, but at ${TABLET}px (>= sm) it should be on the line`,
  ).toBeLessThanOrEqual(reading.blockTop + 2)

  // The chip is whole at 768 too — the block has plenty of room on the line.
  expect(
    reading.width,
    `@${TABLET}px: the "${SEED}" chip renders ${reading.width}px of its ${reading.natural}px natural width`,
  ).toBeGreaterThanOrEqual(reading.natural - 1)

  // And the card still fits its track at 768.
  expect(
    reading.cardWidth,
    `@${TABLET}px: the card renders ${reading.cardWidth}px in a ${reading.trackWidth}px track`,
  ).toBeLessThanOrEqual(reading.trackWidth + 0.5)
})
