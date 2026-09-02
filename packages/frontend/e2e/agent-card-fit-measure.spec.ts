/**
 * `/agents`: the `AgentCard` fits its grid track at 390 (#2251).
 *
 * WHAT WAS BROKEN. `AgentPanel` renders its cards into `grid items-start
 * gap-4 lg:grid-cols-2` (`AgentPanel.tsx:196`, `:250`). A grid item defaults to
 * `min-width: auto`, so the column is sized by the WIDEST card's min-content
 * and no card may shrink below it. When that min-content exceeds the 342px
 * track a 390px viewport offers, every card in the grid renders wider than the
 * track — and the ancestor chain absorbs the excess rather than scrolling:
 * `main.flex-1 … overflow-y-auto` is `overflow-x: auto` inside an
 * `overflow-hidden` parent, so the card is CLIPPED, with nothing on the page
 * telling the user there is more to the right.
 *
 * WHERE IT BITES, and why that is a property of the grid declaration rather
 * than of the viewport. Tailwind's `lg:grid-cols-2` is
 * `repeat(2, minmax(0, 1fr))`, and that explicit `0` already overrides the
 * item's automatic minimum size — so at 1280 the card sits at exactly its
 * 480px column even on unchanged `dev`. Below `lg` there is no
 * `grid-template-columns` at all: the implicit column is `auto`, and `auto`'s
 * minimum IS the item's min-content. #2251 is a below-`lg` bug for that
 * reason, not because 390 is small.
 *
 * WHAT THE FLOOR ACTUALLY IS — measured on `origin/dev` @ `40425405`, and NOT
 * what #2251's body predicted. That issue named the footer action row
 * (`flex items-center gap-2 pt-3 pb-1 border-t`, measured 357.1px) as the
 * widest incompressible descendant. It is not, on this `dev`: #2252's
 * title-row wrap landed in between and moved the floor. Per-card min-content
 * on a seven-seed sweep, read by setting each card to `width: min-content`
 * inside a shrunk grid:
 *
 *   short name, short MCP slug, "No activity yet"       229.1px
 *   short name, short MCP slug, "Last activity 1mo ago" 271.5px
 *   the same card with a 35-character `mcp_server_name` 466.6px  <- the floor
 *
 * and the footer row's own min-content across those seeds is 115.1–155.1px,
 * less than half the track and never the binding constraint. Status, stranded
 * funds, a description and the legacy rail all left the floor at 271.5px; only
 * the MCP chip moved it. The chain is:
 *
 *   header `flex items-start gap-3`
 *     └ `min-w-0 flex-1` block                     shrinks ✅
 *        └ MCP row `flex min-w-0 items-center`     shrinks ✅
 *           └ `McpServerName`'s `inline-flex min-w-0` wrapper   shrinks ✅
 *              └ `Tooltip`'s own `inline-flex` wrapper          DOES NOT ❌
 *                 └ the `truncate` chip
 *
 * `Tooltip` renders its non-`block` trigger as a bare `<span className=
 * "inline-flex">` with no `min-width: 0` and no `className` passthrough
 * (`Tooltip.tsx:293, 365`). As a flex item its automatic minimum size is its
 * content's min-content, and its content is a `white-space: nowrap` chip — so
 * the whole server name became incompressible and propagated all the way up to
 * the grid column, defeating the three `min-w-0`s above it that were already
 * there and already collapsing to 0.
 *
 * WHY THE FIX IS IN TWO PLACES — measured in-page, one inline style at a time,
 * on the 35-character seed at 390:
 *
 *   nothing                     card 466.6  chip 264.9   (overflows the track)
 *   `min-width:0` on Tooltip    card 466.6  chip 187.1   (column already blown)
 *   `min-width:0` on the CARD   card 342.0  chip 264.9 in an 86.5px box
 *                                           (fits the track, spills the card)
 *   both                        card 342.0  chip  62.5, properly ellipsised
 *
 * Hence one class in `AgentCard` and one in `McpServerName`, and one assertion
 * here per class. `shrink-0` on the "Last activity …" stamp is NOT part of it:
 * setting `flex-shrink: 1` on it moved the card 466.6 -> 466.6, exactly
 * nothing. It is left alone rather than tidied, so this diff has no unmeasured
 * half.
 *
 * WHAT THE FIX COSTS AT 390, stated rather than buried, because it is the
 * half a reader is most likely to be surprised by. Once the card stops growing,
 * the header row at 342px has 300px of content to divide: bot tile 36 + gap 12
 * + block 121.2 + gap 12 + "Last activity 1mo ago" 118.8. The stamp is
 * `ml-auto shrink-0`, so the block gets what is left, and inside it the MCP
 * chip gets 62.5px — which ellipsises even a SHORT slug: `haven-research`
 * (113px) renders as `haven…`. Before the fix that same chip rendered whole,
 * inside a card whose right-hand third was clipped off the screen.
 *
 * Three things bound how much that matters, and they are stated so the
 * trade-off can be argued with rather than discovered:
 *
 *   - it is reachable only for agents that HAVE a recorded `mcp_server_name`.
 *     The common state is `not recorded` (`McpServerName`'s own docstring:
 *     "the overwhelming majority of cards are in this state"), which renders a
 *     66px bare label with nothing to truncate.
 *   - no committed baseline moves, checked per file rather than asserted in
 *     general (`haven-reviewer` corrected a looser claim here). Every
 *     `AgentCard` baseline is a `-desktop` capture
 *     (`__screenshots__/agent-panel-states.visual.spec.ts/*`,
 *     `__screenshots__/focus-visible.visual.spec.ts/focus-agentcard-*`), where
 *     the chip has 200.5px and `haven-research` needs 113; and those specs seed
 *     `testAgent`, which carries no `mcp_server_name`, so they sit in the
 *     untouched `not recorded` branch anyway. There is no `/agents` mobile
 *     baseline at all. What DOES change is the non-gating evidence tool:
 *     `scripts/screenshot.mjs:485` seeds `mcp_server_name: 'haven-research'`
 *     and captures at 390, so its `/agents` mobile PNG will show `haven…`.
 *     That is this cost, visible — not a baseline to re-bless.
 *   - the full name stays reachable in place, by the two routes this chip was
 *     always designed around: its tooltip and the sibling `CopyButton`.
 *   - it is a 390-only effect. One column below `lg` is the whole card at
 *     718px at 768, and at `lg` the two-column grid gives 480.
 *
 * The lever that would buy the chip back is the `shrink-0` stamp — moving it
 * below the block on a narrow card, which is a DESIGN decision about what
 * `/agents` shows first at mobile, not a min-width fix. It is deliberately not
 * made here, and `flex-shrink: 1` on the stamp was measured NOT to be a
 * substitute for it (free space is positive at this width, so nothing shrinks).
 *
 * WHAT THE FIX COSTS AT 1280. At 1280 the longest legal
 * name now renders 200.5px of its 287px in a 480px card, where before it
 * rendered whole. Nothing is wasted doing it — the header row is icon 36 +
 * gap 12 + block 259.2 + gap 12 + stamp 118.8 = 438px, the card's entire
 * content box — so this is not #2237's "a name the card had room for was cut",
 * and the full name stays reachable through the chip's own tooltip and the
 * copy button beside it. Buying it back would mean taking the width from the
 * `shrink-0` stamp, which is a design decision this issue did not ask for.
 *
 * WHY THE SEED IS THE LONGEST LEGAL NAME AND NOT A STRESS STRING. `--name`
 * slugs are validated to 1–32 lowercase chars (`packages/connect/src/
 * server-names.ts`, `SLUG_RE` + the length bound) and the stored
 * `mcp_server_name` is `haven-<slug>`, so 38 characters is the WIDEST value the
 * product can ever put in this chip. A card that fits at 38 fits at every value
 * a user can create; a hand-tuned longer string would only prove something
 * about a state that cannot exist.
 *
 * WHY A NEW SPEC RATHER THAN `expectNoHorizontalOverflow()` — and the first
 * answer written here was WRONG, so it is stated with its correction.
 *
 * #2251's body says the shared helper "will NOT catch this — the overflow is
 * clipped by an ancestor rather than reaching the document". That was taken on
 * trust and repeated here, and `haven-reviewer` disproved it. #1779 had already
 * taught the helper to read `main#main-content` as well as the document, and it
 * separates the two cleanly. Run against this spec's own seed at 390, both
 * halves of the fix reverted and then restored:
 *
 *   pre-fix   documentOverflows false   contentOverflowBy 122   hasOverflow TRUE
 *   post-fix  documentOverflows false   contentOverflowBy   0   hasOverflow false
 *
 * So the helper distinguishes broken from fixed here, and the "clipped, so
 * invisible" premise is only true of the `documentElement` half. Believing the
 * issue instead of running the helper is exactly the wrong-instrument mistake
 * this spec is about, one level up.
 *
 * What survives the correction is why a boolean is not enough:
 *
 *   - it could not have caught this in the first place, and did not. The
 *     standing `/agents` mobile check (`navigation.mobile.spec.ts`, "/agents
 *     fits the screen and renders clean") calls that helper and is green on
 *     unchanged `dev`, because the shared fixture leaves `mcp_server_name`
 *     absent and the `not recorded` branch is a 66px label that never
 *     truncates. The seed is what was missing, not the assertion — which is
 *     why the seed here is derived from the connector's own slug bound rather
 *     than picked.
 *   - it cannot name WHICH card, or say what it is measured against. "Some
 *     descendant of `main` is 122px too wide" does not distinguish this from a
 *     stray banner.
 *   - it cannot express the second half of the fix at all. `min-w-0` on the
 *     card alone makes `contentOverflowBy` 0 while the chip renders 264.9px
 *     inside an 86.5px box, spilling out of the card — a boolean reads that as
 *     fixed. The `spillPastCard` assertion below is what catches it, and the
 *     mutation run proves it does.
 *   - it carries no non-vacuity guard, so it cannot tell a fixed layout from a
 *     seed that stopped stressing it.
 *
 * A PNG could not carry any of it either: #1858 is the standing evidence that
 * an overflow photographs perfectly happily, and no committed baseline frames
 * this chip. A class assertion would be worse still — `min-w-0` is present or
 * absent in the string whether or not the resulting column can shrink.
 *
 * FIXTURE FIDELITY (#2298's hazard, checked rather than assumed). Everything
 * this spec seeds is a field `GET /agents` really sends: `mcp_server_name` is
 * selected as `a.mcp_server_name` by `listAgentsForUserAllStatuses`
 * (`infra/repositories/agents.ts:184`), typed `string | null` there and
 * declared `type: ['string','null']` in `openapi/spec.ts:6142`; `status`,
 * `account_type` and `safe_name` come from the same row. The shared
 * `testAgent.allowances` already carries the human-decimal shape #2298 asked
 * for (`'250.000000'`, matching `rails/delegation-budget-view.ts:79`), so
 * nothing here rests on the atomic-shape divergence that issue is about — and
 * nothing here reads the budget amount anyway.
 */
