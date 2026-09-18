/**
 * #3018: the capability-aware skip decisions of the conformance runner,
 * pinned. A skip exists so a connector that CANNOT truthfully meet an
 * assertion does not fail it — but a skip is also a hole in the contract's
 * executable form, so exactly which cases each shape skips is itself under
 * test:
 *
 *  - Fortnox and the in-memory connector run EVERY case unchanged: their
 *    skip set is empty, and the runner's ACTUAL skip decisions — the same
 *    `caseSkipped` predicates its `skip()` calls execute — are all false,
 *    so 13 tests run and none skip.
 *  - Accounted (document-only, verify-from-record, currency-null) skips
 *    exactly cases 3/6 (attachment), case 4's booking halves, and cases
 *    7/7b/7c/7d (base currency) — nothing else.
 */
import { describe, expect, it } from 'vitest'
import { caseSkipped, conformanceSkipsFor, skippableCases, type ConformanceHarness } from './connector-conformance.js'
import type { AccountingProvider } from '../provider.js'
import { ACCOUNTED, FORTNOX } from '../registry.js'

const FULL_CAPABILITIES = { attachments: true, verify: true, revoke: true, companyInfo: true }
/** Every case number the runner can skip — the runner registers them itself. */
const ALL_CASES = skippableCases()

function harnessFor(provider: AccountingProvider, declares?: { baseCurrency?: boolean }): ConformanceHarness {
  return {
    provider,
    ...(declares ? { declares } : {}),
    setup: () => {
      throw new Error('not used by the skip decision')
    },
  }
}

/** The case numbers a shape's vector actually SKIPS, through the runner's own predicates. */
function executedSkips(skips: ReturnType<typeof conformanceSkipsFor>): string[] {
  return ALL_CASES.filter((caseNo) => caseSkipped(caseNo, skips))
}

describe('connector conformance skip decisions (#3018)', () => {
  it('every skippable case the runner can skip is pinned — no unregistered skip', () => {
    // The predicate table IS the runner's decision surface; this pins its
    // exact membership so a case added with a skip() but no predicate (a
    // silent skip) fails here.
    expect(ALL_CASES).toEqual(['3', '4', '6', '7', '7b', '7c', '7d'])
  })

  it('Fortnox runs every case unchanged — no modeled skips, and the runner executes none', () => {
    const skips = conformanceSkipsFor(harnessFor(FORTNOX))
    expect(skips).toEqual({ attachmentCases: false, bookingHalves: false, baseCurrencyCases: false, reasons: [] })
    // ACTUAL skip decisions: zero — 13 tests run, 0 skipped.
    expect(executedSkips(skips)).toEqual([])
  })

  it('the in-memory connector runs every case unchanged — no modeled skips, and the runner executes none', () => {
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
    // ACTUAL skip decisions: zero — 13 tests run, 0 skipped.
    expect(executedSkips(skips)).toEqual([])
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
    expect(skips.reasons.join('\n')).toContain('cases 7, 7b, 7c, 7d')
    // ACTUAL decisions: 3, 4, 6, 7, 7b, 7c, 7d skipped — nothing else.
    // (6b runs: the pre-push refusal is proven through the real api-key
    // connector's own error map, so it needs no capability.)
    expect(executedSkips(skips)).toEqual(['3', '4', '6', '7', '7b', '7c', '7d'])
  })

  it('a verify-capable currency-null harness skips ONLY the base-currency cases', () => {
    // Shape isolation: the `declares.baseCurrency: false` knob moves nothing
    // but the currency cases.
    const skips = conformanceSkipsFor(harnessFor(FORTNOX, { baseCurrency: false }))
    expect(skips.attachmentCases).toBe(false)
    expect(skips.bookingHalves).toBe(false)
    expect(skips.baseCurrencyCases).toBe(true)
    expect(skips.reasons).toHaveLength(1)
    expect(executedSkips(skips)).toEqual(['7', '7b', '7c', '7d'])
  })

  it('the foreign_invoice assertion runs for every shape — 4b has no skip predicate', () => {
    // Round-1 regression guard: case 4b (foreign_invoice / no_invoice_ref —
    // about OUR record's identity) must be unconditional. It is not in the
    // predicate table, so `caseSkipped` refuses it: no vector, present or
    // future, can gate it.
    expect(() => caseSkipped('4b', conformanceSkipsFor(harnessFor(ACCOUNTED, { baseCurrency: false })))).toThrow(/no skip predicate/)
    expect(() => caseSkipped('4b', conformanceSkipsFor(harnessFor(FORTNOX)))).toThrow(/no skip predicate/)
  })
})
