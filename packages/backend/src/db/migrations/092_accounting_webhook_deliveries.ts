import type { PoolClient } from 'pg'

/**
 * 092 — the Accounted webhook receiving side (#3019, epic #3016 slice 3).
 *
 * Two things land here, and the split is deliberate:
 *
 * 1. `accounting_webhook_deliveries` — the durable dedupe table. Accounted
 *    delivers at-least-once (retries at 1m/5m/30m/2h/12h/24h/48h, ~87 h), so
 *    the same envelope `id` WILL arrive more than once — across retries, and
 *    across a backend restart (an in-memory set would reset exactly when a
 *    retry storm is likeliest). The row is written BEFORE the 2xx answer and
 *    processing is inline: after a 2xx Accounted stops retrying, so nothing
 *    may be deferred past the answer. The table, not a column on the
 *    connection, because `period.locked` maps to no payment and the row's
 *    identity is the delivery, not the connection.
 *
 *    `(provider, delivery_id)` is the dedupe key, not `delivery_id` alone:
 *    the envelope id is the PROVIDER's identifier (`X-Gnubok-Delivery`,
 *    echoed in the body's `id`), and a second provider could reuse a UUID.
 *    `event_type`, `api_version` (`X-Gnubok-Api-Version`) and `request_id`
 *    (`X-Request-Id`) are recorded for the ops trail. `payload` is nullable
 *    JSONB: only a redacted `journal_entry.committed` object is stored (the
 *    probe's raw material, #3019 item 5), every other event type counts
 *    without a stored body.
 *
 * 2. `accounting_connections.webhook_token` — the capability-URL token. One
 *    callback route per connection (`POST /accounting/webhooks/accounted/
 *    <token>`), so the secret lookup is direct and the route never guesses
 *    the company from the payload. The token is 32 random bytes base64url
 *    (256 bits — stated for the reviewer trap list's identifier-entropy
 *    item; unguessable, unlike a UUID). It is a TEXT column with a
 *    uniqueness check in the application layer (the lookup is by provider +
 *    token), because the capability is per (provider, token), not per table.
 *
 * Schema-only: no rows exist anywhere (the feature ships dark behind
 * `HAVEN_ACCOUNTING_ENABLED` and only dev connects Accounted), so there is
 * nothing to backfill and the migration reads no environment — the same
 * posture migration 080 states. `down()` drops exactly what `up()` created.
 */
export const version = '092_accounting_webhook_deliveries'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS accounting_webhook_deliveries (
      id           BIGSERIAL PRIMARY KEY,
      provider     TEXT NOT NULL,
      delivery_id  TEXT NOT NULL,
      event_type   TEXT,
      api_version  TEXT,
      request_id   TEXT,
      payload      JSONB,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      CONSTRAINT accounting_webhook_deliveries_provider_delivery_key
        UNIQUE (provider, delivery_id)
    );

    CREATE INDEX IF NOT EXISTS idx_accounting_webhook_deliveries_received
      ON accounting_webhook_deliveries(provider, received_at DESC);

    ALTER TABLE accounting_connections
      ADD COLUMN IF NOT EXISTS webhook_token TEXT;

    -- #3019: the webhook half can fail independently of the feed (the key
    -- validates, the subscriptions do not). The state is user-resolvable
    -- (reconnect), so it joins the needs-attention family; the type's union
    -- and this CHECK move together.
    ALTER TABLE accounting_connections DROP CONSTRAINT IF EXISTS accounting_connections_status_check;
    ALTER TABLE accounting_connections
      ADD CONSTRAINT accounting_connections_status_check
        CHECK (status IN ('connected', 'needs_reauthorisation', 'revoked_at_provider', 'scope_missing', 'needs_attention', 'disconnected'));
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE accounting_connections DROP CONSTRAINT IF EXISTS accounting_connections_status_check;
    ALTER TABLE accounting_connections
      ADD CONSTRAINT accounting_connections_status_check
        CHECK (status IN ('connected', 'needs_reauthorisation', 'revoked_at_provider', 'scope_missing', 'disconnected'));
    ALTER TABLE accounting_connections DROP COLUMN IF EXISTS webhook_token;
    DROP TABLE IF EXISTS accounting_webhook_deliveries;
  `)
}
