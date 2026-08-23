/**
 * Resting-state visual regression for `AgentPanel`'s empty states and
 * `AgentCard`'s warning banners (#1924).
 *
 * BASELINES ARE LINUX-RENDERED, exactly as `design-system.visual.spec.ts`'s and
 * `focus-visible.visual.spec.ts`'s are, and for the same reason: CI is the
 * judge and macOS font rendering differs. Skipped locally unless
 * VISUAL_REGRESSION=1. Regenerate via the **Update visual baselines** workflow
 * on the branch — see docs/contributing/ship-playbooks/frontend.md §4.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * #1858 rescaled the icons in these surfaces, and two of them were **overflowing
 * `EmptyState`'s 20px slot** — a 22px `Icon` and a 24px `BotIcon` inside an
 * `h-5 w-5` span. The design review signed that off on **primitive geometry and
 * container precedent — math and code, not eyes on render** — and filed #1924
 * rather than let "reviewed" be read as "seen". This file is what makes that
 * sign-off real.
 *
 * The gap being closed is a rung below #1863's. There, a capture existed and
 * nothing drove it. Here **there is no capture at all**: `AgentPanel`'s empty
 * states and `AgentCard`'s banners render on no route the pixel gate visits,
 * and `/design-system` demos `EmptyState` only with a generic `DotIcon`
 * placeholder — never the real instances. A rendering regression in any of
 * these states is invisible to every gate the repo has.
 *
 * ── Why a spec and not a `/design-system` demo ───────────────────────────────
 *
 * #1924 asks this to be decided rather than assumed. A `/design-system` entry
 * is cheaper and lands inside the existing blocking capture, and it was
 * rejected: it would demo `EmptyState` and a banner-shaped `div`, not
 * `AgentPanel` and `AgentCard`. The defect class this is guarding against —
 * #1858's icon overflowing its slot — lives in **what the real call site passes
 * to the primitive**, and a showcase re-passes whatever the showcase author
 * writes. It would photograph the demo and leave the product uncovered while
 * looking like coverage. That is the exact substitution #1924 was filed to stop.
 *
 * ── One capture per test ─────────────────────────────────────────────────────
 *
 * Inherited from #1863/#1873 and load-bearing rather than tidy: several
 * `toHaveScreenshot` calls in one test SHORT-CIRCUIT, so a mutation reddening
 * capture 3 never runs 4-6 and the run reports one failure where the truth
 * might be four. Separate tests make each capture's verdict independent, which
 * is what turns a mutation's blast radius into a measurement instead of an
 * inference.
 *
 * ── Seeding a state is not rendering the branch ──────────────────────────────
 *
 * #1873's rule, and the reason every test here asserts the FULL rendered result
 * before it captures. `has_stranded_funds: true` reaching the API mock proves
 * nothing about which of `AgentCard`'s branches ran — and the two banners are
 * **structurally identical**: same wrapper classes, same `warning-soft` fill,
 * same `border-warning/20`, differing only in icon and copy. A fixture field the
 * component ignored would leave the card on the other banner, or on none, and
 * the capture would be a silent duplicate of a sibling baseline.
 *
 * So `expectCardBanners` asserts the card's banner set as an **exact ordered
 * array** over a closed vocabulary, not a `toBeVisible()` on the one expected
 * banner. A banner appearing that should not (stranded surviving into the
 * paused-only fixture) fails too, which a positive-only assertion cannot see.
 * `expectEmptyState` does the same for the empty states: heading, body and the
 * exact action-button set.
 *
 * ── The icon-slot assertion, which is #1858's claim restated as a check ──────
 *
 * `expectIconWithinSlot` measures the rendered `svg` against the `h-5 w-5` span
 * that contains it. This is deliberately NOT left to the pixels: a green
 * baseline only ever proves the baseline matches the render, never that the
 * render is correct, and an overflowing icon photographs perfectly happily —
 * which is precisely how #1858's two overflows survived every gate until a human
 * read the class strings. Overflow is a boolean, so it needs no baseline and
 * carries none of the platform-metrics caveat the captures do.
 *
 * ── Where the fixtures live ──────────────────────────────────────────────────
 *
 * In THIS FILE's own `page.route` override, never in the shared `mockHavenApi`
 * fixture, and this is measured rather than assumed: **twelve other specs call
 * `mockHavenApi`** and **four of them navigate to `/agents`** (`connect-agent`,
 * `hosted-mcp`, `navigation.mobile`, `mobile-nav-layering.mobile`). A paused or
 * stranded agent added there would change the payload all twelve receive and
 * the rendered output of those four, none of which is about this. The override
 * registers per test, AFTER `mockHavenApi`, so Playwright matches it first, and
 * every other route is handed back with `route.fallback()` — which DEFERS to
 * the next matching handler rather than fulfilling, so the shared fixture still
 * serves auth, balances and approvals, unmodified and unaware.
 *
 * ── Desktop captures, 390px geometry, no mobile baseline ─────────────────────
 *
 * #1797's rule is that a desktop proof may not be reused at a width it was not
 * taken at, and #1873 honoured it by asserting the invariant at 390px rather
 * than minting a mobile baseline it had no coverage argument for. Same here.
 * 390 was checked FIRST rather than last — both banners and both empty states
 * reflow there, and the thing worth pinning is that they reflow without
 * overflowing, which is a boolean. `test:visual` pins
 * `--project=chromium-desktop`, so a mobile capture taken here would be a
 * desktop project wearing a `setViewportSize`, which is the shape #1768 warns
 * about.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, testAgent } from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports, shared with
// the screenshot script and the other two pixel gates so all of them render at
// the same widths.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{
  name: string
  width: number
  height: number
}>

const DESKTOP_MIN_VIEWPORT_WIDTH = 1024
const DESKTOP = VIEWPORTS.find((vp) => vp.width >= DESKTOP_MIN_VIEWPORT_WIDTH)
const MOBILE = VIEWPORTS.find((vp) => vp.width < DESKTOP_MIN_VIEWPORT_WIDTH)

/**
 * Inherited from #1863, whose measurement applies unchanged: `threshold` is
 * pixelmatch's PER-PIXEL colour tolerance, and Playwright's default of 0.2
 * means a pixel counts as different only past a YIQ delta of 1,408.6. A tone
 * swapped within our own palette does not come close — #1820 measured 69.7 —
 * so **at the default this entire class of change counts ZERO differing pixels
 * and no budget of any size would catch it.** The budget is not the dial.
 */
