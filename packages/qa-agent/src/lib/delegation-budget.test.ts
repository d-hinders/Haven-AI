/**
 * `readOnchainBudget` is what keeps the two over-budget legs honest (#2016):
 * it is the thing that establishes the leg asked an over-budget question at
 * all. Every branch that can hand back a number therefore has to be provably
 * unable to hand back a number it should have refused.
 *
 * Added on a `haven-reviewer` finding: three branches were reachable only
 * indirectly through the scenario tests and two were not exercised anywhere.
 */
import { describe, it, expect } from 'vitest'
import type { HavenApi } from './haven-api.js'
import { overBudgetAmount, readOnchainBudget } from './delegation-budget.js'

const api = (status: number, data: unknown): HavenApi =>
  ({ getAllowances: async () => ({ ok: status < 400, status, data }) }) as unknown as HavenApi

const row = (onchain: unknown) => ({
  allowances: [{ token_symbol: 'USDC', configured_amount: '1.00', onchain }],
})

describe('readOnchainBudget', () => {
  it('returns the live remaining budget (positive control)', async () => {
    const r = await readOnchainBudget(api(200, row({ remaining: '1000000', remaining_is_from_chain: true })))
    expect(r).toEqual({ remaining: 1_000_000n, configured: '1.00' })
  })

  it('refuses when the allowances read itself failed', async () => {
    const r = await readOnchainBudget(api(500, { error: 'boom' }))
    expect(r).toHaveProperty('error')
    expect((r as { error: string }).error).toMatch(/could not read/)
  })

  it('refuses when the agent has no budget for the token', async () => {
    const r = await readOnchainBudget(api(200, { allowances: [] }))
    expect((r as { error: string }).error).toMatch(/no USDC budget/)
  })

  it('refuses when the row carries no on-chain reading at all', async () => {
    const r = await readOnchainBudget(api(200, row(undefined)))
    expect((r as { error: string }).error).toMatch(/no on-chain reading/)
  })

  it('refuses when `remaining` is missing from the on-chain block', async () => {
    const r = await readOnchainBudget(api(200, row({ remaining_is_from_chain: true })))
    expect((r as { error: string }).error).toMatch(/no on-chain reading/)
  })

  it('refuses a FALLBACK reading rather than building an amount from it', async () => {
    const r = await readOnchainBudget(api(200, row({ remaining: '1000000', remaining_is_from_chain: false })))
    expect((r as { error: string }).error).toMatch(/FALLBACK/)
  })

  it('refuses an already-exhausted budget — every amount would be refused', async () => {
    const r = await readOnchainBudget(api(200, row({ remaining: '0', remaining_is_from_chain: true })))
    expect((r as { error: string }).error).toMatch(/exhausted/)
  })

  it('accepts a reading whose provenance flag is simply absent (older backend)', async () => {
    // Only an explicit `false` means fallback; an absent flag is not evidence
    // of one, and refusing it would make the leg unrunnable against a backend
    // that predates #1319 rather than more honest.
    const r = await readOnchainBudget(api(200, row({ remaining: '500' })))
    expect(r).toEqual({ remaining: 500n, configured: '1.00' })
  })
})

describe('overBudgetAmount', () => {
  it('is strictly above the remaining budget', () => {
    for (const remaining of [1n, 500n, 1_000_000n, 999_999_999n]) {
      expect(overBudgetAmount(remaining) > remaining).toBe(true)
    }
  })

  /**
   * The refusal says why THIS caller cannot use a fallback (#2594).
   *
   * Both uses must refuse — that is #2016 and is unchanged. What #2594 fixes is
   * that the reason travels into the run report, where a wrong one teaches a
   * reader something false about a leg. On 2026-09-06 four scenarios failed
   * together and `within-budget-settle`'s line said it was "refusing to build an
   * over-budget amount". It makes a floor check; it builds no such thing.
   */
  describe('the fallback refusal is about the caller that got it (#2594)', () => {
    const fallback = api(200, row({ remaining: '1000000', remaining_is_from_chain: false }))

    it('still refuses for BOTH uses — the #2016 property is untouched', async () => {
      for (const use of ['ceiling', 'floor'] as const) {
        const r = await readOnchainBudget(fallback, 'USDC', use)
        expect(r, use).toHaveProperty('error')
        expect((r as { error: string }).error, use).toMatch(/FALLBACK, not a live enforcer read/)
      }
    })

    it('gives the ceiling caller the over-budget reason, and only it', async () => {
      const r = await readOnchainBudget(fallback, 'USDC', 'ceiling')
      expect((r as { error: string }).error).toMatch(/refusing to build an over-budget amount/)
    })

    it('gives the floor caller a reason about ITS use, never the over-budget one', async () => {
      const r = await readOnchainBudget(fallback, 'USDC', 'floor')
      const { error } = r as { error: string }
      // The whole finding: this string reached a run report for a leg that
      // never builds one.
      expect(error).not.toMatch(/over-budget amount/)
      // And it says the thing a reader of that report needs: the fallback is
      // optimistic, so clearing the floor would prove nothing.
      expect(error).toMatch(/FULL configured budget/)
      expect(error).toMatch(/settlement failure for a budget that was simply spent/)
    })

    it('defaults to the ceiling reason, so an un-migrated caller is unchanged', async () => {
      const explicit = await readOnchainBudget(fallback, 'USDC', 'ceiling')
      const implicit = await readOnchainBudget(fallback)
      expect(implicit).toEqual(explicit)
    })
  })
})
