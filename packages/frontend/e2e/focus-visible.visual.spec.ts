/**
 * Driven focus-state visual regression (#1863) — the DRIVEN half of the visual
 * gate, following #1820/PR #1861's resting-state half.
 *
 * BASELINES ARE LINUX-RENDERED, exactly as `design-system.visual.spec.ts`'s
 * are, and for the same reason: CI is the judge and macOS font rendering
 * differs. Skipped locally unless VISUAL_REGRESSION=1. Regenerate via the
 * **Update visual baselines** workflow on the branch — see
 * docs/contributing/ship-playbooks/frontend.md §4.
 *
 * ── Why a second visual spec rather than more pixels in the first ────────────
 *
 * #1820 closed a SCOPE gap: the sidebar was a surface the gate could not see.
 * A wider region fixed it. This closes a STATE gap, and a wider region
 * structurally cannot fix it — **a focus ring only exists while something is
 * focused**, and nothing is focused in a screenshot. #1861 said so in its own
 * spec and in the playbook precisely so that "there is a sidebar capture now"
 * would not be read as "the sidebar is covered"; this file is where that
 * sentence points.
 *
 * The eleven indicators are PR #1831's, on `Sidebar`'s kebab user menu and
 * `AgentCard`'s footer action row. Until this file they were protected by a
 * STRUCTURAL guard (`src/__tests__/focus-ring.test.ts`, which reads class
 * strings out of source) and by nothing rendered. A ring that compiles to the
 * wrong colour, is occluded, or sits behind an overlay passed every gate we
 * had — and `AgentCard`'s Revoke and `Sidebar`'s Log out are among the covered
 * controls, so the WCAG 2.4.7 failure being guarded lands on destructive
 * actions rather than cosmetic ones.
 *
 * ── Granularity: one test per control, one capture per test ──────────────────
 *
 * The issue asks this to be decided rather than assumed, and the first thing to
 * say is that half the usual trade-off is not available here. **Focus is
 * singular** — one element at a time — so "one composite capture with several
 * controls focused" cannot be built at all. N indicators need N drives no
 * matter what. The real lever is how wide each capture is, and this file takes
 * the tight one, following #1811/#1820's scoped-region precedent: the 176x117
 * popover, and the 438x37 card action row. A ring recoloured on Revoke reddens
 * `…-revoke-…` and nothing else.
 *
 * **One Playwright `test()` per control is load-bearing, not tidiness.** Six
 * `toHaveScreenshot` calls in one test would short-circuit at the first
 * failure, so a mutation removing the Log out ring would redden capture 3 and
 * never RUN captures 4-6 — and the run would report one failure where the truth
 * might be one or four. That is the masking shape #1820 had to spend a whole
 * extra CI job on: its scoped assertion preceded the whole-page one, so its
 * counterfactual could not be read off the scoped number and needed its own
 * run. Separate tests make every capture's verdict independent and make a
 * mutation's blast radius a measurement instead of an inference.
 *
 * ── Which of the eleven this file reaches, and which it does not ─────────────
 *
 * Six of eleven, and the gap is a rendering-branch fact rather than a choice:
 *
 *   Sidebar kebab popover   Profile · Settings · Log out          3/3  captured
 *   AgentCard action row    Edit · Pause · Revoke                 3/8  captured
 *
 * `AgentCard`'s footer NEVER renders all eight at once — `isOperational`,
 * `isRevoked` and `isArchived` are mutually exclusive, and `canUseWalletActions`
 * / `isDelegationAgent` split the operational branch further (the design pass on
 * #1831 made the same correction to that PR's "eight rings in one row"
 * framing). Against the shared `mockHavenApi` fixture's one active legacy agent
 * exactly three render, and they include **Revoke**, the destructive one.
 *
 * The five not reached — Details (`canUseWalletActions: false`), Resume
 * (paused), Remove (delegation), Remove (revoked), Restore (archived, behind
 * the "Removed" disclosure) — carry class strings BYTE-IDENTICAL to a captured
 * sibling: all five are one of the two strings `ring-brand/80` or
 * `ring-danger/80` on a `text-xs` link in this same row on this same surface.
 * State that as the limit it is, not as coverage: **"the same class string
 * therefore the same pixels" is an argument, not a measurement**, and this repo
 * keeps re-learning that those differ. Reaching them means seeding four more
 * synthetic agent states, which puts the fixture under test rather than the
 * component. Filed as its own issue rather than smuggled in here.
 *
 * ── Tab traversal, and why the count is never hard-coded ─────────────────────
 *
 * The driver is real keyboard `Tab`, because that is the path the user whose
 * bug this is actually takes. **All six controls are reachable by traversal**,
 * so the `.focus()` fallback the issue allows was never needed and nothing is
 * silently substituted. A control reachable by script and not by tab order
 * would itself be a WCAG 2.4.3 finding, so the two are not interchangeable.
 *
 * `.focus()` was measured side by side on the three popover items (it lands on
 * the same nodes, and `:focus-visible` matched there too) — but do not read
 * that as "the two are equivalent". `:focus-visible` is decided by the last
 * INPUT MODALITY, and in that probe the modality was already keyboard because
 * tabbing is how the menu had been opened. Call `.focus()` after a mouse
 * interaction and the same element can take focus with no ring at all — at
 * which point the capture silently becomes a resting-state one. That is the
 * failure this whole file exists to catch, so the substitution is the one
 * shortcut that would quietly undo it.
 *
 * `tabToTarget` presses Tab until `document.activeElement` IS the target node,
 * bounded, and throws naming the control if it never arrives. It does NOT press
 * Tab a fixed number of times, and that is measured rather than defensive:
 * under `next dev` the tab order begins with three `NEXTJS-PORTAL` devtools
 * nodes that do not exist in CI's standalone production build. A hard-coded
 * count would be off by three between the two environments — green locally and
 * focused on the wrong control in CI, which is the "confidently wrong evidence"
 * failure #1800 exists for.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, testAgent } from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports, shared with
// the screenshot script and the resting-state pixel gate so all three render at
// the same widths.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{
  name: string
  width: number
  height: number
}>

/**
 * Desktop only, and for the SAME measured reason #1820's sidebar capture is:
 * below `lg` the sidebar is an off-canvas drawer (`position: fixed`,
 * `translateX(-240px)`, bounding rect `x: -240, right: 0`), so its kebab and
 * popover are not on screen at all. `AgentCard`'s action row does render at
 * 390px, but it wraps differently there and deserves its own measured spec
 * rather than a desktop proof reused at a width it was not taken at — that is
 * #1797's rule, and this file honours it by not claiming mobile.
 *
 * Keyed on the viewport WIDTH, not on `vp.name === 'desktop'`, so a viewport
 * added to `evidence-viewports.mjs` later is included or excluded by what it
 * actually renders rather than by what it is called.
 */
