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
 * the tight one, following #1811/#1820's scoped-region precedent: the 176x118
 * popover, and the 438x41 card action row. A ring recoloured on Revoke reddens
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
 * ── Which of the eleven this file reaches (#1873: all eleven) ────────────────
 *
 * #1863 reached six, and said why the other five were out of reach:
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
 * So this was never a scoping choice: reaching the other five is FIXTURE work,
 * not capture work. #1873 does it, and the eleven are now eleven.
 *
 *   control              needs                                    rendered by
 *   Details              canUseWalletActions === false            a different safe_id
 *   Resume from pause    status: 'paused'                         the paused branch
 *   Remove (delegation)  account_type: 'delegator_hybrid', active the isDelegationAgent branch
 *   Remove (revoked)     status: 'revoked', not archived          the isRevoked branch
 *   Restore to list      archived_at set                          the isArchived branch
 *
 * **The argument for NOT doing this was real, and it is the reason each of the
 * five is proven separately below.** All five carry class strings
 * BYTE-IDENTICAL to a captured sibling — every one is `ring-brand/80` or
 * `ring-danger/80` on a `text-xs` link, in this same row, on this same surface
 * — so the marginal *rendered* information looked small. But "the same class
 * string therefore the same pixels" is an argument, not a measurement, and this
 * repo keeps paying the difference: #1818 is a class string that compiled to
 * nothing, and this file's own first-draft assertion accepted `outline: 2px
 * solid transparent` as an indicator. A capture nobody can redden is decoration;
 * each of the five below has a mutation naming it and only it (see the PR body).
 *
 * ── Where the four synthetic states live, and why it matters ─────────────────
 *
 * In THIS FILE's own route override (`seedAgents` below), never in the shared
 * `mockHavenApi` fixture. Measured rather than assumed: **twelve other specs
 * call `mockHavenApi`** — including `design-system.visual.spec.ts`, the
 * resting-state half of this same pixel gate — and **four of them navigate to
 * `/agents`** (`connect-agent`, `hosted-mcp`, `navigation.mobile`,
 * `mobile-nav-layering.mobile`). Adding a paused, revoked, delegation and
 * archived agent to the shared fixture changes the payload all twelve receive
 * and the rendered output of those four, none of which is about focus. The
 * override is registered per test, AFTER `mockHavenApi`, so Playwright matches
 * it first, and it defers to the shared fixture for every other route via
 * `route.fallback()`.
 *
 * (`scripts/screenshot.mjs` — the #896 evidence capture the design review
 * reads — is a THIRD fixture, `FIXTURE_AGENTS`, and is untouched by either
 * choice. Worth knowing before assuming the two are the same seam.)
 *
 * Each test seeds exactly the ONE agent it needs. The alternative — one page
 * holding all five states — was rejected because it couples the five captures
 * to each other: a layout change in the archived card could reflow the grid and
 * redden the delegation capture, which is precisely the blast-radius blur that
 * "one `test()` per control" exists to remove.
 *
 * **Seeding a state is not the same as rendering the branch**, so every test
 * asserts the row's FULL control set before it captures (`expectRowControls`).
 * `status: 'paused'` reaching the API mock proves nothing about which of
 * `AgentCard`'s five footer branches ran; "this row holds exactly Edit, Resume
 * from pause, Revoke" does. It is also what turns a future branch edit into a
 * named failure instead of a silently re-pointed baseline.
 *
 * ── Tab traversal, and why the count is never hard-coded ─────────────────────
 *
 * The driver is real keyboard `Tab`, because that is the path the user whose
 * bug this is actually takes. **All eleven controls are reachable by
 * traversal**, so the `.focus()` fallback the issue allows is never used and
 * nothing is silently substituted. A control reachable by script and not by tab
 * order would itself be a WCAG 2.4.3 finding, so the two are not
 * interchangeable.
 *
 * That rule decides the one case where it was tempting to break it. **Restore
 * sits behind the "Removed (n)" disclosure**, so something has to open it
 * first, and the obvious move is `.click()`. It is opened with Tab + Enter
 * instead, and this is not ceremony: `:focus-visible` is decided by the last
 * input MODALITY, so a mouse click anywhere in the run switches the document to
 * pointer modality, and a `.focus()` after it takes focus with NO ring at all.
 * The capture would silently become a resting-state one — this file's own
 * failure mode, arrived at by the back door. Tab + Enter keeps the modality
 * keyboard end to end, and the `:focus-visible` assertion in
 * `expectFocusedAndIndicated` is what would catch it if that ever stopped being
 * true.
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
 * #1873 put a NUMBER on "wraps differently" rather than leaving it an
 * adjective, because four of the five branches it adds had never been measured
 * at any width. Live `boundingBox()` of each action row, against the height of
 * the baseline CI actually committed:
 *
 * These are the numbers AS #1873 MEASURED THEM, i.e. before #1909 fixed the two
 * defects the last row exposed. They are kept as the historical record because
 * the lesson below is the reusable part; the post-#1909 heights are underneath.
 *
 *   branch              macOS 1280   macOS 390   COMMITTED (Linux 1280)
 *   Details             438 x 37     300 x 37    438 x 37
 *   Resume from pause   438 x 37     300 x 37    438 x 37
 *   Remove (delegation) 438 x 37     300 x 37    438 x 37
 *   Remove (revoked)    438 x 37     300 x 37    438 x 37
 *   Restore to list     438 x 29     300 x 45    438 x 45   <- see below
 *
 * **Read that last row before trusting any local measurement in this family.**
 * The archived branch pairs its control with a whole sentence ("History stays
 * readable; restoring never re-enables spending"). On macOS at 1280 that fits
 * on one line and the row is 29px; the same branch at 390 wraps to 45px. The
 * obvious conclusion — "desktop is fine, mobile reflows" — is WRONG on the
 * platform that judges: Linux's wider metrics wrap it at 1280 too, so the
 * committed baseline is 45px and even the `Restore to list` label itself
 * breaks across two lines. A macOS-derived desktop number was off by 16px and
 * by a whole layout claim.
 *
 * ── What #1909 changed, and the two things that row was hiding ───────────────
 *
 * The 29px was not just a wrap symptom, it was a second defect. 37 = `pt-3`
 * (12) + a 24px line box + the 1px `border-t`, and that 24px comes from the `|`
 * separators, which carry no `text-xs` and so inherit 16px/24px. `items-center`
 * centres the 16px controls inside it, handing the operational branches 4px of
 * bottom clearance FOR FREE. The archived branch renders no separator, so its
 * tallest item is the 16px control, the row is 12 + 16 + 1 = 29, and the ring —
 * `ring-2`, no offset — sat flush against the row's own boundary with zero
 * clearance. #1909 states the padding (`pb-1`) so the clearance belongs to the
 * row instead of to whichever children happen to render, and pins the label
 * with `whitespace-nowrap` (its 390px budget is measured in `AgentCard.tsx`:
 * 162px of slack, 0px of overflow).
 *
 * Post-#1909 the padding change is a clean, checkable prediction — exactly +4px
 * on every one of these eight rows, and byte-identical on the three sidebar
 * captures, which share no markup with this row. The wrap fix is checked by
 * `expectRowControlsUnwrapped` below rather than by reading the PNG, because a
 * green baseline only ever proves the baseline matches the render.
 *
 * That is the same trap #1875 hit from the other side (a mutation reading
 * 1,746 px on `design-system` where clean code fails identically), and the
 * rule it produces is: **a local pixel number is only ever evidence about a
 * DIFFERENCE measured against a baseline rendered by the same machine.** The
 * mutation figures in this file's PR are exactly that shape — macOS mutant
 * against macOS control — and are sound. An absolute geometry claim is not,
 * which is why the authoritative column above is the one CI produced.
 *
 * The prediction still holds where it is checkable: every committed PNG's
 * dimensions equal `Math.round(boundingBox())` of its row ON ITS OWN PLATFORM,
 * with no clip-rect surprises. A capture verified by looking at it is verified
 * by the same eye that would accept the wrong one.
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
 * element will not match a 176x118 render of this popover — but it would fail
 * as "the popover drifted" rather than as "the locator moved".
 */
const USER_MENU_POPOVER = '[role="menu"][aria-label="User menu"]'
const USER_MENU_TRIGGER = 'button[aria-label="User menu"]'

/**
 * ── The budget, measured rather than chosen ──────────────────────────────────
 *
 * #1811's and #1820's method, repeated: commit it at `0`, push, and read the
 * real count off what CI does with it — against baselines generated in a
 * DIFFERENT run (baselines from run 32603576515, compared in run 32603824968,
 * both ubuntu-latest with the same cached Chromium).
 *
 *   run-to-run jitter, all six driven captures, at threshold 0.02:   0 pixels
 *
 * At a budget of 0 the job went GREEN, which is the strongest form this
 * measurement takes: not "under budget" but literally zero differing pixels.
 * Consistent with the five resting-state captures, and for the same reason one
 * layer down — pixelmatch runs with `includeAA: false`, so antialiased pixels
 * are excluded before any budget is consulted. The budget never absorbed AA.
 *
 * ── Why 50 and not the 100 the other captures carry ──────────────────────────
 *
 * Because the absolute number is the wrong thing to copy. These regions are an
 * order of magnitude smaller than the sidebar's, so the SAME slack is a much
 * looser gate:
 *
 *   capture                 area        budget 100 would be   50 is
 *   sidebar (#1820)         192,000 px        0.052%            —
 *   top bar, desktop        58,240 px         0.17%             —
 *   this popover            20,768 px         0.48%           0.24%
 *   this action row         17,958 px         0.56%           0.28%
 *
 * (The action row is 438x41 since #1909's `pb-1`; it was 438x37 and 16,206 px
 * when these proportions were first taken, which moved 50 from 0.31% to 0.28%
 * — a direction that tightens the gate, so the budget stands unchanged.)
 *
 * Carrying 100 here would have been the loosest gate in the family while
 * looking like consistency. 50 keeps these in the same proportional band as
 * the chrome captures.
 *
 * It is not 0, for the reason none of the others are: a runner-image or
 * Chromium bump may legitimately nudge a few pixels, and a gate that goes flat
 * red every week is a gate someone turns off. 50 is an order of magnitude above
 * "a few pixels" and still **16x below the smallest real defect measured here**
 * — stripping this file's own Log out ring moves 814 px, and dropping its
 * `ring-inset` moves 1,576 px (both macOS; CI runs ~30% higher). There is no
 * plausible focus-ring regression that fits under 50, because a ring's whole
 * perimeter on one of these items is roughly 800 px to begin with.
 */
const FOCUS_MAX_DIFF_PIXELS = 50

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
 * Split a computed `box-shadow` into its layers and ask whether ANY layer
 * actually paints — non-transparent colour AND non-zero geometry.
 *
 * This is the SECOND hole found in this assertion, in the same place, by the
 * same method. The first version of the ring check ran `paintsSomething` over
 * the whole `box-shadow` string and accepted it if any colour anywhere in it
 * was opaque. `haven-reviewer` predicted that is a tautology for any Tailwind
 * `ring-*` utility, and the mutation confirmed it. Setting Log out's ring to
 * `ring-transparent` — a control with NO visible focus indicator at all —
 * measured:
 *
 *   rgb(255, 255, 255) 0px 0px 0px 0px inset,     <- ring-offset layer
 *   rgba(0, 0, 0, 0)   0px 0px 0px 2px inset,     <- the ring itself, invisible
 *   rgba(0, 0, 0, 0)   0px 0px 0px 0px
 *
 * `ring-2` ALWAYS emits that first `--tw-ring-offset-shadow` layer, opaque
 * white by default, even with no `ring-offset-*` utility in the class string.
 * It is zero-sized, so it paints nothing — but it is opaque, so the old check
 * saw it and passed. The assertion went green on a control with no ring, and
 * only the pixel capture (1,356 px) caught it.
 *
 * Colour alone is therefore not enough, and neither is geometry alone: the
 * offending layer has colour without size, and the real ring had size without
 * colour. A layer has to have both.
 */
function shadowPaints(boxShadow: string) {
  if (boxShadow === 'none') return false
  // Paren-aware split: `rgba(0, 0, 0, 0)` contains the very delimiter layers
  // are separated by, so a bare `.split(',')` shreds every colour token.
  const layers: string[] = []
  let depth = 0
  let current = ''
  for (const ch of boxShadow) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      layers.push(current)
      current = ''
    } else current += ch
  }
  layers.push(current)

  return layers.some((layer) => {
    if (!paintsSomething(layer)) return false
    // Lengths OUTSIDE the colour function — the colour's own numbers are not
    // geometry, and `rgb(255, 255, 255)` would otherwise read as non-zero.
    const geometry = layer.replace(/rgba?\([^)]*\)/gi, ' ')
    const lengths = geometry.match(/-?[\d.]+px/g) ?? []
    return lengths.some((l) => parseFloat(l) !== 0)
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

  const ring = shadowPaints(state.boxShadow)
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

/**
 * This spec's OWN `/agents` payload (#1873), layered over `mockHavenApi`.
 *
 * Registered inside a test, so it is registered AFTER the `beforeEach` — and
 * Playwright matches handlers in REVERSE registration order, so this one is
 * consulted first. Everything except `GET /agents` is handed straight back with
 * `route.fallback()`, which defers to the next matching handler rather than
 * fulfilling; the shared fixture therefore still serves auth, balances,
 * approvals and the rest, unmodified and unaware.
 *
 * The point of the layering is blast radius: `haven-api.ts` is shared with
 * eleven other specs, and a paused or archived agent added there would change
 * what `/agents` renders for all of them.
 */
async function seedAgents(page: Page, agents: ReadonlyArray<Record<string, unknown>>) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/agents') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ agents }),
      })
      return
    }
    await route.fallback()
  })
}

/**
 * One synthetic agent, built by OVERRIDING the shared `testAgent` rather than
 * by writing a fresh literal. Every field this spec does not name — allowances,
 * delegate address, timestamps — therefore matches the agent the six original
 * captures were taken against, so a difference between a new capture and an old
 * one is the branch and not the fixture.
 */
function agentState(overrides: Record<string, unknown>) {
  return { ...testAgent, ...overrides }
}

/**
 * Assert the action row holds EXACTLY these controls, in this order.
 *
 * Seeding a state is not the same as rendering the branch. `status: 'paused'`
 * reaching the API mock says nothing about which of `AgentCard`'s five mutually
 * exclusive footer branches ran — a fixture field the component ignores would
 * leave the row on the default branch and the capture would be a duplicate of
 * an existing baseline, silently. The row's full control set is the observable
 * that distinguishes them, and it is asserted as a SET-with-order rather than a
 * `toBeVisible()` on the one target, so a control appearing that should not
 * (Edit surviving into the `canUseWalletActions: false` branch) fails too.
 *
 * Accessible names, not text: two of these controls read "Remove" and are told
 * apart only by their agent, which is exactly the ambiguity `aria-label` exists
 * to resolve.
 */
async function expectRowControls(row: Locator, expected: readonly string[], label: string) {
  const names = await row.getByRole('button').evaluateAll((els) =>
    els.map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? ''),
  )
  expect(names, `${label}: this is not the footer branch the fixture was seeding`).toEqual([
    ...expected,
  ])
}

/**
 * Assert every control in the captured row renders on ONE line (#1909).
 *
 * This exists because the platform that judges is not the platform that
 * develops. `Restore to list` carried no `whitespace-nowrap`, and under CI's
 * wider Linux metrics it broke across two lines at DESKTOP width — the
 * committed baseline was 438x45 against a macOS render of 438x29. A local
 * assertion could never have seen it, and neither could a green baseline: the
 * baseline was a faithful photograph OF the bug. So the guard has to be
 * evaluated where the wrap happens, which is here, in the Linux run.
 *
 * Lines are read as height / line-height rather than by inspecting text: these
 * controls have no vertical padding, so a wrapped label is exactly 2x its
 * line-box and the ratio is unambiguous. Buttons only — the archived branch
 * deliberately pairs its control with a SENTENCE that is expected to reflow,
 * and pinning that would be the actual layout bug.
 *
 * All eight of this row's controls already satisfy it, which the committed
 * baselines prove independently: a wrapped control makes the row >=45px, and
 * the seven non-archived rows are 37px on Linux.
 */
async function expectRowControlsUnwrapped(row: Locator, label: string) {
  const lines = await row.getByRole('button').evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect()
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight)
      return {
        name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
        height: Math.round(box.height * 100) / 100,
        lineHeight,
        lines: Math.round(box.height / lineHeight),
      }
    }),
  )
  for (const control of lines) {
    expect(
      control.lines,
      `${label}: "${control.name}" wrapped onto ${control.lines} lines ` +
        `(${control.height}px against a ${control.lineHeight}px line box). An action ` +
        `label is an atomic phrase; give it \`whitespace-nowrap\` or shorten it. ` +
        `Note this can be GREEN on macOS and RED here — that asymmetry is #1909.`,
    ).toBe(1)
  }
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
      await expectRowControlsUnwrapped(actionRow, `AgentCard action row · ${control.label}`)

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

  // ── AgentCard's other four footer branches — the remaining 5 of 11 (#1873) ─
  //
  // One seeded agent per test, one control per test, one capture per test. The
  // `rowControls` field is the branch assertion: it is what says the fixture
  // reached the intended branch rather than merely carrying the intended field.
  const seededControls = [
    {
      slug: 'details',
      // `canUseWalletActions` is `agentUsesActiveSafe(agent)`, which compares
      // `agent.safe_id` to the ACTIVE safe (`safe-main`, seeded into
      // localStorage by `seedAuthenticatedSession`). A second safe is the only
      // way to reach this branch — the flag is derived, never sent.
      agent: agentState({
        id: 'agent-other-safe',
        name: 'Ledger agent',
        safe_id: 'safe-secondary',
        safe_name: 'Treasury',
      }),
      control: 'Open details for Ledger agent',
      rowControls: ['Open details for Ledger agent', 'Pause Ledger agent'],
      tone: 'brand',
      label: 'Details',
    },
    {
      slug: 'resume',
      agent: agentState({ id: 'agent-paused', name: 'Paused agent', status: 'paused' }),
      control: 'Resume Paused agent',
      rowControls: ['Edit Paused agent', 'Resume Paused agent', 'Revoke Paused agent'],
      tone: 'brand',
      label: 'Resume from pause',
    },
    {
      slug: 'remove-delegation',
      // Delegation agents have no Safe AllowanceModule to tear down, so Revoke
      // is hidden and Remove IS the shutdown (#1402). That substitution is
      // visible in `rowControls` and is the branch's signature.
      //
      // NOTE for anyone copying this seed: it inherits `testAgent`'s LEGACY
      // `allowances` rows (Safe-module `token_address`/`allowance_amount`/
      // `reset_period_min`), which a real `delegator_hybrid` agent would not
      // carry — on that rail `allowances` is a derived view of
      // `agent_delegations` (CLAUDE.md § Agent Model). It is correct HERE
      // because `isDelegationAgent` gates only the action row (AgentCard.tsx),
      // and the budget section is outside the captured region. Reuse this as a
      // template for a capture that reads the budget section and it is wrong.
      agent: agentState({
        id: 'agent-delegation',
        name: 'Delegation agent',
        account_type: 'delegator_hybrid',
      }),
      control: 'Remove Delegation agent',
      rowControls: ['Edit Delegation agent', 'Pause Delegation agent', 'Remove Delegation agent'],
      tone: 'danger',
      label: 'Remove (delegation)',
    },
    {
      slug: 'remove-revoked',
      // `archived_at: null` is load-bearing: the revoked branch is
      // `isRevoked && !isArchived`, and an archived agent renders Restore
      // instead. The two Remove controls are DIFFERENT elements in different
      // branches with different neighbours, which is why they get two captures.
      agent: agentState({
        id: 'agent-revoked',
        name: 'Revoked agent',
        status: 'revoked',
        archived_at: null,
      }),
      control: 'Remove Revoked agent',
      rowControls: ['Remove Revoked agent'],
      tone: 'danger',
      label: 'Remove (revoked)',
    },
    {
      slug: 'restore',
      agent: agentState({
        id: 'agent-archived',
        name: 'Archived agent',
        status: 'revoked',
        archived_at: '2026-05-06T10:00:00.000Z',
      }),
      control: 'Restore Archived agent to the list',
      rowControls: ['Restore Archived agent to the list'],
      tone: 'brand',
      label: 'Restore to list',
      // The only control of the eleven that is not on screen at load.
      behindRemovedDisclosure: true,
    },
  ] as const

  for (const seeded of seededControls) {
    test(`agent card action row — ${seeded.label} focus indicator (${seeded.tone})`, async ({
      page,
    }) => {
      await seedAgents(page, [seeded.agent])
      await gotoDesktop(page, '/agents')

      if ('behindRemovedDisclosure' in seeded && seeded.behindRemovedDisclosure) {
        // Tab + Enter, never `.click()` — see the modality note in the header.
        // The count is asserted so a disclosure that stopped listing this agent
        // fails HERE, rather than as a confusing tab-exhaustion error 80
        // presses later.
        const disclosure = page.getByRole('button', { name: /^Removed\b/ })
        await expect(disclosure).toHaveCount(1)
        await tabToTarget(page, disclosure, 'AgentPanel · Removed disclosure')
        await page.keyboard.press('Enter')
      }

      const target = page.locator(`button[aria-label="${seeded.control}"]`)
      await expect(target).toHaveCount(1)
      await expect(target).toBeVisible()

      const actionRow = target.locator('xpath=..')
      await expect(actionRow).toHaveCount(1)
      await expectRowControls(
        actionRow,
        seeded.rowControls,
        `AgentCard action row · ${seeded.label}`,
      )
      await expectRowControlsUnwrapped(actionRow, `AgentCard action row · ${seeded.label}`)

      await tabToTarget(page, target, `AgentCard action row · ${seeded.label}`)
      await expectFocusedAndIndicated(page, target, `AgentCard action row · ${seeded.label}`)

      await expect(actionRow).toHaveScreenshot(
        `focus-agentcard-actions-${seeded.slug}-desktop.png`,
        SNAPSHOT_OPTIONS,
      )
    })
  }
})
