import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The non-asserting feed must not reach the asserting legacy code (#2859).
 *
 * #491's premise is that Haven is a data source and the accountant books it:
 * the feed never asserts VAT, accounts or rows. `legacy/` is the #462 code that
 * DOES assert — BAS account selection, balanced double-entry booking lines, SIE
 * verifikat, Fortnox vouchers — darkened behind `HAVEN_LEGACY_BOOKKEEPING_ENABLED`.
 *
 * Before this slice the separation was a naming convention and it had already
 * failed: three feed files imported `buildBookingLines` /
 * `buildAccountingEntryForPayment` / the `AccountingEntry` type from the legacy
 * module, and `fortnox.ts` — a file the feed connector imports — pulled in
 * `buildBookingLines` for `toFortnoxVoucher`. Splitting the voucher push into
 * `legacy/fortnox-voucher.ts` is what made this assertion possible.
 *
 * Source-read rather than runtime: a lazy `await import()` inside a rarely-hit
 * branch would never show up in a module graph the tests happen to execute.
 */
const MODULE_DIR = fileURLToPath(new URL('../', import.meta.url))

/** Feed source files: this directory, minus `legacy/` and minus tests. */
function feedSourceFiles(): string[] {
  return readdirSync(MODULE_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => e.name)
}

describe('the accounting feed cannot import the asserting legacy code (#2859)', () => {
  it('finds the feed files it claims to be guarding', () => {
    // A floor, because every assertion below is negative and an empty file set
    // satisfies those for free — the shape that made #2842's sibling scanner
    // unfalsifiable.
    const files = feedSourceFiles()
    expect(files.length, 'no feed source files found — the probe is broken').toBeGreaterThanOrEqual(8)
    expect(files).toContain('fortnox.ts')
    expect(files).toContain('feed-orchestrator.ts')
    expect(files).toContain('index.ts')
  })

  it.each(feedSourceFiles())('%s imports nothing from legacy/', (name) => {
    const src = readFileSync(`${MODULE_DIR}${name}`, 'utf8')
    // Both static and dynamic forms, and both `./legacy/x.js` and a bare
    // `./legacy/index.js`. Quoted loosely because the repo has no formatter
    // that would normalise the quote style.
    const hits = [...src.matchAll(/['"][^'"]*\/legacy\/[^'"]*['"]/g)].map((m) => m[0])
    expect(hits, `${name} reaches into legacy/: ${hits.join(', ')}`).toEqual([])
  })

  it('the module entry point does not re-export legacy either', () => {
    const index = readFileSync(`${MODULE_DIR}index.ts`, 'utf8')
    expect(index).not.toMatch(/export\s+\*\s+from\s+['"][^'"]*legacy/)
  })
})
