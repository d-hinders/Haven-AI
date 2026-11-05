/**
 * Visual regression for the Send dialog's two screens and its sent state
 * (#4641, epic #4637).
 *
 * Before #4641 `DelegationSendModal` was one screen and no visual spec covered
 * it. It is now Details → Review → sent, and the three states are pinned here
 * at the two evidence viewports (`scripts/evidence-viewports.mjs`: 1280×800
 * and 390×844) plus a desktop dark capture, the same light/dark rule
 * `receive-dialog.visual.spec.ts` and `settings-company-details.visual.spec.ts`
 * follow (no mobile dark baseline exists for this file).
 *
 * ── Where each clip comes from, and why ─────────────────────────────────────
 *
 *   - `send-dialog-details-*` and `send-dialog-review-*` are captured from the
 *     REAL dialog, opened from the dashboard hero. The shared fixture serves
 *     one account ("Operations", Base) and one saved contact ("Research
 *     vendor"), so the Review screen shows a named recipient with its full
 *     address, the rule for everything but your own account, which
 *     `send-dialog-review-own-account-*` pins.
 *   - `send-dialog-sent-*` is captured from the `/design-system` "Manual send"
 *     specimen's Sent card. Reaching the sent screen in a browser needs a
 *     completed passkey ceremony: the fixture's account is pure-passkey
 *     (`/accounts/hybrid/:address/signers` answers one passkey and no EOA
 *     owner), so `signPreparedAccountOp` calls WebAuthn, which the visual gate
 *     cannot drive. The specimen renders the dialog's own markup —
 *     `DialogResult` plus the "Save as contact" row — so the clip still pins
 *     what ships, and the card is documented as a specimen on the page.
 *
 * ── Scoping ─────────────────────────────────────────────────────────────────
 *
 * Every clip is ELEMENT-SCOPED: the dialog panel (`data-testid`
 * `delegation-send-modal`, the bordered box — not the `role="dialog"` wrapper,
 * which is `fixed inset-0` and would photograph the page behind it, #2903) and
 * the specimen card. The panel is opaque and the same size regardless of the
 * page behind it, so the dashboard's own state cannot leak into a clip.
 *
 * The dialog carries no wall-clock text, but the page behind renders relative
 * timestamps, so the clock is frozen anyway — a moving backdrop must never be
 * able to race a capture. Kept to `toHaveScreenshot` plus structural waits on
 * purpose: `update-visual-baselines.yml` aborts before its commit step if any
 * ordinary assertion in a `*.visual.spec.ts` fails (#3441).
 *
 * BASELINES ARE LINUX-RENDERED by the *Update visual baselines* dispatch —
 * none are hand-made here. Dispatch with `expected=` naming the clips that
 * move; the PR carries a `baseline-change:` line per clip
 * (`scripts/ci/baseline-verdict-gate.mjs`).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession, serveTwoAccounts, testRecipientAddress, testSafe } from './fixtures/haven-api'
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

/** The same frozen instant the other dashboard visual specs use. */
const FROZEN_NOW = new Date('2026-09-01T12:00:00.000Z')

/** The fixture's saved contact, served by `GET /contacts`. */
const CONTACT_NAME = 'Research vendor'
const AMOUNT = '25'

/** Open the Send dialog from the dashboard hero. */
async function openSendDialog(page: Page, path = '/dashboard'): Promise<Locator> {
  await page.goto(path)
  await dismissMobileSidebar(page)
  const send = page.getByRole('button', { name: 'Send', exact: true }).first()
  await expect(send).toBeVisible({ timeout: ANCHOR_TIMEOUT_MS })
  await expect(send).toBeEnabled()
  await send.click()
  const dialog = page.getByTestId('delegation-send-modal')
  await expect(dialog).toHaveCount(1)
  return dialog
}

/** How many address groups sit on each rendered line. */
async function groupsPerLine(address: Locator): Promise<number[]> {
  return address.evaluate((el) => {
    const counts = new Map<number, number>()
    for (const group of Array.from(el.querySelectorAll('.whitespace-nowrap > span'))) {
      const top = Math.round(group.getBoundingClientRect().top)
      counts.set(top, (counts.get(top) ?? 0) + 1)
    }
    return Array.from(counts.values())
  })
}

/** Fill Details and move to Review. */
async function fillAndReview(page: Page, dialog: Locator): Promise<void> {
  const to = dialog.getByRole('combobox', { name: 'To' })
  await to.click()
  await to.fill(testRecipientAddress)
  // The list is portaled to `document.body` from `sm` up (inline below it), so
  // the option is found on the page, not inside the dialog.
  await page.getByRole('option', { name: new RegExp(CONTACT_NAME) }).click()
  await dialog.getByLabel('Amount').fill(AMOUNT)
  await dialog.getByRole('button', { name: 'Review', exact: true }).click()
}

