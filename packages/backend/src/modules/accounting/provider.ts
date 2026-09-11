/**
 * Accounting provider descriptor (#2862, epic #2858).
 *
 * A provider is DATA: what it is called, how a user authenticates to it, what
 * it can do, whether it is open for connection yet, and which scopes the
 * OAuth grant must carry. It is deliberately separate from the connector — the
 * CODE that talks to the provider — so that a provider can be LISTED (owner
 * decision 2026-09-11: Accounted, Light and Igdrasil appear as *Coming soon*
 * today) before any code for it exists, and so that the routes can answer
 * "which providers are there, and which of them may I connect?" without
 * loading a single adapter.
 *
 * The descriptor list lives in `registry.ts`; adding a provider is described
 * in this directory's `README.md`.
 */

export type ProviderAuthKind = 'oauth2' | 'api_key'

export type ProviderAvailability = 'live' | 'coming_soon'

export interface ProviderCapabilities {
  /** Can attach the receipt underlag to the pushed transaction. */
  attachments: boolean
  /** Can read back whether a pushed transaction still exists / is booked. */
  verify: boolean
  /** Can revoke the grant at the provider when the user disconnects. */
  revoke: boolean
  /** Can report the connected company (name, id, base currency) at connect time. */
  companyInfo: boolean
}

export interface AccountingProvider {
  /** Stable id, the `provider` column and the route parameter. */
  id: string
  displayName: string
  authKind: ProviderAuthKind
  capabilities: ProviderCapabilities
  availability: ProviderAvailability
  /** OAuth scopes the grant must carry; empty for api_key providers. */
  requiredScopes: readonly string[]
}

/**
 * What the connector reports about the company behind a grant. The base
 * currency is what the generic connect flow refuses on when it is not SEK —
 * the feed's amounts are book-time SEK (#467) and a non-SEK ledger would book
 * them as the wrong currency. `#2864` owns the enforcement policy; the flow
 * here calls the check, and the conformance suite proves it is called.
 */
export interface ProviderCompanyInfo {
  externalCompanyId: string | null
  name: string | null
  /** ISO-4217, upper-case, or null when the provider cannot say. */
  baseCurrency: string | null
  /**
   * #2864: the connector TRIED to read the company and the provider refused
   * for a missing scope (Fortnox: a grant consented before `companyinformation`
   * joined the scope list). The generic flows store the connection and mark it
   * `scope_missing` so the dashboard asks for a re-consent. A connector sets
   * this ONLY on a scope refusal — a network error or a 5xx is thrown, never
   * reported as a missing scope.
   */
  scopeMissing?: boolean
}

/**
 * Provider-side failure, carried with the HTTP status the provider answered
 * (0 = unreachable). Messages describe the request, never credentials.
 */
export class ProviderError extends Error {
  status: number
  provider: string
  /** The provider's own error code when it sent one (Fortnox: `ErrorInformation.code`). */
  code?: number
  constructor(message: string, status: number, provider = 'unknown', code?: number) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.provider = provider
    if (code !== undefined) this.code = code
  }
}

/**
 * The connect-time currency rule (owner decision 2026-09-11, enforced by
 * #2864 for EVERY provider, at connect and on a company switch). Kept as one
 * named function so the generic flows call exactly one thing and a
 * multi-currency follow-on has exactly one place to widen it. Null (provider
 * cannot say) passes: refusing the unknown would refuse every provider that
 * has no company endpoint, and the feed pushes SEK regardless.
 */
export const SUPPORTED_BASE_CURRENCY = 'SEK'

/** The user-facing refusal, verbatim — the route and the UI show this sentence. */
export const UNSUPPORTED_BASE_CURRENCY_MESSAGE = 'Haven currently feeds SEK ledgers only'

export class UnsupportedBaseCurrencyError extends Error {
  readonly code = 'UNSUPPORTED_BASE_CURRENCY' as const
  constructor(public readonly baseCurrency: string) {
    super(
      `${UNSUPPORTED_BASE_CURRENCY_MESSAGE} — the connected company books in ${baseCurrency}, ` +
        `so it was not connected and nothing was stored.`,
    )
    this.name = 'UnsupportedBaseCurrencyError'
  }
}

export function assertSupportedBaseCurrency(info: ProviderCompanyInfo): void {
  if (info.baseCurrency == null) return
  if (info.baseCurrency.toUpperCase() !== SUPPORTED_BASE_CURRENCY) {
    throw new UnsupportedBaseCurrencyError(info.baseCurrency.toUpperCase())
  }
}
