import { loadReceiptUnderlagSource } from '../../infra/repositories/machine-payments.js'
import { safeGetBinary, type SafeFetchOptions, type SsrfRefusal } from '../../infra/http/ssrf-guard.js'
import type { FeedTransaction } from './feed-transaction.js'

/**
 * Receipt underlag for the reporting feed (epic #491, P2 #498).
 *
 * The Swedish bookkeeping requirement behind the feed is the *underlag*: the
 * source document an accountant files alongside the amounts. For an agent
 * payment that document is the verifiable payment receipt (#479/#486) — this
 * module renders it as a small, deterministic, dependency-free PDF that the
 * connector attaches to the fed object (Fortnox: inbox upload + supplier
 * invoice file connection).
 *
 * The PDF is intentionally plain (Courier text, ASCII only): it is a filing
 * artifact, not a branding surface, and plain ASCII sidesteps the same Fortnox
 * character restrictions that bit the Comments/Name fields live (error
 * 2000359). Independent cryptographic verification stays with the receipt
 * JSON via the API + `@haven_ai/sdk`'s `verifyPaymentReceipt`; the PDF says so.
 */

export interface ReceiptUnderlagData {
  paymentId: string
  settledAt: string
  token: string
  amountAtomic: string
  /**
   * The token amount in human decimals, rendered as the Amount figure (#3917).
   * The atomic value stays on the line as a secondary annotation — it is the
   * verifiable settlement fact — but it must never be the number an extraction
   * or a consultant reads as the invoice amount. Null when the row carried no
   * human amount (pre-#2877 rows): the line then labels the atomic figure
   * explicitly instead of scaling it with an invented decimals assumption.
   */
  amount: string | null
  amountSek: string | null
  fxRate: string | null
  fxSource: string | null
  fxAt: string | null
  /**
   * The figure on the record this underlag backs, and its currency (#2877).
   * For a SEK ledger it is the SEK book value and the line is unchanged; for
   * any other it is the amount actually invoiced, so the document and the
   * invoice cannot state two unrelated numbers.
   */
  amountLedger: string | null
  ledgerCurrency: string
  fxRateLedger: string | null
  merchantName: string | null
  merchantAddress: string | null
  /**
   * #3918: the seller identity the merchant's own invoice carries (via the
   * captured merchant receipt), plus the catalog's supplier country — the
   * fields a Swedish consultant needs for omvand (reverse) VAT coding.
   * Every field stays null when unknown: a filing artifact never invents a
   * seller.
   */
  merchantCountry: string | null
  merchantVatNo: string | null
  merchantOrgNo: string | null
  resourceUrl: string | null
  chainId: number | null
  /**
   * #3767: the hash the surface BOOKS — the verified merchant settlement when
   * one is recorded (or pinned at the first claim), else the funding hash.
   * `txHashIsFunding` labels the fallback; `fundingTxHash` is the secondary
   * line shown beside a booked settlement. Null → the raw `tx_hash` renders
   * as before (retired / legacy rails are unchanged).
   */
  txHash: string | null
  txHashIsFunding: boolean
  fundingTxHash: string | null
  delegate: string | null
  signHash: string | null
  signature: string | null
}

export interface ReceiptUnderlag {
  filename: string
  pdf: Buffer
}

function pdfEscape(line: string): string {
  return line
    .replace(/[^\x20-\x7e]/g, '?') // ASCII only — filing artifact, see header
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

/** Wrap long values (tx hashes, signatures) so no line overflows the page. */
function wrap(line: string, width = 88): string[] {
  if (line.length <= width) return [line]
  const out: string[] = []
  for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width))
  return out
}

/**
 * Minimal single-page PDF, hand-assembled — no PDF library in the backend and
 * a text-only underlag doesn't justify one. Deterministic for fixed input.
 */
