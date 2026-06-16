import type { PoolClient } from 'pg'

export const version = '022_delegate_sweeps'

/**
 * Gasless delegate-sweep tracking for the EIP-3009 recovery flow.
 *
 * `POST /machine-payments/sweep/prepare` builds a `TransferWithAuthorization`
 * (delegate → Safe) and persists it here as `prepared`. `POST /sweep/submit`
 * looks the row up by its EIP-3009 nonce, re-derives every field server-side,
 * verifies the delegate signature, relays the tx, and flips the row to
 * `submitted` with the tx hash.
 *
 * The nonce is globally unique: an EIP-3009 authorization can only be consumed
 * once on-chain, so the unique index makes submit idempotent and blocks a second
 * prepare from minting a conflicting authorization for the same nonce.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS delegate_sweeps (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id         UUID NOT NULL,
      chain_id        INTEGER NOT NULL,
      token_address   VARCHAR(42) NOT NULL,
      from_address    VARCHAR(42) NOT NULL,
      to_address      VARCHAR(42) NOT NULL,
      value_atomic    NUMERIC(78, 0) NOT NULL,
      valid_after     BIGINT NOT NULL,
      valid_before    BIGINT NOT NULL,
      nonce           VARCHAR(66) NOT NULL,
      status          VARCHAR(16) NOT NULL DEFAULT 'prepared',
      tx_hash         VARCHAR(66),
      error_message   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      submitted_at    TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_delegate_sweeps_nonce
      ON delegate_sweeps(nonce);

    CREATE INDEX IF NOT EXISTS idx_delegate_sweeps_agent
      ON delegate_sweeps(agent_id, created_at DESC);
  `)
}
