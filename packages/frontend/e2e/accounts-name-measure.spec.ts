/**
 * `/accounts`: the card's title row — name measure, badge placement, and the
 * hover actions' reservation (#2223, then #2235 and #2236).
 *
 * WHAT WAS BROKEN, in three instalments on one row.
 *
 * #2223 — the row was `flex items-center` with both badges `flex-shrink-0`,
 * which made the `h3` the only compressible item in it. So the row bought its
 * chrome with the identity: on the two-account fixture the 17-character name
 * "Operating wallet" rendered as "Operatin…" at 1280 (90.4px of a 217px row)
 * and "Operating wal…" at 390. Fixed by `flex-wrap` + `min-w-0 truncate`.
 *
 * #2235 — the wrap's cosmetic consequence. The two badges were independent
 * `flex-shrink-0` siblings, so the row could break BETWEEN them and `default`
 * landed ALONE on a second line. They are now one wrappable group, so the row
 * can only break in front of the PAIR: either both sit beside the name or both
 * move under it together. (The issue proposed moving `default` to the caption
 * line instead. Rendered, that line already measures ~255px of a 265px card at
 * 1280 with `● Base Sepolia` — it overflowed and stranded the separator, which
 * is the same defect one row down. Measured, not assumed.)
 *
 * #2236 — the hover actions were `absolute top-3 right-3` and measure
 * **102.6px** ("Set active" 72.6 + gap 4 + the star 26), while the title row
 * reserved a hand-picked `pr-12` (48px). Measured hovered on unchanged `dev`,
 * they painted a **42.7 x 14px** region of the name's own box at 1280 and
 * **46.6 x 18px** at 390. The actions are now the title row's second column in
 * normal flow, so the reservation IS what they measure — and is zero on a card
 * that renders neither button.
 *
 * WHY THESE THREE ARE ONE SPEC AND NOT THREE. They are one row's width, spent
 * three ways: the name's measure, where the badges sit, and what the actions
 * reserve. Every fix for one is payable out of the other two, so a test that
 * watched only one of them would sign off on a fix that quietly moved the cost
 * next door. Each test below therefore asserts its own claim AND the measure
 * it could have stolen from.
 *
 * WHY GEOMETRY AND NOT A SCREENSHOT — the same reason as
 * `transaction-title-measure.spec.ts` (#1827): the *Design visual regression*
 * job pixel-compares `/design-system` only, and `/accounts` has no committed
 * baseline at any width. No pixel gate can see any of this, before or after.
 * A class assertion cannot see it either — `flex-wrap`, `pr-12` and a column
 * split are present or absent in the string whether or not the resulting
 * layout keeps the name readable and unoccluded.
 *
 * WHAT IS ASSERTED, AND WHY THE HALVES TOGETHER. Asserting only "the name is
 * not ellipsised" would pass for a fix that deletes the badges, and would say
 * nothing about a name too long to fit however the row is arranged. Asserting
 * only a measure floor would pass for a layout that gives the name room by
 * ellipsising it to a wide-but-empty box. So each width asserts:
 *
 *   1. an ORDINARY name (the fixture's own, the string in the issue) is
 *      rendered in FULL beside its chrome — the exact #2223 defect;
 *   2. an UNBOUNDED name still truncates, but against the CONTAINER: its
 *      measure is >= 95% of the row's own content width, so the ellipsis is
 *      the row running out of card, not the row paying for pills or buttons;
 *   3. both badges are still VISIBLY rendered — laid out, in flow, at a real
 *      pill width — so neither result was bought by removing the chrome. Since
 *      #2235 that scan spans the title row AND the caption line: the badge
 *      MOVED, so its assertion moved with it rather than being deleted.
 *
 * (2) is deliberately expressed as a FRACTION of the measured row rather than
 * a pixel count: the card's width depends on how many accounts exist and on
 * the grid's breakpoint, so any fixed number is a new failure waiting for the
 * first string that exceeds it.
 *
 * The single-account case is asserted too — it is what the #2223 defect hid
 * behind, and it must stay unchanged.
 *
 * WHICH ARM CATCHES WHICH WIDTH, measured rather than assumed, because the
 * arms are NOT redundant:
 *
 *   @1280  (1) fails on pre-#2223 `dev`: "Operating wallet" ellipsised into
 *          90.4px of a 217px row — 41.7%. (2) fails at 49.9%.
 *   @390   (1) PASSES on pre-#2223 `dev`: the same name measures 125.7px
 *          against a natural 126.9px in a 252px row, so at this project's
 *          deviceScaleFactor 1 it fits by about a pixel and is not ellipsised.
 *          (2) fails at 49.9%.
 *
 * So the mobile half of #2223 is caught by the UNBOUNDED arm, not the ordinary
 * one — stated here so nobody reads a green (1) at 390 as evidence that 390
 * was ever checked by it. The capture harness renders 390 at
 * deviceScaleFactor 2, where the same string DOES ellipsise ("Operating wal…",
 * the issue's own reading); that one pixel is exactly how narrow the margin
 * was, and is why (2) exists rather than a second literal name.
 */
