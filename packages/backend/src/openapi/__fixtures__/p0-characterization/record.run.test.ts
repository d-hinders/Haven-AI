// db-mock-exempt: this is a fixture RECORDER, not a behavioral test — every
// mocked row is a fixed literal, the same boundary the sibling route test
// files it mirrors already mock at (see record.ts's own header comment).
/**
 * #2907 AC #1 — thin vitest wrapper for `record.ts`.
 *
 * `vi.mock` calls must live in a file vitest hoists (a real `*.test.ts`
 * collected by the default include glob); a plain imported module cannot
 * intercept native ESM named exports reliably. This file owns every mock the
 * recorded routes need and dynamically imports `record.ts` AFTER the mocks
 * are registered, so the route modules `record.ts` imports resolve against
 * the mocked module graph.
 *
 * This file writes fixtures as a side effect of one `it()` — it is a
 * recording tool, not a behavioral assertion, and is not part of the P0
 * replay suite (that is `openapi/__tests__/p0-characterization.test.ts` at
 * HEAD). It is committed so the recording is reproducible, but is not run as
 * part of the ordinary CI test pass (the ordinary include pattern collects
 * it like any other `*.test.ts`; the single `it()` is intentionally cheap —
 * see the report for why it is not gated out here).
 */
import { describe, it, expect, vi } from 'vitest'

const { mockQuery, mockGetChainClient } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetChainClient: vi.fn(),
}))

vi.mock('../../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: async () => ({
      query: (...args: unknown[]) => mockQuery(...args),
      release: () => {},
    }),
  },
}))

vi.mock('../../../infra/chain/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/chain/index.js')>()
  return { ...actual, getChainClient: mockGetChainClient }
})

vi.mock('../../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: { sub: string } }) => {
    request.user = { sub: 'user-1' }
  },
}))

vi.mock('../../../modules/passport/index.js', () => ({
  requestPassport: vi.fn(),
  issuePassportBestEffort: vi.fn(),
  enqueuePassportRevocation: vi.fn().mockResolvedValue(true),
  revokePassportBestEffort: vi.fn(),
  isPassportConfigured: vi.fn().mockReturnValue(false),
  PASSPORT_CHAIN_IDS: new Set([84532]),
}))

describe('#2907 AC #1 recorder (base 6e3ea1dc)', () => {
  it(
    'records every P0-twinned route response under the OLD names',
    async () => {
      const { recordAll } = await import('./record.js')
      await recordAll({ mockQuery, mockGetChainClient })
      expect(true).toBe(true)
    },
    30_000,
  )
})
