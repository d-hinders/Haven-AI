/**
 * The durable regression gate for the clip guard (#1886).
 *
 * `measureHiddenBelowFold` (`scripts/clip-guard.mjs`) is the guard #1879
 * corrected: it scans a capture target's subtree for the deepest box that
 * actually clips, instead of measuring the target node and reporting 0 for
 * every `getByRole('dialog')` capture in the harness. #1879 proved the
 * correction by hand — one 900px block injected into a real modal, one run,
 * one revert — and then nothing re-ran the proof. `scripts/screenshot.mjs` is
 * an on-demand evidence CLI that no CI job invokes, so a future refactor of
 * the exclusion rules had no gate at all, while the guard's horizontal twin
 * `measureDialogOverflow` is asserted against in real specs on every PR.
 *
 * ── Why a synthetic fixture, and not the two other instruments ──────────────
 *
 * **Not jsdom.** jsdom performs no layout: `clientHeight` and `scrollHeight`
 * are `0` on every element, so every assertion written against them passes
 * against every input — including a guard that returns a constant. That is
 * worse than no test, because it looks like coverage. The suggestion was made
 * on #1879 and declined for exactly this reason; it is recorded here so it is
 * not rediscovered and shipped a third time.
 *
 * **Not an assertion against the harness's own output.** Running a capture
 * known to clip and asserting the `clipped` report names it would be genuinely
 * end to end, and it is the wrong instrument for this question. It cannot
 * distinguish *"the guard stopped working"* from *"these captures are still
 * clipped"* — and on today's `dev` the second is permanently true: 8 of the 16
 * current residuals are self-capped by design, entirely in `connect-agent`.
 * A gate that failed on any residual would be red on unchanged `dev` forever,
 * and #1887 is about to change the very scroll heights it would key on. That
 * instrument answers a question about the app's layout. This issue asks a
 * question about the guard.
 *
 * A `page.setContent()` fixture answers only the second question, which is why
 * it is worth its cost: it loads no route, reads no API fixture, renders no
 * product component and commits no baseline PNG, so nothing #1887 does to the
 * app can redden it — while Chromium still lays it out for real, which is the
 * one thing jsdom cannot give.
 *
 * **Coverage is the whole function, not half of it.** The alternative of
 * extracting the traversal as a pure function over injected boxes would run
 * faster and would leave the `scrollHeight`/`clientHeight` read — the half
 * that #1879 actually got wrong — untested. Here the real `target.evaluate()`
 * executes in a real browser against real boxes; the module moved out of
 * `screenshot.mjs` verbatim, so this is the same code the harness runs.
 *
 * ── House rules this spec obeys ────────────────────────────────────────────
 *
 * Each rule gets its own `test()` and its own fixture. A shared fixture with
 * five assertions in one `test()` short-circuits at the first failure and
 * turns the blast radius into a guess (#1863). Every rule below has a
 * recorded mutation that reddens that rule and no other — see the PR body.
 *
 * ── Attribution, and exactly how far this gate's version of it reaches ──────
 *
 * A guard that gets the NUMBER right and pins it to the WRONG BOX passes any
 * amount of number-checking. #1894 (#1887) is that defect in the flesh: the
 * harness's report printed the BEFORE offender's name against the AFTER
 * residual, so four `connect-agent` captures with before-values of
 * 203/203/295/1020 all reported the same 203 — four inputs, one output, which
 * cannot happen. The tell was arithmetic, not a red test.
 *
 * This spec covers that class **inside `measureHiddenBelowFold`**, and only
 * there. Rules 1, 4 and 5 each assert the offender's identity and not merely
 * its pixel count — rule 1 goes further and asserts the offender is the nested
 * scroller and explicitly NOT the wrapper it was handed, which is the precise
 * mis-attribution #1879 fixed.
 *
 * It does **not** cover the report-assembly layer in `screenshot.mjs` that
 * pairs a measurement with a label — that is where #1894's defect actually
 * lived, it is downstream of this function, and nothing here would have caught
 * it. Said plainly rather than left implied: this gate proves the guard
 * attributes correctly; it does not prove the harness REPORTS the guard's
 * attribution correctly. Those are two different questions and #1894 owns the
 * second.
 */
import { expect, test } from '@playwright/test'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, the exact module `scripts/screenshot.mjs` imports
import { CLIP_TOLERANCE_PX, measureHiddenBelowFold } from '../scripts/clip-guard.mjs'

type Measurement = { hidden: number; offender: string | null; offenderCount: number }

const measure = (target: unknown): Promise<Measurement> =>
  measureHiddenBelowFold(target) as Promise<Measurement>