const PIXEL_THRESHOLD = 0.02

/**
 * Proportional to the region, following #1863's correction rather than copying
 * an absolute number between captures of different sizes. These regions sit
 * between the action row's 17,958 px and the sidebar's 192,000 px:
 *
 *   capture                  approx area     100 would be    50 is
 *   agent card banner        ~600 x 56 px       0.30%        0.15%
 *   panel empty state        ~600 x 220 px      0.08%        0.04%
 *
 * 50 keeps these in the same proportional band as the rest of the family. It is
 * not 0, for the reason none of the others are: a runner-image or Chromium bump
 * may legitimately nudge a few pixels, and a gate that goes flat red every week
 * is a gate someone turns off.
 */
const MAX_DIFF_PIXELS = 50

const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: MAX_DIFF_PIXELS,
  threshold: PIXEL_THRESHOLD,
} as const

/**
 * The closed vocabulary of `AgentCard`'s warning banners (`AgentCard.tsx`).
 *
 * A closed list rather than a structural query, because every structural handle
 * these banners offer IS a class string — and a class string is what this gate
 * is under contract to check, so it must not also be what the gate trusts to
 * find its subject (#1811/#1820's rule). Their titles are the only semantic
 * handle they have. The cost is that a NEW banner added to `AgentCard` is
 * invisible to `expectCardBanners` until it is added here; the
 * `expectKnownBannerCount` guard below closes that, by counting banner-shaped
 * children independently and failing when the two disagree.
 */
const BANNER_TITLES = ['Paused in Haven', 'Stranded funds on delegate'] as const

/**
 * This spec's OWN `/agents` and `/auth/me` payloads, layered over
 * `mockHavenApi`. See the header for why the shared fixture is not touched.
 */
async function seedPanel(page: Page, seed: { agents: ReadonlyArray<Record<string, unknown>> }) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/agents') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ agents: seed.agents }),
      })
      return
    }
    await route.fallback()
  })
}

/**
 * One synthetic agent, built by OVERRIDING the shared `testAgent` rather than
 * by writing a fresh literal — #1873's rule. Every field this spec does not
 * name matches the agent the existing captures were taken against, so a
 * difference between a new capture and an old one is the branch and not the
 * fixture.
 */
