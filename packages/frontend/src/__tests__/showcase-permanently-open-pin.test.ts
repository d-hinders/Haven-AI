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
// Re-proven for #2800, and note WHICH assertion each mutation reaches, because
// the first write-up of this got it wrong:
//
//   * ADDING a third bare `open` inside a wrapper — under `WalletPopover` or
//     under any other component — reddens the COUNT, because the count throws
//     before the tag loop is entered. Both additive mutations produce the same
//     "length of 2 but got 3".
//   * The TAG LOOP is only reached when the count still passes, so proving it
//     needs a REPLACEMENT: swap one `WalletPopover` illustration for an
//     `InfoModal` one. That yields
//     "expected 'InfoModal' to be 'WalletPopover'".
//   * RELOCATING one illustration to the end of the page keeps the count at 2
//     and both tags right, and is caught by the span assertion below.
//
// A mutation of mine SURVIVED before it was diagnosed, and the diagnosis is
// the useful part: inserting a block immediately after the wrapper pushed a
// real `open` from inert+9 to inert+14, out of the then-12-line window, so the
// mutation added one and dropped one and the count never moved. A confounded
// mutation looks exactly like a live guard. Check what the edit displaced
// before believing what the test said.
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
        // 60, not 12. The window was 12 and that dropped any `open` placed
        // deeper inside a long wrapper — measured: one at inert+18 was not
        // counted at all. Widening was first recorded here as unsafe "because
        // it swallows the state-driven previews"; a review disproved that. The
        // ternary check below short-circuits NEAREST-FIRST, so a preview's
        // `confirmOpen ?` two lines up wins at any window size — verified at
        // 12, 60 and whole-file, all green on the unmutated page.
        //
        // What widening DOES risk is this file's JSX comments, two of which
        // contain the word `inert` in prose. Hence the element form below: a
        // wrapper is `<div inert …>`, and a sentence about inertness is not.
        for (let j = n; j >= Math.max(1, n - 60); j--) {
          const l = lines[j - 1]
          if (/<\w+[^>]*\sinert\b/.test(l)) return true
          if (/confirmOpen \?|infoModalOpen \?|comingSoonOpen \?|panelOpen \?|modalOpen \?/.test(l))
            return false
        }
        return false
      })
    // A COUNT plus ADJACENCY, not absolute positions (#2800). This asserted
    // `[1942, 1976]`, then `[1943, 1977]`, then `[1972, 2006]` — three values
    // across two churn updates, and the middle one was re-pinned inside an
    // unrelated FEATURE pr (#2730's safe-area insets) rather than a fixup,
    // which is the shape of the problem: a number nobody reads, updated to
    // make a build green.
    //
    // What the absolute positions DID carry, and what the count alone loses:
    // relocation. Moving one illustration out of the side-by-side pair to the
    // end of the page keeps the count at 2 and both tags `WalletPopover`,
    // while breaking design-system.md's claim that the two states sit "side by
    // side" — the very sentence this guard pins. So the span is asserted
    // instead: translation-invariant, so an edit above cannot move it, but a
    // relocation reddens it.
    expect(bare, 'exactly two permanently-open illustrations').toHaveLength(2)
    expect(
      bare[1].n - bare[0].n,
      'the two illustrations sit side by side in one grid, not scattered',
    ).toBeLessThan(60)
    // And both belong to WalletPopover renders.
    for (const { n } of bare) {
      const up = lines.slice(0, n).reverse().find((l) => /<([A-Za-z][A-Za-z0-9]*)/.test(l))
      const tag = up?.match(/<([A-Za-z][A-Za-z0-9]*)/)?.[1]
      expect(tag, `bare \`open\` at line ${n} sits under <${tag}>`).toBe('WalletPopover')
    }
  })
})
