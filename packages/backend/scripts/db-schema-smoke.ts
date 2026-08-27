/**
 * Real-Postgres schema smoke (#773). Runs against a throwaway database:
 *   1. apply every migration from scratch, then
 *   2. PREPARE each curated money-path query — Postgres parses, resolves every
 *      column/table, and type-checks the parameters WITHOUT any rows. A query
 *      that references a non-existent column fails here.
 *
 * This is the SQL counterpart to the env-drift test: mocked route tests never
 * validate SQL against the real schema, so `agents.safe_address` (a join on a
 * column that does not exist) reached dev and 500ed every session payment
 * (#757). PREPARE would have caught it in CI.
 *
 * The list is deliberately EXPLICIT and small — the money-path queries whose
 * schema drift would be most damaging. Add a query here when a new money-path
 * query is introduced; this is a guard, not an exhaustive mirror of every SELECT.
 *
 * Prefer IMPORTING the query over pasting it. A pasted copy only proves the
 * copy still matches the schema, and drifts from production the first time
 * someone edits the real one — which is the failure this script exists to
 * catch, reproduced inside the check itself. The passport revocation queries
 * are imported for exactly that reason.
 *
 * Run (needs DATABASE_URL): npm run db:schema-smoke -w @haven/backend
 */

import { getPool } from '../src/db.js'
import { selectDelegation } from '../src/rails/delegation-authorization.js'
import { runMigrations } from '../src/db/migrate.js'
import { SELECT_DELEGATION_FOR_PAYMENT_SQL } from '../src/infra/repositories/delegation-budgets.js'
import { LIST_ACCOUNT_PASSKEYS_SQL } from '../src/infra/repositories/hybrid-signers.js'
import { INSERT_AGENT_TOOL_INVOCATION_SQL } from '../src/infra/repositories/agent-tool-invocations.js'
import {
  CLAIM_NEXT_OUTBOUND_TX_SQL,
  CLAIM_ORPHANED_OUTBOUND_TX_SQL,
  COUNT_LANE_ATTEMPTS_AT_NONCE_SQL,
  ENQUEUE_OUTBOUND_TX_SQL,
  LIST_UNMINED_OUTBOUND_TXS_SQL,
  MARK_OUTBOUND_TX_BROADCAST_SQL,
  MARK_OUTBOUND_TX_FAILED_SQL,
  MARK_OUTBOUND_TX_MINED_SQL,
  MARK_OUTBOUND_TX_REPLACED_SQL,
} from '../src/infra/repositories/outbound-txs.js'
import {
  GET_RECORDED_FEE_SQL,
  INSERT_PAYMENT_FEE_SQL,
} from '../src/infra/repositories/payment-fees.js'
import {
  DELETE_FORTNOX_CONNECTION_SQL,
  GET_FORTNOX_CONNECTION_SQL,
  UPSERT_FORTNOX_CONNECTION_SQL,
} from '../src/infra/repositories/fortnox-connections.js'
import {
  CLAIM_SYNC_INSERT_SQL,
  CLAIM_SYNC_RECLAIM_FAILED_SQL,
  GET_SYNC_STATE_SQL,
  LIST_SYNCS_FOR_USER_SQL,
  LIST_UNPUSHED_PAYMENT_IDS_SQL,
  MARK_SYNC_FAILED_SQL,
  MARK_SYNC_PUSHED_SQL,
} from '../src/infra/repositories/reporting-feed-syncs.js'
import {
  FIND_PASSKEY_FOR_SAFE_SQL,
  INSERT_USER_PASSKEY_SQL,
  LIST_USER_PASSKEYS_SQL,
} from '../src/infra/repositories/user-passkeys.js'
import {
  DELETE_CONTACT_FOR_USER_SQL,
  INSERT_CONTACT_SQL,
  LIST_CONTACTS_FOR_USER_SQL,
  RENAME_CONTACT_FOR_USER_SQL,
} from '../src/infra/repositories/contacts.js'
import {
  CLAIM_REANCHOR_REVOCATION_SQL,
  CLAIM_REVOCATION_SQL,
  FIND_BY_AGENT_ADDRESS_SQL,
  FIND_BY_ATTESTATION_UID_SQL,
  LIST_REANCHORS_DUE_SQL,
  LIST_REVOCATIONS_DUE_SQL,
  LIST_STUCK_REANCHORS_SQL,
  LIST_STUCK_REVOCATIONS_SQL,
  RESET_FOR_REANCHOR_SQL,
} from '../src/infra/repositories/agent-passports.js'
import {
  CANCEL_SETUP_SQL,
  FIND_ACTIVE_AGENT_BY_DELEGATE_SQL,
  FIND_DEFAULT_USER_SAFE_SQL,
  ACTIVATE_AGENT_SQL,
  FIND_AGENT_STATUS_SQL,
  FIND_SETUP_BY_AGENT_API_KEY_SQL,
  FIND_SETUP_BY_ID_AND_TOKEN_HASH_SQL,
  FIND_SETUP_BY_TOKEN_HASH_SQL,
  FIND_SETUP_FOR_USER_SQL,
  FIND_USER_SAFE_BY_ID_SQL,
  INSERT_AGENT_SQL,
  INSERT_SETUP_ALLOWANCE_SQL,
  INSERT_SETUP_SQL,
  LIST_ACTIVE_DELEGATIONS_SQL,
  LIST_SETUP_ALLOWANCES_SQL,
  LOCK_SETUP_BY_TOKEN_HASH_SQL,
  LOCK_SETUP_FOR_USER_SQL,
  MARK_SETUP_REGISTERED_SQL,
  MERGE_INSTALL_STATUS_SQL,
  REVOKE_PENDING_AGENT_SQL,
  UPDATE_APPROVAL_STATE_SQL,
  UPDATE_CONNECTOR_METADATA_SQL,
} from '../src/infra/repositories/agent-connection-setups.js'
import {
  AGENT_HAS_LIVE_DELEGATIONS_SQL,
  ARCHIVE_AGENT_SQL,
  UNARCHIVE_AGENT_SQL,
  FIND_AGENT_FOR_USER_ALL_STATUSES_SQL,
  FIND_AGENT_ID_FOR_USER_SQL,
  FIND_AGENT_ID_STATUS_FOR_USER_SQL,
  FIND_DEFAULT_USER_SAFE_ID_SQL,
  FIND_DELEGATE_AGENT_FOR_USER_SQL,
  FIND_NON_REVOKED_AGENT_BY_DELEGATE_SQL,
  FIND_SAFE_INFO_SQL,
  FIND_USER_SAFE_ID_FOR_USER_SQL,
  INSERT_AGENT_WITH_KEY_SQL,
  LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL,
  PAUSE_AGENT_SQL,
  RESUME_AGENT_SQL,
  REVOKE_AGENT_SQL,
  ROTATE_AGENT_API_KEY_SQL,
  UPDATE_AGENT_PROFILE_SQL,
} from '../src/infra/repositories/agents.js'
import {
  FIND_AGENT_DELEGATE_ADDRESS_SQL,
  AGENT_BY_API_KEY_SQL,
  TOUCH_AGENT_LAST_SEEN_SQL,
} from '../src/infra/repositories/agents.js'
import {
  LIST_AGENTS_WITH_FRESH_PENDING_INTENTS_SQL,
  LIST_MONITORED_DELEGATES_SQL,
} from '../src/infra/repositories/delegate-monitoring.js'
import {
  CLAIM_INTENT_FOR_SUBMISSION_SQL,
  CONFIRM_MACHINE_INTENT_SQL,
  CONFIRM_SUBMITTED_INTENT_SQL,
  EXPIRE_OVERDUE_INTENT_BY_ID_SQL,
  EXPIRE_OVERDUE_INTENT_RETURNING_STATUS_SQL,
  EXPIRE_OVERDUE_INTENTS_FOR_AGENT_SQL,
  EXPIRE_PENDING_INTENT_RETURNING_STATUS_SQL,
  EXPIRE_PENDING_INTENT_SQL,
  FAIL_MACHINE_INTENT_SQL,
  FAIL_SUBMITTED_INTENT_SQL,
  FIND_INTENT_FOR_AGENT_SQL,
  FIND_INTENT_STATUS_ROW_SQL,
  FIND_MACHINE_INTENT_BY_KEY_OR_CHALLENGE_SQL,
  FIND_SEND_INTENT_BY_KEY_SQL,
  FIND_SETTLED_PAYMENT_RECEIPT_SQL,
  GET_INTENT_STATUS_SQL,
  INSERT_DELEGATION_INTENT_SQL,
  INSERT_LEGACY_INTENT_SQL,
  INSERT_MACHINE_INTENT_MACHINE_KEY_SQL,
  INSERT_MACHINE_INTENT_X402_KEY_SQL,
  INSERT_SEND_INTENT_SQL,
  LIST_INTENTS_FOR_AGENT_SQL,
  RECORD_MACHINE_INTENT_SIGNATURE_SQL,
  REFRESH_MACHINE_INTENT_NONCE_SQL,
  RELEASE_SUBMITTED_CLAIM_SQL,
} from '../src/infra/repositories/payment-intents.js'
import {
  CONFIRM_X402_INTENT_SQL,
  COUNT_RECENT_X402_INTENTS_SQL,
  FAIL_X402_INTENT_SQL,
  FIND_ACTIVE_X402_INTENT_BY_KEY_SQL,
  FIND_SETTLE_INTENT_SQL,
  FIND_X402_INTENT_BY_KEY_SQL,
  GET_MAX_X402_PER_HOUR_SQL,
  MARK_INTENT_SUBMITTED_FOR_SETTLEMENT_SQL,
  RECORD_X402_SIGNATURE_SQL,
  REFRESH_STALE_X402_INTENT_SQL,
} from '../src/infra/repositories/x402-authorizations.js'
import {
  ATTACH_EVIDENCE_FOR_APPROVAL_SQL,
  ATTACH_EVIDENCE_FOR_INTENT_SQL,
  CLAIM_PREPARED_SWEEP_SQL,
  EXPIRE_PREPARED_SWEEP_SQL,
  FIND_EVIDENCE_ANCHOR_FOR_AGENT_SQL,
  FIND_INTENT_EVIDENCE_SOURCE_SQL,
  FIND_INTENT_FOR_EVIDENCE_SQL,
  FIND_RECONCILIATION_EVENT_FOR_APPROVAL_SQL,
  FIND_RECONCILIATION_EVENT_FOR_INTENT_SQL,
  FIND_RECONCILIATION_INTENT_SQL,
  FIND_SWEEP_BY_ID_SQL,
  FIND_SWEEP_BY_NONCE_SQL,
  GET_INTENT_SETTLEMENT_FIELDS_SQL,
  GET_MERCHANT_RECEIPT_SQL,
  INSERT_MERCHANT_RECEIPT_SQL,
  INSERT_PREPARED_SWEEP_SQL,
  INSERT_RESIDUE_EVENT_SQL,
  LIST_EVIDENCE_RECEIPTS_SQL,
  MARK_SWEEP_FAILED_SQL,
  MARK_SWEEP_SUBMITTED_SQL,
  RELEASE_SWEEP_CLAIM_SQL,
  RESOLVE_RECONCILIATION_FOR_APPROVAL_SQL,
  RESOLVE_RECONCILIATION_FOR_INTENT_SQL,
  RESOLVE_STRANDED_EVENTS_FOR_AGENT_SQL,
  UPSERT_EVIDENCE_BASE_FOR_APPROVAL_SQL,
  UPSERT_EVIDENCE_BASE_FOR_INTENT_SQL,
  UPSERT_RECONCILIATION_EVENT_FOR_APPROVAL_SQL,
  UPSERT_RECONCILIATION_EVENT_FOR_INTENT_SQL,
  LOAD_RECEIPT_UNDERLAG_SOURCE_SQL,
} from '../src/infra/repositories/machine-payments.js'
import {
  GRANT_ENTITLEMENT_SQL,
  HAS_ENTITLEMENT_SQL,
  REVOKE_ENTITLEMENT_SQL,
} from '../src/infra/repositories/account-entitlements.js'
import {
  CLEAR_DEFAULT_SAFES_FOR_USER_SQL,
  CLEAR_LEGACY_USER_SAFE_ADDRESS_SQL,
  DELETE_USER_SAFE_SQL,
  FIND_OLDEST_SAFE_FOR_USER_SQL,
  FIND_OWNED_SAFE_ADDRESS_SQL,
  FIND_OWNED_SAFE_DEFAULT_FLAG_SQL,
  LIST_SAFES_FOR_USER_SQL,
  LIST_SAFES_WITH_ACCOUNT_TYPE_FOR_USER_SQL,
  ORPHAN_AGENTS_FOR_SAFE_SQL,
  ORPHAN_SELF_SIGN_AGENTS_FOR_SAFE_SQL,
  PROMOTE_SAFE_TO_DEFAULT_SQL,
  RENAME_SAFE_FOR_USER_SQL,
  SET_LEGACY_USER_SAFE_ADDRESS_SQL,
  SET_SAFE_DEFAULT_SQL,
  FIND_HYBRID_OWNER_SAFE_ROW_SQL,
  FIND_OWNED_SAFE_WITH_TYPE_ANY_CHAIN_SQL,
  FIND_OWNED_SAFE_WITH_TYPE_FOR_CHAIN_SQL,
  FIND_EXECUTION_RAIL_FOR_AGENT_SQL,
  LIST_SESSION_SAFES_FOR_USER_SQL,
} from '../src/infra/repositories/user-safes.js'
import {
  FIND_CONFIRMED_X402_PAYMENT_INTENTS_SQL,
  FIND_DELEGATE_SWEEP_AGENT_MATCHES_SQL,
  FIND_MACHINE_PAYMENT_EVIDENCE_DETAIL_SQL,
  FIND_PAYMENT_INTENT_AGENT_MATCHES_SQL,
  FIND_SAFE_OWNERSHIP_ANY_CHAIN_SQL,
  FIND_SAFE_OWNERSHIP_FOR_CHAIN_SQL,
  LIST_AGENTS_FOR_TRANSACTION_FILTERS_SQL,
  LIST_BASIC_SAFES_FOR_USER_SQL,
} from '../src/infra/repositories/transaction-history.js'
import {
  COUNT_PENDING_CATALOG_SUBMISSIONS_SQL,
  FIND_PENDING_CATALOG_SUBMISSION_BY_HOST_SQL,
  INSERT_CATALOG_SUBMISSION_SQL,
  LIST_SUBMITTED_CATALOG_SUBMISSIONS_SQL,
  LIST_OWNERSHIP_VERIFIED_CATALOG_SUBMISSIONS_SQL,
  LIST_VERIFIED_CATALOG_SUBMISSIONS_DUE_SQL,
  MARK_CATALOG_SUBMISSION_OWNERSHIP_VERIFIED_SQL,
  MARK_CATALOG_SUBMISSION_VERIFIED_PAYABLE_SQL,
  INCREMENT_CATALOG_SUBMISSION_FAILURES_SQL,
  MARK_CATALOG_SUBMISSION_FAILED_SQL,
  COUNT_STUCK_CATALOG_SUBMISSIONS_SQL,
  DELETE_TERMINAL_CATALOG_SUBMISSIONS_BEFORE_SQL,
  GET_CATALOG_SUBMISSION_SQL,
  LIST_VERIFIED_CATALOG_SUBMISSIONS_SQL,
} from '../src/infra/repositories/catalog-submissions.js'
import {
  FIND_CURRENCY_PREFERENCE_SQL,
  FIND_USER_CREDENTIALS_BY_EMAIL_SQL,
  FIND_USER_ID_BY_EMAIL_SQL,
  FIND_USER_PROFILE_BY_ID_SQL,
  INSERT_USER_SQL,
  UPDATE_CURRENCY_PREFERENCE_SQL,
  UPDATE_USER_NAME_SQL,
  UPDATE_USER_WALLET_ADDRESS_SQL,
} from '../src/infra/repositories/users.js'
import {
  DELETE_OWNER_ALIAS_SQL,
  LIST_OWNER_ALIASES_SQL,
  UPSERT_OWNER_ALIAS_SQL,
} from '../src/infra/repositories/owner-aliases.js'
import {
  FIND_PORTFOLIO_SNAPSHOTS_SQL,
  HAS_FIRST_AGENT_PAYMENT_SQL,
  INSERT_PORTFOLIO_SNAPSHOT_SQL,
  LIST_DASHBOARD_AGENTS_SQL,
  LIST_DASHBOARD_SAFES_SQL,
  SUM_MONTHLY_PAYMENT_SPEND_SQL,
} from '../src/infra/repositories/dashboard.js'
import {
  LIST_AGENT_PAYMENTS_SQL,
  LIST_FEED_PAYMENTS_SQL,
  SUM_AGENT_SPEND_ALL_TIME_SQL,
  SUM_AGENT_SPEND_TODAY_SQL,
  SUM_AGENT_SPEND_WEEK_SQL,
} from '../src/infra/repositories/agent-activity.js'
import {
  LIST_TOOL_INVOCATIONS_FOR_AGENT_SQL,
  LIST_TOOL_INVOCATIONS_FOR_AGENTS_SQL,
} from '../src/infra/repositories/agent-tool-invocations.js'
import { LIST_AGENT_NAMES_FOR_USER_SQL } from '../src/infra/repositories/agents.js'

