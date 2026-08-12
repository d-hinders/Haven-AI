import {
  FORTNOX_API_BASE,
  FortnoxError,
} from './fortnox.js'
import {
  fortnoxConfigured,
  getFortnoxConnection,
  getValidFortnoxAccessToken,
} from './fortnox-connection.js'
import { getSyncState, markPushed } from './feed-sync.js'
import type { AccountingConnector, PushResult } from './connector.js'
import type { ReportingTransaction } from './reporting-transaction.js'
import {
  loadReceiptUnderlag,
  merchantReceiptPdf,
  fetchMerchantReceiptDocument,
  type ReceiptUnderlag,
} from './receipt-underlag.js'

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
  contentType = 'application/pdf',
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(underlag.pdf)], { type: contentType }), underlag.filename)
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
    // Resolve the underlag up front. A lookup FAILURE must not read as "no
    // receipt exists" in the audit trail — carry the real reason as the note.
    let underlag: ReceiptUnderlag | null = null
    let lookupNote: string | undefined
    try {
      underlag = await loadReceiptUnderlag(userId, tx)
    } catch (err) {
      lookupNote = `receipt lookup failed: ${err instanceof Error ? err.message : String(err)}`
    }
    const result = await this.pushWithToken(accessToken, tx, underlag)
    return lookupNote && result.status === 'pushed' ? { ...result, note: lookupNote } : result
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

    // #498/#956: attach the underlag files — strictly best-effort. The invoice
    // is the delivered value; any attachment problem becomes an observable
    // note. Two possible files: the Haven-generated payment evidence (#498,
    // always expected) and the merchant's OWN receipt (#956, present only
    // when the agent captured one — absence is the normal case, not a note).
    const notes: string[] = []
    if (givenNumber == null) {
      notes.push('receipt not attached: Fortnox returned no invoice number')
    } else {
      if (!underlag) {
        notes.push('receipt not attached: no receipt available for this payment')
      } else {
        try {
          await this.attachFile(accessToken, givenNumber, underlag)
        } catch (err) {
          notes.push(`receipt attachment failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (tx.merchantReceipt) {
        try {
          await attachMerchantReceiptFiles(
            accessToken, givenNumber, tx.paymentId, tx.merchantReceipt, this.fetchImpl,
          )
        } catch (err) {
          notes.push(`merchant receipt attachment failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    const note = notes.length > 0 ? notes.join('; ') : undefined
    return {
      externalRef: givenNumber != null ? `fortnox:supplierinvoice:${givenNumber}` : null,
      status: 'pushed',
      ...(note ? { note } : {}),
    }
  }

  /** Upload one file to the Inbox and connect it to the invoice (#498/#956). */
  private async attachFile(
    accessToken: string,
    givenNumber: number,
    file: ReceiptUnderlag,
    contentType = 'application/pdf',
  ): Promise<void> {
    const fileId = await fortnoxUploadPdf(accessToken, file, this.fetchImpl, contentType)
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
  }
}

/** Shared merchant-receipt attach: inline → provenance PDF, url → guarded fetch. */
async function attachMerchantReceiptFiles(
  accessToken: string,
  givenNumber: number,
  paymentId: string,
  receipt: { url: string | null; inlineJson: unknown | null },
  fetchImpl: typeof fetch,
): Promise<void> {
  let file: ReceiptUnderlag
  let contentType = 'application/pdf'
  if (receipt.inlineJson != null) {
    file = merchantReceiptPdf(paymentId, receipt.inlineJson)
  } else if (receipt.url) {
    const doc = await fetchMerchantReceiptDocument(receipt.url, fetchImpl)
    file = { filename: doc.filename, pdf: doc.bytes }
    contentType = doc.contentType
  } else {
    return
  }
  const fileId = await fortnoxUploadPdf(accessToken, file, fetchImpl, contentType)
  await fortnoxPost(
    accessToken,
    '/supplierinvoicefileconnections',
    { SupplierInvoiceFileConnection: { SupplierInvoiceNumber: String(givenNumber), FileId: fileId } },
    fetchImpl,
  )
}

/**
 * Read-back verification (#1362) — the first READ in an otherwise write-only
 * integration. Answers, from Fortnox's own records: (1) does the supplier
 * invoice we pushed still EXIST (= registered), and (2) has a human BOOKED it
 * (= accounted, with the voucher reference Fortnox assigned)? Strictly
 * read-only — the non-asserting principle is untouched; this asserts nothing,
 * writes nothing, and cannot book, cancel, or modify the invoice.
 *
 * The #494 spike proved the fields live: an API-created supplier invoice
 * carries `Booked: false` and no voucher until a human attests it; booking
 * fills `VoucherNumber`/`VoucherSeries`/`VoucherYear`.
 */
export interface FortnoxInvoiceVerification {
  /** The invoice exists in Fortnox under our external_ref. */
  registered: boolean
  /** A human has booked it (Fortnox `Booked`). Null when not registered. */
  booked: boolean | null
  /** Cancelled in Fortnox — registered but struck. Null when not registered. */
  cancelled: boolean | null
  invoice_number: number
  /** `<series><number> <year>` when booked, e.g. "A123 2026". Null until booked. */
  voucher: string | null
  invoice_date: string | null
  total: number | null
  checked_at: string
}

export async function verifyFortnoxInvoice(
  userId: string,
  paymentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; verification: FortnoxInvoiceVerification }
  | { ok: false; error_code: 'not_pushed' | 'not_connected' | 'no_invoice_ref'; status: string | null }
> {
  const sync = await getSyncState(userId, 'fortnox', paymentId)
  if (!sync || sync.status !== 'pushed') {
    return { ok: false, error_code: 'not_pushed', status: sync?.status ?? null }
  }
  const match = sync.external_ref?.match(/^fortnox:supplierinvoice:(\d+)$/)
  if (!match) return { ok: false, error_code: 'no_invoice_ref', status: sync.status }
  const givenNumber = Number(match[1])

  const accessToken = await getValidFortnoxAccessToken(userId, fetchImpl)
  if (!accessToken) return { ok: false, error_code: 'not_connected', status: sync.status }

  const checkedAt = new Date().toISOString()
  let invoice: {
    GivenNumber?: number
    ExternalInvoiceNumber?: string
    Booked?: boolean
    Cancelled?: boolean
    VoucherNumber?: number | null
    VoucherSeries?: string | null
    VoucherYear?: number | null
    InvoiceDate?: string
    Total?: number
  }
  try {
    const body = await fortnoxGet<{ SupplierInvoice?: typeof invoice }>(
      accessToken,
      `/supplierinvoices/${givenNumber}`,
      fetchImpl,
    )
    if (!body.SupplierInvoice) throw new FortnoxError('Fortnox returned no SupplierInvoice body.', 0)
    invoice = body.SupplierInvoice
  } catch (err) {
    if (err instanceof FortnoxError && err.status === 404) {
      // The invoice we pushed is GONE in Fortnox (deleted). Honest answer,
      // not an error — this is exactly what verification exists to surface.
      return {
        ok: true,
        verification: {
          registered: false, booked: null, cancelled: null,
          invoice_number: givenNumber, voucher: null, invoice_date: null,
          total: null, checked_at: checkedAt,
        },
      }
    }
    throw err
  }

  // Belt to the ledger's braces: the invoice number must carry OUR external
  // invoice number for this payment — a number collision (e.g. after a Fortnox
  // company switch) must not read as "your payment is registered".
  if (invoice.ExternalInvoiceNumber !== externalInvoiceNumber(paymentId)) {
    return {
      ok: true,
      verification: {
        registered: false, booked: null, cancelled: null,
        invoice_number: givenNumber, voucher: null, invoice_date: null,
        total: null, checked_at: checkedAt,
      },
    }
  }

  const voucher =
    invoice.Booked && invoice.VoucherNumber != null
      ? `${invoice.VoucherSeries ?? ''}${invoice.VoucherNumber}${invoice.VoucherYear ? ` ${invoice.VoucherYear}` : ''}`
      : null
  return {
    ok: true,
    verification: {
      registered: true,
      booked: Boolean(invoice.Booked),
      cancelled: Boolean(invoice.Cancelled),
      invoice_number: givenNumber,
      voucher,
      invoice_date: invoice.InvoiceDate ?? null,
      total: invoice.Total ?? null,
      checked_at: checkedAt,
    },
  }
}

/**
 * Late attach (#956, found live): for x402 the feed pushes at the FUNDING
 * confirmation, but the merchant hands its receipt to the agent only at the
 * merchant retry seconds later — so the invoice is already pushed when the
 * receipt arrives, and pushed sync rows are never re-claimed. The capture
 * route calls this fire-and-forget: when the payment is already pushed to
 * Fortnox, attach the just-captured receipt retroactively onto the invoice
 * we know from external_ref. Best-effort by contract — a failure becomes a
 * note on the sync row, never an error to the reporting agent.
 */
export async function lateAttachMerchantReceipt(
  userId: string,
  paymentId: string,
  receipt: { url: string | null; inlineJson: unknown | null },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const sync = await getSyncState(userId, 'fortnox', paymentId)
  if (!sync || sync.status !== 'pushed') return // not pushed — in-order flow attaches at push time
  const match = sync.external_ref?.match(/^fortnox:supplierinvoice:(\d+)$/)
  if (!match) return
  const givenNumber = Number(match[1])

  const accessToken = await getValidFortnoxAccessToken(userId, fetchImpl)
  if (!accessToken) return

  try {
    // Skip if a merchant-receipt file is already connected (guards the tiny
    // capture/push race from double-attaching).
    const existing = await fortnoxGet<{
      SupplierInvoiceFileConnections?: Array<{ SupplierInvoiceNumber?: string; Name?: string }>
    }>(accessToken, '/supplierinvoicefileconnections?limit=500', fetchImpl)
    const already = (existing.SupplierInvoiceFileConnections ?? []).some(
      (c) => String(c.SupplierInvoiceNumber) === String(givenNumber) && (c.Name ?? '').startsWith('merchant-receipt'),
    )
    if (already) return
    await attachMerchantReceiptFiles(accessToken, givenNumber, paymentId, receipt, fetchImpl)
  } catch (err) {
    await markPushed(
      userId, 'fortnox', paymentId, sync.external_ref,
      `merchant receipt late-attach failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
