/**
 * The contacts dialog's action row is reachable without scrolling (#1946).
 *
 * ## What was measured, before anything was moved
 *
 * #1946 named three dialogs that render their action row as the last children
 * *inside* `ui/Modal`'s scroll body, and said explicitly that its own premise
 * was unmeasured. It was measured, in this browser, at the evidence viewports
 * and at every short viewport a real user reaches. Only ONE of the three could
 * be made to overflow anywhere reachable:
 *
 * | dialog | 1280x800 | 390x844 | 844x390 | 640x400 |
 * |---|---|---|---|---|
 * | contacts, duplicate-address hint showing | 0 | 0 | **37px below fold** | **27px** |
 * | contacts, save-error box showing | 0 | 0 | **98px** | **89px** |
 * | `DelegationSendModal` | 0 | 0 | 0 | 0 |
 * | `ComingSoonModal` | 0 | 0 | 0 | 0 |
 *
 * `DelegationSendModal` and `ComingSoonModal` need a viewport shorter than
 * ~340px to hide their action rows at all, which is not a viewport this app
 * supports, so they were left alone rather than restructured for symmetry —
 * `DelegationSendModal` especially, being a money-movement dialog covered by a
 * contract doc.
 *
 * The two viewports below are therefore not decoration. **844x390** is a phone
 * in landscape. **640x400** is a 1280x800 desktop at 200% browser zoom, which
 * WCAG 1.4.4 requires to work. Both hid the primary action before this change.
 *
 * ## Why the assertions read the way they do
 *
 * `role="dialog"` sits on `ui/Modal`'s `fixed inset-0` wrapper, which never
 * scrolls — reading scroll geometry off it yields `scrollHeight ===
 * clientHeight` forever, a check that cannot fail. The scroller is
 * `[data-modal-body]`. So "reachable" is asserted two ways that fail for
 * different reasons: the row must not be a DESCENDANT of the scroll box
 * (structure), and it must be fully within the viewport at rest (geometry).
 * A structural-only assertion would pass on a footer that overflowed the
 * panel; a geometric-only one would pass on a body that happened to fit today.
 */
import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, testRecipientAddress } from './fixtures/haven-api'

const BODY = '[data-modal-body]'

/** The two viewports at which the pre-#1946 markup measurably hid the button. */
const SHORT_VIEWPORTS = [
  { name: 'landscape phone 844x390', width: 844, height: 390 },
  { name: '200% browser zoom 640x400', width: 640, height: 400 },
]

async function openAddContact(page: Page) {
  await page.goto('/contacts')
  await page.getByRole('button', { name: 'Add contact' }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

/** The submit button, which is the one that must stay reachable. */
function submitButton(page: Page) {
  return page.getByRole('dialog').getByRole('button', { name: 'Add contact', exact: true })
}

async function reachability(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector('[data-modal-body]') as HTMLElement | null
    const buttons = Array.from(document.querySelectorAll('[role="dialog"] button'))
    const submit = buttons.find(
      (b) => (b as HTMLButtonElement).type === 'submit',
    ) as HTMLButtonElement | undefined
    if (!body || !submit) return { found: false as const, hasBody: !!body, hasSubmit: !!submit }
    const rect = submit.getBoundingClientRect()
    return {
      found: true as const,
      insideScrollBody: body.contains(submit),
      bodyOverflow: body.scrollHeight - body.clientHeight,
      // Fully inside the viewport at rest — nothing clipped off the bottom.
      hiddenBelowViewport: Math.round(Math.max(0, rect.bottom - window.innerHeight)),
      // Hit-testable at its own centre, i.e. nothing is covering it.
      hitTestsToSelf: (() => {
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        )
        return !!hit && (hit === submit || submit.contains(hit))
      })(),
      formAttribute: submit.getAttribute('form'),
      formOwnerMatches: submit.form !== null && submit.form === document.getElementById(
        submit.getAttribute('form') ?? '',
      ),
    }
  })
}

