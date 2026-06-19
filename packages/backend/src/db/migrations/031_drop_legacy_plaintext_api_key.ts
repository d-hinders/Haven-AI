import type { PoolClient } from 'pg'

export const version = '031_drop_legacy_plaintext_api_key'

/**
 * Retire the legacy plaintext `agents.api_key` column (CASP guardrail Red Line
 * #3 — secrets at rest must be hashed, not stored raw).
 *
 * Agent secrets have long been stored as `api_key_hash` + `api_key_prefix`
 * (auth verifies `api_key_hash`; creation never writes the plaintext column —
 * the raw key is returned once and held by the user/agent runtime). The old
 * `api_key` column is unused at runtime but may still hold raw keys at rest for
 * agents created before the hash migration. Dropping it removes that residue.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agents DROP COLUMN IF EXISTS api_key;
  `)
}
