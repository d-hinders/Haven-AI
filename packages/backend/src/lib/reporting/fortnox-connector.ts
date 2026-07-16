import {
  FORTNOX_API_BASE,
  FortnoxError,
} from '../fortnox.js'
import {
  fortnoxConfigured,
  getFortnoxConnection,
  getValidFortnoxAccessToken,
} from '../fortnox-connection.js'
import type { AccountingConnector, PushResult } from './connector.js'
import type { ReportingTransaction } from './reporting-transaction.js'
import { loadReceiptUnderlag, type ReceiptUnderlag } from './receipt-underlag.js'

/**
 * Fortnox feed adapter (epic #491, P1 #496) — the first live
 * `AccountingConnector`.
 *
 * Mechanism (per the #494 spike, docs/research/fortnox-non-asserting-feed.md):
 * an **unattested supplier invoice**. Created via the API it sits unbooked
 * until a human attests and bookkeeps it, so Haven asserts nothing — we supply
 * supplier + amount + date + a description, and the accountant picks account
 * and VAT. The payload deliberately carries **no voucher rows, no BAS account,
 * no VAT fields**; `assertNonAsserting()` makes that a runtime invariant, not
 * just a convention (and the test suite locks it).
 *
 * Semantics for our already-settled payments: the invoice is fed as a source
 * document for a purchase that has already been paid on-chain — DueDate =
 * InvoiceDate, and the description says "already settled". Whether Fortnox
 * offers a better "externally paid" marking is the #494 open question 2; the
 * sandbox round-trip decides it and this comment records the outcome.
 *
 * Idempotency: the orchestrator's dedup ledger (`reporting_feed_syncs`, #497)
 * is the guarantee — `claimSync` ensures one push per (user, provider,
 * payment). Connector-side, the supplier-invoice `ExternalInvoiceNumber`
 * carries `HAVEN-<paymentId>` so a duplicate is also *detectable* in Fortnox
 * itself (best-effort belt to the ledger's braces).
 *
 * Receipt attachment (the underlag, #498): after the invoice is created the
 * verifiable receipt is rendered as a small PDF (`receipt-underlag.ts`),
 * uploaded to the Fortnox **Inbox** and connected to the invoice via
 * `supplierinvoicefileconnections`. Attachment is strictly best-effort — a
 * missing receipt or a failed upload NEVER fails the push (the invoice is
 * already the delivered value); the degradation is carried back on
 * `PushResult.note` and recorded on the sync row for observability. Requires
 * the `inbox` OAuth scope — connections consented before the scope widened
 * degrade to note-only until the user reconnects.
 */

/** Fortnox supplier invoices identify our feed rows. Max 50 chars per API. */
export function externalInvoiceNumber(paymentId: string): string {
  return `HAVEN-${paymentId}`.slice(0, 50)
}

/** Keys that would make the payload ASSERTING — structurally banned. */
const ASSERTING_KEYS = ['SupplierInvoiceRows', 'VAT', 'VATType', 'Account', 'VoucherRows']

/**
 * Runtime guard: the feed must never assert accounting judgment. Throws if a
 * payload gained a forbidden key (e.g. through a future "helpful" refactor).
 */
export function assertNonAsserting(payload: Record<string, unknown>): void {
  for (const key of ASSERTING_KEYS) {
    if (key in payload) {
      throw new FortnoxError(`non-asserting invariant violated: payload carries ${key}`, 0)
    }
  }
}

interface FortnoxSupplier {
  SupplierNumber: string
  Name: string
}

/** Build the supplier display name for a counterparty (deterministic). */
export function supplierNameFor(tx: ReportingTransaction): string {
  if (tx.counterparty.name) return tx.counterparty.name.slice(0, 100)
  if (tx.counterparty.address) {
    const a = tx.counterparty.address
    // ASCII hyphen, NOT the app's canonical … ellipsis: Fortnox rejects it in
    // the supplier Name too (error 2000359 — found live on the first real
    // feed, 2026-07-16, same class as the Comments gotcha).
    return `Merchant ${a.slice(0, 6)}-${a.slice(-4)}`
  }
  return 'Unknown merchant'
}

