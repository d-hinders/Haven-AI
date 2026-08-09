import type { PoolClient } from 'pg'

export const version = '056_multi_passkey_per_chain'

/**
 * Let a user hold more than one passkey per chain (#1229, fix 3).
 *
 * `006_user_passkeys` declared `UNIQUE (user_id, chain_id)` when a user had
 * exactly one passkey by construction: onboarding enrolled it, and it became
 * the sole owner (threshold 1) of the deployed Safe. That made the constraint
 * look like a harmless de-dupe. It was in fact the thing that removed the only
 * recovery path this rail has.
 *
 * A passkey Safe's ONLY recovery is preventive: add a second owner while the
 * first passkey still works. Adding a second *passkey* owner is exactly what
 * `provisionPasskeyApprover` does — enrol, then `addOwnerWithThreshold` — and
 * it could never succeed, because the enrol half hit this constraint and 409'd
 * for every user who had onboarded with a passkey. The population blocked from
 * adding a backup was precisely the population that needed one. (Adding an EOA
 * approver was unaffected, and remains the other backup option.)
 *
 * `UNIQUE (credential_id)` stays: one WebAuthn credential must map to one row,
 * globally, or the exec path could not resolve a signer from an assertion.
 *
 * The index replaces the constraint's implicit one — every read of this table
 * is either by credential or by (user, chain).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE user_passkeys DROP CONSTRAINT IF EXISTS user_passkeys_user_id_chain_id_key;

    CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_id_chain_id
      ON user_passkeys(user_id, chain_id);
  `)
}

/**
 * Deliberately NOT a re-ADD of the unique constraint. Once a user has enrolled
 * a backup, restoring it would fail on live data — and "fail on live data" is
 * the worst shape a down migration can have. This drops the index it added and
 * leaves the widened key space in place; the capability rollback is the route
 * code refusing to enrol a second passkey, not the schema.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query('DROP INDEX IF EXISTS idx_user_passkeys_user_id_chain_id')
}
