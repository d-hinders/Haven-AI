import { getConnection } from '../../infra/repositories/accounting-connections.js'
import { getSyncState } from '../../infra/repositories/accounting-feed-syncs.js'
import { buildAccountingEntryForPayment } from './entry.js'
import { ledgerAmount } from './feed-transaction.js'
import {
  IGDRASIL_UPLOAD_MAX_BYTES,
  IgdrasilUploadHashMismatchError,
  igdrasilListCompanies,
  igdrasilUploadDocument,
  type IgdrasilProviderError,
  type IgdrasilUpload,
} from './igdrasil-client.js'
import { igdrasilConfigured, igdrasilCredentials, igdrasilOAuth2Config } from './igdrasil.js'
import type { AccountingConnector, ProviderSecrets, PushResult, VerifyOutcome } from './connector.js'
import type { FeedTransaction } from './feed-transaction.js'
import type { SafeFetchOptions } from '../../infra/http/ssrf-guard.js'
import { loadReceiptUnderlag, merchantReceiptDocument } from './receipt-underlag.js'
import { MultiCompanyGrantError, ProviderError, type ProviderCompanyInfo } from './provider.js'
import { getValidOAuth2AccessToken, revokeToken } from './oauth-flow.js'
import { ledgerCurrencyOrDefault } from '../../domain/ledger-currency.js'

/**
 * Igdrasil feed adapter (#4518, epic #2875) — document-only like Accounted,
 * OAuth2 like Fortnox.
 *
 * The push uploads the receipt underlag to the company's Igdrasil inbox
 * (`POST …/uploads`): stored, never booked, no voucher proposed — the
 * non-asserting shape with no account, VAT or lines anywhere in the request.
 * Delivery is PROVEN by the upload echoing the SHA-256 of the bytes sent.
 * Igdrasil keys a document on its bytes, so a retry of the same payment's
 * deterministic underlag names the same document (200) instead of filing a
 * second one; there is no idempotency key to send.
 *
 * Semantics, and why:
 *  - `baseCurrency` is **null** (`PublicCompany` has no currency field); the
 *    feed books in the default, SEK, as for Accounted.
 *  - Exactly one company is connectable. The consent screen lets a person
 *    pick several; the feed has no per-push company choice, so ≠ 1 THROWS at
 *    connect. The connector only throws — `completeOAuth2Connect` already
 *    revokes a grant whose company read throws (`capabilities.revoke`), and
 *    the callback answers `reason=multi_company`.
 *  - `capabilities.verify: false`: verify answers from Haven's own record.
 *  - `capabilities.revoke: true`: disconnect posts the refresh token to
 *    `/oauth/revoke`.
 *  - A push-time `401 invalid_token` is thrown as transient, the Fortnox
 *    precedent: the access token is refreshed a minute before its 900 s run
 *    out, so a 401 on a token Haven believes valid is most likely a grant the
 *    person revoked at Igdrasil — and the next refresh's `invalid_grant`
 *    flips the connection to `needs_reauthorisation` within one token life.
 *    Flipping on the 401 itself would also flip on a provider hiccup.
 *  - `503 writes_disabled` (Igdrasil has not switched this app's writes on)
 *    and every other 5xx are transient: thrown, retried by the sweep.
 *  - Late attach of a merchant receipt that arrives after the push is #4521,
 *    not here.
 */
