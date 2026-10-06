/**
 * Ops console reveal reads (#3509). Convention: `README.md` in this directory.
 *
 * The closed set of fields `POST /ops/reveal` can return, and the read that
 * returns each one. Anything not listed is refused (by the spec's enums, and
 * again by `isOpsRevealField`). The data slices (#3512–#3514) add entries as
 * their pages show new masked fields; #3602 adds the feedback message's text.
 *
 * Cross-tenant by design: an operator reveals a field of any customer's
 * record. That is why every read here runs on the executor the caller passes —
 * the read-only ops role (#3510) — and never defaults to the main pool.
 */
import type { Executor } from '../transaction.js'
import { FEEDBACK_REVEAL_TEXT_SQL } from './feedback.js'

export const OPS_REVEAL_SQL = {
  user: {
    email: 'SELECT email AS value FROM users WHERE id = $1',
    name: 'SELECT name AS value FROM users WHERE id = $1',
  },
  // #3602: one feedback message's text. The expiry filter lives in the
  // constant (feedback.ts) — an expired row reveals nothing, like a missing one.
  feedback: {
    text: FEEDBACK_REVEAL_TEXT_SQL,
  },
} as const satisfies Record<string, Record<string, string>>

export type OpsRevealTarget = keyof typeof OPS_REVEAL_SQL

export function isOpsRevealField(targetType: string, field: string): boolean {
  const fields = (OPS_REVEAL_SQL as Record<string, Record<string, string>>)[targetType]
  return fields !== undefined && Object.prototype.hasOwnProperty.call(fields, field)
}

/** One field of one record; `undefined` when the record does not exist. */
export async function readOpsRevealField(
  db: Executor,
  targetType: string,
  field: string,
  targetId: string,
): Promise<{ value: string | null } | undefined> {
  if (!isOpsRevealField(targetType, field)) throw new Error(`not a revealable field: ${targetType}.${field}`)
  const sql = (OPS_REVEAL_SQL as Record<string, Record<string, string>>)[targetType][field]
  const { rows } = await db.query<{ value: string | null }>(sql, [targetId])
  return rows[0]
}
