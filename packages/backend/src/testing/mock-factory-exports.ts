/**
 * The mechanism behind a defect this repository has regrown three times.
 *
 * `vi.mock('../../rails/allowance-module.js', () => allowanceMocks)` replaces a
 * module wholesale. Vitest does NOT check the factory's keys against the real
 * module's exports, so a factory entry for a name the module does not export is
 * silently accepted as a brand-new function that nothing can ever call. Every
 * assertion written against it — `expect(mocks.executeAllowanceTransfer)
 * .not.toHaveBeenCalled()` — then passes unconditionally, and reads in review
 * exactly like a guard that works.
 *
 * That is how #1987 (which deleted the module's internals and left the mocks
 * pointing at them), #2048 and #2044/#1993 each removed instances of this shape
 * without removing the shape, and how it reached 56 unfalsifiable money-path
 * guards by #2307.
 *
 * This module is the mechanical answer: it statically extracts every mock
 * factory's top-level keys and every target module's real export names, and
 * reports any key that is not an export. It is deliberately **static** — no
 * dynamic `import()` — because the mocked set includes modules like `../../db.js`
 * whose import opens a connection pool, and a guard that has to be skipped for
 * the dangerous modules guards nothing.
 *
 * Anything it cannot parse is reported as a FAILURE, never skipped. A silent
 * skip is how the first three rounds of this defect survived their own cleanups.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface PhantomKey {
  testFile: string
  moduleSpec: string
  resolvedModule: string
  key: string
}

export interface UnparseableTarget {
  testFile: string
  moduleSpec: string
  reason: string
}

export interface ScanResult {
  phantoms: PhantomKey[]
  unparseable: UnparseableTarget[]
  /** Factories actually checked — a scan that checks nothing must not read as a pass. */
  checkedFactories: number
  scannedTestFiles: number
}

const TEST_FILE_RE = /\.test\.ts$/

export function listTestFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (TEST_FILE_RE.test(entry.name)) out.push(full)
    }
  }
  walk(root)
  return out.sort()
}

/** Resolve a `./x.js`-style ESM specifier to the TypeScript source that backs it. */
export function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null // bare specifier: node_modules, out of scope
  const base = path.resolve(path.dirname(fromFile), spec).replace(/\.js$/, '')
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Balanced-delimiter scan from an opening bracket. Returns the index of the
 * matching close, or -1. String and comment aware, because a `}` inside a
 * template literal or a `//` comment is not a delimiter.
 */
function matchDelimiter(src: string, openIdx: number): number {
  const open = src[openIdx]
  const close = open === '{' ? '}' : open === '(' ? ')' : null
  if (!close) return -1
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      i = src.indexOf('\n', i)
      if (i === -1) return -1
      continue
    }
    if (c === '/' && next === '*') {
      i = src.indexOf('*/', i + 2) + 1
      if (i === 0) return -1
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Top-level keys of an object literal body (the text between its braces). */
function objectLiteralKeys(body: string): string[] {
  const keys: string[] = []
  let depth = 0
  let atKeyPosition = true
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    const next = body[i + 1]
    if (c === '/' && next === '/') {
      i = body.indexOf('\n', i)
      if (i === -1) break
      continue
    }
    if (c === '/' && next === '*') {
      i = body.indexOf('*/', i + 2) + 1
      if (i === 0) break
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      const start = i + 1
      i++
      while (i < body.length && body[i] !== quote) {
        if (body[i] === '\\') i++
        i++
      }
      if (depth === 0 && atKeyPosition) {
        // A quoted key only counts if a colon follows.
        const after = body.slice(i + 1).match(/^\s*:/)
        if (after) {
          keys.push(body.slice(start, i))
          atKeyPosition = false
        }
      }
      continue
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++
      continue
    }
    if (c === '}' || c === ')' || c === ']') {
      depth--
      continue
    }
    if (depth === 0 && c === ',') {
      atKeyPosition = true
      continue
    }
    if (depth === 0 && atKeyPosition && /[A-Za-z_$]/.test(c)) {
      const rest = body.slice(i)
      const m = rest.match(/^([A-Za-z_$][\w$]*)\s*(:|,|\}|$)/)
      if (m) {
        keys.push(m[1])
        atKeyPosition = false
        i += m[1].length - 1
        continue
      }
      // Spread or something else at key position — advance past the token.
      const tok = rest.match(/^[A-Za-z_$][\w$]*/)
      if (tok) i += tok[0].length - 1
      atKeyPosition = false
    }
    if (depth === 0 && c === '.' && body.slice(i, i + 3) === '...') {
      atKeyPosition = false
    }
  }
  return keys
}

