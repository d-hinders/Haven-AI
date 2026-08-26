/**
 * Rendered evidence for `WalletButton`'s two UNCAPTURED collapsed states
 * (#1944): the connected-wallet AVATAR and WRONG NETWORK, below `sm`.
 *
 * BASELINES ARE LINUX-RENDERED, exactly as `design-system.visual.spec.ts`'s,
 * `focus-visible.visual.spec.ts`'s and `agent-panel-states.visual.spec.ts`'s
 * are, and for the same reason: CI is the judge and macOS font rendering
 * differs. Skipped locally unless VISUAL_REGRESSION=1. Regenerate via the
 * **Update visual baselines** workflow on the branch — see
 * docs/contributing/ship-playbooks/frontend.md §4.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * #1803 (PR #1942) collapsed every state of this control to a 40px icon/avatar
 * square below `sm`. The `haven-design-reviewer` pass saw three of the five
 * states rendered and two only in source, and the owner merged on the unit and
 * e2e coverage rather than hold the PR — filing #1944 so "reviewed" would not
 * be read as "seen". This file is what makes that sign-off real.
 *
 * ── Both states are REACHABLE, and the recorded reasons they were not ────────
 *
 * #1944 recorded each as uncapturable. Both judgments are re-derived against
 * `dev` here rather than inherited, because #1930 found the same class of
 * judgment ("`page.route` does not intercept RPC at all") had never been true.
 *
 * **connected avatar.** The recorded attempt seeded a STORED PASSKEY SIGNER and
 * watched the app hang on "Loading…". Stopping there was right, but the seam
 * was the wrong one for this state: a stored passkey resolves
 * `useActiveSigner` to `type: 'passkey'` and lands in `WalletButton`'s FIRST
 * branch (`WalletButton.tsx:594`), which is the *passkey* avatar — a different
 * state that was already captured. The connected-EOA avatar is the LAST branch
 * (`:766`) and is reached only when neither passkey branch fires and RainbowKit
 * reports `account` + `chain`. So what it needs is a connected wallet with NO
 * passkey on the device, which is precisely the shape the e2e fixture already
 * has: `seedAuthenticatedSession` seeds no passkey store at all, and an `eoa`
 * signer falls through both passkey branches by construction (`WalletButton`
 * narrows on `'passkey'` / `'delegator_passkey'` only). Note the fixture user
 * has no HYBRID account either: since #1969 (owner decision 2026-08-26) a
 * hybrid user with a hydrated signer set resolves a `delegator_passkey` even
 * marker-less, so reaching the connected-EOA branch additionally requires a
 * legacy-Safe (or empty-set) account, which is what this fixture is. This
 * file captures rendering only and changes nothing about signer resolution.
 *
 * **wrong network.** Recorded as having "no capture path in the mocked harness
 * at all". Re-derived: RainbowKit hands the render prop a `chain` object
 * whenever `useAccount().chainId` is truthy, with
 * `unsupported: !wagmiChains.some((c) => c.id === chainId)`
 * (`ConnectButtonRenderer.tsx`) — so a wallet on a chain outside
 * `SUPPORTED_CHAIN_IDS` produces `connected === true` AND `unsupported ===
 * true`, which is exactly `WalletButton.tsx:743-746`. Since #1979/#1971 that
 * set is DERIVED from `lib/chains.ts` rather than hand-written, so the question
 * "is a chain outside it expressible" now has a stable answer instead of one
 * that depended on a transport table drifting from the chain list.
 *
 * The missing piece for both was never the app — it was that nothing in the
 * harness answered `window.ethereum`. `e2e/fixtures/injected-wallet.ts` does,
 * and its header states why a wallet stub is an EXTERNAL-SYSTEM fixture of the
 * same kind as `mockHavenApi` and the chain fixture, not a doctored render.
 *
 * ── Why 320px is NOT captured here, and does not join the shared viewports ───
 *
 * #1944's third question, answered rather than left open. **No**, on three
 * counts:
 *
 *  1. **Cost.** `scripts/evidence-viewports.mjs` is not a list of widths, it is
 *     the input to four consumers. `design-system.visual.spec.ts` iterates it
 *     and would mint a new BLOCKING full-page `/design-system` baseline at 320;
 *     `capture-integrity.spec.ts` iterates it and gains a test;
 *     `scripts/screenshot.mjs` would shoot a third PNG of every route in every
 *     evidence run, forever, on every frontend PR.
 *  2. **It buys nothing for these two states.** The collapse is one breakpoint
 *     (`sm`, 640px), so the 320 rendering of this control is structurally
 *     identical to the 390 one — same 40px square, same child, same tone. A 320
 *     baseline would be a near-duplicate whose only measurable effect is to
 *     redden two captures for every mutation instead of one, spending back
 *     exactly the blast-radius property #1863/#1873 bought.
 *  3. **320's real risk is already gated, by a better instrument.** What breaks
 *     at 320 is TopBar LAYOUT ARITHMETIC — overlap, and a label squeezed to
 *     17px. `e2e/mobile-nav-tap-target.mobile.spec.ts` runs `WIDTHS = [320,
 *     390, 1023]` in the `chromium-mobile` project and asserts the ≥8px gap
 *     floor, the 24px legibility floor and #1803's own assertion 10 at that
 *     width, in a real engine with device emulation. A pixel baseline is the
 *     WEAKER instrument for that class: an overlap photographs perfectly
 *     happily — the #1858 lesson — while the arithmetic assertion cannot.
 *
 * So 320 is covered where it matters and uncaptured where it would only cost.
 * The residual gap is a REVIEWER one — there is no way to *look* at 320 without
 * hand-editing a shared file, since `scripts/screenshot.mjs` iterates
 * `VIEWPORTS` with no override of any kind. That is filed as **#2006** (an
 * opt-in, non-default width override for the capture harness) rather than
 * solved by moving four gates' baselines.
 *
 * ── One capture per test ─────────────────────────────────────────────────────
 *
 * Inherited from #1863/#1873/#1924: several `toHaveScreenshot` calls in one
 * test SHORT-CIRCUIT, so a mutation reddening capture 2 never runs 3 and the
 * run reports one failure where the truth might be two. Separate tests make
 * each capture's verdict independent.
 *
 * ── A guard against a fork must NAME its branch (#1984) ──────────────────────
 *
 * The load-bearing rule for this file specifically, because the whole issue is
 * about distinguishing forks of ONE component. #1984 found an assertion
 * matching `/passkey/i` satisfied by the very fork it was meant to exclude.
 * `WalletButton` has five renderings that differ in one child and one tone:
 *
 *   branch            accessible name        child            tone
 *   passkey signer    the passkey alias      gradient avatar  white
 *   delegator passkey "Passkey"              gradient avatar  white
 *   not connected     "Connect wallet"       lucide svg       brand
 *   wrong network     "Wrong network"        lucide svg       danger-soft
 *   connected EOA     truncated address      gradient avatar  white
 *
 * A `toBeVisible()` on "the wallet button" is satisfied by all five. So each
 * test asserts the NAME (exact, against a closed vocabulary), the CHILD FORK
 * (gradient avatar vs. `svg`, counted both ways) and the TONE (a computed
 * colour compared against the resolved token) — three independent
 * discriminators, no two of which any other branch satisfies together.
 *
 * ── The mutation matrix these assertions were proven against ────────────────
 *
 * Each mutation applied to `WalletButton.tsx`, this file run, then restored
 * from a task-named backup and re-verified by CONTENT (`cmp`), not by memory.
 *
 *   mutation                                          red                 other tests
 *   connected branch loses `aria-label`               NONE — see below    green
 *   connected branch loses `aria-label` AND `title`   name (1)            green
 *   connected branch's AddressAvatar -> lucide Icon   fork (3)            green
 *   wrong-network span loses LABEL_BELOW_SM           collapse (2)        green
 *   wrong-network bg danger-soft -> white             tone (4)            green
 *
 * Two things that matrix is worth reading for. The first row produced **zero
 * reds** and its diagnosis is written out at assertion (1) — `title` shadows
 * `aria-label` in the accessible-name computation, which is the product's own
 * design and not a hole in the guard. And the third test — the Connect-wallet
 * control — stayed green through every one of them, which is the other half of
 * a mutation proof: nothing reddened that the mutation could not have touched.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
import {
  SUPPORTED_CHAIN_ID_HEX,
  UNSUPPORTED_CHAIN_ID_HEX,
  connectedWalletShortName,
  installInjectedWallet,
} from './fixtures/injected-wallet'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports, shared with
// the screenshot script and the other three pixel gates so all of them render
// at the same widths.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{
  name: string
  width: number
  height: number
}>

/**
 * Tailwind's `sm`. `COLLAPSE_BELOW_SM` retires itself at and above this width,
 * so a capture of a COLLAPSED control is only evidence when it was taken below
 * it. Asserted rather than assumed — see `gotoCollapsed`.
 */
