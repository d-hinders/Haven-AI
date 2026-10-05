/**
 * `/` motion: no layout shift across a full cycle (#3575).
 *
 * All four animated regions of the home page are live under this harness. Each test installs Playwright's
 * controlled clock, waits until the region's loop is demonstrably running
 * (a loop-driven text state is visible — which also proves the
 * IntersectionObserver delivered), then advances the clock through one
 * FULL cycle and asserts the region's height never changed.
 *
 * `page.clock` virtualizes the timers the loops ride (motion.ts's engine is
 * a setTimeout machine for exactly this reason) — including the tween's
 * 16 ms tick chain and the typing hook's 95 ms keystroke chain. CSS
 * entrances (translateY/opacity) paint outside layout, so a region whose
 * animated states are height-stable passes here and fails loudly if a
 * future edit makes one wrap. The hero's row swap is the exception: its
 * grid tracks do move layout, in real time, so that test pauses the page
 * clock, finds the loop's phase to within 100 ms, and lets each swap
 * finish before it measures.
 */
import { expect, test } from '@playwright/test'

/** The region's rendered height, as layout reports it (integer px). */
async function heightOf(page: import('@playwright/test').Page, testId: string): Promise<number> {
  return page.evaluate((id) => {
    const node = document.querySelector(`[data-testid="${id}"]`)
    if (!node) throw new Error(`missing region [data-testid="${id}"]`)
    return node.getBoundingClientRect().height
  }, testId)
}

test.describe('/ motion: layout stability across cycles', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install()
    await page.goto('/')
    await expect(
      page.getByRole('heading', { level: 1, name: 'Give your agent a budget, not your credit card.' }),
    ).toBeVisible()
  })

  test('the hero frame holds its height at every step of the 19 s payment loop', async ({ page }) => {
    const hero = page.getByTestId('hero-animated')
    await hero.scrollIntoViewIfNeeded()
    // The settled frame, before the loop's first step.
    const settled = await heightOf(page, 'hero-animated')

    // Paused, the page clock only moves on `runFor`, so the real-time waits
    // below cannot move the loop. Sampled DURING the cycle, not only across
    // it (#3644): the list once grew to four rows at the pending insert and
    // shrank back at the reset, which a before/after pair at the same phase
    // could not see.
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000))

    // Find the loop's phase exactly: step 100 ms at a time until the pending
    // row appears (the 3000 ms step, index.html:105). If it is already
    // showing, wait it out first so the edge is the next cycle's.
    const rowTexts = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="hero-activity"] > div:not([data-leaving])')].map(
          (row) => row.textContent ?? '',
        ),
      )
    const pending = async () => (await rowTexts()).some((text) => text.includes('Paying research.example'))
    for (let steps = 0; await pending(); steps++) {
      if (steps > 400) throw new Error('the pending row never cleared')
      await page.clock.runFor(100)
    }
    for (let steps = 0; !(await pending()); steps++) {
      if (steps > 400) throw new Error('the pending row never appeared')
      await page.clock.runFor(100)
    }
    // The loop is now within 100 ms after its 3000 ms step.

    // The row swap is a CSS animation (motion.module.css `grow`/`shrink`):
    // it runs on real time while the paused clock holds the JS steps, so
    // each sample lets the 0.4 s swap finish first. Sub-pixel rounding of
    // the two tracks is tolerated (`toBeCloseTo(…, 0)`, < 0.5 px); the bug
    // this guards against is a whole extra row (~62 px).
    const settledAfterSwap = async () => {
      await page.waitForTimeout(600)
      return heightOf(page, 'hero-animated')
    }

    // Each sample names what the FIRST row shows in its phase and what it
    // must not show yet, so a sample that slid into a neighbouring phase
    // fails instead of passing quietly. Phases (AnimatedHeroFrame.tsx):
    // pending 3000, settle 5200, badge 6800, refusal 11000 (the displaced
    // row dropped at 11420), fade 17500, reset 18100, next pending 22000.
    for (const [advance, label, shows, notYet] of [
      [0, 'pending insert, mid-swap', 'Paying research.example', 'Paid research.example'],
      [2700, 'settled payment', 'Paid research.example', 'In Fortnox'],
      [1800, 'accounting badge', 'In Fortnox', 'Refused'],
      [4000, 'refusal, its displaced row dropped', 'Refused: over budget', 'Paid data.example'],
      [7300, 'reset to the settled rows', 'Paid data.example', 'research.example'],
    ] as const) {
      await page.clock.runFor(advance)
      expect(await settledAfterSwap(), `hero height moved at: ${label}`).toBeCloseTo(settled, 0)
      const [first, ...rest] = await rowTexts()
      expect(first, `first row at: ${label}`).toContain(shows)
      expect(first, `first row at: ${label}`).not.toContain(notYet)
      expect(rest, `in-flow rows at: ${label}`).toHaveLength(2)
    }
  })

  test('the how-it-works cards hold their height through the 12 s cycle', async ({ page }) => {
    const how = page.locator('#how')
    await how.scrollIntoViewIfNeeded()

    // 2100 ms in, the passkey card has completed (index.html:279). The card
    // then shows "Account created" twice — the title and the confirmation —
    // so the probe pins the confirmation element, not the text.
    await page.clock.runFor(2200)
    await expect(page.getByTestId('passkey-animated').getByTestId('confirmation')).toBeVisible()

    const passkeyBefore = await heightOf(page, 'passkey-animated')
    const budgetBefore = await heightOf(page, 'budget-animated')
    const terminalBefore = await heightOf(page, 'terminal-animated')
    await page.clock.runFor(12_000)
    expect(await heightOf(page, 'passkey-animated'), 'passkey card height moved').toBe(passkeyBefore)
    expect(await heightOf(page, 'budget-animated'), 'budget card height moved').toBe(budgetBefore)
    expect(await heightOf(page, 'terminal-animated'), 'terminal height moved').toBe(terminalBefore)
  })

  test('the accounting feed holds its height through the 11 s retry loop', async ({ page }) => {
    const feed = page.getByTestId('accounting-animated')
    await feed.scrollIntoViewIfNeeded()

    // 1600 ms in, the animated row is Retrying (index.html:294).
    await page.clock.runFor(1700)
    await expect(feed.getByText('Retrying the push to Fortnox')).toBeVisible()

    const before = await heightOf(page, 'accounting-animated')
    await page.clock.runFor(11_000)
    const after = await heightOf(page, 'accounting-animated')
    expect(after, 'accounting frame height moved across one cycle').toBe(before)
  })

  test('the refusal receipt holds its height through a replay', async ({ page }) => {
    const receipt = page.getByTestId('refusal-receipt')
    await receipt.scrollIntoViewIfNeeded()

    // The assembly is entry-triggered CSS; the refusal box lands 750 ms in
    // (site.css:338). Give the entry a beat, then cycle past a re-entry.
    await page.clock.runFor(1000)
    const before = await heightOf(page, 'refusal-receipt')
    await page.clock.runFor(3000)
    const after = await heightOf(page, 'refusal-receipt')
    expect(after, 'receipt height moved').toBe(before)
  })
})
