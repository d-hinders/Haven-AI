/**
 * The DOM half of the capture readiness probe (#2204 review finding).
 *
 * `full-page-capture.test.ts` proves the JUDGE — `judgeContentSettled` and
 * `resolveContentSettled` — discriminates correctly, and it proves it against
 * hand-written `ContentProbe` objects. That is the right shape for a verdict,
 * and it leaves a hole one layer down: nothing ran the code that PRODUCES those
 * objects, because it only ever executed inside a live Chromium via
 * `page.evaluate`.
 *
 * The hole matters more than it looks. A typo in the `[aria-busy="true"]`
 * selector — dropping the quotes, matching the bare attribute, misspelling it —
 * fails **open**: `contentBusy` comes back 0, every judge test still passes, the
 * suite is green, and the harness silently captures the partially-painted
 * `/agents` page again with `RESULT ok`. A guard whose sensor is untested is a
 * guard that reports "fine" for the same reason the original bug did.
 *
 * So `readContentProbe` is hoisted out of the `page.evaluate` call and run here
 * against a real jsdom document. One constraint carries over and is asserted
 * below: Playwright serialises that function into the page, so it may close over
 * nothing from module scope.
 *
 * jsdom does not implement layout, so `innerText` is undefined and
 * `scrollHeight` is 0 on every element. Neither is what this file is about —
 * the character/element floors are already pinned in `full-page-capture.test.ts`
 * against MEASURED live numbers, and re-asserting them against a layout engine
 * that returns zeros would be a test of jsdom. What is exercised here is the
 * part that is pure DOM query: which elements are found, which count as busy,
 * and what they are called.
 */