const SM_BREAKPOINT_PX = 640

const MOBILE = VIEWPORTS.find((vp) => vp.width < SM_BREAKPOINT_PX)

/**
 * The collapsed box, from `COLLAPSE_BELOW_SM`'s `h-10 w-10`. It was chosen to
 * match the notification bell's own painted box, which WAS the point of the
 * number (`WalletButton.tsx:106-108`) — #1989 deleted the bell with the Safe
 * rail, so 40 is now simply the collapsed wallet's size and mirrors nothing.
 * The value is unchanged and still asserted; only its rationale expired. Asserted as PAINTED geometry so the capture is
 * known to be of a 40px square and not of a control that quietly regrew.
 */
const COLLAPSED_BOX_PX = 40

/**
 * `threshold` is pixelmatch's PER-PIXEL colour tolerance; Playwright's default
 * of 0.2 means a pixel counts as different only past a YIQ delta of 1,408.6,
 * and #1820 measured a within-palette tone swap at 69.7 — so at the default
 * this entire class of change counts ZERO differing pixels and no budget of any
 * size would catch it. Inherited unchanged from #1863/#1924: the budget is not
 * the dial.
 */
const PIXEL_THRESHOLD = 0.02

/**
 * Proportional to the region, per #1863's correction rather than copying an
 * absolute number between captures of different sizes. These regions are 40x40
 * = 1,600 px, an order of magnitude smaller than #1924's ~33,600 px banner, so
 * its 50 would be a 3.1% budget here. 8 keeps the proportion in the same band
 * (0.5%) while staying off 0 for the reason none of this family is 0: a runner
 * image or Chromium bump may legitimately nudge the antialiasing on a circle,
 * and a gate that goes flat red every week is a gate someone turns off.
 */
