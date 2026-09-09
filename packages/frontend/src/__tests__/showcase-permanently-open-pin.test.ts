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
//
// Re-proven for #2800 in BOTH directions, because the count and the tag loop
// catch different things: a third bare `open` under `WalletPopover` reddens the
// count ("length of 2 but got 3"), and one under `InfoModal` reddens the tag
// loop ("expected 'InfoModal' to be 'WalletPopover'").
//
// KNOWN LIMIT, found by a mutation that SURVIVED before it was diagnosed: the
// inert lookup below walks at most 12 lines up, so a bare `open` placed deeper
// than that inside a long inert wrapper is not counted at all. The first
// attempt at the second mutation landed 18 lines below its wrapper, passed, and
// looked like a hole in the guard until the placement was checked. It is a real
// limit of the census — a third illustration buried deep in a wrapper would be
// missed — and it is recorded rather than widened here, because a larger window
// starts swallowing the state-driven previews the filter below exists to
// exclude.
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
    // A COUNT, not positions (#2800). This asserted `[1943, 1977]` and then
    // `[1972, 2006]`, because absolute line numbers in a ~2000-line page move
    // whenever anything above them does — the second time from comments added
    // 400 lines earlier, in a section with no relationship to `WalletPopover`.
    //
    // The positions never carried the guard. #2680's job is that a SECOND
    // statically-held-open showcase reddens, and that is caught here by the
    // count, and below by the tag loop: a third bare `open` inside an inert
    // wrapper makes this 3, and one under a different component fails the
    // `toBe('WalletPopover')` check. What the line numbers added was a red
    // build on unrelated edits — and an invitation to paste the new numbers in
    // without checking whether the census had actually changed, which is a
    // guard training people to update it thoughtlessly.
    expect(bare, 'exactly two permanently-open illustrations').toHaveLength(2)
    // And both belong to WalletPopover renders.
    for (const { n } of bare) {
      const up = lines.slice(0, n).reverse().find((l) => /<([A-Za-z][A-Za-z0-9]*)/.test(l))
      const tag = up?.match(/<([A-Za-z][A-Za-z0-9]*)/)?.[1]
      expect(tag, `bare \`open\` at line ${n} sits under <${tag}>`).toBe('WalletPopover')
    }
  })
})
