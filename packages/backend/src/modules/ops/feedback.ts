/**
 * `GET /ops/feedback` (#3602, epic #3507): the last 7 days of
 * `haven feedback submit` messages (#3597), for the console's Feedback page.
 *
 * The message text is masked with `maskFreeText` — length only, no content —
 * and the submitter's email through the existing email masker; the unmasked
 * text leaves only through `POST /ops/reveal` (`feedback.text`, audited).
 * Rows the list shows have already been filtered to unexpired ones by the
 * read (`expires_at > NOW()`, migration 106's discipline, in one place).
 */
import type { Executor } from '../../infra/transaction.js'
import { readOpsFeedbackList } from '../../infra/repositories/ops-reads.js'
import { maskEmail, maskFreeText } from './masking.js'

export interface OpsFeedbackList {
  feedback: {
    id: string
    /** The submitter, masked (`da•••@gmail.com`). */
    email: string
    /** The masked message: a character count, never a prefix or excerpt. */
    text: string
    created_at: string
    /** When the row stops being listed and revealable. */
    expires_at: string
  }[]
  generated_at: string
}

export async function buildOpsFeedbackList(
  db: Executor,
  now: () => number = Date.now,
): Promise<OpsFeedbackList> {
  const rows = await readOpsFeedbackList(db)
  return {
    feedback: rows.map((r) => ({
      id: r.id,
      email: maskEmail(r.email),
      text: maskFreeText(r.text),
      created_at: new Date(r.created_at).toISOString(),
      expires_at: new Date(r.expires_at).toISOString(),
    })),
    generated_at: new Date(now()).toISOString(),
  }
}
