/**
 * The Accounted paste-UI copy constants (#3017, epic #3016) — the ONE home of
 * every Accounted-specific TOKEN the user must read or type verbatim.
 *
 * The required key scopes are spelled exactly `companies:read` and
 * `documents:write` here and nowhere else: the i18n sentences in
 * `lib/i18n/messages/en.ts` interpolate them from this module instead of
 * writing their own copy of the identifier, and the two files' connection is
 * proven by `__tests__/ApiKeyConnectModal.test.tsx`, which asserts the
 * rendered sentences carry both exact tokens. A user who mis-ticks a scope is
 * refused by the provider at the first feed (the `scope_missing` path of
 * #2865), so a drifted copy spelling is a support bug, not a cosmetic one.
 *
 * The key prefixes (`gnubok_sk_test_`, `gnubok_sk_live_`) and the dashboard
 * path where keys are created and revoked (`/settings/api`) travel with their
 * sentences for the same reason. The sentences themselves live in `en.ts`
 * (all UI copy flows through `useT()`), keyed by the error codes below.
 */

/** The read scope the connect validates the key against (whose key is this?). */
export const ACCOUNTED_SCOPE_COMPANIES_READ = 'companies:read'

/** The write scope the feed needs; cannot be validated at connect (#3017 docs). */
export const ACCOUNTED_SCOPE_DOCUMENTS_WRITE = 'documents:write'

/** The two scopes a valid Accounted key must carry, in the order the copy names them. */
export const ACCOUNTED_REQUIRED_SCOPES: readonly [string, string] = [
  ACCOUNTED_SCOPE_COMPANIES_READ,
  ACCOUNTED_SCOPE_DOCUMENTS_WRITE,
] as const

/** The separator the helper copy puts between the two scope names. */
export const ACCOUNTED_SCOPE_SEPARATOR = ', '

/** The prefix an Accounted test key begins with; what the connect accepts today. */
export const ACCOUNTED_TEST_KEY_PREFIX = 'gnubok_sk_test_'

/** The prefix a production key begins with, named so the copy can say which kind to paste. */
export const ACCOUNTED_LIVE_KEY_PREFIX = 'gnubok_sk_live_'

/** The Accounted dashboard page where API keys are created AND revoked. */
export const ACCOUNTED_DASHBOARD_PATH = '/settings/api'

/** The Accounted dashboard origin, per the OpenAPI `servers` entry (`2026-05-12`). */
export const ACCOUNTED_DASHBOARD_URL = 'https://app.accounted.se'

/** The full URL the paste modal's first step links to. */
export const ACCOUNTED_DASHBOARD_KEYS_URL = `${ACCOUNTED_DASHBOARD_URL}${ACCOUNTED_DASHBOARD_PATH}`

/**
 * The error codes the paste modal branches on, exactly as the connect route
 * answers `error_code` (`routes/accounting-connections.ts`): 400
 * `API_KEY_REQUIRED`, 400 `INVALID_API_KEY`, 409 `MULTI_COMPANY_KEY`, 409
 * `UNSUPPORTED_BASE_CURRENCY`. `en.ts` carries a sentence per code under the
 * same key; codes outside this list (an outage, a gate refusal) fall through
 * to the server's own sentence, the same posture the OAuth return path takes
 * (#2868).
 */
export type AccountedApiKeyErrorCode =
  | 'API_KEY_REQUIRED'
  | 'INVALID_API_KEY'
  | 'MULTI_COMPANY_KEY'
  | 'UNSUPPORTED_BASE_CURRENCY'

/** The codes as a list, so the modal can branch without spelling the union twice. */
export const ACCOUNTED_API_KEY_ERROR_CODES: readonly AccountedApiKeyErrorCode[] = [
  'API_KEY_REQUIRED',
  'INVALID_API_KEY',
  'MULTI_COMPANY_KEY',
  'UNSUPPORTED_BASE_CURRENCY',
] as const