const DESKTOP_MIN_VIEWPORT_WIDTH = 1024
const DESKTOP = VIEWPORTS.find((vp) => vp.width >= DESKTOP_MIN_VIEWPORT_WIDTH)

/**
 * The `Sidebar` kebab popover, located by its ARIA contract rather than by a
 * class string — the same rule #1811/#1820 followed with their xpaths, for the
 * same reason: **a class string is the thing this gate is under contract to
 * check, so it must not also be the thing the gate trusts to find its
 * subject.** `role="menu"` + its accessible name is semantic contract, and
 * `Sidebar.tsx` is the only place in the app that renders one under this name.
 *
 * `toHaveCount(1)` closes "matches nothing" and "matches several". Read what it
 * does NOT close, the way #1820 had to: it cannot tell a plausible-but-wrong
 * element from the right one. The backstop is the baseline — a different
 * element will not match a 176x117 render of this popover — but it would fail
 * as "the popover drifted" rather than as "the locator moved".
 */
const USER_MENU_POPOVER = '[role="menu"][aria-label="User menu"]'
const USER_MENU_TRIGGER = 'button[aria-label="User menu"]'

/**
 * ── The budget ───────────────────────────────────────────────────────────────
 *
 * PLACEHOLDER — measured, not chosen, using #1811's and #1820's method:
 * committed at `0`, pushed, and the real count read off what CI does with it,
 * against baselines generated in a DIFFERENT run. Replaced with the measured
 * number before this PR is ready; if you are reading `0` on a merged commit,
 * that is the bug #1820's design pass caught in itself.
 */
