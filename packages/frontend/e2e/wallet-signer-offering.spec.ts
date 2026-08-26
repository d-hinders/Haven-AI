/**
 * The signer the wallet menu OFFERS, by app state — not by forced props (#1969).
 *
 * ── What this proves that the showcase spec cannot ───────────────────────────
 *
 * `wallet-signing-credential-states.spec.ts` proves the /design-system SHOWCASE
 * discriminates the marker-matched and fallback renders — with props forced,
 * as every gallery state is. This spec proves the APP reaches those renders
 * through the real resolution path: `AuthContext` hydrates the hybrid signer
 * set from the (mocked) owner-scoped API read, `useActiveSigner` resolves it,
 * and the header renders what a real user sees. Until #1969 (owner decision
 * 2026-08-26) the marker-less half of this spec was impossible to write: the
 * hook refused the state, and the product rendered "Connect wallet" instead.
 *
 * Two states, same run, so the discrimination is proven rather than assumed:
 *
 * - MARKER-LESS (the #1969 state: new device, cleared site data + re-login, or
 *   a passkey enrolled elsewhere — the blob re-hydrates from the server, the
 *   device markers never do): the Passkey pill renders, and the menu carries
 *   the #1952 disclosure naming the fallback credential.
 * - MARKER MATCHED (positive control): the same pill, and NO disclosure —
 *   exactly what shipped before #1969, unchanged.
 *
 * The precedence mirror (mixed EOA+passkey accounts keep signing with the
 * connected EOA) is pinned in `signer.test.ts` — wagmi connection state is a
 * unit concern, not a mocked-browser one.
 *
 * Set PROBE_SHOTS_DIR to also write evidence PNGs; CI asserts only.
 */
import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, testSafe, testSafeAddress, testUser } from './fixtures/haven-api'

const HYBRID_KEY_ID = '0x0102030405060708'
// credentialIdFromKeyId('0x0102030405060708') → base64url("\x01…\x08")
const CREDENTIAL_ID = 'AQIDBAUGBwg'
const DEVICE_MARKER_KEY = `haven_passkey_device_${CREDENTIAL_ID}`

const hybridSafe = { ...testSafe, account_type: 'delegator_hybrid' }
const hybridUser = { ...testUser, safes: [hybridSafe] }
const hybridSigners = {
  account_address: testSafeAddress,
  chain_id: 8453,
  owner_address: null,
  passkeys: [
    {
      key_id: HYBRID_KEY_ID,
      x: `0x${'aa'.repeat(32)}`,
      y: `0x${'bb'.repeat(32)}`,
      created_at: '2026-05-01T10:00:00.000Z',
    },
  ],
}

async function mockHybridAccount(page: Page) {
  await mockHavenApi(page)
  // Later-registered routes win: make the fixture user's one safe a Hybrid
  // account and serve the signer-set read `AuthContext` hydrates from.
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hybridUser) })
  })
  await page.route(`**/api/accounts/hybrid/${testSafeAddress}/signers**`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hybridSigners) })
  })
}

async function shoot(page: Page, name: string) {
  if (!process.env.PROBE_SHOTS_DIR) return
  await page.screenshot({ path: `${process.env.PROBE_SHOTS_DIR}/${name}.png` })
}

test('a marker-less hybrid user is OFFERED the passkey signer, with the #1952 disclosure (#1969)', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await mockHybridAccount(page)
  await seedAuthenticatedSession(page)
  await page.goto('/dashboard')
  await page.evaluate(() => document.fonts.ready)

  // The #1969 state, reached through the real path: hydration wrote the blob…
  await expect
    .poll(async () =>
      page.evaluate(
        (addr) => window.localStorage.getItem(`haven_hybrid_signers_${addr.toLowerCase()}_8453`) !== null,
        testSafeAddress,
      ),
    )
    .toBe(true)
  // …and no device marker exists.
  expect(await page.evaluate((k) => window.localStorage.getItem(k), DEVICE_MARKER_KEY)).toBeNull()

  // The header offers the account's own signer — not a wallet connection CTA.
  const pill = page.getByRole('button', { name: 'Passkey', exact: true })
  await expect(pill).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toHaveCount(0)
  await shoot(page, '1969-after-markerless-pill')

  // The menu DISCLOSES that the credential is the fallback (#1952) — offering
  // without disclosure was option 2, declined by the owner decision.
  await pill.click()
  await expect(page.getByText('Signing with')).toBeVisible()
  await expect(page.getByText('No passkey enrolled on this device')).toBeVisible()
  await expect(page.getByText('Your browser may ask you to choose a different one.')).toBeVisible()
  await shoot(page, '1969-after-markerless-popover')

  expect(pageErrors).toEqual([])
})

test('positive control: a marker-matched user gets the same pill with NO disclosure — unchanged by #1969', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await mockHybridAccount(page)
  await seedAuthenticatedSession(page)
  await page.addInitScript((k) => window.localStorage.setItem(k, '1'), DEVICE_MARKER_KEY)
  await page.goto('/dashboard')
  await page.evaluate(() => document.fonts.ready)

  const pill = page.getByRole('button', { name: 'Passkey', exact: true })
  await expect(pill).toBeVisible()
  await pill.click()
  await expect(page.getByText('Signing with')).toBeVisible()
  // The discrimination: marker matched → the fallback disclosure must NOT render.
  await expect(page.getByText('No passkey enrolled on this device')).toHaveCount(0)
  await shoot(page, '1969-control-marker-popover')

  expect(pageErrors).toEqual([])
})
