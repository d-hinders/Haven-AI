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
 * serves auth and balances, unmodified and unaware.
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
import { resolveToken } from '@haven_ai/core'
import {
  mockHavenApi,
  seedAuthenticatedSession,
  testAgent,
  testSafe,
  testSafeAddress,
} from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs. The ABI-level chain fixture the SCREENSHOT harness
// already runs on (#1935/#1971), reused rather than re-cut. #1930 extracted it
// out of `screenshot.mjs` into a module that imports nothing but viem and the
// shared chain registry, precisely so this spec can load it: a second
// hand-written encoder for the same four reads would drift SILENTLY, because a
// wrong encoding is swallowed by `useOnChainAllowances` into an empty map and
// renders as a plausible empty card.
import {
  FIXTURE_BLOCK_TIMESTAMP,
  makeAllowanceChainFixture,
} from '../scripts/allowance-chain-fixture.mjs'
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
 *
 * #2195 renamed the stranded-funds banner ("Stranded funds on delegate" →
 * "Recoverable funds in agent wallet", now shared with the agent-detail banner
 * via `lib/stranded-funds-copy.ts`). The titles here stay RESTATED LITERALS and
 * are deliberately NOT imported from that module: an independently written
 * vocabulary is the only thing that can catch an unintended copy change, and a
 * spec that imports the string it is checking asserts nothing about it.
 */
const BANNER_TITLES = ['Paused in Haven', 'Recoverable funds in agent wallet'] as const

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
 * ── The on-chain seam, and why #1930's fourth surface is reachable now ───────
 *
 * `UnmanagedDelegateCard` is the one surface in this family that no `/api/*`
 * body of any shape can put on screen. Its input is `unmanagedDelegates`
 * (`useAgentPanelState.ts:261-271`) — the set difference between the delegates
 * the AllowanceModule reports ON-CHAIN and the delegates Haven's own `/agents`
 * knows about. The left-hand side comes from `useOnChainAllowances`, which is
 * viem reading the module through `usePublicClient`.
 *
 * #1930 recorded this as "`page.route` does not intercept RPC calls at all, so
 * this is a capture-plumbing gap". **That reason is wrong, and it is worth
 * saying why rather than quietly deleting it.** viem's transport for every
 * chain Haven offers is `fallback()` over plain `http(url)` endpoints
 * (`lib/wagmi.ts`), so a chain read leaves the browser as an ordinary JSON-RPC
 * POST — the same kind of request Playwright routes for `/api/*`. Nothing about
 * RPC is out of `page.route`'s reach; the harness simply had no answerer.
 * #1935 built one for the screenshot harness and #1971 made it the default
 * there, which is what turned a plausible-sounding judgment into a checkable
 * one.
 *
 * The second half of #1930's judgment was load-bearing in a way its author
 * could not have known: before #1971, `lib/wagmi.ts` registered a transport for
 * 8453 only, `@wagmi/core`'s `getClient` CATCHES `ChainNotConfiguredError`, and
 * eleven call sites — `useAgentPanelState:39` among them — took `undefined` and
 * returned at their first line. Any read of "what a fixture can drive" made in
 * that window was made against a defect.
 *
 * So the seam is the SAME one, not a second implementation:
 * `makeAllowanceChainFixture` from the screenshot harness, which encodes the
 * four reads `useOnChainAllowances` actually makes and unwraps the Multicall3
 * `aggregate3` the app really sends. Every line between the wire and the pixel
 * is production code — viem encodes, the fixture answers ABI-encoded return
 * data, viem decodes, the hook maps, the card renders. Nothing is handed to a
 * component by hand.
 */

/** A delegate the module reports and `/agents` does not — the whole product state. */
const UNMANAGED_DELEGATE = '0x4444444444444444444444444444444444444444'
/**
 * The revoke control's accessible name speaks the TRUNCATED address (the
 * card's rendered `Address` form), derived here independently rather than
 * imported from the component's own helper — the assertion should not be
 * able to re-derive its expectation from the code under test.
 */
