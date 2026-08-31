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
