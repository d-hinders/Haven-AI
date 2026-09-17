import { getConnection } from '../../infra/repositories/accounting-connections.js'
import { accountedListCompanies, isAccountedAuthRefusal, type AccountedCompany } from './accounted-client.js'
import type { AccountingConnector, ProviderSecrets, PushResult, VerifyOutcome } from './connector.js'
import type { FeedTransaction } from './feed-transaction.js'
import { ProviderError, type ProviderCompanyInfo } from './provider.js'

/**
 * Accounted feed adapter (#3017, epic #3016 slice 1) — the second live
 * `AccountingConnector`, and the first of the API-key kind.
 *
 * Slice 1 is the CONNECT half only: `getCompanyInfo` reads
 * `GET /api/v1/companies` with the pasted bearer key. That is the provider's
 * ONLY company read path — there is no `GET /companies/{id}` on the
 * 2026-05-12 spec — so it is also how a reconnect detects a company switch
 * (conformance case 8 depends on the id). The push half (documents, suppliers)
 * is #3018; the methods exist so the class satisfies the contract and answer
 * "not pushed" / skip without touching the provider.
 *
 * Semantics the issue pins, and why:
 *  - `baseCurrency` is **null, never 'SEK'**: the company read exposes no
 *    currency field (`accounting_method`/`moms_period` exist only on
 *    `POST /companies`), and inventing a value would let a future provider
 *    change read as a switch. `assertSupportedBaseCurrency` passes null and
 *    the feed books such a connection in `DEFAULT_LEDGER_CURRENCY` ('SEK') —
 *    the product doc states that as an inference from `entity_type`/`org_number`
 *    (Swedish entities), not a claim from the provider.
 *  - One company is the connectable case. Several → `MultiCompanyKeyError` →
 *    the route's 409 `MULTI_COMPANY_KEY` ("create a key scoped to one
 *    company") — there is no provider-side error for it; the list simply
 *    returns N rows. Zero companies or an auth refusal (401/403) →
 *    `InvalidApiKeyError` via the generic flow.
 *  - Keys are revoked in the Accounted dashboard, not via API, so `revoke`
 *    is a no-op here and the descriptor declares `capabilities.revoke: false`;
 *    disconnect still clears the local secrets (`connections.ts`).
 *  - `documents:write` cannot be validated at connect (no scope-introspection
 *    endpoint; `dry_run` unsupported on upload). The paste copy names both
 *    required scopes; a key missing the write scope surfaces at the first
 *    push as `scope_missing` (#2865) — the provider answers 403
 *    `INSUFFICIENT_SCOPE`, which slice 2 maps.
 */
export class AccountedConnector implements AccountingConnector {
  provider = 'accounted'

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async isConnected(userId: string): Promise<boolean> {
    // The generic connection row is the source of truth for api_key
    // connections; the Fortnox adapter's per-provider table has no Accounted
    // analogue (keys are per user, not per deployment). "Connected" means a
    // row with secrets that is not disconnected — the same read
    // `readApiKeyConnection` gates the feed's own secrets on.
    const row = await getConnection(userId, this.provider)
    return Boolean(row && row.secrets_ciphertext && row.status !== 'disconnected')
  }

  /**
   * Who the key belongs to. The validation IS this call: the generic
   * api-key flow refuses a key the provider rejects (401/403 →
   * `InvalidApiKeyError`) before anything is stored.
   */
  async getCompanyInfo(secrets: ProviderSecrets): Promise<ProviderCompanyInfo> {
    const apiKey = String(secrets.apiKey ?? '')
    let companies: AccountedCompany[]
    try {
      const body = await accountedListCompanies(apiKey, this.fetchImpl)
      companies = body.data ?? []
    } catch (err) {
      // MUTATION TARGET (accounted-connector.test.ts "auth refusal"): letting
      // a 401 through as a non-refusal would store a dead key. Only a 401/403
      // is a key problem; a network error or 5xx is an outage and is thrown.
      if (isAccountedAuthRefusal(err)) {
        throw new ProviderError(err.message, err.status, 'accounted')
      }
      throw err
    }
    if (companies.length === 0) {
      // A valid key that can see nothing is useless to the feed: same user
      // answer as a rejected key (the route maps this to 400 INVALID_API_KEY).
      throw new ProviderError('Accounted GET /api/v1/companies returned no companies.', 401, 'accounted')
    }
    if (companies.length > 1) {
      // MUTATION TARGET (accounted-connector.test.ts "multi-company"): the
      // multi-company 409 exists so a consultant key never books into the
      // wrong of N companies silently. The feed has no companyId parameter.
      throw new MultiCompanyKeyError(companies.length)
    }
    const company = companies[0]
    return {
      externalCompanyId: company.id,
      name: company.name,
      baseCurrency: null,
    }
  }

  /**
   * Slice 2 (#3018) replaces this with the document push. Until then the
   * connection never feeds: the orchestrator sees `skipped` rows it can
   * retry, never failures. Not reachable through the UI — the descriptor
   * gains its push capability with #3018.
   */
  async pushTransaction(userId: string, tx: FeedTransaction): Promise<PushResult> {
    return { externalRef: null, status: 'skipped', reason: 'push_not_in_slice_1' }
  }

  async verify(userId: string, externalRef: string, paymentId: string): Promise<VerifyOutcome> {
    return { ok: false, error_code: 'no_invoice_ref' }
  }

  /**
   * Accounted keys are revoked in their dashboard (the product doc says so);
   * nothing to call. `capabilities.revoke: false` means the generic
   * disconnect never invokes this — it is here to satisfy the contract.
   */
  async revoke(secrets: ProviderSecrets): Promise<void> {}
}

/**
 * The key can see MORE THAN ONE company (`GET /api/v1/companies` returned N > 1).
 * Haven's feed has no per-push company choice, so a multi-company key is
 * refused at connect with 409 `MULTI_COMPANY_KEY`: the user creates a key
 * scoped to one company (a separate Accounted user for it) and pastes that.
 */
export class MultiCompanyKeyError extends Error {
  readonly code = 'MULTI_COMPANY_KEY' as const
  constructor(public readonly count: number) {
    super(
      `This Accounted key can see ${count} companies — create a key scoped to one company and connect with that instead.`,
    )
    this.name = 'MultiCompanyKeyError'
  }
}