const UNMANAGED_DELEGATE_SHORT = `${UNMANAGED_DELEGATE.slice(0, 6)}…${UNMANAGED_DELEGATE.slice(-4)}`

/**
 * The unmanaged delegate's on-chain budget.
 *
 * Deliberately NOT the same numbers as `testAgent`'s API allowance. This card's
 * defining property is that its budget has no Haven-side counterpart, and a row
 * that happened to match the managed agent's would photograph a coincidence.
 */
/**
 * Resolved from the shared registry rather than pasted, and asserted rather
 * than `!`-ed: `resolveToken` returns `undefined` for a symbol a chain does not
 * carry, and an `undefined` token address would flow all the way into the ABI
 * encoder and surface as an unrelated decode failure.
 */
const UNMANAGED_TOKEN = resolveToken(testSafe.chain_id, 'USDC')
// `address` is nullable because the registry also describes NATIVE tokens. The
// AllowanceModule reads this fixture answers are ERC-20 reads keyed by a real
// contract address, so a null here is a fixture that cannot work — caught at
// load rather than surfacing as an unrelated ABI decode failure mid-render.
if (!UNMANAGED_TOKEN?.address) {
  throw new Error(
    `visual gate: chain ${testSafe.chain_id} carries no ERC-20 USDC in the shared registry`,
  )
}
const UNMANAGED_TOKEN_ADDRESS = UNMANAGED_TOKEN.address

const UNMANAGED_RESET_MIN = 1440

/**
 * Anchored INSIDE the current period, and that is the whole reason this
 * constant exists (#1930, design review).
 *
 * The fixture's `lastResetMin` defaults to 0, which is unboundedly far in the
 * past, so `computeEffectiveAllowance` reports `isResetPending` and zeroes
 * effective spend (`lib/allowance-math.ts:60-71`). The card then renders
 * "200.00 / 200.00 remaining per day" over an `AllowanceBar` whose fill segment
 * is ZERO WIDTH — a capture that shows the bar's track and never its fill.
 *
 * That is exactly the shape this spec family keeps having to catch: a
 * plausible, well-formed PNG of the wrong thing. The fill is the one part of
 * this row whose colour has to hold up against the card's `--v2-warning-soft`
 * ground, and a bar that never paints it cannot show a regression in it.
 *
 * Six hours back on a daily period puts the row at 45/200 spent — a partial
 * fill — and is still deterministic, because it is derived from the fixture's
 * own fixed block timestamp rather than from the wall clock.
 *
 * EVERY line of the resulting capture is now chain-derived, and the one that
 * was not is worth recording because the baseline moved when it was fixed.
 * `AllowanceBar` decided the reset from `chainTimeSec` but formatted the
 * countdown beneath it from `Date.now()` — filed as #1995, fixed by threading
 * the same `nowSec` into the formatter. Two corrections to what this comment
 * said before: the call site binds `agent-panel/agent-display.tsx`'s
 * `timeUntil`, NOT `lib/format.ts`'s (two same-named helpers; a grep for
 * `timeUntil` cannot say which one a call site resolves to), and its cliff
 * string is therefore `now`, not `expired`.
 *
 * The concrete consequence for this baseline: the row used to render
 * "Resets in now" — the terminal value, because `FIXTURE_BLOCK_TIMESTAMP` is
 * permanently in the past — beside a bar drawn from a decision that the reset
 * had NOT happened. It now renders "Resets in 18h 0m", which is what six hours
 * into a daily period actually leaves. The string is still pinned, and now for
 * a better reason: it is a function of the fixture block and the row alone, so
 * advancing the fixture block no longer moves it in a way the wall clock
 * decides.
 */
const UNMANAGED_LAST_RESET_MIN = Math.floor(FIXTURE_BLOCK_TIMESTAMP / 60) - 360