const FOCUS_MAX_DIFF_PIXELS = 0

/**
 * Inherited from #1805, and it is doing more work here than the budget is.
 * `threshold` is pixelmatch's PER-PIXEL colour tolerance; Playwright's default
 * of 0.2 means a pixel counts as different only past a YIQ delta of 1,408.6,
 * and a focus ring recoloured within our own palette does not come close — the
 * #1820 mutation measured 69.7. **At the default threshold this entire class of
 * change counts ZERO differing pixels, so no budget of any size would catch
 * it.** The budget is not the dial.
 */
const PIXEL_THRESHOLD = 0.02

const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: FOCUS_MAX_DIFF_PIXELS,
  threshold: PIXEL_THRESHOLD,
} as const

/**
 * Press Tab until `document.activeElement` is exactly `target`, and return how
 * many presses it took. Throws naming the control if it never arrives — which
 * is the assertion that keeps the capture honest, because a driver that
 * silently focuses nothing would produce a RESTING-state baseline and this gate
 * would then be green forever about the exact thing it exists to see. That is
 * this issue's own failure mode, one level up.
 *
 * Node identity (`document.activeElement === el`), never a text or class match:
 * two controls in this row share a label prefix, and matching by appearance is
 * the mistake this whole file is about.
 */
async function tabToTarget(page: Page, target: Locator, label: string, max = 80) {
  const handle = await target.elementHandle()
  if (!handle) throw new Error(`focus gate: "${label}" is not attached — nothing to tab to`)
  for (let presses = 1; presses <= max; presses++) {
    await page.keyboard.press('Tab')
    if (await page.evaluate((el) => document.activeElement === el, handle)) return presses
  }
  throw new Error(
    `focus gate: "${label}" was NOT reachable by keyboard Tab within ${max} presses. ` +
      `Do not "fix" this by substituting .focus() — a control reachable by script and ` +
      `not by tab order is a WCAG 2.4.3 finding in its own right, and swapping the ` +
      `driver would hide it. See this spec's header.`,
  )
}

/**
 * Does this CSS value paint anything at all, or is every colour in it
 * transparent?
 *
 * This function exists because the obvious version of the check below was
 * wrong, and the mutation is what said so rather than the reading. The first
 * draft asked only whether the computed `outline` was `none` with a non-zero
 * width. **Tailwind's `outline-none` is not `outline-style: none`** — it
 * compiles to `outline: 2px solid transparent` (deliberately, so a
 * forced-colors user still gets a ring). So under the removal mutation the
 * measured computed style was:
 *
 *   box-shadow: none · outline-style: solid · outline-width: 2px
 *   outline-color: rgba(0, 0, 0, 0)
 *
 * — and the draft check read "solid, 2px" and called it an indicator. It would
 * have passed a control with **no visible focus indicator whatsoever**, which
 * is the exact WCAG 2.4.7 failure this file is here to catch.
 *
 * That is the same shape as the hole #1831's own guard documented in itself
 * (it accepts a `focus-visible:bg-` that is identical to the surface behind
 * it), and it was found the same way: by a mutation that was SUPPOSED to turn
 * this assertion red and did not. A guard cannot be trusted because it passes.
 */
function paintsSomething(css: string) {
  const colours = css.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/gi) ?? []
  if (colours.length === 0) return false
  return colours.some((token) => {
    if (/^transparent$/i.test(token)) return false
    const rgba = /rgba\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+\s*[,/]\s*([\d.]+)\s*\)/i.exec(token)
    if (rgba) return Number(rgba[1]) > 0
    const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(token)
    if (hex) return parseInt(hex[1].slice(-2).padStart(2, 'f'), 16) > 0
    return true // rgb(...) or a 3/6-digit hex — no alpha channel, so opaque
  })
}

