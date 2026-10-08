/**
 * Agent-reported delivery quality on a settled payment (#3770).
 *
 * A settled payment's `settled: true` is an on-chain fact: a paid call that
 * returned unusable output (the 2026-10-08 Soundside `create_text` run —
 * 0.01 USDC paid, `message: ":**\n"` back) still reads as a success on the
 * receipt, because nothing else could say otherwise. This module is the
 * evidence-only answer: the agent that made the payment can record
 * `ok` / `unusable` / `partial` (with a bounded note) on its OWN settled
 * payment, and the receipt reads carry it beside the payment.
 *
 * Hard rules (issue #3770): the report moves no money, never alters any
 * money field, and NEVER changes `settled`. The write goes to
 * `machine_payment_delivery_reports` only — nothing here touches
 * `payment_intents`. Another agent's payment is refused (the lookup is
 * agent-scoped); an unsettled payment is refused (a report about a delivery
 * that has not happened yet is not evidence).
 */
import {
  findIntentForEvidenceScoped,
  upsertDeliveryQualityReport,
} from '../../infra/repositories/machine-payments.js'
import type { MppHandlerResult } from './types.js'

export type DeliveryQuality = 'ok' | 'unusable' | 'partial'

export const DELIVERY_QUALITIES: readonly DeliveryQuality[] = ['ok', 'unusable', 'partial']

/**
 * The note bound. The module refuses over this BEFORE the write, so the
 * database CHECK (migration 107) is a second line of defence, not the
 * refusal an agent sees.
 */
export const DELIVERY_QUALITY_NOTE_MAX = 2000

export function isDeliveryQuality(value: unknown): value is DeliveryQuality {
  return typeof value === 'string' && (DELIVERY_QUALITIES as readonly string[]).includes(value)
}

/**
 * `POST /machine-payments/{id}/delivery-quality` orchestration. The route
 * keeps only auth wiring, rate limiting and the enforced request schema;
 * this is the semantic layer.
 */
export async function recordDeliveryQualityHandler(
  agentId: string,
  paymentId: string,
  quality: DeliveryQuality,
  note?: string,
): Promise<MppHandlerResult> {
  if (!isDeliveryQuality(quality)) {
    return {
      statusCode: 400,
      body: { error: 'quality must be one of "ok", "unusable" or "partial"' },
    }
  }
  const trimmedNote = note?.trim()
  if (trimmedNote !== undefined && trimmedNote !== '' && trimmedNote.length > DELIVERY_QUALITY_NOTE_MAX) {
    return {
      statusCode: 400,
      body: { error: `note must be at most ${DELIVERY_QUALITY_NOTE_MAX} characters` },
    }
  }

  // Agent-scoped by construction: another agent's (or a nonexistent) payment
  // is indistinguishable here, exactly like the evidence attach path.
  const intent = await findIntentForEvidenceScoped(paymentId, agentId)
  if (!intent) {
    return { statusCode: 404, body: { error: 'Payment not found' } }
  }
  // `expectedStatusForPayment` is 'confirmed' and a settled protocol payment
  // always carries a tx hash — the same gate the evidence attach applies
  // before writing. A report requires a DELIVERY; an unsettled payment has
  // not delivered anything yet.
  if (intent.status !== 'confirmed' || !intent.tx_hash) {
    return {
      statusCode: 409,
      body: { error: 'Delivery quality can only be recorded on a settled payment' },
    }
  }

  const report = await upsertDeliveryQualityReport({
    paymentIntentId: intent.id,
    agentId,
    userId: intent.user_id,
    quality,
    note: trimmedNote === '' ? null : (trimmedNote ?? null),
  })

  return {
    statusCode: 200,
    body: {
      payment_id: intent.id,
      quality: report.quality,
      note: report.note,
      updated_at: report.updated_at,
    },
  }
}
