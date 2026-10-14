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
 * #2236 — the hover actions were `absolute top-3 right-3` and measured
 * **102.6px** ("Set active" 72.6 + gap 4 + the star 26), while the title row
 * reserved a hand-picked `pr-12` (48px). Measured hovered on unchanged `dev`,
 * they painted a **42.7 x 14px** region of the name's own box at 1280 and
 * **46.6 x 18px** at 390. The actions are now the title row's second column in
 * normal flow, so the reservation IS what they measure — and is zero on a card
 * that renders neither button.
 *
 * #2374 — the star is GONE. The card's actions block now holds exactly one
 * control, "Set active", so the pair figures above (102.6, and 108.6 after
 * #2241's gap) are HISTORY: they explain why the reservation is derived rather
 * than describing what it currently measures. Nothing in this file pins them,
 * which is precisely #2236's fix working — the reservation is read at run time
 * from the rendered block, so removing a control moves the number without
 * moving a line of this spec.
 *
 * What #2374 DID move here, all of it recorded at its own call site: the focus
 * test now tabs to "Set active" rather than to the star (the star was the last
 * control and the ring-clipping question was about the card's right edge — it
 * still is, one control over); the compound-state test's card A becomes
 * one-badge-and-NO-action, which is a state nothing else in this file covers;
 * and a new arm pins the single NON-default account, which was the gap #2374's
 * investigation found — the existing single-account test seeds
 * `is_default: true`, so a lone non-default account was asserted nowhere.
 *
 * #3719 — the global active account is GONE, and with it the `Active` badge
 * and "Set active". A card now renders at most ONE badge (`default`) and NO
 * action at all. So three tests left this file rather than being weakened:
 * #2235's "the badges wrap together" (with one badge nothing can be
 * orphaned), and #2236's hover-reservation and focus-ring tests plus the
 * compound badge/action test (there is no actions block to hover, focus or
 * reserve for). What survives of #2236 is its dead-reservation half, now
 * asserted for EVERY card: no card reserves width for actions it does not
 * render. The `Active` badge stays in `readCard`'s scan, so a reintroduced one
 * fails the `['default']` badge assertions below rather than going unseen.
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
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession, testSafe, testUser } from './fixtures/haven-api'

/** The name in the issue, and the shared capture fixture's own. 17 characters. */
const ORDINARY_NAME = 'Operating wallet'
/**
 * Long enough that no arrangement of this card can show it whole at either
 * width, so the truncation it provokes is a property of the container rather
 * than of the string.
 */
const UNBOUNDED_NAME = 'Treasury operations wallet for the European entity'
const SECOND_SAFE = {
  ...testSafe,
  id: 'safe-second',
  account_address: '0x4444444444444444444444444444444444444444',
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
 * Anchor on the named link inside the explicit card test hook — never on a
 * class string, since the class strings are what these fixes change.
 *
 * `rowInner` is the width available to the NAME: the title row's client width
 * minus its own padding. Before #2236 that padding was `pr-12`, a reservation
 * for absolutely-positioned actions; now the actions are a sibling column and
 * the row carries no padding at all, so the same expression keeps meaning the
 * same thing across the fix rather than needing two readings.
 */
async function readCard(page: Page, accountName: string): Promise<CardReading> {
  return page.evaluate((label) => {
    const card = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="account-card"]'))
      .find((candidate) => candidate.querySelector('h3 a')?.textContent?.trim() === label) ?? null
    if (!card) throw new Error(`no /accounts card labelled "${label}"`)
    const h3 = card.querySelector('h3')
    if (!h3) throw new Error(`the card labelled "${label}" renders no name`)
    const nameLink = h3.querySelector('a')
    if (!nameLink) throw new Error(`the card labelled "${label}" renders no name link`)
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
      text: (nameLink.textContent ?? '').trim(),
      measure: +nameLink.getBoundingClientRect().width.toFixed(1),
      rowInner: +(row.clientWidth - padRight).toFixed(1),
      cardInner: +(
        card.clientWidth -
        (parseFloat(getComputedStyle(card).paddingLeft) || 0) -
        (parseFloat(getComputedStyle(card).paddingRight) || 0)
      ).toFixed(1),
      rowHeight: +row.getBoundingClientRect().height.toFixed(1),
      nameHeight: +nameLink.getBoundingClientRect().height.toFixed(1),
      truncated: nameLink.scrollWidth > nameLink.clientWidth + 1,
      badges: Array.from(new Set(badges.map(([t]) => t))),
      badgeRects,
      captionRect: rect(caption),
      nameRect: rect(nameLink),
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
async function serveAccounts(page: Page, accounts: unknown[]) {
  await page.route('**/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      // One envelope key. `safes` was the deprecated twin here until #2914
      // retired it; sending it now would make this fixture describe a
      // response the backend cannot produce.
      body: JSON.stringify({ ...testUser, accounts }),
    })
  })
}

