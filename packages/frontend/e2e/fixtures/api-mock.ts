import { vi } from 'vitest'
import type { ApiOperations, ApiSchema } from '@haven_ai/core'
import {
  testUser,
  testSafe,
  testAgent,
  dashboardOverview,
  accountingProviders,
  accountingConnection,
  accountingFeedStatus,
} from './haven-api'

/**
 * `apiMock()` — a typed builder for `vi.mock('@/lib/api', …)` (#3027).
 *
 * ## Background
 *
 * 34 frontend unit-test files mock `@/lib/api` with ad-hoc inline literals
 * typed `unknown` — a wrong field or a dropped key never fails a build, it
 * just renders `undefined` in whichever screen reads it, silently. The e2e
 * fixture (`./haven-api.ts`) already carries real, wire-shaped constants for
 * `mockHavenApi`'s Playwright routes; this file re-serves those SAME
 * constants — one dataset, not a second one to drift from the first — behind
 * a route table whose value types come from `@haven_ai/core`'s generated
 * OpenAPI types. A field that does not exist on the schema, in an override
 * literal, is a compile error (see the `// @ts-expect-error` line in
 * `ConnectionsCard.test.tsx`).
 *
 * ## Usage
 *
 * `vi.mock` factories are hoisted above imports, so the working shape is:
 *
 * ```ts
 * vi.mock('@/lib/api', async () =>
 *   (await import('../../../e2e/fixtures/api-mock')).apiMock({
 *     '/agents': { agents: [{ status: 'paused' }] },
 *   }),
 * )
 * ```
 *
 * A plain top-level `vi.mock('@/lib/api', () => apiMock(...))` also runs
 * correctly under this repo's vitest config (jsdom, `vi.mock` hoisting is a
 * static transform keyed on the `vi.mock(...)` call, not on what the factory
 * closes over) — `vi.hoisted` is NOT required here because `apiMock` and the
 * e2e fixture constants are imported at module scope, not captured from an
 * outer local. Reach for the `async () => (await import(...))` form only when
 * a test also needs `vi.hoisted` state (e.g. shared spies referenced from
 * `beforeEach`) alongside it — `ConnectionsCard.test.tsx` in this repo already
 * does that with its own hand-rolled mock, unconverted, for exactly that
 * reason (see its file header note).
 *
 * `api.get`/`api.post`/`api.patch`/`api.delete`/`api.getText` are `vi.fn()`
 * spies, so a converted test can still assert calls and still override a
 * single call's resolution with `spies.get.mockResolvedValueOnce(...)` —
 * `useAgents.test.ts` does both.
 *
 * ## Design notes
 *
 * - `overrides` merges SHALLOWLY over the defaults, per top-level route key
 *   only — `{ '/agents': { agents: [...] } }` replaces the whole `/agents`
 *   response, it does not deep-merge into the default's `agents` array. A
 *   test that wants "the default plus one changed field" spreads the default
 *   itself: `{ '/agents': { agents: [{ ...API_MOCK_DEFAULTS['/agents'].agents[0], status: 'paused' }] } }`.
 * - An override may also be a function `(path: string) => unknown` for a
 *   route whose response depends on the exact path/query string.
 * - `get(path)` matches by PATHNAME (a leading `?query` is stripped), and an
 *   unrouted path rejects loudly (`apiMock: unrouted <path>`) instead of
 *   resolving `undefined` — the #2913/incident shape this file exists to
 *   stop.
 *
 * ## Known fixture gaps (do NOT silently widen the schema types to hide these)
 *
 * The e2e fixture constants below do not, as authored in `haven-api.ts`,
 * fully satisfy their generated schemas — every gap found is a deprecated
 * "twin" field the schema requires and the fixture omits. Each is completed
 * here with the SAME real value (never fabricated), marked `// TODO(#3027)`
 * at the point of completion; the naming epic's contraction (#2914) removes
 * the twins from the schema and these completions with them:
 *
 * - `testAgent` (`Agent`): missing `safe_chain_id` (required, deprecated twin
 *   of the account's chain id) — completed with `testSafe.chain_id`.
 * - `dashboardOverview.agents[]` (`DashboardAgentPreview`): missing `safeId`
 *   (required, deprecated twin of `accountId`) — completed with `accountId`.
 * - `dashboardOverview.transactions[]` (`Transaction`): missing `safeId` /
 *   `safeAddress` (required, deprecated twins of `accountId` /
 *   `accountAddress`) — completed with those same values.
 * Enum-typed fields (`Agent.status`, `Transaction.type`/`direction`, the
 * accounting `authKind`/`availability`/`status`, the feed's
 * `entitlementMode` and sync `status`) carry `as const` in `haven-api.ts` so
 * the literal reaches the `satisfies` clauses below un-widened: a fixture
 * value outside the enum is a `tsc` error here, not a cast (proven by
 * mutation on #3027 — `status: 'bogus'` fails at `AGENT_DEFAULT`). The one
 * remaining cast is `feedDestination()`, which re-narrows the fixture's own
 * `Record<string, unknown> | null` destination row.
 *
 * `/auth/me` (`getSession`) is NOT in the typed route table: `testUser.safes`
 * (built from `testSafe`) is missing `value_bearing_chain` and
 * `needs_backup_recommendation` (both required on the session's `safes[]`
 * entries), and unlike the twins above there is no existing real value in the
 * e2e fixture to reuse — inventing one would be exactly the fabrication this
 * file's design note above forbids. `/auth/me` is served UNTYPED
 * (`testUser` as-is) with the gap named here rather than hidden by a cast.
 */

