import type { PoolClient } from 'pg'

export const version = '048_agent_passports'

/**
 * L0 Agent Passport issuance state (#972, epic #970).
 *
 * A passport is **opt-in** (owner decision 2026-07-24): creating an agent does
 * NOT issue one. Absence of a row is therefore the normal case and means
 * exactly "this agent has no passport" — never "issuance failed".
 *
 * The EAS write is async, best-effort and retryable: a failed or slow
 * attestation must never fail or block agent creation (v6 review point 2, the
 * same discipline as the reporting feed never blocking settlement). This table
 * is what makes that possible — it holds the state machine so a fire-and-forget
 * write is still observable and resumable:
 *
 *   pending  → requested, not yet anchored (also the state after a crash)
 *   anchored → on-chain, `attestation_uid` set
 *   failed   → last attempt failed; `last_error` says why, retry is allowed
 *
 * One row per agent: the passport binds a treasury and a chain that belong to
 * the agent, so a second passport for the same agent would be a contradiction
 * rather than a second credential.
 *
 * Additive and non-destructive: no existing table is touched, and an agent with
 * no row behaves exactly as it does today.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_passports (
      agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      chain_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      assurance_level SMALLINT NOT NULL DEFAULT 0,
      attestation_uid TEXT,
      tx_hash TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      -- Atomic anchoring claim. Two callers can legitimately race (creation
      -- opt-in vs the route vs the retry sweep); without a claim BOTH would see
      -- 'pending', both submit attest(), and the relayer pays twice for two real
      -- on-chain attestations of which we could only ever track one. Stale
      -- claims expire so a crashed attempt is recoverable. Same discipline as
      -- reporting's claimSync.
      anchoring_started_at TIMESTAMPTZ,
      last_error TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      anchored_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT agent_passport_status_valid
        CHECK (status IN ('pending', 'anchored', 'failed')),
      -- An anchored passport MUST carry its UID: "anchored" is the claim a
      -- verifier acts on, and one without a UID is unverifiable — a state we
      -- would rather make unrepresentable than defend in every reader.
      CONSTRAINT agent_passport_anchored_has_uid
        CHECK (status <> 'anchored' OR attestation_uid IS NOT NULL),
      -- L0 only for now; the ladder (#975) widens this deliberately, not by drift.
      CONSTRAINT agent_passport_level_issuable
        CHECK (assurance_level = 0)
    );
  `)

  // Retry sweeps look up by state, not by agent.
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_passports_status_idx
      ON agent_passports (status)
      WHERE status <> 'anchored';
  `)

  // The verifier (#974) resolves a passport BY attestation UID.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_passports_uid_idx
      ON agent_passports (attestation_uid)
      WHERE attestation_uid IS NOT NULL;
  `)
}
