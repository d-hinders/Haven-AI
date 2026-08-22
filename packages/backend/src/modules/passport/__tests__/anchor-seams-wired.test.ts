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
 */
const CODE = INDEX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

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
  ])('%s(%s)', (fn, arg) => {
    expect(callsWith(fn, arg)).toBe(true)
  })

  it('the probe is imported, not just named in a comment', () => {
    // Guards the shape where the call survives but the import is dropped —
    // which would be a compile error, but the assertion above alone would
    // still pass on a commented-out call.
    expect(INDEX).toMatch(/^\s*classifyAnchorTxLiveness,\s*$/m)
    expect(INDEX).toMatch(/^\s*readRevocationAnchor,\s*$/m)
  })

  it('a COMMENTED-OUT call does not count as wired', () => {
    // The mutation that found this: `// setRevocationProbe(readRevocationAnchor)`
    // used to satisfy every assertion above. Proven on a synthetic source
    // rather than by editing the real file, so the guard is pinned even if
    // `index.ts` is later reformatted.
    const commented = '// setAnchorLiveness(classifyAnchorTxLiveness)\n/* setAnchor(anchorOnChain) */'
    const stripped = commented.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(/\bsetAnchorLiveness\s*\(\s*classifyAnchorTxLiveness\s*\)/.test(stripped)).toBe(false)
    expect(/\bsetAnchor\s*\(\s*anchorOnChain\s*\)/.test(stripped)).toBe(false)
  })

  it('the helper itself can fail — a seam that is NOT wired reads as false', () => {
    // Without this, a typo in `callsWith` would make every assertion above
    // vacuously true and the whole file would prove nothing.
    expect(callsWith('setAnchorLiveness', 'recoverAnchorFromReceipt')).toBe(false)
    expect(callsWith('setAnchorNeverDefined', 'anchorOnChain')).toBe(false)
  })
})