type Agent = ApiSchema<'Agent'>
type DashboardOverview = ApiSchema<'DashboardOverviewResponse'>
type DashboardTransaction = DashboardOverview['transactions'][number]
type DashboardAgentPreview = DashboardOverview['agents'][number]

type ListProvidersResponse =
  ApiOperations['listAccountingProviders']['responses']['200']['content']['application/json']
type ListConnectionsResponse =
  ApiOperations['listAccountingConnections']['responses']['200']['content']['application/json']
type FeedStatusResponse =
  ApiOperations['getAccountingFeedStatus']['responses']['200']['content']['application/json']
type AccountingConnectionRow = ListConnectionsResponse['connections'][number]
type AccountingProviderRow = ListProvidersResponse['providers'][number]

// ── Derived, schema-checked defaults ───────────────────────────────────────
// Each `satisfies` clause IS the contract #3027 asks for: a fixture that
// drops a required key, or ships a value the schema does not admit, fails
// `tsc` here — not at runtime, in whichever test happens to read the gap.

const AGENT_DEFAULT = {
  ...testAgent,
  // TODO(#3027): `testAgent` in haven-api.ts carries no `safe_chain_id`.
  safe_chain_id: testSafe.chain_id,
} satisfies Agent

const AGENTS_DEFAULT = { agents: [AGENT_DEFAULT] } satisfies { agents: Agent[] }

const DASHBOARD_AGENT_DEFAULT = {
  ...dashboardOverview.agents[0]!,
  // TODO(#3027): `dashboardOverview.agents[]` in haven-api.ts carries no
  // `safeId`.
  safeId: dashboardOverview.agents[0]!.accountId,
} satisfies DashboardAgentPreview

const DASHBOARD_TRANSACTION_DEFAULT = {
  ...dashboardOverview.transactions[0]!,
  // TODO(#3027): `dashboardTransaction` in haven-api.ts carries no `safeId` /
  // `safeAddress`.
  safeId: dashboardOverview.transactions[0]!.accountId,
  safeAddress: dashboardOverview.transactions[0]!.accountAddress,
} satisfies DashboardTransaction

const DASHBOARD_OVERVIEW_DEFAULT = {
  ...dashboardOverview,
  agents: [DASHBOARD_AGENT_DEFAULT],
  transactions: [DASHBOARD_TRANSACTION_DEFAULT],
} satisfies DashboardOverview

const ACCOUNTING_PROVIDERS_DEFAULT = {
  providers: accountingProviders.map(
    (p) =>
      ({ ...p }) satisfies AccountingProviderRow,
  ),
} satisfies ListProvidersResponse

const ACCOUNTING_CONNECTION_DEFAULT = {
  ...accountingConnection,
} satisfies AccountingConnectionRow

const ACCOUNTING_CONNECTIONS_DEFAULT = {
  connections: [ACCOUNTING_CONNECTION_DEFAULT],
} satisfies ListConnectionsResponse

type FeedDestination = NonNullable<FeedStatusResponse['destination']>

function feedDestination(raw: Record<string, unknown> | null): FeedDestination | null {
  if (!raw) return null
  return {
    provider: raw.provider as string,
    displayName: raw.displayName as string,
    status: raw.status as FeedDestination['status'],
    companyName: raw.companyName as string | null,
    lastPushAt: raw.lastPushAt as string | null,
  } satisfies FeedDestination
}

