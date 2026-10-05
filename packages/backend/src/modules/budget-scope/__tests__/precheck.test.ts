// db-mock-exempt: pure module test — the chain read is injected, nothing touches the DB
/**
 * #3616 — the period pre-check evaluator, characterized against
 * `routes/__tests__/payments-period-budget.test.ts` (the reference semantics)
 * and the x402 legs' identical posture:
 *
 * - every link is read, the SMALLEST readable remaining decides;
 * - a link that throws or answers `fromChain: false` fails OPEN (contributes
 *   nothing) — the enforcer stays the gate;
 * - refuse only on `remaining < amount` — `<`, never `<=` (spending the
 *   exact remainder is what the chain allows);
 * - no usable measurement at all → no refusal.
 */
import { describe, expect, it } from 'vitest'
import { evaluatePeriodPrecheck } from '../precheck.js'

const CHAIN = 84532
const AMOUNT = 5000n
const read = (remainingAtomic: string, fromChain: boolean) => async () => ({ remainingAtomic, fromChain })

describe('evaluatePeriodPrecheck — POST /payments semantics (#3503, lifted)', () => {
  it('refuses when the single link cannot cover the amount (payments-period-budget.test.ts:218)', async () => {
    const out = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-a'],
      read: read('500', true),
    })
    expect(out).toEqual({ refused: true, remainingAtomic: 500n, readableLinks: 1, failedOpenLinks: 0 })
  })

  it('does NOT refuse when remaining === amount — `<`, never `<=`', async () => {
    const out = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-a'],
      read: read('5000', true),
    })
    expect(out.refused).toBe(false)
    expect(out.remainingAtomic).toBe(5000n)
  })

  it('does not refuse when the link comfortably covers the amount (:243)', async () => {
    const out = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-a'],
      read: read('10000', true),
    })
    expect(out.refused).toBe(false)
  })

  it('MUTATION WITNESS (a): min-of-links — the LAST link going short reddens', async () => {
    // The scan's M3: a suite reading only the first link passes 11/11 even
    // when the min was replaced by the first read. These two witnesses hold
    // only while the reducer takes the smallest across ALL links.
    const out = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-grant', 'json-parent-child', 'json-budget'],
      read: async (_chain: number, json: string) =>
        json === 'json-budget' ? { remainingAtomic: '500', fromChain: true } : { remainingAtomic: '10000', fromChain: true },
    })
    expect(out.refused).toBe(true)
    expect(out.remainingAtomic).toBe(500n)

    // And the inverse: the FIRST link short, later links flush — a
    // last-link reducer would also miss this.
    const out2 = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-grant', 'json-parent-child', 'json-budget'],
      read: async (_chain: number, json: string) =>
        json === 'json-grant' ? { remainingAtomic: '0', fromChain: true } : { remainingAtomic: '10000', fromChain: true },
    })
    expect(out2.refused).toBe(true)
    expect(out2.remainingAtomic).toBe(0n)
  })

  it('reads every link of the sub-budget chain (all three)', async () => {
    const reads: string[] = []
    await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-grant', 'json-parent-child', 'json-budget'],
      read: async (_chain: number, json: string) => {
        reads.push(json)
        return { remainingAtomic: '10000', fromChain: true }
      },
    })
    expect(reads).toEqual(['json-grant', 'json-parent-child', 'json-budget'])
  })

  it('MUTATION WITNESS (c): a thrown read on one link fails OPEN, the others still decide', async () => {
    const out = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-throws', 'json-ok'],
      read: async (_chain: number, json: string) => {
        if (json === 'json-throws') throw new Error('rpc degraded')
        return { remainingAtomic: '10000', fromChain: true }
      },
    })
    // Fails open per link, yet the readable link still refuses — exactly the
    // fail-open-but-still-decides posture the x402 legs have.
    expect(out.refused).toBe(false)
    expect(out.failedOpenLinks).toBe(1)
    expect(out.readableLinks).toBe(1)

    const out2 = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-throws', 'json-short'],
      read: async (_chain: number, json: string) => {
        if (json === 'json-throws') throw new Error('rpc degraded')
        return { remainingAtomic: '100', fromChain: true }
      },
    })
    expect(out2.refused).toBe(true)
    expect(out2.remainingAtomic).toBe(100n)

    // Mirror order: the readable SHORT link first, the thrown link LAST. A
    // mutant that lets a failed-open link VETO the decision (clearing the
    // running minimum instead of skipping it) survives the two cases above —
    // the readable sibling overwrites the veto — and only reddens here.
    const out3 = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-short', 'json-throws'],
      read: async (_chain: number, json: string) => {
        if (json === 'json-throws') throw new Error('rpc degraded')
        return { remainingAtomic: '100', fromChain: true }
      },
    })
    expect(out3.refused).toBe(true)
    expect(out3.remainingAtomic).toBe(100n)
    expect(out3.failedOpenLinks).toBe(1)
    expect(out3.readableLinks).toBe(1)
  })

  it('MUTATION WITNESS (c2): `fromChain: false` on one link is the same fail-open', async () => {
    const out = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-degraded', 'json-ok'],
      read: async (_chain: number, json: string) =>
        json === 'json-degraded' ? { remainingAtomic: '0', fromChain: false } : { remainingAtomic: '10000', fromChain: true },
    })
    // The degraded link's optimistic '0' must NOT decide — failing open on
    // it while the healthy link clears the amount proceeds (:266).
    expect(out.refused).toBe(false)
    expect(out.failedOpenLinks).toBe(1)
  })

  it('every link degraded: no refusal at all (:266 — fromChain false proceeds)', async () => {
    const out = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-a', 'json-b'],
      read: read('0', false),
    })
    expect(out.refused).toBe(false)
    expect(out.remainingAtomic).toBeNull()
    expect(out.readableLinks).toBe(0)
    expect(out.failedOpenLinks).toBe(2)
  })

  it('every link throws: no refusal at all — the enforcer remains the gate', async () => {
    const out = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-a'],
      read: async () => {
        throw new Error('rpc down')
      },
    })
    expect(out.refused).toBe(false)
    expect(out.remainingAtomic).toBeNull()
  })

  it('MUTATION WITNESS (b): `<` → `<=` reddens — a remaining EQUAL to the amount must pass', async () => {
    // The mutation `remainingAtomic < amountAtomic` → `<=` refuses a payment
    // spending the exact remainder; this assertion is the red it produces.
    const out = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-a', 'json-b'],
      read: async (_chain: number, json: string) =>
        json === 'json-a' ? { remainingAtomic: '7000', fromChain: true } : { remainingAtomic: '5000', fromChain: true },
    })
    expect(out.refused).toBe(false)
    expect(out.remainingAtomic).toBe(5000n)
  })

  it('no links at all (e.g. no delegation): no refusal', async () => {
    const out = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: [],
      read: read('10000', true),
    })
    expect(out.refused).toBe(false)
    expect(out.readableLinks).toBe(0)
  })

  it('a malformed remaining string fails that link open instead of 500ing', async () => {
    const out = await evaluatePeriodPrecheck({
      chainId: CHAIN,
      amountAtomic: AMOUNT,
      delegationJsons: ['json-malformed', 'json-ok'],
      read: async (_chain: number, json: string) =>
        json === 'json-malformed' ? { remainingAtomic: 'not-a-number', fromChain: true } : { remainingAtomic: '10000', fromChain: true },
    })
    expect(out.refused).toBe(false)
    expect(out.failedOpenLinks).toBe(1)
  })
})
