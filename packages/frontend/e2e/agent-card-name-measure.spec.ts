/**
 * `/agents`: the `AgentCard` title row — the agent name's measure beside the
 * status pill (#2237).
 *
 * WHAT WAS BROKEN. The row was `flex items-center gap-2` holding a `truncate`
 * `h3` and, when the agent is not active, one status pill. `truncate` makes the
 * `h3` the only compressible item in the row, so the row bought its chrome with
 * the agent's identity — exactly #2223's defect on `/accounts`, one card type
 * over, and the reason #2238's reviewer filed this rather than letting the
 * pre-#2223 idiom survive somewhere else.
 *
 * IT IS A REAL RENDERING DEFECT HERE, NOT ONLY AN INCONSISTENCY, and that was
 * settled by measurement rather than by the pattern. On unchanged `origin/dev`,
 * at 1280, with one paused agent seeded:
 *
 *   title row content width          259px
 *   `paused` pill + gap              54.5 + 8 = 62.5px
 *   => the name is capped at         196.5px, whatever it says
 *
 *   "Nightly data-feed reconciliation agent" measures **256.2px** — it FITS
 *   the 259px row — and rendered **ellipsised at 196.7px, 75.9% of the row**.
 *   The same string on an ACTIVE agent (no pill) renders in full at 256.2px.
 *
 * So a name the card had room for was cut, and every name past 196.5px was cut
 * 62.5px earlier than the container required. `/accounts` read 41.7% with two
 * badges; this reads 75.9% with one. Narrower, same defect.
 *
 * WHAT WRAPPING COSTS, because a fix for one thing on a shared row that
 * silently costs another is not a fix (#2240). When the pill does move down the
 * title row grows 20px -> 48px and the card 332px -> 360px. That cost stops at
 * the card that wraps: `AgentPanel`'s grid is `items-start`, where `/accounts`
 * is `align-items: stretch` and propagated #2223's wrap to the whole grid row.
 * Nothing else competes for this width — at most ONE pill renders here
 * (`!isActive`), so there is no badge pair to orphan (#2235) and no hover
 * actions to reserve for (#2236). Both of #2240's fixes are inapplicable, which
 * is why it correctly concluded its work did not close this issue.
 *
 * WHY GEOMETRY AND NOT A SCREENSHOT — the reason `transaction-title-measure`
 * (#1827) and `accounts-name-measure` (#2223) give. The one committed baseline
 * on this surface, `agentcard-banner-paused-desktop.png`, photographs the
 * BANNER, not the title row, so no pixel gate can see any of this. A class
 * assertion cannot see it either: `flex-wrap` is present or absent in the
 * string whether or not the resulting layout keeps the name readable.
 *
 * WHICH ARM CATCHES WHICH WIDTH — measured, not assumed, because they are NOT
 * redundant and a table of green ticks would hide that:
 *
 *   @1280  BOTH arms go red on unchanged `dev`. The band name is ellipsised at
 *          75.9% of its row; the unbounded name occupies the same 196.7px.
 *   @390   only the UNBOUNDED arm goes red (85.9% of a 444px row). The band
 *          name measures 256.2px against a row that offers 381.5px even with
 *          the pill, so it fits and is not ellipsised — it is BELOW this
 *          width's band, not evidence that this width was checked by it.
 *
 * The band is derived, not picked: a name is cut-though-it-fits exactly when it
 * measures more than `rowInner - pill - gap` and at most `rowInner`. At 1280
 * that is (196.5, 259]; at 390 it is (381.5, 444]. `BAND_NAME` at 256.2px sits
 * inside the first and below the second. No literal is written for the second
 * band on purpose: `/agents` cards do not shrink below ~399px of min-content at
 * any viewport (the footer's action row is the floor), so at 390 the card
 * overflows its own grid track and its width is content-derived and unstable —
 * a literal tuned to it would be a failure waiting for the next fixture edit.
 * That overflow is PRE-EXISTING, unchanged by this diff and out of its scope;
 * it is why the unbounded arm carries 390 rather than a second literal.
 */
import { expect, test, type Page } from '@playwright/test'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession, testAgent, testSafe } from './fixtures/haven-api'

const WIDTHS = [1280, 390] as const

/**
 * Inside the 1280 band: longer than the 196.5px the pre-fix row left for it,
 * shorter than the 259px row itself. This is the string the issue's defect is
 * actually visible on — an ordinary, plausible agent name, not a pathological
 * one.
 */
const BAND_NAME = 'Nightly data-feed reconciliation agent'

/**
 * Long enough that no arrangement of this card shows it whole at either width,
 * so the truncation it provokes is a property of the CONTAINER rather than of
 * the string — which is what makes its measure a fair reading of how much room
 * the row actually gave the name.
 */
const UNBOUNDED_NAME = 'European entity nightly data-feed reconciliation and reporting agent'

/**
 * A truncated name must fill essentially the whole row. 0.95 rather than 1.0
 * only absorbs sub-pixel rounding: when the name is alone on its flex line its
 * measure IS the line. The defect reads 75.9% at 1280 and 85.9% at 390, so
 * nothing sits near the threshold — but note how much closer 85.9% is than
 * `/accounts`' 49.9%, which is the whole "one pill, not two" difference.
 */