function agentState(overrides: Record<string, unknown>) {
  return { ...testAgent, ...overrides }
}

/** The `AgentCard` root for a named agent — its ARIA contract, not its classes. */
function cardFor(page: Page, name: string) {
  return page.locator(`[role="link"][aria-label="View ${name}"]`)
}

/**
 * Assert the card carries EXACTLY these banners, in this DOM order.
 *
 * The exact-array form is the whole point (#1873). `toBeVisible()` on the one
 * expected banner would pass just as happily when BOTH rendered, and the two
 * banners are byte-identical in every class they carry — so the wrong one, or
 * one too many, would produce a plausible capture that silently duplicates a
 * sibling baseline. An ordered set-equality assertion fails loudly instead.
 */
async function expectCardBanners(card: Locator, expected: readonly string[], label: string) {
  const present = await card.evaluate(
    (el, titles) =>
      Array.from(el.querySelectorAll('p'))
        .map((p) => p.textContent?.trim() ?? '')
        .filter((text) => (titles as string[]).includes(text)),
    BANNER_TITLES as unknown as string[],
  )
  expect(present, `${label}: this is not the banner set the fixture was seeding`).toEqual([
    ...expected,
  ])
}

/**
 * Count banner-shaped children independently of `BANNER_TITLES`, and require
 * the two counts to agree.
 *
 * Without this, `expectCardBanners` is only ever as complete as its own hard-
 * coded list: a THIRD banner added to `AgentCard` would render, be captured,
 * and pass — the assertion would look at the two titles it knows, find them,
 * and say nothing about the newcomer. That is the "coverage is a file count"
 * failure one level in.
 *
 * This is the one place a class string is used as a locator, and it is used
 * deliberately as a CROSS-CHECK rather than as the subject: it does not decide
 * what is captured, it only refuses to let the closed vocabulary drift out of
 * date silently. If the banner styling is refactored this assertion fails and
 * someone re-reads this file — which is the intended outcome, not a bug.
 */
async function expectKnownBannerCount(card: Locator, expected: number, label: string) {
  // COMPUTED background, not a class selector. A class-string locator would
  // have the flaw this whole family keeps paying for — it reads identically
  // whether the class compiled to a colour or to nothing (#1818) — and it
  // would also make the cross-check depend on the very strings the capture is
  // under contract to police. Resolving `--v2-warning-soft` on the card itself
  // and comparing computed fills asks the question the eye asks.
  const shaped = await card.evaluate((el) => {
    const soft = getComputedStyle(el).getPropertyValue('--v2-warning-soft').trim()
    if (!soft) return -1
    const probe = document.createElement('div')
    probe.style.backgroundColor = soft
    el.appendChild(probe)
    const resolved = getComputedStyle(probe).backgroundColor
    probe.remove()
    return Array.from(el.children).filter(
      (child) => getComputedStyle(child).backgroundColor === resolved,
    ).length
  })
  expect(
    shaped,
    `${label}: could not resolve --v2-warning-soft on the card — the token moved`,
  ).not.toBe(-1)
  expect(
    shaped,
    `${label}: found ${shaped} warning-tinted direct children of the card but ${expected} ` +
      `known banner title(s). Either a banner was added to AgentCard without being added ` +
      `to BANNER_TITLES in this spec — add it AND give it its own capture, or this gate ` +
      `reports coverage it does not have — or a banner's fill stopped resolving.`,
  ).toBe(expected)
}

/**
 * Assert an `EmptyState`'s full rendered content: heading, body, and the exact
 * ordered set of action buttons.
 *
 * Same reason as `expectCardBanners`. `AgentPanel` renders FOUR `EmptyState`s
 * from four mutually exclusive conditions, and three of them differ only in
 * icon, copy and tone. Asserting the heading alone would not distinguish "the
 * branch I seeded ran" from "a different branch ran and happens to be on
 * screen"; the action set is what separates them structurally (the no-account
 * state has NO action, "No agents yet" has exactly one).
 */
async function expectEmptyState(
  root: Locator,
  expected: { title: string; body: string; actions: readonly string[] },
  label: string,
) {
  await expect(root.getByRole('heading', { name: expected.title })).toHaveCount(1)
  await expect(root, `${label}: body copy is not the seeded branch's`).toContainText(expected.body)
  const actions = await root.getByRole('button').evaluateAll((els) =>
    els.map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? ''),
  )
  expect(actions, `${label}: this is not the empty state the fixture was seeding`).toEqual([
    ...expected.actions,
  ])
}