import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, testSafe, testUser } from './fixtures/haven-api'

/** The name in the issue, and the shared capture fixture's own. 17 characters. */
const ORDINARY_NAME = 'Operating wallet'
/**
 * Long enough that no arrangement of this card can show it whole at either
 * width, so the truncation it provokes is a property of the container rather
 * than of the string.
 */
const UNBOUNDED_NAME = 'Treasury operations wallet for the European entity'
/**
 * The SECOND card is the only one that renders hover actions — both buttons
 * are gated on `!isActive` / `!safe.is_default`, so the active+default card
 * the issues photograph renders none at all. #2236 lives here, and its name is
 * long on purpose: a short one would not reach the actions even when the row
 * was mis-reserved, which is exactly how the mismatch stayed latent.
 */
const ACTION_CARD_NAME = 'Imported Safe for the European entity treasury'
/**
 * The name length at which the row wraps but only just — and the ONLY band in
 * which #2235's defect is reachable. Derived from the measured pieces rather
 * than picked: at 1280 the title row is 265px, `Active` is 58.2px and
 * `default` 52.1px with 8px gaps, so a name strands `default` on its own line
 * exactly when it measures more than 138.7px (name + both badges overflow) and
 * at most 198.8px (name + `Active` still fit). At 390 the row is 300px and the
 * band is 173.7..233.8px. This string measures ~182px, which is inside both.
 *
 * An UNBOUNDED name does NOT exercise this: at 265px of name nothing fits
 * beside it, so both badges wrap together even when they are two independent
 * siblings — the pre-fix tree passes that check. Measured, after the full
 * revert mutation went green on it.
 */
const WRAPPING_NAME = 'Operating wallet Europe'

const SECOND_SAFE = {
  ...testSafe,
  id: 'safe-second',
  safe_address: '0x4444444444444444444444444444444444444444',
  name: 'Imported Safe',
  is_default: false,
  created_at: '2026-04-20T10:00:00.000Z',
}

const WIDTHS = [1280, 390] as const

/**
 * A truncated name must fill essentially the whole row. 0.95 rather than 1.0
 * only to absorb sub-pixel rounding: when the name is the only item on its
 * flex line its measure IS the line, so the healthy reading is ~100%. The
 * #2223 defect reads ~45% at both widths, so nothing sits near this threshold.
 */
const MIN_TRUNCATED_SHARE_OF_ROW = 0.95

type Rect = { x: number; y: number; w: number; h: number }

