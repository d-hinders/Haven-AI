/**
 * The passport anchor's three seams are actually WIRED at boot (#1745).
 *
 * `issuance.ts` is deliberately chain-free: the anchor, the receipt recovery
 * and the liveness probe are all injected, which is what makes the state
 * machine testable without ethers or a relayer. The cost of that design is
 * that deleting a `setX(...)` line in `index.ts` breaks nothing visibly —
 * every unit test injects its own seam and passes regardless.
 *
 * For the liveness probe that failure is silent AND severe: with no probe
 * wired, `issuePassport` refuses every re-mint (the fail-safe default), so
 * issuance would stall repo-wide rather than duplicate — loud eventually, but
 * only via the attention counter. And if a future edit ever flipped that
 * default the other way, an unwired probe would restore the pre-#1745
 * duplicate-credential behaviour exactly.
 *
 * A source assertion rather than a boot: importing `index.ts` builds a Fastify
 * app, opens a pool and starts timers. The repo already uses source scanning
 * for guards of this shape (the bare-numeric-chain-fallback guard).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@haven_ai/core'
import { describe, expect, it } from 'vitest'

const INDEX = readFileSync(
  fileURLToPath(new URL('../../../index.ts', import.meta.url)),
  'utf8',
)

/**
 * Comments mention these names constantly — assert on the CALL, not the word.
 *
 * Comments are STRIPPED before matching, which is not belt and braces: the
 * file's own note below says the call surviving as a comment would still pass,
 * and a #1758 mutation confirmed it — commenting out `setRevocationProbe(...)`
 * left every assertion here green. The separate import check catches a deleted
 * import, not a commented-out call, so this is the half that was missing.
 *
 * The stripping is the shared core helper (#4411), not a regex pair: a
 * block-comment regex run first opened a fake block at the
 * `/accounting/connections/*` text inside a line comment and swallowed the
 * `registerConnector(...)` region below it, so a guard here could pass while
 * the wiring had changed. The sanity assertion below pins a statement from
 * that exact region so a swallowed window fails red.
 */
const CODE = stripComments(INDEX)

function callsWith(fn: string, arg: string): boolean {
  return new RegExp(`\\b${fn}\\s*\\(\\s*${arg}\\s*\\)`).test(CODE)
}

describe('passport anchor seams are wired in index.ts', () => {
  it.each([
    ['setAnchor', 'anchorOnChain'],
    ['setAnchorRecovery', 'recoverAnchorFromReceipt'],
    ['setAnchorLiveness', 'classifyAnchorTxLiveness'],
    ['setRevoker', 'revokeOnChain'],
    // #1758: unwired, `reconcileRevocation` cannot converge a revoke that
    // mined after its wait expired, and the row alarms forever while the
    // relayer re-broadcasts a doomed transaction hourly. Same silent-failure
    // shape as the liveness probe: every unit test injects its own.
    ['setRevocationProbe', 'readRevocationAnchor'],
    // #3294: unwired, a pre-fix row's phantom UID is revoked (reverting
    // NotFound() forever) instead of repaired from its own anchor receipt.
    ['setAnchorUidRepair', 'repairAnchorUidFromReceipt'],
  ])('%s(%s)', (fn, arg) => {
    expect(callsWith(fn, arg)).toBe(true)
  })

  it('the probe is imported, not just named in a comment', () => {
    // Guards the shape where the call survives but the import is dropped —
    // which would be a compile error, but the assertion above alone would
    // still pass on a commented-out call.
    expect(INDEX).toMatch(/^\s*classifyAnchorTxLiveness,\s*$/m)
    expect(INDEX).toMatch(/^\s*readRevocationAnchor,\s*$/m)
    expect(INDEX).toMatch(/^\s*repairAnchorUidFromReceipt,\s*$/m)
  })

  it('a COMMENTED-OUT call does not count as wired', () => {
    // The mutation that found this: `// setRevocationProbe(readRevocationAnchor)`
    // used to satisfy every assertion above. Proven on a synthetic source
    // rather than by editing the real file, so the guard is pinned even if
    // `index.ts` is later reformatted. The trailing `/*` is the #4411 shape:
    // the old regex pair turned a line comment ending like that into a fake
    // block that swallowed the real wiring BELOW it instead.
    const commented =
      '// setAnchorLiveness(classifyAnchorTxLiveness) /* see /x/* */\n/* setAnchor(anchorOnChain) */\nconst after = stillHere()'
    const stripped = stripComments(commented)
    expect(/\bsetAnchorLiveness\s*\(\s*classifyAnchorTxLiveness\s*\)/.test(stripped)).toBe(false)
    expect(/\bsetAnchor\s*\(\s*anchorOnChain\s*\)/.test(stripped)).toBe(false)
    // The fake-block regression: real code AFTER the trap comment must survive.
    expect(stripped).toContain('stillHere()')
  })

  it('the stripper keeps real code: the registerConnector region survives (#4411)', () => {
    // A statement from the exact stretch the old regex pair swallowed (the
    // window between the `/accounting/connections/*` line comment and the
    // CATALOG_INGEST_INTERVAL_MS jsdoc). If any stripper ever eats a region
    // of index.ts again, this goes red before the wiring assertions can
    // read a false silence.
    expect(CODE).toMatch(/registerConnector\(new AccountedConnector\(\)\)/)
    expect(CODE).toMatch(/registerConnector\(new FortnoxConnector\(\)\)/)
    expect(CODE).toMatch(/await app\.register\(accountingConnectionsRoutes/)
    expect(CODE).toMatch(/const CATALOG_INGEST_INTERVAL_MS\s*=/)
  })

  it('the helper itself can fail — a seam that is NOT wired reads as false', () => {
    // Without this, a typo in `callsWith` would make every assertion above
    // vacuously true and the whole file would prove nothing.
    expect(callsWith('setAnchorLiveness', 'recoverAnchorFromReceipt')).toBe(false)
    expect(callsWith('setAnchorNeverDefined', 'anchorOnChain')).toBe(false)
  })
})
