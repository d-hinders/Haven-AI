/**
 * Real-DB tests for the feedback repository (#3597, epic #1219's rule).
 *
 * Every claim here is a claim about POSTGRES: that an insert stores a
 * redacted copy, that a read excludes an expired row, and that the purge
 * deletes expired rows and nothing else. A positional mock would assert only
 * that `query` was called in the order the test already assumed.
 */
import { beforeEach, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { deleteExpiredFeedback, findFeedbackById, insertFeedback } from '../feedback.js'

async function insertTestUser(): Promise<string> {
  const email = `${randomBytes(8).toString('hex')}@example.com`
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  )
  return rows[0].id
}

describeDb('feedback (#3597)', () => {
  beforeEach(async () => {
    await initDbHarness()
    await resetDb()
    await db.query('DELETE FROM feedback')
  })

  it('inserts and reads a row back, unexpired', async () => {
    const userId = await insertTestUser()
    const row = await insertFeedback(userId, 'The CLI timed out on wallets funding.')
    expect(row.user_id).toBe(userId)
    expect(row.text).toBe('The CLI timed out on wallets funding.')

    const read = await findFeedbackById(row.id)
    expect(read).toMatchObject({ id: row.id, text: row.text })
  })

  it('applies redactVendorSecrets to the text before storing it', async () => {
    const userId = await insertTestUser()
    const row = await insertFeedback(
      userId,
      'My bundler call failed: https://api.pimlico.io/v2/base/rpc?apikey=should-not-be-stored',
    )
    expect(row.text).not.toContain('should-not-be-stored')
    expect(row.text).toContain('apikey=REDACTED')

    const stored = await db.query<{ text: string }>('SELECT text FROM feedback WHERE id = $1', [row.id])
    expect(stored.rows[0].text).not.toContain('should-not-be-stored')
  })

  it('a read excludes an expired row — the 7 days hold even if the sweep lags', async () => {
    const userId = await insertTestUser()
    const row = await insertFeedback(userId, 'Expired already.')
    await db.query("UPDATE feedback SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [row.id])

    expect(await findFeedbackById(row.id)).toBeNull()
  })

  it('MUTATION PROOF: the purge deletes expired rows and nothing else', async () => {
    const userId = await insertTestUser()
    const live = await insertFeedback(userId, 'Still live.')
    const dead = await insertFeedback(userId, 'Should be swept.')
    await db.query("UPDATE feedback SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [dead.id])

    const deleted = await deleteExpiredFeedback()
    expect(deleted).toBe(1)

    const remaining = await db.query<{ id: string }>('SELECT id FROM feedback')
    expect(remaining.rows.map((r) => r.id)).toEqual([live.id])
  })

  it('the purge is a no-op when nothing has expired', async () => {
    const userId = await insertTestUser()
    await insertFeedback(userId, 'Fresh.')
    expect(await deleteExpiredFeedback()).toBe(0)
  })
})
