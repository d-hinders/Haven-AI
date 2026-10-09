/**
 * The import guard for the budget-remaining cache (#3804).
 *
 * The cache is DISPLAY-ONLY: `readRemainingBudget` is the fresh read behind
 * every spend decision (pre-checks, x402 authorisation, payments, balance
 * coverage, allowances, the re-key meter, task budgets, merchants), and a
 * cache in that path would let a spend decision run on up-to-60 s-old
 * numbers. Owner decision 2 (2026-10-09): the agent page's own
 * `?include=remaining` poll stays UNCACHED too — the ONLY legitimate importer
 * of the cache module is the new dashboard route.
 *
 * Source-read rather than runtime (the #2859 lesson): a lazy `await import()`
 * inside a rarely-hit branch would never show up in a module graph the tests
 * happen to execute.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BACKEND_SRC = fileURLToPath(new URL('../../..', import.meta.url))

/** Every non-test .ts/.tsx source file under packages/backend/src, recursively. */
function sourceFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__') continue
    const rel = path.posix.join(prefix, e.name)
    if (e.isDirectory()) {
      out.push(...sourceFiles(path.join(dir, e.name), `${rel}/`))
      continue
    }
    if (!e.isFile()) continue
    if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue
    if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) continue
    out.push(rel)
  }
  return out
}

const CACHE_MODULE = 'budget-remaining-cache'

/**
 * Every import specifier a source file declares — static `import … from` and
 * dynamic `import()`. Text-scanning the whole file would flag the cache's
 * own DOC REFERENCES in other modules' comments; only real imports count.
 */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const m of source.matchAll(/(?:^|\n)\s*import\s[^;'"]*?from\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(m[1])
  }
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(m[1])
  }
  return specifiers
}

function importsCacheModule(source: string): boolean {
  return importSpecifiers(source).some((spec) => spec.endsWith(`${CACHE_MODULE}.js`))
}

describe('the budget-remaining cache has exactly one importer (#3804)', () => {
  it('finds the backend source tree it claims to guard (unfalsifiability floor)', () => {
    const files = sourceFiles(BACKEND_SRC)
    expect(files.length).toBeGreaterThan(200)
    expect(files).toContain('routes/dashboard-budget-remaining.ts')
    expect(files).toContain('modules/dashboard/budget-remaining-cache.ts')
  })

  it('the ONLY file importing the cache is the new dashboard route', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(BACKEND_SRC)) {
      if (file === `modules/dashboard/${CACHE_MODULE}.ts`) continue
      const source = readFileSync(path.join(BACKEND_SRC, file), 'utf8')
      if (importsCacheModule(source)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual(['routes/dashboard-budget-remaining.ts'])
  })

  it('nothing on the money path imports it — named explicitly so a regression names its file', () => {
    // The issue's list of files where a cache must NEVER sit, plus the two
    // directories most likely to grow a shortcut. The scan above already
    // rejects any of these; this test exists so the failure reads as
    // "you cached the spend path", not as a generic offender list.
    const forbidden = [
      'modules/mpp/budget-precheck.ts',
      'modules/budget-scope/precheck.ts',
      'modules/x402/delegation-authorize.ts',
      'routes/payments.ts',
      'routes/agent-rekey.ts',
      'modules/mpp/balance-coverage.ts',
      'modules/mpp/allowances.ts',
      'modules/task-budgets/task-budget-service.ts',
      'modules/agents/rekey-carry.ts',
      'routes/merchants.ts',
      'infra/chain/delegation-budget-reader.ts',
    ]
    for (const file of forbidden) {
      const source = readFileSync(path.join(BACKEND_SRC, file), 'utf8')
      expect(
        importsCacheModule(source),
        `${file} must never import the budget-remaining cache`,
      ).toBe(false)
    }
  })
})