const MIN_TRUNCATED_SHARE_OF_ROW = 0.95

/**
 * The rendered `paused` pill is 54.5px at both widths; `sr-only` is 1px. 24px
 * therefore sits with ~2x headroom on one side and 24x on the other — the same
 * threshold, and the same three conditions, `accounts-name-measure` arrived at
 * after `haven-reviewer`'s `sr-only` mutation survived two patches there.
 */
const MIN_PILL_WIDTH = 24

type Reading = {
  text: string
  /** The rendered width of the name box — what the row actually gave it. */
  measure: number
  /** The name's NATURAL width, readable even while it is ellipsised. */
  natural: number
  /** The title row's own content width — what is available to the whole row. */
  rowInner: number
  rowHeight: number
  truncated: boolean
  /** Status pills that are laid out AS CHROME, not merely present in the DOM. */
  pills: string[]
  pillWidths: number[]
}

/**
 * Anchor on the card's `aria-label` and the `h3` inside it — never on a class
 * string, since the class strings are what this fix changes.
 *
 * The row is the `h3`'s parent on both the pre-fix and post-fix trees (the fix
 * adds classes, it does not restructure), so this probe reads the same element
 * under every mutation below — including the full revert, which is what lets
 * the numbers in the header be compared like for like.
 */
async function readCard(page: Page, agentName: string): Promise<Reading> {
  return page.evaluate(
    ([label, minPill]) => {
      const card = document.querySelector(`[role="link"][aria-label="View ${label}"]`)
      if (!card) throw new Error(`no /agents card labelled "View ${label}"`)
      const h3 = card.querySelector('h3')
      if (!h3) throw new Error(`the card labelled "View ${label}" renders no name`)
      const row = h3.parentElement as HTMLElement

      // Three conditions, each ruling out one half of the `sr-only` mutation
      // that survived two patches on #2238: `getClientRects()` for
      // `display: none`, `position: static` for anything pulled out of flow
      // (Tailwind's `sr-only` is `position: absolute` at 1x1px with `clip`, so
      // it IS laid out and it DOES have width), and a real pill width for the
      // 1px box. A check that reads `textContent` is not a check.
      const pills = Array.from(row.querySelectorAll('span')).filter(
        (el) =>
          el.getClientRects().length > 0 &&
          getComputedStyle(el).position === 'static' &&
          el.getBoundingClientRect().width >= (minPill as number),
      )

      return {
        text: (h3.textContent ?? '').trim(),
        measure: +h3.getBoundingClientRect().width.toFixed(1),
        natural: h3.scrollWidth,
        rowInner: +row.clientWidth.toFixed(1),
        rowHeight: +row.getBoundingClientRect().height.toFixed(1),
        truncated: h3.scrollWidth > h3.clientWidth + 1,
        pills: pills.map((el) => (el.textContent ?? '').trim()),
        pillWidths: pills.map((el) => +el.getBoundingClientRect().width.toFixed(1)),
      }
    },
    [agentName, MIN_PILL_WIDTH] as const,
  )
}

/** Settle until two consecutive reads agree — a fixed wait yields stale numbers. */
async function readSettled(page: Page, agentName: string): Promise<Reading> {
  let reading = await readCard(page, agentName)
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150)
    const again = await readCard(page, agentName)
    if (JSON.stringify(again) === JSON.stringify(reading)) break
    reading = again
  }
  return reading
}

function agentNamed(name: string, id: string, status: 'active' | 'paused') {
  return {
    ...testAgent,
    id,
    name,
    status,
    description: null,
    account_type: 'delegator_hybrid',
    safe_id: testSafe.id,
    safe_name: testSafe.name,
    mcp_server_name: `haven-${id}`,
    mcp_last_seen_at: '2026-07-10T08:12:00.000Z',
    has_stranded_funds: false,
  }
}

/**
 * Serve `/agents` with the agents this test is about. Registered AFTER
 * `mockHavenApi`, so it wins — Playwright consults the most recently added
 * handler first. Nothing in the shared `e2e/fixtures/haven-api.ts` is edited,
 * and `scripts/screenshot.mjs` is not touched at all, so no other spec and no
 * capture scenario moves (which is also what keeps #2225 untouched).
 */
async function serveAgents(page: Page, agents: unknown[]) {
  await page.route('**/api/agents', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agents }),
    })
  })
}

async function openAgents(page: Page, firstName: string) {
  await page.goto('/agents')
  await page.getByRole('heading', { name: firstName, exact: true }).waitFor({ timeout: 60_000 })
}

/** Below `lg` the nav drawer overlays the grid (#1749); the shared helper is a no-op at 1280. */
async function atWidth(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 })
  await dismissMobileSidebar(page)
}