type CardReading = {
  text: string
  measure: number
  /** The title row's own content width — what is actually available to the name. */
  rowInner: number
  /** The card's content-box width, so a reservation can be expressed as a share of it. */
  cardInner: number
  rowHeight: number
  nameHeight: number
  truncated: boolean
  badges: string[]
  /** Where each badge landed, so "on the caption line" is a measurement. */
  badgeRects: Record<string, Rect>
  captionRect: Rect
  nameRect: Rect
  /** null when the card renders no actions — which is itself the assertion for #2236's dead-reservation half. */
  actionsRect: Rect | null
  actionsOpacity: number
}

/**
 * Anchor on the card's `aria-label` and the `h3` inside it — never on a class
 * string, since the class strings are what these fixes change.
 *
 * `rowInner` is the width available to the NAME: the title row's client width
 * minus its own padding. Before #2236 that padding was `pr-12`, a reservation
 * for absolutely-positioned actions; now the actions are a sibling column and
 * the row carries no padding at all, so the same expression keeps meaning the
 * same thing across the fix rather than needing two readings.
 */
async function readCard(page: Page, accountName: string): Promise<CardReading> {
  return page.evaluate((label) => {
    const card = document.querySelector(`a[aria-label="${label}"]`)
    if (!card) throw new Error(`no /accounts card labelled "${label}"`)
    const h3 = card.querySelector('h3')
    if (!h3) throw new Error(`the card labelled "${label}" renders no name`)
    const row = h3.parentElement!
    const padRight = parseFloat(getComputedStyle(row).paddingRight) || 0
    const rect = (el: Element): Rect => {
      const b = el.getBoundingClientRect()
      return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }
    }

    // Header and caption, anchored so the probe survives the LAYOUT it is
    // testing. Walking `row.parentElement` and its `nextElementSibling` works
    // on the current DOM and silently breaks on the pre-#2236 one, where the
    // title row is a direct child of the card: `header` becomes the card, and
    // `caption` becomes the NEXT CARD — or `null` with a single account, which
    // crashed the positive control inside the very mutation run it exists to
    // validate. A control that cannot survive the mutation is not a control.
    //
    // So: the header is whichever direct child of the card contains the name,
    // and the caption is the direct child that carries the age line. Both hold
    // on either shape, and neither reads a class string.
    const cardChildren = Array.from(card.children)
    const header = cardChildren.find((el) => el.contains(h3))!
    const caption = cardChildren.find(
      (el) => el !== header && /Added /.test(el.textContent ?? ''),
    ) as HTMLElement
    if (!caption) throw new Error(`the card labelled "${label}" renders no caption line`)

    // Badges, laid out AS CHROME rather than merely present in the DOM.
    // `haven-reviewer` defeated a text-only version of this check with its own
    // mutation on #2223: drop `flex-wrap` AND give both badges `sr-only`, and
    // every test passed — `position: absolute` takes them out of flex flow, so
    // the `h3` gets the whole row exactly as a real wrap would, while their
    // text nodes stay queryable. A layout no sighted user gets, invisible to
    // the very check that exists to say "this was not bought by deleting the
    // chrome".
    //
    // A first attempt at that fix — `getClientRects().length > 0` plus a
    // non-zero width — did NOT kill it, and that is worth writing down rather
    // than quietly replacing: Tailwind's `sr-only` is `position:absolute` at
    // 1x1px with `clip`, so it IS laid out and it DOES have width. All three
    // conditions below are needed, and each rules out one half of that
    // mutation: `getClientRects()` for display:none, `position: static` for
    // anything pulled out of flow, and a real pill width for the 1px box. 24px
    // is measured, not guessed: the rendered pills are 58.2px (`Active`) and
    // 52.1px (`default`) at BOTH widths, and `sr-only` is 1px — so the
    // threshold sits with ~2x headroom on one side and 24x on the other.
    //
    // SCANNED ACROSS BOTH ROWS since #2235. `default` moved to the caption, so
    // a scan pinned to the title row would have read its own success as the
    // badge disappearing — the deletion this check exists to catch.
    const badgeRects: Record<string, Rect> = {}
    const badges = [...header.querySelectorAll('span'), ...caption.querySelectorAll('span')]
      .filter(
        (el) =>
          el.getClientRects().length > 0 &&
          getComputedStyle(el).position === 'static' &&
          el.getBoundingClientRect().width >= 24,
      )
      .map((el) => [(el.textContent ?? '').trim(), el] as const)
      .filter(([t]) => t === 'Active' || t === 'default')
    for (const [t, el] of badges) badgeRects[t] = rect(el)

    // The hover actions — identified by the buttons they hold rather than by
    // position, so this reads the same block whether it is the header's second
    // column (now) or an absolutely-positioned overlay (before #2236).
    const actionsEl = card.querySelector('button')?.parentElement ?? null

    return {
      text: (h3.textContent ?? '').trim(),
      measure: +h3.getBoundingClientRect().width.toFixed(1),
      rowInner: +(row.clientWidth - padRight).toFixed(1),
      cardInner: +(
        card.clientWidth -
        (parseFloat(getComputedStyle(card).paddingLeft) || 0) -
        (parseFloat(getComputedStyle(card).paddingRight) || 0)
      ).toFixed(1),
      rowHeight: +row.getBoundingClientRect().height.toFixed(1),
      nameHeight: +h3.getBoundingClientRect().height.toFixed(1),
      truncated: h3.scrollWidth > h3.clientWidth + 1,
      badges: Array.from(new Set(badges.map(([t]) => t))),
      badgeRects,
      captionRect: rect(caption),
      nameRect: rect(h3),
      actionsRect: actionsEl ? rect(actionsEl) : null,
      actionsOpacity: actionsEl ? Number(getComputedStyle(actionsEl).opacity) : 0,
    }
  }, accountName)
}