const MAX_DIFF_PIXELS = 8

const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: MAX_DIFF_PIXELS,
  threshold: PIXEL_THRESHOLD,
} as const

/**
 * The CLOSED vocabulary of `WalletButton`'s accessible names, minus the two
 * that are data-dependent (the passkey alias, and the connected wallet's
 * alias/ENS/truncated address).
 *
 * Used only NEGATIVELY — "no OTHER control in the bar announces as one of these
 * states" — so that a regression rendering two wallet controls, or the wrong
 * branch beside the right one, fails instead of photographing as a clean single
 * capture.
 */
const OTHER_STATE_NAMES = ['Connect wallet', 'Wrong network', 'Passkey'] as const

/**
 * The wallet control, located POSITIONALLY.
 *
 * NOT by its `aria-label`, and that is the #1811/#1820 rule rather than a
 * preference: the accessible name is the thing this gate is under contract to
 * check, so it must not also be the thing the gate trusts to find its subject —
 * a `getByLabel('Wrong network')` locator cannot fail the "the name is wrong"
 * assertion, it can only fail to resolve, which reports as a missing element.
 *
 * `TopBar.tsx` renders exactly two regions plus an optional action slot, with
 * the wallet last inside the right one: `<div className="ml-auto flex ...">`
 * containing `<WalletButton />`. It also held `<ApprovalNotifications />`
 * before it until #1989 deleted that with the Safe rail, so the wallet is now
 * the region's ONLY child — the positional handle is unchanged and still
 * correct, but "last of several" is now "the only one". So: the last direct
 * `div` child of the bar, and the last `button` in it. The same
 * positional handle `mobile-nav-tap-target.mobile.spec.ts` uses, for the same
 * reason it uses it.
 *
 * ── The bar is `role="banner"`, NOT `locator('header')` ─────────────────────
 *
 * Measured, after a first draft using `header > div` failed in a way worth
 * recording. `/dashboard` renders **two** `<header>` elements: `TopBar`'s, and
 * one inside `<main>` belonging to the page content — and the second one mounts
 * LATER, once the route's data resolves. So `page.locator('header > div')`
 * matched 3 divs whose membership CHANGED mid-test: `.last()` was the wallet
 * region while the page was still loading, and the content header's div a
 * moment later. The accessible-name assertion passed against the real control
 * and the very next read found nothing, which reads like a detached-element
 * flake and is actually a locator that silently moved.
 *
 * `role="banner"` is the fix and not merely a workaround: a `<header>` scoped
 * inside sectioning content is NOT a banner, so exactly one node in this page
 * carries the role — the app bar. Measured at count 1 while both headers were
 * mounted. It is also semantic contract rather than a class string, which is
 * the handle `focus-visible.visual.spec.ts` and #1811/#1820 argue for.
 *
 * **A trap for whoever reuses this after a CLICK** (independent review): the
 * `.last()` holds only while the popover is closed. `WalletPopover` renders
 * inside the same `div.relative` as the trigger and carries Copy / Switch /
 * Disconnect buttons, so opening it moves `.last()` off the trigger. Every test
 * in this file captures a RESTING state and never clicks, and `popoverOpen`
 * defaults to `false`, so nothing here is exposed — but a spec that drives the
 * popover open needs a different handle, not this one with a longer wait.
 */
