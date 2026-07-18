import pool from '../../db.js'
import type { ReportingTransaction } from './reporting-transaction.js'

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
  amountSek: string | null
  fxRate: string | null
  fxSource: string | null
  fxAt: string | null
  merchantName: string | null
  merchantAddress: string | null
  resourceUrl: string | null
  chainId: number | null
  txHash: string | null
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
    `Amount         ${data.amountAtomic} ${data.token} (atomic units)`,
    data.amountSek != null
      ? `Book value     ${data.amountSek} SEK (rate ${data.fxRate ?? 'n/a'}, ${data.fxSource ?? 'n/a'}, ${data.fxAt ?? 'n/a'})`
      : 'Book value     not captured',
    `Merchant       ${data.merchantName ?? data.merchantAddress ?? 'unknown'}`,
    ...(data.merchantName && data.merchantAddress ? [`Merchant addr  ${data.merchantAddress}`] : []),
    `Resource       ${data.resourceUrl ?? 'n/a'}`,
    '',
    'ON-CHAIN SETTLEMENT',
    `Chain id       ${data.chainId ?? 'n/a'}`,
    `Tx hash        ${data.txHash ?? 'n/a'}`,
    '',
    'AUTHORIZATION',
    `Delegate       ${data.delegate ?? 'n/a'}`,
    `Sign hash      ${data.signHash ?? 'n/a'}`,
    `Signature      ${data.signature ?? 'n/a'}`,
    '',
    'This document renders the verifiable Haven payment receipt. Anyone can',
    'verify it independently of Haven: fetch the receipt JSON from the Haven',
    'API and check it with verifyPaymentReceipt in the @haven_ai/sdk package.',
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

/** Hostname patterns that must never be fetched server-side (SSRF floor). */
const BLOCKED_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.6[4-9]\.|100\.[7-9]\d\.|100\.1[01]\d\.|100\.12[0-7]\.|0\.|\[::1?\]|\[::ffff:.*|\[f[cd][0-9a-f]{2}:.*|\[fe80:.*|.*\.local|.*\.internal)/i

/**
 * Fetch a merchant receipt DOCUMENT by URL at feed time (#956) — strictly
 * guarded: https only, private/internal hosts refused, content-type
 * whitelisted, size-capped. Throws with an actionable message on any
 * violation; the connector degrades to a note (never fails the push).
 *
 * Known residual: string-level host blocking does not defeat DNS rebinding,
 * and exotic address literals beyond the covered v4/v6 ranges may slip the
 * regex — the real fix is resolve-then-validate against private ranges.
 * Acceptable for the current dev/testnet posture, revisit before any
 * production rollout (noted in the security review).
 */
export async function fetchMerchantReceiptDocument(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ filename: string; bytes: Buffer; contentType: string }> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error('merchant receipt url must be https')
  if (BLOCKED_HOST_RE.test(parsed.hostname)) {
    throw new Error('merchant receipt url points at a private or internal host')
  }
  const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`merchant receipt fetch failed (HTTP ${res.status})`)
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const ext = MERCHANT_RECEIPT_CONTENT_TYPES.get(contentType)
  if (!ext) throw new Error(`merchant receipt content-type '${contentType}' is not allowed (pdf/png/jpg only)`)
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > MERCHANT_RECEIPT_MAX_BYTES) throw new Error('merchant receipt exceeds the 5MB cap')
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.byteLength > MERCHANT_RECEIPT_MAX_BYTES) throw new Error('merchant receipt exceeds the 5MB cap')
  return { filename: `merchant-receipt.${ext}`, bytes, contentType }
}

interface UnderlagSourceRow {
  tx_hash: string | null
  chain_id: number | null
  merchant_address: string | null
  sign_hash: string | null
  signature: string | null
  delegate_address: string | null
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
  tx: ReportingTransaction,
): Promise<ReceiptUnderlag | null> {
  const result = await pool.query<UnderlagSourceRow>(
    `SELECT mpe.tx_hash, mpe.chain_id, mpe.merchant_address,
            pi.sign_hash, pi.signature, pi.delegate_address
     FROM machine_payment_evidence mpe
     LEFT JOIN payment_intents pi ON pi.id = mpe.payment_intent_id
     WHERE mpe.id = $1 AND mpe.user_id = $2`,
    [tx.receiptRef, userId],
  )
  const row = result.rows[0]
  if (!row) return null
  return underlagFromData({
    paymentId: tx.paymentId,
    settledAt: tx.settledAt,
    token: tx.token,
    amountAtomic: tx.amountAtomic,
    amountSek: tx.amountSek,
    fxRate: tx.fxRate,
    fxSource: tx.fxSource,
    fxAt: tx.fxAt,
    merchantName: tx.counterparty.name,
    merchantAddress: tx.counterparty.address ?? row.merchant_address,
    resourceUrl: tx.resourceUrl,
    chainId: row.chain_id,
    txHash: row.tx_hash,
    delegate: row.delegate_address,
    signHash: row.sign_hash,
    signature: row.signature,
  })
}
