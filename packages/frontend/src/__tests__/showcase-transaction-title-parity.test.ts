/**
 * The `/design-system` showcase's machine-payment sample titles must be strings
 * the product can actually produce (#2448).
 *
 * ## The drift this closes
 *
 * #2357 changed `paymentSourceTitle` so `source: 'x402'` renders "Agent payment"
 * instead of "x402 payment", and moved the protocol name to
 * `TransactionDetailPanel`'s section heading (retired by #4267: the panel says
 * "Paid request" now). `/design-system` hardcodes row
 * titles as illustrative sample data, so its four copies of the old wording went
 * stale and NOTHING went red — the showcase is the page contributors read to
 * learn the house patterns, and it spent that window teaching retired copy.
 *
 * Three gates were each structurally unable to see it, which is why this file
 * exists rather than a rule in one of them:
 *
 * - the **copy lint** is multi-word-literal by design and "x402 payment" is not
 *   a banned phrase (`docs/product/copy-guidelines.md` § Enforcement says this
 *   of these exact strings);
 * - the **design-system coupling gate** only asks whether a newly exported
 *   `ui/**` / `haven/**` component APPEARS on the page. It has nothing to say
 *   about a showcase whose sample copy has gone stale;
 * - the **visual gate** works the other way round here. It goes red when someone
 *   FIXES the copy without regenerating baselines, and stays green forever while
 *   the copy is wrong.
 *
 * ## What is asserted, and why in this shape
 *
 * The expected strings are COMPUTED from the shipping functions —
 * `paymentSourceTitle` — never restated as literals. That
 * is the point: a fourth copy of the copy would go stale exactly the way the
 * showcase did. `ship-next` § Rework caps rule 1 is the governing rule (guard the
 * code that GENERATES the text; never write an assertion that has to interpret a
 * sentence), and both assertions here are literal string containment over a
 * derived value.
 *
 * ## What this guard CANNOT see — stated because the complement is the risk
 *
 * - It cannot see a stale sample kept ALONGSIDE a correct one. The positive
 *   assertion is satisfied by the current string being present; if a future
 *   change adds a new correct row and leaves an old row untouched, this stays
 *   green. The `not.toContain` below closes that hole for the ONE literal #2448
 *   removed, and for no other.
 * - The `not.toContain` is scoped to this single file on the basis that the file
 *   has no legitimate use of "x402 payment" today. It is NOT a repo-wide ban;
 *   the detail panel's own absence pin (`TransactionDetailPanel.test.tsx`,
 *   #4267) covers that surface.
 * - It reads SOURCE TEXT, not the DOM. It cannot tell a rendered title from one
 *   inside a JSX comment or behind a closed overlay, and it says nothing about
 *   layout, which is the pixel gate's job.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { paymentSourceTitle } from '@/lib/transaction-labels'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHOWCASE = path.resolve(HERE, '..', 'app/(authenticated)/design-system/page.tsx')

describe('/design-system machine-payment sample titles (#2448)', () => {
  const source = readFileSync(SHOWCASE, 'utf8')

  // POSITIVE CONTROL. Without it, both assertions below are satisfiable by
  // making the function return an empty string — `''` is contained in every
  // file, and `not.toContain('')` would then be the only thing failing.
  it('the shipping function still produces a non-empty machine-payment title', () => {
    expect(paymentSourceTitle('x402')).toBeTruthy()
  })

  it('shows the bare source title the product ships', () => {
    const shipped = paymentSourceTitle('x402')
    expect(source).toContain(`title="${shipped}"`)
  })

  // The agent-attributed row title ("Agent payment by <agent>") was pinned
  // here against the "Transaction history" table showcase. #4266 retired that
  // showcase with `TransactionsTable`, and #4267 retired `transactionTitle`
  // itself: the list rows and the detail panel lead with the counterparty.

  it('no longer carries the pre-#2357 wording anywhere in the file', () => {
    expect(source).not.toContain('x402 payment')
  })
})