/**
 * Human description carried on the invoice (token amount + source).
 * Fortnox's Comments field rejects several non-alphanumeric characters
 * ("Värdet innehåller ej tillåtna tecken", error 2000359 — found live in the
 * sandbox): no middle dots, and URLs' :// also trip it. Keep to plain
 * ASCII words, commas and periods; the resource host carries enough context.
 */
export function feedDescription(tx: ReportingTransaction): string {
  const resourceHost = (() => {
    if (!tx.resourceUrl) return null
    try {
      return new URL(tx.resourceUrl).host
    } catch {
      return null
    }
  })()
  const parts = [
    'Agent payment, already settled on-chain.',
    `Amount ${tx.amountAtomic} ${tx.token} atomic.`,
    resourceHost ? `Resource ${resourceHost}.` : null,
    `Haven payment ${tx.paymentId}.`,
  ].filter(Boolean)
  return parts.join(' ').slice(0, 512)
}

async function fortnoxGet<T>(accessToken: string, path: string, fetchImpl: typeof fetch): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(`${FORTNOX_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    })
  } catch (err) {
    throw new FortnoxError(`Could not reach Fortnox: ${err instanceof Error ? err.message : String(err)}`, 0)
  }
  if (!res.ok) throw new FortnoxError(`Fortnox GET ${path} failed (HTTP ${res.status}).`, res.status)
  return (await res.json()) as T
}

async function fortnoxPost<T>(
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(`${FORTNOX_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new FortnoxError(`Could not reach Fortnox: ${err instanceof Error ? err.message : String(err)}`, 0)
  }
  if (!res.ok) {
    // Fortnox wraps errors as { ErrorInformation: { message, code } } — carry
    // the message so the sync ledger's failure reason is actionable. These
    // messages describe the request, never credentials.
    const detail = await res
      .json()
      .then((b) => (b as { ErrorInformation?: { message?: string; code?: number } }).ErrorInformation)
      .catch(() => undefined)
    throw new FortnoxError(
      `Fortnox POST ${path} failed (HTTP ${res.status}${detail?.message ? `: ${detail.message}` : ''}${detail?.code ? ` [${detail.code}]` : ''}).`,
      res.status,
    )
  }
  return (await res.json()) as T
}