/** Settle until two consecutive reads agree — a fixed wait yields stale numbers. */
async function readCardSettled(page: Page, accountName: string): Promise<CardReading> {
  let reading = await readCard(page, accountName)
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150)
    const again = await readCard(page, accountName)
    if (JSON.stringify(again) === JSON.stringify(reading)) break
    reading = again
  }
  return reading
}

/**
 * Put the pointer on a card and WAIT for the hover state to actually engage.
 *
 * `locator.hover()` alone was not enough at 390, where the second card starts
 * below the fold: the scroll it triggers is still settling when the mouse move
 * is dispatched, so the pointer lands where the card used to be and the read
 * below sees `opacity: 0`. Re-aiming at the freshly measured box each attempt
 * is what makes this deterministic. It returns the achieved opacity rather
 * than asserting, so the caller can fail with its own message — a silent
 * "hover didn't happen" is how a geometry check becomes vacuous.
 */
async function hoverCardUntilActionsVisible(page: Page, accountName: string): Promise<number> {
  const card = page.locator(`a[aria-label="${accountName}"]`)
  await card.scrollIntoViewIfNeeded()
  let opacity = 0
  for (let i = 0; i < 20; i++) {
    const box = await card.boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(200)
    opacity = (await readCard(page, accountName)).actionsOpacity
    if (opacity > 0.9) break
  }
  return opacity
}

/** Overlapping area of two rects, in px — 0 on either axis means no overlap. */
function overlapOf(a: Rect, b: Rect): { x: number; y: number } {
  return {
    x: +Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)).toFixed(1),
    y: +Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)).toFixed(1),
  }
}

/**
 * Serve `/auth/me` with the account list this test is about. Registered AFTER
 * `mockHavenApi`, so it wins: Playwright consults the most recently added
 * handler first. Nothing in the shared fixture is edited, so no other spec and
 * no capture scenario moves.
 */
async function serveAccounts(page: Page, safes: unknown[]) {
  await page.route('**/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...testUser, safes }),
    })
  })
}