/**
 * Every fixture pins its own box heights in `px` and resets the UA margin, so
 * a measurement is a property of the markup rather than of the viewport, the
 * device scale factor, or the default font. Nothing here depends on app CSS.
 */
const fixture = (body: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font: 16px/1.2 system-ui, sans-serif; }
</style></head><body>${body}</body></html>`

const target = (page: import('@playwright/test').Page) => page.locator('[data-testid="target"]')

test.describe('clip guard — measureHiddenBelowFold', () => {
  /**
   * Rule 1 — the #1879 defect itself, in its smallest honest form.
   *
   * This is the shape of the mutation that proved the original fix: a 900px
   * block inside a modal's scrolling body, wrapped in a container that does
   * not scroll. The capture target is the wrapper, because that is where
   * `ui/Modal` puts `role="dialog"`. Measuring the wrapper alone yields 0 —
   * so the OLD guard produced no `clipped` entry at all, absent rather than
   * zero, which is why the truncation was invisible for as long as it was.
   */
  test('catches a nested scroller inside a non-scrolling wrapper, and names the scroller', async ({
    page,
  }) => {
    await page.setContent(
      fixture(`
        <div data-testid="target" style="height: 600px; overflow-y: visible;">
          <div style="height: 60px;">header</div>
          <div data-testid="scrolling-body" style="height: 200px; overflow-y: auto;">
            <div style="height: 900px;">tall content</div>
          </div>
        </div>`),
    )

    const result = await measure(target(page))

    // 900px of content in a 200px box.
    expect(result.hidden).toBe(700)
    // Reported against the box that actually clips, NOT the wrapper handed in.
    expect(result.offender).toContain('scrolling-body')
    expect(result.offender).not.toContain('target')
    expect(result.offenderCount).toBe(1)
  })

  /**
   * Rule 2 — the measured over-fire, and the reason `CLIP_TOLERANCE_PX` is
   * still 4.
   *
   * #1879's first corrected version reported 22 captures, six of them flagged
   * on nothing but a `<button>` whose `scrollHeight - clientHeight` was 5 with
   * `overflow-y: visible` — a box that clips nothing, because its overflow
   * paints and propagates outward to the nearest clipping ancestor, which
   * reports it. The fix was to exclude boxes that cannot clip, NOT to widen
   * the tolerance to 5, which would have hidden real 5px shortfalls too.
   *
   * The second assertion is what keeps this test from being satisfied by the
   * wrong mechanism: 5 is strictly greater than the tolerance, so this button
   * WOULD be reported if the exclusion stopped working. The exclusion is doing
   * the work here, and the tolerance is not covering for it.
   *
   * **What this test does NOT prove on its own, stated so nobody quotes it
   * alone (#1886 review).** It is a NEGATIVE assertion, and a guard that had
   * stopped working entirely would also satisfy it. Measured, not reasoned:
   * the reviewer replaced the whole function body with a constant
   * `{ hidden: 0, offender: null, offenderCount: 0 }` and this test stayed
   * GREEN, along with rule 3 and the tolerance lock — only rules 1, 4 and 5
   * went red. The suite as a whole is therefore falsifiable against a dead
   * guard, but this test is load-bearing only in COMBINATION with the
   * positive-result tests. That is the residue of "a test that cannot fail",
   * narrowed from any single assertion down to any single test, and it is
   * written here rather than left for the next reader to rediscover.
   */
  test('does not fire on a non-clipping descendant whose overflow-y is visible', async ({
    page,
  }) => {
    await page.setContent(
      fixture(`
        <div data-testid="target" style="height: 400px; overflow-y: auto;">
          <!-- border:0 is load-bearing, not tidiness: the UA stylesheet gives a
               button a 2px border, and under box-sizing:border-box that makes a
               34px button report clientHeight 30. The assertion below pins the
               exact numbers #1879 measured, so the fixture has to produce them. -->
          <button data-testid="noisy-button"
                  style="display: block; height: 34px; border: 0; overflow-y: visible;">
            <span style="display: block; height: 39px;">label</span>
          </button>
        </div>`),
    )

    const raw = await page.locator('[data-testid="noisy-button"]').evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowY: getComputedStyle(el).overflowY,
    }))
    // The fixture really does reproduce the measured noise band — otherwise
    // this test would pass on a button that overflows by nothing.
    expect(raw).toEqual({ clientHeight: 34, scrollHeight: 39, overflowY: 'visible' })
    expect(raw.scrollHeight - raw.clientHeight).toBeGreaterThan(CLIP_TOLERANCE_PX)

    const result = await measure(target(page))

    expect(result.hidden).toBe(0)
    expect(result.offender).toBeNull()
    expect(result.offenderCount).toBe(0)
  })

  /**
   * Rule 3 — `sr-only` is excluded by GEOMETRY, never by class name.
   *
   * Tailwind's idiom is `width: 1px; height: 1px; overflow: hidden`, so its
   * `scrollHeight` is the full height of the screen-reader text while its
   * `clientHeight` is 1 — a large "overflow" that is the utility working as
   * intended. A class-name rule would silently exempt a real defect that
   * happened to carry the class, which is the trap the horizontal twin
   * records. The fixture therefore carries no `sr-only` class at all: if the
   * guard ever starts matching on the name instead of the height, this box
   * stops being exempt and this test goes red.
   *
   * Same caveat as rule 2, for the same measured reason: this is a NEGATIVE
   * assertion and it stayed GREEN under the reviewer's constant-return
   * mutation. Do not quote it on its own as proof the exclusion logic runs —
   * it is load-bearing only alongside rules 1, 4 and 5.
   */
  test('excludes a 1px-tall box by geometry, with no sr-only class present', async ({ page }) => {
    await page.setContent(
      fixture(`
        <div data-testid="target" style="height: 400px; overflow-y: auto;">
          <span data-testid="visually-hidden"
                style="display: block; width: 1px; height: 1px; overflow: hidden;">
            a long screen-reader-only sentence that wraps many many times over
          </span>
        </div>`),
    )

    await expect(page.locator('[data-testid="visually-hidden"]')).not.toHaveClass(/sr-only/)
    const shortfall = await page
      .locator('[data-testid="visually-hidden"]')
      .evaluate((el) => el.scrollHeight - el.clientHeight)
    // Keeps the test honest: the box genuinely reports a huge shortfall, so a
    // guard that stopped excluding it could not pass this by accident.
    expect(shortfall).toBeGreaterThan(50)

    const result = await measure(target(page))

    expect(result.hidden).toBe(0)
    expect(result.offenderCount).toBe(0)
  })

  /**
   * Rule 4 — `overflow-y: hidden` is deliberately NOT exempt.
   *
   * A box that truncates without even offering a scrollbar is the worst
   * version of this defect, not an exempt one: the content is unreachable in
   * the PNG and unreachable in the browser. Only `visible` is excluded, and
   * only because it clips nothing.
   */
  test('catches a box that truncates with overflow-y: hidden', async ({ page }) => {
    await page.setContent(
      fixture(`
        <div data-testid="target" style="height: 500px; overflow-y: visible;">
          <div data-testid="truncating-box" style="height: 100px; overflow-y: hidden;">
            <div style="height: 400px;">unreachable content</div>
          </div>
        </div>`),
    )

    const result = await measure(target(page))

    expect(result.hidden).toBe(300)
    expect(result.offender).toContain('truncating-box')
    expect(result.offenderCount).toBe(1)
  })

  /**
   * Rule 5 — the TARGET itself is measured unconditionally, `overflow-y` and
   * all.
   *
   * An element screenshot captures the target's bounding box, so content
   * overflowing a non-clipping TARGET really is cut from the PNG even though
   * it is visible on screen. Exempting the root the way descendants are
   * exempted would have narrowed the coverage the guard already had while
   * fixing the nested case — so the measurement stays a strict superset of the
   * old one. This is the asymmetry between `isRoot` and everything else, and
   * it is the one an over-eager simplification would delete.
   */
  test('catches overflowing content on a target whose own overflow-y is visible', async ({
    page,
  }) => {
    await page.setContent(
      fixture(`
        <div data-testid="target" style="height: 100px; overflow-y: visible;">
          <div style="height: 500px;">content past the bounding box</div>
        </div>`),
    )

    const result = await measure(target(page))

    expect(result.hidden).toBe(400)
    expect(result.offender).toContain('target')
    // The 500px child is itself a non-clipping descendant, so only the root
    // registers — the root exception is not silently re-admitting the subtree.
    expect(result.offenderCount).toBe(1)
  })

  /**
   * The calibration #1879 measured and this issue is explicit about not
   * undoing. Not a behavioural assertion — a lock, stated as one.
   *
   * 4 survives because the shortfalls the guard exists to catch are 17-1060px,
   * nowhere near the boundary, while 5 was tried and rejected: it would have
   * silenced the `<button>` noise band AND started silencing real 5px
   * shortfalls. Rule 2 is what makes this number safe to leave alone.
   */
  test('keeps CLIP_TOLERANCE_PX at the value #1879 calibrated', () => {
    expect(CLIP_TOLERANCE_PX).toBe(4)
  })
})
