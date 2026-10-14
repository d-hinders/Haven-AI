/**
 * The signer an account OFFERS, by app state — not by forced props (#1969,
 * #2073), re-pointed at the surface that still shows it (#3825).
 *
 * ── Why this file moved off the top bar ──────────────────────────────────────
 *
 * It used to read the resolved signer off the header's wallet pill ("Passkey",
 * "Wrong wallet", the truncated address) and its menu. #3825 removed that pill
 * from `TopBar` — signers live in Settings → Signers and every signing flow
 * carries its own in-flow connect (#3812) — so there is no global surface that
 * names the resolved signer any more.
 *
 * The STATES still matter, and they are still reachable through the product's
 * own resolution path: `AuthContext` hydrates the hybrid signer set from the
 * (mocked) owner-scoped read, `useAccountSigners` / `pickSigningPath` resolve
 * it, and the account page's "Backup & recovery" card (`AccountSignersCard`)
 * renders the outcome for a user who is about to sign:
 *
 * - READY with a passkey (no wallet prompt at all);
 * - "Connect your account owner wallet…" plus `WalletConnectAction`'s
 *   "Connect wallet" when no signer is reachable;
 * - the same card's "Switch wallet" when a connected wallet is NOT the owner
 *   (#2073) — the in-flow successor to the pill's "Wrong wallet".
 *
 * What is NOT carried over, on purpose: the #1952 "No passkey enrolled on this
 * device" disclosure and the passkey-menu copy were `WalletPopover` content,
 * which no app route renders now (it survives in the connect modal's approval
 * step for wallet-only owners and on `/design-system`, where
 * `wallet-signing-credential-states.spec.ts` still asserts the two states, and
 * `WalletButton.test.tsx` covers the hybrid dropdown copy). The card's own
 * marker-less cue is the cross-device hint (#1097), asserted below as the
 * discriminator between the marker-less and marker-matched states.
 *
 * The precedence mirror (mixed EOA+passkey accounts keep signing with the
 * connected EOA) is pinned in `signer.test.ts` — wagmi connection state is a
 * unit concern, not a mocked-browser one.
 *
 * Set PROBE_SHOTS_DIR to also write evidence PNGs; CI asserts only.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  mockHavenApi,
  seedAuthenticatedSession,
  serveOwnerOnlyHybridSigners,
  testSafe,
  testSafeAddress,
  testUser,
} from './fixtures/haven-api'
import { SUPPORTED_CHAIN_ID_HEX, installInjectedWallet } from './fixtures/injected-wallet'

const HYBRID_KEY_ID = '0x0102030405060708'
// credentialIdFromKeyId('0x0102030405060708') → base64url("\x01…\x08")
const CREDENTIAL_ID = 'AQIDBAUGBwg'
const DEVICE_MARKER_KEY = `haven_passkey_device_${CREDENTIAL_ID}`

const hybridSafe = { ...testSafe, account_type: 'delegator_hybrid' }
// `accounts`, not `safes`: AuthContext has only ever read `accounts`, and the
// `safes` twin is gone entirely (#2914 follow-up).
const hybridUser = { ...testUser, accounts: [hybridSafe] }
const OWNER_ADDRESS = '0x2222222222222222222222222222222222222222'
const UNRELATED_ADDRESS = '0x9999999999999999999999999999999999999999'
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

const ACCOUNT_PAGE = `/accounts/${testSafe.id}`

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

/**
 * Owner-only signer set: an EOA owner, zero enrolled passkeys (#2068's shape).
 * Served by the shared `serveOwnerOnlyHybridSigners` — one encoding of "same
 * account, same signer-set answer". No `/auth/me` override: the shared
 * `testSafe` is `delegator_hybrid` by default since #2264.
 */
async function mockOwnerOnlyHybridAccount(page: Page) {
  await mockHavenApi(page)
  await serveOwnerOnlyHybridSigners(page, OWNER_ADDRESS)
}

async function shoot(page: Page, name: string) {
  if (!process.env.PROBE_SHOTS_DIR) return
  await page.screenshot({ path: `${process.env.PROBE_SHOTS_DIR}/${name}.png` })
}