const UNMANAGED_ROWS = [
  {
    token: UNMANAGED_TOKEN_ADDRESS,
    amount: 200_000000n,
    spent: 45_000000n,
    resetTimeMin: UNMANAGED_RESET_MIN,
    lastResetMin: UNMANAGED_LAST_RESET_MIN,
  },
] as const

const answerUnmanagedChainRead = makeAllowanceChainFixture({
  chainId: testSafe.chain_id,
  safeAddress: testSafeAddress,
  delegates: [UNMANAGED_DELEGATE],
  rows: UNMANAGED_ROWS,
}) as (method: string, params: unknown[]) => unknown

/** What a run learned about the chain traffic it served. */
interface ChainWatch {
  /** Reads the app actually issued. Zero is FATAL — see below. */
  observed: string[]
  /** Reads this fixture had no answer for. */
  gaps: string[]
}

/**
 * Answer the app's JSON-RPC over `page.route`, and MEASURE what was asked.
 *
 * Registered last, so Playwright matches it before `seedPanel`'s and
 * `mockHavenApi`'s handlers; anything that is not a JSON-RPC envelope is handed
 * straight back with `route.fallback()`, which DEFERS rather than fulfilling, so
 * pages, `/_next` assets and every `/api/*` route are served exactly as before.
 * The body is parsed before the request is claimed, so an unrelated POST to some
 * other host cannot be swallowed here.
 *
 * The two counters are the point, and they catch opposite failures:
 *
 * - `gaps` is "the app asked and this fixture had no answer". Left unmeasured
 *   that is invisible, because `useOnChainAllowances` swallows a failed read
 *   into an empty map (`useOnChainAllowances.ts:136-139` logs and moves on) and
 *   the panel renders its EMPTY branch. That is a well-formed, entirely wrong
 *   capture: the empty state of the very surface the test exists to show.
 * - `observed` is "the app asked at all". This is the failure that hid #1971 for
 *   the whole life of the screenshot harness, and it produces NO request to be
 *   missing from `gaps` — `usePublicClient` returns `undefined`, the consumer
 *   returns at its first line, nothing throws and nothing is logged. A test that
 *   only checked `gaps` would call that a clean run.
 *
 * Both are asserted in the test rather than here, so the failure names the
 * capture it belongs to.
 */
async function seedChain(
  page: Page,
  answer: (method: string, params: unknown[]) => unknown,
): Promise<ChainWatch> {
  const watch: ChainWatch = { observed: [], gaps: [] }

  await page.route('**/*', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') return route.fallback()

    let payload: unknown
    try {
      payload = request.postDataJSON()
    } catch {
      return route.fallback()
    }

    const batched = Array.isArray(payload)
    const calls = (batched ? payload : [payload]) as Array<{
      jsonrpc?: string
      id?: unknown
      method?: unknown
      params?: unknown[]
    }>
    if (calls.length === 0) return route.fallback()
    const isRpc = (c: (typeof calls)[number]) =>
      Boolean(c) && c.jsonrpc === '2.0' && typeof c.method === 'string'
    if (!calls.every(isRpc)) return route.fallback()

    // Recorded BEFORE any answer is computed: the question is whether the app
    // ASKED, not whether we could reply.
    for (const call of calls) watch.observed.push(String(call.method))

    const answers = calls.map((call) => {
      const method = String(call.method)
      let result: unknown
      try {
        result = answer(method, call.params ?? [])
      } catch (err) {
        // A throw from the fixture is a FIXTURE bug and must not read like a
        // chain that declined — same bucket, different sentence.
        watch.gaps.push(`${method}: the fixture threw — ${String(err)}`)
        return { jsonrpc: '2.0', id: call.id ?? null, error: { code: -32000, message: 'fixture threw' } }
      }
      if (result === undefined) {
        watch.gaps.push(`${method}: no answer was declared for this read`)
        return {
          jsonrpc: '2.0',
          id: call.id ?? null,
          error: { code: -32601, message: `no answer for ${method}` },
        }
      }
      return { jsonrpc: '2.0', id: call.id ?? null, result }
    })

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(batched ? answers : answers[0]),
    })
  })

  return watch
}

