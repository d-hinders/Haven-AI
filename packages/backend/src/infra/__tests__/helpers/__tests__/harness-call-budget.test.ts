/**
 * Structural guard: the harness's COLD cost must be charged to a hook budget,
 * never to the per-test one (#2329).
 *
 * ## The defect this exists to prevent
 *
 * `resetDb()` reaches the migration head before it empties anything, as a
 * documented guarantee (#1562) — it awaits the same memoised run
 * `initDbHarness()` exposes, which brings this worker's schema to head —
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
 * side of the hook/test line stand behind. Counted against `dev` with this
 * file's own AST logic: 47 files call the harness from a hook and cannot trip
 * the per-test budget; of the seven that call it from a test body, four are
 * warmed by a hook of their own and one declares an explicit timeout. Exactly
 * two were unbudgeted, and they are exactly the two that failed.
 *
 * ## The rule
 *
 * A `resetDb()` / `initDbHarness()` call inside an `it`/`test` body is allowed
 * only when its cost is budgeted, which means one of:
 *
 * 1. a `beforeAll`/`beforeEach` in that test's OWN `describe`, or in an
 *    enclosing one, also calls the harness — so the cold run is already paid
 *    and the in-body call is a warm one (~25 ms locally). This is how the
 *    harness's own suites legitimately call `resetDb()` mid-test, because there
 *    the reset IS the subject; or
 * 2. that `it`/`test` declares an explicit timeout, in either vitest spelling —
 *    `it(name, fn, 180_000)` or `it(name, { timeout: 180_000 }, fn)` — which is
 *    how `db-harness-lock-concurrency.test.ts` deliberately keeps an unwarmed
 *    `initDbHarness()` as its own first call for a positive control.
 *
 * Both escapes are visible in the file, which is the point: the budget a
 * harness call runs under should be readable at the call site rather than
 * inherited by accident from where someone happened to type it.
 *
 * ## Two things the first draft got wrong (haven-reviewer, #2329)
 *
 * Recorded because both were silent passes in the guard built to stop silent
 * passes, and both were reproduced against this file rather than argued.
 *
 * - **Escape 1 was file-WIDE.** One boolean per file meant a `beforeEach` in
 *   any `describe` excused an unwarmed cold call in a sibling one — the exact
 *   shape that reddened CI, waved through. Warming is now scoped to the test's
 *   own suite chain. Textual order inside a suite is deliberately NOT part of
 *   it: vitest runs a suite's hooks before every test in that suite regardless
 *   of where they are written, so a hook below the test still warms it.
 * - **A helper hid the call entirely.** `await coldSetup()`, with `resetDb()`
 *   one function away, had no `it` ancestor and so was never even classified.
 *   `harnessReachingLocals` now resolves local functions that reach the harness
 *   to a fixed point, so a chain of helpers is followed rather than one hop.
 * - **Round two: a hook REGISTERED via a helper reopened the first hole.**
 *   `function registerHooks() { beforeEach(() => resetDb()) }` puts the hook
 *   lexically inside the helper, not inside the `describe` that calls it, so
 *   the ancestor walk found no suite and fell back to file scope — marking a
 *   wholly separate, genuinely cold sibling suite warm. Same defect, different
 *   door. `hookRegisteringLocals` resolves that indirection the same way, and
 *   warming now comes from the helper's CALL site, where the suite really is
 *   an ancestor.
 *
 * ## Known limit, stated so a green run is not over-read
 *
 * A harness call behind an **object method** — `helpers.coldSetup()` — is
 * invisible: `calleeRoot` flattens the property chain to `helpers`, which
 * matches no local function name, so nothing attributes the call to the test.
 * Deliberately not chased: resolving arbitrary property-access indirection is a
 * different order of complexity for a much rarer shape than the three above,
 * each of which came from a real defect. A fixture below PINS this limit as a
 * fact rather than leaving it implied, so the day someone closes it the
 * expectation fails and says where to look. Read a green run as "no unbudgeted
 * cold call in the shapes this guard resolves", never as "none exists".
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
const SUITE_OPENERS = new Set(['describe', 'describeDb', 'suite'])

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
 * `it.skipIf(x)(...)`, `test.concurrent(...)` and `describe.only(...)` all
 * report their root opener.
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

/**
 * Does this `it`/`test` call declare a budget of its own?
 *
 * Both vitest spellings count: the positional `it(name, fn, 20_000)` third
 * argument, and the options object `it(name, { timeout: 20_000 }, fn)`.
 */