/**
 * The check #1858 was signed off without: does the icon actually FIT its slot?
 *
 * `EmptyState` renders its icon inside `<span class="h-5 w-5">` — a 20x20 box
 * with no overflow clipping — so a 22px or 24px icon simply spills, and both
 * did before #1858. Measured as a DIFFERENCE between two live boxes on the same
 * render, never as an absolute pixel claim, which is the rule #1875/#1909
 * produced: a local absolute geometry number is not evidence, a same-render
 * difference is.
 *
 * Deliberately a structural assertion rather than something read off the PNG.
 * An overflowing icon photographs perfectly happily, so a green baseline is
 * exactly as consistent with the bug as with the fix — which is how the two
 * overflows survived every gate the repo had.
 */
async function expectIconWithinSlot(root: Locator, label: string) {
  const fit = await root.evaluate((el) => {
    const svg = el.querySelector('svg')
    if (!svg) return null
    const slot = svg.closest('span')
    if (!slot) return null
    const s = svg.getBoundingClientRect()
    const box = slot.getBoundingClientRect()
    return {
      icon: { w: Math.round(s.width * 100) / 100, h: Math.round(s.height * 100) / 100 },
      slot: { w: Math.round(box.width * 100) / 100, h: Math.round(box.height * 100) / 100 },
      overflowX: Math.round((s.width - box.width) * 100) / 100,
      overflowY: Math.round((s.height - box.height) * 100) / 100,
    }
  })
  expect(fit, `${label}: no icon inside a slot span — the EmptyState markup moved`).not.toBeNull()
  expect(
    fit!.overflowX <= 0 && fit!.overflowY <= 0,
    `${label}: the icon OVERFLOWS its slot — icon ${fit!.icon.w}x${fit!.icon.h} in a ` +
      `${fit!.slot.w}x${fit!.slot.h} span (+${fit!.overflowX}x+${fit!.overflowY}). This is ` +
      `exactly the #1858 defect: the slot does not clip, so the icon spills and every ` +
      `pixel baseline photographs it happily. Size the icon to the slot rather than ` +
      `widening the slot.`,
  ).toBe(true)
}

/**
 * Load the panel and wait for it to SETTLE — deliberately not via
 * `waitForLoadState('networkidle')`, which the two older visual specs use.
 *
 * Measured rather than preferred: under `next dev` this page never reaches
 * network idle. wagmi/WalletConnect keeps long-lived connections open and
 * Reown re-polls its remote config, so the 500ms-quiet window never arrives and
 * the wait burns the whole 60s test timeout. Six of this file's seven tests
 * failed that way on the first local run, and the seventh passed only because
 * it happened to catch a quiet moment — which is the worse outcome of the two,
 * because it is the one that looks like a working wait.
 *
 * `networkidle` is also the wrong QUESTION here. What a capture needs is that
 * the thing being photographed has rendered and stopped moving, and idleness of
 * unrelated wallet sockets is neither necessary nor sufficient for that. So the
 * settle condition is the panel's OWN loading state: `AgentPanel` renders
 * `Skeleton` rows while `useAgents` is loading (`AgentPanel.tsx:83-101`) and
 * nothing else on this route does, so "no skeletons left" is exactly the
 * transition that matters, and every caller then asserts its specific subject
 * is present before capturing.
 *
 * Playwright's own docs discourage `networkidle` for this reason. Left alone in
 * the two older specs rather than changed here — they are green in CI and
 * retuning someone else's baselines is not this issue's scope — but noted,
 * because the next spec in this family should copy THIS and not those.
 *
 * The wait itself is split in two, and the split is the point. `settle` waits
 * only for what is genuinely page-global — fonts, and the lazily-mounted
 * sidebar whose arrival changes every width beneath it. What each test then
 * waits for is **its own subject** — the `toHaveCount(1)` assertions below
 * auto-retry, and the subject cannot exist until `useAgents` has resolved, so
 * the data load is waited on by the thing that actually depends on it.
 * `expectNoSkeletons` closes the last gap immediately before the capture, and
 * is SCOPED to the captured region on purpose: a page-wide skeleton wait would
 * hang on any unrelated pulsing element — and `AgentCard` renders a skeleton
 * per pending on-chain token (`AgentCard.tsx:105-116`) while `onChainLoading`
 * is true, which in e2e depends on RPC calls that have no provider to answer
 * them. Scoping it means the assertion can only ever be about pixels that are
 * in the baseline.
 */
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  // THE SIDEBAR MUST BE MOUNTED BEFORE ANYTHING IS MEASURED OR CAPTURED, and
  // this line was written from a failure rather than from caution.
  //
  // `(authenticated)/layout.tsx:10` loads `Sidebar` with
  // `dynamic(..., { ssr: false })`. Until that chunk arrives, `<main>` spans
  // the FULL viewport; after it, the sidebar takes 240px. Every width below it
  // moves accordingly — measured live at 1280x800:
  //
  //   sidebar mounted?      main.clientWidth   AgentCard   banner
  //   not yet                    1280             504        462
  //   mounted                    1040             480        438
  //
  // A capture taken in that window is 462px wide and will not match a 438px
  // baseline — Playwright reports it as a SIZE MISMATCH, which reads like a
  // layout regression rather than like a race, so it costs a diagnosis before
  // it costs a rerun. Observed on 1 run in 4 while probing (the other three
  // were already mounted at first paint), so it is exactly frequent enough to
  // be mistaken for an unrelated flake later.
  //
  // The two older visual specs never hit this because `networkidle` waits for
  // the chunk FETCH as a side effect. That is the one thing their wait bought
  // that this file's does not, so it is bought back explicitly here — which is
  // the better trade anyway: this asserts the condition that actually matters
  // instead of a proxy that happens to imply it.
  //
  // Located by the kebab's ARIA contract, the same handle
  // `focus-visible.visual.spec.ts` uses for this widget.
  await expect(page.locator('button[aria-label="User menu"]')).toHaveCount(1)
}