async function openAccounts(page: Page) {
  await page.goto('/accounts')
  await page.waitForSelector('a[aria-label] h3', { timeout: 60_000 })
}

test('/accounts: two accounts — the name survives its chrome at both widths', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await serveAccounts(page, [
    { ...testSafe, name: ORDINARY_NAME, is_default: true },
    SECOND_SAFE,
  ])
  await openAccounts(page)

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    const reading = await readCardSettled(page, ORDINARY_NAME)

    // Non-vacuity: this is a claim about the badge layout, so the badges have
    // to be there. `testSafe` is the seeded ACTIVE account and the default
    // one, and both badges are gated on `safes.length > 1` — the whole reason
    // the #2223 defect was invisible on a one-account fixture.
    expect(reading.badges.sort(), `@${width}px: the card renders ${JSON.stringify(reading.badges)}`)
      .toEqual(['Active', 'default'])
    expect(reading.rowInner, `@${width}px: the title row measured ${reading.rowInner}px`).toBeGreaterThan(0)

    // The #2223 defect, stated as the user sees it: the name reads in full.
    expect(
      reading.truncated,
      `@${width}px: "${reading.text}" is ellipsised in ${reading.measure}px of a ${reading.rowInner}px row`,
    ).toBe(false)
  }
})

test('/accounts: an unbounded name truncates against the card, not against its chrome', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await serveAccounts(page, [
    { ...testSafe, name: UNBOUNDED_NAME, is_default: true },
    SECOND_SAFE,
  ])
  await openAccounts(page)

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    const reading = await readCardSettled(page, UNBOUNDED_NAME)

    expect(reading.badges.sort(), `@${width}px: the card renders ${JSON.stringify(reading.badges)}`)
      .toEqual(['Active', 'default'])

    // A name this long MUST still truncate — names are user-supplied and
    // unbounded, and a card that grew to fit one would be a different defect.
    // Without this the share check below could be satisfied by a short string.
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

/**
 * #2235 — no badge is ever orphaned.
 *
 * Asserted as the reader experiences it, at two name lengths that exercise
 * both sides of the wrap, and never as a class string:
 *
 *   - an ORDINARY name: the title row is ONE line, so nothing dropped at all;
 *   - an UNBOUNDED name, which MUST wrap: the two badges are on the same line
 *     AS EACH OTHER, and it is not the name's line.
 *
 * The second case is the one that matters and the one a "title row is one line
 * tall" check alone would miss — a wrap is legitimate for a long name (#2223
 * put it there on purpose), so the defect is not the wrap, it is the row
 * breaking BETWEEN two badges and leaving one pill on its own. Only a test
 * that forces the wrap can see that.
 */
test('/accounts: an ordinary name keeps its badges on the title line', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await serveAccounts(page, [
    { ...testSafe, name: ORDINARY_NAME, is_default: true },
    SECOND_SAFE,
  ])
  await openAccounts(page)

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    const reading = await readCardSettled(page, ORDINARY_NAME)

    expect(reading.badges.sort(), `@${width}px: the card renders ${JSON.stringify(reading.badges)}`)
      .toEqual(['Active', 'default'])

    // Both badges on the name's own line.
    for (const label of ['Active', 'default'] as const) {
      const badge = reading.badgeRects[label]
      expect(
        overlapOf(badge, reading.nameRect).y,
        `@${width}px: the ${label} badge (y ${badge.y}) is not on the name's line (y ${reading.nameRect.y})`,
      ).toBeGreaterThanOrEqual(badge.h)
    }

    // The title row is one line tall. Measured: 52px when `default` wrapped
    // alone, 24px now. A 1.5x allowance of the name's own height separates
    // those two without pinning a pixel count a font change would break.
    expect(
      reading.rowHeight,
      `@${width}px: the title row is ${reading.rowHeight}px tall against a ${reading.nameHeight}px name — something wrapped`,
    ).toBeLessThan(reading.nameHeight * 1.5)
  }
})

