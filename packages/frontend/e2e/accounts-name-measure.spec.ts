/**
 * `/accounts`: the account name's measure beside the Active / default badges (#2223).
 *
 * WHAT WAS BROKEN. The card's title row was `flex items-center` with both
 * badges `flex-shrink-0`, which made the `h3` the only compressible item in
 * it. So the row bought its chrome with the identity: on the two-account
 * fixture the 17-character name "Operating wallet" rendered as "Operatin…" at
 * 1280 and "Operating wal…" at 390. A single-account user never saw it — with
 * one account neither badge renders (`safes.length > 1` gates both), so the
 * name had the row to itself and the defect was unreachable in the evidence
 * even though it was always reachable in the product.
 *
 * WHY GEOMETRY AND NOT A SCREENSHOT — the same reason as
 * `transaction-title-measure.spec.ts` (#1827): the *Design visual regression*
 * job pixel-compares `/design-system` only, and `/accounts` has no committed
 * baseline at any width. No pixel gate can see this defect, before or after.
 * A class assertion cannot see it either — `flex-wrap` is present or absent in
 * the string whether or not the resulting layout keeps the name readable.
 *
 * WHAT IS ASSERTED, AND WHY BOTH HALVES TOGETHER. Asserting only "the name is
 * not ellipsised" would pass for a fix that deletes the badges, and would say
 * nothing at all about a name too long to fit however the row is arranged.
 * Asserting only a measure floor would pass for a layout that gives the name
 * room by ellipsising it to a wide-but-empty box. So each width asserts:
 *
 *   1. an ORDINARY name (the fixture's own, the string in the issue) is
 *      rendered in FULL beside both badges — the exact defect;
 *   2. an UNBOUNDED name still truncates, but against the CONTAINER: its
 *      measure is >= 95% of the row's own content width, so the ellipsis is
 *      the row running out of card, not the row paying for two pills;
 *   3. the badges are still VISIBLY rendered in both cases — laid out, with
 *      non-zero width — so neither result was bought by removing the chrome
 *      or by taking it out of flow.
 *
 * (2) is deliberately expressed as a FRACTION of the measured row rather than
 * a pixel count: the switcher's width depends on how many accounts exist and
 * on their names, so any fixed number is a new failure waiting for the first
 * string that exceeds it.
 *
 * The single-account case is asserted too — it is what the defect hid behind,
 * and it must stay unchanged.
 *
 * WHICH ARM CATCHES WHICH WIDTH, measured on unchanged `origin/dev` rather
 * than assumed, because the two arms are NOT redundant:
 *
 *   @1280  (1) fails: "Operating wallet" ellipsised into 90.4px of a 217px
 *          row — 41.7%. (2) fails at 49.9%.
 *   @390   (1) PASSES: the same name measures 125.7px against a natural
 *          126.9px in a 252px row, so at this project's deviceScaleFactor 1
 *          it fits by about a pixel and is not ellipsised. (2) fails at
 *          49.9%.
 *
 * So the mobile half of the defect is caught by the UNBOUNDED arm, not by the
 * ordinary one — stated here so nobody reads a green (1) at 390 as evidence
 * that 390 was ever checked by it. The capture harness renders 390 at
 * deviceScaleFactor 2, where the same string DOES ellipsise ("Operating
 * wal…", the issue's own reading); that one pixel is exactly how narrow the
 * margin was, and is the reason (2) exists rather than a second literal name.
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
 * defect reads ~45% at both widths, so nothing sits near this threshold.
 */
const MIN_TRUNCATED_SHARE_OF_ROW = 0.95

type NameReading = {
  text: string
  measure: number
  rowInner: number
  truncated: boolean
  badges: string[]
}

/**
 * Anchor on the card's `aria-label` and the `h3` inside it — never on a class
 * string, since the class string is what this fix changes. `rowInner` is the
 * title row's CONTENT width: `clientWidth` minus its own `pr-12`, which
 * reserves space for the hover actions and is not available to the name.
 */
