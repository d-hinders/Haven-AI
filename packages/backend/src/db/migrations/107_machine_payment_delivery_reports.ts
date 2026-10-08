import type { PoolClient } from 'pg'

/**
 * 107 — Agent-reported delivery-quality reports on settled payments (#3770).
 *
 * A settled payment's `settled: true` is an on-chain fact and never changes;
 * catalog health only ever proved PAYABILITY (a live 402 quote could be
 * fetched). When a paid call returns unusable output (the 2026-10-08
 * Soundside `create_text` run: 0.01 USDC paid, `message: ":**\n"` back),
 * there was no way for the agent to say "delivered, but unusable" — the
 * owner's receipt read as a success.
 *
 * This table is the evidence-only feedback channel: one row per
 * (payment, agent), written through `POST /machine-payments/{id}/delivery-quality`.
 * It carries NO money fields and nothing here is read by settlement — the
 * intent's `status`/`tx_hash`/amount are never touched by a report. The
 * receipt reads (`GET /receipts` rows and the signed bundle) surface it
 * beside the payment.
 *
 * `quality` is an enum at the database so a typo cannot become a fourth
 * verdict; `note` is bounded (module refuses over 2000 before the write) so
 * a diagnostic note cannot become an unbounded text store. Last write wins:
 * an agent that re-judges its delivery re-reports, replacing its own row —
 * never another agent's (the route is agent-scoped).
 */
export const version = '107_machine_payment_delivery_reports'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS machine_payment_delivery_reports (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
      agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      quality           TEXT NOT NULL CHECK (quality IN ('ok', 'unusable', 'partial')),
      note              TEXT CHECK (note IS NULL OR length(note) <= 2000),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  // One report per agent per payment — the upsert's conflict target.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_machine_payment_delivery_reports_payment_agent
      ON machine_payment_delivery_reports (payment_intent_id, agent_id)
  `)
  // Receipts read the report per (payment, agent); the unique index serves
  // the lateral join. This one serves any per-agent listing/ops read.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_machine_payment_delivery_reports_agent
      ON machine_payment_delivery_reports (agent_id, created_at DESC)
  `)
}

/** Structural down (#1139): drops exactly what this migration created. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS machine_payment_delivery_reports`)
}
