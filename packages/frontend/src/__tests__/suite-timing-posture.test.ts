/**
 * The frontend suite's timing posture, pinned (#2319).
 *
 * ## The known limit this pins
 *
 * `DelegationSendModal`, `InfoModal`, `UnmanagedDelegateCard` and `Modal` can
 * time out on a CPU-contended machine and pass alone. Measured, not assumed:
 * each of those files' first test renders a `ui/Modal` in a freshly isolated
 * module graph, which costs 250–450 ms idle (the later tests in the same file
 * cost ~40 ms), and that cost scales linearly with how oversubscribed the
 * machine is. Around an 11x slowdown the first test crosses vitest's 5000 ms
 * `testTimeout`; an unloaded full run never gets near it. So the failure is
 * proportional to load, not a fixed wall inside the tests — there is nothing
 * in those four files to make faster, and no fake-timer or `act()` change
 * removes a cost that is the render itself.
 *
 * The decision is therefore to ACCEPT the limit and make it honest rather than
 * hide it, and this file is what keeps the decision from being undone
 * silently:
 *
 * 1. `vitest.config.ts` does not set `testTimeout`. The 5000 ms default is the
 *    suite's hung-test detector; raising it until a contended run passes makes
 *    every file's timeout stop detecting anything, which is why #2329 and
 *    #2354 rejected the same move on the backend.
 * 2. None of the four suites carries a per-test timeout override, in either
 *    vitest spelling (`it(name, fn, 30_000)` / `it(name, { timeout }, fn)`).
 *    Bumping just the four is the same fix at a smaller radius: the four are
 *    only the FIRST files to cross the line, not the only ones that can.
 * 3. The `afterEach` diagnostic in `setup.ts` says what the machine was doing
 *    when a test was slow or timed out, so a reader gets the distinguishing
 *    fact next to the failure. Its message is unit-tested here, from an
 *    explicit reading, so it needs no loaded machine to prove.
 *
 * Each pin was mutation-proved: `testTimeout: 30_000` added to the config,
 * a `{ timeout: 30_000 }` added to one of the four — and, after review, an
 * `it.each(...)(…, 30_000)`, a positional timeout through a `const`, and a
 * `vi.setConfig({ testTimeout })` each added to `Modal.test.tsx` — and the
 * diagnostic made to return `null`: each turns exactly one assertion red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  CONTENDED_LOAD_RATIO,
  SLOW_TEST_DIAGNOSTIC_MS,
  describeSlowTest,
  lastSlowTestReading,
} from './slow-test-diagnostic'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = path.resolve(HERE, '../..')

/** The four suites #2319 observed, relative to `packages/frontend`. */
export const LOAD_SENSITIVE_SUITES = [
  'src/components/__tests__/DelegationSendModal.test.tsx',
  'src/components/__tests__/InfoModal.test.tsx',
  'src/components/agent-panel/__tests__/UnmanagedDelegateCard.test.tsx',
  'src/components/ui/__tests__/Modal.test.tsx',
] as const

/**
 * Every place in `source` that raises a per-test budget above the config's:
 *
 * - an `it`/`test` call (bare, `.only`/`.skip`/`.concurrent`, or the
 *   `it.each(...)(...)` / `test.each(...)(...)` curried form) with a THIRD
 *   positional argument after a function body — any expression, not only a
 *   numeric literal, since `it(name, fn, MUTATION_TIMEOUT)` is the same
 *   override through a `const`;
 * - the options-object spelling, `it(name, { timeout }, fn)`;
 * - a runtime `vi.setConfig({ testTimeout })`, which raises the budget for the
 *   rest of the file without touching an `it` or `vitest.config.ts`.
 *
 * The first two `it.each` / variable shapes were false negatives in the first
 * version of this detector (haven-reviewer, #2319): it recognised only a bare
 * callee and a numeric-literal third argument, and `it.each` is both already
 * used in this codebase and literally the shape of #2319's misattributed
 * cause. Returns the line of each finding so a failure names a location.
 */
