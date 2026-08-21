/**
 * Real-DB tests for the hybrid-signers repository (#1679, on the #1220
 * harness). The signer-set reads label credential rows from `created_at`
 * ("Passkey · added {date}"), so what the SELECT actually returns — the
 * column's presence, enrollment ordering, and the Date → ISO mapping — is
 * database behaviour and belongs here, not behind a route mock
 * (`docs/contributing/testing-strategy.md`).
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { addAccountPasskey, listAccountPasskeys, passkeyEnrollmentDates } from '../hybrid-signers.js'

let seq = 0

async function seedUserSafe(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`hs${++seq}-${Date.now()}@test.example`],
  )
  const safe = await db.query<{ id: string }>(
    `INSERT INTO user_safes (user_id, safe_address, chain_id, name, account_type, execution_rail)
     VALUES ($1, $2, 84532, 'Test account', 'delegator_hybrid', 'delegation')
     RETURNING id`,
    [user.rows[0].id, `0x${String(seq).padStart(40, '0')}`],
  )
  return safe.rows[0].id
}

await initDbHarness()

describeDb('hybrid_account_passkeys reads (#1679)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('listAccountPasskeys returns created_at, ordered by enrollment time', async () => {
    const safeId = await seedUserSafe()
    await addAccountPasskey(safeId, { keyId: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' })
    // Backdate the second row so ordering is proven by created_at, not insert order.
    await db.query(
      `INSERT INTO hybrid_account_passkeys (user_safe_id, key_id, public_key_x, public_key_y, created_at)
       VALUES ($1, $2, '0x3', '0x4', NOW() - INTERVAL '1 day')`,
      [safeId, '0x' + '22'.repeat(32)],
    )

    const rows = await listAccountPasskeys(safeId)
    expect(rows.map((r) => r.key_id)).toEqual(['0x' + '22'.repeat(32), '0x' + '11'.repeat(32)])
    for (const row of rows) {
      expect(row.created_at).toBeTruthy()
      expect(Number.isNaN(new Date(row.created_at as never).getTime())).toBe(false)
    }
  })

  it('passkeyEnrollmentDates maps real driver rows to lowercase key → ISO string', async () => {
    const safeId = await seedUserSafe()
    // Mixed-case key_id: the map must be joinable case-insensitively.
    await addAccountPasskey(safeId, { keyId: '0x' + 'AB'.repeat(32), x: '0x1', y: '0x2' })

    const rows = await listAccountPasskeys(safeId)
    const dates = passkeyEnrollmentDates(rows)
    const iso = dates.get(('0x' + 'AB'.repeat(32)).toLowerCase())
    expect(iso).toBeTruthy()
    // A real ISO-8601 instant, round-trippable:
    expect(new Date(iso as string).toISOString()).toBe(iso)
  })
})