/**
 * The chain traffic was real, complete, and served entirely from this fixture.
 *
 * Asserted immediately before the capture for the same reason `expectNoSkeletons`
 * is: a PNG taken while either of these is false looks exactly like a PNG taken
 * while both are true.
 */
async function expectChainServed(watch: ChainWatch, label: string) {
  // Polled, and asserted BEFORE anything about the card. The reads are async
  // and complete independently of whether the card ends up on screen, so this
  // does not need the card as a proxy for "the fetch finished" — and it must
  // not use one. Measured (#1930): when a read goes unanswered,
  // `getAllAllowances` throws, `useOnChainAllowances` catches it into an empty
  // allowance list, and `unmanagedDelegates` then DROPS the delegate outright
  // — `.filter((d) => d.allowances.length > 0)` (`useAgentPanelState.ts:270`).
  // There is no card left to be missing a budget. Asserted AFTER the card
  // locator, this guard never fires at all and the run reports "card not
  // found", pointing at the component rather than at the read that failed.
  await expect
    .poll(() => watch.observed.length, {
      message:
        `${label}: the app issued NO chain read at all. That is the #1971 shape — ` +
        `\`getClient\` catches ChainNotConfiguredError and returns undefined, so ` +
        `\`usePublicClient\` is undefined and every consumer returns at its first ` +
        `line, silently. Check that testSafe.chain_id is registered in lib/wagmi.ts.`,
    })
    .toBeGreaterThan(0)
  expect(
    watch.gaps,
    `${label}: the app issued chain reads this fixture could not answer. ` +
      `useOnChainAllowances swallows a failed read into an EMPTY map, so the ` +
      `capture would be a photograph of the empty branch rather than of this card.`,
  ).toEqual([])
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
 *
 * Scans ALL `<p>` descendants of the card, not just direct banner children —
 * so it carries an implicit invariant: fixture copy (name, description,
 * safe_name, etc.) must never collide with a `BANNER_TITLES` string, or it
 * would be counted as a banner here.
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
 * coded list: a THIRD banner added to `AgentCard` with the SAME warning tone
 * would render, be captured, and pass — the assertion would look at the two
 * titles it knows, find them, and say nothing about the newcomer. That is the
 * "coverage is a file count" failure one level in.
 *
 * Narrower than it may look: this only defends against a same-tone warning
 * banner slipping in unlisted. It compares against the resolved
 * `--v2-warning-soft` fill specifically, so a differently-toned banner (e.g. a
 * danger-toned banner using a different token) is NOT counted here and is NOT
 * detected by this check — it would need `expectCardBanners`'s title list (or
 * a parallel tone-specific count) to be caught.
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
    // Transient scratch probe — appended, measured, and removed synchronously
    // within this `page.evaluate`. It MUST stay synchronous: moving this into
    // an async evaluate could leave the probe mounted in the DOM during a
    // `toHaveScreenshot` capture.
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
   * ── The three surfaces that are STILL unreachable (#1930) ──────────────────
   *
   * #1930 recorded four surfaces this spec could not reach. Three of them are
   * re-derived below against `dev` AFTER #1979/#1971 — the defect that made
   * `usePublicClient` `undefined` on one of Haven's two chains, and therefore
   * made every earlier reachability judgment suspect — and after #1972/#1935
   * gave the harness a way to answer chain reads at all. The fourth,
   * `UnmanagedDelegateCard`, turned out to be reachable and is captured above.
   *
   * They are reported rather than synthesised, per
   * `docs/contributing/ship-playbooks/frontend.md` §4: a fixture that reaches a
   * state the product cannot is worse than no capture, because it is green
   * forever about something no user can see.
   *
   * ── 1. `AgentPanel`'s no-account EmptyState — PERMANENTLY unreachable ──────
   *
   * "Create a Haven account to manage agents" (`AgentPanel.tsx:36-44`) is gated
   * on `!safeAddress`, and `safeAddress` is `activeSafe?.safe_address` where
   * `activeSafe` is `resolveActiveSafe(safes)` — null only for an EMPTY `safes`
   * array (`AuthContext.tsx:75-87`). `ProtectedRoute` gets there first: a user
   * with no safes is `router.replace('/onboarding')`d and renders `null` in the
   * meantime (`ProtectedRoute.tsx:21-27, 41`).
   *
   * #1930 left ONE hole in that argument open, and it is closed here rather
   * than restated. The guard is `hasSafe = user.safes?.length > 0 ||
   * user.safe_address` (`ProtectedRoute.tsx:27`), so a LEGACY user carrying
   * `users.safe_address` with zero `user_safes` rows would pass the guard and
   * then hit this branch. That shape turns out to be one the backend maintains
   * an invariant against, on every path that writes either side:
   *
   *   - migration `000_initial` BACKFILLS `user_safes` from every non-null
   *     `users.safe_address`;
   *   - `users.safe_address` is written only when the FIRST safe is inserted,
   *     which is also the one marked default
   *     (`routes/user-safes.ts:122-135`, `isFirst`);
   *   - unlinking the LAST safe CLEARS the mirror in the same transaction
   *     (`CLEAR_LEGACY_USER_SAFE_ADDRESS_SQL`, `deleteSafeForUser`,
   *     `infra/repositories/user-safes.ts:301-324`), and unlinking a non-last
   *     default re-points it at the promoted safe;
   *   - `/auth/me` returns every `user_safes` row for the user, unfiltered by
   *     chain or anything else (`LIST_SESSION_SAFES_FOR_USER_SQL`).
   *
   * ONE residual path survives that reading, found by independent review and
   * recorded here rather than rounded off. `PUT /user/safe`
   * (`routes/user.ts:152-174`) writes the same two sides with **two
   * un-transacted `pool.query` calls in sequence** — the legacy mirror first,
   * the `user_safes` row second. A crash between them commits exactly the
   * shape the paragraph above says cannot exist. It has no frontend caller
   * (the dashboard uses `POST /user/safes`), so no user reaches it through the
   * product, and the window is a torn write rather than a state the backend
   * intends — but "the backend cannot emit this" is stronger than the evidence
   * supports, and the honest claim is that it cannot emit it *by design*.
   *
   * Filed as #1994 rather than fixed here: wrapping a route's writes in a
   * transaction is a behaviour change on the account-linking path, which is
   * not a test PR's to make.
   *
   * The conclusion is unchanged either way. A capture of this branch would be
   * a photograph of a torn write, not of a screen the product puts anyone on,
   * and #1924's rule is about what the PRODUCT can reach.
   *
   * ── 2. The finalizing / finalize-timeout EmptyStates — behind a signature ──
   *
   * Both (`AgentPanel.tsx:109-144`) are driven by `finalizingAgent` /
   * `finalizeTimedOut`, which only `pollForNewAgent` sets
   * (`useAgentPanelState.ts:152-196`) — and it is reached from exactly two
   * places. `handleSetupUpdated` is `ConnectAgentModal`'s `onSetupUpdated`; the
   * only two call sites that pass a NON-NULL `delegateAddress` (the poll
   * returns early without either flag when the delegate is absent,
   * `useAgentPanelState.ts:159-166`) are
   * `useAgentConnectionSetup.ts:733` and `:744`:
   *
   *   - `:733` is after `executeAgentSetup({ signer, publicClient, ... })` — a
   *     real Safe transaction signed by a real wallet;
   *   - `:744` is `handleDelegationApproved`, which reads as pure API until it
   *     is traced back: it is `DelegationApprovalStep`'s `onApproved`, called
   *     only from `confirmWithHaven` (`DelegationApprovalStep.tsx:83-96`),
   *     which runs only after `BudgetGrantAction`'s `grant(input)` returns
   *     `ok` (`BudgetGrantAction.tsx:79-83`) — and `grant` is
   *     `useDelegationBudget`, i.e. a WebAuthn passkey assertion or
   *     `walletClient.signTypedData` (`useDelegationBudget.ts:114-126`).
   *
   * The second entry point, `retryFinalizePoll`, is rendered only INSIDE the
   * timeout EmptyState's own "Check again" button — reaching it requires the
   * state it produces. Neither leg moved with #1971 or #1935: both are wallet
   * signatures, which no `page.route` fixture can supply.
   *
   * ── 3. `ErrorBoundary`'s fallback — behind a contract the backend keeps ────
   *
   * `ErrorBoundary` wraps every authenticated route
   * (`app/(authenticated)/layout.tsx:55`) and renders its fallback only when a
   * descendant THROWS during render. #1930 recorded the only unguarded accesses
   * as `agent.allowances`; today there are three more, all created by the same
   * mechanism and all closed by the same fact:
   *
   *   - `custody/page.tsx:88` — `getChainConfig(safe.chain_id).name`
   *   - `EditAgentModal.tsx:91` — `getChainTokens(chainId)`
   *   - `agent-display.tsx:28` — `getChainTokens(chainId)` via `AllowanceBar`
   *
   * Each throws on a chain id the shared registry does not carry. The backend
   * rejects one at the door on both write paths — `isSupportedChain` at
   * `routes/user-safes.ts:89` (deploy) and `:111` (import) — and no chain has
   * been removed from `CHAIN_REGISTRY`, so stored rows on Gnosis (100) are
   * still resolvable. A fixture COULD emit `chain_id: 999` and redden the
   * screen, and that is precisely the capture this file must not take.
   *
   * `ErrorBoundary` is the costliest of the three to leave uncovered — it is
   * exercised by no other spec, and its entire job is to display failures that
   * are by definition unplanned — so #1930 keeps it as the priority and names
   * the direction: a dedicated dev-only throw trigger, which is a product
   * change and not this spec's to make.
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
      banners: ['Recoverable funds in agent wallet'],
      title: 'Recoverable funds in agent wallet',
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
  const STACKED_BANNERS = ['Paused in Haven', 'Recoverable funds in agent wallet'] as const

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
          ['Paused in Haven', 'Recoverable funds in agent wallet'].includes(p.textContent?.trim() ?? ''),
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

  // ── UnmanagedDelegateCard — the chain-fed surface (#1930) ─────────────────
  //
  // The card locator is the heading's fifth ancestor, and that is this file's
  // established idiom (`empty` and `banner` above are the same shape) rather
  // than a shortcut: `UnmanagedDelegateCard` carries no role and no
  // `aria-label`, so its only semantic handle is its heading. Walking to the
  // root by structure keeps the capture off the class strings this gate is
  // under contract to police (#1811/#1820). #1980 is the open owner decision
  // about this card's affordances — this test photographs what exists and
  // changes nothing about it.
  function unmanagedCard(page: Page) {
    return page
      .getByRole('heading', { name: 'Unmanaged Delegate' })
      .locator('xpath=../../../../..')
  }

  /**
   * Assert the card's full rendered content, including the budget row the CHAIN
   * seeded.
   *
   * The budget assertion is the "seeding a state is not rendering the branch"
   * rule (#1873) applied to a fixture that is two layers deeper than an API
   * body. `getDelegates` returning an address proves nothing about whether
   * `getTokens` and `getTokenAllowance` were answered, decoded and mapped —
   * `UnmanagedDelegateCard` renders its whole `Agent budget` block behind
   * `allowances.length > 0` (`UnmanagedDelegateCard.tsx:78`), so a card whose
   * allowance reads failed renders a perfectly plausible header-and-address
   * card with the budget silently absent.
   *
   * The heading and the chip are asserted as an exact pair for the same reason
   * `expectCardBanners` is exact: the `pendingHavenSetup` branch of this
   * component is STRUCTURALLY IDENTICAL — same markup, same slots — and differs
   * only in tone, icon and these two strings ("Finishing agent setup" /
   * "confirming"). A `toBeVisible()` on the address block would pass on either,
   * and the two captures would be silent near-duplicates.
   */
  async function expectUnmanagedCard(card: Locator, label: string) {
    // The card's heading SET, not "the heading I located it by is present" —
    // the latter cannot fail, because `card` is built by walking up from that
    // exact heading and the caller has already asserted it resolves
    // (independent review, #1930). Asserting the set has real discriminating
    // power: a second heading appearing inside this card fails here.
    const headings = await card
      .getByRole('heading')
      .evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ''))
    expect(
      headings,
      `${label}: this is not the heading set the card is supposed to render`,
    ).toEqual(['Unmanaged Delegate'])
    await expect(
      card.getByText('network only', { exact: true }),
      `${label}: this is the pendingHavenSetup branch, not the unmanaged one`,
    ).toHaveCount(1)
    await expect(card).toContainText('This delegate was set up outside Haven')

    // Existence FIRST, as its own assertion with its own sentence. Reading the
    // symbols straight off a locator that resolves to nothing does redden — but
    // it reddens as a bare 60s `locator.evaluate` timeout, which says nothing
    // about what went wrong. Measured, not predicted: suppressing this block in
    // `UnmanagedDelegateCard` produced exactly that, and the diagnosis it costs
    // is the whole reason these messages are written.
    const budget = card.locator('text=Agent budget').locator('xpath=..')
    await expect(
      budget,
      `${label}: the card rendered with NO on-chain budget block. The delegate ` +
        `came from getDelegates, but the rows come from getTokens + ` +
        `getTokenAllowance — a card with no budget is what an unanswered ` +
        `allowance read looks like, and it photographs perfectly happily.`,
    ).toHaveCount(1)

    const budgetSymbols = await budget.evaluate((el) =>
      Array.from(el.querySelectorAll('span, p'))
        .map((n) => n.textContent?.trim() ?? '')
        .filter((t) => /^[A-Z]{2,6}$/.test(t)),
    )
    expect(
      budgetSymbols,
      `${label}: the budget block rendered but carries no token symbol — the ` +
        `rows did not survive decoding.`,
    ).toContain('USDC')

    // The bar's FILL, not just its track. `AllowanceBar` paints the spent
    // portion as a nested element inside the track, and a reset-pending row
    // paints it at zero width — which photographs as a perfectly tidy empty
    // bar. Asserting a fill wider than 0 and narrower than the track is what
    // makes this capture evidence about the fill colour rather than about the
    // container it sits in (#1930, design review).
    const fill = await budget.evaluate((el) => {
      const bars = Array.from(el.querySelectorAll('div')).filter((d) => {
        const parent = d.parentElement
        if (!parent) return false
        return (
          d.getBoundingClientRect().width > 0 &&
          d.getBoundingClientRect().width < parent.getBoundingClientRect().width &&
          getComputedStyle(d).backgroundColor !== getComputedStyle(parent).backgroundColor
        )
      })
      return bars.length
    })
    expect(
      fill,
      `${label}: no partially-filled bar segment inside the budget block. A ` +
        `reset-pending row renders the track with a ZERO-WIDTH fill, so this ` +
        `capture would show the bar's container and never the fill colour it ` +
        `exists to prove. Check UNMANAGED_LAST_RESET_MIN.`,
    ).toBeGreaterThan(0)

    // #1980: the card answers "how do I stop this authority" with a control,
    // not a copy button. /custody's "Revoke an agent — or an unmanaged
    // delegate — on-chain from Agents" copy points HERE, so a card without
    // this control makes that copy a lie again.
    await expect(
      card.getByRole('button', { name: `Revoke delegate ${UNMANAGED_DELEGATE_SHORT}` }),
      `${label}: the revoke affordance is missing — this card shows live ` +
        `spending authority and must answer how the user stops it (#1980).`,
    ).toBeVisible()
  }

  test('agent panel unmanaged delegate — set up outside Haven', async ({ page }) => {
    // No managed agent at all, so the on-chain delegate is unmanaged by set
    // difference rather than by a field. `unmanagedDelegates.length > 0` is
    // also what keeps the panel off its "No agents yet" empty state
    // (`AgentPanel.tsx:147-151`), so this fixture cannot be confused with that
    // one — the two branches are mutually exclusive in the product.
    await seedPanel(page, { agents: [] })
    const chain = await seedChain(page, answerUnmanagedChainRead)
    await gotoDesktop(page, '/agents')

    // BEFORE the card is looked for. See `expectChainServed` — an unanswered
    // read removes the card ENTIRELY rather than emptying it, so every
    // assertion below this line would report "card not found" for a fault that
    // is actually in the chain fixture.
    await expectChainServed(chain, 'UnmanagedDelegateCard · network only')

    const card = unmanagedCard(page)
    await expect(card).toHaveCount(1)
    await expectUnmanagedCard(card, 'UnmanagedDelegateCard · network only')
    // The empty state and this card are mutually exclusive branches of the same
    // `agents.length === 0` fixture. Pinning the negative is what stops a
    // regression that renders BOTH from photographing as if only this one ran.
    await expect(page.getByRole('heading', { name: 'No agents yet' })).toHaveCount(0)

    await expectNoSkeletons(card, 'UnmanagedDelegateCard · network only')
    await expect(card).toHaveScreenshot('unmanaged-delegate-card-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('unmanaged delegate revoke goes through the confirm pattern (#1980)', async ({ page }) => {
    await seedPanel(page, { agents: [] })
    const chain = await seedChain(page, answerUnmanagedChainRead)
    await gotoDesktop(page, '/agents')
    await expectChainServed(chain, 'UnmanagedDelegateCard · revoke confirm')

    const card = unmanagedCard(page)
    await expect(card).toHaveCount(1)

    // The affordance, then the established destructive-confirm pattern: the
    // button alone commits NOTHING — the dialog stands between the click and
    // the Safe transaction, exactly as AgentCard's revoke does.
    await card.getByRole('button', { name: `Revoke delegate ${UNMANAGED_DELEGATE_SHORT}` }).click()
    await expect(page.getByText('Revoke this delegate?')).toBeVisible()
    // Money copy, not decoration: the dialog names the authority being
    // removed and that the user approves the update.
    await expect(page.getByText(/Revoking removes its network spending authority/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Revoke delegate', exact: true })).toBeVisible()

    // Cancel: the card is still there, no state changed, no tx was attempted.
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('Revoke this delegate?')).toHaveCount(0)
    await expect(card).toHaveCount(1)
  })

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

  test('the unmanaged delegate card does not overflow at 390px', async ({ page }) => {
    if (!MOBILE) throw new Error('visual gate: no viewport below the desktop breakpoint')

    await seedPanel(page, { agents: [] })
    const chain = await seedChain(page, answerUnmanagedChainRead)
    await page.setViewportSize({ width: MOBILE.width, height: MOBILE.height })
    await page.goto('/agents')
    await settle(page)

    await expectChainServed(chain, 'UnmanagedDelegateCard · network only @ 390px')

    const card = unmanagedCard(page)
    await expect(card).toHaveCount(1)
    // Re-asserted at this width rather than assumed from the desktop test: the
    // budget block is the widest thing in the card and it is the part fed by
    // the chain, so a 390px run that lost it would otherwise report a clean
    // zero-overflow on a card that is narrow because it is empty.
    await expectUnmanagedCard(card, 'UnmanagedDelegateCard · network only @ 390px')

    const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(
      overflow,
      `the unmanaged delegate card overflowed at ${MOBILE.width}px`,
    ).toBe(0)
  })
})