/** The Backup & recovery card, once the account page has rendered it. */
async function openRecoveryCard(page: Page) {
  await page.goto(ACCOUNT_PAGE)
  await page.evaluate(() => document.fonts.ready)
  await expect(page.getByRole('heading', { name: 'Backup & recovery' })).toBeVisible({ timeout: 20_000 })
}

test('a marker-less hybrid user is OFFERED the passkey signer — ready, no wallet prompt — with the cross-device hint (#1969)', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await mockHybridAccount(page)
  await seedAuthenticatedSession(page)
  await openRecoveryCard(page)

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

  // The account's own signer is offered: signing is ready, so the card asks
  // for no wallet and offers no connect control. (Before #1969 this state
  // rendered "Connect wallet".)
  await expect(page.getByRole('button', { name: 'Add a backup passkey' })).toBeEnabled()
  await expect(page.getByText('Connect your account owner wallet')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Switch wallet' })).toHaveCount(0)

  // Offering WITH disclosure, in the card's own words: the passkey may live on
  // another device, so the browser may hand the ceremony off (#1097/#1952).
  await expect(page.getByText(/passkey may be on another device/)).toBeVisible()
  await shoot(page, '1969-after-markerless-card')

  expect(pageErrors).toEqual([])
})

test('positive control: a marker-matched user is offered the same signer with NO cross-device hint — unchanged by #1969', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await mockHybridAccount(page)
  await seedAuthenticatedSession(page)
  await page.addInitScript((k) => window.localStorage.setItem(k, '1'), DEVICE_MARKER_KEY)
  await openRecoveryCard(page)

  await expect(page.getByRole('button', { name: 'Add a backup passkey' })).toBeEnabled()
  // The discrimination: marker matched → the hint must NOT render.
  await expect(page.getByText(/passkey may be on another device/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toHaveCount(0)
  await shoot(page, '1969-control-marker-card')

  expect(pageErrors).toEqual([])
})

// ── Owner-match / mismatch, through the real wagmi connection (#2073) ────────

test('an UNRELATED connected wallet on an owner-only hybrid account is blocked and offered Switch wallet — not treated as the owner (#2073)', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await mockOwnerOnlyHybridAccount(page)
  await installInjectedWallet(page, { chainIdHex: SUPPORTED_CHAIN_ID_HEX, address: UNRELATED_ADDRESS })
  await seedAuthenticatedSession(page)
  await openRecoveryCard(page)

  // The card names the block instead of enabling actions beside a wallet that
  // cannot sign for this account…
  await expect(page.getByText('Connect your account owner wallet')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Add a backup passkey' })).toBeDisabled()
  // …and the fix is one click away, in the flow: the wallet IS connected, so
  // the action is "Switch wallet", never "Connect wallet".
  await expect(page.getByRole('button', { name: 'Switch wallet' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toHaveCount(0)
  await shoot(page, '2073-wrong-wallet-card')

  expect(pageErrors).toEqual([])
})

test('positive control: the OWNER connected on the same owner-only set can approve — no connect or switch control (#2068 ready path)', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await mockOwnerOnlyHybridAccount(page)
  await installInjectedWallet(page, { chainIdHex: SUPPORTED_CHAIN_ID_HEX, address: OWNER_ADDRESS })
  await seedAuthenticatedSession(page)
  await openRecoveryCard(page)

  await expect(page.getByRole('button', { name: 'Add a backup passkey' })).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByText('Connect your account owner wallet')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Switch wallet' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toHaveCount(0)
  await shoot(page, '2073-owner-match-card')

  expect(pageErrors).toEqual([])
})

test('an owner-only account with NO wallet connected is offered Connect wallet in the flow (#3812)', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await mockOwnerOnlyHybridAccount(page)
  await seedAuthenticatedSession(page)
  await openRecoveryCard(page)

  await expect(page.getByText('Connect your account owner wallet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Switch wallet' })).toHaveCount(0)

  expect(pageErrors).toEqual([])
})
