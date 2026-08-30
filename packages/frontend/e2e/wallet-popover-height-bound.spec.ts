/**
 * The wallet menu is bounded by the VIEWPORT, and what the bound hides is
 * still reachable (#2067).
 *
 * ── What was actually wrong, measured on `origin/dev` ────────────────────────
 *
 * `WalletPopover` hangs `absolute top-full` with no height limit, so its box is
 * whatever its content happens to be. At the tallest app-reachable state — the
 * #1952 marker-less disclosure plus a connected wallet's secondary section —
 * that box measured **430px**. The issue (#2067) described this as overlapping
 * the dashboard hero, and at 1280x800 / 390x844 it does; but so does every
 * overlay, nothing was clipped, and nothing was out of reach. Those two
 * viewports are NOT where the missing bound bites, and this spec does not
 * pretend otherwise — it asserts there that the geometry is unchanged.
 *
 * Where it bites is a short viewport. At 844x390 the same 430px box ran **93px
 * past the bottom of the screen** with the Disconnect button below the fold —
 * and the app shell scrolls `main`, not the document
 * (`app/(authenticated)/layout.tsx`), with this header `position: relative`
 * inside it, so `document.documentElement.scrollHeight === window.innerHeight`
 * and no scroll the user can perform brings it back. Unreachable, not untidy.
 *
 * ── Why these assertions and not a class string ──────────────────────────────
 *
 * A `toHaveClass(/max-h-/)` assertion passes whether or not the layout works,
 * and would have passed on a bound applied to the wrong element. Everything
 * below is geometry a user experiences: where the box ends relative to the
 * screen, whether the last control is on screen, whether keyboard focus can
 * still reach what the bound pushed out of view, and whether the focus ring
 * survives the scroll container (#1873 — rings paint OUTSIDE the border box, so
 * an `overflow` container clips exactly what the ring is for).
 */
import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, testSafe, testSafeAddress, testUser } from './fixtures/haven-api'

/** Tailwind `ring-2`, in px — what must fit between a control and the clip edge. */
const RING_PX = 2

const HYBRID_KEY_ID = '0x0102030405060708'
const hybridSafe = { ...testSafe, account_type: 'delegator_hybrid' }
const hybridUser = { ...testUser, safes: [hybridSafe] }
const WALLET = '0x9999999999999999999999999999999999999999'
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
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hybridUser) })
  })
  await page.route(`**/api/accounts/hybrid/${testSafeAddress}/signers**`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hybridSigners) })
  })
}

/**
 * A connected wallet through the real wagmi path, so the popover renders its
 * `secondary` section too — the same stub `wallet-signer-offering.spec.ts`
 * uses. Without it the menu is a section shorter and the tallest state is not
 * under test.
 */
async function installConnectedWallet(page: Page, address: string) {
  await page.addInitScript(
    ({ addr, chainIdHex }) => {
      window.localStorage.setItem('wagmi.injected.connected', 'true')
      window.localStorage.setItem('wagmi.recentConnectorId', '"injected"')
      const provider = {
        isMetaMask: true,
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [addr]
          if (method === 'eth_chainId') return chainIdHex
          if (method === 'net_version') return String(parseInt(chainIdHex, 16))
          throw new Error(`e2e wallet stub: unanswered method ${method}`)
        },
        on: () => {},
        removeListener: () => {},
      }
      Object.defineProperty(window, 'ethereum', { value: provider, configurable: true })
    },
    { addr: address, chainIdHex: '0x2105' },
  )
}

/** Open the menu in its tallest app-reachable state and return its locator. */
async function openTallestWalletMenu(page: Page) {
  await mockHybridAccount(page)
  await installConnectedWallet(page, WALLET)
  await seedAuthenticatedSession(page)
  await page.goto('/dashboard')
  await page.evaluate(() => document.fonts.ready)

  const pill = page.getByRole('button', { name: 'Passkey', exact: true })
  await expect(pill).toBeVisible({ timeout: 20_000 })
  await pill.click()
  const popover = page.getByRole('dialog', { name: 'Wallet menu' })
  await expect(popover).toBeVisible()
  // The tallest state, asserted rather than assumed: the #1952 marker-less
  // disclosure AND the connected wallet's secondary section are both present.
  await expect(page.getByText('No passkey enrolled on this device')).toBeVisible()
  await expect(page.getByText('Connected wallet')).toBeVisible()
  return popover
}

/** Geometry of the menu, its scroll box, and the page's own scrollability. */
async function readGeometry(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-label="Wallet menu"]') as HTMLElement
    const box = el.getBoundingClientRect()
    const scroller = el.querySelector('[data-wallet-menu-scroll]') as HTMLElement
    const buttons = el.querySelectorAll('button')
    const last = buttons[buttons.length - 1] as HTMLElement
    return {
      bottom: box.bottom,
      height: box.height,
      innerHeight: window.innerHeight,
      // The app shell scrolls `main`, not the document. If this is false, an
      // overhang is unreachable by any scroll the user can perform.
      documentScrollable: document.documentElement.scrollHeight > window.innerHeight,
      scrollerScrollHeight: scroller.scrollHeight,
      scrollerClientHeight: scroller.clientHeight,
      lastControlText: (last.textContent ?? '').trim(),
      lastControlBottom: last.getBoundingClientRect().bottom,
    }
  })
}

