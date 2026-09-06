import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  /**
   * No scenario puts the resolved endpoint into a string (#2511).
   *
   * `describeObserverRpc`'s guarantee covers the one line it was written for.
   * Three scenarios interpolated `BASE_SEPOLIA_RPC` straight into a `fail()`
   * detail — harmless while that constant was a hardcoded public URL, and a
   * live credential the moment `QA_RPC_URL_BASE_SEPOLIA` could hold a provider
   * key. Wiring the variable is what made those lines dangerous, so the guard
   * ships with the wiring (haven-reviewer, blocking).
   *
   * A `fail()` detail is not a scoped channel. It reaches the job's stdout,
   * and `printRunReport()` puts it in a markdown table the harness's own
   * header tells an operator to paste into `docs/bug-reports/` — i.e. commit
   * to a public repo. GitHub masks registered secrets in Actions logs, which
   * covers the CI path and neither of the other two: a local run prints the
   * raw value, and a pasted report carries it into git.
   *
   * The rule is about the SHAPE — the constant reaching a template literal —
   * not about any one message, because the next one will be written by someone
   * who never read this comment.
   */
  it('no scenario interpolates the resolved endpoint into a message', () => {
    const dir = join(__dirname, '..', 'scenarios')
    const offenders: string[] = []
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      for (const [n, line] of readFileSync(join(dir, file), 'utf8').split('\n').entries()) {
        // The two legitimate uses are handing it to a provider, never printing
        // it: `new JsonRpcProvider(BASE_SEPOLIA_RPC)` and `{ 84532: BASE_SEPOLIA_RPC }`.
        if (!/\$\{[^}]*BASE_SEPOLIA_RPC[^}]*\}/.test(line)) continue
        offenders.push(`${file}:${n + 1}`)
      }
    }
    expect(offenders, `resolved endpoint interpolated into a string: ${offenders.join(', ')}`).toEqual([])
  })

  it('POSITIVE CONTROL: the matcher finds an interpolation when there is one', () => {
    const matches = (line: string) => /\$\{[^}]*BASE_SEPOLIA_RPC[^}]*\}/.test(line)
    expect(matches('return fail(`polling ${BASE_SEPOLIA_RPC} timed out`)')).toBe(true)
    // And does not fire on the two legitimate, non-printing uses.
    expect(matches('const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)')).toBe(false)
    expect(matches('chainRpcs: { 84532: BASE_SEPOLIA_RPC },')).toBe(false)
  })
})
