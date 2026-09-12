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
import { isSupportedLedgerCurrency, ledgerCurrencyList } from '../../domain/ledger-currency.js'

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
 * currency is what the generic connect flow refuses on when it is outside
 * `SUPPORTED_LEDGER_CURRENCIES` — and, since #2877, the currency the feed
 * pushes in: the amount is that currency's, from the rate frozen at
 * settlement (#467 captures it). `#2864` owns the enforcement policy; the
 * flow here calls the check, and the conformance suite proves it is called.
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
 * #2864 for EVERY provider, at connect and on a company switch; widened from
 * SEK-only to the supported ledger currencies by #2877). Kept as one named
 * function so the generic flows call exactly one thing and the list has
 * exactly one home — `domain/ledger-currency.ts`, which `infra/prices.ts`
 * reads too, so a currency accepted here is a currency the feed can be quoted
 * a rate for. Null (provider cannot say) passes: refusing the unknown would
 * refuse every provider that has no company endpoint, and the feed books such
 * a connection in the default currency.
 */
export const UNSUPPORTED_BASE_CURRENCY_MESSAGE = `Haven feeds ${ledgerCurrencyList()} ledgers`

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
  if (!isSupportedLedgerCurrency(info.baseCurrency)) {
    throw new UnsupportedBaseCurrencyError(info.baseCurrency.toUpperCase())
  }
}

// ── Scope shortfall (#2865) ───────────────────────────────────────────────────
//
// Two places can find a grant short of a scope: the OAuth callback (the
// granted scope string is compared with `requiredScopes`) and a push (the
// provider refuses a call for scope). Both record the finding as
// `status = 'scope_missing'` with a `status_reason` in ONE shape —
// `missing scopes: a, b — <detail>` — so that a single reader
// (`scopesFromStatusReason`) can name the scopes for the dashboard without a
// column and without a migration. The detail is the connector's message,
// which describes the request, never a credential.

/** The stable prefix of a `status_reason` that names missing scopes. */
export const MISSING_SCOPES_REASON_PREFIX = 'missing scopes:'

const SCOPE_TOKEN_RE = /^[a-z][a-z0-9_.:-]{0,63}$/

/**
 * The provider's scopes the grant does NOT carry, in the provider's order.
 * A null granted string (a provider that does not echo the scope) compares
 * as complete: nothing can be named, and refusing the unknown would refuse
 * every provider that answers no `scope` field.
 */
export function compareGrantedScopes(granted: string | null | undefined, required: readonly string[]): string[] {
  if (granted == null) return []
  const have = new Set(granted.split(/\s+/).filter(Boolean))
  return required.filter((s) => !have.has(s))
}

/** The `status_reason` for a scope shortfall: the scopes first (parseable), the detail after. */
export function missingScopesReason(scopes: readonly string[], detail: string): string {
  const named = scopes.filter((s) => SCOPE_TOKEN_RE.test(s))
  return named.length > 0 ? `${MISSING_SCOPES_REASON_PREFIX} ${named.join(', ')} — ${detail}` : `scope refused — ${detail}`
}

/** The scopes a `missingScopesReason` named; empty for any other reason. */
export function scopesFromStatusReason(reason: string | null | undefined): string[] {
  if (!reason || !reason.startsWith(MISSING_SCOPES_REASON_PREFIX)) return []
  const list = reason.slice(MISSING_SCOPES_REASON_PREFIX.length).split(' — ')[0]
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => SCOPE_TOKEN_RE.test(s))
}

/**
 * What a connection summary reports as `missingScopes`: the shortfall of the
 * stored `granted_scope` against the descriptor, plus — while the row is
 * `scope_missing` — whatever the reason named when the shortfall was found at
 * push time (a grant whose scope string looked complete but whose provider
 * still refused). Empty when nothing is missing. Order: the descriptor's.
 */
export function missingScopesFor(
  row: { status: string; status_reason: string | null; granted_scope: string | null },
  provider: Pick<AccountingProvider, 'requiredScopes'> | undefined,
): string[] {
  const required = provider?.requiredScopes ?? []
  const fromGrant = compareGrantedScopes(row.granted_scope, required)
  const fromReason = row.status === 'scope_missing' ? scopesFromStatusReason(row.status_reason) : []
  // The descriptor's order first; a scope the reason named that the
  // descriptor does not list (a connector's own vocabulary) follows.
  const out = required.filter((r) => fromGrant.includes(r) || fromReason.includes(r))
  for (const s of fromReason) if (!out.includes(s)) out.push(s)
  return out
}
