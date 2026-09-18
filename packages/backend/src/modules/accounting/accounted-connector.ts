import { getConnection } from '../../infra/repositories/accounting-connections.js'
import { getSyncState } from '../../infra/repositories/accounting-feed-syncs.js'
import { buildAccountingEntryForPayment } from './entry.js'
import { ledgerAmount } from './feed-transaction.js'
import {
  ACCOUNTED_DOCUMENTS_MAX_BYTES,
  AccountedDocumentHashMismatchError,
  accountedIdempotencyKey,
  accountedUploadDocument,
  accountedListCompanies,
  isAccountedAuthRefusal,
  type AccountedCompany,
  type AccountedDocument,
} from './accounted-client.js'
import type { AccountingConnector, ProviderSecrets, PushResult, VerifyOutcome } from './connector.js'
import type { FeedTransaction } from './feed-transaction.js'
import { loadReceiptUnderlag } from './receipt-underlag.js'
import { ProviderError, type ProviderCompanyInfo } from './provider.js'
import { readApiKeyConnection } from './api-key-flow.js'
import { ledgerCurrencyOrDefault } from '../../domain/ledger-currency.js'

/**
 * Accounted feed adapter (#3017 connect, #3018 the document push; epic
 * #3016 slices 1 and 2) — the second live `AccountingConnector`, and the
 * first of the API-key kind.
 *
 * Slice 2 IS the connector: Accounted's write model is a single WORM
 * document per payment (`POST /api/v1/companies/{companyId}/documents` —
 * immutable once accepted), so `pushTransaction` renders the verifiable
 * receipt underlag, uploads it, PROVES delivery by echoing the provider's
 * `sha256_hash` against the local bytes, and only then hands back the
 * namespaced ref the sync row stores. There is no supplier invoice, no
 * attachment step, no journal entry — the document is the object.
 *
 * Semantics the issues pin, and why:
 *  - `baseCurrency` is **null, never 'SEK'** (slice 1): the company read
 *    exposes no currency field, and inventing a value would let a future
 *    provider change read as a switch. The feed books such a connection in
 *    `DEFAULT_LEDGER_CURRENCY` ('SEK') — an inference from the Swedish
 *    entity, stated in the product doc, not a claim from the provider.
 *  - One company is the connectable case (slice 1). Several →
 *    `MultiCompanyKeyError` → 409 `MULTI_COMPANY_KEY`.
 *  - `documents:write` cannot be validated at connect (no
 *    scope-introspection endpoint; `dry_run` unsupported on upload). A key
 *    missing the write scope surfaces at the first push as `scope_missing`
 *    (#2865) — the provider answers 403 `INSUFFICIENT_SCOPE`, which
 *    `pushTransaction` maps; a plain `FORBIDDEN` 403 is NOT a scope problem
 *    and is thrown for the sweep to retry.
 *  - Keys are revoked in the Accounted dashboard, not via API, so `revoke`
 *    is a no-op and the descriptor declares `capabilities.revoke: false`;
 *    disconnect still clears the local secrets (`connections.ts`).
 *  - `capabilities.verify: false`: verify is answered from Haven's own
 *    record, without a provider call — there is no `GET /documents/{id}`,
 *    and `/download` writes a `document.accessed` audit event per call.
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
   * The sync row's `external_ref` for one Accounted document. Namespaced
   * like Fortnox's (`fortnox:supplierinvoice:<n>`) and the in-memory
   * connector's — the namespace is what makes `no_invoice_ref` reachable
   * for a foreign ref.
   */
  private documentRef(documentId: string): string {
    return `accounted:document:${documentId}`
  }

  /**
   * The document push (#3018). Steps, each with its own failure shape:
   *
   *  1. Secrets + company id off the generic connection row (the company id
   *     is WHERE the document goes; a row without one cannot upload —
   *     skipped, recoverable by reconnecting).
   *  2. `loadReceiptUnderlag` → the deterministic PDF (`receiptPdf` is
   *     deterministic for fixed input). A query failure THROWS (the caller
   *     must not record a false "no receipt exists"); a genuinely absent
   *     evidence row is a pre-push `skipped` — there is nothing to deliver,
   *     and a `pushed` row with no document at the provider would be a lie.
   *  3. Local oversize gate: the underlag alone over 10 MB is skipped
   *     BEFORE any request; the reason is what `AccountingBadge` shows on
   *     hover, so it reads as a sentence.
   *  4. `accountedUploadDocument` with `Idempotency-Key =
   *     uuid5(paymentId)`: the bytes are deterministic and the merchant
   *     receipt is excluded, so a retry of the same payment replays the
   *     provider's cached answer.
   *  5. Delivery proof: a 2xx (the spec declares `200`, not `201` — keying
   *     on `201` would turn every real success into `skipped`) whose
   *     `data.sha256_hash` equals the local SHA-256. Anything else is not a
   *     delivery: skipped, and no ref is stored for bytes Haven cannot
   *     vouch for.
   *
   * Owner decisions pinned by the issue: the suggested-account hint is NOT
   * added (the upload takes exactly the `file` and `upload_source` parts —
   * `additionalProperties: false`) and the merchant receipt is NOT uploaded
   * in v1 (one upload is one document and the sync row holds one ref; the
   * second document is a follow-up once the row can hold a second id).
   */
  async pushTransaction(userId: string, tx: FeedTransaction): Promise<PushResult> {
    const connection = await readApiKeyConnection('accounted', userId)
    if (!connection) return { externalRef: null, status: 'skipped', reason: 'not_connected' }
    const companyId = connection.row.external_company_id
    if (!companyId) {
      // A key whose company read never succeeded has no destination to
      // upload into; the connect flow stores the id, so this row predates
      // it or was degraded — recoverable by reconnecting.
      return { externalRef: null, status: 'skipped', reason: 'no company recorded on the connection — reconnect Accounted' }
    }

    const underlag = await loadReceiptUnderlag(userId, tx).catch((err: unknown) => {
      // A lookup failure is NOT "no receipt exists" — throwing keeps the row
      // retryable instead of recording a false permanent skip.
      throw new ProviderError(
        `Accounted could not render the receipt document: ${err instanceof Error ? err.message : String(err)}`,
        0,
        'accounted',
      )
    })
    if (!underlag) {
      return { externalRef: null, status: 'skipped', reason: 'receipt evidence not found — nothing to upload' }
    }
    if (underlag.pdf.byteLength > ACCOUNTED_DOCUMENTS_MAX_BYTES) {
      return {
        externalRef: null,
        status: 'skipped',
        reason: 'The receipt document is larger than Accounted accepts (over 10 MB).',
      }
    }

    let document: AccountedDocument
    try {
      ;({ document } = await accountedUploadDocument({
        apiKey: connection.secrets.apiKey,
        companyId,
        file: { filename: underlag.filename, bytes: underlag.pdf, contentType: 'application/pdf' },
        idempotencyKey: accountedIdempotencyKey(tx.paymentId),
        fetchImpl: this.fetchImpl,
      }))
    } catch (err) {
      if (err instanceof AccountedDocumentHashMismatchError) {
        return {
          externalRef: null,
          status: 'skipped',
          reason: 'Accounted answered success but stored different bytes than Haven uploaded (sha256 mismatch) — no reference stored',
        }
      }
      const code = providerErrorCode(err)
      if (err instanceof ProviderError && err.status === 403 && code === 'INSUFFICIENT_SCOPE') {
        // A grant problem, found PRE-push: nothing exists at the provider,
        // so the row is a real skipped AND the connection flips (#2865).
        // The scope is named only when the envelope's `details` carries it —
        // the sandbox's real body is recorded when the connector first runs
        // against it (the one unknown the issue flags).
        return {
          externalRef: null,
          status: 'skipped',
          reason: `scope refused before the document was created: ${err.message}`,
          connectionStatus: 'scope_missing',
          ...missingScopesFromDetails(err),
        }
      }
      if (err instanceof ProviderError && err.status === 409 && code === 'IDEMPOTENCY_KEY_REUSE') {
        // TERMINAL: the key derives from the paymentId, so this is the same
        // payment's slot filed with DIFFERENT bytes — the underlag changed
        // under a document already in the WORM store. Never retried (the
        // sweep re-feeds skipped rows, but this skip is permanent), counted,
        // and named so the badge tooltip says what happened.
        return {
          externalRef: null,
          status: 'skipped',
          reason: 'IDEMPOTENCY_KEY_REUSE — the document already filed for this payment was uploaded with different bytes; not re-filed',
        }
      }
      if (
        err instanceof ProviderError &&
        err.status === 400 &&
        (code === 'DOC_UPLOAD_TOO_LARGE' || code === 'DOC_UPLOAD_UNSUPPORTED_TYPE')
      ) {
        // The provider refused the document itself — permanent, not retryable.
        return { externalRef: null, status: 'skipped', reason: `${code} — the receipt document was not accepted` }
      }
      // `DOC_UPLOAD_STORAGE_FAILED` (500), plain `FORBIDDEN` 403, 429, and
      // every other failure are retryable: throw, the sweep re-feeds with
      // backoff (and defers the connection on the 429).
      throw err
    }

    // Proven delivery: the provider echoed the bytes back hash-identical.
    return { externalRef: this.documentRef(document.id), status: 'pushed' }
  }

  /**
   * Verify, answered from Haven's OWN record — zero provider calls. The
   * descriptor declares `capabilities.verify: false` and this honours it:
   * there is no `GET /documents/{id}` on the 2026-05-12 spec, and
   * `/download` writes a `document.accessed` audit event per call, so a
   * read-back would stamp the user's audit trail on every dashboard check
   * (#3019 owns the provider read-back, if it ever happens).
   *
   * The three outcomes:
   *  - the sync row for `(userId, 'accounted', paymentId)` is `pushed` with
   *    THIS ref → registered, `document_ref` = the document id, `total`
   *    from the row's ledger amount. `booked`/`cancelled`/`voucher` stay
   *    null — Haven cannot know booking without a provider call, and null
   *    means "not claimed", never "no".
   *  - the ref is well-formed but the row does not carry it → the document
   *    belongs to another payment (a company-switch collision):
   *    `missing: 'foreign_invoice'`.
   *  - the ref is not `accounted:document:<id>` → `{ ok: false,
   *    error_code: 'no_invoice_ref' }`.
   */
  async verify(userId: string, externalRef: string, paymentId: string): Promise<VerifyOutcome> {
    const checked_at = new Date().toISOString()
    const match = typeof externalRef === 'string' ? externalRef.match(ACCOUNTED_DOCUMENT_REF_RE) : null
    if (!match) return { ok: false, error_code: 'no_invoice_ref' }

    // The record the push wrote after the sha256 proof, and the payment's own
    // ledger figure — the SAME computation the feed pushed (`ledgerAmount`,
    // the connection's booked currency), so verify cannot drift from what was
    // delivered. Both reads are local; no network call happens.
    const [row, entry, connection] = await Promise.all([
      getSyncState(userId, this.provider, paymentId),
      buildAccountingEntryForPayment(userId, paymentId),
      getConnection(userId, this.provider),
    ])
    if (!row || row.status !== 'pushed' || row.external_ref !== externalRef) {
      return {
        ok: true,
        verification: {
          registered: false,
          missing: 'foreign_invoice',
          booked: null,
          cancelled: null,
          voucher: null,
          document_ref: null,
          invoice_number: null,
          invoice_date: null,
          total: null,
          checked_at,
        },
      }
    }
    // The connection's booked currency: null (Accounted cannot say) books in
    // the default, exactly as `getActiveDestination` decides it for the push.
    const ledger =
      entry && connection
        ? ledgerAmount(entry, ledgerCurrencyOrDefault(connection.base_currency))
        : { amount: null }
    const total = ledger.amount == null ? null : Number(ledger.amount)
    return {
      ok: true,
      verification: {
        registered: true,
        missing: null,
        booked: null,
        cancelled: null,
        voucher: null,
        document_ref: match[1],
        invoice_number: null,
        invoice_date: null,
        total: Number.isFinite(total) ? total : null,
        checked_at,
      },
    }
  }

  /**
   * Accounted keys are revoked in their dashboard (the product doc says so);
   * nothing to call. `capabilities.revoke: false` means the generic
   * disconnect never invokes this — it is here to satisfy the contract.
   */
  async revoke(secrets: ProviderSecrets): Promise<void> {}
}

/**
 * The provider's error CODE off a thrown upload failure (`providerCode`,
 * set by `accountedUploadDocument` from the envelope's `error.code`).
 */
function providerErrorCode(err: unknown): string | null {
  const v = (err as { providerCode?: unknown } | null)?.providerCode
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * `missingScopes` from the envelope's `details`, when `details` names the
 * scope (`details.missingScopes` is the expected shape — CONFIRM against the
 * sandbox's real 403 body before relying on it; the reason string always
 * names the code meanwhile). Absent or shaped otherwise → no scopes named.
 */
function missingScopesFromDetails(err: ProviderError): { missingScopes?: string[] } {
  const details = (err as { details?: unknown }).details
  if (!details || typeof details !== 'object') return {}
  const raw = (details as { missingScopes?: unknown }).missingScopes
  if (!Array.isArray(raw)) return {}
  const scopes = raw.filter((s): s is string => typeof s === 'string' && s.length > 0)
  return scopes.length > 0 ? { missingScopes: scopes } : {}
}

/** A foreign or malformed ref can never be a document Haven filed. */
const ACCOUNTED_DOCUMENT_REF_RE = /^accounted:document:([0-9a-fA-F-]{8,64})$/

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
