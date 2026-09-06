import { describe, expect, it } from 'vitest'
import { describeObserverRpc } from './chain.js'

/**
 * The observer-RPC announcement must never print the endpoint (#2511).
 *
 * A provider URL embeds an API key, and this line goes to a CI log that is
 * public on a public repo and gets quoted into `qa-failure` issue bodies. The
 * repo's secret-safety rule is the same for a run report as for a credential
 * file, so it is asserted rather than trusted to a ternary.
 *
 * The other half is why the function exists at all: between PR #2553 and this
 * change, `QA_RPC_URL_BASE_SEPOLIA` was read by `chain.ts` and passed in by
 * nothing, so an operator could file the secret and the observer would stay on
 * the public endpoint. A set variable and an unset one produced identical
 * logs, which is precisely what let it sit unreachable.
 */
describe('describeObserverRpc (#2511)', () => {
  const SECRET = 'https://base-sepolia.g.alchemy.com/v2/NOT-A-REAL-KEY'

  it('never puts the endpoint in the line it produces', () => {
    const line = describeObserverRpc(SECRET)
    expect(line).not.toContain('NOT-A-REAL-KEY')
    expect(line).not.toContain('alchemy')
    // Positive control: the matcher finds the key when it IS present, so the
    // two negatives above are facts about the line and not about `toContain`.
    expect(`observer RPC → ${SECRET}`).toContain('NOT-A-REAL-KEY')
  })

  it('says WHICH class, so a triager can tell the two runs apart', () => {
    expect(describeObserverRpc(SECRET)).toMatch(/^dedicated/)
    expect(describeObserverRpc(undefined)).toMatch(/^PUBLIC/)
    // The distinction is the whole point: identical output for set and unset
    // is the state that hid the missing wiring.
    expect(describeObserverRpc(SECRET)).not.toBe(describeObserverRpc(undefined))
  })

  it('treats blank and whitespace as unset, matching BASE_SEPOLIA_RPC', () => {
    // `chain.ts` resolves the endpoint with `?.trim() ||`, so a variable set to
    // spaces falls back to the public node. The announcement has to agree, or
    // it would report `dedicated` for a run observing the public endpoint —
    // worse than no line at all.
    for (const blank of ['', '   ', '\t\n']) {
      expect(describeObserverRpc(blank), JSON.stringify(blank)).toMatch(/^PUBLIC/)
    }
  })

  it('names the consequence, not just the endpoint class', () => {
    // The line exists to stop an availability failure being triaged as a
    // defect, so it has to say that is what it means.
    expect(describeObserverRpc(undefined)).toContain('read as scenario failures')
  })
})