async function openAccounts(page: Page) {
  await page.goto('/accounts')
  await page.waitForSelector('[data-testid="account-card"] h3 a', { timeout: 60_000 })
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

    // Non-vacuity: this is a claim about the badge layout, so the badge has
    // to be there. `testSafe` is the default account, and the badge is gated
    // on `accounts.length > 1` — the whole reason the #2223 defect was
    // invisible on a one-account fixture. No `Active` badge since #3719.
    expect(reading.badges, `@${width}px: the card renders ${JSON.stringify(reading.badges)}`)
      .toEqual(['default'])
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

    expect(reading.badges, `@${width}px: the card renders ${JSON.stringify(reading.badges)}`)
      .toEqual(['default'])

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
 * #2235 — the badge sits on the name's line.
 *
 * #2235 was about two badges: the row broke BETWEEN them and stranded one.
 * Since #3719 there is one badge, so the orphan case is unreachable and its
 * forced-wrap test is gone; what still holds is that an ordinary name keeps
 * the badge beside it on a one-line title row, asserted as geometry.
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

    expect(reading.badges, `@${width}px: the card renders ${JSON.stringify(reading.badges)}`)
      .toEqual(['default'])

    // The badge on the name's own line.
    for (const label of ['default'] as const) {
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

/**
 * #2236's surviving half: no card reserves width for actions it does not
 * render. Since #3719 NO card renders an action, so every card's title row
 * must span its whole content box — at both widths, on the default card and
 * on the other one. A reintroduced action (a set-default star, "Set active")
 * would come back into flow and take width from the name, the #2223 cost this
 * file exists to watch, and this is the first test to go red.
 */
test('/accounts: no card reserves width for actions it does not render', async ({ page }) => {
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
    for (const name of [ORDINARY_NAME, SECOND_SAFE.name]) {
      const reading = await readCardSettled(page, name)
      // Non-vacuity: the card rendered under its own name.
      expect(reading.text, `@${width}px: the "${name}" card did not render its name`).toBe(name)
      expect(reading.actionsRect, `@${width}px: "${name}" renders an actions block`).toBeNull()
      expect(
        reading.cardInner - reading.rowInner,
        `@${width}px: "${name}" reserves ${(reading.cardInner - reading.rowInner).toFixed(1)}px for actions it does not render`,
      ).toBeLessThanOrEqual(1)
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


/**
 * The single NON-default account — the arm this file did not have (#2374).
 *
 * ## Why it was missing, and why that mattered
 *
 * The test directly above seeds `{ ...testSafe, name: ORDINARY_NAME,
 * is_default: true }`. Every other fixture in this file seeds two accounts. So
 * a rendered set of exactly ONE account that is NOT the default was asserted
 * nowhere — and that is the state in which the card's old set-default star was
 * at its worst:
 *
 *   - both badges are gated on `accounts.length > 1`, so the word `default`
 *     renders NOWHERE on the page;
 *   - `/accounts/<id>` gates its own "Set as default" on
 *     `!safe.is_default && (user?.accounts?.length ?? 0) > 1`, so the detail page
 *     deliberately hides the action in this exact state;
 *   - the card's star was gated on `!safe.is_default` ALONE, so it rendered
 *     anyway — a permanently visible, unlabelled control for an action that
 *     cannot do anything, on a page that never says the word it refers to.
 *
 * It is latent on today's backend, which is why nobody hit it: `is_default` is
 * inserted as `isFirst` and the oldest survivor is promoted on unlink, so a
 * lone account is normally the default. It stops being latent the moment a
 * rendered account set is FILTERED rather than being the whole set.
 *
 * ## What this arm asserts, and why each part is here
 *
 * `getAttribute('aria-label')` is scanned across the whole document rather
 * than inside the card, so a control that moved elsewhere on the page still
 * counts. Both the accessible name and the visible text are matched, because a
 * reintroduction could arrive as the old `aria-label`-only star OR as the
 * labelled `Set default` variant the decision rejected.
 *
 * NON-VACUITY IS THE FIRST ASSERTION, not the last. An absence check on a page
 * that failed to render is a green run that proves nothing — the exact
 * false-zero this file's `sr-only` note is about, one surface over. So the card
 * itself must be present and named before anything is asserted to be missing.
 */
test('/accounts: a lone NON-default account offers no set-default control', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await serveAccounts(page, [{ ...testSafe, name: ORDINARY_NAME, is_default: false }])
  await openAccounts(page)

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    const reading = await readCardSettled(page, ORDINARY_NAME)

    // Non-vacuity, in TWO parts, and the second was missing until
    // `haven-reviewer` found it. (a) the page really rendered this account —
    // read through `readCard`'s `h3` lookup.
    expect(
      reading.text,
      `@${width}px: the lone account card did not render its name — every absence below would be vacuous`,
    ).toBe(ORDINARY_NAME)

    // Unchanged from the default-flagged single-account case: with one account
    // neither badge renders, whatever `is_default` says.
    expect(
      reading.badges,
      `@${width}px: a lone account rendered ${JSON.stringify(reading.badges)} — both badges are gated on \`accounts.length > 1\``,
    ).toEqual([])
    expect(
      reading.truncated,
      `@${width}px: "${reading.text}" is ellipsised with one account and no badges`,
    ).toBe(false)

    // The pin. No card renders an action since #3719, so the whole actions
    // block should be absent — but the assertion that matters is the named
    // one, because a future action on this card must not silently re-admit a
    // set-default control.
    const controls = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a[role="button"]')).map((el) =>
        `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.trim(),
      ),
    )
    /*
      (b) — and the SAME scan must be shown able to return something.

      `haven-reviewer` was right that (a) alone borrows its confidence: it
      proves the card rendered, through `readCard`'s `h3` lookup, and says
      nothing about whether `document.querySelectorAll('button, a[role=...]')`
      — the query the absence claim below actually rests on — can find a
      control at all. A scan that has never returned anything is not evidence
      of an absence.

      This card deliberately renders no action of its own; the controls that
      prove the scan works are the app chrome's own buttons (the sidebar's
      user menu and nav links), which are on every authenticated page.
      Naming what it found in the message keeps a future failure diagnosable
      rather than just "expected > 0".
    */
    expect(
      controls.length,
      `@${width}px: the control scan found NOTHING on the whole page — it cannot yet distinguish "no set-default control" from "nothing rendered". It saw ${JSON.stringify(controls)}`,
    ).toBeGreaterThan(0)

    expect(
      controls.filter((n) => /default/i.test(n)),
      `@${width}px: a lone NON-default account offers ${JSON.stringify(controls.filter((n) => /default/i.test(n)))} — #2374 removed the card's set-default control, and this is the state in which it was most misleading`,
    ).toEqual([])
    expect(
      reading.actionsRect,
      `@${width}px: the lone account renders an actions block`,
    ).toBeNull()
    expect(
      reading.cardInner - reading.rowInner,
      `@${width}px: the lone account reserves ${(reading.cardInner - reading.rowInner).toFixed(1)}px for actions it does not render`,
    ).toBeLessThanOrEqual(1)
  }
})
