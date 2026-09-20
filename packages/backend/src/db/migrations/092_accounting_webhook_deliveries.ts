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
 *    item; unguessable, unlike a UUID). It is a TEXT column whose uniqueness
 *    is a DB FACT: a PARTIAL unique index (PR #3196 review) over the rows
 *    that carry one — `WHERE webhook_token IS NOT NULL`, since every
 *    non-Accounted row and every disconnected row has none. (The lookup is
 *    still by provider + token in the application layer; the index turns
 *    "the capability is unique" from a convention into a constraint.)
 *
 * 3. PR #3196 review additions, in the same migration (093 is reserved for
 *    #3167 — never renumbered):
 *
 *    - `accounting_webhook_deliveries.user_id` — nullable: the connection
 *      row the capability token resolved. Without it the ledger cannot
 *      answer "whose deliveries are these" without joining through a token
 *      that a reconnect RETIRES — cheap to add while the table is born,
 *      expensive to backfill once real deliveries exist (S1).
 *
 *    - `accounting_feed_syncs.delivery_confirmed_at` — the provider-webhook
 *      confirmation timestamp on a pushed row (S2). The confirmation used to
 *      ride `error`, which is the feed's FAILURE vocabulary: the page
 *      renders `s.error ?? rowIdentity.document(id)`, so a confirmed row
 *      lost its document id the moment the confirmation landed. A real
 *      column keeps `error` an error and the confirmation queryable.
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
      user_id      TEXT,
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

    -- The capability is unique among the rows that carry one: a PARTIAL
    -- unique index, since webhook_token is NULL on every non-Accounted
    -- row (and a disconnected row) and a plain UNIQUE would silently allow
    -- only ONE such row per table (PR #3196 review). AFTER the ADD COLUMN:
    -- on a database that does not have the column yet, the index would
    -- otherwise reference it before it exists.
    CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_webhook_token_key
      ON accounting_connections (webhook_token)
      WHERE webhook_token IS NOT NULL;

    -- #3019: the webhook half can fail independently of the feed (the key
    -- validates, the subscriptions do not). The state is user-resolvable
    -- (reconnect), so it joins the needs-attention family; the type's union
    -- and this CHECK move together.
    ALTER TABLE accounting_connections DROP CONSTRAINT IF EXISTS accounting_connections_status_check;
    ALTER TABLE accounting_connections
      ADD CONSTRAINT accounting_connections_status_check
        CHECK (status IN ('connected', 'needs_reauthorisation', 'revoked_at_provider', 'scope_missing', 'needs_attention', 'disconnected'));

    -- S2 (PR #3196 review): the provider-webhook confirmation gets a real
    -- column instead of riding the failure error field.
    ALTER TABLE accounting_feed_syncs
      ADD COLUMN IF NOT EXISTS delivery_confirmed_at TIMESTAMPTZ;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE accounting_feed_syncs DROP COLUMN IF EXISTS delivery_confirmed_at;
    DROP INDEX IF EXISTS accounting_connections_webhook_token_key;
    ALTER TABLE accounting_connections DROP CONSTRAINT IF EXISTS accounting_connections_status_check;
    ALTER TABLE accounting_connections
      ADD CONSTRAINT accounting_connections_status_check
        CHECK (status IN ('connected', 'needs_reauthorisation', 'revoked_at_provider', 'scope_missing', 'disconnected'));
    ALTER TABLE accounting_connections DROP COLUMN IF EXISTS webhook_token;
    DROP TABLE IF EXISTS accounting_webhook_deliveries;
  `)
}
