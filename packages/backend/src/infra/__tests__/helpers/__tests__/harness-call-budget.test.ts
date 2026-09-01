/**
 * Structural guard: the harness's COLD cost must be charged to a hook budget,
 * never to the per-test one (#2329).
 *
 * ## The defect this exists to prevent
 *
 * `resetDb()` awaits `initDbHarness()` as a documented guarantee (#1562), and
 * `initDbHarness()` brings this worker's schema to the migration head —
 * serialised across vitest workers by a global advisory lock, so a waiting
 * worker's cost is the sum of the migration runs ahead of it. That cost grows
 * with every migration and multiplies under CI contention. `vitest.config.ts`
 * budgets it explicitly and says so: `hookTimeout: 120_000`, sized for "what
 * the hook actually does" (#1372).
 *
 * That budget only applies to a call made from a hook. The SAME call made as
 * the first statement of an `it` body is charged to vitest's 5000 ms
 * `testTimeout`, which was never sized for a migration run. Two files did
 * exactly that, and both timed out in CI on pull requests that could not have
 * caused it — `uuid-param-22p02.test.ts` (#2274, and again in #2295's run) and
 * `catalog-ingest-lock.test.ts` (#2295's run) — with a bare
 * `Test timed out in 5000ms` naming an innocent test.
 *
 * The measurement that settles it: on #2295's runner one bare `resetDb()`
 * measured **4634 ms against the 5000 ms budget**, versus **1162 ms** on green
 * `dev` — the same 223 files. So the failure is not a test getting slower in
 * proportion to load. It is a FIXED wall that only the call sites on the wrong
 * side of the hook/test line stand behind: 48 files put the harness in a hook
 * and cannot trip it; the two that did not, did.
 *
 * ## The rule
 *
 * A `resetDb()` / `initDbHarness()` call inside an `it`/`test` body is allowed
 * only when its cost is budgeted, which means one of:
 *
 * 1. the file also calls the harness from `beforeAll`/`beforeEach`, so the cold
 *    run is already paid there and the in-body call is a warm one (~25 ms
 *    locally) — this is how the harness's own suites legitimately call
 *    `resetDb()` mid-test, because there the reset IS the subject; or
 * 2. that `it`/`test` declares an explicit timeout argument, which is how
 *    `db-harness-lock-concurrency.test.ts` deliberately makes an unwarmed
 *    `initDbHarness()` its first call for a positive control, under 180_000 ms.
 *
 * Both escapes are visible in the file, which is the point: the budget a
 * harness call runs under should be readable at the call site rather than
 * inherited by accident from where someone happened to type it.
 *
 * ## Why not simply raise `testTimeout`
 *
 * Because there is no number that works. The cold path's worst case is a
 * migration run PLUS every queued worker's migration run ahead of it — which is
 * why the harness's own lock deadline is 10 minutes and deliberately LARGER
 * than `hookTimeout`. Any `testTimeout` big enough to cover that is a
 * `testTimeout` that no longer detects a hung test, and it would be applied to
 * all 223 backend test files to protect two call sites. The repository already
 * made this decision once and wrote the answer down as two different numbers
 * for two different kinds of cost; this guard keeps call sites on the correct
 * side of that line.
 *
 * ## Reading source, not text
 *
 * Parsed with the TypeScript parser, for the reason `import-facts.ts` gives:
 * comments are not AST nodes, so the paragraphs above — which name
 * `resetDb()` and `initDbHarness()` repeatedly — cannot reach the buckets, and
 * no formatting or quoting hides a real call from them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const HARNESS_CALLS = new Set(['resetDb', 'initDbHarness'])
const TEST_OPENERS = new Set(['it', 'test'])
const HOOK_OPENERS = new Set(['beforeAll', 'beforeEach'])

const BACKEND_SRC = fileURLToPath(new URL('../../../..', import.meta.url))

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...testFiles(full))
    else if (entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/**
 * The name a call expression is invoking, flattened so `it.each(...)(...)`,
 * `it.skipIf(x)(...)` and `describe.only(...)` all report their root opener.
 */
function calleeRoot(node: ts.CallExpression): string | null {
  let expr: ts.Expression = node.expression
  for (;;) {
    if (ts.isIdentifier(expr)) return expr.text
    if (ts.isPropertyAccessExpression(expr)) {
      expr = expr.expression
      continue
    }
    if (ts.isCallExpression(expr)) {
      expr = expr.expression
      continue
    }
    return null
  }
}

type Site = {
  line: number
  call: string
  enclosing: 'test' | 'hook' | 'other'
}

type FileFacts = {
  /** Every `resetDb()` / `initDbHarness()` call site in the file. */
  sites: Site[]
  /** In-body call sites that neither escape covers. */
  unbudgetedTestSites: Site[]
  /** Whether any harness call is made from `beforeAll`/`beforeEach`. */
  warmedInHook: boolean
}