/** Upload a PDF to the Fortnox Inbox; returns the file id to connect with. */
async function fortnoxUploadPdf(
  accessToken: string,
  underlag: ReceiptUnderlag,
  fetchImpl: typeof fetch,
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(underlag.pdf)], { type: 'application/pdf' }), underlag.filename)
  let res: Response
  try {
    // No explicit Content-Type: fetch sets the multipart boundary itself.
    res = await fetchImpl(`${FORTNOX_API_BASE}/inbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      body: form,
    })
  } catch (err) {
    throw new FortnoxError(`Could not reach Fortnox: ${err instanceof Error ? err.message : String(err)}`, 0)
  }
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b) => (b as { ErrorInformation?: { message?: string; code?: number } }).ErrorInformation)
      .catch(() => undefined)
    throw new FortnoxError(
      `Fortnox inbox upload failed (HTTP ${res.status}${detail?.message ? `: ${detail.message}` : ''}${detail?.code ? ` [${detail.code}]` : ''}).`,
      res.status,
    )
  }
  const body = (await res.json()) as { File?: { Id?: string } }
  if (!body.File?.Id) throw new FortnoxError('Fortnox inbox upload returned no file id.', 0)
  return body.File.Id
}

export class FortnoxConnector implements AccountingConnector {
  provider = 'fortnox'

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async isConnected(userId: string): Promise<boolean> {
    if (!fortnoxConfigured()) return false
    return (await getFortnoxConnection(userId)) !== null
  }

  /**
   * Find the supplier for this counterparty, or create it (minimal record:
   * name only — no org number guessing, no address assertion).
   */
  private async findOrCreateSupplier(
    accessToken: string,
    tx: ReportingTransaction,
  ): Promise<FortnoxSupplier> {
    const name = supplierNameFor(tx)
    const found = await fortnoxGet<{ Suppliers?: FortnoxSupplier[] }>(
      accessToken,
      `/suppliers?name=${encodeURIComponent(name)}`,
      this.fetchImpl,
    )
    const exact = (found.Suppliers ?? []).find(
      (s) => s.Name.toLowerCase() === name.toLowerCase(),
    )
    if (exact) return exact

    const created = await fortnoxPost<{ Supplier: FortnoxSupplier }>(
      accessToken,
      '/suppliers',
      { Supplier: { Name: name } },
      this.fetchImpl,
    )
    return created.Supplier
  }

  async pushTransaction(userId: string, tx: ReportingTransaction): Promise<PushResult> {
    const accessToken = await getValidFortnoxAccessToken(userId, this.fetchImpl)
    if (!accessToken) {
      return { externalRef: null, status: 'skipped', reason: 'not_connected' }
    }
    // Resolve the underlag up front (never throws — null degrades to a note).
    const underlag = await loadReceiptUnderlag(userId, tx)
    return this.pushWithToken(accessToken, tx, underlag)
  }

  /**
   * The push itself, given a token — shared by pushTransaction and the sandbox
   * validation pilot (scripts/fortnox-sandbox-validation.ts), so the live
   * round-trip exercises EXACTLY the production payload construction.
   */
  async pushWithToken(
    accessToken: string,
    tx: ReportingTransaction,
    underlag: ReceiptUnderlag | null = null,
  ): Promise<PushResult> {
    // The orchestrator gates on FX-ready, but the connector re-checks: a feed
    // row without a book-time SEK amount cannot be a usable source document.
    if (tx.amountSek == null) {
      return { externalRef: null, status: 'skipped', reason: 'no_sek_amount' }
    }
    // Inbound payments are not supplier purchases — out of scope for the
    // supplier-invoice mechanism (they'd be customer invoices / other income).
    if (tx.direction !== 'out') {
      return { externalRef: null, status: 'skipped', reason: 'not_outbound' }
    }

    const supplier = await this.findOrCreateSupplier(accessToken, tx)

    const invoiceDate = tx.settledAt.slice(0, 10)
    const invoice: Record<string, unknown> = {
      SupplierNumber: supplier.SupplierNumber,
      InvoiceDate: invoiceDate,
      // Already settled on-chain — nothing is due. DueDate = InvoiceDate keeps
      // the AP aging clean until the accountant reconciles the payment leg.
      DueDate: invoiceDate,
      Total: Number(tx.amountSek),
      Currency: 'SEK',
      ExternalInvoiceNumber: externalInvoiceNumber(tx.paymentId),
      Comments: feedDescription(tx),
      // Suggestion only, surfaced in the comment — NEVER as an account row.
      ...(tx.suggestedAccount
        ? { YourReference: `suggested account ${tx.suggestedAccount}` }
        : {}),
    }
    assertNonAsserting(invoice)

    const created = await fortnoxPost<{ SupplierInvoice?: { GivenNumber?: number } }>(
      accessToken,
      '/supplierinvoices',
      { SupplierInvoice: invoice },
      this.fetchImpl,
    )
    const givenNumber = created.SupplierInvoice?.GivenNumber

    // #498: attach the receipt underlag — strictly best-effort. The invoice is
    // the delivered value; any attachment problem becomes an observable note.
    let note: string | undefined
    if (givenNumber == null) {
      note = 'receipt not attached: Fortnox returned no invoice number'
    } else if (!underlag) {
      note = 'receipt not attached: no receipt available for this payment'
    } else {
      try {
        const fileId = await fortnoxUploadPdf(accessToken, underlag, this.fetchImpl)
        await fortnoxPost(
          accessToken,
          '/supplierinvoicefileconnections',
          {
            SupplierInvoiceFileConnection: {
              SupplierInvoiceNumber: String(givenNumber),
              FileId: fileId,
            },
          },
          this.fetchImpl,
        )
      } catch (err) {
        note = `receipt attachment failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    return {
      externalRef: givenNumber != null ? `fortnox:supplierinvoice:${givenNumber}` : null,
      status: 'pushed',
      ...(note ? { note } : {}),
    }
  }
}
