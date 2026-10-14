import type { PoolClient } from 'pg'

export const version = '113_sync_document_kind'

/**
 * #3918: the sync ledger grows a per-row DOCUMENT KIND.
 *
 * Since #3016 the ledger is keyed uniquely on `(provider, payment_id,
 * user_id)` — "one upload is one file, one ref per row". The Accounted
 * underlag now has a SECOND document to deliver: the merchant's own invoice
 * (#3918), which is its own WORM upload with its own provider id. The
 * minimal safe shape (owner note on the issue) is a SECOND sync row for the
 * same payment, not a schema of embedded arrays: the row is the dedup and
 * retry unit, and a second row reuses every invariant the ledger already
 * enforces (pushed is final, first write wins).
 *
 * So the unique key becomes `(provider, payment_id, user_id, document_kind)`
 * and every row carries `document_kind` — `'underlag'` by default, so all
 * pre-existing rows and every existing statement keep their meaning
 * unchanged. The repository scopes the ledger's generic statements
 * (`claimSync`, `markPushed`, the sweep and backfill selections, the
 * badge/verify reads) to `document_kind = 'underlag'`, so a merchant-invoice
 * row is invisible to the machinery that would otherwise re-claim or
 * rewrite it; only its own writer touches it.
 *
 * Why no CHECK constraint on the kind: the value is written from exactly
 * one repository constant (`MERCHANT_INVOICE_SYNC_KIND` in
 * `infra/repositories/accounting-feed-syncs.ts`), and a CHECK would turn
 * every future kind into a migration. The unique key is the invariant; the
 * value set is code's to keep honest.
 *
 * The old constraint's name is what Postgres generated when 033 created the
 * table as `reporting_feed_syncs` — the 080 RENAME renamed the table, not
 * its constraints — verified live against a migrated database before this
 * shipped. Both edits are guarded DO blocks (the #2702 rule: anchored on
 * `conrelid`, never an unscoped name lookup), so the migration is
 * idempotent and a fresh schema and a repaired schema converge.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE accounting_feed_syncs
      ADD COLUMN IF NOT EXISTS document_kind TEXT NOT NULL DEFAULT 'underlag';

    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conname = 'reporting_feed_syncs_provider_payment_id_user_id_key'
          AND c.conrelid = 'accounting_feed_syncs'::regclass
      ) THEN
        ALTER TABLE accounting_feed_syncs
          DROP CONSTRAINT reporting_feed_syncs_provider_payment_id_user_id_key;
      END IF;
    END $$;

    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conname = 'accounting_feed_syncs_provider_payment_id_document_kind_key'
          AND c.conrelid = 'accounting_feed_syncs'::regclass
      ) THEN
        ALTER TABLE accounting_feed_syncs
          ADD CONSTRAINT accounting_feed_syncs_provider_payment_id_document_kind_key
          UNIQUE (provider, payment_id, user_id, document_kind);
      END IF;
    END $$;
  `)
}

/**
 * Restore the exact 033 shape. Merchant-invoice rows cannot survive the old
 * three-column key (two rows would collide on `(provider, payment_id,
 * user_id)`), so they are deleted first — they are delivery records for a
 * feature this rollback removes, not data to preserve.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    DELETE FROM accounting_feed_syncs WHERE document_kind <> 'underlag';

    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conname = 'accounting_feed_syncs_provider_payment_id_document_kind_key'
          AND c.conrelid = 'accounting_feed_syncs'::regclass
      ) THEN
        ALTER TABLE accounting_feed_syncs
          DROP CONSTRAINT accounting_feed_syncs_provider_payment_id_document_kind_key;
      END IF;
    END $$;

    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conname = 'reporting_feed_syncs_provider_payment_id_user_id_key'
          AND c.conrelid = 'accounting_feed_syncs'::regclass
      ) THEN
        ALTER TABLE accounting_feed_syncs
          ADD CONSTRAINT reporting_feed_syncs_provider_payment_id_user_id_key
          UNIQUE (provider, payment_id, user_id);
      END IF;
    END $$;

    ALTER TABLE accounting_feed_syncs DROP COLUMN IF EXISTS document_kind;
  `)
}
