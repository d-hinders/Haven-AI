/**
 * The source guard (#3515): the security contracts that must hold for the
 * WHOLE tree, enforced by reading it.
 *
 * - The token never reaches a cookie or localStorage: the ops sources name
 *   neither, and the only Storage the app touches is window.sessionStorage.
 * - No third-party or analytics scripts, and no dangerouslySetInnerHTML.
 * - Importing from packages/frontend fails: the ops app consumes @haven_ai/ui
 *   and @haven_ai/core only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = join(__dirname, '..', '..')
const SRC = join(PACKAGE_ROOT, 'src')

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) {
      // node_modules is not source; __tests__ carries this guard's own
      // enforcement strings and is not app surface either.
      if (entry === 'node_modules' || entry === '__tests__') continue
      yield* walk(p)
    } else if (/\.(tsx?|css|mjs|js)$/.test(entry)) {
      yield p
    }
  }
}

function allSources(): Map<string, string> {
  const files = new Map<string, string>()
  for (const file of walk(SRC)) {
    files.set(
      relative(PACKAGE_ROOT, file).split(sep).join('/'),
      stripComments(readFileSync(file, 'utf8')),
    )
  }
  // The package-root config files are sources too.
  for (const name of ['next.config.ts', 'tailwind.config.js', 'postcss.config.mjs', 'vitest.config.ts']) {
    files.set(name, stripComments(readFileSync(join(PACKAGE_ROOT, name), 'utf8')))
  }
  return files
}

/**
 * Strip comments so the bans hit CODE, not prose. A docstring that says the
 * token must never reach localStorage is the contract being enforced, not a
 * violation of it. Line comments are matched only at line start, so URLs
 * (`https://…`) inside strings survive; block comments cannot contain a
 * string that matters (none of these checks reads one).
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('the token never reaches a cookie or localStorage (#3515)', () => {
  it('no ops source names localStorage or document.cookie', () => {
    for (const [name, source] of allSources()) {
      expect(source.includes('localStorage'), `${name} names localStorage`).toBe(false)
      expect(source.includes('document.cookie'), `${name} names document.cookie`).toBe(false)
    }
  })

  it('the only session Storage the app reads is sessionStorage', () => {
    let sessionStorageReads = 0
    for (const source of allSources().values()) {
      if (source.includes('window.sessionStorage')) sessionStorageReads++
    }
    expect(sessionStorageReads).toBeGreaterThan(0)
  })
})

describe('no third-party scripts and no HTML injection (#3515)', () => {
  it('no dangerouslySetInnerHTML anywhere in packages/ops', () => {
    for (const [name, source] of allSources()) {
      expect(source.includes('dangerouslySetInnerHTML'), `${name} uses dangerouslySetInnerHTML`).toBe(false)
    }
  })

  it('no analytics or third-party script host is referenced', () => {
    const banned = ['googletagmanager', 'google-analytics', 'segment.com', 'posthog', 'plausible', 'matomo']
    for (const [name, source] of allSources()) {
      for (const host of banned) {
        expect(source.includes(host), `${name} references ${host}`).toBe(false)
      }
    }
  })
})

describe('importing from packages/frontend fails, enforced as a test (#3515)', () => {
  it('no ops source imports from the frontend package or its aliases', () => {
    const frontendImport = /(?:from\s+|require\(\s*|import\s+)['"](?:@haven\/frontend|packages\/frontend)/
    for (const [name, source] of allSources()) {
      expect(frontendImport.test(source), `${name} imports from packages/frontend`).toBe(false)
    }
  })

  it('ops consumes only the shared packages it declares', () => {
    // Everything cross-package must come from @haven_ai/core or @haven_ai/ui.
    // Scoped specifiers need BOTH segments: '@haven_ai/core/x'.split('/').slice(0, 2)
    // is the package, while [0] alone would be the bare scope.
    const internalImports = new Set<string>()
    for (const source of allSources().values()) {
      for (const m of source.matchAll(/from\s+'(@[^']+)'/g)) {
        if (m[1].startsWith('@haven_ai/')) internalImports.add(m[1].split('/').slice(0, 2).join('/'))
      }
    }
    expect([...internalImports].sort()).toEqual(['@haven_ai/core', '@haven_ai/ui'])
  })
})