import { expect, test, type Page } from '@playwright/test'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession, testAgent, testSafe } from './fixtures/haven-api'

/** The mobile width #2251 is about, plus the two-column desktop as a control. */
const MOBILE = 390
const DESKTOP = 1280

/**
 * `haven-` + a 32-character slug: the longest `mcp_server_name` the connector
 * can mint (`assertValidServerSlug`, 1–32 lowercase alphanumerics and single
 * hyphens — this slug is 32 and matches `SLUG_RE`).
 */
const LONGEST_SLUG = 'nightly-reconciliation-europe-ab'
const LONGEST_MCP_NAME = `haven-${LONGEST_SLUG}`

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
 * Three cards, because the defect is a property of the COLUMN and not of one
 * card: the widest min-content in the grid sets the track for every sibling,
 * so a single-card seed would understate what a real list does. The wide one
 * is last on purpose — before the fix it dragged the two short cards out with
 * it, which is the user-visible shape of this bug.
 */
const AGENTS = [
  agentSeed('research', { name: 'Research agent' }),
  agentSeed('nightly', { name: 'Nightly reconciliation', status: 'paused' }),
  agentSeed('europe', { name: 'European treasury desk', mcp_server_name: LONGEST_MCP_NAME }),
]

type Reading = {
  label: string
  /** What the card actually rendered at. */
  cardWidth: number
  /** The card's share of the grid's CONTENT box — not the inflated column. */
  trackWidth: number
  /** What the card renders at when the grid is squeezed to 50px. */
  shrunkWidth: number
}