async function readName(page: Page, accountName: string): Promise<NameReading> {
  return page.evaluate((label) => {
    const card = document.querySelector(`a[aria-label="${label}"]`)
    if (!card) throw new Error(`no /accounts card labelled "${label}"`)
    const h3 = card.querySelector('h3')
    if (!h3) throw new Error(`the card labelled "${label}" renders no name`)
    const row = h3.parentElement!
    const padRight = parseFloat(getComputedStyle(row).paddingRight) || 0
    // VISIBLY rendered, not merely present in the DOM. `haven-reviewer`
    // defeated a text-only version of this check with its own mutation: drop
    // `flex-wrap` AND give both badges `sr-only`, and all three tests passed —
    // `position: absolute` takes them out of flex flow, so the `h3` gets the
    // whole row exactly as a real wrap would, while their text nodes stay
    // queryable. That is a layout no sighted user gets, and the check that was
    // supposed to say "the result was not bought by deleting the chrome" could
    // not see it. `getClientRects()` is the same visibility filter
    // `transaction-title-measure.spec.ts` uses; the width test is what rules
    // out a zero-size box.
    const badges = Array.from(row.querySelectorAll('span'))
      .filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0)
      .map((el) => (el.textContent ?? '').trim())
      .filter((t) => t === 'Active' || t === 'default')
    return {
      text: (h3.textContent ?? '').trim(),
      measure: +h3.getBoundingClientRect().width.toFixed(1),
      rowInner: +(row.clientWidth - padRight).toFixed(1),
      truncated: h3.scrollWidth > h3.clientWidth + 1,
      badges: Array.from(new Set(badges)),
    }
  }, accountName)
}

/** Settle until two consecutive reads agree — a fixed wait yields stale numbers. */
async function readNameSettled(page: Page, accountName: string): Promise<NameReading> {
  let reading = await readName(page, accountName)
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150)
    const again = await readName(page, accountName)
    if (JSON.stringify(again) === JSON.stringify(reading)) break
    reading = again
  }
  return reading
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

test('/accounts: two accounts — the name survives the badges at both widths', async ({ page }) => {
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
    const reading = await readNameSettled(page, ORDINARY_NAME)

    // Non-vacuity: this is a claim about the badge layout, so the badges have
    // to be there. `testSafe` is the seeded ACTIVE account and the default
    // one, and both badges are gated on `safes.length > 1` — the whole reason
    // the defect was invisible on a one-account fixture.
    expect(reading.badges.sort(), `@${width}px: the title row renders ${JSON.stringify(reading.badges)}`)
      .toEqual(['Active', 'default'])
    expect(reading.rowInner, `@${width}px: the title row measured ${reading.rowInner}px`).toBeGreaterThan(0)

    // The defect, stated as the user sees it: the name reads in full.
    expect(
      reading.truncated,
      `@${width}px: "${reading.text}" is ellipsised in ${reading.measure}px of a ${reading.rowInner}px row`,
    ).toBe(false)
  }
})

test('/accounts: an unbounded name truncates against the card, not against the badges', async ({ page }) => {
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
    const reading = await readNameSettled(page, UNBOUNDED_NAME)

    expect(reading.badges.sort(), `@${width}px: the title row renders ${JSON.stringify(reading.badges)}`)
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
 * The state the defect hid behind, asserted so the fix is provably free here.
 * With one account neither badge renders, so the name already had the row to
 * itself; this must read identically before and after.
 */
test('/accounts: the single-account case is unchanged — no badges, name in full', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await serveAccounts(page, [{ ...testSafe, name: ORDINARY_NAME, is_default: true }])
  await openAccounts(page)

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    const reading = await readNameSettled(page, ORDINARY_NAME)

    expect(reading.badges, `@${width}px: a lone account rendered ${JSON.stringify(reading.badges)}`).toEqual([])
    expect(
      reading.truncated,
      `@${width}px: "${reading.text}" is ellipsised with one account and no badges`,
    ).toBe(false)
  }
})
