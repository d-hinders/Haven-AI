import type { PoolClient } from 'pg'

export const version = '020_send_idempotency_key'

/**
 * Idempotency support for POST /machine-payments/send.
 *
 * The endpoint's OpenAPI contract advertises an optional `idempotency_key` that
 * deduplicates retried requests, but nothing persisted it. A retried send (e.g.
 * after a network timeout) would mint a second payment intent — or a second
 * pending approval — and hand the agent a different hash to sign.
 *
 * A send resolves to one of two rows depending on the remaining on-chain
 * allowance, so the key lives on both tables. The partial unique indexes mirror
 * the existing machine-payment idempotency indexes (010/012): scoped per agent,
 * and excluding terminal rows so a key can be reused once the original request
 * has failed/expired/been rejected.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS send_idempotency_key VARCHAR(128);

    ALTER TABLE approval_requests
      ADD COLUMN IF NOT EXISTS send_idempotency_key VARCHAR(128);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_send_idempotency
      ON payment_intents(agent_id, send_idempotency_key)
      WHERE send_idempotency_key IS NOT NULL
        AND status NOT IN ('failed', 'expired');

    CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_send_idempotency
      ON approval_requests(agent_id, send_idempotency_key)
      WHERE send_idempotency_key IS NOT NULL
        AND status NOT IN ('rejected', 'expired');
  `)
}
