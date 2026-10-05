/**
 * Visual regression for the Add funds modal's chain-dependent variants
 * (#3483).
 *
 * Since #3478 slice 2 (PR #3482) the modal's layout is a function of the
 * SELECTED ACCOUNT's chain, not of the deployment: a testnet account (84532)
 * shows the "Get test funds" faucet card and no "Buy with card" onramp; a
 * mainnet account (8453) shows the onramp — but only when the build carried
 * `NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID` (read at BUILD time,
 * `AddFundsModal.tsx`, so `process.env` here means the bundle constant) — and
 * no faucet. An account that arrives without a `chain_id` still gets the
 * #1844 refusal, naming no network. The unit tests pin only whether each
 * element is present; no pixel baseline covered any variant, so the #3482
 * design reviews asked for one.
 *
 * Three ELEMENT-SCOPED clips (the dialog, the same scoping
 * `edit-budget-modal.visual.spec.ts` uses for the Edit budget modal — the
 * panel is opaque and the same size regardless of the page behind it, so the
 * dashboard's own state cannot leak into a clip):
 *
 *   - `add-funds-testnet`      — the shared account re-chained to 84532 with
 *     the onramp id CONFIGURED: faucet shown, onramp hidden. Configured is
 *     the point — it proves the onramp is hidden because the CHAIN is
 *     testnet, not because the build lacked the id (the trivial way to pass).
 *   - `add-funds-mainnet`      — 8453 with the onramp configured: onramp
 *     shown, no faucet.
 *   - `add-funds-unresolved-chain` — the account WITHOUT `chain_id`: the
 *     refusal copy, no network named, neither card. The existing scenario
 *     from `scripts/screenshot.mjs` (~4729), added per #3483's optional item.
 *
 * Each is captured at desktop and 390 mobile in light, and at desktop in
 * dark (no mobile dark baseline exists for this spec — the convention
 * `settings-company-details.visual.spec.ts` states and follows; the dark
 * run skips mobile rather than comparing against a light baseline).
 *
 * Chain data comes from overlaying `GET /auth/me` per test
 * (`serveAddFundsAccount`): the dashboard reads only `/auth/me` for the
 * account list (`DashboardClient.tsx` → `user?.accounts`), the shared
 * `testSafe` is pinned to 8453 for every other spec and baseline, and the
 * overlay derives from `testSafe` itself so both safe-serving shapes stay
 * consistent. The dashboard hero renders its actions for these fixture
 * shapes (the operation gate resolves `ready` — the shared signer-set
 * handler answers a non-empty passkey set — and `no_signer` would render
 * them too; only `passkey_on_other_device` removes them), so "Add funds" is
 * clickable in every scenario here.
 *
 * Baselines are Linux-rendered by the *Update visual baselines* dispatch —
 * none are hand-made here. That job's BUILD carries the onramp id, so its
 * baselines are the mainnet/testnet variants this spec pins; see
 * `update-visual-baselines.yml` and `ci.yml` (#3483): the two CI builds set
 * `NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID=e2e-onramp-app-id-placeholder`, a
 * fixed synthetic literal chosen over a secret because the id is never
 * rendered — only its PRESENCE gates the card — so a fixed value keeps the
 * baselines deterministic across rotations. Dispatch with
 * `expected=` naming the nine new clips (the file's own listing below);
 * the PR carries a `baseline-change:` line per clip (added baselines need
 * the declaration only — `scripts/ci/baseline-verdict-gate.mjs`).
 *
 * The dialog carries no wall-clock text, but the page behind renders
 * relative timestamps, so the clock is frozen anyway — a moving backdrop
 * must never be able to race a capture. Kept to `toHaveScreenshot` plus
 * structural waits on purpose: `update-visual-baselines.yml` aborts before
 * its commit step if any ordinary assertion in a `*.visual.spec.ts` fails
 * and uploads no failure artifacts (#3441).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import {
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
  serveAddFundsAccount,
} from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .ts constant with no default export shape to widen.
import { THEME_STORAGE_KEY } from '../src/lib/theme-bootstrap'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{ name: 'desktop' | 'mobile'; width: number; height: number }>
const DESKTOP = VIEWPORTS.find((vp) => vp.name === 'desktop')
const MOBILE = VIEWPORTS.find((vp) => vp.name === 'mobile')

if (!DESKTOP || !MOBILE) {
  throw new Error('visual gate: evidence-viewports.mjs carries no desktop/mobile viewport')
}

const PIXEL_THRESHOLD = 0.02
const ANCHOR_TIMEOUT_MS = 60_000

const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: 50,
  threshold: PIXEL_THRESHOLD,
} as const

/**
 * The frozen clock: the SAME instant `currency-preference.visual.spec.ts`
 * freezes — chosen after the fixture timestamps so the dashboard's relative
 * times render in their ordinary months-ago form, and the backdrop can
 * never race a capture (the dialog itself shows no time).
 */
const FROZEN_NOW = new Date('2026-09-01T12:00:00.000Z')

