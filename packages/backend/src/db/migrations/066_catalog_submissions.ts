import type { PoolClient } from 'pg'

export const version = '066_catalog_submissions'

/**
 * Self-service catalogue submission queue (epic #1717, #1711).
 *
 * Holds ONLY the pointer + verification state for merchant-submitted payable
 * (x402/MCP) endpoints. It is deliberately pointer-shaped: the URL plus a
 * normalized hostname and minimal submitter metadata, never 402 bodies or
 * probe history (those stay at the merchant's endpoint; storage stays small).
 *
 * Status progression (filled in by later slices):
 *   submitted        → row written by POST /catalog/submit; nothing else yet
 *   ownership_verified → the seller served the .well-known proof token (#1712)
 *   verified_payable → the leader-locked probe watched a real x402 quote (#1713)
 *   failed           → ownership proof or probe could not be satisfied
 *   delisted         → operator action, or lifecycle expiry (#1714)
 *
 * The partial unique index is the anti-spam core of the whole ingestion
 * pipeline: one pending/active submission per hostname, where "pending/active"
 * is exactly the non-terminal status set. That index makes the route's
 * dedupe a database guarantee (`ON CONFLICT (hostname) WHERE status IN (...)`),
 * not a check-then-act race — two concurrent first-time submits of the same
 * host cannot create two queue rows.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS catalog_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hostname TEXT NOT NULL,
      resource_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted', 'ownership_verified', 'verified_payable', 'failed', 'delisted')),
      submitter_ip TEXT NOT NULL,
      verify_token TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_submissions_pending_host
      ON catalog_submissions(hostname)
      WHERE status IN ('submitted', 'ownership_verified', 'verified_payable');

    CREATE INDEX IF NOT EXISTS idx_catalog_submissions_status_created
      ON catalog_submissions(status, created_at);
  `)
}

/** Structural down (#1139): the table is entirely additive infra — no data survives. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS catalog_submissions;
  `)
}
