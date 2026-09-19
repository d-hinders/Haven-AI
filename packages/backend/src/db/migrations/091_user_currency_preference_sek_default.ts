import type { PoolClient } from 'pg'

export const version = '091_user_currency_preference_sek_default'

/**
 * The stored preference catches up to the documented default (#3127, owner
 * decision 2026-09-19).
 *
 * Every pre-existing `users.currency_preference` row carries the literal
 * `'USD'` — inherited from `000_initial.ts`'s column default, never chosen:
 * the old signup INSERT did not name the column, so no user before round 1
 * of #3127 ever wrote a preference themselves. Round 1 documented SEK as the
 * no-preference default and made it selectable, but the inherited `'USD'`
 * strings kept those users on USD figures — the documented default never
 * reached the people the documentation described.
 *
 * This migration makes the stored data agree with the document:
 *
 * - existing `'USD'` rows are set to NULL — no stored preference, so the
 *   whole read path (`transactionCurrencyOrDefault`, the preferences GET
 *   fallback) serves the documented SEK default;
 * - the column default becomes `'SEK'`, so a row created without naming the
 *   column starts on the documented default too. (`INSERT_USER_SQL` already
 *   names the column and writes `DEFAULT_TRANSACTION_CURRENCY` explicitly;
 *   the default is the belt to that suspenders.)
 *
 * The consequence is stated, not hidden: a user who explicitly clicked USD
 * in the old two-option radio silently switches to the SEK default here —
 * their stored `'USD'` is indistinguishable from the inherited one — and can
 * click USD back in the new three-option radio. That is the cost of the
 * inherited default having been indistinguishable from a chosen one; the
 * alternative was silently serving the wrong-currency figures forever.
 *
 * `down()` restores the column default but deliberately does NOT re-stamp
 * the migrated rows: the migration's product meaning is "these users have no
 * stored preference", and re-fabricating `'USD'` literals from NULL would
 * re-create the inherited-not-chosen state this migration exists to remove.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    UPDATE users
       SET currency_preference = NULL
     WHERE currency_preference = 'USD';

    ALTER TABLE users
      ALTER COLUMN currency_preference SET DEFAULT 'SEK';
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE users
      ALTER COLUMN currency_preference SET DEFAULT 'USD';
  `)
}