type FeedSyncRow = FeedStatusResponse['syncs'][number]

const ACCOUNTING_FEED_STATUS_DEFAULT = {
  ...accountingFeedStatus,
  destination: feedDestination(accountingFeedStatus.destination),
  syncs: accountingFeedStatus.syncs.map(
    (sync) => ({ ...sync }) satisfies FeedSyncRow,
  ),
} satisfies FeedStatusResponse

/**
 * The typed route table: every `@/lib/api` route this builder answers, keyed
 * by PATHNAME (no query string), mapped to the generated wire type its
 * default and any override must satisfy.
 *
 * `/auth/me` is intentionally `unknown` — see the file header's "Known
 * fixture gaps" note; it is still routed (so `useAuth`-style callers do not
 * hit the unrouted rejection), just not type-checked against `getSession`.
 */
export type ApiRoutes = {
  '/agents': { agents: Agent[] }
  '/dashboard/overview': DashboardOverview
  '/accounting/providers': ListProvidersResponse
  '/accounting/connections': ListConnectionsResponse
  '/accounting/feed/status': FeedStatusResponse
  '/auth/me': unknown
}

export const API_MOCK_DEFAULTS: ApiRoutes = {
  '/agents': AGENTS_DEFAULT,
  '/dashboard/overview': DASHBOARD_OVERVIEW_DEFAULT,
  '/accounting/providers': ACCOUNTING_PROVIDERS_DEFAULT,
  '/accounting/connections': ACCOUNTING_CONNECTIONS_DEFAULT,
  '/accounting/feed/status': ACCOUNTING_FEED_STATUS_DEFAULT,
  '/auth/me': testUser,
}

/**
 * A route's override: the whole response (or a `DeepPartial` of it, shallow
 * on collections — see the file header), or a function of the exact
 * requested path for query-string-dependent routing.
 */
export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

export type ApiMockOverrides = {
  [P in keyof ApiRoutes]?: DeepPartial<ApiRoutes[P]> | ((path: string) => unknown)
}

function pathnameOf(path: string): string {
  // `path` is already relative (no origin) — `URL` needs one to parse, so a
  // dummy base is supplied purely to reuse its query-stripping behaviour.
  return new URL(path, 'http://haven.internal').pathname
}

/**
 * Shallow-merge one route's override over its default. Objects merge one
 * level deep (top-level keys only); arrays and anything else are REPLACED
 * wholesale by the override — the documented "shallow" contract above.
 */
function mergeRoute(base: unknown, override: unknown): unknown {
  if (
    override !== null &&
    typeof override === 'object' &&
    !Array.isArray(override) &&
    base !== null &&
    typeof base === 'object' &&
    !Array.isArray(base)
  ) {
    return { ...(base as Record<string, unknown>), ...(override as Record<string, unknown>) }
  }
  return override
}

/**
 * Build a `vi.mock('@/lib/api', …)`-compatible object: `{ api, spies }`,
 * where `api.get`/`api.post`/`api.patch`/`api.delete`/`api.getText` are all
 * `vi.fn()` (== `spies.get` etc, same references) so a converted test can
 * still assert calls or override a single tick's resolution directly on the
 * spy, exactly as the pre-#3027 inline mocks did.
 */
export function apiMock(overrides: ApiMockOverrides = {}) {
  const get = vi.fn((path: string) => {
    const pathname = pathnameOf(path)
    const key = pathname as keyof ApiRoutes
    const override = overrides[key]

    if (typeof override === 'function') {
      return Promise.resolve(override(path))
    }
    if (key in API_MOCK_DEFAULTS) {
      const merged = override === undefined ? API_MOCK_DEFAULTS[key] : mergeRoute(API_MOCK_DEFAULTS[key], override)
      return Promise.resolve(merged)
    }
    return Promise.reject(new Error(`apiMock: unrouted ${path}`))
  })

  const getText = vi.fn((path: string) => Promise.reject(new Error(`apiMock: unrouted getText ${path}`)))
  const post = vi.fn((_path: string, _body?: unknown) => Promise.resolve(undefined))
  const patch = vi.fn((_path: string, _body?: unknown) => Promise.resolve(undefined))
  const deleteFn = vi.fn((_path: string) => Promise.resolve(undefined))

  const api = { get, getText, post, patch, delete: deleteFn }

  return { api, spies: { get, getText, post, patch, delete: deleteFn } }
}