function declaresOwnTimeout(call: ts.CallExpression): boolean {
  if (call.arguments.length >= 3 && !ts.isObjectLiteralExpression(call.arguments[2])) return true
  return call.arguments.some(
    (arg) =>
      ts.isObjectLiteralExpression(arg) &&
      arg.properties.some(
        (prop) =>
          (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
          prop.name !== undefined &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === 'timeout',
      ),
  )
}

type Site = {
  line: number
  call: string
  /** How the harness was reached: directly, or through a local helper. */
  via: 'direct' | string
}

type FileFacts = {
  /** Every harness call site in the file, direct or through a local helper. */
  sites: Site[]
  /** In-body sites that neither escape covers. */
  unbudgeted: Site[]
  /** True when at least one site is reached through a local helper function. */
  sawIndirect: boolean
  /** True when at least one harness call is made from a hook. */
  sawHook: boolean
  /** True when at least one harness call sits in an `it`/`test` body. */
  sawInBody: boolean
}

/**
 * Local function names whose bodies reach the harness, directly or through
 * another local function. Iterated to a fixed point, so a chain of helpers is
 * followed rather than only one hop — the #2329 review's second finding: a
 * `resetDb()` moved one function away was invisible to the first draft.
 */
function localFunctionBodies(sf: ts.SourceFile): Map<string, ts.Node> {
  const bodies = new Map<string, ts.Node>()
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      bodies.set(node.name.text, node.body)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        bodies.set(node.name.text, init.body)
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(sf)
  return bodies
}

/**
 * Iterate `seed` over the local call graph to a fixed point: a name qualifies
 * when its body satisfies `hits`, or calls a name that already qualifies.
 */
function fixedPoint(
  bodies: Map<string, ts.Node>,
  hits: (node: ts.Node, qualified: Set<string>) => boolean,
): Set<string> {
  const qualified = new Set<string>()
  for (let changed = true; changed; ) {
    changed = false
    for (const [name, body] of bodies) {
      if (qualified.has(name)) continue
      let hit = false
      const scan = (node: ts.Node): void => {
        if (hit) return
        if (hits(node, qualified)) {
          hit = true
          return
        }
        ts.forEachChild(node, scan)
      }
      scan(body)
      if (hit) {
        qualified.add(name)
        changed = true
      }
    }
  }
  return qualified
}

function harnessReachingLocals(sf: ts.SourceFile): Set<string> {
  return fixedPoint(localFunctionBodies(sf), (node, qualified) => {
    if (!ts.isCallExpression(node)) return false
    const callee = calleeRoot(node)
    return callee !== null && (HARNESS_CALLS.has(callee) || qualified.has(callee))
  })
}

/**
 * Local function names that REGISTER a harness hook when called — directly
 * (`function registerHooks() { beforeEach(() => resetDb()) }`) or through
 * another local that does.
 *
 * The second thing haven-reviewer found (#2329), and the same hole as the
 * first reached through a different door. A hook registered inside a helper is
 * lexically nested under the helper, not under the `describe` that calls it, so
 * the ancestor walk found no suite and fell back to file scope — which marked
 * EVERY suite in the file warm, including a genuinely cold sibling. The fix is
 * the one already in this file: resolve the indirection to a fixed point, then
 * warm from the helper's CALL site, where the suite really is an ancestor.
 */
function hookRegisteringLocals(sf: ts.SourceFile, harnessLocals: Set<string>): Set<string> {
  return fixedPoint(localFunctionBodies(sf), (node, qualified) => {
    if (!ts.isCallExpression(node)) return false
    const callee = calleeRoot(node)
    if (callee === null) return false
    if (qualified.has(callee)) return true
    if (!HOOK_OPENERS.has(callee)) return false
    // A hook counts only if its callback actually reaches the harness.
    let reaches = false
    const scan = (n: ts.Node): void => {
      if (reaches) return
      if (ts.isCallExpression(n)) {
        const inner = calleeRoot(n)
        if (inner !== null && (HARNESS_CALLS.has(inner) || harnessLocals.has(inner))) {
          reaches = true
          return
        }
      }
      ts.forEachChild(n, scan)
    }
    for (const arg of node.arguments) scan(arg)
    return reaches
  })
}

function readHarnessCallFacts(source: string, fileName: string): FileFacts {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const indirect = harnessReachingLocals(sf)
  const hookRegistrars = hookRegisteringLocals(sf, indirect)
  const sites: Site[] = []
  const unbudgeted: Site[] = []
  let sawIndirect = false
  let sawHook = false
  let sawInBody = false

  /**
   * Suites (by node identity) that a hook in them, or in an ancestor suite,
   * has already warmed.
   *
   * Suite-scoped, NOT file-scoped — the #2329 review's first finding. A hook in
   * one `describe` block says nothing about a cold call in a sibling block,
   * which is exactly the shape that would have shipped silently. Textual order
   * inside one suite is deliberately NOT considered: vitest runs a suite's
   * hooks before every test in it regardless of where they are written.
   */
  const warmedSuites = new Set<ts.Node>()
  // The file itself, for a hook written outside any describe.
  const FILE_SCOPE: ts.Node = sf

  type Context = {
    kind: 'test' | 'hook' | 'other'
    /** The `it`/`test` call, when kind is 'test'. */
    test?: ts.CallExpression
    /** Innermost enclosing suite, or the file. */
    suite: ts.Node
  }

  function contextOf(node: ts.Node): Context {
    let kind: Context['kind'] = 'other'
    let test: ts.CallExpression | undefined
    let suite: ts.Node = FILE_SCOPE
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (!ts.isCallExpression(p)) continue
      const opener = calleeRoot(p)
      if (!opener) continue
      if (kind === 'other' && HOOK_OPENERS.has(opener)) kind = 'hook'
      else if (kind === 'other' && TEST_OPENERS.has(opener)) {
        kind = 'test'
        test = p
      } else if (SUITE_OPENERS.has(opener)) {
        suite = p
        break
      }
    }
    return { kind, test, suite }
  }

  /**
   * Is `node` lexically inside a NAMED local function, rather than inside an
   * inline callback that a `describe`/`it`/hook opener was handed?
   *
   * The distinction the file-scope fallback needs. An inline callback is part
   * of the suite that received it, so the ancestor walk finds the right suite.
   * A named helper is not: its declaration site says nothing about which suite
   * will call it, so a hook registered there must warm nothing from HERE — its
   * warming comes from the helper's call sites below.
   */
  function insideNamedLocal(node: ts.Node): boolean {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p)) return true
      if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
        if (p.parent && ts.isVariableDeclaration(p.parent)) return true
      }
    }
    return false
  }

  // Pass 1: record which suites a hook warms, including every ancestor suite's
  // descendants — a hook in an outer describe warms the inner ones too.
  const warmFrom: ts.Node[] = []
  const findHooks = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeRoot(node)
      if (callee && (HARNESS_CALLS.has(callee) || indirect.has(callee))) {
        const ctx = contextOf(node)
        if (ctx.kind === 'hook') {
          sawHook = true
          // A hook whose ancestor walk found no suite AND which lives in a
          // named local warms nothing here: the suite is decided where the
          // helper is CALLED, not where it is written.
          if (!(ctx.suite === FILE_SCOPE && insideNamedLocal(node))) warmFrom.push(ctx.suite)
        }
      }
      // ...and the call site of a helper that registers such a hook warms the
      // suite it is called from.
      if (callee && hookRegistrars.has(callee) && !insideNamedLocal(node)) {
        sawHook = true
        warmFrom.push(contextOf(node).suite)
      }
    }
    ts.forEachChild(node, findHooks)
  }
  findHooks(sf)
  for (const suite of warmFrom) warmedSuites.add(suite)

  const warmed = (suite: ts.Node): boolean => {
    for (let p: ts.Node | undefined = suite; p; p = p.parent) {
      if (warmedSuites.has(p)) return true
    }
    return warmedSuites.has(FILE_SCOPE)
  }

  // Pass 2: classify every call site against those warmed suites.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeRoot(node)
      if (callee && (HARNESS_CALLS.has(callee) || indirect.has(callee))) {
        const ctx = contextOf(node)
        const site: Site = {
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          call: callee,
          via: HARNESS_CALLS.has(callee) ? 'direct' : callee,
        }
        if (site.via !== 'direct') sawIndirect = true
        sites.push(site)
        if (ctx.kind === 'test') {
          sawInBody = true
          const budgeted =
            (ctx.test !== undefined && declaresOwnTimeout(ctx.test)) || warmed(ctx.suite)
          if (!budgeted) unbudgeted.push(site)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  return { sites, unbudgeted, sawIndirect, sawHook, sawInBody }
}

describe('harness cold cost is charged to a hook budget, never to testTimeout (#2329)', () => {
  const scanned = testFiles(BACKEND_SRC)
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
    expect(scanned.reduce((n, s) => n + s.facts.sites.length, 0)).toBeGreaterThanOrEqual(100)
    // And both classifications the rule turns on are genuinely exercised by
    // real source, so neither branch is dead code that has never run.
    expect(scanned.some(({ facts }) => facts.sawHook)).toBe(true)
    expect(scanned.some(({ facts }) => facts.sawInBody)).toBe(true)
  })

  it('every in-body harness call is warmed by a hook in its own suite, or carries a timeout', () => {
    const violations = scanned.flatMap(({ file, facts }) =>
      facts.unbudgeted.map(
        (site) =>
          `${file}:${site.line} — ${site.call}() runs inside an it() body` +
          (site.via === 'direct' ? '' : ` (via the local helper ${site.via}())`) +
          ', with no beforeAll/beforeEach harness call in its own describe block and no ' +
          "explicit timeout on the test, so it is charged to vitest's 5000 ms testTimeout " +
          '(#2329)',
      ),
    )
    expect(violations).toEqual([])
  })
})