/**
 * The capture is only worth anything if the control is genuinely in the state
 * the baseline claims, so assert that structurally BEFORE the pixels.
 *
 * Three separate things, and they fail for different reasons:
 *
 *  - focus actually landed on this node;
 *  - `:focus-visible` matches — the ring's own CSS condition. Focus alone is not
 *    enough; `:focus-visible` is what all eleven indicators are gated on;
 *  - the computed style PAINTS something — i.e. the class string compiled to a
 *    visible indicator rather than merely being present in source. This is the
 *    gap the structural guard cannot see at all: `focus-ring.test.ts` reads
 *    source text, so a Tailwind class that resolves to nothing at build time
 *    reads exactly like one that works. Not hypothetical — #1818 is that
 *    defect, and it is what made #1811's first mutation inert.
 *
 * **This assertion precedes the screenshot, so it MASKS it.** A mutation that
 * removes an indicator outright stops here and the capture never runs, which
 * means the pixel half cannot be proven from this run — the same short-circuit
 * #1820 had to spend a separate CI job on. It is proven separately, by
 * re-running the same mutation with this assertion disabled; the numbers are in
 * the PR body. Ordering it this way is deliberate even so: "the ring is gone"
 * is a better failure message than a pixel diff, and a capture taken after a
 * failed drive is evidence of nothing.
 */
async function expectFocusedAndIndicated(page: Page, target: Locator, label: string) {
  const state = await target.evaluate((el) => {
    const s = getComputedStyle(el)
    return {
      isActive: document.activeElement === el,
      focusVisible: el.matches(':focus-visible'),
      boxShadow: s.boxShadow,
      outlineStyle: s.outlineStyle,
      outlineWidth: s.outlineWidth,
      outlineColor: s.outlineColor,
    }
  })
  expect(state.isActive, `${label}: expected it to hold focus`).toBe(true)
  expect(state.focusVisible, `${label}: focus landed but :focus-visible did not match`).toBe(true)

  const ring = state.boxShadow !== 'none' && paintsSomething(state.boxShadow)
  const outline =
    state.outlineStyle !== 'none' &&
    parseFloat(state.outlineWidth) > 0 &&
    paintsSomething(state.outlineColor)
  expect(
    ring || outline,
    `${label}: focused and :focus-visible, but the computed style paints NO VISIBLE ` +
      `indicator — box-shadow: ${state.boxShadow}; outline: ${state.outlineStyle} ` +
      `${state.outlineWidth} ${state.outlineColor}. Note that a "solid 2px" outline is ` +
      `NOT reassurance on its own: Tailwind's own \`outline-none\` compiles to exactly ` +
      `that, fully transparent. The class string can be present in source and still ` +
      `paint nothing (#1818).`,
  ).toBe(true)
}

/**
 * Open the kebab popover with the KEYBOARD, and pin what that does to focus.
 *
 * `Sidebar` moves focus to the first menu item on open — deliberately, and it
 * is the reason #1831 called this widget the worst of its four cases: focus was
 * being placed, on purpose, on an element with nothing to show for it. So the
 * auto-focus is asserted here rather than tabbed past: if it ever stops
 * happening, every downstream tab count in this file shifts by one and the
 * captures would silently move to the wrong controls.
 */
async function openUserMenuByKeyboard(page: Page) {
  const trigger = page.locator(USER_MENU_TRIGGER)
  await expect(trigger).toHaveCount(1)
  await tabToTarget(page, trigger, 'Sidebar kebab trigger')
  await page.keyboard.press('Enter')

  const popover = page.locator(USER_MENU_POPOVER)
  await expect(popover).toHaveCount(1)
  await expect(popover).toBeVisible()

  const profile = popover.getByRole('menuitem', { name: 'Profile' })
  await expect(
    profile,
    'Sidebar auto-focuses its first menu item on open (#1831) — that stopped being true',
  ).toBeFocused()
  return popover
}