/** Every export NAME a TypeScript module provides, following barrel re-exports. */
export function moduleExportNames(
  file: string,
  seen = new Set<string>(),
): { names: Set<string> | null; reason?: string } {
  if (seen.has(file)) return { names: new Set() }
  seen.add(file)
  let src: string
  try {
    src = fs.readFileSync(file, 'utf8')
  } catch {
    return { names: null, reason: `cannot read ${file}` }
  }
  const names = new Set<string>()

  // export function foo / const foo / class Foo / interface Foo / type Foo / enum Foo
  const decl =
    /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm
  for (const m of src.matchAll(decl)) names.add(m[1])

  // export default (anonymous)
  if (/^\s*export\s+default\s/m.test(src)) names.add('default')

  // export { a, b as c } [from '...']
  const named = /^\s*export\s*\{([^}]*)\}\s*(?:from\s*'([^']+)')?/gm
  for (const m of src.matchAll(named)) {
    for (const part of m[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      const asMatch = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/)
      const name = asMatch ? asMatch[1] : t.replace(/^type\s+/, '').trim()
      if (name) names.add(name)
    }
  }

  // export * from '...' — must be followed, or a barrel's exports are invisible
  const star = /^\s*export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s*)?from\s*'([^']+)'/gm
  for (const m of src.matchAll(star)) {
    if (m[1]) {
      names.add(m[1])
      continue
    }
    const target = resolveSpec(file, m[2])
    if (!target) {
      // A barrel re-exporting a bare specifier: its names cannot be resolved
      // statically, so this module's export set is UNKNOWN, not empty.
      return { names: null, reason: `\`export * from '${m[2]}'\` resolves outside the source tree` }
    }
    const inner = moduleExportNames(target, seen)
    if (!inner.names) return inner
    for (const n of inner.names) names.add(n)
  }

  return { names }
}

/** Extract every `vi.mock(spec, () => <object|identifier>)` factory in a test file. */
function factoriesIn(src: string): { spec: string; keys: string[] | null; ident?: string }[] {
  const out: { spec: string; keys: string[] | null; ident?: string }[] = []
  const re = /vi\.mock\(\s*'([^']+)'\s*,\s*(?:async\s*)?\(\)\s*=>\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const spec = m[1]
    const rest = src.slice(re.lastIndex)
    if (rest.startsWith('(')) {
      // () => ({ ... })
      const parenEnd = matchDelimiter(src, re.lastIndex)
      const inner = src.slice(re.lastIndex + 1, parenEnd).trim()
      if (inner.startsWith('{')) {
        const braceStart = src.indexOf('{', re.lastIndex + 1)
        const braceEnd = matchDelimiter(src, braceStart)
        out.push({ spec, keys: objectLiteralKeys(src.slice(braceStart + 1, braceEnd)) })
      } else {
        const identMatch = inner.match(/^([A-Za-z_$][\w$]*)$/)
        out.push({ spec, keys: null, ident: identMatch ? identMatch[1] : undefined })
      }
      continue
    }
    if (rest.startsWith('{')) {
      // () => { ... return { ... } } — a body, not an expression. Not the
      // wholesale-replacement shape this guard is about; skipped by design.
      continue
    }
    const identMatch = rest.match(/^([A-Za-z_$][\w$]*)\s*\)/)
    out.push({ spec, keys: null, ident: identMatch ? identMatch[1] : undefined })
  }
  return out
}

/**
 * Keys of a top-level object bound to `ident`, whether it comes from
 * `vi.hoisted(() => ({ ident: { ... } }))` or a plain `const ident = { ... }`.
 */