import { beforeEach, describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, shared by the screenshot script and both e2e specs
import { readContentProbe } from '../../scripts/full-page-capture.mjs'

type Probe = {
  found: boolean
  contentChars: number | null
  contentElements: number | null
  contentBusy: number | null
  contentBusyLabels: string[]
}

const probe = (selector = '#main-content'): Probe => readContentProbe(selector) as Probe

function render(html: string) {
  document.body.innerHTML = html
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('readContentProbe', () => {
  it('finds the content root and counts what is inside it', () => {
    render(`
      <nav id="sidebar"><a href="/x">Shell link</a></nav>
      <main id="main-content"><div><p>Agents</p><p>Ops agent</p></div></main>
    `)

    const result = probe()

    expect(result.found).toBe(true)
    // Three: the <div> and its two <p>s. The root itself is not counted
    // (`root.querySelectorAll('*')` is descendants), and the shell's <nav> is
    // outside it — that gap between body and region is the whole reason #2036
    // measures the region rather than the document.
    expect(result.contentElements).toBe(3)
  })

  it('reports no root rather than an empty one when the selector matches nothing', () => {
    render('<div id="something-else">marketing page</div>')

    const result = probe()

    expect(result.found).toBe(false)
    expect(result.contentChars).toBeNull()
    expect(result.contentElements).toBeNull()
    expect(result.contentBusy).toBeNull()
  })

  // ── The sensor this file exists for ────────────────────────────────────────

  it('counts an aria-busy="true" region inside the content root', () => {
    render(`
      <main id="main-content">
        <div role="status" aria-busy="true" aria-label="Loading USDC budget"></div>
      </main>
    `)

    const result = probe()

    expect(result.contentBusy).toBe(1)
    expect(result.contentBusyLabels).toEqual(['Loading USDC budget'])
  })

  it('does NOT count aria-busy="false" — the signal working is not a match', () => {
    // `/accounts` binds `aria-busy={portfolioLoading}` and `ReceiveFundsModal`
    // binds `aria-busy={!qrDataUrl}`. A probe that matched the ATTRIBUTE rather
    // than the value would refuse both of those surfaces forever, on every run,
    // once they had finished loading.
    render(`
      <main id="main-content">
        <div role="status" aria-busy="false">Portfolio</div>
        <div aria-busy="false">Receive</div>
      </main>
    `)

    expect(probe().contentBusy).toBe(0)
  })

  it('ignores a busy element OUTSIDE the content root', () => {
    // The shell is allowed to be busy — a TopBar chip refreshing is not the
    // route failing to paint, and counting it would make the guard fire on
    // every route at once.
    render(`
      <header aria-busy="true">TopBar</header>
      <main id="main-content"><p>Agents</p></main>
    `)

    expect(probe().contentBusy).toBe(0)
  })

  it('reproduces the exact /agents shape the guard refuses', () => {
    // Three budget-loading rows in three `AgentCard`s, transcribed from
    // `components/agent-panel/{AllowanceBar,AgentCard}.tsx` as this change
    // leaves them. This is the DOM behind the measured 886 chars / 150 elements
    // / 1856px capture.
    //
    // Note where the attributes sit, because #2204's design review moved them:
    // the LIVE REGION is the per-card wrapper (one announcement per surface,
    // the app's own convention) and `aria-busy` is on each ROW. The guard reads
    // the rows, so the count is 3 — one per card — not 3 wrappers plus 3 rows.
    render(`
      <main id="main-content">
        ${['Research agent', 'Ops agent', 'Data-feed agent']
          .map(
            (name) => `
          <div role="status" aria-live="polite" aria-label="Loading ${name}'s budget" class="space-y-2">
            <div class="flex items-center gap-2 text-xs" aria-busy="true">
              <span>USDC</span><div></div><span>loading...</span>
            </div>
          </div>`,
          )
          .join('')}
      </main>
    `)

    const result = probe()

    expect(result.contentBusy).toBe(3)
    // jsdom has no layout, so `innerText` is undefined and the naming falls to
    // the tag/class rung. What matters here is that all three rows are SEEN;
    // the label rungs have their own cases above and below.
    expect(result.contentBusyLabels).toHaveLength(3)
  })

  it('does not count the live-region WRAPPER — only the busy rows inside it', () => {
    // The wrapper carries `role="status"` and no `aria-busy`. If the probe ever
    // widened to "anything that looks like a loading region", this shape would
    // double-count and the refusal message would name containers rather than
    // the rows that are actually unfinished.
    render(`
      <main id="main-content">
        <div role="status" aria-live="polite" aria-label="Loading Ops agent's budget">
          <div aria-busy="true"><span>USDC</span></div>
        </div>
      </main>
    `)

    expect(probe().contentBusy).toBe(1)
  })

  it('names a busy element with no aria-label by its tag and class', () => {
    // The fallback chain has three rungs and each one is a different reader
    // experience in the refusal message. jsdom has no layout, so `innerText` is
    // undefined here and the text rung cannot be exercised — this pins the
    // last rung, which is the one that runs when a placeholder has neither.
    render('<main id="main-content"><section aria-busy="true" class="agent-card grid"></section></main>')

    expect(probe().contentBusyLabels).toEqual(['section.agent-card'])
  })

  it('caps the labels so a page mid-load cannot flood the refusal message', () => {
    render(
      `<main id="main-content">${Array.from(
        { length: 12 },
        (_, i) => `<div aria-busy="true" aria-label="row ${i}"></div>`,
      ).join('')}</main>`,
    )

    const result = probe()

    // The COUNT is complete; only the naming is capped, so the reader is never
    // told there were 8 when there were 12.
    expect(result.contentBusy).toBe(12)
    expect(result.contentBusyLabels).toHaveLength(8)
  })

  it('closes over nothing from module scope — Playwright serialises it', () => {
    // Not a style rule. `probeShell` passes this function to `page.evaluate`,
    // which stringifies it and rebuilds it inside the browser; a reference to
    // any import or constant in `full-page-capture.mjs` becomes a
    // ReferenceError in the page, which surfaces as a capture failure with no
    // relation to the route being captured. Asserting on the source is crude
    // and it is the only thing that fails at the moment the mistake is made.
    const source = String(readContentProbe)

    for (const moduleScoped of [
      'SCROLL_SHELL_ROOT',
      'MIN_CONTENT_CHARS',
      'MIN_CONTENT_ELEMENTS',
      'CONTENT_BUSY_ALLOWED',
      'judgeContentSettled',
      'createInflate',
    ]) {
      expect(source).not.toContain(moduleScoped)
    }
  })
})
