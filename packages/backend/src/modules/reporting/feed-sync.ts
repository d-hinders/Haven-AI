/**
 * Idempotency / dedup ledger for the reporting feed (epic #491, P1 #497).
 *
 * Persists what's been fed to which provider so re-syncs, backfills, and retries
 * never double-post into the customer's ledger — duplicate entries are the
 * fastest way to lose trust. Keyed uniquely on (provider, payment_id, user_id).
 *
 * The data access moved VERBATIM into
 * `infra/repositories/reporting-feed-syncs.ts` (#999, `pg-only-in-infra`);
 * this module keeps the reporting-facing surface and re-exports it so
 * callers and the module barrel are unchanged.
 */
export {
  claimSync,
  markPushed,
  markFailed,
  getSyncState,
  listSyncs,
  type SyncStatus,
  type FeedSyncRow,
  type ClaimResult,
} from '../../infra/repositories/reporting-feed-syncs.js'
