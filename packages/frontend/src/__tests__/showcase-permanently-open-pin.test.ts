// #2680 slice-2 guard — pins design-system.md § Showcase page's claim that
// "Exactly one showcase is held permanently open: `WalletPopover`'s two
// signing-credential states, side by side, because the blocking pixel gate
// captures the page at rest". The WalletPopover showcases are static
// ILLUSTRATIONS inside `inert aria-hidden` wrappers; every live overlay on
// the page is state-driven (`open={…}`). Pinned by scanning the page source:
// the only bare `open` props allowed outside those `inert` wrappers are
// state-driven interactive previews, so a SECOND statically-held-open
// showcase reddens.
//
// Mutation-proven for #2680: adding a bare `open` to a showcase element inside
// an inert wrapper (a second permanently-open illustration) reddens;
// restoring the file turns it green, byte-identical.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PAGE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'app',
  '(authenticated)',
  'design-system',
  'page.tsx',
)

describe('permanently-open showcase census (#2680 pin)', () => {
  const src = readFileSync(PAGE, 'utf8')

  it('exactly two bare-open illustrations, both inert-wrapped WalletPopover states', () => {
    const lines = src.split('\n')
    const bare = lines
      .map((l, i) => ({ l: l.trim(), n: i + 1 }))
      .filter(({ l }) => !l.startsWith('*') && !l.startsWith('//'))
      .filter(({ l }) => /(^|\s)open$/.test(l))
      // State-driven previews (`{confirmOpen ? <ConfirmDialog open …>}`) are
      // interactive-by-construction: they sit inside a ternary on a *Open
      // state, not inside an inert wrapper. The doc's claim is about the
      // static illustrations, so restrict to inert-wrapper lines.
      .filter(({ n }) => {
        for (let j = n; j >= Math.max(0, n - 12); j--) {
          const l = lines[j - 1]
          if (/inert/.test(l)) return true
          if (/confirmOpen \?|infoModalOpen \?|comingSoonOpen \?|panelOpen \?|modalOpen \?/.test(l))
            return false
        }
        return false
      })
    // Absolute line numbers, so they move whenever anything above them does —
    // 1943/1977 -> 1972/2006 when #2792 added comments 400 lines up. The census
    // itself did not change: still exactly two, still both `WalletPopover`,
    // still both inert-wrapped. Updated rather than loosened, because
    // narrowing someone else's guard is not this PR's business; #2800 proposes
    // the count-plus-tag form that would not need touching.
    expect(bare.map(({ n }) => n).sort((a, b) => a - b)).toEqual([1972, 2006])
    // And both belong to WalletPopover renders.
    for (const { n } of bare) {
      const up = lines.slice(0, n).reverse().find((l) => /<([A-Za-z][A-Za-z0-9]*)/.test(l))
      const tag = up?.match(/<([A-Za-z][A-Za-z0-9]*)/)?.[1]
      expect(tag, `bare \`open\` at line ${n} sits under <${tag}>`).toBe('WalletPopover')
    }
  })
})
