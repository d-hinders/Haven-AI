import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every `var(--v2-…)` reference in product source resolves to a property the
 * repo actually defines (#4425).
 *
 * The bug this file exists to prevent: `--v2-ink-muted` (32 uses, 10 files),
 * `--v2-ink-strong` (1) and `--v2-line` (1) were referenced in product code
 * and defined nowhere. Tailwind compiles `text-[var(--v2-ink-muted)]` to
 * `color: var(--v2-ink-muted)`; an unresolved `var()` with no fallback makes
 * the declaration invalid at computed-value time, so the property behaves as
 * `unset` — `color` inherits the ancestor's ink, `border-color` falls back to
 * `currentcolor`. Nothing errors, nothing warns, and the cascade still picks
 * the dead declaration, so it never falls back to an earlier rule. The muted
 * tier was simply lost, in both themes, for four months.
 *
 * What counts as a definition, and why each is not an allowlist:
 *
 *   - a declaration in any scanned stylesheet (`--v2-ink-3: #5d6c85`), which
 *     is `packages/ui/src/tokens.css` (three palette blocks) and the app
 *     `globals.css` files;
 *   - a Tailwind arbitrary property (`[--v2-safe-gutter:1rem]`), which is how
 *     the modals set the overlay's own minimum;
 *   - an inline style key (`['--v2-stagger-delay']: …`), which is how the
 *     accounts overview staggers its cards.
 *
 * A name that ends in `-` is a template prefix (`var(--v2-avatar-${n})`,
 * `var(--v2-series-${i})`): it resolves when ANY defined name starts with it.
 * That is a rule about the name, not a list of names — the six avatar tints
 * and six series stops are defined in `tokens.css` and the guard finds them.
 *
 * A reference that carries a fallback (`var(--v2-safe-gutter, 0px)`) is
 * exempt: the fallback is the author saying what happens when the property is
 * absent, so the declaration is never invalid at computed-value time. The
 * guard reports those separately rather than silently dropping them.
 *
 * Scope is non-test source under `packages/frontend/src`, `packages/ui/src`
 * and `packages/ops/src`. Test files are excluded because they legitimately
 * quote dead shapes as fixtures (`shadow-token.test.ts` pins the compiled
 * output of `shadow-[var(--v2-shadow-card)]`), and a comment is not a
 * reference — CSS comments are blanked before scanning, and a `var(--v2-…)`
 * inside a JS/TS comment is still a string in the file, so the guard reads
 * the source as text and accepts that a comment mentioning a name counts.
 * That is deliberate: a name in a comment is a name someone will copy.
 */

const FRONTEND = resolve(__dirname, '../..')
const REPO = resolve(FRONTEND, '../..')

/** The three product source roots the acceptance criteria name. */
const SOURCE_ROOTS = [
  'packages/frontend/src',
  'packages/ui/src',
  'packages/ops/src',
] as const

const SOURCE_FILE = /\.(css|ts|tsx|js|mjs|cjs)$/
const TEST_FILE = /(^|\/)(__tests__|__mocks__)\/|\.(test|spec)\.[cm]?[jt]sx?$/

/** `var(--v2-name` or `var(--v2-name,` — the second group is the fallback. */
const REFERENCE = /var\(\s*--v2-([A-Za-z0-9-]*)(\s*,)?/g
/** A declaration: `--v2-name:` (CSS) — the value is irrelevant here. */
const DECLARATION = /--v2-[A-Za-z0-9-]+\s*:/g
/** A Tailwind arbitrary property: `[--v2-name:value]`. */
const ARBITRARY_PROPERTY = /\[--v2-[A-Za-z0-9-]+\s*:/g
/** An inline style key: `'--v2-name':` / `"--v2-name":` / `['--v2-name' as string]:`. */
const INLINE_STYLE_KEY = /(['"])--v2-[A-Za-z0-9-]+\1(?:\s+as\s+string)?\s*\]?\s*:/g

interface Reference {
  /** True when at least one use of the name carries a `var()` fallback. */
  hasFallback: boolean
  /** Repo-relative files that reference it. */
  files: Set<string>
}

interface Scan {
  files: string[]
  references: Map<string, Reference>
  definitions: Set<string>
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (SOURCE_FILE.test(entry)) out.push(path)
  }
  return out
}

/** Blank CSS comments, preserving offsets so nothing shifts. */
function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
}

function scan(root: string = REPO): Scan {
  const files = SOURCE_ROOTS.flatMap((dir) => walk(join(root, dir)))
    .map((path) => relative(root, path))
    .filter((path) => !TEST_FILE.test(path))
    .sort()

  const references = new Map<string, Reference>()
  const definitions = new Set<string>()

  for (const rel of files) {
    const raw = readFileSync(join(root, rel), 'utf8')
    const text = rel.endsWith('.css') ? stripCssComments(raw) : raw

    for (const match of text.matchAll(REFERENCE)) {
      const name = `--v2-${match[1]}`
      const existing = references.get(name)
      if (existing) {
        existing.files.add(rel)
        // A name is exempt only when EVERY use carries a fallback.
        if (!match[2]) existing.hasFallback = false
      } else {
        references.set(name, { hasFallback: Boolean(match[2]), files: new Set([rel]) })
      }
    }

    for (const match of text.matchAll(DECLARATION)) {
      definitions.add(match[0].replace(/\s*:$/, ''))
    }
    for (const match of text.matchAll(ARBITRARY_PROPERTY)) {
      definitions.add(match[0].replace(/^\[/, '').replace(/\s*:$/, ''))
    }
    for (const match of text.matchAll(INLINE_STYLE_KEY)) {
      const name = match[0].match(/--v2-[A-Za-z0-9-]+/)
      if (name) definitions.add(name[0])
    }
  }

  return { files, references, definitions }
}

/** Does `name` resolve against `definitions`? Template prefixes match by prefix. */
function resolves(name: string, definitions: Set<string>): boolean {
  if (name.endsWith('-')) {
    return [...definitions].some((defined) => defined.startsWith(name))
  }
  return definitions.has(name)
}

/** The unresolved, fallback-less references of a scan, sorted. */
function unresolved(scan: Scan): string[] {
  return [...scan.references]
    .filter(([name, ref]) => !ref.hasFallback && !resolves(name, scan.definitions))
    .map(([name]) => name)
    .sort()
}

describe('every var(--v2-…) reference in product source is defined (#4425)', () => {
  const scanResult = scan()

  it('scans the three product source roots, non-test files only', () => {
    // A floor, not an inventory: the guard is worthless if the walk silently
    // returns nothing (a moved directory, a broken glob).
    expect(scanResult.files.length).toBeGreaterThan(300)
    expect(scanResult.files.some((f) => f.startsWith('packages/frontend/src/'))).toBe(true)
    expect(scanResult.files.some((f) => f.startsWith('packages/ui/src/'))).toBe(true)
    expect(scanResult.files.some((f) => f.startsWith('packages/ops/src/'))).toBe(true)
    expect(scanResult.files.some((f) => TEST_FILE.test(f))).toBe(false)
  })

  it('finds the definitions it is supposed to find', () => {
    // Positive control on the DEFINITION side: the palette's three blocks and
    // the two non-CSS definition shapes must all be visible to the scan, or
    // every reference below would look undefined.
    expect(scanResult.definitions.has('--v2-ink-3')).toBe(true)
    expect(scanResult.definitions.has('--v2-ink-2')).toBe(true)
    expect(scanResult.definitions.has('--v2-border')).toBe(true)
    // Set by a Tailwind arbitrary property in the modals.
    expect(scanResult.definitions.has('--v2-safe-gutter')).toBe(true)
    // Set as an inline style key in AccountsOverviewClient.
    expect(scanResult.definitions.has('--v2-stagger-delay')).toBe(true)
    // The template prefixes' expansions.
    expect(scanResult.definitions.has('--v2-avatar-1')).toBe(true)
    expect(scanResult.definitions.has('--v2-series-1')).toBe(true)
  })

  it('finds the references it is supposed to find', () => {
    // Positive control on the REFERENCE side: a scan that reads no references
    // would pass the assertion below vacuously.
    expect(scanResult.references.size).toBeGreaterThan(50)
    expect(scanResult.references.has('--v2-ink')).toBe(true)
    expect(scanResult.references.has('--v2-border')).toBe(true)
  })

  it('has no undefined reference without a fallback', () => {
    const missing = unresolved(scanResult)
    const detail = missing
      .map((name) => `${name} (${[...scanResult.references.get(name)!.files].join(', ')})`)
      .join('\n')
    expect(missing, `undefined --v2-* references:\n${detail}`).toEqual([])
  })

  it('passes the template-prefix and fallback uses without allowlisting them by name', () => {
    // These are the shapes the issue says must pass on their own merits. Each
    // is asserted to be PRESENT (so the test is not vacuous) and to resolve.
    const prefixes = [...scanResult.references.keys()].filter((name) => name.endsWith('-'))
    expect(prefixes.length).toBeGreaterThan(0)
    for (const prefix of prefixes) {
      expect(resolves(prefix, scanResult.definitions), `${prefix} is a template prefix`).toBe(true)
    }

    const withFallback = [...scanResult.references]
      .filter(([, ref]) => ref.hasFallback)
      .map(([name]) => name)
    expect(withFallback.length).toBeGreaterThan(0)
    for (const name of withFallback) {
      expect(unresolved(scanResult)).not.toContain(name)
    }
  })

  it('no longer names the three tokens #4425 removed', () => {
    // The regression pin. Each of these was referenced and defined nowhere;
    // the fix maps them onto existing tokens rather than defining them.
    for (const name of ['--v2-ink-muted', '--v2-ink-strong', '--v2-line']) {
      expect(scanResult.references.has(name), `${name} is still referenced`).toBe(false)
    }
  })
})

describe('the guard has a positive control (#4425)', () => {
  /**
   * The mutation harness. `scan()` reads the real tree; these tests mutate a
   * COPY of the scan's inputs in memory and assert the guard's own predicate
   * turns red. A guard that cannot fail is not a guard.
   */
  const base = scan()

  it('a reference to an undefined name turns it red', () => {
    const mutated: Scan = {
      files: base.files,
      definitions: new Set(base.definitions),
      references: new Map(base.references),
    }
    mutated.references.set('--v2-ink-muted', {
      hasFallback: false,
      files: new Set(['packages/frontend/src/components/ui/SettingsSection.tsx']),
    })
    expect(unresolved(mutated)).toContain('--v2-ink-muted')
    expect(unresolved(base)).not.toContain('--v2-ink-muted')
  })

  it('deleting a used token from the definitions turns it red', () => {
    // `--v2-ink-3` is used by product source and declared in tokens.css. Drop
    // the declaration and the guard must name every file that reads it.
    expect(base.references.has('--v2-ink-3')).toBe(true)
    const mutated: Scan = {
      files: base.files,
      definitions: new Set([...base.definitions].filter((name) => name !== '--v2-ink-3')),
      references: new Map(base.references),
    }
    expect(unresolved(mutated)).toContain('--v2-ink-3')
    expect(unresolved(base)).not.toContain('--v2-ink-3')
  })

  it('deleting a template prefix expansion turns it red', () => {
    // The prefix rule must not be a blanket pass: remove every `--v2-avatar-*`
    // definition and `var(--v2-avatar-${n})` becomes unresolved.
    const mutated: Scan = {
      files: base.files,
      definitions: new Set([...base.definitions].filter((name) => !name.startsWith('--v2-avatar-'))),
      references: new Map(base.references),
    }
    const missing = unresolved(mutated)
    expect(missing.some((name) => name.startsWith('--v2-avatar-'))).toBe(true)
  })

  it('a fallback exempts a reference, and only that reference', () => {
    const mutated: Scan = {
      files: base.files,
      definitions: new Set(base.definitions),
      references: new Map(base.references),
    }
    mutated.references.set('--v2-not-a-token', { hasFallback: true, files: new Set(['x.tsx']) })
    expect(unresolved(mutated)).not.toContain('--v2-not-a-token')
    mutated.references.set('--v2-not-a-token', { hasFallback: false, files: new Set(['x.tsx']) })
    expect(unresolved(mutated)).toContain('--v2-not-a-token')
  })
})
