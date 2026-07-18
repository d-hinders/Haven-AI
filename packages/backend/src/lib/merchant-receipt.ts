import pool from '../db.js'

/**
 * Merchant-issued receipt capture + retrieval (#956, follow-up to #498).
 *
 * The reporting feed's always-present attachment is the HAVEN-generated
 * payment evidence document (#498). When the merchant ALSO hands the agent a
 * receipt after settlement (invoice number, VAT breakdown, org number —
 * facts Haven's evidence cannot assert), the agent reports it and the feed
 * attaches it as a SECOND file on the fed transaction. Absence is the normal
 * case for early agent payments — never a degradation.
 *
 * Two tolerated formats (issue #956 acceptance):
 * - `inline_json`: the receipt document itself, size-capped at the route.
 * - `url`: a reference, fetched at FEED time (the connector), never here —
 *   with strict SSRF guards on that side.
 *
 * Capture is idempotent per evidence row (first write wins — a merchant's
 * receipt for a settled payment is immutable source material; re-reported
 * duplicates are dropped rather than letting a later, different document
 * silently replace what may already be attached in the accounting tool).
 */

/** Inline receipts are bookkeeping metadata, not blob storage. */
export const MERCHANT_RECEIPT_INLINE_MAX_BYTES = 64 * 1024
/** URLs must be https and sanely sized. */
export const MERCHANT_RECEIPT_URL_MAX_LENGTH = 2048

export interface MerchantReceipt {
  url: string | null
  inlineJson: unknown | null
}

export interface CaptureMerchantReceiptInput {
  /** Payment id (intent or approval) as the agent knows it. */
  paymentId: string
  agentId: string
  url?: string
  inlineJson?: unknown
}

export type CaptureResult =
  | { ok: true; stored: boolean }
  | { ok: false; error: string; code: 400 | 404 }

export function validateMerchantReceiptUrl(url: string): string | null {
  if (url.length > MERCHANT_RECEIPT_URL_MAX_LENGTH) return 'url is too long'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'url must be a valid absolute URL'
  }
  if (parsed.protocol !== 'https:') return 'url must be https'
  return null
}

export async function captureMerchantReceipt(
  input: CaptureMerchantReceiptInput,
): Promise<CaptureResult> {
  const { paymentId, agentId, url, inlineJson } = input
  if (url === undefined && inlineJson === undefined) {
    return { ok: false, code: 400, error: 'Provide url or json' }
  }
  if (url !== undefined) {
    if (typeof url !== 'string') return { ok: false, code: 400, error: 'url must be a string' }
    const urlError = validateMerchantReceiptUrl(url)
    if (urlError) return { ok: false, code: 400, error: urlError }
  }
  if (inlineJson !== undefined) {
    if (inlineJson === null || typeof inlineJson !== 'object') {
      return { ok: false, code: 400, error: 'json must be an object' }
    }
    const size = Buffer.byteLength(JSON.stringify(inlineJson), 'utf8')
    if (size > MERCHANT_RECEIPT_INLINE_MAX_BYTES) {
      return {
        ok: false, code: 400,
        error: `json exceeds the ${MERCHANT_RECEIPT_INLINE_MAX_BYTES / 1024}KB inline cap — host it and report a url instead`,
      }
    }
  }

  // The evidence row is the anchor (#498's receiptRef) — agent-scoped via the
  // intent/approval join so an agent can only annotate its own payments.
  const evidence = await pool.query<{ id: string }>(
    `SELECT mpe.id
     FROM machine_payment_evidence mpe
     LEFT JOIN payment_intents pi ON pi.id = mpe.payment_intent_id
     LEFT JOIN approval_requests ar ON ar.id = mpe.approval_request_id
     WHERE COALESCE(mpe.payment_intent_id::TEXT, mpe.approval_request_id::TEXT) = $1
       AND COALESCE(pi.agent_id, ar.agent_id) = $2`,
    [paymentId, agentId],
  )
  const evidenceId = evidence.rows[0]?.id
  if (!evidenceId) {
    return { ok: false, code: 404, error: 'No settled payment evidence found for this payment' }
  }

  const inserted = await pool.query(
    `INSERT INTO merchant_receipts (evidence_id, url, inline_json)
     VALUES ($1, $2, $3)
     ON CONFLICT (evidence_id) DO NOTHING
     RETURNING evidence_id`,
    [evidenceId, url ?? null, inlineJson === undefined ? null : JSON.stringify(inlineJson)],
  )
  return { ok: true, stored: inserted.rows.length > 0 }
}

/** The merchant receipt for an evidence row, or null. */
export async function getMerchantReceipt(evidenceId: string): Promise<MerchantReceipt | null> {
  const result = await pool.query<{ url: string | null; inline_json: unknown }>(
    `SELECT url, inline_json FROM merchant_receipts WHERE evidence_id = $1`,
    [evidenceId],
  )
  const row = result.rows[0]
  if (!row) return null
  return { url: row.url, inlineJson: row.inline_json ?? null }
}