function walletControl(page: Page): Locator {
  return page.getByRole('banner').locator('> div').last().locator('button').last()
}

/**
 * What the control is made of — read once, in one `evaluate`, so every
 * discriminator describes the SAME render.
 */
interface ControlShape {
  /** Painted box, rounded. */
  box: { w: number; h: number }
  /** `svg` descendants — the icon fork's marker. */
  icons: number
  /** `span[aria-hidden]` descendants painting a gradient — the avatar fork's. */
  gradientAvatars: number
  /** Computed background of the button itself. */
  background: string
  /** `--v2-danger-soft`, resolved on this element, for tone comparison. */
  dangerSoft: string
  /** Every `span` child and whether the engine is actually hiding it. */
  spans: Array<{ text: string; display: string }>
}

async function readControl(control: Locator): Promise<ControlShape> {
  return control.evaluate((el) => {
    // Resolve the token through a transient probe rather than string-comparing
    // a var() — the same technique #1924 used, and for the same reason: a class
    // string reads identically whether it compiled to a colour or to nothing
    // (#1818). Appended, measured and removed SYNCHRONOUSLY inside this
    // evaluate so the probe can never be mounted during a capture.
    const resolve = (token: string) => {
      const raw = getComputedStyle(el).getPropertyValue(token).trim()
      if (!raw) return ''
      const probe = document.createElement('div')
      probe.style.backgroundColor = raw
      el.appendChild(probe)
      const resolved = getComputedStyle(probe).backgroundColor
      probe.remove()
      return resolved
    }
    const rect = el.getBoundingClientRect()
    return {
      box: { w: Math.round(rect.width), h: Math.round(rect.height) },
      icons: el.querySelectorAll('svg').length,
      gradientAvatars: Array.from(el.querySelectorAll('span[aria-hidden]')).filter((span) =>
        getComputedStyle(span).backgroundImage.includes('gradient'),
      ).length,
      background: getComputedStyle(el).backgroundColor,
      dangerSoft: resolve('--v2-danger-soft'),
      spans: Array.from(el.querySelectorAll('span')).map((span) => ({
        text: span.textContent?.trim() ?? '',
        display: getComputedStyle(span).display,
      })),
    }
  })
}

