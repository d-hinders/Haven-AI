/**
 * The two questions a `*.visual.spec.ts` asks, and which of them can run here
 * (#2827).
 *
 * These specs assert two different things, and only one is un-runnable off
 * Linux:
 *
 *   - **the pixel comparison**, against a Linux-rendered baseline. Genuinely
 *     un-runnable on a developer's macOS — font rendering differs, so a local
 *     comparison fails for a reason unrelated to any defect. That is why these
 *     specs are excluded from the default suite at all (#897).
 *   - **the structure** it navigates to get there. Platform-independent, and
 *     the half that breaks silently. These specs are already written that way:
 *     `design-system.visual.spec.ts` finds the top bar with
 *     `//*[@id="main-content"]/preceding-sibling::header[1]` (#1820) and then
 *     asserts `toHaveCount(1)` on it — `focus-visible.visual.spec.ts` says why,
 *     at its line 296: that "closes 'matches nothing' and 'matches several'".
 *     There are 27 such assertions across the five specs.
 *
 *     So the structural coverage was never missing. It was unreachable: nesting
 *     `<header>` in a wrapper makes that xpath match nothing, #2819 did exactly
 *     that, and `test:e2e:gate:built` — the loop an author runs before pushing
 *     — could not see these specs at all. This mode does not add assertions; it
 *     lets the ones already written run somewhere other than CI.
 *
 * So there are three modes, and the predicate is HERE rather than repeated in
 * each spec: the same condition written five times is five chances for the
 * next mode to be added to four of them.
 *
 *   | mode                    | specs run | pixels compared |
 *   |-------------------------|-----------|-----------------|
 *   | default                 | no        | —               |
 *   | `VISUAL_REGRESSION=1`   | yes       | yes (CI, Linux) |
 *   | `VISUAL_STRUCTURE_ONLY=1` | yes     | **no**          |
 *
 * Structure-only is safe in the default local gate because of one property:
 * **it cannot go red for a reason CI would call green.** It compares no pixels,
 * so what is left is the specs' own structural assertions and the setup that
 * reaches them — all of which fail identically on Linux.
 *
 * It is not a substitute for the pixel gate and must never be mistaken for one.
 * `test:visual` remains the only thing that compares anything, and
 * `src/__tests__/visual-gate-coverage.test.ts` asserts this mode never reaches
 * it: setting it there would leave the blocking job green while comparing
 * nothing.
 */
export const VISUAL_COMPARE = process.env.VISUAL_REGRESSION === '1'
export const VISUAL_STRUCTURE_ONLY = process.env.VISUAL_STRUCTURE_ONLY === '1'

/** Whether the visual specs run at all, in either mode. */
export const VISUAL_SPECS_ENABLED = VISUAL_COMPARE || VISUAL_STRUCTURE_ONLY

/**
 * The `test.skip` reason, so the five specs cannot drift into describing
 * different conditions for the same predicate.
 */
export const VISUAL_SKIP_REASON =
  'Linux-rendered baselines — run via the CI job (or VISUAL_REGRESSION=1 in a Linux container). ' +
  'VISUAL_STRUCTURE_ONLY=1 runs the locators without comparing pixels (#2827).'