export function receiptPdf(lines: string[]): Buffer {
  const text = lines.flatMap((l) => wrap(l)).map(pdfEscape)
  const content = ['BT', '/F1 9 Tf', '11 TL', '40 800 Td', ...text.map((l) => `(${l}) Tj T*`), 'ET'].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xrefAt = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** Render the underlag document (pure — the pilot script uses it directly). */
export function underlagFromData(data: ReceiptUnderlagData): ReceiptUnderlag {
  const lines = [
    'HAVEN PAYMENT RECEIPT (underlag)',
    '='.repeat(72),
    '',
    `Payment id     ${data.paymentId}`,
    `Settled at     ${data.settledAt}`,
    // #3917: the Amount figure is the scaled token amount (the same human
    // figure the book value below is computed from) — `amountAtomic` on this
    // line is what made Accounted's extraction read 1 500,00 US$ off a
    // 0.0015 USDC payment. The atomic figure stays, labelled, as the
    // verifiable settlement fact; when no human amount was captured the line
    // says so instead of implying a scale.
    ...(data.amount != null
      ? [`Amount         ${data.amount} ${data.token} (${data.amountAtomic} atomic units)`]
      : [`Amount         ${data.amountAtomic} ${data.token} (atomic units)`]),
    data.amountLedger != null
      ? `Book value     ${data.amountLedger} ${data.ledgerCurrency} (rate ${data.fxRateLedger ?? 'n/a'}, ${data.fxSource ?? 'n/a'}, ${data.fxAt ?? 'n/a'})`
      : 'Book value     not captured',
    // The SEK capture is kept as a second line for a non-SEK ledger: it is the
    // value migration 026 has recorded for this payment all along, and an
    // accountant reconciling against Haven's own history should be able to see
    // it without being told the invoice is in kronor.
    ...(data.ledgerCurrency !== 'SEK' && data.amountSek != null
      ? [`Haven SEK ref  ${data.amountSek} SEK (rate ${data.fxRate ?? 'n/a'}, same capture)`]
      : []),
    `Merchant       ${data.merchantName ?? data.merchantAddress ?? 'unknown'}`,
    ...(data.merchantName && data.merchantAddress ? [`Merchant addr  ${data.merchantAddress}`] : []),
    // #3918: the seller block, from the merchant's own invoice and the
    // catalog country — the reverse-VAT fields (Emil, our Accounted contact:
    // country + VAT reg no decide the omvand coding). Lines appear only when
    // the value is known; the document never states an empty-looking fact.
    ...(data.merchantCountry ? [`Country        ${data.merchantCountry}`] : []),
    ...(data.merchantVatNo ? [`VAT reg no     ${data.merchantVatNo}`] : []),
    ...(data.merchantOrgNo ? [`Org no         ${data.merchantOrgNo}`] : []),
    `Resource       ${data.resourceUrl ?? 'n/a'}`,
    '',
    'ON-CHAIN SETTLEMENT',
    `Chain id       ${data.chainId ?? 'n/a'}`,
    // #3767: the settlement hash is the "Tx hash" line (it is what the
    // merchant and the explorer call the payment), with the funding leg kept
    // as a secondary line in the same 15-column label style. When only the
    // funding hash could be booked (no verified settlement within the
    // window), the funding hash IS the line — labelled as funding.
    ...(data.txHashIsFunding
      ? [`Funding tx     ${data.txHash ?? 'n/a'}`]
      : [`Tx hash        ${data.txHash ?? 'n/a'}`]),
    ...(data.fundingTxHash ? [`Funding tx     ${data.fundingTxHash}`] : []),
    '',
    'AUTHORIZATION',
    `Delegate       ${data.delegate ?? 'n/a'}`,
    `Sign hash      ${data.signHash ?? 'n/a'}`,
    `Signature      ${data.signature ?? 'n/a'}`,
    '',
    'This document renders the Haven payment receipt. The agent authorisation',
    'signature can be checked independently of Haven: fetch the receipt JSON',
    'from the Haven API and check it with verifyPaymentReceipt in the',
    '@haven_ai/sdk package. That confirms the delegate signature (verifiedOver',
    ...(data.txHashIsFunding
      ? [
          // #3767: true when only the funding leg is shown — that transaction
          // is NOT the settlement, so the old sentence would overclaim here.
          'names which hash was signed) — the payment facts stay Haven-asserted. Only',
          'the funding leg is shown above; the settlement itself is proven by the',
          "merchant's own transaction, reported separately, not by this document.",
        ]
      : [
          'names which hash was signed) — the payment facts stay Haven-asserted and',
          'settlement is proven only by the on-chain transaction above.',
        ]),
  ]
  return {
    // ASCII-only filename; Fortnox rejects exotic characters in metadata too.
    // Cap the id part, never the extension — an extensionless upload risks
    // rejection at the inbox.
    filename: `haven-receipt-${data.paymentId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}.pdf`,
    pdf: receiptPdf(lines),
  }
}

/**
 * Render a merchant-issued INLINE receipt (#956) as an attachable PDF. The
 * document is presented as the merchant provided it (non-ASCII folded to '?',
 * the renderer's filing-artifact constraint) — Haven adds only a provenance
 * banner. Same renderer constraints as the evidence PDF above.
 */
export function merchantReceiptPdf(paymentId: string, inlineJson: unknown): ReceiptUnderlag {
  const pretty = JSON.stringify(inlineJson, null, 1) ?? 'null'
  const lines = [
    'MERCHANT-ISSUED RECEIPT',
    '='.repeat(72),
    '',
    'Provided by the merchant in the paid response and reported by the',
    `paying agent. Haven payment ${paymentId}. Contents as provided below`,
    '(non-ASCII characters folded to ?); Haven asserts nothing about them.',
    '',
    ...pretty.split('\n').slice(0, 400),
  ]
  return {
    filename: `merchant-receipt-${paymentId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 78)}.pdf`,
    pdf: receiptPdf(lines),
  }
}

/** Content types accepted from a merchant receipt URL (#956). */
const MERCHANT_RECEIPT_CONTENT_TYPES = new Map([
  ['application/pdf', 'pdf'],
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
])
const MERCHANT_RECEIPT_MAX_BYTES = 5 * 1024 * 1024
/** Total wall-clock budget for one guarded receipt read, matching the old 15 s timeout. */
const MERCHANT_RECEIPT_TIMEOUT_MS = 15_000

/**
 * Human-readable refusal for the receipt fetch. `http_status` keeps the old
 * "HTTP <status>" wording — connector notes surface it verbatim and the feed
 * audit trail quotes the provider's answer; the private/internal wording is
 * likewise kept so existing notes read the same.
 */
function merchantReceiptRefusalMessage(refusal: SsrfRefusal): string {
  if (refusal.reason === 'scheme_not_https') return 'merchant receipt url must be https'
  if (refusal.reason === 'host_not_public' || refusal.reason === 'address_not_public') {
    return `merchant receipt url points at a private or internal host (${refusal.detail})`
  }
  if (refusal.reason === 'http_status') return `merchant receipt fetch failed (${refusal.detail})`
  return `merchant receipt fetch refused: ${refusal.reason} (${refusal.detail})`
}

/**
 * Fetch a merchant receipt DOCUMENT by URL at feed time (#956, #4309) — under
 * the shared SSRF guard's `safeGetBinary` (resolve-validate-pin, the same
 * four controls every third-party-chosen URL gets; do not write a second
 * guard): https only, default port only, no IP literals or locally-bound
 * names, the hostname resolved and EVERY address classified before any
 * packet is sent, and the socket PINNED to a validated address — a resolver
 * that answers "public" to the check and "127.0.0.1" to the connect cannot
 * split the two. Redirects are refused outright (`maxRedirects: 0`), the
 * same posture as the old `redirect: 'error'`. Content-type whitelisted
 * (pdf/png/jpeg), 5 MB cap, 15 s total deadline. Throws with an actionable
 * message on any violation; the connector degrades to a note (never fails
 * the push).
 */
export async function fetchMerchantReceiptDocument(
  url: string,
  options: SafeFetchOptions = {},
): Promise<{ filename: string; bytes: Buffer; contentType: string }> {
  const result = await safeGetBinary(url, {
    timeoutMs: MERCHANT_RECEIPT_TIMEOUT_MS,
    maxBytes: MERCHANT_RECEIPT_MAX_BYTES,
    maxRedirects: 0,
    ...options,
  })
  if (!result.ok) throw new Error(merchantReceiptRefusalMessage(result))
  const contentType = (result.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  const ext = MERCHANT_RECEIPT_CONTENT_TYPES.get(contentType)
  if (!ext) throw new Error(`merchant receipt content-type '${contentType}' is not allowed (pdf/png/jpg only)`)
  const declared = Number(result.headers['content-length'] ?? '0')
  if (declared > MERCHANT_RECEIPT_MAX_BYTES) throw new Error('merchant receipt exceeds the 5MB cap')
  if (result.body.byteLength > MERCHANT_RECEIPT_MAX_BYTES) throw new Error('merchant receipt exceeds the 5MB cap')
  return { filename: `merchant-receipt.${ext}`, bytes: result.body, contentType }
}

/**
 * The merchant's own receipt/invoice as an uploadable document (#956, shared
 * by the Fortnox attachment and the Accounted second upload #3918): an
 * inline JSON is rendered as the provenance PDF (`merchantReceiptPdf`), a
 * URL is fetched through the SSRF guard's `safeGetBinary`
 * (`fetchMerchantReceiptDocument`) — resolve-validate-pin, https-only,
 * pdf/png/jpeg only, 5 MB cap, redirects refused. Null when the receipt
 * names neither. `options` is the guard's test seam (resolver, transport,
 * budgets); production uses system DNS and the pinned `node:https` transport.
 */
export async function merchantReceiptDocument(
  paymentId: string,
  receipt: { url: string | null; inlineJson: unknown | null },
  options: SafeFetchOptions = {},
): Promise<{ filename: string; bytes: Buffer; contentType: string } | null> {
  if (receipt.inlineJson != null) {
    const file = merchantReceiptPdf(paymentId, receipt.inlineJson)
    return { filename: file.filename, bytes: file.pdf, contentType: 'application/pdf' }
  }
  if (receipt.url) {
    const doc = await fetchMerchantReceiptDocument(receipt.url, options)
    return { filename: doc.filename, bytes: doc.bytes, contentType: doc.contentType }
  }
  return null
}

/**
 * The seller block the merchant's own invoice carries, read defensively off
 * the captured receipt JSON (#3918). The demo merchant's invoice (and any
 * merchant following the same Swedish bookkeeping shape) names it under
 * `saljare` — name, `org_nr`, `moms_nr` (the VAT reg no). Anything absent,
 * non-object or non-string reads as null: Haven asserts nothing about the
 * merchant-provided fields, it only carries them onto the underlag.
 */
export function sellerFromMerchantReceipt(inlineJson: unknown): {
  name: string | null
  orgNo: string | null
  vatNo: string | null
} {
  if (inlineJson == null || typeof inlineJson !== 'object') return { name: null, orgNo: null, vatNo: null }
  const saljare = (inlineJson as { saljare?: unknown }).saljare
  if (saljare == null || typeof saljare !== 'object') return { name: null, orgNo: null, vatNo: null }
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null)
  const s = saljare as { name?: unknown; org_nr?: unknown; moms_nr?: unknown }
  return { name: str(s.name), orgNo: str(s.org_nr), vatNo: str(s.moms_nr) }
}

/**
 * Load + render the underlag for a feed transaction. `receiptRef` is the
 * `machine_payment_evidence` row id (see `AccountingEntry.receiptRef`);
 * authorization details join in from the payment intent when there is one.
 * Returns null when the evidence row genuinely does not exist. A query
 * failure THROWS — the caller must degrade with a "lookup failed" note, not a
 * false "no receipt exists" diagnosis (the attachment is unrecoverable once
 * the invoice is posted, so the audit trail must state the real reason).
 */
export async function loadReceiptUnderlag(
  userId: string,
  tx: FeedTransaction,
): Promise<ReceiptUnderlag | null> {
  // SQL lives in infra/repositories/machine-payments.ts (#999).
  const row = await loadReceiptUnderlagSource(tx.receiptRef, userId)
  if (!row) return null
  // #3918: the seller identity comes from the merchant's OWN invoice when the
  // agent captured one (the demo merchant names Haven Demo AB + org/VAT nos);
  // the catalog country is the counterparty's — the feed's VAT-treatment
  // source, unchanged.
  const seller = sellerFromMerchantReceipt(tx.merchantReceipt?.inlineJson ?? null)
  return underlagFromData({
    paymentId: tx.paymentId,
    settledAt: tx.settledAt,
    token: tx.token,
    amountAtomic: tx.amountAtomic,
    amount: tx.amount,
    amountSek: tx.amountSek,
    fxRate: tx.fxRate,
    fxSource: tx.fxSource,
    fxAt: tx.fxAt,
    amountLedger: tx.amountLedger,
    ledgerCurrency: tx.ledgerCurrency,
    fxRateLedger: tx.fxRateLedger,
    merchantName: seller.name ?? tx.counterparty.name,
    merchantAddress: tx.counterparty.address ?? row.merchant_address,
    merchantCountry: tx.counterparty.country,
    merchantVatNo: seller.vatNo,
    merchantOrgNo: seller.orgNo,
    resourceUrl: tx.resourceUrl,
    chainId: row.chain_id,
    // #3767: the BOOKED hash — the settlement when available/pinned, the
    // funding hash labelled as funding after the window, null (raw
    // `row.tx_hash`) on retired rails so their rendering never moves.
    txHash: tx.txHash ?? row.tx_hash,
    txHashIsFunding: tx.txHashIsFunding,
    fundingTxHash: tx.fundingTxHash,
    delegate: row.delegate_address,
    signHash: row.sign_hash,
    signature: row.signature,
  })
}