/**
 * Assert the branch, the collapse and the tone — then, and only then, capture.
 *
 * Every claim here is about the render, never about the fixture. Seeding a
 * chain id proves nothing about which of five structurally similar branches
 * ran (#1873), and four of the five would photograph as a plausible 40px
 * square.
 */
async function expectCollapsedState(
  page: Page,
  expected: {
    label: string
    fork: 'avatar' | 'icon'
    tone: 'plain' | 'danger'
  },
  context: string,
): Promise<Locator> {
  // The bar itself, FIRST, as its own assertion with its own sentence.
  //
  // Not ceremony: the draft this replaced located the bar as `header`, of which
  // this page has two (see `walletControl`). Pinning the count is what turns
  // "the bar moved" into a one-line diagnosis instead of a downstream read that
  // finds nothing and reports a detached element.
  await expect(
    page.getByRole('banner'),
    `${context}: expected exactly one role="banner" — the app bar. A second one ` +
      `means a page-content <header> escaped its sectioning ancestor, and every ` +
      `positional read below this line would be measuring the wrong element.`,
  ).toHaveCount(1)

  const control = walletControl(page)
  await expect(
    control,
    `${context}: no wallet control at the end of the bar's right region. ` +
      `TopBar renders WalletButton at the end of that region; a count of 0 ` +
      `means the region moved, not that a branch chose wrong.`,
  ).toHaveCount(1)

  // 1. The ACCESSIBLE NAME, computed by the engine.
  //
  // This is the assertion `WalletButton.test.tsx` structurally cannot make and
  // says so in its own header: jsdom applies no CSS, so a label hidden by
  // `hidden sm:inline` still contributes there and the unit test would keep
  // passing on the visible text alone. In a real engine `display: none` drops
  // the label from the accessible name entirely, so this is the only place the
  // #1803 collapse's first invariant — "an icon-only button must not announce
  // as 'button'" — is proven where the CSS is real.
  //
  // ── What it does NOT prove, measured rather than reasoned ─────────────────
  //
  // It does not prove the name comes from `aria-label` SPECIFICALLY. Deleting
  // `aria-label={walletLabel}` from the connected branch and rerunning this file
  // produced ZERO reds: the sibling `title={walletLabel}` is a name-from-author
  // fallback in the accessible-name computation, so it SHADOWS that mutation.
  // Recorded rather than engineered away, because the shadow is the PRODUCT's
  // design — `WalletButton.tsx`'s own note ships both deliberately, the `title`
  // being the pointer-hover half of the same mitigation. What this assertion is
  // under contract to check is that the collapsed control still HAS a name, by
  // whichever of the two survives; deleting both turns it red with the sentence
  // below. The attribute-level claim belongs to `WalletButton.test.tsx`, and the
  // two together are complete in a way neither is alone.
  await expect(
    control,
    `${context}: the collapsed control does not announce as "${expected.label}". ` +
      `Below sm the visible label is display:none, so the name has to come from ` +
      `aria-label or title — this is the #1803 invariant that no jsdom test can see.`,
  ).toHaveAccessibleName(expected.label)

  const shape = await readControl(control)

  // 2. The COLLAPSE IS APPLIED, in the engine, not merely at a narrow width.
  //
  // Independent of (1): a regression that dropped `hidden sm:inline` would keep
  // the accessible name correct and render a labelled pill, which is a
  // different control from the one these baselines are of.
  const visibleSpans = shape.spans.filter((s) => s.display !== 'none' && s.text.length > 0)
  expect(
    visibleSpans,
    `${context}: a text span is still PAINTED at ${MOBILE?.width}px — the label did not ` +
      `collapse. LABEL_BELOW_SM ("hidden sm:inline") is what drops it; a control that ` +
      `keeps its label here is not the state these baselines photograph.`,
  ).toEqual([])

  // 3. The BRANCH, by its child fork — counted BOTH ways.
  //
  // #1984's rule: a guard against a fork must name its branch. Asserting "there
  // is an avatar" would be satisfied by both passkey branches; asserting "there
  // is no icon" too. The pair, together with (1) and (4), is satisfied by
  // exactly one branch.
  const forkExpectation =
    expected.fork === 'avatar'
      ? { gradientAvatars: 1, icons: 0 }
      : { gradientAvatars: 0, icons: 1 }
  expect(
    { gradientAvatars: shape.gradientAvatars, icons: shape.icons },
    `${context}: this is not the ${expected.fork} fork. An AddressAvatar is a ` +
      `span[aria-hidden] painting a gradient; the Connect-wallet and Wrong-network ` +
      `branches render a lucide svg instead. Getting this wrong photographs as a ` +
      `perfectly plausible 40px square.`,
  ).toEqual(forkExpectation)

  // 4. The TONE, as a resolved colour rather than a class string.
  //
  // The only discriminator that separates "Wrong network" from "Connect
  // wallet": both are icon forks, both are 40px squares, and both carry an
  // explicit aria-label. The danger-soft fill is what says the product is
  // warning rather than inviting.
  expect(
    shape.dangerSoft,
    `${context}: --v2-danger-soft did not resolve on this control — the token moved`,
  ).not.toBe('')
  if (expected.tone === 'danger') {
    expect(
      shape.background,
      `${context}: the control is not painted --v2-danger-soft (${shape.background} vs ` +
        `${shape.dangerSoft}). Without this, this capture is indistinguishable from the ` +
        `Connect-wallet branch, which is also an icon in a 40px square.`,
    ).toBe(shape.dangerSoft)
  } else {
    expect(
      shape.background,
      `${context}: the control is painted the danger tone but this branch is not a warning`,
    ).not.toBe(shape.dangerSoft)
  }

  // 5. The 40px SQUARE — the bell's own box, which is what keeps the bar a row
  //    rather than a set of differently-sized squares (#1803).
  expect(
    shape.box,
    `${context}: the collapsed control is ${shape.box.w}x${shape.box.h}, not ` +
      `${COLLAPSED_BOX_PX}x${COLLAPSED_BOX_PX}`,
  ).toEqual({ w: COLLAPSED_BOX_PX, h: COLLAPSED_BOX_PX })

  // 6. NO OTHER wallet state is on screen beside this one.
  //
  // The exact-set form #1873 argued for, in its negative half: a positive-only
  // assertion passes just as happily when a second control renders next to the
  // right one, and the capture — scoped to one button — would look clean.
  const strayStates = await page
    .getByRole('banner')
    .getByRole('button')
    .evaluateAll(
      (els, names) =>
        els
          .map((el) => el.getAttribute('aria-label') ?? '')
          .filter((name) => (names as string[]).includes(name)),
      OTHER_STATE_NAMES as unknown as string[],
    )
  const expectedStrays = (OTHER_STATE_NAMES as readonly string[]).includes(expected.label)
    ? [expected.label]
    : []
  expect(
    strayStates,
    `${context}: the app bar carries wallet controls for other states as well. ` +
      `WalletButton returns exactly one rendering; more than one means a branch ` +
      `stopped being exclusive.`,
  ).toEqual(expectedStrays)

  return control
}

