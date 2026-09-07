import type { PoolClient } from 'pg'

export const version = '078_device_authorizations'

/**
 * Device-authorization grants for the CLI login (#2526, C1 of epic #2519).
 *
 * Every owner action needs the owner JWT, and the only way to get one was
 * email + password — which an agent must never hold. This table backs the
 * OAuth-style device flow that lets an agent ask its human to approve a CLI
 * session in a browser instead.
 *
 * Numbered 078 rather than 077 deliberately: #2528's `setup_run_mode` claimed
 * 077 in an open PR. A gap is harmless (the runner applies the registry in
 * array order), while two migrations sharing a number is not.
 *
 * ## What is stored, and what is not
 *
 * Both codes are stored as SHA-256 HASHES, never in the clear. The device code
 * is a bearer credential — whoever holds it collects the session token — and
 * the user code is typed by a human into a page, so a leaked database row must
 * not let anyone complete somebody else's login. This mirrors how setup tokens
 * and API keys are already handled (`setup_token_hash`, `api_key_hash`).
 *
 * `user_id` is NULL until a human approves. That nullability IS the state
 * machine's honesty: an unapproved row is not attached to anyone, so a pending
 * code cannot be mistaken for a grant.
 *
 * `client_label` is what the CLI calls itself, shown on the approval screen so
 * the human knows what they are approving. Free text from an unauthenticated
 * caller, so the route bounds and sanitises it; the column does not trust it.
 *
 * Rows are short-lived (10 minutes) and purged after expiry — see the
 * repository's `purgeExpired`. Nothing here is an audit record: an approval
 * that mattered is visible as a session, and keeping spent codes would be
 * keeping credentials nobody needs.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS device_authorizations (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_code_hash   TEXT NOT NULL UNIQUE,
      device_code_hash TEXT NOT NULL UNIQUE,
      user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
      status           TEXT NOT NULL DEFAULT 'pending',
      client_label     TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at       TIMESTAMPTZ NOT NULL,
      approved_at      TIMESTAMPTZ,
      CONSTRAINT device_authorizations_status_check
        CHECK (status IN ('pending', 'approved', 'denied', 'redeemed')),
      -- An approved row must name who approved it, and a pending row must not.
      -- Stated as a constraint rather than as a convention, because "the
      -- route always sets both" is exactly the kind of promise that decays.
      CONSTRAINT device_authorizations_approved_has_user
        CHECK ((status IN ('approved', 'redeemed')) = (user_id IS NOT NULL AND approved_at IS NOT NULL))
    );
  `)
  // The poll path looks a row up by device code on every interval, and the
  // approve path by user code exactly once. Both are unique already; this
  // index serves the expiry purge.
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_authorizations_expires_at_idx
      ON device_authorizations (expires_at);
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS device_authorizations;`)
}