/**
 * Anchor on the explicit card marker, never on a class string or the title
 * link: the class strings and link geometry are what this fix changes, so a
 * probe that read either would be measuring the diff instead of the layout.
 */
async function readCards(page: Page): Promise<Reading[]> {
  return page.evaluate(() => {
    const cards = Array.from(
      document.querySelectorAll('[data-testid="agent-card"]'),
    ) as HTMLElement[]
    if (cards.length === 0) throw new Error('no /agents cards rendered')
    const grid = cards[0].parentElement as HTMLElement

    // The track a card is ENTITLED to: the grid's own content box, divided by
    // the column count and less the gaps. Deliberately not either obvious
    // shortcut, and both were tried:
    //
    //   `grid.clientWidth` alone — right at 390 (one column) and meaningless
    //   at 1280, where `lg:grid-cols-2` sits in a 976px grid and a 480px card
    //   compares against 976. That arm went GREEN on unchanged `dev` while the
    //   card was overflowing its column by 8.3px.
    //
    //   the resolved `grid-template-columns` value — this is the box the
    //   DEFECT ITSELF INFLATES. With the fix reverted the single column
    //   resolves to 488.3px inside a 342px grid, so `card <= track` passes at
    //   488.3 <= 488.3 and the overflow is invisible. Measuring the broken
    //   layout against a number the breakage produced is the exact
    //   wrong-instrument failure this spec is written to avoid; it was caught
    //   by mutating the fix out, not by reading the code.
    //
    // The column COUNT still comes from `grid-template-columns` (1 below `lg`,
    // 2 above) — that is a fact about the layout, not about the overflow.
    const style = getComputedStyle(grid)
    const columnCount = style.gridTemplateColumns
      .split(' ')
      .filter((value) => Number.isFinite(Number.parseFloat(value))).length
    if (columnCount === 0) throw new Error('the agents grid resolved no columns')
    const columnGap = Number.parseFloat(style.columnGap) || 0
    const trackWidth = +(
      (grid.clientWidth - columnGap * (columnCount - 1)) / columnCount
    ).toFixed(1)

    // "Can this card shrink?", asked of the layout rather than of a class
    // string: squeeze the grid and see what the card does. Deliberately NOT
    // `card.style.width = 'min-content'` — that asks for INTRINSIC min-content,
    // which `min-w-0` does not lower (it removes the automatic minimum, it
    // does not make nowrap text narrower), so the probe read 488.3px both
    // before and after the fix and could never have gone green.
    const previousGridWidth = grid.style.width
    grid.style.width = '50px'
    const shrunk = cards.map((card) => +card.getBoundingClientRect().width.toFixed(1))
    grid.style.width = previousGridWidth

    return cards.map((card, i) => ({
      label: card.querySelector('h3')?.textContent?.trim() ?? '',
      cardWidth: +card.getBoundingClientRect().width.toFixed(1),
      trackWidth,
      shrunkWidth: shrunk[i],
    }))
  })
}