export function perTestTimeoutOverrides(source: string, fileName = 'fixture.tsx'): number[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  )
  const lines: number[] = []

  /** `it` for `it`, `it.only`, `it.each(...)`, `it.each(...)` inside `.only`; null otherwise. */
  const testRoot = (callee: ts.Expression): string | null => {
    if (ts.isIdentifier(callee)) return callee.text
    if (ts.isPropertyAccessExpression(callee)) return testRoot(callee.expression)
    // `it.each([...])(name, fn, timeout)`: the callee is itself a call.
    if (ts.isCallExpression(callee)) return testRoot(callee.expression)
    return null
  }

  const isTestCall = (node: ts.CallExpression): boolean => {
    const root = testRoot(node.expression)
    return root === 'it' || root === 'test'
  }

  const declaresTimeout = (node: ts.CallExpression): boolean => {
    const [, second, third] = node.arguments
    // `it(name, fn, <anything>)`: the third argument is the timeout only when
    // the second is the test body — in `it(name, { retry }, fn)` the third
    // argument IS the body, and that spelling is covered by the branch below.
    const secondIsBody =
      !!second && (ts.isArrowFunction(second) || ts.isFunctionExpression(second))
    if (secondIsBody && third) return true
    if (second && ts.isObjectLiteralExpression(second)) {
      return second.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'timeout',
      )
    }
    return false
  }

  const isSetConfigTimeout = (node: ts.CallExpression): boolean => {
    const callee = node.expression
    if (
      !ts.isPropertyAccessExpression(callee) ||
      !ts.isIdentifier(callee.expression) ||
      callee.expression.text !== 'vi' ||
      callee.name.text !== 'setConfig'
    ) {
      return false
    }
    const [arg] = node.arguments
    return (
      !!arg &&
      ts.isObjectLiteralExpression(arg) &&
      arg.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'testTimeout',
      )
    )
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ((isTestCall(node) && declaresTimeout(node)) || isSetConfigTimeout(node))
    ) {
      lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return lines
}

const IDLE = { loadAverage1m: 1.2, cores: 12 }
const CONTENDED = { loadAverage1m: 41.0, cores: 12 }

describe('the slow-test diagnostic (#2319)', () => {
  it('says nothing about a passing test under the threshold', () => {
    expect(
      describeSlowTest({
        name: 'f > t',
        durationMs: SLOW_TEST_DIAGNOSTIC_MS - 1,
        timeoutMs: 5000,
        timedOut: false,
        ...IDLE,
      }),
    ).toBeNull()
  })

  it('names a contended machine for a slow test, with the load it measured', () => {
    const message = describeSlowTest({
      name: 'Modal.test.tsx > traps focus',
      durationMs: 4800,
      timeoutMs: 5000,
      timedOut: false,
      ...CONTENDED,
    })
    expect(message).toContain('Modal.test.tsx > traps focus')
    expect(message).toContain('4800 ms')
    expect(message).toContain('CPU-contended')
    expect(message).toContain('41.0 on 12 cores')
    expect(message).toContain('Re-run the file alone')
  })

  it('says the machine was NOT contended when the load does not explain it', () => {
    const message = describeSlowTest({
      name: 'f > t',
      durationMs: 4800,
      timeoutMs: 5000,
      timedOut: false,
      ...IDLE,
    })
    expect(message).toContain('NOT contended')
    expect(message).toContain("test's own")
    expect(message).not.toContain('Re-run the file alone')
  })

  it('always speaks for a timed-out test, and names the budget it lost to', () => {
    const message = describeSlowTest({
      name: 'f > t',
      durationMs: 10,
      timeoutMs: 5000,
      timedOut: true,
      ...CONTENDED,
    })
    expect(message).toContain('timed out against its 5000 ms budget')
  })

  it('draws the contention line at CONTENDED_LOAD_RATIO, not at "every core busy"', () => {
    // A full frontend run alone sits near 1.0; that must not read as contention.
    const atRatio = describeSlowTest({
      name: 'f > t',
      durationMs: 3000,
      timeoutMs: 5000,
      timedOut: false,
      loadAverage1m: CONTENDED_LOAD_RATIO * 12,
      cores: 12,
    })
    expect(atRatio).toContain('NOT contended')
    const justOver = describeSlowTest({
      name: 'f > t',
      durationMs: 3000,
      timeoutMs: 5000,
      timedOut: false,
      loadAverage1m: CONTENDED_LOAD_RATIO * 12 + 0.1,
      cores: 12,
    })
    expect(justOver).toContain('CPU-contended')
  })
})

