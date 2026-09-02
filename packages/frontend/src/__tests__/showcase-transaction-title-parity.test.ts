/**
 * The `/design-system` showcase's machine-payment sample titles must be strings
 * the product can actually produce (#2448).
 *
 * ## The drift this closes
 *
 * #2357 changed `paymentSourceTitle` so `source: 'x402'` renders "Agent payment"
 * instead of "x402 payment", and moved the protocol name to
 * `TransactionDetailPanel`'s section heading. `/design-system` hardcodes row
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
 * `paymentSourceTitle` and `transactionTitle` — never restated as literals. That
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
 *   has no legitimate use of "x402 payment" today. It is NOT a repo-wide ban:
 *   `TransactionDetailPanel.tsx:168` renders that exact heading and is right to,
 *   because the detail drawer is the advanced surface the copy guidelines allow
 *   technical vocabulary on. If someone later showcases that heading on
 *   `/design-system`, this assertion is the thing that must be deleted with a
 *   reason — which is the intended cost, not a defect.
 * - It reads SOURCE TEXT, not the DOM. It cannot tell a rendered title from one
 *   inside a JSX comment or behind a closed overlay, and it says nothing about
 *   layout, which is the pixel gate's job.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { paymentSourceTitle } from '@/lib/transaction-labels'
import { transactionTitle } from '@/lib/transaction-presentation'
import type { AggregatedTransaction } from '@/types/transactions'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHOWCASE = path.resolve(HERE, '..', 'app/(authenticated)/design-system/page.tsx')

/** The agent the showcase's machine-payment sample rows are attributed to. */
const SHOWCASE_AGENT = 'Research assistant'

/**
 * The showcase's own x402 sample row, as an `AggregatedTransaction`. Only the
 * fields `transactionTitle` reads matter; the rest satisfy the wire type.
 */
function showcaseX402Row(
  overrides: Partial<AggregatedTransaction> = {},
): AggregatedTransaction {
  return {
    hash: '0x' + '12'.repeat(32),
    type: 'erc20',
    from: '0xA87300000000000000000000000000000000DD35',
    to: '0x135a9215604711AC70d970e12Caa812c53537EF4',
    value: '12000000',
    valueFormatted: '12.00',
    asset: 'USDC',
    decimals: 6,
    direction: 'out',
    timestamp: 1779436199,
    blockNumber: 45725826,
    isError: false,
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    tokenSymbol: 'USDC',
    chainId: 8453,
    safeId: 'safe-id',
    safeAddress: '0x135a9215604711AC70d970e12Caa812c53537EF4',
    safeName: 'Main Haven wallet',
    source: 'x402',
    ...overrides,
  }
}

describe('/design-system machine-payment sample titles (#2448)', () => {
  const source = readFileSync(SHOWCASE, 'utf8')

  // POSITIVE CONTROL. Without it, both assertions below are satisfiable by
  // making the functions return empty strings — `''` is contained in every
  // file, and `not.toContain('')` would then be the only thing failing.
  it('the shipping functions still produce non-empty machine-payment titles', () => {
    expect(paymentSourceTitle('x402')).toBeTruthy()
    expect(transactionTitle(showcaseX402Row({ agentName: SHOWCASE_AGENT }))).toBeTruthy()
  })

  it('shows the bare source title the product ships', () => {
    const shipped = paymentSourceTitle('x402')
    expect(source).toContain(`title="${shipped}"`)
  })

  it('shows the agent-attributed title the product ships', () => {
    const shipped = transactionTitle(showcaseX402Row({ agentName: SHOWCASE_AGENT }))
    expect(shipped).toContain(SHOWCASE_AGENT)
    expect(source).toContain(`title: '${shipped}'`)
  })

  it('no longer carries the pre-#2357 wording anywhere in the file', () => {
    expect(source).not.toContain('x402 payment')
  })
})
