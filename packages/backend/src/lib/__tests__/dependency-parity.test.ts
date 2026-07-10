/**
 * Dependency parity (#826, the PR #840 lesson as CI).
 *
 * A backend import of a package declared only in ANOTHER workspace passes
 * every local gate — tests, tsc, CI — because workspace hoisting resolves it
 * from the repo root. Railway's backend build prunes to this package's own
 * dependencies, so the boot crashes on MODULE_NOT_FOUND and Railway silently
 * keeps serving the last healthy build (observed live: /accounts/hybrid
 * 404ing on dev while /health already showed newer features).
 *
 * This test closes the gap: every bare-specifier import in src/** (and the
 * boot-reachable scripts) must be declared in packages/backend/package.json.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue
      walk(p, out)
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
      out.push(p)
    }
  }
  return out
}

/** Bare package specifier from an import path ("@scope/pkg/sub" → "@scope/pkg"). */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('node:')) return null
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (builtinModules.includes(name)) return null
  return name
}

describe('dependency parity — production imports are declared where they are imported', () => {
  it('every bare import in backend src/ is in backend package.json dependencies', () => {
    const pkg = JSON.parse(readFileSync(path.join(backendRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ])

    const importRe = /(?:^|\n)\s*(?:import\s[^'"]*?from\s*|import\s*\(\s*|export\s[^'"]*?from\s*|require\(\s*)['"]([^'"]+)['"]/g
    const missing = new Map<string, string[]>()
    for (const file of walk(path.join(backendRoot, 'src'))) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(importRe)) {
        const name = packageOf(match[1])
        if (name && !declared.has(name)) {
          const list = missing.get(name) ?? []
          list.push(path.relative(backendRoot, file))
          missing.set(name, list)
        }
      }
    }

    expect(
      [...missing.entries()].map(([name, files]) => `${name} ← ${files.join(', ')}`),
      'hoisted-only imports crash the pruned production build (the PR #840 class)',
    ).toEqual([])
  })
})