test('/agents: a paused agent name the row has room for is not cut by the status pill', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await serveAgents(page, [agentNamed(BAND_NAME, 'agent-band', 'paused')])
  await seedAuthenticatedSession(page)
  await openAgents(page, BAND_NAME)

  // 1280 only, and deliberately so: at 390 this string is BELOW the band (it
  // fits beside the pill even on the broken row), so asserting it there would
  // be a green that means nothing. The unbounded test below is what carries
  // 390 — see the header.
  await atWidth(page, 1280)
  const reading = await readSettled(page, BAND_NAME)

  // Non-vacuity, in both directions. The pill must be rendered as chrome —
  // otherwise this passes for a layout that simply deleted it — and the name
  // must genuinely be in the band, otherwise the claim below is about a string
  // that would have fitted anyway.
  expect(reading.pills, `@1280px: the title row renders ${JSON.stringify(reading.pills)} (widths ${JSON.stringify(reading.pillWidths)})`)
    .toEqual(['paused'])
  const pillRoom = reading.pillWidths[0] + 8
  expect(
    reading.natural,
    `@1280px: "${BAND_NAME}" measures ${reading.natural}px, which is not inside this row's band ` +
      `(${(reading.rowInner - pillRoom).toFixed(1)}, ${reading.rowInner}] — the name would fit beside the pill anyway, ` +
      `so this test would prove nothing`,
  ).toBeGreaterThan(reading.rowInner - pillRoom)
  expect(reading.natural).toBeLessThanOrEqual(reading.rowInner)

  // The defect, stated as the user sees it.
  expect(
    reading.truncated,
    `@1280px: "${reading.text}" is ellipsised into ${reading.measure}px of a ${reading.rowInner}px row ` +
      `that its ${reading.natural}px name fits`,
  ).toBe(false)
})

test('/agents: an unbounded paused name truncates against the card, not against the pill', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await serveAgents(page, [agentNamed(UNBOUNDED_NAME, 'agent-unbounded', 'paused')])
  await seedAuthenticatedSession(page)
  await openAgents(page, UNBOUNDED_NAME)

  for (const width of WIDTHS) {
    await atWidth(page, width)
    const reading = await readSettled(page, UNBOUNDED_NAME)

    expect(reading.pills, `@${width}px: the title row renders ${JSON.stringify(reading.pills)} (widths ${JSON.stringify(reading.pillWidths)})`)
      .toEqual(['paused'])

    // Agent names are user-supplied and unbounded, so a name this long MUST
    // still truncate — a card that grew to fit one would be a different defect,
    // and without this the share check could be satisfied by a short string.
    expect(
      reading.truncated,
      `@${width}px: an unbounded name was NOT truncated (${reading.measure}px in a ${reading.rowInner}px row)`,
    ).toBe(true)

    const share = reading.measure / reading.rowInner
    expect(
      share,
      `@${width}px: the truncated name occupies ${(share * 100).toFixed(1)}% of the ${reading.rowInner}px row (${reading.measure}px)`,
    ).toBeGreaterThanOrEqual(MIN_TRUNCATED_SHARE_OF_ROW)
  }
})

test('/agents: an ACTIVE agent renders no pill and its name is unmoved', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await serveAgents(page, [agentNamed(BAND_NAME, 'agent-active', 'active')])
  await seedAuthenticatedSession(page)
  await openAgents(page, BAND_NAME)

  for (const width of WIDTHS) {
    await atWidth(page, width)
    const reading = await readSettled(page, BAND_NAME)

    // This is the state the defect hid behind — every agent in the standing
    // capture fixture but one is active, so the pill never renders and the name
    // has the row to itself. It is the case this change had to be free in, and
    // it is asserted rather than assumed: the row stays ONE line tall, the name
    // is whole, and no pill appears.
    expect(reading.pills, `@${width}px: an active card renders ${JSON.stringify(reading.pills)}`).toEqual([])

    // "The name gets the row" — expressed as a measure rather than as
    // `truncated === false`, because whether this string fits is a property of
    // the VIEWPORT, not of the fix: at 1280 the row offers 259px and the name
    // is whole, while at 390 a single-agent grid gives it a 178px row and it
    // legitimately ellipsises against the card. Asserting "not truncated" at
    // both widths was red on unchanged `dev` for a reason that has nothing to
    // do with this issue, which is a control that would have failed inside
    // every mutation run it exists to validate.
    const share = reading.measure / reading.rowInner
    expect(
      share,
      `@${width}px: an active card's name occupies ${(share * 100).toFixed(1)}% of its ${reading.rowInner}px row ` +
        `(${reading.measure}px of a ${reading.natural}px name)`,
    ).toBeGreaterThanOrEqual(reading.natural <= reading.rowInner ? 0 : MIN_TRUNCATED_SHARE_OF_ROW)
    expect(
      reading.truncated,
      `@${width}px: an active card ellipsised "${reading.text}" (${reading.natural}px) in a ${reading.rowInner}px row`,
    ).toBe(reading.natural > reading.rowInner)

    // One line: no pill means nothing can wrap, before or after this change.
    expect(reading.rowHeight, `@${width}px: the title row is ${reading.rowHeight}px tall`).toBeLessThan(30)
  }
})