test.describe('send dialog visual regression (#4641)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  const schemeOf = (testInfo: { project: { name: string } }): 'light' | 'dark' =>
    testInfo.project.name === 'chromium-desktop-dark' ? 'dark' : 'light'

  test.beforeEach(async ({ page }, testInfo) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    if (schemeOf(testInfo) === 'dark') {
      await page.addInitScript((themeKey: string) => {
        window.localStorage.setItem(themeKey, 'dark')
      }, THEME_STORAGE_KEY)
    }
  })

  for (const vp of [DESKTOP, MOBILE]) {
    test(`send-dialog-details renders pixel-stable (${vp!.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp!.name !== 'desktop', 'no mobile dark baseline for the send-dialog visual spec')

      await page.clock.setFixedTime(FROZEN_NOW)
      await page.setViewportSize({ width: vp!.width, height: vp!.height })
      const dialog = await openSendDialog(page)

      // The state the capture is OF, asserted before the shutter.
      await expect(dialog.getByText('From Operations')).toHaveCount(1)
      // Focus lands on To and the list stays shut until the user asks for it,
      // so the whole form is in view when the dialog opens.
      await expect(dialog.getByRole('combobox', { name: 'To' })).toBeFocused()
      await expect(page.getByRole('listbox')).toHaveCount(0)
      await expect(dialog.getByLabel('Amount')).toHaveCount(1)
      await expect(dialog.getByText('No network fee. You review the payment before you approve it.')).toHaveCount(1)
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(1)
      await expect(dialog.getByRole('button', { name: 'Review', exact: true })).toHaveCount(1)
      // The toggle row and the raw address input are gone (#4641).
      await expect(dialog.getByText(/Or send to another Haven account/)).toHaveCount(0)
      await expect(dialog.getByPlaceholder(/Recipient address/)).toHaveCount(0)

      await page.evaluate(() => document.fonts.ready)
      await expect(dialog).toHaveScreenshot(
        `send-dialog-details-${vp!.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })

    // The filled form. Amount once stopped 122 px short of the recipient field,
    // unnoticed while the dialog opened with the list covering it (found on epic
    // #4637's walkthrough).
    test(`send-dialog-details-filled renders pixel-stable (${vp!.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp!.name !== 'desktop', 'no mobile dark baseline for the send-dialog visual spec')

      await page.clock.setFixedTime(FROZEN_NOW)
      await page.setViewportSize({ width: vp!.width, height: vp!.height })
      const dialog = await openSendDialog(page)

      const to = dialog.getByRole('combobox', { name: 'To' })
      await to.click()
      await to.fill(testRecipientAddress)
      await page.getByRole('option', { name: new RegExp(CONTACT_NAME) }).click()
      await dialog.getByLabel('Amount').fill(AMOUNT)

      // The state the capture is OF, asserted before the shutter.
      const chip = dialog.locator('[data-recipient-chip]')
      await expect(chip).toContainText(CONTACT_NAME)
      await expect(page.getByRole('listbox')).toHaveCount(0)

      await page.evaluate(() => document.fonts.ready)
      await expect(dialog).toHaveScreenshot(
        `send-dialog-details-filled-${vp!.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })

    test(`send-dialog-review renders pixel-stable (${vp!.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp!.name !== 'desktop', 'no mobile dark baseline for the send-dialog visual spec')

      await page.clock.setFixedTime(FROZEN_NOW)
      await page.setViewportSize({ width: vp!.width, height: vp!.height })
      const dialog = await openSendDialog(page)
      await fillAndReview(page, dialog)

      // The Review screen: the amount, the named recipient with its FULL
      // address, the account, the network and the fee.
      await expect(dialog.getByText("You're sending")).toHaveCount(1)
      await expect(dialog.getByText(`${AMOUNT} USDC`, { exact: true })).toHaveCount(1)
      await expect(dialog.getByText(CONTACT_NAME)).toHaveCount(1)
      const address = dialog.getByTestId('review-recipient-address')
      await expect(address).toHaveText(testRecipientAddress)
      // Two balanced lines, jsdom cannot see this. It once wrapped 4, 5, 1 in the
      // desktop column and ran to one line of ten between the two captured widths.
      expect(await groupsPerLine(address)).toEqual([5, 5])
      await page.setViewportSize({ width: 500, height: vp!.height })
      expect(await groupsPerLine(address)).toEqual([5, 5])
      await page.setViewportSize({ width: vp!.width, height: vp!.height })
      // A line cannot wrap, so too narrow a column would overflow instead, hiding
      // the middle of the address, which is where a lookalike differs.
      expect(await address.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await expect(dialog.getByText('Base', { exact: true })).toHaveCount(1)
      await expect(dialog.getByText('None. Haven covers it.')).toHaveCount(1)
      await expect(dialog.getByText("A sent payment can't be reversed. You approve it on the next step.")).toHaveCount(1)
      await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toHaveCount(1)
      await expect(dialog.getByRole('button', { name: `Send ${AMOUNT} USDC`, exact: true })).toHaveCount(1)

      await page.evaluate(() => document.fonts.ready)
      await expect(dialog).toHaveScreenshot(
        `send-dialog-review-${vp!.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })

    test(`send-dialog-review-new-address renders pixel-stable (${vp!.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp!.name !== 'desktop', 'no mobile dark baseline for the send-dialog visual spec')

      await page.clock.setFixedTime(FROZEN_NOW)
      await page.setViewportSize({ width: vp!.width, height: vp!.height })
      const dialog = await openSendDialog(page)
      // A pasted address that matches nothing saved, the case most exposed to a
      // lookalike: no name, no avatar, the whole address grouped for comparing.
      const pasted = '0x18a43f6c7d5c84c3a715097c57b9945ce10c5162'
      const to = dialog.getByRole('combobox', { name: 'To' })
      await to.click()
      await to.fill(pasted)
      await page.getByRole('option', { name: /Send to/ }).click()
      await dialog.getByLabel('Amount').fill(AMOUNT)
      await dialog.getByRole('button', { name: 'Review', exact: true }).click()

      await expect(dialog.getByText('New address')).toHaveCount(1)
      const address = dialog.getByTestId('review-recipient-address')
      await expect(address).toHaveText(pasted)
      expect(await groupsPerLine(address)).toEqual([5, 5])

      await page.evaluate(() => document.fonts.ready)
      await expect(dialog).toHaveScreenshot(
        `send-dialog-review-new-address-${vp!.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })

    test(`send-dialog-review-own-account renders pixel-stable (${vp!.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp!.name !== 'desktop', 'no mobile dark baseline for the send-dialog visual spec')

      await serveTwoAccounts(page)
      await page.clock.setFixedTime(FROZEN_NOW)
      await page.setViewportSize({ width: vp!.width, height: vp!.height })
      // The account page, because the dashboard asks which account first when there are two.
      const dialog = await openSendDialog(page, `/accounts/${testSafe.id}`)
      const ownAccount = '0x4444444444444444444444444444444444444444'
      const to = dialog.getByRole('combobox', { name: 'To' })
      await to.click()
      await to.fill(ownAccount)
      await page.getByRole('option', { name: /Imported Safe/ }).click()
      await dialog.getByLabel('Amount').fill(AMOUNT)
      await dialog.getByRole('button', { name: 'Review', exact: true }).click()

      // Your own account: the name and the SHORT address, not the full one.
      await expect(dialog.getByText('Imported Safe')).toHaveCount(1)
      await expect(dialog.getByTestId('review-recipient-address')).toHaveText(`${ownAccount.slice(0, 6)}…${ownAccount.slice(-4)}`)

      await page.evaluate(() => document.fonts.ready)
      await expect(dialog).toHaveScreenshot(
        `send-dialog-review-own-account-${vp!.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })

    test(`send-dialog-sent renders pixel-stable (${vp!.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp!.name !== 'desktop', 'no mobile dark baseline for the send-dialog visual spec')

      await page.clock.setFixedTime(FROZEN_NOW)
      await page.setViewportSize({ width: vp!.width, height: vp!.height })
      await page.goto('/design-system')
      await dismissMobileSidebar(page)

      const card = page.getByTestId('ds-send-sent')
      await expect(card).toHaveCount(1)
      // The card sits below the fold; an element past the fold captures
      // nothing where the page has no painted pixels.
      await card.scrollIntoViewIfNeeded()

      await expect(card.getByText('125.00 USDC sent')).toHaveCount(1)
      await expect(card.getByText('To Acme Services on Base.')).toHaveCount(1)
      await expect(card.getByText('View transaction')).toHaveCount(1)
      await expect(card.getByText('Save this address as a contact?')).toHaveCount(1)
      await expect(card.getByRole('button', { name: 'Save', exact: true })).toHaveCount(1)
      await expect(card.getByRole('button', { name: 'Done', exact: true })).toHaveCount(1)

      await page.evaluate(() => document.fonts.ready)
      await expect(card).toHaveScreenshot(
        `send-dialog-sent-${vp!.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })
  }
})