describe('the per-test timeout detector, against fixtures', () => {
  it('POSITIVE CONTROL: finds both vitest spellings, the modifier and .each forms, a const, and vi.setConfig', () => {
    const source = `
      import { it, test, vi } from 'vitest'
      it('positional', async () => {}, 30_000)
      test('options', { timeout: 30_000 }, async () => {})
      it.only('modifier', async () => {}, 30_000)
      it('plain', async () => {})
      it('options without timeout', { retry: 2 }, async () => {})
      it.each([1])('each %s', () => {}, 30_000)
      it('via a const', () => {}, MUTATION_TIMEOUT)
      vi.setConfig({ testTimeout: 30_000 })
      test.each([1])('each without timeout %s', () => {})
      vi.setConfig({ hookTimeout: 30_000 })
    `
    // The last two are deliberately NOT findings: `.each` without a third
    // argument, and a setConfig that leaves testTimeout alone.
    expect(perTestTimeoutOverrides(source)).toEqual([3, 4, 5, 8, 9, 10])
  })

  it('reports nothing for a file with no overrides', () => {
    expect(perTestTimeoutOverrides(`it('a', () => {}); test('b', () => {})`)).toEqual([])
  })
})

describe('the posture itself, pinned (#2319)', () => {
  it('vitest.config.ts leaves testTimeout at the 5000 ms default', () => {
    const config = readFileSync(path.join(FRONTEND_ROOT, 'vitest.config.ts'), 'utf8')
    // A key, not a mention: a comment explaining why it is absent must not trip this.
    const sourceFile = ts.createSourceFile('vitest.config.ts', config, ts.ScriptTarget.Latest, true)
    const found: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        (node.name.text === 'testTimeout' || node.name.text === 'hookTimeout')
      ) {
        found.push(node.name.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    expect(found, 'raising the budget is the rejected fix — see the file header').toEqual([])
  })

  it('none of the four load-sensitive suites carries a per-test timeout override', () => {
    const findings = LOAD_SENSITIVE_SUITES.flatMap((rel) => {
      const source = readFileSync(path.join(FRONTEND_ROOT, rel), 'utf8')
      return perTestTimeoutOverrides(source, rel).map((line) => `${rel}:${line}`)
    })
    expect(findings).toEqual([])
  })

  it('the four suites still exist at the paths this file pins', () => {
    // A renamed file would make the pin above pass on nothing.
    for (const rel of LOAD_SENSITIVE_SUITES) {
      expect(() => readFileSync(path.join(FRONTEND_ROOT, rel))).not.toThrow()
    }
  })
})

describe("the hook's clock is real time even after a test installed fake timers", () => {
  // The seven fake-timer files in this suite all restore real timers from a
  // file-level or describe-level `afterEach`, like this one. What is being
  // pinned is that `setup.ts`'s `afterEach` — registered first, so run LAST
  // under vitest's default `sequence.hooks: 'stack'` — takes its reading after
  // that cleanup, on a `performance.now()` that moves again. Mutation-proved:
  // removing this `vi.useRealTimers()` leaves the clock frozen at the install
  // and the assertion below reads a duration of ~0.
  afterEach(() => {
    vi.useRealTimers()
  })

  const BLOCK_MS = 50

  it('installs fake timers and blocks for a real 50 ms without restoring them', () => {
    vi.useFakeTimers()
    const before = performance.now()
    // A genuinely elapsed wall-clock interval that no timer mock can skip.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BLOCK_MS)
    // Under fake timers `performance.now()` is frozen — that is the hazard.
    expect(performance.now() - before).toBe(0)
  })

  it("setup.ts measured the previous test's real duration, not the frozen clock", () => {
    const reading = lastSlowTestReading.current
    expect(reading?.name).toContain('installs fake timers and blocks for a real 50 ms')
    expect(reading?.durationMs).toBeGreaterThanOrEqual(BLOCK_MS)
  })
})
