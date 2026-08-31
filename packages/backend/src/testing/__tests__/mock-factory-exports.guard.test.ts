import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  countRelativeMockCalls,
  listTestFiles,
  moduleExportNames,
  scanForPhantomMockKeys,
} from '../mock-factory-exports.js'
import {
  BARREL_FACTORY,
  BARREL_INDEX,
  BARREL_INNER,
  BARREL_OTHER,
  BOUND_HOISTED_WITH_PHANTOM,
  CLEAN_FACTORY,
  HOISTED_IDENTIFIER_WITH_PHANTOMS,
  IMPORT_ORIGINAL_CLEAN,
  IMPORT_ORIGINAL_WITH_PHANTOM,
  INLINE_LITERAL_WITH_PHANTOM,
  AUTO_MOCK,
  DOUBLE_QUOTED_SPEC_WITH_PHANTOM,
  IMPORT_ACTUAL_RETURN_WITH_PHANTOM,
  REAL_MODULE_SOURCE,
  UNREADABLE_FACTORY,
  UNREADABLE_STATEMENT_BODY,
} from '../fixtures/phantom-mock-fixtures.js'

/**
 * The guard against the FOURTH regrowth (#2307).
 *
 * `vi.mock(spec, () => factory)` accepts a factory entry for a name the module
 * does not export — silently, as a new function nobody calls. Assertions written
 * against such an entry can never fail. #1987 created 56 of them on the money
 * path; #2048, #2044 and #1993 each removed instances without removing the
 * mechanism, and it grew back every time.
 *
 * This test is that mechanism's stop. It lives in the backend test suite — a
 * required check on every PR — rather than in a lint rule or a standalone
 * script, for three reasons:
 *
 *   1. **It cannot be forgotten.** A new npm script has to be wired into CI to
 *      matter; a `*.test.ts` under `packages/backend/src` is collected by the
 *      config that already runs.
 *   2. **It cannot be locally silenced.** An ESLint rule is one
 *      `// eslint-disable-next-line` from being switched off in exactly the file
 *      that needs it, and that suppression reads as routine in review. There is
 *      no per-line escape from a failing assertion.
 *   3. **It compares against ground truth, not a list.** The expected key set is
 *      read out of the real module every run, so it stays correct when the
 *      module's exports change — including under #2259, which will delete three
 *      of `rails/allowance-module.ts`'s six exports. A hard-coded roster would
 *      have to be edited in lockstep, and would go stale exactly the way the
 *      CASP claim this issue corrects went stale.
 */
const BACKEND_SRC = path.resolve(__dirname, '../..')

describe('vi.mock factories may only name real exports', () => {
  const result = scanForPhantomMockKeys(BACKEND_SRC)

  it('scanned a meaningful number of factories — a scan that checks nothing is not a pass', () => {
    // The falsifiability floor. Without this, a resolver bug that silently
    // matched nothing would render every assertion below vacuously green —
    // which is precisely the defect class this file exists to end.
    expect(result.scannedTestFiles).toBeGreaterThan(50)
    expect(result.checkedFactories).toBeGreaterThan(20)

    // Every `vi.mock` with a RELATIVE specifier must be accounted for — either
    // checked, reported unparseable, or counted as an auto-mock. Round-one
    // review found a whole factory shape falling through all of them, so the
    // count is pinned rather than trusted: a parser change that stops seeing a
    // shape fails here instead of quietly shrinking the guard's reach.
    //
    // The counter is `countRelativeMockCalls` from the module itself, NOT a
    // regex written here. Round two found the two had drifted to single-quote-
    // only independently, so a double-quoted spec was invisible to the detector
    // and the auditor at the same instant — an invariant that cannot fail is the
    // defect this whole issue is about. One expression, imported, is the fix.
    // Bare specifiers (`viem`, `ethers`) stay out of scope: real dependencies,
    // not our source tree.
    const relativeMockCalls = listTestFiles(BACKEND_SRC).reduce(
      (n, f) => n + countRelativeMockCalls(fs.readFileSync(f, 'utf8')),
      0,
    )
    expect(result.checkedFactories + result.unparseable.length + result.autoMocked).toBe(
      relativeMockCalls,
    )
  })

  it('leaves no mock factory unparsed — an unreadable factory is a failure, never a skip', () => {
    const detail = result.unparseable
      .map((u) => `  ${path.relative(BACKEND_SRC, u.testFile)}\n    vi.mock('${u.moduleSpec}') — ${u.reason}`)
      .join('\n')
    expect(
      result.unparseable,
      `Mock factories whose keys could not be checked:\n${detail}\n\n` +
        'A factory this guard cannot read is a factory that can hide a phantom. ' +
        'Either write it in a checkable shape (an object literal, or an identifier ' +
        'bound to one), or extend the parser in testing/mock-factory-exports.ts.',
    ).toEqual([])
  })

  it('names no symbol the mocked module does not export', () => {
    const detail = result.phantoms
      .map(
        (p) =>
          `  ${path.relative(BACKEND_SRC, p.testFile)}\n` +
          `    vi.mock('${p.moduleSpec}') declares \`${p.key}\`, which ` +
          `${path.relative(BACKEND_SRC, p.resolvedModule)} does not export`,
      )
      .join('\n')
    expect(
      result.phantoms,
      `Phantom mock factory keys — every assertion written against one of these ` +
        `is unfalsifiable (#2307):\n${detail}\n\n` +
        'The factory entry creates a function the real module has no counterpart ' +
        'for, so nothing can ever call it and `not.toHaveBeenCalled()` passes ' +
        'unconditionally. Remove the entry, or re-anchor onto a symbol the module ' +
        'actually exports.',
    ).toEqual([])
  })
})

