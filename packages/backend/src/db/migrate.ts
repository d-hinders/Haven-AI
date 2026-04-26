import { getPool } from '../db.js'
import { migrations } from './migrations/index.js'

/**
 * Versioned migration runner.
 *
 * Each migration declares a unique `version` and an idempotent `up(client)`.
 * Applied versions are tracked in `schema_migrations`. On boot, we run any
 * migrations whose version is not yet recorded, each inside a transaction,
 * in the order defined by `migrations/index.ts`.
 */
export async function runMigrations(): Promise<void> {
  const pool = getPool()

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  const applied = await pool.query<{ version: string }>(
    `SELECT version FROM schema_migrations`,
  )
  const appliedSet = new Set(applied.rows.map((r) => r.version))

  for (const migration of migrations) {
    if (appliedSet.has(migration.version)) continue

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await migration.up(client)
      await client.query(
        `INSERT INTO schema_migrations (version) VALUES ($1)`,
        [migration.version],
      )
      await client.query('COMMIT')
      console.log(`[migrate] applied ${migration.version}`)
    } catch (err) {
      await client.query('ROLLBACK')
      throw new Error(
        `Migration ${migration.version} failed: ${(err as Error).message}`,
        { cause: err },
      )
    } finally {
      client.release()
    }
  }
}