test('/accounts: when the row must wrap, the badges wrap together — never one alone', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await serveAccounts(page, [
    { ...testSafe, name: WRAPPING_NAME, is_default: true },
    SECOND_SAFE,
  ])
  await openAccounts(page)

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    const reading = await readCardSettled(page, WRAPPING_NAME)

    expect(reading.badges.sort(), `@${width}px: the card renders ${JSON.stringify(reading.badges)}`)
      .toEqual(['Active', 'default'])

    const active = reading.badgeRects.Active
    const def = reading.badgeRects.default

    // Non-vacuity: this test is about the WRAPPED state, so prove it wrapped.
    // Without this the assertion below would also pass on a row that never
    // broke at all, which is a different (and already-covered) situation.
    //
    // Expressed as the row's HEIGHT, deliberately. The first version asserted
    // that `Active` had left the name's line, which quietly encoded the fixed
    // layout's answer: under the ungrouped defect `Active` stays beside the
    // name and only `default` drops, so the mutation went red on this guard
    // instead of on the assertion it exists to protect — a red for the wrong
    // reason, which is only one step better than a green for the wrong one.
    // Row height is true of BOTH wrapped arrangements and of neither
    // unwrapped one.
    expect(
      reading.rowHeight,
      `@${width}px: the row did not wrap — it is ${reading.rowHeight}px tall against a ${reading.nameHeight}px name`,
    ).toBeGreaterThan(reading.nameHeight * 1.5)

    // The defect: the row breaking BETWEEN the badges.
    expect(
      overlapOf(active, def).y,
      `@${width}px: the badges are on different lines — Active at y ${active.y}, default at y ${def.y}`,
    ).toBeGreaterThanOrEqual(Math.min(active.h, def.h))
  }
})

/**
 * #2236 — the hover actions' reservation.
 *
 * Two claims, and the second is what stops the first being bought with the
 * name's width: (a) the actions never overlap the name, hovered; (b) what they
 * reserve is what they measure — the name gets every pixel the actions do not
 * occupy, and on a card that renders NO actions it gets the whole card.
 *
 * Hover is asserted to have ENGAGED (opacity 0 -> 1) before the overlap is
 * read. A geometry check against invisible buttons would pass on a card where
 * the hover state never fired, which is the same class of mistake as reading a
 * focus ring as a hover token.
 */
