/**
 * The wallet menu's two signing-credential states really render, and really
 * differ (#1952).
 *
 * ── Why this exists beside the pixel gate ────────────────────────────────────
 *
 * The rendered evidence for these states is the `/design-system` full-page
 * baseline, which is the blocking *Design visual regression* capture. That
 * baseline is necessary and not sufficient, for the reason `agent-panel-states`
 * states at length: a green baseline only ever proves the baseline matches the
 * render, never that the render is correct — and these two demos are
 * STRUCTURALLY near-identical by construction (same primitive, same tokens,
 * same three-line skeleton, differing by a rule, an icon-led label and one
 * line). If a future edit passed `onThisDevice: true` to both, the page would
 * still render, the diff would be small, and a baseline refresh would quietly
 * bless a showcase that photographs one state twice while advertising two.
 *
 * So the structural facts are asserted here as booleans, which need no baseline
 * and carry none of the platform-metrics caveat the captures do:
 * EXACTLY ONE fallback marker, EXACTLY ONE explanatory line, and EXACTLY TWO
 * "Signing with" eyebrows. The counts are what make this a discrimination
 * rather than a presence check — `toHaveCount(1)` on the marker fails if both
 * demos become the fallback, and `toHaveCount(2)` on the eyebrow fails if
 * either demo stops rendering at all.
 *
 * ── Why the showcase renders these with props forced ─────────────────────────
 *
 * Because the gallery's job is photographing states side by side with props
 * forced, whatever the app does. Since #1969 (owner decision 2026-08-26) the
 * fallback IS reachable in the app — `useActiveSigner` resolves any non-empty
 * hydrated signer set — and the app-state proof lives in
 * `e2e/wallet-signer-offering.spec.ts`, which reaches both states through the
 * real hydration path. This spec keeps asserting the SHOWCASE discriminates
 * the two states structurally, which no app fixture guarantees.
 *
 * NOT a `.visual.spec.ts`: it takes no screenshot and needs no baseline, so it
 * runs on every platform in the ordinary e2e suite rather than only under
 * VISUAL_REGRESSION=1.
 */
import { expect, test } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

test('the wallet menu shows the marker-matched and fallback credentials as different states', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await page.goto('/design-system')
  await page.evaluate(() => document.fonts.ready)

  const heading = page.getByRole('heading', { name: 'Signing credential (wallet menu)' })
  await expect(heading).toHaveCount(1)
  await heading.scrollIntoViewIfNeeded()

  // The fallback state, and ONLY the fallback state, carries the marker and the
  // explanatory line. Both demos carry the eyebrow — keeping it identical is
  // what preserves the credential name's place in the hierarchy, so the
  // distinction has to live in the marker rather than in the eyebrow's length.
  await expect(page.getByText('No passkey enrolled on this device')).toHaveCount(1)
  await expect(page.getByText('Your browser may ask you to choose a different one.')).toHaveCount(1)
  await expect(page.getByText('Signing with')).toHaveCount(2)

  // The marker is a DESIGNED treatment, not a longer sentence: the design pass
  // measured that an eyebrow-only distinction rested on incidental text wrap at
  // this width. Assert the rule and the icon, so a revision that keeps the
  // words and drops the treatment fails here.
  const fallbackBlock = page
    .locator('div.border-l-2')
    .filter({ hasText: 'No passkey enrolled on this device' })
  await expect(fallbackBlock).toHaveCount(1)
  await expect(fallbackBlock.locator('svg')).toHaveCount(1)

  expect(pageErrors).toEqual([])
})
