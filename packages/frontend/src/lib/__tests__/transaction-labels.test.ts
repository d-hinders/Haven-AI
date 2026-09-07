import { describe, expect, it } from 'vitest'
import {
  isMachinePaymentSource,
  parseX402Hostname,
  paymentSourceTitle,
} from '../transaction-labels'

/**
 * #2357 — `paymentSourceTitle` is the PRIMARY title of a transaction row on
 * `DashboardClient.tsx`, `TransactionsTable.tsx`, `TransactionDetailPanel.tsx`
 * and `AgentDetailClient.tsx`. Two defects shipped in it: the word "demo" in a
 * real payment's title, and a bare protocol identifier leading the row people
 * scan.
 *
 * These guards are deliberately literal string checks over the function's
 * RETURN VALUES — `ship-next` § Rework caps rule 1: guard the code that
 * generates the text, never write an assertion that has to interpret a
 * sentence. They cannot tell good copy from bad; they pin the two specific
 * shapes this issue removed, so a re-introduction fails here rather than in a
 * design review six weeks later. The copy lint cannot do this job — it is
 * multi-word-literal by design and neither defect contains a banned phrase
 * (`docs/product/copy-guidelines.md` § Enforcement says so explicitly).
 *
 * Note the file-level `not.toContain` form is NOT available here: the source
 * legitimately contains `'mpp_demo'` and `'x402'` as `source` comparison
 * literals. The values are what render, so the values are what is asserted.
 */

// Every source `isMachinePaymentSource` recognises — the exact set that gets a
// title from `paymentSourceTitle`.
const MACHINE_PAYMENT_SOURCES = ['x402', 'mpp_demo'] as const

describe('paymentSourceTitle (#2357)', () => {
  // POSITIVE CONTROL, and it is mandatory: without it every negative assertion
  // below is satisfied by making the function return null for everything.
  it('still titles both machine-payment sources, and nothing else', () => {
    for (const source of MACHINE_PAYMENT_SOURCES) {
      expect(isMachinePaymentSource(source)).toBe(true)
      expect(paymentSourceTitle(source)).toBeTruthy()
    }

    for (const source of ['direct', 'api', 'mpp_crypto', 'spt', 'stripe_deposit', '', null, undefined]) {
      expect(paymentSourceTitle(source)).toBeNull()
    }
  })

  it('pins the shipped copy', () => {
    expect(paymentSourceTitle('x402')).toBe('Agent payment')
    expect(paymentSourceTitle('mpp_demo')).toBe('Machine payment')
  })

  it('never calls a real payment a demo', () => {
    for (const source of MACHINE_PAYMENT_SOURCES) {
      expect(paymentSourceTitle(source)).not.toMatch(/demo/i)
    }
  })

  it('never leads a row title with a bare protocol or rail identifier', () => {
    // The identifiers that reach this function as `source` values. A title
    // containing one is the row saying "x402" / "mpp" to a user, which
    // `copy-guidelines.md` § Core principle rules out for a primary surface.
    // Technical vocabulary stays legal on the detail drawer — that is where
    // `TransactionDetailPanel`'s "x402 payment" heading and `settlementScheme`
    // label live, and neither goes through this function.
    for (const source of MACHINE_PAYMENT_SOURCES) {
      const title = paymentSourceTitle(source) ?? ''
      expect(title).not.toMatch(/x402/i)
      expect(title).not.toMatch(/\bmpp\b/i)
      expect(title).not.toMatch(/eip[-\s]?3009|erc[-\s]?7710/i)
    }
  })
})

describe('parseX402Hostname', () => {
  it('returns the hostname, and null for anything unparseable', () => {
    expect(parseX402Hostname('https://research.example/report?q=1')).toBe('research.example')
    expect(parseX402Hostname('not a url')).toBeNull()
    expect(parseX402Hostname(null)).toBeNull()
    expect(parseX402Hostname(undefined)).toBeNull()
  })
})