test.describe('contacts dialog — action row reachability (#1946)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  for (const vp of SHORT_VIEWPORTS) {
    test(`the Add contact button is reachable at ${vp.name}, with the body overflowing`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await openAddContact(page)

      // Force the duplicate-address hint — the state that made this dialog
      // overflow in the first place.
      await page.getByLabel('Contact name').fill('Duplicate vendor')
      await page.locator('#contact-address').fill(testRecipientAddress)
      await expect(
        page.getByRole('dialog').getByText('This address is already saved as'),
      ).toBeVisible()

      const m = await reachability(page)
      expect(m.found, 'the dialog must expose a scroll body and a submit button').toBe(true)
      if (!m.found) return

      // MEASURED, not assumed. If the dialog ever stops overflowing here, this
      // spec must say so rather than quietly passing its real assertions for a
      // reason that has nothing to do with #1946.
      expect(
        m.bodyOverflow,
        `the contacts body must actually overflow at ${vp.name}, or this test proves nothing`,
      ).toBeGreaterThan(0)

      // Structure: the actions are a flex SIBLING of the scroll box, so they
      // cannot scroll away with the content.
      expect(
        m.insideScrollBody,
        'the action row must not be inside [data-modal-body]',
      ).toBe(false)

      // Geometry: and the button is wholly on screen at rest.
      expect(
        m.hiddenBelowViewport,
        'no part of the submit button may sit below the viewport',
      ).toBe(0)
      expect(m.hitTestsToSelf, 'the submit button must be hit-testable').toBe(true)
    })
  }

  test('the footer submit button still owns the form in the body', async ({ page }) => {
    // The footer renders outside the body, so the submit button is no longer a
    // DESCENDANT of the `<form>`. It reaches it by the HTML `form` attribute —
    // asserted here as a resolved form OWNER rather than as a matching string,
    // because a stale or duplicated id would compare equal and still submit
    // nothing.
    await page.setViewportSize({ width: 1280, height: 800 })
    await openAddContact(page)

    const m = await reachability(page)
    expect(m.found).toBe(true)
    if (!m.found) return
    expect(m.formAttribute, 'the submit button must carry a form attribute').toBeTruthy()
    expect(
      m.formOwnerMatches,
      'the form attribute must resolve to the form element in the body',
    ).toBe(true)
  })

  test('Enter in a text field still submits, with the button outside the form', async ({
    page,
  }) => {
    // The regression that a `type="button"` + `onClick` rewiring would have
    // introduced silently. Implicit submission is the reason the `form`
    // attribute was used instead.
    let posted = false
    await page.route('**/api/contacts', async (route) => {
      if (route.request().method() === 'POST') {
        posted = true
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'contact-new',
            name: 'Keyboard vendor',
            address: '0x5555555555555555555555555555555555555555',
            created_at: '2026-08-24T10:00:00.000Z',
          }),
        })
        return
      }
      await route.fallback()
    })

    await page.setViewportSize({ width: 1280, height: 800 })
    await openAddContact(page)
    await page.getByLabel('Contact name').fill('Keyboard vendor')
    await page.locator('#contact-address').fill('0x5555555555555555555555555555555555555555')
    await page.locator('#contact-address').press('Enter')

    await expect
      .poll(() => posted, { message: 'Enter must submit the contacts form' })
      .toBe(true)
  })

  test('the scroll cue still marks the body edge, and no longer sits over a button', async ({
    page,
  }) => {
    // #1893's cue is unchanged and still correct: it marks where the BODY runs
    // out. What changed is what is underneath it — content now, rather than the
    // primary action.
    await page.setViewportSize({ width: 844, height: 390 })
    await openAddContact(page)
    await page.getByLabel('Contact name').fill('Duplicate vendor')
    await page.locator('#contact-address').fill(testRecipientAddress)
    await expect(
      page.getByRole('dialog').getByText('This address is already saved as'),
    ).toBeVisible()

    const cue = page.locator('[data-modal-scroll-cue]')
    await expect(cue).toBeVisible()

    const overlapsSubmit = await page.evaluate(() => {
      const marker = document.querySelector('[data-modal-scroll-cue]') as HTMLElement
      const submit = Array.from(
        document.querySelectorAll('[role="dialog"] button'),
      ).find((b) => (b as HTMLButtonElement).type === 'submit') as HTMLElement
      const a = marker.getBoundingClientRect()
      const b = submit.getBoundingClientRect()
      return !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right)
    })
    expect(overlapsSubmit, 'the cue must no longer overlap the primary action').toBe(false)
  })
})
