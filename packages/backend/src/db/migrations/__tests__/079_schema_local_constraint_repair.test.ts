/**
 * The property that was false for 185 worker schemas and that nothing asserted
 * (#2702): a freshly migrated schema actually HAS the constraints its
 * migrations declare.
 *
 * Four migrations guarded constraint creation with
 * `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '…')` and no
 * `connamespace` predicate. `conname` is not unique across schemas, so once
 * `public` held a name, every schema migrated afterwards skipped its own copy.
 * Measured before the fix: 185 schemas with `user_safes`, zero with
 * `user_safes_user_id_safe_address_chain_id_key` or
 * `user_safes_account_type_check`.
 *
 * This asserts the constraints EXIST rather than asserting the SQL text, on
 * purpose: the defect was invisible precisely because the migration ran, said
 * nothing, and left the schema weaker than the one it claimed to build. Only
 * the catalog can tell those apart.
 */
import { beforeAll, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, WORKER_SCHEMA } from '../../../infra/__tests__/helpers/db-harness.js'

async function constraintsOnUserSafes(): Promise<string[]> {
  const { rows } = await db.query<{ conname: string }>(
    `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1 AND c.conrelid = ($1 || '.user_safes')::regclass
      ORDER BY c.conname`,
    [WORKER_SCHEMA],
  )
  return rows.map((r) => r.conname)
}

describeDb('migrations create their constraints in THIS schema (#2702)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  it('the UNIQUE constraint 000/079 declare is present in this worker schema', async () => {
    // Missing in all 185 worker schemas on one machine before the fix, while
    // `public` had it — so a duplicate (user_id, safe_address, chain_id) that
    // production rejects was accepted by every test.
    expect(await constraintsOnUserSafes()).toContain('user_safes_user_id_safe_address_chain_id_key')
  })

  it('the account_type CHECK constraint 041/079 declare is present in this worker schema', async () => {
    expect(await constraintsOnUserSafes()).toContain('user_safes_account_type_check')
  })

  it('POSITIVE CONTROL: the query can see a constraint that was never affected', async () => {
    // Without this, a query returning [] for any reason — wrong schema, wrong
    // regclass, a typo — would fail the two assertions above and read as the
    // defect still being live. `execution_rail_check` is on the same table and
    // 041 re-adds it unconditionally, so it was present throughout.
    expect(await constraintsOnUserSafes()).toContain('user_safes_execution_rail_check')
  })

  it('the UNIQUE constraint actually REJECTS a duplicate', async () => {
    // The constraint existing in the catalog and the constraint being enforced
    // are different claims, and this issue is about a schema that looked right
    // enough to pass for months. Insert the same triple twice.
    // A REAL user row, not a synthetic uuid. Two earlier attempts failed for
    // reasons that had nothing to do with the constraint under test — a text
    // id tripped the `uuid` column type, then a free-floating uuid tripped
    // `user_safes_user_id_fkey` — and either would have read as this test
    // finding something when it had not reached the assertion at all.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`dup-2702-${process.pid}@example.test`],
    )
    const userId = rows[0].id
    const address = '0x0000000000000000000000000000000000002702'
    await db.query(
      `INSERT INTO user_safes (user_id, safe_address, chain_id) VALUES ($1, $2, $3)`,
      [userId, address, 8453],
    )
    try {
      await expect(
        db.query(`INSERT INTO user_safes (user_id, safe_address, chain_id) VALUES ($1, $2, $3)`, [
          userId,
          address,
          8453,
        ]),
      ).rejects.toMatchObject({ code: '23505' })
    } finally {
      await db.query(`DELETE FROM user_safes WHERE user_id = $1`, [userId])
      await db.query(`DELETE FROM users WHERE id = $1`, [userId])
    }
  })
})