function identifierObjectKeys(src: string, ident: string): string[] | null {
  // `const ident = { ... }`
  const direct = new RegExp(`(?:const|let|var)\\s+${ident}\\s*(?::[^=]+)?=\\s*\\{`).exec(src)
  if (direct) {
    const braceStart = src.indexOf('{', direct.index + direct[0].length - 1)
    const end = matchDelimiter(src, braceStart)
    if (end !== -1) return objectLiteralKeys(src.slice(braceStart + 1, end))
  }

  // `const ident = vi.hoisted(() => ({ ... }))` — the undestructured hoisted form
  const boundHoisted = new RegExp(
    `(?:const|let|var)\\s+${ident}\\s*(?::[^=]+)?=\\s*vi\\.hoisted\\(\\s*(?:async\\s*)?\\(\\)\\s*=>\\s*\\(`,
  ).exec(src)
  if (boundHoisted) {
    const parenIdx = src.indexOf('(', boundHoisted.index + boundHoisted[0].length - 1)
    const braceStart = src.indexOf('{', parenIdx)
    const parenEnd = matchDelimiter(src, parenIdx)
    if (braceStart !== -1 && parenEnd !== -1 && braceStart < parenEnd) {
      const braceEnd = matchDelimiter(src, braceStart)
      if (braceEnd !== -1) return objectLiteralKeys(src.slice(braceStart + 1, braceEnd))
    }
  }
  // Inside a vi.hoisted destructuring: `const { a, b } = vi.hoisted(() => ({ a: {...} }))`
  const hoisted = /vi\.hoisted\(\s*(?:async\s*)?\(\)\s*=>\s*\(/g
  let m: RegExpExecArray | null
  while ((m = hoisted.exec(src))) {
    const parenIdx = src.indexOf('(', m.index + m[0].length - 1)
    const parenEnd = matchDelimiter(src, parenIdx)
    if (parenEnd === -1) continue
    const braceStart = src.indexOf('{', parenIdx)
    if (braceStart === -1 || braceStart > parenEnd) continue
    const braceEnd = matchDelimiter(src, braceStart)
    const body = src.slice(braceStart + 1, braceEnd)
    // Find `ident: { ... }` at top level of the hoisted object.
    const propRe = new RegExp(`(^|[,{\\s])${ident}\\s*:\\s*\\{`)
    const prop = propRe.exec(body)
    if (!prop) continue
    const innerStart = body.indexOf('{', prop.index + prop[0].length - 1)
    const innerEnd = matchDelimiter(body, innerStart)
    if (innerEnd !== -1) return objectLiteralKeys(body.slice(innerStart + 1, innerEnd))
  }
  return null
}

export function scanForPhantomMockKeys(root: string): ScanResult {
  const phantoms: PhantomKey[] = []
  const unparseable: UnparseableTarget[] = []
  let checkedFactories = 0
  const testFiles = listTestFiles(root)

  for (const testFile of testFiles) {
    const src = fs.readFileSync(testFile, 'utf8')
    for (const factory of factoriesIn(src)) {
      const resolved = resolveSpec(testFile, factory.spec)
      if (!resolved) continue // bare specifier — a real dependency, not our source tree

      let keys = factory.keys
      if (!keys && factory.ident) keys = identifierObjectKeys(src, factory.ident)
      if (!keys) {
        unparseable.push({
          testFile,
          moduleSpec: factory.spec,
          reason: factory.ident
            ? `factory returns identifier \`${factory.ident}\`, whose object literal could not be located`
            : 'factory return value is not an object literal or a plain identifier',
        })
        continue
      }

      const exported = moduleExportNames(resolved)
      if (!exported.names) {
        unparseable.push({
          testFile,
          moduleSpec: factory.spec,
          reason: exported.reason ?? 'export set could not be determined',
        })
        continue
      }

      checkedFactories++
      for (const key of keys) {
        if (key === 'default') continue // `export default` bindings vary in shape
        if (!exported.names.has(key)) {
          phantoms.push({
            testFile,
            moduleSpec: factory.spec,
            resolvedModule: resolved,
            key,
          })
        }
      }
    }
  }

  return { phantoms, unparseable, checkedFactories, scannedTestFiles: testFiles.length }
}
