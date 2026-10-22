/**
 * #4293: every capture and e2e run renders local times in UTC, whatever the
 * host's zone. `playwright.config.ts` pins `use.timezoneId`; without it the
 * browser follows the host `TZ`, so a baseline regenerated on a laptop bakes
 * in a different wall clock than CI's.
 *
 * CI hosts are UTC, so a page there reads UTC with or without the pin — an
 * assertion on an ordinary page could never go red. This spec launches its
 * browser with a NON-UTC host zone, so the only thing that can make the page
 * read UTC is the config's `timezoneId`.
 */
import { expect, test } from '@playwright/test'

// UTC+14: no host, CI or laptop, is plausibly already in it.
const HOST_ZONE = 'Pacific/Kiritimati'

test.use({ launchOptions: { env: { ...process.env, TZ: HOST_ZONE } } })

test('the browser renders in UTC even when the host zone is not UTC (#4293)', async ({ page }) => {
  await page.setContent('<p>tz</p>')
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  expect(zone, `the page reads ${zone}; playwright.config.ts use.timezoneId must pin UTC`).toBe('UTC')
})