type ChipReading = {
  /** The chip's rendered width. */
  width: number
  /** Its untruncated width — readable even while it is ellipsised. */
  natural: number
  truncated: boolean
  /** How far the chip's right edge sits past the card's own right edge. */
  spillPastCard: number
  /** Card left edge -> chip left edge: border, padding, bot tile, `MCP:`. */
  leftInset: number
  /** The copy button beside the chip, plus the wrapper's gap. */
  rightChrome: number
  text: string
}

/**
 * The MCP chip on the wide card — the descendant that could not shrink.
 * Located through the value it renders, not through its classes.
 */
async function readChip(page: Page, value: string): Promise<ChipReading> {
  return page.evaluate((mcpName) => {
    const chip = Array.from(document.querySelectorAll('span')).find(
      (el) => el.children.length === 0 && (el.textContent ?? '').trim() === mcpName,
    ) as HTMLElement | undefined
    if (!chip) throw new Error(`no MCP chip rendering "${mcpName}"`)
    const card = chip.closest('[data-testid="agent-card"]') as HTMLElement
    if (!card) throw new Error('the MCP chip is not inside an /agents card')
    // The chrome on either side of the chip, measured rather than assumed —
    // and deliberately measured as OFFSETS, which is the part this fix cannot
    // move. `leftInset` is the card's border+padding, the 36px bot tile, the
    // 12px header gap and the `MCP:` label; `rightChrome` is the copy button
    // and its gap. Neither depends on how wide the chip itself is, so the room
    // derived from them below reads the same before and after the fix — which
    // is what makes it usable as a non-vacuity guard.
    const mcpWrapper = chip.parentElement!.parentElement as HTMLElement
    const copyButton = mcpWrapper.querySelector('button')
    if (!copyButton) throw new Error('the MCP chip renders no copy button beside it')
    const chipBox = chip.getBoundingClientRect()
    const cardBox = card.getBoundingClientRect()
    // The copy button's own width plus the wrapper's gap — NOT
    // `wrapper.right - chip.right`, which is negative before the fix because
    // the un-shrinkable chip overflows the wrapper it sits in. An offset
    // measured against a box the defect itself distorts is not fix-independent.
    const gap = Number.parseFloat(getComputedStyle(mcpWrapper).columnGap) || 0
    return {
      width: +chipBox.width.toFixed(1),
      natural: chip.scrollWidth,
      truncated: chip.scrollWidth > chip.clientWidth + 1,
      spillPastCard: +(chipBox.right - cardBox.right).toFixed(1),
      leftInset: +(chipBox.left - cardBox.left).toFixed(1),
      rightChrome: +(copyButton.getBoundingClientRect().width + gap).toFixed(1),
      text: (chip.textContent ?? '').trim(),
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

/** Below `lg` the nav drawer overlays the grid (#1749); the helper is a no-op at 1280. */
async function atWidth(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 })
  await dismissMobileSidebar(page)
}

test('/agents: every card fits its grid track at 390', async ({ page }) => {
  test.slow()
  await openAgents(page)
  await atWidth(page, MOBILE)
  const readings = await settled(() => readCards(page))

  expect(readings.length, 'the seed must render all three cards').toBe(AGENTS.length)

  // Non-vacuity #1: we must really be in the one-column mobile layout. If the
  // track were the full viewport this would pass for a page that simply never
  // narrowed, which is the failure #2251 warns about — evidence captured at
  // the wrong viewport.
  const track = readings[0].trackWidth
  expect(
    track,
    `@${MOBILE}px: the grid track is ${track}px — this is not the mobile layout the issue is about`,
  ).toBeLessThan(MOBILE)

  // Non-vacuity #2: the seed must genuinely stress the column, stated in terms
  // this fix CANNOT move. `leftInset` and `rightChrome` are offsets — the
  // card's padding, the bot tile, the header gap, the `MCP:` label, the copy
  // button — none of which change width when the chip starts truncating, so
  // the room they leave a chip inside a track-width card reads the same before
  // and after the fix. The chip's untruncated measure must exceed it.
  //
  // "Is it truncated?" deliberately is NOT this guard, and that was learned by
  // running it: BEFORE the fix the chip is not truncated at all — the card
  // simply grew to fit it — so a truncation precondition goes red on unchanged
  // `dev` for the opposite of the right reason and hides the real assertions
  // behind it. Truncation is an OUTCOME of the fix and is asserted as one,
  // below.
  const chip = await settled(() => readChip(page, LONGEST_MCP_NAME))
  expect(
    chip.text,
    'the wide card must render the longest legal MCP server name',
  ).toBe(LONGEST_MCP_NAME)
  const roomAtTrack = +(track - chip.leftInset - chip.rightChrome).toFixed(1)
  expect(
    chip.natural,
    `@${MOBILE}px: the seeded MCP chip measures ${chip.natural}px against the ${roomAtTrack}px a ` +
      `${track}px track leaves it (${chip.leftInset}px of card chrome to its left, ` +
      `${chip.rightChrome}px to its right) — it FITS, so this seed does not stress the column and ` +
      `nothing below is under test`,
  ).toBeGreaterThan(roomAtTrack)

  for (const reading of readings) {
    // The defect, stated as the user sees it.
    expect(
      reading.cardWidth,
      `@${MOBILE}px: "${reading.label}" renders ${reading.cardWidth}px in a ${reading.trackWidth}px ` +
        `grid track — it overflows by ${(reading.cardWidth - reading.trackWidth).toFixed(1)}px and is ` +
        `clipped by the overflow-hidden ancestor, not scrollable`,
    ).toBeLessThanOrEqual(reading.trackWidth + 0.5)

    // And the structural half: the card must be ABLE to shrink, not merely
    // happen to fit this seed. Squeezed to a 50px grid it must actually get
    // narrower than the track; a card still pinned at its content width would
    // pass the check above only until the next fixture edit widened something.
    expect(
      reading.shrunkWidth,
      `@${MOBILE}px: squeezed into a 50px grid, "${reading.label}" still renders ` +
        `${reading.shrunkWidth}px — wider than the ${reading.trackWidth}px track, so the grid item's ` +
        `automatic minimum size is still binding and this seed only happens to fit`,
    ).toBeLessThan(reading.trackWidth)
  }

  // The second half of the fix: with the card capped, the chip must ELLIPSISE
  // inside it rather than spill out of the card and be clipped by `main`.
  // `min-w-0` on the card alone gives a 342px card with a 264.9px chip hanging
  // out of an 86.5px box, which looks identical in a DOM width check and
  // exactly as broken on screen.
  const settledChip = await settled(() => readChip(page, LONGEST_MCP_NAME))
  expect(
    settledChip.truncated,
    `@${MOBILE}px: the ${settledChip.natural}px MCP chip renders whole in a ${settledChip.width}px ` +
      `box — the card is still buying its width from the grid track instead of truncating`,
  ).toBe(true)
  expect(
    settledChip.spillPastCard,
    `@${MOBILE}px: the MCP chip's right edge sits ${settledChip.spillPastCard}px past its card's — it is ` +
      `spilling out of the card instead of truncating inside it`,
  ).toBeLessThanOrEqual(0.5)
})

test('/agents: every card fits its column in the two-column desktop grid', async ({ page }) => {
  test.slow()
  await openAgents(page)
  await atWidth(page, DESKTOP)
  const readings = await settled(() => readCards(page))

  // A CONTROL, and honestly labelled as one: this whole test is green on
  // unchanged `dev` and stays green after the fix. It is not evidence of the
  // defect and is not counted as any.
  //
  // It is worth its runtime because it says WHERE the defect lives and pins
  // the boundary. Tailwind's `lg:grid-cols-2` is `repeat(2, minmax(0, 1fr))`,
  // and that explicit `0` minimum already overrides the item's automatic
  // minimum size — so at 1280 the card sits at exactly its 480px column even
  // on unchanged `dev` (measured: 480px card, 480px column, chip rendering all
  // 287px). Below `lg` there is no `grid-template-columns` at all, the implicit
  // column is `auto`, and `auto`'s minimum IS the item's min-content — which is
  // the entire defect. #2251 is a below-`lg` bug for a reason that is a
  // property of the grid declaration, not of the viewport.
  //
  // Its live job is the other direction: a "fix" that squeezed the card at 390
  // by breaking the desktop grid would go red here.
  for (const reading of readings) {
    expect(
      reading.cardWidth,
      `@${DESKTOP}px: "${reading.label}" renders ${reading.cardWidth}px in a ${reading.trackWidth}px track`,
    ).toBeLessThanOrEqual(reading.trackWidth + 0.5)
  }

  // The chip must stay INSIDE the card at desktop too. Before the fix it did
  // not: at 1280 the un-shrinkable 287px chip floored the card at 488.3px
  // against a 480px column, so the card overflowed its own track by 8.3px on a
  // wide screen as well — the mobile clip was the visible end of a defect that
  // was never mobile-only.
  const chip = await settled(() => readChip(page, LONGEST_MCP_NAME))
  expect(
    chip.spillPastCard,
    `@${DESKTOP}px: the MCP chip's right edge sits ${chip.spillPastCard}px past its card's`,
  ).toBeLessThanOrEqual(0.5)

  // NOT asserted here, and recorded so the next reader does not think it was
  // missed: what the desktop column now does with the longest legal name is
  // TRUNCATE it — 200.5px of a 287px name in a 480px card, where before the
  // fix all 287px rendered and the card overflowed instead. Nothing is wasted
  // doing it: the header row is icon 36 + gap 12 + block 259.2 + gap 12 +
  // stamp 118.8 = 438px, the card's whole content box, so this is not #2237's
  // "a name the card had room for was cut". The name stays fully recoverable
  // through the chip's tooltip and the copy button beside it, which is what
  // `truncate` on this chip has always meant. Giving it more room would mean
  // taking it from the `shrink-0` "Last activity" stamp — a design decision
  // this issue did not ask for and this diff deliberately does not make.
})