describe('the guard itself is falsifiable', () => {
  /**
   * A guard against unfalsifiable guards that could not itself go red would be
   * the joke #2307 is about. These cases prove it can say NO — and, just as
   * importantly, that it says YES for the legitimate shape, so that a future
   * cleanup cannot "fix" a red by breaking the detector.
   *
   * The fixture SOURCE lives in `../fixtures/phantom-mock-fixtures.ts` rather
   * than inline here, because this file is itself a `*.test.ts` inside the
   * scanned tree: inline fixture source would be read as real findings.
   */
  function withFixture<T>(files: Record<string, string>, fn: (root: string) => T): T {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-guard-'))
    try {
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(root, rel)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, content)
      }
      return fn(root)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  const withRealModule = (testSource: string) => ({
    'rails/allowance-module.ts': REAL_MODULE_SOURCE,
    'routes/__tests__/thing.test.ts': testSource,
  })

  it('flags a phantom key in the inline object-literal form', () => {
    const found = withFixture(withRealModule(INLINE_LITERAL_WITH_PHANTOM), scanForPhantomMockKeys)
    expect(found.phantoms.map((p) => p.key)).toEqual(['executeAllowanceTransfer'])
  })

  it('flags phantom keys behind the destructured vi.hoisted form — the shape #2307 found', () => {
    const found = withFixture(
      withRealModule(HOISTED_IDENTIFIER_WITH_PHANTOMS),
      scanForPhantomMockKeys,
    )
    expect(found.phantoms.map((p) => p.key).sort()).toEqual([
      'generateTransferHash',
      'recoverSigner',
    ])
  })

  it('flags a phantom key behind the undestructured `const x = vi.hoisted(...)` form', () => {
    const found = withFixture(withRealModule(BOUND_HOISTED_WITH_PHANTOM), scanForPhantomMockKeys)
    expect(found.phantoms.map((p) => p.key)).toEqual(['recoverSigner'])
  })

  it('passes a factory that names only real exports', () => {
    const found = withFixture(withRealModule(CLEAN_FACTORY), scanForPhantomMockKeys)
    expect(found.phantoms).toEqual([])
    expect(found.checkedFactories).toBe(1)
  })

  it('follows barrel re-exports rather than calling a re-exported name a phantom', () => {
    const found = withFixture(
      {
        'modules/inner.ts': BARREL_INNER,
        'modules/other.ts': BARREL_OTHER,
        'modules/index.ts': BARREL_INDEX,
        'routes/__tests__/thing.test.ts': BARREL_FACTORY,
      },
      scanForPhantomMockKeys,
    )
    expect(found.phantoms).toEqual([])
    expect(found.checkedFactories).toBe(1)
  })

  it('flags a phantom override in the `async (importOriginal) => ({ ...spread })` form', () => {
    // The blind spot review found on #2307. The first parser required a
    // literal empty `()` parameter list, so this shape — 26 occurrences in the
    // backend tree, three of them on `rails/allowance-module.js` — was not
    // checked, not reported, just invisible. A phantom injected into one of
    // them went undetected. That is a silent skip, the exact thing this
    // module's contract forbids.
    const found = withFixture(withRealModule(IMPORT_ORIGINAL_WITH_PHANTOM), scanForPhantomMockKeys)
    expect(found.phantoms.map((p) => p.key)).toEqual(['executeAllowanceTransfer'])
    expect(found.unparseable).toEqual([])
  })

  it('passes the spread form when every explicit override is a real export', () => {
    const found = withFixture(withRealModule(IMPORT_ORIGINAL_CLEAN), scanForPhantomMockKeys)
    expect(found.phantoms).toEqual([])
    expect(found.checkedFactories).toBe(1)
  })

  it('reads the returned literal of an `importActual` statement-body factory', () => {
    // The other half of the same review finding. The first draft skipped
    // statement bodies silently; naively reporting them instead would have
    // failed the gate over 31 legitimate, perfectly readable factories. The
    // returned object literal's explicit overrides are what get checked.
    const found = withFixture(
      withRealModule(IMPORT_ACTUAL_RETURN_WITH_PHANTOM),
      scanForPhantomMockKeys,
    )
    expect(found.phantoms.map((p) => p.key)).toEqual(['executeAllowanceTransfer'])
    expect(found.unparseable).toEqual([])
  })

  it('reports a statement body whose return value it genuinely cannot read', () => {
    const found = withFixture(withRealModule(UNREADABLE_STATEMENT_BODY), scanForPhantomMockKeys)
    expect(found.phantoms).toEqual([])
    expect(found.unparseable).toHaveLength(1)
    expect(found.checkedFactories).toBe(0)
  })

  it('counts a factory-less `vi.mock(spec)` as an auto-mock, not as checked', () => {
    const found = withFixture(withRealModule(AUTO_MOCK), scanForPhantomMockKeys)
    expect(found.phantoms).toEqual([])
    expect(found.unparseable).toEqual([])
    expect(found.checkedFactories).toBe(0)
    expect(found.autoMocked).toBe(1)
  })

  it('flags a phantom behind a DOUBLE-QUOTED specifier, and counts the call', () => {
    // Round-two review finding. Both assertions matter: the first proves the
    // detector sees it, the second proves the auditor counts it — they used to
    // miss it together, which is the only way the count-pinning invariant can
    // be fooled rather than tripped.
    const found = withFixture(
      withRealModule(DOUBLE_QUOTED_SPEC_WITH_PHANTOM),
      scanForPhantomMockKeys,
    )
    expect(found.phantoms.map((p) => p.key)).toEqual(['executeAllowanceTransfer'])
    expect(countRelativeMockCalls(DOUBLE_QUOTED_SPEC_WITH_PHANTOM)).toBe(1)
  })

  it('reports an unreadable factory instead of silently passing it', () => {
    const found = withFixture(withRealModule(UNREADABLE_FACTORY), scanForPhantomMockKeys)
    expect(found.phantoms).toEqual([])
    expect(found.unparseable).toHaveLength(1)
    expect(found.checkedFactories).toBe(0)
  })

  it('reads the real export list rather than a hard-coded roster', () => {
    // #2259 will delete getTokenAllowance / getTokensForDelegate / AllowanceInfo
    // from this module. The guard must follow that automatically — a frozen
    // roster is how the CASP claim #2307 corrects went stale in the first place.
    const { names } = moduleExportNames(path.resolve(BACKEND_SRC, 'rails/allowance-module.ts'))
    expect(names).not.toBeNull()
    expect([...(names ?? [])].sort()).toEqual([
      'AllowanceInfo',
      'getProvider',
      'getRelayerWallet',
      'getTokenAllowance',
      'getTokenBalance',
      'getTokensForDelegate',
    ])
  })
})
