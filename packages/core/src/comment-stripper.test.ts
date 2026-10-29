/**
 * The shared comment stripper's own contract (#4411).
 *
 * Each case here is a window the old two-regex pair (block comments first,
 * then line comments) went blind in — the four named by #4411's acceptance
 * criteria, plus the regex-literal and nested-template shapes the scans' own
 * sources carry. The load-bearing direction is always "the code after the
 * hazard survives": a stripper that removes TOO MUCH is exactly the bug — a
 * guard that scans an emptied window passes while the code it checks has
 * changed.
 */
import { describe, expect, it } from 'vitest'
import { stripComments } from './comment-stripper.js'

describe('stripComments — the windows the regex pair went blind in (#4411)', () => {
  it('a /* inside a line comment does not open a block', () => {
    // The index.ts case that started #4411: a line comment naming a route
    // pattern. The old block-first regex opened a fake block here and
    // swallowed the ~35 real lines that followed it.
    const source = [
      '// #2862: provider-generic connections (`/accounting/connections/*`)',
      'registerConnector(new AccountedConnector())',
      'const after = stillHere()',
    ].join('\n')
    const stripped = stripComments(source)
    expect(stripped).toContain('registerConnector(new AccountedConnector())')
    expect(stripped).toContain('stillHere()')
    // And the comment itself is really gone.
    expect(stripped).not.toContain('accounting')
  })

  it('a // inside a string is not a comment', () => {
    // The old line-comment regex ate from the slashes to end of line; the
    // guarded call sharing that line vanished with the URL.
    const source = "const api = 'https://api.haven.example'; doThing()"
    const stripped = stripComments(source)
    expect(stripped).toContain("'https://api.haven.example'")
    expect(stripped).toContain('doThing()')
  })

  it('a /* inside a template literal does not open a block', () => {
    const source = [
      'const msg = `route /* not a comment */ end`',
      'const call = doThing()',
    ].join('\n')
    const stripped = stripComments(source)
    expect(stripped).toContain('not a comment')
    expect(stripped).toContain('doThing()')
  })

  it('a one-line /** … https://… */ jsdoc is removed whole, including its closing */', () => {
    // The case that defeats SWAPPING the two regexes: line comments first
    // eats from the `//` in the URL to end of line, the jsdoc loses its
    // closing `*/`, and the block regex then swallows to the NEXT `*/` —
    // a fake block again, just from the other direction.
    const source = '/** See https://example.com/docs. */\nconst call = doThing()'
    const stripped = stripComments(source)
    expect(stripped).not.toContain('example.com')
    expect(stripped).not.toContain('/**')
    expect(stripped).toContain('doThing()')
  })

  it('a regex literal containing // is code, not a comment', () => {
    // The scanner must not treat the slashes inside a regular expression as
    // comment delimiters — the literal itself (and the rest of its line) is
    // exactly the kind of guarded text a scan may look for.
    const source = "const re = /https:\\/\\//\nconst call = doThing()"
    const stripped = stripComments(source)
    expect(stripped).toContain('doThing()')
  })

  it('a nested template literal with a ${} expression keeps the expression', () => {
    const source = 'const msg = `outer ${String(`inner /* x */`)} end`\ndoThing()'
    const stripped = stripComments(source)
    expect(stripped).toContain('doThing()')
  })

  it('an unused import survives — import elision must not hide it from the guards', () => {
    // transpileModule's default elision deletes imports whose bindings are
    // unused, which would let an unused signer import slip past the
    // "imports nothing that can sign" scans. verbatimModuleSyntax keeps it.
    const source = "import { createWalletClient } from 'viem'\ndoThing()"
    const stripped = stripComments(source)
    expect(stripped).toContain("from 'viem'")
    expect(stripped).toContain('doThing()')
  })

  it('a type-only import is erased — a type cannot sign at runtime', () => {
    const source = "import type { WalletClient } from 'viem'\ndoThing()"
    const stripped = stripComments(source)
    expect(stripped).not.toContain("from 'viem'")
    expect(stripped).toContain('doThing()')
  })

  it('division is not a regex: code between two slashes survives', () => {
    // The classic hand-rolled-lexer hazard — if a division were mistaken for
    // a regex start, everything to the next slash would vanish. The compiler
    // cannot make this mistake.
    const source = 'const avg = total / count\ncompute(avg)'
    const stripped = stripComments(source)
    expect(stripped).toContain('total / count')
    expect(stripped).toContain('compute(avg)')
  })

  it('jsx is preserved verbatim for .tsx scans', () => {
    // The ops card guard matches attribute text inside tags; the re-emit
    // must not rewrite the elements.
    const source = 'export const Card = () => (\n  <Card.Header padding="none" className="px-5">x</Card.Header>\n)'
    const stripped = stripComments(source, 'widget.tsx')
    expect(stripped).toContain('<Card.Header padding="none" className="px-5">')
  })

  it('comments are gone from every shape: line, block and jsdoc', () => {
    const source = [
      '// a line comment',
      'const a = 1 // trailing',
      '/* a block */',
      '/** a jsdoc */',
      'const b = 2',
    ].join('\n')
    const stripped = stripComments(source)
    expect(stripped).not.toContain('a line comment')
    expect(stripped).not.toContain('a block')
    expect(stripped).not.toContain('a jsdoc')
    expect(stripped).toContain('const a = 1')
    expect(stripped).toContain('const b = 2')
  })
})