/**
 * No skeleton is still pulsing inside the region about to be captured.
 *
 * `animations: 'disabled'` freezes an animation for the screenshot; it does not
 * make a skeleton become the content it stands in for. A capture taken mid-load
 * would bake a placeholder into the baseline and then match it forever, which is
 * the "green about the wrong thing" shape this whole file exists to avoid.
 */
async function expectNoSkeletons(region: Locator, label: string) {
  await expect(
    region.locator('.animate-pulse'),
    `${label}: still rendering skeleton placeholders — the capture would bake in a ` +
      `mid-load frame and then match it forever`,
  ).toHaveCount(0)
}

async function gotoDesktop(page: Page, path: string) {
  if (!DESKTOP) throw new Error('visual gate: no viewport at or above the desktop breakpoint')
  await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height })
  await page.goto(path)
  await settle(page)
}

test.describe('agent panel empty states and card banners', () => {
  test.skip(
    process.env.VISUAL_REGRESSION !== '1',
    'Linux-rendered baselines — run via the CI job (or VISUAL_REGRESSION=1 in a Linux container)',
  )

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  // ── AgentPanel EmptyStates ────────────────────────────────────────────────

  test('agent panel empty state — no agents yet', async ({ page }) => {
    await seedPanel(page, { agents: [] })
    await gotoDesktop(page, '/agents')

    const empty = page.getByRole('heading', { name: 'No agents yet' }).locator('xpath=..')
    await expect(empty).toHaveCount(1)
    await expectEmptyState(
      empty,
      {
        title: 'No agents yet',
        body: 'Set agent rules, then add your Haven credential to your agent',
        actions: ['Connect agent'],
      },
      'AgentPanel · No agents yet',
    )
    // The 20px `BotIcon` #1858 shrank from 24px. This is the assertion that
    // makes that change checkable rather than reviewed.
    await expectIconWithinSlot(empty, 'AgentPanel · No agents yet')

    await expectNoSkeletons(empty, 'AgentPanel · No agents yet')
    await expect(empty).toHaveScreenshot('agentpanel-empty-no-agents-desktop.png', SNAPSHOT_OPTIONS)
  })

  /**
   * `AgentPanel`'s FOURTH EmptyState — "Create a Haven account to manage
   * agents" (`AgentPanel.tsx:36-44`) — is deliberately NOT captured here,
   * because this run could not reach it and the reason turned out to be a
   * product fact rather than a fixture problem.
   *
   * The branch is `!safeAddress`, and `safeAddress` is
   * `activeSafe?.safe_address` where `activeSafe` is `resolveActiveSafe(safes)`
   * — which returns `null` only for an EMPTY `safes` array
   * (`AuthContext.tsx:75-87`). But `ProtectedRoute` gets there first: on a user
   * with no safes it `router.replace('/onboarding')` AND renders `null` while
   * it does (`ProtectedRoute.tsx:21-27, 41`). Seeding `safes: []` produced a
   * blank page with no `AgentPanel` on it at all, which is what sent this
   * looking at the guard.
   *
   * There is one gap in the guard — `hasSafe` is
   * `user.safes?.length > 0 || user.safe_address`, so a LEGACY user carrying
   * `safe_address` without any `user_safes` row would pass the guard and then
   * hit this branch. Whether the backend still produces that shape is not
   * something this issue established, so the branch is left uncaptured and
   * reported rather than photographed on a guess: a capture of a state the
   * product cannot reach is the exact failure #1924 was filed to stop, and
   * "probably reachable" is not the standard this file is holding everything
   * else to.
   *
   * Filed with the other out-of-reach surfaces rather than left as a silence.
   */

  // ── AgentCard warning banners ─────────────────────────────────────────────
  //
  // One seeded agent per test, one banner set per test, one capture per test.
  // `isPaused` and `has_stranded_funds` are INDEPENDENT — not mutually
  // exclusive the way the footer's five branches are — so the both-at-once case
  // is a real render the product reaches and gets its own capture rather than
  // being inferred from the two singles.
  const bannerCases = [
    {
      slug: 'paused',
      agent: agentState({ id: 'agent-paused', name: 'Paused agent', status: 'paused' }),
      banners: ['Paused in Haven'],
      title: 'Paused in Haven',
    },
    {
      slug: 'stranded',
      // `has_stranded_funds` is a plain field on the `Agent` wire shape
      // (documented in the spec by #1444, `useAgents.ts` header) — a backend
      // read, not an on-chain one, so a route override reaches it honestly.
      agent: agentState({
        id: 'agent-stranded',
        name: 'Stranded agent',
        has_stranded_funds: true,
      }),
      banners: ['Stranded funds on delegate'],
      title: 'Stranded funds on delegate',
    },
  ] as const

  /**
   * Both banners at once — a real render, and deliberately NOT captured.
   *
   * `isPaused` and `has_stranded_funds` are independent, not mutually exclusive
   * the way the footer's five branches are, and the backend can produce both:
   * an agent accumulates stranded funds while active and is then paused, with
   * no guard between the two (`repositories/agents.ts` — `pauseAgent` checks
   * only `status = 'active'`). So the stacked state exists and is worth a test.
   *
   * It gets no `toHaveScreenshot`, and that is the considered choice rather
   * than an omission. The only region containing BOTH banners is the card
   * itself — they are bare siblings with no wrapper — so a capture here would
   * be a strict SUPERSET of `agentcard-banner-paused` and
   * `agentcard-banner-stranded`. Every mutation to either banner would then
   * redden two captures instead of one, and the blast radius of a failure
   * would stop being a measurement and go back to being an inference. That is
   * exactly the property #1863's one-capture-per-test rule and #1820's extra
   * CI job were spent buying, and it is not worth spending it back to
   * re-photograph two regions that are already covered.
   *
   * What the stacked case actually adds over the two singles is ORDER and
   * co-occurrence, and both of those are structural — asserted here as an
   * exact ordered array, which is a stronger and more legible claim than a
   * pixel diff of a card would have been.
   */
  const STACKED_AGENT = agentState({
    id: 'agent-both',
    name: 'Both agent',
    status: 'paused',
    has_stranded_funds: true,
  })
  const STACKED_BANNERS = ['Paused in Haven', 'Stranded funds on delegate'] as const

  test('agent card warning banners — paused and stranded stack in order', async ({ page }) => {
    await seedPanel(page, { agents: [STACKED_AGENT] })
    await gotoDesktop(page, '/agents')

    const card = cardFor(page, STACKED_AGENT.name as string)
    await expect(card).toHaveCount(1)
    await expectCardBanners(card, STACKED_BANNERS, 'AgentCard · paused+stranded')
    await expectKnownBannerCount(card, 2, 'AgentCard · paused+stranded')

    // The two are siblings, so "stacked in order" is a DOM-order claim about
    // the card's own children — which is what the assertion above reads.
    // Pinning that they are genuinely two separate boxes rather than one:
    const boxes = await card.evaluate((el) =>
      Array.from(el.querySelectorAll('p'))
        .filter((p) =>
          ['Paused in Haven', 'Stranded funds on delegate'].includes(p.textContent?.trim() ?? ''),
        )
        .map((p) => Math.round(p.getBoundingClientRect().top)),
    )
    expect(boxes.length, 'expected both banner titles on the card').toBe(2)
    expect(
      boxes[0] < boxes[1],
      `the stranded banner rendered ABOVE the paused one (tops ${boxes[0]} / ${boxes[1]}). ` +
        `Order is a product claim: "this agent is paused" is the state, and the stranded ` +
        `funds notice is the exception within it.`,
    ).toBe(true)
  })

  for (const seeded of bannerCases) {
    test(`agent card warning banner — ${seeded.slug}`, async ({ page }) => {
      await seedPanel(page, { agents: [seeded.agent] })
      await gotoDesktop(page, '/agents')

      const card = cardFor(page, seeded.agent.name as string)
      await expect(card).toHaveCount(1)
      await expectCardBanners(card, seeded.banners, `AgentCard · ${seeded.slug}`)
      await expectKnownBannerCount(card, seeded.banners.length, `AgentCard · ${seeded.slug}`)

      // The banner itself is the region: `p` -> inner `div` -> banner root.
      // Located from its TITLE rather than from its classes, for the reason
      // #1811/#1820 gave — the classes are what this gate is checking.
      const banner = card
        .getByText(seeded.title, { exact: true })
        .locator('xpath=../..')
      await expect(banner).toHaveCount(1)

      await expectNoSkeletons(banner, `AgentCard · ${seeded.slug}`)
      await expect(banner).toHaveScreenshot(
        `agentcard-banner-${seeded.slug}-desktop.png`,
        SNAPSHOT_OPTIONS,
      )
    })
  }

  // ── 390px — GEOMETRY ONLY, deliberately no capture ────────────────────────
  //
  // #1797's rule (see the header). Checked FIRST during development rather
  // than bolted on: all four surfaces reflow at 390, and what is worth pinning
  // is that they reflow WITHOUT overflowing, which is a boolean and therefore
  // needs no baseline and carries none of the platform-metrics caveat the
  // captures do.
  test('empty states and banners do not overflow at 390px', async ({ page }) => {
    if (!MOBILE) throw new Error('visual gate: no viewport below the desktop breakpoint')

    await seedPanel(page, { agents: [STACKED_AGENT] })
    await page.setViewportSize({ width: MOBILE.width, height: MOBILE.height })
    await page.goto('/agents')
    await settle(page)

    const card = cardFor(page, STACKED_AGENT.name as string)
    await expect(card).toHaveCount(1)
    // Both banners, at the width where their icon + two-paragraph body is
    // tightest. `flex-shrink-0` on the icon is what this would catch losing.
    await expectCardBanners(card, STACKED_BANNERS, 'AgentCard · both @ 390px')

    const overflow = await card.evaluate((el) => ({
      card: el.scrollWidth - el.clientWidth,
      contentWidth: el.clientWidth,
    }))
    expect(
      overflow.card,
      `the paused+stranded card overflowed at ${MOBILE.width}px ` +
        `(content width ${overflow.contentWidth}px)`,
    ).toBe(0)
  })

  test('the empty state does not overflow at 390px', async ({ page }) => {
    if (!MOBILE) throw new Error('visual gate: no viewport below the desktop breakpoint')

    await seedPanel(page, { agents: [] })
    await page.setViewportSize({ width: MOBILE.width, height: MOBILE.height })
    await page.goto('/agents')
    await settle(page)

    const empty = page.getByRole('heading', { name: 'No agents yet' }).locator('xpath=..')
    await expect(empty).toHaveCount(1)
    // The slot fit is width-independent in principle and asserted here anyway:
    // `BotIcon`'s `size` is a prop, not a breakpoint, so if that ever stops
    // being true this is where it shows.
    await expectIconWithinSlot(empty, 'AgentPanel · No agents yet @ 390px')

    const overflow = await empty.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow, `the empty state overflowed at ${MOBILE.width}px`).toBe(0)
  })
})