/**
 * Load an authenticated route at the mobile evidence viewport and wait for the
 * bar to settle — deliberately NOT via `waitForLoadState('networkidle')`.
 *
 * Measured, not preferred, and #1924 measured it first: under `next dev` this
 * page never reaches network idle, because wagmi/WalletConnect hold long-lived
 * connections open and Reown re-polls its remote config, so the 500ms-quiet
 * window never arrives and the wait burns the whole test timeout. It is also
 * the wrong QUESTION — what a capture needs is that its subject has rendered
 * and stopped moving.
 *
 * So the settle condition is the SUBJECT's own: `expectCollapsedState`'s first
 * assertion is a retrying `toHaveAccessibleName`, and the control cannot carry
 * the connected branch's name until wagmi's mount-time `reconnect()` has
 * adopted the injected provider. The data load is therefore waited on by the
 * thing that depends on it. Fonts are waited on here because they are genuinely
 * page-global and they move glyph metrics inside the capture.
 *
 * `/dashboard` specifically: it is the route #1803 measured the whole defect on,
 * so a regression here is comparable against those numbers rather than against
 * a different page's bar.
 */
async function gotoCollapsed(page: Page, path: string) {
  if (!MOBILE) {
    throw new Error(
      `visual gate: evidence-viewports.mjs carries no viewport below the sm ` +
        `breakpoint (${SM_BREAKPOINT_PX}px), so the collapsed rendering cannot be ` +
        `captured at a committed width`,
    )
  }
  await page.setViewportSize({ width: MOBILE.width, height: MOBILE.height })
  await page.goto(path)
  await page.evaluate(() => document.fonts.ready)
}

