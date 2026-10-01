import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The import boundary of `@haven_ai/ui` (#3508).
 *
 * The package compiles inside WHICHEVER app consumes it (`transpilePackages`),
 * so an `@/` import inside it would resolve to the consumer's `src` — it
 * happens to work in the frontend today and breaks the moment a second app
 * (ops) compiles the same file. A `packages/frontend` import would invert the
 * dependency the package exists to create. Both are build-breakers that no
 * typecheck inside this package can see, so the boundary is scanned here,
 * mechanically, over every source file.
 *
 * Allowed: relative imports (`./Icon`), package imports the peerDependencies
 * name (`react`, `react-dom`, `next`, `lucide-react`) and each other (`vitest`
 * and the testing-library trio in tests). Everything referencing the consuming
 * app fails: `from '@/…'` / `import '@/…'` (the alias), and any
 * `packages/frontend` path in code. Comments are STRIPPED before scanning —
 * they are prose, not imports, and this file's own documentation and
 * tokens.css's header legitimately name the paths the rule bans; scanning
 * them would make the guard fail on its own explanation. What counts is the
 * code shape — a real import statement — never a lookalike in prose.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
/** This file, relative to src/ — the sweep does not scan its own message templates. */
const SELF = relative(SRC, fileURLToPath(import.meta.url))

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.(tsx?|css)$/.test(full)) acc.push(full)
  }
  return acc
}

/**
 * Comment-stripped source. Block comments first, then line comments; the
 * `//` in `https://…` is protected the same way design-lint protects it (a
 * `//` preceded by `:` is a URL, not a comment opener).
 */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, keep: string) => `${keep}`)
}

describe('the @haven_ai/ui import boundary (#3508)', () => {
  const files = sourceFiles(SRC)
  it('scans a non-empty package', () => {
    // False-zero guard: a moved or renamed src/ directory would otherwise
    // make every boundary assertion below pass over nothing.
    expect(files.length).toBeGreaterThan(0)
  })

  it('imports the consuming app nowhere — zero alias imports, zero frontend imports', () => {
    const violations: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file)
      const code = codeOf(readFileSync(file, 'utf8'))
      // The `@/` alias, in both quote styles — NOT any `@`-prefixed package
      // (`@testing-library/react` is a dev tool this package legitimately
      // imports; the shape that breaks is `@` immediately followed by the
      // alias separator).
      if (/(?:from|import)\s+['"]@\//.test(code)) {
        violations.push(`${rel}: an @/ import resolves to whichever app compiles this file`)
      }
      if (/(^|\W)packages\/frontend(\W|$)/.test(code)) {
        violations.push(`${rel}: packages/ui must not import the consuming frontend app`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('every cross-file import inside src is relative', () => {
    // The positive half of the same boundary: a cross-file import must be
    // `./X` or `../X`, never an alias. Bare-package imports (react, vitest,
    // lucide-react, @testing-library/*) are exempt — they are the peers and
    // dev tools the package declares. This file is exempt from the sweep: its
    // own templates quote import shapes, and a guard must not fail on the
    // strings it reports with.
    const violations: string[] = []
    for (const file of files.filter((f: string) => /\.(tsx?|css)$/.test(f))) {
      const rel = relative(SRC, file)
      if (rel === SELF) continue
      const code = codeOf(readFileSync(file, 'utf8'))
      for (const m of code.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]
        if (spec.startsWith('.') || spec.startsWith('/')) continue
        if (/^(react|react-dom|next|lucide-react)(\/|$)/.test(spec)) continue
        if (/^(vitest|@testing-library\/|@vitejs\/|node:)/.test(spec)) continue
        violations.push(`${rel}: non-relative import '${spec}'`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('keeps the moved primitives exactly the ones the ops console needs', () => {
    // The extraction is INCREMENTAL (#3508): these primitives moved, and the
    // rest of components/ui stayed in the frontend. A primitive drifting back
    // — or one moving here without the move list gaining it — breaks the shim
    // contract silently, so the set is pinned.
    const expected = [
      'Button.tsx',
      'Card.tsx',
      'CopyButton.tsx',
      'EmptyState.tsx',
      'FilterPill.tsx',
      'Icon.tsx',
      'InlineAlert.tsx',
      'Input.tsx',
      'PageHeader.tsx',
      'Row.tsx',
      'SegmentedControl.tsx',
      'Skeleton.tsx',
      'StatTile.tsx',
      'StatusBadge.tsx',
      'Table.tsx',
      'Tooltip.tsx',
    ].sort()
    const actual = readdirSync(SRC)
      .filter((f) => f.endsWith('.tsx'))
      .sort()
    expect(actual, 'packages/ui/src must hold exactly the moved primitives').toEqual(expected)
  })

  it('ships tokens.css and a Tailwind preset that agree with it', () => {
    const tokens = readFileSync(join(SRC, 'tokens.css'), 'utf8')
    const preset = readFileSync(join(SRC, '..', 'tailwind.preset.js'), 'utf8')
    // Every channel token the preset's colours read must be declared in
    // tokens.css — the preset compiles against declarations this package owns.
    const referenced = [...preset.matchAll(/--v2-([a-z0-9-]+)-rgb/g)].map((m) => m[1])
    expect(referenced.length, 'the preset reads channel tokens').toBeGreaterThan(0)
    for (const name of new Set(referenced)) {
      expect(tokens, `tokens.css declares --v2-${name}-rgb`).toMatch(
        new RegExp(`--v2-${name}-rgb:`),
      )
    }
  })
})