describe('the budget rule itself, against fixtures', () => {
  // The rule is enforced over a tree that is currently clean, so without these
  // the "no violations" assertion above cannot be distinguished from a rule
  // that never says no. Each fixture is the minimal shape of one decision, and
  // the last two are the holes haven-reviewer found in the first draft.
  const at = (src: string) => readHarnessCallFacts(src, 'fixture.test.ts')

  it('flags a bare resetDb() first in an it body — the #2274/#2295 shape', () => {
    const facts = at(`
      describeDb('x', () => {
        it('a', async () => {
          await resetDb()
        })
      })
    `)
    expect(facts.unbudgeted.map((s) => s.line)).toEqual([4])
  })

  it('accepts an in-body call when a hook in the same suite already paid the cold run', () => {
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
    expect(facts.sawHook).toBe(true)
    expect(facts.unbudgeted).toEqual([])
  })

  it('accepts an unwarmed in-body call that declares its own positional timeout', () => {
    const facts = at(`
      describeDb('x', () => {
        it('a', async () => {
          await initDbHarness()
        }, 180_000)
      })
    `)
    expect(facts.sawHook).toBe(false)
    expect(facts.unbudgeted).toEqual([])
  })

  it("accepts the options-object spelling, it(name, { timeout }, fn)", () => {
    const facts = at(`
      describeDb('x', () => {
        it('a', { timeout: 180_000 }, async () => {
          await initDbHarness()
        })
      })
    `)
    expect(facts.unbudgeted).toEqual([])
  })

  it('a hook in a SIBLING describe does not warm a cold call (haven-reviewer finding 1)', () => {
    // The first draft carried one file-wide `warmedInHook` boolean, so this
    // passed clean — while suite A is exactly the cold, unprotected shape that
    // reddened CI. Warming is suite-scoped now.
    const facts = at(`
      describeDb('A', () => {
        it('cold', async () => {
          await resetDb()
        })
      })
      describeDb('B', () => {
        beforeEach(async () => {
          await resetDb()
        })
        it('warm', () => {})
      })
    `)
    expect(facts.sawHook).toBe(true)
    expect(facts.unbudgeted.map((s) => s.line)).toEqual([4])
  })

  it('a hook in an ANCESTOR describe does warm a nested one', () => {
    // The other direction of the same rule: vitest runs an outer suite's hooks
    // before every test nested inside it, so this really is warm.
    const facts = at(`
      describeDb('outer', () => {
        beforeEach(async () => {
          await resetDb()
        })
        describe('inner', () => {
          it('a', async () => {
            await resetDb()
          })
        })
      })
    `)
    expect(facts.unbudgeted).toEqual([])
  })

  it('follows the harness through a local helper (haven-reviewer finding 2)', () => {
    // The first draft only classified a call whose literal AST ancestor was an
    // it(); one function hop made it invisible entirely — not even flagged.
    const facts = at(`
      async function coldSetup() {
        await resetDb()
      }
      describeDb('C', () => {
        it('cold via helper, no hook', async () => {
          await coldSetup()
        })
      })
    `)
    expect(facts.sawIndirect).toBe(true)
    expect(facts.unbudgeted.map((s) => s.via)).toEqual(['coldSetup'])
  })

  it('follows a CHAIN of helpers, not just one hop', () => {
    const facts = at(`
      const inner = async () => {
        await resetDb()
      }
      async function outer() {
        await inner()
      }
      describeDb('D', () => {
        it('a', async () => {
          await outer()
        })
      })
    `)
    expect(facts.unbudgeted.map((s) => s.via)).toEqual(['outer'])
  })

  it('a hook registered VIA A HELPER warms only the suite that calls it (haven-reviewer, round 2)', () => {
    // The same hole as finding 1, reached through a different door. The hook is
    // lexically inside `registerHooks`, not inside `describeDb('A')`, so the
    // ancestor walk found no suite and fell back to FILE_SCOPE — which marked
    // the wholly separate, genuinely cold suite B warm too. B's test is exactly
    // the #2274/#2295 shape, and the guard waved it through.
    const facts = at(`
      function registerHooks() {
        beforeEach(async () => {
          await resetDb()
        })
      }
      describeDb('A', () => {
        registerHooks()
        it('warm', async () => {
          await resetDb()
        })
      })
      describeDb('B', () => {
        it('cold', async () => {
          await resetDb()
        })
      })
    `)
    expect(facts.sawHook).toBe(true)
    // Suite A's in-body call is warmed by its own registerHooks() call; suite
    // B's is not warmed by anything, so line 15 — B's cold reset — is the one
    // and only violation.
    expect(facts.unbudgeted.map((s) => s.line)).toEqual([15])
  })

  it('a top-level helper call registers file-scope hooks, warming the whole file', () => {
    // The direction that must still pass: called outside any describe, the
    // helper really does register hooks for every suite in the file.
    const facts = at(`
      function registerHooks() {
        beforeEach(async () => {
          await resetDb()
        })
      }
      registerHooks()
      describeDb('A', () => {
        it('warm', async () => {
          await resetDb()
        })
      })
    `)
    expect(facts.unbudgeted).toEqual([])
  })

  it('KNOWN LIMIT: a harness call behind an object METHOD is not seen at all', () => {
    // Named, not chased (haven-reviewer, round 2, agreed as a scope boundary).
    // `calleeRoot` flattens `helpers.coldSetup()` to `helpers`, which matches
    // no local function name, so the call is invisible — neither flagged nor
    // excused. Resolving arbitrary property-access indirection is a different
    // order of complexity for a much rarer shape than the two above, which were
    // reproduced from real defect classes.
    //
    // This test exists so a green run is never citable as "no unbudgeted cold
    // call exists in this repository". It pins the limit as a FACT, so the day
    // someone closes it, this expectation fails and says where to look.
    const facts = at(`
      const helpers = {
        async coldSetup() {
          await resetDb()
        },
      }
      describeDb('x', () => {
        it('a', async () => {
          await helpers.coldSetup()
        })
      })
    `)
    // The `resetDb()` inside the method IS seen as a call site — it is right
    // there in the source — but it has no `it`/hook ancestor, so it classifies
    // as neither. What is invisible is the LINK: `helpers.coldSetup()` in the
    // test body resolves to no known local, so nothing attributes the cold call
    // to that test and nothing is flagged.
    expect(facts.sites.map((s) => s.line)).toEqual([4])
    expect(facts.unbudgeted).toEqual([])
    expect(facts.sawInBody).toBe(false)
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