export class IgdrasilConnector implements AccountingConnector {
  provider = 'igdrasil'

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    /** The merchant-receipt URL fetch goes through the SSRF guard (#4309); this is its test seam. */
    private readonly receiptFetchOptions: SafeFetchOptions = {},
  ) {}

  async isConnected(userId: string): Promise<boolean> {
    const row = await getConnection(userId, this.provider)
    return Boolean(row && row.secrets_ciphertext && row.status !== 'disconnected')
  }

  /**
   * Who the grant belongs to: `GET /api/v1/external/companies`. Called by the
   * generic connect with the fresh secrets, before anything is stored.
   */
  async getCompanyInfo(secrets: ProviderSecrets): Promise<ProviderCompanyInfo> {
    const accessToken = String(secrets.accessToken ?? '')
    const list = await igdrasilListCompanies(accessToken, this.fetchImpl)
    const companies = list.data ?? []
    if (companies.length === 0) {
      throw new ProviderError('The Igdrasil grant reaches no company.', 403, 'igdrasil')
    }
    // MUTATION TARGET (igdrasil-connector.test.ts "multi-company"): a grant
    // that reaches several companies must never book into one of them
    // silently. `has_more` counts too — a second page is a second company.
    if (companies.length > 1 || list.has_more) {
      throw new MultiCompanyGrantError('Igdrasil', list.has_more ? 'several' : companies.length)
    }
    const company = companies[0]
    return { externalCompanyId: company.id, name: company.name, baseCurrency: null }
  }

  /** The sync row's `external_ref` for one Igdrasil document (the frontend matches this shape). */
  private documentRef(documentId: string): string {
    return `igdrasil:document:${documentId}`
  }

  /**
   * The document push. Steps, each with its own failure shape:
   *
   *  1. A live access token (the generic flow refreshes under the row lock)
   *     and the company id the connect stored. No token → `not_connected`; no
   *     company → skipped, recoverable by reconnecting.
   *  2. `loadReceiptUnderlag` → the deterministic PDF. A lookup failure
   *     THROWS (never a false "no receipt exists"); absent evidence is a
   *     pre-push skip.
   *  3. Local size gate (25 MiB) before any request.
   *  4. Upload; the client proves delivery by the echoed SHA-256.
   *  5. The merchant's own invoice, when captured, is a second upload —
   *     best-effort: a failure is a NOTE on the pushed row, never a failed
   *     row (re-pushing to reach the invoice would re-file the underlag).
   */
  async pushTransaction(userId: string, tx: FeedTransaction): Promise<PushResult> {
    const accessToken = await getValidOAuth2AccessToken(igdrasilOAuth2Config(igdrasilCredentials()), userId, this.fetchImpl)
    if (!accessToken) return { externalRef: null, status: 'skipped', reason: 'not_connected' }
    const companyId = (await getConnection(userId, this.provider))?.external_company_id
    if (!companyId) {
      return { externalRef: null, status: 'skipped', reason: 'no company recorded on the connection — reconnect Igdrasil' }
    }

    const underlag = await loadReceiptUnderlag(userId, tx).catch((err: unknown) => {
      throw new ProviderError(
        `Igdrasil could not render the receipt document: ${err instanceof Error ? err.message : String(err)}`,
        0,
        'igdrasil',
      )
    })
    if (!underlag) {
      return { externalRef: null, status: 'skipped', reason: 'receipt evidence not found — nothing to upload' }
    }
    if (underlag.pdf.byteLength > IGDRASIL_UPLOAD_MAX_BYTES) {
      return { externalRef: null, status: 'skipped', reason: 'The receipt document is larger than Igdrasil accepts (over 25 MiB).' }
    }

    let upload: IgdrasilUpload
    try {
      ;({ upload } = await igdrasilUploadDocument({
        accessToken,
        companyId,
        file: { filename: underlag.filename, bytes: underlag.pdf, contentType: 'application/pdf' },
        fetchImpl: this.fetchImpl,
      }))
    } catch (err) {
      const refusal = preCreateRefusal(err)
      if (refusal) return refusal
      // 401, 429 (with `retryAfterMs`), `503 writes_disabled`, other 5xx,
      // network: retryable — throw, the sweep re-feeds with backoff.
      throw err
    }
    const externalRef = this.documentRef(upload.document_id)

    let merchantInvoiceRef: string | undefined
    const notes: string[] = []
    if (tx.merchantReceipt) {
      try {
        const doc = await merchantReceiptDocument(tx.paymentId, tx.merchantReceipt, this.receiptFetchOptions)
        if (!doc) {
          notes.push("the merchant's own receipt names neither a document nor a url")
        } else if (doc.bytes.byteLength > IGDRASIL_UPLOAD_MAX_BYTES) {
          notes.push("the merchant's own invoice is larger than Igdrasil accepts (over 25 MiB) — not attached")
        } else {
          const { upload: second } = await igdrasilUploadDocument({
            accessToken,
            companyId,
            file: { filename: doc.filename, bytes: doc.bytes, contentType: doc.contentType },
            fetchImpl: this.fetchImpl,
          })
          merchantInvoiceRef = this.documentRef(second.document_id)
        }
      } catch (err) {
        notes.push(`the merchant's own invoice was not attached: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return {
      externalRef,
      status: 'pushed',
      ...(merchantInvoiceRef ? { merchantInvoiceRef } : {}),
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    }
  }

  /**
   * Verify, answered from Haven's OWN record — zero provider calls
   * (`capabilities.verify: false`, the Accounted precedent). Registered when
   * the payment's sync row is `pushed` with THIS ref; a well-formed ref the
   * row does not carry is `foreign_invoice`; a ref of another shape is
   * `no_invoice_ref`. Booking is never claimed (null = not known).
   */
  async verify(userId: string, externalRef: string, paymentId: string): Promise<VerifyOutcome> {
    const checked_at = new Date().toISOString()
    const match = typeof externalRef === 'string' ? externalRef.match(IGDRASIL_DOCUMENT_REF_RE) : null
    if (!match) return { ok: false, error_code: 'no_invoice_ref' }

    const [row, entry, connection] = await Promise.all([
      getSyncState(userId, this.provider, paymentId),
      buildAccountingEntryForPayment(userId, paymentId),
      getConnection(userId, this.provider),
    ])
    const unregistered = {
      booked: null,
      cancelled: null,
      voucher: null,
      document_ref: null,
      invoice_number: null,
      invoice_date: null,
      total: null,
      checked_at,
    }
    if (!row || row.status !== 'pushed' || row.external_ref !== externalRef) {
      return { ok: true, verification: { registered: false, missing: 'foreign_invoice', ...unregistered } }
    }
    const ledger =
      entry && connection ? ledgerAmount(entry, ledgerCurrencyOrDefault(connection.base_currency)) : { amount: null }
    const total = ledger.amount == null ? null : Number(ledger.amount)
    return {
      ok: true,
      verification: {
        ...unregistered,
        registered: true,
        missing: null,
        document_ref: match[1],
        total: Number.isFinite(total) ? total : null,
      },
    }
  }

  /**
   * Revoke the grant at Igdrasil (`POST /oauth/revoke`, Basic client auth,
   * the refresh token — revoking it ends the family). Disconnect clears the
   * local secrets whether or not this succeeds.
   */
  async revoke(secrets: ProviderSecrets): Promise<void> {
    const refreshToken = typeof secrets.refreshToken === 'string' ? secrets.refreshToken : null
    if (!refreshToken) throw new ProviderError('Igdrasil connection holds no refresh token to revoke.', 0, 'igdrasil')
    await revokeToken(igdrasilOAuth2Config(igdrasilCredentials()), refreshToken, 'refresh_token', this.fetchImpl)
  }
}

/**
 * An upload refusal found BEFORE anything was created, mapped to a skipped
 * row (re-claimable once the connection is healthy again) — or null for a
 * failure that is retryable as it stands.
 */
function preCreateRefusal(err: unknown): PushResult | null {
  if (err instanceof IgdrasilUploadHashMismatchError) {
    return {
      externalRef: null,
      status: 'skipped',
      reason: 'Igdrasil answered success but stored different bytes than Haven uploaded (sha256 mismatch) — no reference stored',
    }
  }
  if (!(err instanceof ProviderError)) return null
  const code = (err as IgdrasilProviderError).providerCode ?? null
  if (err.status === 403 && code === 'insufficient_scope') {
    // MUTATION TARGET (igdrasil-connector.test.ts "insufficient_scope"):
    // the grant lacks the write scope — a grant problem, so the connection
    // flips and the dashboard asks for a re-consent naming the scope.
    return {
      externalRef: null,
      status: 'skipped',
      reason: `scope refused before the document was created: ${err.message}`,
      connectionStatus: 'scope_missing',
      missingScopes: ['vouchers:write'],
    }
  }
  if (err.status === 403 && (code === 'company_not_granted' || code === 'grant_role_revoked')) {
    // The grant no longer reaches the company, or the person who approved it
    // is no longer its owner or admin: only a fresh approval fixes either.
    return {
      externalRef: null,
      status: 'skipped',
      reason: `the Igdrasil grant can no longer write to this company (${code}) — reconnect Igdrasil: ${err.message}`,
      connectionStatus: 'needs_reauthorisation',
    }
  }
  if (err.status === 400) {
    // The document itself was refused (empty, over 25 MiB, or bytes that do
    // not match the part's type) — permanent for these bytes.
    return { externalRef: null, status: 'skipped', reason: `the receipt document was not accepted: ${err.message}` }
  }
  return null
}

/** A foreign or malformed ref can never be a document Haven filed. */
const IGDRASIL_DOCUMENT_REF_RE = /^igdrasil:document:([0-9a-fA-F-]{8,64})$/

/**
 * The instance `src/index.ts` registers — or null when this deployment has no
 * Igdrasil app configured, so the provider reports `configured: false` and
 * cannot be connected. A function so the gate is tested, not inferred.
 */
export function igdrasilConnectorIfConfigured(fetchImpl: typeof fetch = fetch): IgdrasilConnector | null {
  return igdrasilConfigured() ? new IgdrasilConnector(fetchImpl) : null
}
