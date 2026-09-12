// #2680 slice-2 guard — pins design-system.md § *Modal*'s "This is the only
// scroller" claim: the `[data-modal-body]` element carries Modal's ONLY
// `overflow-y` scroll container. A second one (or the attribute moving off
// the scroller) silently breaks the scroll-cue contract (`useScrollEdgeCue`
// resolves the scroller by that attribute) — this test fails on both.
//
// Mutation-proven for #2680: adding a second `overflow-y-auto` in Modal.tsx
// turns the count pin red; restoring the file turns it green, byte-identical.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODAL = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'components',
  'ui',
  'Modal.tsx',
)

describe('design-system § Modal one-scroller pin (#2680)', () => {
  const src = readFileSync(MODAL, 'utf8')

  it('exactly one element carries an overflow-y scroll container, and it is the [data-modal-body] element', () => {
    const scrollerLines = src
      .split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /overflow-y\s*:|overflow-y-/.test(l))
    expect(scrollerLines).toHaveLength(1)
    // Attribute and class sit on adjacent lines of ONE opening tag.
    const isCode = (l: string) => !/^\s*(\*|\/\/|\/\*)/.test(l)
    const attrAt = src
      .split('\n')
      .findIndex((l) => isCode(l) && l.includes('data-modal-body'))
    expect(Math.abs(attrAt + 1 - scrollerLines[0].n)).toBeLessThanOrEqual(1)
  })

  it('the [data-modal-body] ATTRIBUTE is on the element that carries the scroller class', () => {
    // The attribute and the scroller class sit on adjacent lines of ONE
    // opening tag (`data-modal-body=""` then the className template). Search
    // only CODE lines — the docstring mentions the attribute too (:75).
    const lines = src.split('\n')
    const isCode = (l: string) => !/^\s*(\*|\/\/|\/\*)/.test(l)
    const attrAt = lines.findIndex((l) => isCode(l) && l.includes('data-modal-body'))
    const clsAt = lines.findIndex((l) => isCode(l) && l.includes('overflow-y-auto'))
    expect(attrAt, 'Modal.tsx no longer declares data-modal-body').toBeGreaterThanOrEqual(0)
    expect(clsAt, 'Modal.tsx no longer declares the overflow-y-auto scroller').toBeGreaterThanOrEqual(0)
    expect(Math.abs(attrAt - clsAt)).toBeLessThanOrEqual(2)
  })
})
