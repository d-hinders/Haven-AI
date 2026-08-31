/**
 * Fixture SOURCE for the mock-factory-export guard's own falsifiability tests
 * (#2307). These strings are written to a temp directory and scanned from there.
 *
 * They live in a `.ts` file rather than inline in the `.test.ts` that uses them
 * for one reason: the guard scans `*.test.ts` files, so fixture source embedded
 * in the guard's own test would be picked up as real findings and the guard
 * would flag itself. Keeping them here — outside the scanned glob — is why the
 * guard needs no self-exclusion list. An exclusion list is a thing people add
 * entries to; a file the scanner simply never looks at is not.
 */

/** A module with three genuine exports, two functions and an interface. */
export const REAL_MODULE_SOURCE = `
export function getProvider(chainId: number) { return chainId }
export async function getTokenBalance(a: string) { return a }
export interface AllowanceInfo { amount: string }
`

/** Inline object-literal factory naming one real export and one phantom. */
export const INLINE_LITERAL_WITH_PHANTOM = `
vi.mock('../../rails/allowance-module.js', () => ({
  getProvider: vi.fn(),
  executeAllowanceTransfer: vi.fn(),
}))
`

/** The exact shape #2307 found: a destructured `vi.hoisted` bag of mocks. */
export const HOISTED_IDENTIFIER_WITH_PHANTOMS = `
const { allowanceMocks } = vi.hoisted(() => ({
  allowanceMocks: {
    getProvider: vi.fn(),
    getTokenBalance: vi.fn(),
    generateTransferHash: vi.fn(),
    recoverSigner: vi.fn(),
  },
}))
vi.mock('../../rails/allowance-module.js', () => allowanceMocks)
`

/** The undestructured `const x = vi.hoisted(...)` variant. */
export const BOUND_HOISTED_WITH_PHANTOM = `
const mocks = vi.hoisted(() => ({ getProvider: vi.fn(), recoverSigner: vi.fn() }))
vi.mock('../../rails/allowance-module.js', () => mocks)
`

/** A legitimate factory: every key is a real export. Must NOT be flagged. */
export const CLEAN_FACTORY = `
vi.mock('../../rails/allowance-module.js', () => ({
  getProvider: vi.fn(),
  getTokenBalance: vi.fn(),
}))
`

/** A barrel re-export chain — names must be followed, not called phantoms. */
export const BARREL_INNER = 'export function realThing() {}'
export const BARREL_OTHER = 'export function other() {}'
export const BARREL_INDEX = "export * from './inner.js'\nexport { other } from './other.js'"
export const BARREL_FACTORY = `
vi.mock('../../modules/index.js', () => ({
  realThing: vi.fn(),
  other: vi.fn(),
}))
`

/** A factory the parser cannot read. Must be REPORTED, never silently passed. */
export const UNREADABLE_FACTORY = `
vi.mock('../../rails/allowance-module.js', () => somethingImportedFromElsewhere)
`

/**
 * The `async (importOriginal) => ({ ...(await importOriginal()), key })` shape.
 *
 * Added after review of #2307 found the first parser insisted on a literal
 * empty `()` parameter list and therefore never saw this form at all — 26
 * factories unscanned, three of them on `rails/allowance-module.js`, and a
 * phantom key injected into one went undetected. The explicit overrides are
 * what must be checked: the spread carries the real exports through, so an
 * override naming a non-export is still a function nothing can call.
 */
export const IMPORT_ORIGINAL_WITH_PHANTOM = `
vi.mock('../../rails/allowance-module.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../rails/allowance-module.js')>()),
  getTokenBalance: vi.fn(),
  executeAllowanceTransfer: vi.fn(),
}))
`

/** Same shape, all overrides real. Must NOT be flagged. */
export const IMPORT_ORIGINAL_CLEAN = `
vi.mock('../../rails/allowance-module.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProvider: vi.fn(),
}))
`

/**
 * The `importActual` + `return { ...actual, override }` shape — 31 occurrences
 * in the backend tree. The first parser skipped statement bodies silently; the
 * second reported all 31 as unreadable, which would have been a red gate over a
 * form that is perfectly readable. The returned literal's explicit keys are the
 * overrides and must be checked like any other.
 */
export const IMPORT_ACTUAL_RETURN_WITH_PHANTOM = `
vi.mock('../../rails/allowance-module.js', async () => {
  const actual = await vi.importActual<typeof import('../../rails/allowance-module.js')>(
    '../../rails/allowance-module.js',
  )
  return { ...actual, getProvider: vi.fn(), executeAllowanceTransfer: vi.fn() }
})
`

/** A statement body whose return value is genuinely unreadable: REPORT, never skip. */
export const UNREADABLE_STATEMENT_BODY = `
vi.mock('../../rails/allowance-module.js', () => {
  const built = Object.fromEntries(names.map((n) => [n, vi.fn()]))
  return built.inner
})
`

/** `vi.mock(spec)` with no factory — an auto-mock. Nothing to check, but counted. */
export const AUTO_MOCK = `
vi.mock('../../rails/allowance-module.js')
`