async function gotoDesktop(page: Page, path: string) {
  if (!DESKTOP) throw new Error('focus gate: no viewport at or above the desktop breakpoint')
  await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height })
  await page.goto(path)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForLoadState('networkidle')
}

test.describe('driven focus-state visual regression', () => {
  test.skip(
    process.env.VISUAL_REGRESSION !== '1',
    'Linux-rendered baselines — run via the CI job (or VISUAL_REGRESSION=1 in a Linux container)',
  )

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  // ── Sidebar kebab user menu — 3 of #1831's 11 ─────────────────────────────
  //
  // Captured on `/design-system` rather than on `/agents`, so the sidebar's
  // pixel evidence stays on one route — the same route #1820's resting-state
  // sidebar capture uses. The popover contains no nav item, so the route's
  // active-nav highlight cannot leak into these baselines either way.
  const menuItems = [
    { slug: 'profile', name: 'Profile', tone: 'brand' },
    { slug: 'settings', name: 'Settings', tone: 'brand' },
    { slug: 'logout', name: 'Log out', tone: 'danger' },
  ] as const

  for (const item of menuItems) {
    test(`sidebar user menu — ${item.name} focus indicator (${item.tone})`, async ({ page }) => {
      await gotoDesktop(page, '/design-system')
      const popover = await openUserMenuByKeyboard(page)

      const target = popover.getByRole('menuitem', { name: item.name })
      await expect(target).toHaveCount(1)
      // Profile already holds focus from the open; the other two are tabbed to
      // from wherever the previous step left off, which is the real traversal.
      if (item.slug !== 'profile') {
        await tabToTarget(page, target, `Sidebar user menu · ${item.name}`)
      }
      await expectFocusedAndIndicated(page, target, `Sidebar user menu · ${item.name}`)

      // The POPOVER is the region, not the item: `ring-inset` paints against
      // the popover's own edge and shadow, and whether those are
      // distinguishable was the residual the #1831 design pass could not close
      // for want of pixels. An item-sized capture would crop away the exact
      // question.
      await expect(popover).toHaveScreenshot(
        `focus-sidebar-menu-${item.slug}-desktop.png`,
        SNAPSHOT_OPTIONS,
      )
    })
  }

  // ── AgentCard action row — 3 of #1831's 11 ────────────────────────────────
  //
  // On `/agents`, because `AgentCard` renders nowhere else — it is NOT on
  // `/design-system`, which is why the blocking visual gate has never seen it
  // in any state, resting included. #1831 said so; this closes the focus half
  // only, and the resting half is filed separately.
  const rowControls = [
    { slug: 'edit', label: 'Edit', tone: 'brand' },
    { slug: 'pause', label: 'Pause', tone: 'brand' },
    { slug: 'revoke', label: 'Revoke', tone: 'danger' },
  ] as const

  for (const control of rowControls) {
    test(`agent card action row — ${control.label} focus indicator (${control.tone})`, async ({ page }) => {
      await gotoDesktop(page, '/agents')

      const target = page.locator(`button[aria-label="${control.label} ${testAgent.name}"]`)
      await expect(target).toHaveCount(1)
      await expect(target).toBeVisible()

      // The action row, located as the control's own parent rather than by its
      // class string — same rule as the popover above. Asserting the count
      // keeps "the row moved" from silently becoming "some other div".
      const actionRow = target.locator('xpath=..')
      await expect(actionRow).toHaveCount(1)

      await tabToTarget(page, target, `AgentCard action row · ${control.label}`)
      await expectFocusedAndIndicated(page, target, `AgentCard action row · ${control.label}`)

      // The ROW, not the control: these rings are `ring-2` with no offset on a
      // 16px-tall inline link, so ~2px of every ring falls outside the
      // control's own box. A control-sized capture would clip the indicator it
      // exists to photograph. The row also holds the neighbouring controls, so
      // a ring bleeding into its neighbour is visible here and would not be in
      // a tighter crop.
      await expect(actionRow).toHaveScreenshot(
        `focus-agentcard-actions-${control.slug}-desktop.png`,
        SNAPSHOT_OPTIONS,
      )
    })
  }
})