test('at a short viewport the menu stays inside the screen, and its last control stays on it (#2067)', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  // 844x390 — a landscape phone. On `origin/dev` this is where the 430px box
  // ran 93px off the bottom.
  await page.setViewportSize({ width: 844, height: 390 })
  await openTallestWalletMenu(page)

  const geo = await readGeometry(page)

  // The page cannot rescue an overhang — which is what makes the next
  // assertion about reachability rather than tidiness.
  expect(geo.documentScrollable).toBe(false)

  // The bound itself, stated as the user's experience: the menu ends on screen.
  expect(geo.bottom).toBeLessThanOrEqual(geo.innerHeight)

  // And it is a real clamp, not an accident of content: the menu is shorter
  // than its own content wants to be.
  expect(geo.scrollerScrollHeight).toBeGreaterThan(geo.scrollerClientHeight)

  // Disconnect is the control a user opens this menu to reach in a hurry.
  expect(geo.lastControlText).toBe('Disconnect')
  expect(geo.lastControlBottom).toBeLessThanOrEqual(geo.innerHeight)

  expect(pageErrors).toEqual([])
})

test('what the bound pushes out of view is still reachable — by keyboard and by wheel — with the ring intact (#2067)', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.setViewportSize({ width: 844, height: 390 })
  const popover = await openTallestWalletMenu(page)

  // The LAST Copy button lives in the secondary section, at the bottom of the
  // scroll box — the part the clamp hides at this viewport.
  const copies = popover.getByRole('button', { name: 'Copy' })
  await expect(copies).toHaveCount(2)
  const hidden = copies.last()

  // "Out of view" here means clipped by the SCROLL BOX, not off the screen —
  // the whole point of the bound is that the menu no longer leaves the screen,
  // so the viewport is the wrong ruler for what the clamp hid.
  const before = await hidden.evaluate((el) => {
    const scroller = el.closest('[role="dialog"]')!.querySelector(
      '[data-wallet-menu-scroll]',
    ) as HTMLElement
    const s = scroller.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    return { clipped: b.bottom > s.bottom || b.top < s.top }
  })
  expect(before.clipped).toBe(true)

  // Keyboard focus — not a programmatic scroll — is what has to reach it.
  await hidden.focus()

  const after = await hidden.evaluate((el) => {
    const scroller = el.closest('[role="dialog"]')!.querySelector(
      '[data-wallet-menu-scroll]',
    ) as HTMLElement
    const s = scroller.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    const style = getComputedStyle(scroller)
    // The clip edge of an `overflow` box is its PADDING edge.
    const clip = {
      top: s.top + parseFloat(style.borderTopWidth),
      bottom: s.bottom - parseFloat(style.borderBottomWidth),
      left: s.left + parseFloat(style.borderLeftWidth),
      right: s.right - parseFloat(style.borderRightWidth),
    }
    return {
      focused: document.activeElement === el,
      // Fully inside the scroll box's clip rect AND inside the screen.
      inView:
        b.top >= clip.top - 0.5 &&
        b.bottom <= clip.bottom + 0.5 &&
        b.top >= 0 &&
        b.bottom <= window.innerHeight,
      // Smallest gap between the control and the edge that would clip its ring.
      ringGutter: Math.min(b.left - clip.left, clip.right - b.right, b.top - clip.top, clip.bottom - b.bottom),
    }
  })

  expect(after.focused).toBe(true)
  // The browser scrolled it into view because it is a real tab stop inside a
  // real scroll container — the bound did not strand it.
  expect(after.inView).toBe(true)
  // #1873: the ring paints OUTSIDE the border box, so the scroll container must
  // leave room for it rather than clip the very affordance focus depends on.
  expect(after.ringGutter).toBeGreaterThanOrEqual(RING_PX)

  // ── The POINTER half, and it is not redundant ──────────────────────────────
  //
  // Measured while mutation-proving this spec: swapping `overflow-y-auto` for
  // `overflow-hidden` left every assertion above GREEN. `overflow: hidden` is
  // still a scroll container — it just cannot be scrolled by the user — so
  // `el.focus()` scrolls it programmatically and the keyboard path survives a
  // change that strands every mouse and touch user. A wheel gesture is the
  // assertion that discriminates them.
  const scroller = popover.locator('[data-wallet-menu-scroll]')
  await scroller.evaluate((el) => {
    el.scrollTop = 0
  })
  const box = (await scroller.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 200)
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0)

  expect(pageErrors).toEqual([])
})

test('the clamped menu SAYS there is more above the actions, and stops once there is not (#2067)', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.setViewportSize({ width: 844, height: 390 })
  const popover = await openTallestWalletMenu(page)

  // haven-design-reviewer on this PR: the clamped box ended mid-line on
  // "Network: Base" with no gradient and no scrollbar thumb, which reads as
  // truncated rather than scrollable. This is Modal's own cue (#1893), reused.
  const cue = popover.locator('[data-wallet-menu-scroll-cue]')
  await expect(cue).toBeVisible()

  // And it is a CUE, not decoration: scroll to the end and it goes away.
  const scroller = popover.locator('[data-wallet-menu-scroll]')
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(cue).toHaveCount(0)

  expect(pageErrors).toEqual([])
})

test('positive control: at 1280x800 the bound does not fire and the menu is unchanged (#2067)', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.setViewportSize({ width: 1280, height: 800 })
  await openTallestWalletMenu(page)

  const geo = await readGeometry(page)

  // The tallest state at an evidence viewport: 430px, well inside 800px. A
  // clamp that changed THIS would be a regression dressed as a fix, so the
  // control asserts the box is its natural height — nothing scrolls.
  expect(geo.bottom).toBeLessThanOrEqual(geo.innerHeight)
  expect(geo.scrollerScrollHeight).toBe(geo.scrollerClientHeight)
  expect(geo.height).toBeGreaterThan(400)

  expect(pageErrors).toEqual([])
})