interface SmokeQuery {
  name: string
  sql: string
}

/**
 * Curated money-path queries. `$N` params are fine — PREPARE type-checks them.
 * Keep each verbatim from its source so the check tracks the real query.
 */
const QUERIES: SmokeQuery[] = [
  // Connect Agent 2 setup flow (#985). IMPORTED from the repository, so these
  // track the real queries — this is the first block extraction made reachable
  // by this script at all; before #985 every one of them was inline in a route.
  { name: 'setup: find by token hash', sql: FIND_SETUP_BY_TOKEN_HASH_SQL },
  { name: 'setup: find for user (tenant-scoped)', sql: FIND_SETUP_FOR_USER_SQL },
  { name: 'setup: lock for user (FOR UPDATE)', sql: LOCK_SETUP_FOR_USER_SQL },
  { name: 'setup: lock by token hash on register (FOR UPDATE)', sql: LOCK_SETUP_BY_TOKEN_HASH_SQL },
  { name: 'setup: find by id + token hash (install status header path)', sql: FIND_SETUP_BY_ID_AND_TOKEN_HASH_SQL },
  { name: 'setup: find agent status during cancel', sql: FIND_AGENT_STATUS_SQL },
  { name: 'setup: activate agent on approval', sql: ACTIVATE_AGENT_SQL },
  { name: 'setup: find by agent API key (install status)', sql: FIND_SETUP_BY_AGENT_API_KEY_SQL },
  { name: 'setup: find user safe by id', sql: FIND_USER_SAFE_BY_ID_SQL },
  { name: 'setup: find default user safe', sql: FIND_DEFAULT_USER_SAFE_SQL },
  { name: 'setup: list allowances', sql: LIST_SETUP_ALLOWANCES_SQL },
  { name: 'setup: list active delegations for budget approval', sql: LIST_ACTIVE_DELEGATIONS_SQL },
  { name: 'setup: find active agent by delegate', sql: FIND_ACTIVE_AGENT_BY_DELEGATE_SQL },
  { name: 'setup: insert', sql: INSERT_SETUP_SQL },
  { name: 'setup: insert allowance', sql: INSERT_SETUP_ALLOWANCE_SQL },
  { name: 'setup: update connector metadata', sql: UPDATE_CONNECTOR_METADATA_SQL },
  { name: 'setup: insert pending agent on register', sql: INSERT_AGENT_SQL },
  { name: 'setup: mark registered (token consumed)', sql: MARK_SETUP_REGISTERED_SQL },
  { name: 'setup: merge install status', sql: MERGE_INSTALL_STATUS_SQL },
  { name: 'setup: apply approval state', sql: UPDATE_APPROVAL_STATE_SQL },
  { name: 'setup: cancel (guarded)', sql: CANCEL_SETUP_SQL },
  { name: 'setup: revoke pending agent on cancel', sql: REVOKE_PENDING_AGENT_SQL },
  // Agents aggregate (#988). IMPORTED from the repository — the SQL is verbatim
  // from routes/agents.ts, and the list/single vs delegate-balance status
  // asymmetry (#1069) is named in the constants.
  { name: 'agents: list for user, ALL statuses (#1069)', sql: LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL },
  { name: 'agents: find for user, ALL statuses (#1069)', sql: FIND_AGENT_FOR_USER_ALL_STATUSES_SQL },
  { name: 'agents: delegate-balance read (status-agnostic, #1403)', sql: FIND_DELEGATE_AGENT_FOR_USER_SQL },
  { name: 'agents: safe ownership check on create', sql: FIND_USER_SAFE_ID_FOR_USER_SQL },
  { name: 'agents: default safe fallback on create', sql: FIND_DEFAULT_USER_SAFE_ID_SQL },
  { name: 'agents: duplicate-delegate pre-check', sql: FIND_NON_REVOKED_AGENT_BY_DELEGATE_SQL },
  { name: 'agents: existence check (tenant-scoped)', sql: FIND_AGENT_ID_FOR_USER_SQL },
  { name: 'agents: id+status gate (tenant-scoped)', sql: FIND_AGENT_ID_STATUS_FOR_USER_SQL },
  { name: 'agents: insert with API key', sql: INSERT_AGENT_WITH_KEY_SQL },
  { name: 'agents: safe info inside create tx', sql: FIND_SAFE_INFO_SQL },
  { name: 'agents: profile update (CTE, tenant-scoped)', sql: UPDATE_AGENT_PROFILE_SQL },
  { name: 'agents: archive revoked agent (#1401)', sql: ARCHIVE_AGENT_SQL },
  { name: 'agents: live-delegation guard for archive (#1436)', sql: AGENT_HAS_LIVE_DELEGATIONS_SQL },
  { name: 'agents: unarchive (#1401)', sql: UNARCHIVE_AGENT_SQL },
  { name: 'agents: revoke', sql: REVOKE_AGENT_SQL },
  { name: 'agents: rotate API key', sql: ROTATE_AGENT_API_KEY_SQL },
  { name: 'agents: pause', sql: PAUSE_AGENT_SQL },
  { name: 'agents: resume', sql: RESUME_AGENT_SQL },
  // User-safes aggregate (#988). IMPORTED from the repository — verbatim from
  // routes/user-safes.ts. Nine statements left with #1988 (epic #1440): the
  // four approver-metadata ones, the three import-path writes/reads, and the
  // two lookups only the deleted handlers used. What remains is the surviving
  // CRUD surface — list, rename, re-default, unlink — plus the owner directory.
  { name: 'user-safes: list for user', sql: LIST_SAFES_FOR_USER_SQL },
  { name: 'user-safes: ownership check (id+address)', sql: FIND_OWNED_SAFE_ADDRESS_SQL },
  { name: 'user-safes: ownership check (id+is_default)', sql: FIND_OWNED_SAFE_DEFAULT_FLAG_SQL },
  { name: 'user-safes: legacy users.safe_address mirror', sql: SET_LEGACY_USER_SAFE_ADDRESS_SQL },
  { name: 'user-safes: legacy users.safe_address clear', sql: CLEAR_LEGACY_USER_SAFE_ADDRESS_SQL },
  { name: 'user-safes: rename (tenant-scoped)', sql: RENAME_SAFE_FOR_USER_SQL },
  { name: 'user-safes: clear defaults in set-default tx', sql: CLEAR_DEFAULT_SAFES_FOR_USER_SQL },
  { name: 'user-safes: set default in set-default tx', sql: SET_SAFE_DEFAULT_SQL },
  { name: 'user-safes: orphan agents in delete tx', sql: ORPHAN_AGENTS_FOR_SAFE_SQL },
  { name: 'user-safes: orphan self-sign agents in delete tx (RESTRICT FK)', sql: ORPHAN_SELF_SIGN_AGENTS_FOR_SAFE_SQL },
  { name: 'user-safes: delete row', sql: DELETE_USER_SAFE_SQL },
  { name: 'user-safes: oldest remaining safe for promotion', sql: FIND_OLDEST_SAFE_FOR_USER_SQL },
  { name: 'user-safes: promote safe to default in delete tx', sql: PROMOTE_SAFE_TO_DEFAULT_SQL },
  { name: 'user-safes: owner-directory list (account_type)', sql: LIST_SAFES_WITH_ACCOUNT_TYPE_FOR_USER_SQL },
  // Users aggregate (#1167). IMPORTED from the repository — verbatim from
  // routes/user.ts.
  { name: 'users: update display name', sql: UPDATE_USER_NAME_SQL },
  { name: 'users: update connected wallet address', sql: UPDATE_USER_WALLET_ADDRESS_SQL },
  { name: 'users: read currency preference', sql: FIND_CURRENCY_PREFERENCE_SQL },
  { name: 'users: update currency preference', sql: UPDATE_CURRENCY_PREFERENCE_SQL },
  // Signup/login (#1180). IMPORTED — verbatim from routes/auth.ts. These are
  // the only statements that look an account up by EMAIL rather than id, so a
  // schema change to that column would break sign-in itself.
  { name: 'auth: existing-account check by email', sql: FIND_USER_ID_BY_EMAIL_SQL },
  { name: 'auth: signup insert', sql: INSERT_USER_SQL },
  { name: 'auth: login credentials read by email', sql: FIND_USER_CREDENTIALS_BY_EMAIL_SQL },
  { name: 'auth: /me profile read by id', sql: FIND_USER_PROFILE_BY_ID_SQL },
  { name: 'auth: session safes payload (carries account_type, #1069)', sql: LIST_SESSION_SAFES_FOR_USER_SQL },
  { name: 'outbound: enqueue a tx', sql: ENQUEUE_OUTBOUND_TX_SQL },
  { name: 'outbound: claim next per chain', sql: CLAIM_NEXT_OUTBOUND_TX_SQL },
  { name: 'outbound: mark broadcast', sql: MARK_OUTBOUND_TX_BROADCAST_SQL },
  { name: 'outbound: mark mined', sql: MARK_OUTBOUND_TX_MINED_SQL },
  { name: 'outbound: mark failed', sql: MARK_OUTBOUND_TX_FAILED_SQL },
  { name: 'outbound: mark replaced', sql: MARK_OUTBOUND_TX_REPLACED_SQL },
  { name: 'outbound: list unmined for the bump worker', sql: LIST_UNMINED_OUTBOUND_TXS_SQL },
  { name: 'outbound: claim an orphaned queued row (#1558)', sql: CLAIM_ORPHANED_OUTBOUND_TX_SQL },
  { name: 'outbound: count lane attempts at a nonce (#1558)', sql: COUNT_LANE_ATTEMPTS_AT_NONCE_SQL },
  // Owner-alias aggregate (#1167). IMPORTED — verbatim from routes/user.ts.
  { name: 'owner-aliases: list for confirmed owners', sql: LIST_OWNER_ALIASES_SQL },
  { name: 'owner-aliases: upsert', sql: UPSERT_OWNER_ALIAS_SQL },
  { name: 'owner-aliases: delete', sql: DELETE_OWNER_ALIAS_SQL },
  // Dashboard overview aggregate (#1167). IMPORTED — verbatim from
  // routes/dashboard.ts.
  { name: 'dashboard: account list', sql: LIST_DASHBOARD_SAFES_SQL },
  { name: 'dashboard: agent preview (safe join)', sql: LIST_DASHBOARD_AGENTS_SQL },
  { name: 'dashboard: first-agent-payment milestone', sql: HAS_FIRST_AGENT_PAYMENT_SQL },
  { name: 'dashboard: portfolio snapshots for today+yesterday', sql: FIND_PORTFOLIO_SNAPSHOTS_SQL },
  { name: 'dashboard: portfolio snapshot upsert', sql: INSERT_PORTFOLIO_SNAPSHOT_SQL },
  { name: 'dashboard: month-to-date payment spend', sql: SUM_MONTHLY_PAYMENT_SPEND_SQL },
  // Agent-activity read model (#1167). IMPORTED — verbatim from
  // routes/agent-activity.ts. The four-table payment/approval joins are the
  // highest-value additions in this block: they reach machine_payment_evidence
  // and machine_payment_reconciliation_events, which no other smoke query
  // touches from this angle.
  { name: 'agent-activity: single-agent payments (evidence joins)', sql: LIST_AGENT_PAYMENTS_SQL },
  { name: 'agent-activity: feed payments (evidence joins)', sql: LIST_FEED_PAYMENTS_SQL },
  { name: 'agent-activity: spend all time', sql: SUM_AGENT_SPEND_ALL_TIME_SQL },
  { name: 'agent-activity: spend today', sql: SUM_AGENT_SPEND_TODAY_SQL },
  { name: 'agent-activity: spend this week', sql: SUM_AGENT_SPEND_WEEK_SQL },
  // One statement, two surfaces (#1179) — the dashboard and the activity feed.
  { name: 'agent-tool-invocations: read for agent', sql: LIST_TOOL_INVOCATIONS_FOR_AGENT_SQL },
  { name: 'agent-tool-invocations: read for agent set', sql: LIST_TOOL_INVOCATIONS_FOR_AGENTS_SQL },
  { name: 'agents: name map for activity feed', sql: LIST_AGENT_NAMES_FOR_USER_SQL },
  {
    // Every authenticated agent request runs this, and it is where
    // `agent.chain_id` comes from — the value machine-payments.ts then uses for
    // asset resolution, sweep-chain checks and inserts. IMPORTED, per this
    // file's own rule, so the check tracks the real query rather than a copy.
    name: 'auth: agent lookup by API key (chain_id fallback, #990)',
    sql: AGENT_BY_API_KEY_SQL,
  },
  {
    // IMPORTED since #999 — the pasted copy had drifted (it still selected
    // `a.session_permission_id`, which the real query dropped), which is
    // exactly the failure mode importing prevents.
    name: 'execution-rail: loadExecutionRailState (the #757 regression)',
    sql: FIND_EXECUTION_RAIL_FOR_AGENT_SQL,
  },
  {
    name: 'auth: agent last-seen throttle write (#999, imported)',
    sql: TOUCH_AGENT_LAST_SEEN_SQL,
  },
  {
    name: 'audit: agent tool-invocation insert (#999, imported)',
    sql: INSERT_AGENT_TOOL_INVOCATION_SQL,
  },
  {
    // IMPORTED since #995 — the pasted copy predated the repository.
    name: 'x402: exact-amount idempotency reload',
    sql: FIND_X402_INTENT_BY_KEY_SQL,
  },
  // Two pasted session-rail entries were DELETED here (#1165): the
  // recordRotatedSession guarded switch (its source died with the #834
  // retirement — no such function exists in src) and a session-shaped
  // payment_intents insert whose live counterpart is the repository's
  // imported INSERT above. Both PREPAREd fine — the columns still exist as
  // the #834 reversibility seam — which is exactly why dead pasted copies
  // are worse than none: they green-light a query nobody runs.
  {
    // IMPORTED since #999 — was a pasted copy.
    name: 'delegate monitor: active delegates joined to their Safe chain',
    sql: LIST_MONITORED_DELEGATES_SQL,
  },
  {
    name: 'delegate monitor: fresh pending intents per agent (#999, imported)',
    sql: LIST_AGENTS_WITH_FRESH_PENDING_INTENTS_SQL,
  },
  {
    // IMPORTED since #995 — the pasted copy predated the repository.
    name: 'evidence: post-settle residue reconciliation insert',
    sql: INSERT_RESIDUE_EVENT_SQL,
  },
  {
    name: 'hybrid accounts: provisioning insert with rail + type (#825)',
    sql: `INSERT INTO user_safes (user_id, safe_address, chain_id, name, is_default, account_type, execution_rail)
          VALUES ($1, $2, $3, $4, $5, 'delegator_hybrid', 'delegation')
          RETURNING id, created_at`,
  },
  {
    name: 'hybrid accounts: passkey signer persist (#885)',
    sql: `INSERT INTO hybrid_account_passkeys (user_safe_id, key_id, public_key_x, public_key_y)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_safe_id, key_id) DO NOTHING`,
  },
  {
    // IMPORTED since #999 — was a pasted copy.
    name: 'hybrid accounts: owner config round-trip — passkey set (#885)',
    sql: LIST_ACCOUNT_PASSKEYS_SQL,
  },
  {
    name: 'hybrid accounts: owner config round-trip — account row (#885/#908, imported)',
    sql: FIND_HYBRID_OWNER_SAFE_ROW_SQL,
  },
  {
    name: 'delegations: grant insert with lifecycle status (#828)',
    sql: `INSERT INTO agent_delegations (
            agent_id, chain_id, token_address, recipient_address, delegation_hash,
            delegation_json, version, status, budget_atomic, period_seconds,
            start_date, expires_at
          ) VALUES ($1, $2, LOWER($3), $4, $5, $6, $7, 'pending', $8, $9, $10, $11)
          ON CONFLICT (delegation_hash) DO NOTHING`,
  },
  {
    name: 'delegations: next version per (agent, token, recipient|open) (#813 identity)',
    sql: `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
          FROM agent_delegations
          WHERE agent_id = $1 AND token_address = LOWER($2)
            AND recipient_address IS NOT DISTINCT FROM LOWER($3)`,
  },
  {
    // IMPORTED since #995 — the pasted copy predated the repository.
    name: 'payments: delegation intent insert (rail + delegation pinned, #829; budget hash #1059)',
    sql: INSERT_DELEGATION_INTENT_SQL,
  },
  {
    name: 'relayer: gas-event insert (#717 attribution)',
    sql: `INSERT INTO relayer_gas_events
            (chain_id, operation, agent_id, user_id, tx_hash, gas_used, effective_gas_price, cost_wei)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id`,
  },
  {
    name: 'relayer: budget window count (#717 guard)',
    sql: `SELECT COUNT(*)::text AS cnt FROM relayer_gas_events
          WHERE agent_id = $1 AND operation = $2
            AND created_at > NOW() - ($3 || ' minutes')::interval`,
  },
  {
    // IMPORTED since #999 — was a pasted copy.
    name: 'delegations: authorization selection (pinned wins over open, #829)',
    sql: SELECT_DELEGATION_FOR_PAYMENT_SQL,
  },
  // Repository extractions landed by #999 (baseline-to-zero): fee ledger,
  // Fortnox connection, reporting-feed dedup ledger, user passkeys, safe
  // ownership-with-type, receipt underlag. All IMPORTED.
  { name: 'fees: idempotent settled-fee insert (#386)', sql: INSERT_PAYMENT_FEE_SQL },
  { name: 'fees: recorded-fee read (#386)', sql: GET_RECORDED_FEE_SQL },
  { name: 'fortnox: connection upsert (#465)', sql: UPSERT_FORTNOX_CONNECTION_SQL },
  { name: 'fortnox: connection read (#465)', sql: GET_FORTNOX_CONNECTION_SQL },
  { name: 'fortnox: connection delete (#465)', sql: DELETE_FORTNOX_CONNECTION_SQL },
  { name: 'reporting feed: claim insert (first writer wins, #497)', sql: CLAIM_SYNC_INSERT_SQL },
  { name: 'reporting feed: re-claim failed row (#497)', sql: CLAIM_SYNC_RECLAIM_FAILED_SQL },
  { name: 'reporting feed: mark pushed (note #498)', sql: MARK_SYNC_PUSHED_SQL },
  { name: 'reporting feed: mark failed (#497)', sql: MARK_SYNC_FAILED_SQL },
  { name: 'reporting feed: sync state read (#497)', sql: GET_SYNC_STATE_SQL },
  { name: 'reporting feed: per-user listing (#500)', sql: LIST_SYNCS_FOR_USER_SQL },
  { name: 'reporting feed: unpushed payment ids (#499)', sql: LIST_UNPUSHED_PAYMENT_IDS_SQL },
  { name: 'passkeys: enrollment insert', sql: INSERT_USER_PASSKEY_SQL },
  { name: 'passkeys: per-user listing', sql: LIST_USER_PASSKEYS_SQL },
  { name: 'passkeys: safe-exec ownership read', sql: FIND_PASSKEY_FOR_SAFE_SQL },
  { name: 'safes: details ownership check (any chain)', sql: FIND_OWNED_SAFE_WITH_TYPE_ANY_CHAIN_SQL },
  { name: 'safes: details ownership check (for chain)', sql: FIND_OWNED_SAFE_WITH_TYPE_FOR_CHAIN_SQL },
  { name: 'reporting: receipt underlag source join (#498)', sql: LOAD_RECEIPT_UNDERLAG_SOURCE_SQL },
  { name: 'contacts: per-user listing', sql: LIST_CONTACTS_FOR_USER_SQL },
  { name: 'contacts: insert (23505 → 409 in the route)', sql: INSERT_CONTACT_SQL },
  { name: 'contacts: rename (tenant-scoped)', sql: RENAME_CONTACT_FOR_USER_SQL },
  { name: 'contacts: delete (tenant-scoped)', sql: DELETE_CONTACT_FOR_USER_SQL },
  {
    // Not a money query, but it is a SAFETY query: if these stop matching the
    // schema, revoked agents keep a live attestation on-chain and nothing fails
    // loudly. The unit tests mock `pg`, so this is the only place the
    // UPDATE…FROM shape and `MAKE_INTERVAL(secs => $n)` meet a real planner.
    //
    // IMPORTED, not pasted — see the note above.
    name: 'passport: claimRevocation — invariant + lease, atomically (#973)',
    sql: CLAIM_REVOCATION_SQL,
  },
  {
    // The query that decides whether an agent revoked mid-anchor is ever picked
    // up at all. It was missing while its alarm cousin was covered — the retry
    // path mattering more than the alarm for it.
    name: 'passport: listRevocationsDue — the retry queue (#973)',
    sql: LIST_REVOCATIONS_DUE_SQL,
  },
  {
    name: 'passport: listStuckRevocations — the stuck-revoke alarm (#973)',
    sql: LIST_STUCK_REVOCATIONS_SQL,
  },
  {
    // The re-anchor trio (#1699). Same argument as their revocation cousins,
    // one step further: these are the ONLY thing that notices a live agent
    // whose attestation names the delegate key a re-key retired. A schema
    // mismatch here fails silently and permanently — the queue simply returns
    // nothing, which is indistinguishable from "no agent needs re-anchoring".
    name: 'passport: claimReanchorRevocation — the stale-anchor gate (#1699)',
    sql: CLAIM_REANCHOR_REVOCATION_SQL,
  },
  {
    name: 'passport: listReanchorsDue — the re-anchor queue (#1699)',
    sql: LIST_REANCHORS_DUE_SQL,
  },
  {
    name: 'passport: listStuckReanchors — the stuck-re-anchor alarm (#1699)',
    sql: LIST_STUCK_REANCHORS_SQL,
  },
  {
    // IMPORTED, not pasted — the reason the passport set stopped hand-copying
    // queries at all. A literal here is byte-identical the day it is written
    // and silently stale the day the real statement changes, and the smoke
    // test keeps passing against the copy.
    name: 'passport: resetForReanchor — hands the row back to issuance (#1699)',
    sql: RESET_FOR_REANCHOR_SQL,
  },
  {
    // The merchant-facing lookup. A schema mismatch here means verification
    // returns "no passport" for a real agent — which a merchant reads as
    // "unknown agent" and may act on. IMPORTED, not pasted: this was the last
    // hand-copied query in the passport set, and it had already been hand-edited
    // once to track the anchored-only narrowing.
    name: 'passport: verifier resolves EITHER agent address (#974)',
    sql: FIND_BY_AGENT_ADDRESS_SQL,
  },
  {
    name: 'passport: verifier resolves by attestation UID (#974)',
    sql: FIND_BY_ATTESTATION_UID_SQL,
  },
  {
    name: 'passport: markAnchored records the attested addresses (#974)',
    sql: `UPDATE agent_passports
             SET status = 'anchored', attestation_uid = $2, tx_hash = $3,
                 agent_eoa = $4, smart_account = $5,
                 last_error = NULL, anchored_at = NOW(), updated_at = NOW()
           WHERE agent_id = $1`,
  },
  {
    name: 'passport: claimForAnchoring — the double-attest guard (#972)',
    sql: `UPDATE agent_passports
             SET anchoring_started_at = NOW(), attempts = attempts + 1, updated_at = NOW()
           WHERE agent_id = $1
             AND status <> 'anchored'
             AND (anchoring_started_at IS NULL
                  OR anchoring_started_at < NOW() - MAKE_INTERVAL(secs => $2))`,
  },
  // ── Payment-path repositories (#995). ALL IMPORTED — the single biggest
  // block of settlement data access, previously inline in nine files and
  // therefore never PREPARE-checked in CI (the #757 failure class).
  // payment_intents aggregate:
  { name: 'intents: find for agent (tenant-scoped)', sql: FIND_INTENT_FOR_AGENT_SQL },
  { name: 'intents: status read for 409 responder', sql: GET_INTENT_STATUS_SQL },
  { name: 'intents: list for agent', sql: LIST_INTENTS_FOR_AGENT_SQL },
  { name: 'intents: legacy AllowanceModule insert', sql: INSERT_LEGACY_INTENT_SQL },
  { name: 'intents: /send insert (send_idempotency_key)', sql: INSERT_SEND_INTENT_SQL },
  { name: 'intents: machine insert, machine-key arbiter', sql: INSERT_MACHINE_INTENT_MACHINE_KEY_SQL },
  { name: 'intents: machine insert, x402-key arbiter', sql: INSERT_MACHINE_INTENT_X402_KEY_SQL },
  { name: 'intents: /send idempotency replay lookup', sql: FIND_SEND_INTENT_BY_KEY_SQL },
  { name: 'intents: machine key/challenge idempotency lookup', sql: FIND_MACHINE_INTENT_BY_KEY_OR_CHALLENGE_SQL },
  { name: 'intents: expire pending (judged by caller)', sql: EXPIRE_PENDING_INTENT_SQL },
  { name: 'intents: expire pending, returning status (GET read path)', sql: EXPIRE_PENDING_INTENT_RETURNING_STATUS_SQL },
  { name: 'intents: expire overdue (claim-CAS loser branch)', sql: EXPIRE_OVERDUE_INTENT_RETURNING_STATUS_SQL },
  { name: 'intents: lazy expire before status read', sql: EXPIRE_OVERDUE_INTENT_BY_ID_SQL },
  { name: 'intents: lazy expire sweep before list', sql: EXPIRE_OVERDUE_INTENTS_FOR_AGENT_SQL },
  { name: 'intents: claim for submission (the double-spend CAS)', sql: CLAIM_INTENT_FOR_SUBMISSION_SQL },
  { name: 'intents: confirm submitted', sql: CONFIRM_SUBMITTED_INTENT_SQL },
  { name: 'intents: release submitted claim (#717/#1119)', sql: RELEASE_SUBMITTED_CLAIM_SQL },
  { name: 'intents: fail submitted', sql: FAIL_SUBMITTED_INTENT_SQL },
  { name: 'intents: machine nonce/hash refresh', sql: REFRESH_MACHINE_INTENT_NONCE_SQL },
  { name: 'intents: machine one-shot signature record', sql: RECORD_MACHINE_INTENT_SIGNATURE_SQL },
  { name: 'intents: machine one-shot confirm', sql: CONFIRM_MACHINE_INTENT_SQL },
  { name: 'intents: machine one-shot fail', sql: FAIL_MACHINE_INTENT_SQL },
  { name: 'intents: status projection with funded-but-unsettled join', sql: FIND_INTENT_STATUS_ROW_SQL },
  { name: 'intents: settled receipt row (evidence join)', sql: FIND_SETTLED_PAYMENT_RECEIPT_SQL },
  // x402 authorization lifecycle:
  { name: 'x402: hourly cap config read (#961)', sql: GET_MAX_X402_PER_HOUR_SQL },
  { name: 'x402: hourly cap usage count (#961)', sql: COUNT_RECENT_X402_INTENTS_SQL },
  { name: 'x402: post-conflict active-intent reload', sql: FIND_ACTIVE_X402_INTENT_BY_KEY_SQL },
  { name: 'x402: stale-replay refresh (guarded, #961)', sql: REFRESH_STALE_X402_INTENT_SQL },
  { name: 'x402: one-shot signature record', sql: RECORD_X402_SIGNATURE_SQL },
  { name: 'x402: one-shot confirm', sql: CONFIRM_X402_INTENT_SQL },
  { name: 'x402: one-shot fail', sql: FAIL_X402_INTENT_SQL },
  { name: 'x402: settle intent load (#830)', sql: FIND_SETTLE_INTENT_SQL },
  { name: 'x402: settle flip to submitted (#976 ordering)', sql: MARK_INTENT_SUBMITTED_FOR_SETTLEMENT_SQL },
  // machine-payment evidence / reconciliation / sweeps / merchant receipts:
  { name: 'evidence: base upsert anchored on intent', sql: UPSERT_EVIDENCE_BASE_FOR_INTENT_SQL },
  { name: 'evidence: base upsert anchored on approval', sql: UPSERT_EVIDENCE_BASE_FOR_APPROVAL_SQL },
  { name: 'evidence: intent source read (optional agent scope)', sql: FIND_INTENT_EVIDENCE_SOURCE_SQL },
  { name: 'evidence: intent source read (agent-scoped)', sql: FIND_INTENT_FOR_EVIDENCE_SQL },
  { name: 'evidence: proof attach on intent', sql: ATTACH_EVIDENCE_FOR_INTENT_SQL },
  { name: 'evidence: proof attach on approval', sql: ATTACH_EVIDENCE_FOR_APPROVAL_SQL },
  { name: 'evidence: receipts list with settlement-scheme join (#1063)', sql: LIST_EVIDENCE_RECEIPTS_SQL },
  { name: 'evidence: intent settlement-fields echo (#1118)', sql: GET_INTENT_SETTLEMENT_FIELDS_SQL },
  { name: 'reconciliation: intent lookup', sql: FIND_RECONCILIATION_INTENT_SQL },
  { name: 'reconciliation: event upsert keyed on intent', sql: UPSERT_RECONCILIATION_EVENT_FOR_INTENT_SQL },
  { name: 'reconciliation: event upsert keyed on approval', sql: UPSERT_RECONCILIATION_EVENT_FOR_APPROVAL_SQL },
  { name: 'reconciliation: event reload keyed on intent', sql: FIND_RECONCILIATION_EVENT_FOR_INTENT_SQL },
  { name: 'reconciliation: event reload keyed on approval', sql: FIND_RECONCILIATION_EVENT_FOR_APPROVAL_SQL },
  { name: 'reconciliation: resolve on settle proof (intent)', sql: RESOLVE_RECONCILIATION_FOR_INTENT_SQL },
  { name: 'reconciliation: resolve on settle proof (approval)', sql: RESOLVE_RECONCILIATION_FOR_APPROVAL_SQL },
  { name: 'reconciliation: resolve stranded flags after sweep', sql: RESOLVE_STRANDED_EVENTS_FOR_AGENT_SQL },
  { name: 'sweeps: prepared insert', sql: INSERT_PREPARED_SWEEP_SQL },
  { name: 'sweeps: find by nonce (tenant-scoped)', sql: FIND_SWEEP_BY_NONCE_SQL },
  { name: 'sweeps: reload after lost claim', sql: FIND_SWEEP_BY_ID_SQL },
  { name: 'sweeps: expire prepared', sql: EXPIRE_PREPARED_SWEEP_SQL },
  { name: 'sweeps: claim CAS before relay', sql: CLAIM_PREPARED_SWEEP_SQL },
  { name: 'sweeps: release claim on budget refusal (#717)', sql: RELEASE_SWEEP_CLAIM_SQL },
  { name: 'sweeps: mark failed', sql: MARK_SWEEP_FAILED_SQL },
  { name: 'sweeps: mark submitted', sql: MARK_SWEEP_SUBMITTED_SQL },
  { name: 'merchant receipts: evidence anchor lookup (#956)', sql: FIND_EVIDENCE_ANCHOR_FOR_AGENT_SQL },
  { name: 'merchant receipts: first-write-wins insert (#956)', sql: INSERT_MERCHANT_RECEIPT_SQL },
  { name: 'merchant receipts: read by evidence id', sql: GET_MERCHANT_RECEIPT_SQL },
  // agents-aggregate money-path reads:
  { name: 'agents: delegate address for residue check (#716)', sql: FIND_AGENT_DELEGATE_ADDRESS_SQL },
  // account entitlements:
  { name: 'entitlements: has (unrevoked) check', sql: HAS_ENTITLEMENT_SQL },
  { name: 'entitlements: grant upsert', sql: GRANT_ENTITLEMENT_SQL },
  { name: 'entitlements: revoke', sql: REVOKE_ENTITLEMENT_SQL },
  // ── Transaction-history read model (#992). All the joins here reach into
  // money-path tables (payment_intents, delegate_sweeps,
  // machine_payment_evidence) even though the route itself is read-only.
  // `approval_requests` left this list with the table itself (#2055).
  { name: 'tx-history: basic safes list driving aggregation', sql: LIST_BASIC_SAFES_FOR_USER_SQL },
  { name: 'tx-history: agent picklist for /filters', sql: LIST_AGENTS_FOR_TRANSACTION_FILTERS_SQL },
  { name: 'tx-history: Safe ownership, any chain', sql: FIND_SAFE_OWNERSHIP_ANY_CHAIN_SQL },
  { name: 'tx-history: Safe ownership, pinned chain', sql: FIND_SAFE_OWNERSHIP_FOR_CHAIN_SQL },
  { name: 'tx-history: payment_intents agent attribution', sql: FIND_PAYMENT_INTENT_AGENT_MATCHES_SQL },
  { name: 'tx-history: delegate_sweeps agent attribution', sql: FIND_DELEGATE_SWEEP_AGENT_MATCHES_SQL },
  { name: 'tx-history: confirmed x402 payment_intents funding', sql: FIND_CONFIRMED_X402_PAYMENT_INTENTS_SQL },
  { name: 'tx-history: machine-payment evidence detail', sql: FIND_MACHINE_PAYMENT_EVIDENCE_DETAIL_SQL },
  { name: 'catalog-submissions: insert with pending-host dedupe', sql: INSERT_CATALOG_SUBMISSION_SQL },
  { name: 'catalog-submissions: pending row by host (no-op path)', sql: FIND_PENDING_CATALOG_SUBMISSION_BY_HOST_SQL },
  { name: 'catalog-submissions: pending queue count (429 cap)', sql: COUNT_PENDING_CATALOG_SUBMISSIONS_SQL },
  { name: 'catalog-lifecycle: submitted rows for ownership stage', sql: LIST_SUBMITTED_CATALOG_SUBMISSIONS_SQL },
  { name: 'catalog-lifecycle: ownership-verified rows for probe', sql: LIST_OWNERSHIP_VERIFIED_CATALOG_SUBMISSIONS_SQL },
  { name: 'catalog-lifecycle: verified rows due for recheck', sql: LIST_VERIFIED_CATALOG_SUBMISSIONS_DUE_SQL },
  { name: 'catalog-lifecycle: submitted -> ownership_verified', sql: MARK_CATALOG_SUBMISSION_OWNERSHIP_VERIFIED_SQL },
  { name: 'catalog-lifecycle: -> verified_payable with metadata', sql: MARK_CATALOG_SUBMISSION_VERIFIED_PAYABLE_SQL },
  { name: 'catalog-lifecycle: increment consecutive failures', sql: INCREMENT_CATALOG_SUBMISSION_FAILURES_SQL },
  { name: 'catalog-lifecycle: -> failed', sql: MARK_CATALOG_SUBMISSION_FAILED_SQL },
  { name: 'catalog-lifecycle: stuck submitted count', sql: COUNT_STUCK_CATALOG_SUBMISSIONS_SQL },
  { name: 'catalog-lifecycle: purge terminal rows past TTL', sql: DELETE_TERMINAL_CATALOG_SUBMISSIONS_BEFORE_SQL },
  { name: 'catalog-status: submission by id', sql: GET_CATALOG_SUBMISSION_SQL },
  { name: 'catalog-listing: verified ingestion rows', sql: LIST_VERIFIED_CATALOG_SUBMISSIONS_SQL },
]

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (throwaway CI database).')
    process.exit(2)
  }
  const pool = getPool()

  console.log('applying migrations…')
  await runMigrations()

  console.log(`preparing ${QUERIES.length} money-path queries against the real schema…\n`)
  const failures: string[] = []
  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i]
    const client = await pool.connect()
    try {
      await client.query(`PREPARE smoke_${i} AS ${q.sql}`)
      await client.query(`DEALLOCATE smoke_${i}`)
      console.log(`  ✓ ${q.name}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  ✗ ${q.name}\n      ${msg}`)
      failures.push(`${q.name}: ${msg}`)
    } finally {
      client.release()
    }
  }

  // ── behavioral: selectDelegation ordering (#1060) ─────────────────────────
  // The ORDER BY decides WHICH grant authorizes a payment — security-relevant
  // SQL that was only ever exercised through mocks. Seeded against the real
  // schema, asserted through the REAL exported function, cleaned up after.
  console.log('\nselectDelegation ordering (#1060)…')
  const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
  const PINNED_TO = '0x' + 'aa'.repeat(20)
  const OTHER_TO = '0x' + 'bb'.repeat(20)
  const fx = await pool.connect()
  let userId = ''
  try {
    userId = (
      await fx.query<{ id: string }>(
        `INSERT INTO users (name, email, password_hash) VALUES ('smoke-1060', $1, 'x') RETURNING id`,
        [`smoke-1060-${Date.now()}@haven.test`],
      )
    ).rows[0].id
    const safeId = (
      await fx.query<{ id: string }>(
        `INSERT INTO user_safes (user_id, safe_address, chain_id, name, is_default, account_type, execution_rail)
         VALUES ($1, $2, 84532, 'smoke', false, 'delegator_hybrid', 'delegation') RETURNING id`,
        [userId, '0x' + 'cc'.repeat(20)],
      )
    ).rows[0].id
    const agentId = (
      await fx.query<{ id: string }>(
        `INSERT INTO agents (user_id, name, delegate_address, api_key_hash, api_key_prefix, safe_id)
         VALUES ($1, 'smoke-1060', $2, 'smoke-hash-1060', 'sk_smoke', $3) RETURNING id`,
        [userId, '0x' + 'dd'.repeat(20), safeId],
      )
    ).rows[0].id

    const grant = (hash: string, recipient: string | null, status: string, minutesAgo: number) =>
      fx.query(
        `INSERT INTO agent_delegations (
           agent_id, chain_id, token_address, recipient_address, delegation_hash,
           delegation_json, version, status, budget_atomic, period_seconds,
           start_date, expires_at, created_at
         ) VALUES ($1, 84532, $2, $3, $4, '{}', 1, $5, '1000', 86400,
                   0, 9999999999, NOW() - ($6 || ' minutes')::interval)`,
        [agentId, USDC, recipient, hash, status, String(minutesAgo)],
      )
    // Fixture: an OLD pinned grant, a NEWER open grant, an even newer second
    // open grant, and dead rows in both classes.
    await grant('0x' + '01'.repeat(32), PINNED_TO, 'active', 60)
    await grant('0x' + '02'.repeat(32), null, 'active', 30)
    await grant('0x' + '03'.repeat(32), null, 'active', 10)
    await grant('0x' + '04'.repeat(32), PINNED_TO, 'replaced', 5)
    await grant('0x' + '05'.repeat(32), null, 'revoked', 1)

    const behavioral: Array<[string, boolean]> = []
    // 1. Pinned beats open for the pinned recipient — even though every open
    //    grant is newer than the pin.
    const pinned = await selectDelegation(agentId, USDC, PINNED_TO)
    behavioral.push([
      'pinned grant beats newer open grants for the pinned recipient',
      pinned?.delegation_hash === '0x' + '01'.repeat(32),
    ])
    // 2. Other recipients fall through to the open class, newest first.
    const open = await selectDelegation(agentId, USDC, OTHER_TO)
    behavioral.push([
      'open class serves other recipients, newest active open wins',
      open?.delegation_hash === '0x' + '03'.repeat(32),
    ])
    // 3. replaced/revoked rows never authorize: kill the actives, expect null.
    await fx.query(`UPDATE agent_delegations SET status = 'revoked' WHERE agent_id = $1 AND status = 'active'`, [agentId])
    const none = await selectDelegation(agentId, USDC, PINNED_TO)
    behavioral.push(['replaced/revoked grants never authorize (null → clean 403)', none === null])

    for (const [name, ok] of behavioral) {
      console.log(`  ${ok ? '✓' : '✗'} ${name}`)
      if (!ok) failures.push(`selectDelegation: ${name}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`  ✗ selectDelegation behavioral setup failed: ${msg}`)
    failures.push(`selectDelegation setup: ${msg}`)
  } finally {
    // Throwaway fixtures out, whatever happened above.
    if (userId) {
      await fx.query(`DELETE FROM agent_delegations WHERE agent_id IN (SELECT id FROM agents WHERE user_id = $1)`, [userId])
      await fx.query(`DELETE FROM agents WHERE user_id = $1`, [userId])
      await fx.query(`DELETE FROM user_safes WHERE user_id = $1`, [userId])
      await fx.query(`DELETE FROM users WHERE id = $1`, [userId])
    }
    fx.release()
  }

  await pool.end()
  console.log('')
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} query/queries do not match the schema — fix the query or the migration.`)
    process.exit(1)
  }
  console.log('✅ migrations apply and every curated money-path query matches the schema.')
}

main().catch((e) => {
  console.error('db-schema-smoke failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
