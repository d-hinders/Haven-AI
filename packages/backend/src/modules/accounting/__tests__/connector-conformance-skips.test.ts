/**
 * #3018: the capability-aware skip decisions of the conformance runner,
 * pinned. A skip exists so a connector that CANNOT truthfully meet an
 * assertion does not fail it — but a skip is also a hole in the contract's
 * executable form, so exactly which cases each shape skips is itself under
 * test:
 *
 *  - Fortnox and the in-memory connector run EVERY case unchanged: their
 *    skip set is empty (this is the acceptance criterion's "a test asserts
 *    their case count").
 *  - Accounted (document-only, verify-from-record, currency-null) skips
 *    exactly cases 3/6 (attachment), case 4's booking halves, and cases
 *    7/7c/7d (base currency) — nothing else.
 */
import { describe, expect, it } from 'vitest'
import { conformanceSkipsFor, type ConformanceHarness } from './connector-conformance.js'
import type { AccountingProvider } from '../provider.js'
import { ACCOUNTED, FORTNOX } from '../registry.js'

const FULL_CAPABILITIES = { attachments: true, verify: true, revoke: true, companyInfo: true }

function harnessFor(provider: AccountingProvider, declares?: { baseCurrency?: boolean }): ConformanceHarness {
  return {
    provider,
    ...(declares ? { declares } : {}),
    setup: () => {
      throw new Error('not used by the skip decision')
    },
  }
}

describe('connector conformance skip decisions (#3018)', () => {
  it('Fortnox runs every case unchanged — no skips, no reasons', () => {
    const skips = conformanceSkipsFor(harnessFor(FORTNOX))
    expect(skips).toEqual({ attachmentCases: false, bookingHalves: false, baseCurrencyCases: false, reasons: [] })
  })

  it('the in-memory connector runs every case unchanged — no skips, no reasons', () => {
    const memory: AccountingProvider = {
      id: 'memory',
      displayName: 'Memory',
      authKind: 'api_key',
      capabilities: FULL_CAPABILITIES,
      availability: 'live',
      requiredScopes: [],
    }
    const skips = conformanceSkipsFor(harnessFor(memory))
    expect(skips).toEqual({ attachmentCases: false, bookingHalves: false, baseCurrencyCases: false, reasons: [] })
  })

  it('Accounted skips exactly the attachment cases, the booking halves, and the base-currency cases', () => {
    const skips = conformanceSkipsFor(harnessFor(ACCOUNTED, { baseCurrency: false }))
    expect(skips.attachmentCases).toBe(true)
    expect(skips.bookingHalves).toBe(true)
    expect(skips.baseCurrencyCases).toBe(true)
    // Three printed reasons, one per skipped area, each naming the cases.
    expect(skips.reasons).toHaveLength(3)
    expect(skips.reasons.join('\n')).toContain('cases 3, 6')
    expect(skips.reasons.join('\n')).toContain("case 4's registered/booked/deleted halves")
    expect(skips.reasons.join('\n')).toContain('cases 7, 7c, 7d')
  })

  it('a verify-capable currency-null harness skips ONLY the base-currency cases', () => {
    // Shape isolation: the `declares.baseCurrency: false` knob moves nothing
    // but the currency cases.
    const skips = conformanceSkipsFor(harnessFor(FORTNOX, { baseCurrency: false }))
    expect(skips.attachmentCases).toBe(false)
    expect(skips.bookingHalves).toBe(false)
    expect(skips.baseCurrencyCases).toBe(true)
    expect(skips.reasons).toHaveLength(1)
  })
})