test('/accounts: the hover actions reserve their own width and never cover the name', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await serveAccounts(page, [
    { ...testSafe, name: ORDINARY_NAME, is_default: true },
    { ...SECOND_SAFE, name: ACTION_CARD_NAME },
  ])
  for (const width of WIDTHS) {
    // Set the viewport and RELOAD, rather than resizing a page that was laid
    // out at the other width. Resizing 1280 -> 390 in place leaves the mobile
    // navigation drawer mounted and covering the grid: `elementFromPoint` at
    // the card's centre returns the `<nav>`, the card never enters `:hover`,
    // and the actions stay at `opacity: 0`. That is a harness artefact of the
    // resize, not a product defect — the other tests here never noticed it
    // because a fixed overlay does not move the card's geometry, only its
    // hit-testing. A pointer test has to load the width it is testing.
    await page.setViewportSize({ width, height: 900 })
    await openAccounts(page)

    // (a) The action-bearing card, hovered.
    const achievedOpacity = await hoverCardUntilActionsVisible(page, ACTION_CARD_NAME)
    const hovered = await readCardSettled(page, ACTION_CARD_NAME)

    expect(hovered.actionsRect, `@${width}px: the non-active, non-default card renders no actions`).not.toBeNull()
    expect(
      achievedOpacity,
      `@${width}px: the actions are at opacity ${achievedOpacity} — hover did not engage, so any overlap reading below is vacuous`,
    ).toBeGreaterThan(0.9)

    // The overlapping AREA, not either axis alone. The actions sit on the
    // name's line by design, so a y-overlap of the row height is the healthy
    // reading and asserting `y === 0` would demand the wrong layout; what must
    // be zero is the region where both axes intersect. Measured on unchanged
    // `dev`: 42.7 x 14 = 597.8px^2 at 1280 and 46.6 x 18 = 838.8px^2 at 390.
    const over = overlapOf(hovered.actionsRect!, hovered.nameRect)
    expect(
      +(over.x * over.y).toFixed(1),
      `@${width}px: the hovered actions cover ${over.x}x${over.y}px of the name's box (actions x ${hovered.actionsRect!.x}..${(hovered.actionsRect!.x + hovered.actionsRect!.w).toFixed(1)}, name x ${hovered.nameRect.x}..${(hovered.nameRect.x + hovered.nameRect.w).toFixed(1)})`,
    ).toBe(0)

    // (b) The reservation is DERIVED. The name's row plus the actions plus the
    // one gap between them account for the card's whole content width, so
    // nothing is reserved that the actions do not occupy. 12px of slack for
    // the gap and sub-pixel rounding; the pre-fix mismatch was 54.6px in the
    // other direction (a 48px `pr-12` against a 102.6px actions block).
    const accounted = hovered.rowInner + hovered.actionsRect!.w
    expect(
      hovered.cardInner - accounted,
      `@${width}px: ${hovered.cardInner}px of card holds a ${hovered.rowInner}px name row + a ${hovered.actionsRect!.w}px actions block`,
    ).toBeLessThanOrEqual(12)

    // And the name really is truncating against that boundary rather than
    // stopping short of it — otherwise "no overlap" could be bought by a name
    // that simply never reached the actions.
    expect(
      hovered.truncated,
      `@${width}px: "${hovered.text}" did not reach the actions at all (${hovered.measure}px in a ${hovered.rowInner}px row)`,
    ).toBe(true)

    // (c) The card that renders NO actions reserves nothing for them. `pr-12`
    // was unconditional while both buttons are gated on `!isActive` /
    // `!safe.is_default`, so the active+default card — the one both issues
    // photograph — was losing 48px of name to buttons that did not exist.
    await page.mouse.move(0, 0)
    const quiet = await readCardSettled(page, ORDINARY_NAME)
    expect(quiet.actionsRect, `@${width}px: the active+default card renders hover actions`).toBeNull()
    expect(
      quiet.cardInner - quiet.rowInner,
      `@${width}px: the active+default card reserves ${(quiet.cardInner - quiet.rowInner).toFixed(1)}px for actions it does not render`,
    ).toBeLessThanOrEqual(1)
  }
})

/**
 * The COMPOUND state — one badge AND one action on the same card.
 *
 * Raised by `haven-reviewer` as a coverage gap, and it was right: every other
 * test here puts the seeded active+default account on card one (both badges,
 * NEITHER button, since both are gated on `!isActive` / `!safe.is_default`)
 * and a neither-active-nor-default account on card two (no badges, BOTH
 * buttons). So the two extremes were measured and the middle was not — even
 * though badge visibility and action visibility are independent predicates,
 * and the middle is the ordinary state for anyone whose active account is not
 * their default one.
 *
 * This fixture makes the ACTIVE account the non-default one, which renders
 * both halves of the middle at once:
 *
 *   card A (active, not default)  -> `Active` badge + the star button alone
 *   card B (default, not active)  -> `default` badge + "Set active" alone
 *
 * and asserts on both that the badge is on the name's line, the button never
 * covers the name, and the reservation is still exactly what the button
 * measures — a single 26px star reserves 26px, not the 102.6px of a full pair
 * and not the 48px of the old `pr-12`. That last reading is the one no other
 * test in this file can produce, because nowhere else does a card render a
 * PARTIAL actions block.
 */
