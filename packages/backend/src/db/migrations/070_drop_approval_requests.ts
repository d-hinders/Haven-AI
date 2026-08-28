import type { PoolClient } from 'pg'

export const version = '070_drop_approval_requests'

/**
 * Drop `approval_requests` — the AllowanceModule rail's queued-payment store
 * (epic #1440, #2055; owner decision recorded on #2021: queue-history
 * readability for legacy accounts is waived, so the table goes).
 *
 * By the time this runs, nothing reads or writes the table: #1986 closed the
 * actionable transitions, #1984/#1987 killed every insert path, and #2055's
 * code half deleted `routes/approvals.ts` and re-anchored or removed every
 * remaining reader (transaction history, dashboard aggregates, agent-activity
 * counter, machine-payment evidence lookups, agent payment status fallback).
 *
 * ⚠️ FK HAZARD — DO NOT `DELETE FROM approval_requests` FIRST (#2021).
 * `machine_payment_evidence.approval_request_id` is `ON DELETE CASCADE`
 * (migration 018): deleting rows before the drop silently destroys
 * proof-of-payment evidence. `DROP TABLE ... CASCADE` is the safe form — it
 * drops the dependent FK CONSTRAINTS (on `machine_payment_evidence` and
 * `machine_payment_reconciliation_events`), never the child ROWS. Evidence
 * and reconciliation rows survive with their `approval_request_id` columns
 * intact as plain historical UUIDs.
 *
 * Rollback: `down()` restores the SCHEMA exactly as the harness DB reported
 * it pre-drop (migrations 000+005+011+012+018+020 combined shape, read from
 * information_schema on 2026-08-25) so the migration is structurally
 * reversible. DATA is not restored — this is retirement, not migration. The
 * FK constraints from migration 018 are also NOT restored by down(): the
 * columns they governed survive the drop as plain UUIDs, and re-adding a
 * CASCADE onto historical evidence would recreate the hazard this header
 * warns about.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS approval_requests CASCADE;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id                UUID NOT NULL REFERENCES agents(id),
      user_id                 UUID NOT NULL REFERENCES users(id),
      safe_address            VARCHAR(42) NOT NULL,
      token_symbol            VARCHAR(20) NOT NULL,
      token_address           VARCHAR(42) NOT NULL,
      to_address              VARCHAR(42) NOT NULL,
      amount_raw              VARCHAR(78) NOT NULL,
      amount_human            VARCHAR(78) NOT NULL,
      reason                  TEXT,
      status                  VARCHAR(20) NOT NULL DEFAULT 'pending',
      tx_hash                 VARCHAR(66),
      reviewed_at             TIMESTAMPTZ,
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      expires_at              TIMESTAMPTZ NOT NULL,
      chain_id                INTEGER NOT NULL DEFAULT 8453,
      usd_value               NUMERIC,
      eur_value               NUMERIC,
      executed_at             TIMESTAMPTZ,
      source                  VARCHAR(20) NOT NULL DEFAULT 'direct',
      x402_resource_url       TEXT,
      payment_rail            VARCHAR(32),
      payment_resource_url    TEXT,
      merchant_address        VARCHAR(42),
      machine_challenge_id    VARCHAR(128),
      machine_idempotency_key VARCHAR(128),
      machine_metadata        JSONB,
      send_idempotency_key    VARCHAR(128)
    );

    CREATE INDEX IF NOT EXISTS idx_approval_requests_user_status
      ON approval_requests(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_approval_requests_agent_id
      ON approval_requests(agent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_machine_idempotency
      ON approval_requests(agent_id, machine_idempotency_key)
      WHERE machine_idempotency_key IS NOT NULL AND status <> 'expired';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_send_idempotency
      ON approval_requests(agent_id, send_idempotency_key)
      WHERE send_idempotency_key IS NOT NULL AND status NOT IN ('rejected', 'expired');
  `)
}
