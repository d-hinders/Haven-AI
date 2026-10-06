/**
 * Every class a `@haven_ai/ui` primitive uses has a rule the ops console
 * actually loads (#3611).
 *
 * The ui primitives style themselves mostly with Tailwind utilities, which the
 * shared preset generates in each app. A handful of classes are hand-written
 * rules instead (`v2-text-h1`, `v2-tabular`, …). Until #3611 those rules lived
 * only in the dashboard's globals.css, so in the ops console they styled
 * nothing: every PageHeader title rendered at body size.
 *
 * How the guard decides, mechanically:
 *   - USED: class tokens from every string literal in `packages/ui/src/*.tsx`
 *     (not tests), after removing `[…]` arbitrary values and `var(…)`, with
 *     variant prefixes (`md:`, `hover:`) stripped. Tokens, not lines.
 *   - NEEDS A RULE: a used token in the `v2-` namespace, or one that any
 *     hand-written stylesheet in the repo defines (the dashboard's globals.css,
 *     the ops globals.css, the ui package's own stylesheets).
 *   - REACHABLE: classes defined by the stylesheets ops' root layout imports,
 *     resolved the way the bundler resolves them (package `exports` for
 *     `@haven_ai/ui/…`, relative paths otherwise) and following `@import`.
 *     Nothing is hard-coded: drop the import and the classes become
 *     unreachable.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const OPS_ROOT = join(__dirname, '..', '..')
const LAYOUT = join(OPS_ROOT, 'src', 'app', 'layout.tsx')
const REPO = join(OPS_ROOT, '..', '..')
const UI_SRC = join(REPO, 'packages', 'ui', 'src')
// Read as a file, never imported: the source guard forbids ops importing from
// the dashboard, and this only collects the class names it defines.
const DASHBOARD_GLOBALS = join(REPO, 'packages', 'frontend', 'src', 'app', 'globals.css')

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Class names a stylesheet defines: `.name` inside each rule's selector, never inside a declaration. */
function definedClasses(css: string): Set<string> {
  const out = new Set<string>()
  for (const m of stripCssComments(css).matchAll(/([^{};]+)\{/g)) {
    const selector = m[1]
    if (selector.trim().startsWith('@')) continue
    for (const c of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(c[1])
  }
  return out
}

/** The CSS files a module imports, in order, resolved from that module's directory. */
function cssImportsOf(file: string): string[] {
  const req = createRequire(file)
  const out: string[] = []
  for (const m of readFileSync(file, 'utf8').matchAll(/^\s*import\s+['"]([^'"]+\.css)['"]/gm)) {
    const spec = m[1]
    out.push(spec.startsWith('.') ? resolve(dirname(file), spec) : req.resolve(spec))
  }
  return out
}

/** Every class reachable from the given stylesheets, following `@import`. */
function reachableClasses(sheets: string[]): Set<string> {
  const seen = new Set<string>()
  const classes = new Set<string>()
  const visit = (sheet: string) => {
    if (seen.has(sheet)) return
    seen.add(sheet)
    const css = readFileSync(sheet, 'utf8')
    for (const c of definedClasses(css)) classes.add(c)
    for (const m of stripCssComments(css).matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      visit(spec.startsWith('.') ? resolve(dirname(sheet), spec) : createRequire(sheet).resolve(spec))
    }
  }
  sheets.forEach(visit)
  return classes
}

/** Class tokens in a source file's string literals (`'…'`, `"…"`, `` `…` ``). */
function classTokens(source: string): Set<string> {
  const out = new Set<string>()
  for (const m of source.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) {
    const literal = (m[1] ?? m[2] ?? m[3] ?? '')
      .replace(/\$\{[^}]*\}/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/var\([^)]*\)/g, ' ')
    for (const raw of literal.split(/\s+/)) {
      const token = raw.slice(raw.lastIndexOf(':') + 1).replace(/^!/, '')
      if (/^-?[a-z][a-z0-9-]*$/.test(token)) out.add(token)
    }
  }
  return out
}

function uiSources(): string[] {
  return readdirSync(UI_SRC)
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
    .map((f) => join(UI_SRC, f))
}

function uiStylesheets(): string[] {
  return readdirSync(UI_SRC)
    .filter((f) => f.endsWith('.css'))
    .map((f) => join(UI_SRC, f))
}

describe('@haven_ai/ui classes reach the ops console (#3611)', () => {
  const sheets = cssImportsOf(LAYOUT)
  const reachable = reachableClasses(sheets)

  const handWritten = new Set<string>()
  for (const sheet of [DASHBOARD_GLOBALS, ...uiStylesheets(), ...sheets]) {
    if (existsSync(sheet)) for (const c of definedClasses(readFileSync(sheet, 'utf8'))) handWritten.add(c)
  }

  it('the instruments see what they claim to see', () => {
    // Positive controls: without them an empty set would pass the real check.
    expect(sheets.length, 'ops layout imports no stylesheet').toBeGreaterThan(0)
    expect([...classTokens("className={`v2-text-h1 md:v2-tabular text-[var(--v2-text-h1)]`}")]).toEqual(
      expect.arrayContaining(['v2-text-h1', 'v2-tabular']),
    )
    expect(classTokens('text-[var(--v2-text-h1)]').has('v2-text-h1')).toBe(false)
    expect([...definedClasses('.a, .b:hover { color: red } @media (x) { .c { margin: 0.5rem } }')].sort()).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('every hand-written class a ui primitive uses has a rule the ops layout loads', () => {
    const missing: string[] = []
    for (const file of uiSources()) {
      for (const token of classTokens(readFileSync(file, 'utf8'))) {
        const needsRule = token.startsWith('v2-') || handWritten.has(token)
        if (needsRule && !reachable.has(token)) missing.push(`${file.slice(UI_SRC.length + 1)}: .${token}`)
      }
    }
    expect(missing, `no rule reachable from ops' layout.tsx for:\n${missing.join('\n')}`).toEqual([])
  })

  it('ops imports the shared type sheet after its globals.css, keeping the cascade the dashboard has', () => {
    const order = sheets.map((s) => s.replace(/\\/g, '/'))
    const globals = order.findIndex((s) => s.endsWith('/src/app/globals.css'))
    const type = order.findIndex((s) => s.endsWith('/ui/src/type.css'))
    expect(globals, 'ops layout does not import its globals.css').toBeGreaterThanOrEqual(0)
    expect(type, 'ops layout does not import @haven_ai/ui/type.css').toBeGreaterThan(globals)
  })
})