test('/accounts: a card with one badge and one action reserves only that action', async ({ page }) => {
  test.slow()
  // Short names, and the arithmetic is the reason. The compound state has
  // LESS room than either extreme, which is not obvious and which the first
  // version of this test got wrong: card A carries a 58.2px badge AND a 26px
  // star, so at 1280 the name may measure at most 265 - 26 - 8 - 58.2 - 8 =
  // 164.8px before the badge wraps; card B carries a 52.1px badge and the
  // 72.6px "Set active" button, leaving 124.3px. `Operating wallet Europe`
  // (~182px) exceeded card A's budget and wrapped the badge — correctly, per
  // #2223, but it is not the state this test is about.
  const ACTIVE_NOT_DEFAULT = ORDINARY_NAME
  const DEFAULT_NOT_ACTIVE = 'Imported Safe'
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await serveAccounts(page, [
    // `seedAuthenticatedSession` pins `safe-main` as the active account, so
    // giving it `is_default: false` is what produces the split.
    { ...testSafe, name: ACTIVE_NOT_DEFAULT, is_default: false },
    { ...SECOND_SAFE, name: DEFAULT_NOT_ACTIVE, is_default: true },
  ])

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    await openAccounts(page)

    for (const [name, badge] of [
      [ACTIVE_NOT_DEFAULT, 'Active'],
      [DEFAULT_NOT_ACTIVE, 'default'],
    ] as const) {
      const achievedOpacity = await hoverCardUntilActionsVisible(page, name)
      const reading = await readCardSettled(page, name)

      // Exactly one badge, and it is the one this card's state earns.
      expect(reading.badges, `@${width}px: "${name}" renders ${JSON.stringify(reading.badges)}`).toEqual([badge])
      expect(
        overlapOf(reading.badgeRects[badge], reading.nameRect).y,
        `@${width}px: the ${badge} badge (y ${reading.badgeRects[badge].y}) is not on the name's line (y ${reading.nameRect.y})`,
      ).toBeGreaterThanOrEqual(reading.badgeRects[badge].h)

      // Exactly one action, actually hovered, and not over the name.
      expect(reading.actionsRect, `@${width}px: "${name}" renders no actions`).not.toBeNull()
      expect(
        achievedOpacity,
        `@${width}px: the actions on "${name}" are at opacity ${achievedOpacity} — hover did not engage`,
      ).toBeGreaterThan(0.9)
      const over = overlapOf(reading.actionsRect!, reading.nameRect)
      expect(
        +(over.x * over.y).toFixed(1),
        `@${width}px: the hovered action covers ${over.x}x${over.y}px of "${name}"'s box`,
      ).toBe(0)

      // And the reservation tracks the PARTIAL block. A `pr-*` step cannot do
      // this: whatever number it held would be right for at most one of the
      // three action combinations this card can render.
      const accounted = reading.rowInner + reading.actionsRect!.w
      expect(
        reading.cardInner - accounted,
        `@${width}px: ${reading.cardInner}px of card holds a ${reading.rowInner}px name row + a ${reading.actionsRect!.w}px actions block`,
      ).toBeLessThanOrEqual(12)

      await page.mouse.move(0, 0)
    }
  }
})

/**
 * The state the #2223 defect hid behind, asserted so the fixes are provably
 * free here. With one account neither badge renders and the card is both
 * active and default, so no hover actions render either — this must read
 * identically before and after.
 */
test('/accounts: the single-account case is unchanged — no badges, name in full', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await serveAccounts(page, [{ ...testSafe, name: ORDINARY_NAME, is_default: true }])
  await openAccounts(page)

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    const reading = await readCardSettled(page, ORDINARY_NAME)

    expect(reading.badges, `@${width}px: a lone account rendered ${JSON.stringify(reading.badges)}`).toEqual([])
    expect(
      reading.truncated,
      `@${width}px: "${reading.text}" is ellipsised with one account and no badges`,
    ).toBe(false)
  }
})