test.describe('WalletButton collapsed states', () => {
  test.skip(
    process.env.VISUAL_REGRESSION !== '1',
    'Linux-rendered baselines — run via the CI job (or VISUAL_REGRESSION=1 in a Linux container)',
  )

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('connected wallet renders its address avatar, collapsed', async ({ page }) => {
    await installInjectedWallet(page, { chainIdHex: SUPPORTED_CHAIN_ID_HEX })
    await gotoCollapsed(page, '/dashboard')

    // The truncated address is pinned as a LITERAL rather than derived from
    // `truncateAddress`. Deriving it would make the assertion agree with the
    // product by construction; pinning it means a change to how Haven shortens
    // an address surfaces here, which is a change worth seeing.
    // Scope limit, stated locally rather than only in `OTHER_STATE_NAMES`'s
    // docstring (independent review): assertion 6 is INERT for this test. The
    // closed vocabulary deliberately omits the two data-dependent names, so a
    // second copy of THIS control rendering beside the first would be caught by
    // nothing here — `walletControl`'s `.last()` narrows to one element by
    // construction, so the count guard cannot see it either. That is a narrower
    // hole than #1984's, which was wrong-BRANCH contamination and is excluded
    // jointly by assertions (1), (3) and (4); it is recorded rather than papered
    // over, because an assertion that cannot fire for a given test should say so
    // at the test, not only where it is defined.
    const control = await expectCollapsedState(
      page,
      { label: connectedWalletShortName, fork: 'avatar', tone: 'plain' },
      'WalletButton · connected avatar @ collapsed',
    )

    await expect(control).toHaveScreenshot(
      'walletbutton-connected-avatar-collapsed.png',
      SNAPSHOT_OPTIONS,
    )
  })

  test('a wallet on an unsupported chain renders the wrong-network state, collapsed', async ({
    page,
  }) => {
    await installInjectedWallet(page, { chainIdHex: UNSUPPORTED_CHAIN_ID_HEX })
    await gotoCollapsed(page, '/dashboard')

    const control = await expectCollapsedState(
      page,
      { label: 'Wrong network', fork: 'icon', tone: 'danger' },
      'WalletButton · wrong network @ collapsed',
    )

    await expect(control).toHaveScreenshot(
      'walletbutton-wrong-network-collapsed.png',
      SNAPSHOT_OPTIONS,
    )
  })

  /**
   * The CONTROL for the two above, and deliberately NOT captured.
   *
   * "Connect wallet" is already under the #1803 e2e assertions and is the state
   * the harness renders when the injected fixture does NOT take — which is
   * exactly the silent failure this file has to be able to distinguish from a
   * pass. Without this test, a fixture that stopped working would turn both
   * captures red with "wrong accessible name" and leave open whether the app or
   * the fixture moved; with it, the answer is one line.
   *
   * No `toHaveScreenshot`: it would be a third baseline of an already-covered
   * state, and its only effect would be to widen the blast radius of any
   * mutation to `COLLAPSE_BELOW_SM` from two captures to three.
   */
  test('without a wallet the control is the Connect-wallet state — fixture control', async ({
    page,
  }) => {
    await gotoCollapsed(page, '/dashboard')

    await expectCollapsedState(
      page,
      { label: 'Connect wallet', fork: 'icon', tone: 'plain' },
      'WalletButton · not connected @ collapsed (control)',
    )
  })
})