function readHarnessCallFacts(
  source: string,
  fileName: string,
): FileFacts {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const sites: Site[] = []
  const unbudgetedTestSites: Site[] = []
  let warmedInHook = false

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeRoot(node)
      if (name && HARNESS_CALLS.has(name)) {
        // Nearest enclosing opener. `describe` is not one: it does not create a
        // budget, so a harness call directly in a describe body is neither.
        let enclosing: Site['enclosing'] = 'other'
        let budgeted = false
        for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
          if (!ts.isCallExpression(p)) continue
          const opener = calleeRoot(p)
          if (!opener) continue
          if (HOOK_OPENERS.has(opener)) {
            enclosing = 'hook'
            warmedInHook = true
            break
          }
          if (TEST_OPENERS.has(opener)) {
            enclosing = 'test'
            // Escape 2: an explicit timeout argument. vitest's signature is
            // (name, fn, timeoutOrOptions), so a third argument is the budget.
            budgeted = p.arguments.length >= 3
            break
          }
        }
        const site: Site = {
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          call: name,
          enclosing,
        }
        sites.push(site)
        if (enclosing === 'test' && !budgeted) unbudgetedTestSites.push(site)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  return { sites, unbudgetedTestSites, warmedInHook }
}

describe('harness cold cost is charged to a hook budget, never to testTimeout (#2329)', () => {
  const files = testFiles(BACKEND_SRC)
  const scanned = files
    .map((file) => ({
      file: file.slice(BACKEND_SRC.length),
      facts: readHarnessCallFacts(readFileSync(file, 'utf8'), file),
    }))
    .filter(({ facts }) => facts.sites.length > 0)

  it('POSITIVE CONTROL: the scan actually found the harness call sites', () => {
    // A zero here is the failure mode this whole file is exposed to — a walker
    // that silently matches nothing agrees with every rule it is asked to
    // enforce. Pinned as lower bounds, not exact counts, so adding a real-DB
    // suite does not fail an unrelated PR; a broken scan cannot clear them.
    expect(scanned.length).toBeGreaterThanOrEqual(40)
    expect(
      scanned.reduce((n, s) => n + s.facts.sites.length, 0),
    ).toBeGreaterThanOrEqual(100)
    // And both escape shapes are genuinely exercised in the tree, so neither
    // branch of the rule is dead code that has never run against real source.
    expect(scanned.some(({ facts }) => facts.warmedInHook)).toBe(true)
    expect(
      scanned.some(({ facts }) =>
        facts.sites.some((s) => s.enclosing === 'test'),
      ),
    ).toBe(true)
  })

  it('every in-body harness call is warmed by a hook or carries an explicit timeout', () => {
    const violations = scanned
      .filter(
        ({ facts }) =>
          !facts.warmedInHook && facts.unbudgetedTestSites.length > 0,
      )
      .flatMap(({ file, facts }) =>
        facts.unbudgetedTestSites.map(
          (site) =>
            `${file}:${site.line} — ${site.call}() runs inside an it() body with no ` +
            'beforeAll/beforeEach harness call in the file and no explicit timeout, so ' +
            "it is charged to vitest's 5000 ms testTimeout (#2329)",
        ),
      )
    expect(violations).toEqual([])
  })
})

describe('the budget rule itself, against fixtures', () => {
  // The rule is enforced over a tree that is currently clean, so without these
  // the "no violations" assertion above cannot be distinguished from a rule
  // that never says no. Each fixture is the minimal shape of one decision.
  const at = (src: string) => readHarnessCallFacts(src, 'fixture.test.ts')

  it('flags a bare resetDb() first in an it body — the #2274/#2295 shape', () => {
    const facts = at(`
      describeDb('x', () => {
        it('a', async () => {
          await resetDb()
        })
      })
    `)
    expect(facts.warmedInHook).toBe(false)
    expect(facts.unbudgetedTestSites.map((s) => s.call)).toEqual(['resetDb'])
  })

  it('accepts an in-body call when a hook already paid the cold run', () => {
    const facts = at(`
      describeDb('x', () => {
        beforeEach(async () => {
          await resetDb()
        })
        it('a', async () => {
          await resetDb()
        })
      })
    `)
    expect(facts.warmedInHook).toBe(true)
  })

  it('accepts an unwarmed in-body call that declares its own timeout', () => {
    const facts = at(`
      describeDb('x', () => {
        it('a', async () => {
          await initDbHarness()
        }, 180_000)
      })
    `)
    expect(facts.warmedInHook).toBe(false)
    expect(facts.unbudgetedTestSites).toEqual([])
  })

  it('does not read the names out of comments or strings', () => {
    const facts = at(`
      // await resetDb() in an it body would be a violation
      describeDb('x', () => {
        it('a', async () => {
          expect('await initDbHarness()').toBeTruthy()
        })
      })
    `)
    expect(facts.sites).toEqual([])
  })
})
