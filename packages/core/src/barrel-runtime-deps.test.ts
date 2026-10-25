/**
 * The `@haven_ai/core` barrel imports nothing a production image lacks.
 *
 * The backend and mcp-server images install with `npm ci --omit=dev`, and
 * every runtime service imports this barrel, so a module reachable from
 * `index.ts` that imports a devDependency stops every service from booting.
 * #4413 did exactly that: re-exporting the comment stripper put a bare
 * `import ts from 'typescript'` at the top of `dist/index.js`, and every dev
 * deploy failed until the stripper moved to its own subpath.
 *
 * This walks the barrel's RELATIVE import graph in source (so an indirect
 * re-export is caught too) and checks every bare specifier it reaches against
 * the package's runtime `dependencies` (none today) and Node built-ins.
 */
import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(resolve(SRC, '../package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}
const RUNTIME = new Set(Object.keys(PKG.dependencies ?? {}))
// `import`/`export … from`, and side-effect imports; type-only ones are erased.
const SPECIFIER = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm

function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    const bare: string[] = []
    seen.set(file, bare)
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
      else bare.push(spec)
    }
  }
  return seen
}

function packageName(spec: string): string {
  const parts = spec.replace(/^node:/, '').split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

describe('@haven_ai/core barrel runtime dependencies', () => {
  const graph = reachable(resolve(SRC, 'index.ts'))

  it('walks a real graph (positive control)', () => {
    expect(graph.size).toBeGreaterThan(10)
  })

  it('reaches no bare import outside runtime dependencies and Node built-ins', () => {
    const offenders = [...graph].flatMap(([file, specs]) =>
      specs
        .filter((spec) => !builtinModules.includes(packageName(spec)) && !RUNTIME.has(packageName(spec)))
        .map((spec) => `${file.slice(SRC.length + 1)} → ${spec}`),
    )
    expect(offenders).toEqual([])
  })

  it('does not reach the comment stripper, which imports typescript', () => {
    expect([...graph.keys()].some((file) => file.endsWith('comment-stripper.ts'))).toBe(false)
    // and the stripper really is the kind of module this guard exists for
    expect(reachable(resolve(SRC, 'comment-stripper.ts')).get(resolve(SRC, 'comment-stripper.ts'))).toContain(
      'typescript',
    )
  })
})
