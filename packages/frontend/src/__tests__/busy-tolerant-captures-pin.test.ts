// #2680 slice-2 guard — pins `docs/contributing/ship-playbooks/frontend.md`
// § *Capture integrity*'s "exactly one surface" claim: `BUSY_TOLERANT_CAPTURES`
// in `scripts/full-page-capture.mjs` exists for exactly one surface —
// `/design-system`, which renders loading states AS CONTENT — and the escape
// is fatal-when-stale. The ratchet this test adds: the set cannot grow (or
// silently shrink) without a doc edit in the same PR, mirroring the doc's own
// "narrow, self-expiring" contract.
//
// Mutation-proven for #2680: adding a second route turns this red; restoring
// the file turns it green, byte-identical.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'full-page-capture.mjs',
)

/** The one surface frontend.md § Capture integrity allows. */
const EXPECTED_BUSY_TOLERANT = ['/design-system']

function busyTolerantRoutes(): string[] {
  const src = readFileSync(SCRIPT, 'utf8')
  const at = src.indexOf('export const BUSY_TOLERANT_CAPTURES')
  expect(at, 'full-page-capture.mjs lost BUSY_TOLERANT_CAPTURES').toBeGreaterThanOrEqual(0)
  const block = src.slice(at, src.indexOf(']\n', at))
  // The set is `pattern: /^\/<route>$/` regexes — read the source strings.
  return [...block.matchAll(/pattern:\s*\/\^\\?\/([a-z0-9/-]+)\$\//g)].map(
    (m) => `/${m[1]}`,
  )
}

describe('frontend.md § Capture integrity — exactly one busy-tolerant surface (#2680 pin)', () => {
  it('BUSY_TOLERANT_CAPTURES holds exactly /design-system', () => {
    expect(busyTolerantRoutes()).toEqual(EXPECTED_BUSY_TOLERANT)
  })
})