/**
 * The modal's own copy, referenced by name so a wording change is a red test
 * here rather than a silently-reblessed baseline. The faucet/onramp sentence
 * strings are asserted verbatim where the variant question is about them.
 */
const DIALOG_NAME = 'Add funds'
const FAUCET_HEADING = 'Get test funds'
const ONRAMP_BUTTON = 'Buy with card'
const UNRESOLVED_SENTENCE = "We can't confirm which network this account uses, so we can't tell you where to send USDC."

type Variant = {
  /** Baseline file stem: `<stem>-<viewport>[-dark].png`. */
  stem: string
  /** The account chain the scenario serves; `undefined` = no `chain_id`. */
  chainId: number | undefined
  /** Structural assertions that pin WHAT is captured, per scheme. */
  assert: (dialog: Locator) => Promise<void>
}

const VARIANTS: readonly Variant[] = [
  {
    stem: 'add-funds-testnet',
    chainId: 84532,
    async assert(dialog) {
      // The faucet card, naming the account's own chain — Base Sepolia.
      await expect(dialog.getByText(FAUCET_HEADING)).toHaveCount(1)
      await expect(
        dialog.getByText('Send USDC to your account address on Base Sepolia.'),
      ).toHaveCount(1)
      // The variant's point: the onramp is hidden DESPITE the configured id.
      await expect(dialog.getByRole('button', { name: ONRAMP_BUTTON })).toHaveCount(0)
    },
  },
  {
    stem: 'add-funds-mainnet',
    chainId: 8453,
    async assert(dialog) {
      await expect(dialog.getByRole('button', { name: ONRAMP_BUTTON })).toHaveCount(1)
      await expect(dialog.getByText('Send USDC to your account address on Base.')).toHaveCount(1)
      // And the faucet is gone with the testnet — not stacked under the onramp.
      await expect(dialog.getByText(FAUCET_HEADING)).toHaveCount(0)
    },
  },
  {
    stem: 'add-funds-unresolved-chain',
    chainId: undefined,
    async assert(dialog) {
      // The #1844 refusal, verbatim — the modal names no network.
      await expect(dialog.getByText(UNRESOLVED_SENTENCE)).toHaveCount(1)
      await expect(dialog.getByRole('button', { name: ONRAMP_BUTTON })).toHaveCount(0)
      await expect(dialog.getByText(FAUCET_HEADING)).toHaveCount(0)
    },
  },
]

test.describe('add funds modal visual regression (#3483)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  const schemeOf = (testInfo: { project: { name: string } }): 'light' | 'dark' =>
    testInfo.project.name === 'chromium-desktop-dark' ? 'dark' : 'light'

  test.beforeEach(async ({ page }, testInfo) => {
    await mockHavenApi(page)
    // Later routes win (#2733): `/auth/me` now answers the variant's account,
    // everything else keeps falling through to the shared fixture.
    await seedAuthenticatedSession(page)
    if (schemeOf(testInfo) === 'dark') {
      await page.addInitScript((themeKey: string) => {
        window.localStorage.setItem(themeKey, 'dark')
      }, THEME_STORAGE_KEY)
    }
  })

  for (const variant of VARIANTS) {
    for (const vp of [DESKTOP, MOBILE]) {
      test(`${variant.stem} renders pixel-stable (${vp!.name})`, async ({ page }, testInfo) => {
        const scheme = schemeOf(testInfo)
        // Committed baselines: every scenario in light (desktop and mobile),
        // and only the DESKTOP shots in dark — the same rule
        // `settings-company-details.visual.spec.ts` applies. Skipped rather
        // than filtered out so the loop stays the single honest source of
        // what runs under light.
        test.skip(scheme === 'dark' && vp!.name !== 'desktop', 'no mobile dark baseline for the add-funds visual spec')

        // BEFORE `goto`: the page reads `Date.now()` during its first render.
        await page.clock.setFixedTime(FROZEN_NOW)
        await page.setViewportSize({ width: vp!.width, height: vp!.height })
        await serveAddFundsAccount(page, variant.chainId)

        await page.goto('/dashboard')
        await dismissMobileSidebar(page)

        // Open the modal from the hero. `.first()` — the wallet button never
        // carries this label, but the locator stays defensive the way
        // `scripts/screenshot.mjs`'s own add-funds scenarios are.
        const addFunds = page.getByRole('button', { name: 'Add funds', exact: true }).first()
        await expect(addFunds).toBeVisible({ timeout: ANCHOR_TIMEOUT_MS })
        await addFunds.click()

        const dialog = page.getByRole('dialog', { name: DIALOG_NAME })
        await expect(dialog).toHaveCount(1)
        // The state the capture is OF, asserted before the shutter — a
        // locator that drifts is a red test rather than a baseline of the
        // wrong thing (and these run under VISUAL_STRUCTURE_ONLY=1 too).
        await variant.assert(dialog)

        await page.evaluate(() => document.fonts.ready)
        await expect(dialog).toHaveScreenshot(`${variant.stem}-${vp!.name}${scheme === 'dark' ? '-dark' : ''}.png`, SNAPSHOT_OPTIONS)
      })
    }
  }
})
