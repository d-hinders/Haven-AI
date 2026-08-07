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
import { selectDelegation } from '../src/lib/delegation-authorization.js'
import { AGENT_BY_API_KEY_SQL } from '../src/middleware/agentAuth.js'
import { runMigrations } from '../src/db/migrate.js'
import {
  CLAIM_REVOCATION_SQL,
  FIND_BY_AGENT_ADDRESS_SQL,
  FIND_BY_ATTESTATION_UID_SQL,
  LIST_REVOCATIONS_DUE_SQL,
  LIST_STUCK_REVOCATIONS_SQL,
} from '../src/infra/repositories/agent-passports.js'
import {
  CANCEL_SETUP_SQL,
  COPY_SETUP_ALLOWANCES_SQL,
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
  DELETE_AGENT_ALLOWANCE_SQL,
  DELETE_REVOKED_AGENT_SQL,
  FIND_AGENT_FOR_USER_ALL_STATUSES_SQL,
  FIND_AGENT_ID_FOR_USER_SQL,
  FIND_AGENT_ID_STATUS_FOR_USER_SQL,
  FIND_DEFAULT_USER_SAFE_ID_SQL,
  FIND_DELEGATE_AGENT_EXCLUDING_REVOKED_SQL,
  FIND_NON_REVOKED_AGENT_BY_DELEGATE_SQL,
  FIND_SAFE_INFO_SQL,
  FIND_USER_SAFE_ID_FOR_USER_SQL,
  INSERT_AGENT_ALLOWANCE_SQL,
  INSERT_AGENT_WITH_KEY_SQL,
  LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL,
  LIST_ALLOWANCES_FOR_AGENTS_SQL,
  LIST_ALLOWANCES_FOR_AGENT_SQL,
  LIST_ALLOWANCES_FOR_AGENT_UNORDERED_SQL,
  PAUSE_AGENT_SQL,
  RESUME_AGENT_SQL,
  REVOKE_AGENT_SQL,
  ROTATE_AGENT_API_KEY_SQL,
  UPDATE_AGENT_PROFILE_SQL,
  UPSERT_AGENT_ALLOWANCE_SQL,
} from '../src/infra/repositories/agents.js'
import {
  FIND_AGENT_DELEGATE_ADDRESS_SQL,
  FIND_TOKEN_ALLOWANCE_AMOUNT_SQL,
  LIST_ALLOWANCE_CONFIG_FOR_AGENT_SQL,
} from '../src/infra/repositories/agents.js'
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
  EXPIRE_OVERDUE_APPROVAL_SQL,
  FIND_APPROVAL_STATUS_ROW_SQL,
  FIND_MACHINE_APPROVAL_BY_KEY_OR_CHALLENGE_SQL,
  FIND_SEND_APPROVAL_BY_KEY_SQL,
  FIND_X402_APPROVAL_BY_KEY_SQL,
  INSERT_MACHINE_APPROVAL_SQL,
  INSERT_PAYMENT_APPROVAL_SQL,
  INSERT_SEND_APPROVAL_SQL,
} from '../src/infra/repositories/approval-requests.js'
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
  FIND_APPROVAL_FOR_EVIDENCE_SQL,
  FIND_EVIDENCE_ANCHOR_FOR_AGENT_SQL,
  FIND_INTENT_EVIDENCE_SOURCE_SQL,
  FIND_INTENT_FOR_EVIDENCE_SQL,
  FIND_RECONCILIATION_APPROVAL_SQL,
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
} from '../src/infra/repositories/machine-payments.js'
import {
  GRANT_ENTITLEMENT_SQL,
  HAS_ENTITLEMENT_SQL,
  REVOKE_ENTITLEMENT_SQL,
} from '../src/infra/repositories/account-entitlements.js'
import {
  CLEAR_DEFAULT_SAFES_FOR_USER_SQL,
  CLEAR_LEGACY_USER_SAFE_ADDRESS_SQL,
  COUNT_SAFES_FOR_USER_SQL,
  DELETE_APPROVER_METADATA_SQL,
  DELETE_USER_SAFE_SQL,
  FIND_OLDEST_SAFE_FOR_USER_SQL,
  FIND_OWNED_SAFE_ADDRESS_SQL,
  FIND_OWNED_SAFE_DEFAULT_FLAG_SQL,
  FIND_OWNED_SAFE_SQL,
  FIND_SAFE_ID_BY_ADDRESS_AND_CHAIN_SQL,
  INSERT_USER_SAFE_SQL,
  LIST_APPROVER_METADATA_FOR_SAFE_SQL,
  LIST_KNOWN_APPROVERS_FOR_USER_SQL,
  LIST_SAFES_FOR_USER_SQL,
  ORPHAN_AGENTS_FOR_SAFE_SQL,
  ORPHAN_SELF_SIGN_AGENTS_FOR_SAFE_SQL,
  PROMOTE_SAFE_TO_DEFAULT_SQL,
  RENAME_SAFE_FOR_USER_SQL,
  SET_LEGACY_USER_SAFE_ADDRESS_SQL,
  SET_SAFE_DEFAULT_SQL,
  UPSERT_APPROVER_METADATA_SQL,
} from '../src/infra/repositories/user-safes.js'

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
  { name: 'setup: copy setup allowances to agent', sql: COPY_SETUP_ALLOWANCES_SQL },
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
  { name: 'agents: delegate-balance read, excluding revoked', sql: FIND_DELEGATE_AGENT_EXCLUDING_REVOKED_SQL },
  { name: 'agents: allowances for many agents', sql: LIST_ALLOWANCES_FOR_AGENTS_SQL },
  { name: 'agents: allowances for one agent (ordered)', sql: LIST_ALLOWANCES_FOR_AGENT_SQL },
  { name: 'agents: allowances for one agent (PUT path, unordered)', sql: LIST_ALLOWANCES_FOR_AGENT_UNORDERED_SQL },
  { name: 'agents: safe ownership check on create', sql: FIND_USER_SAFE_ID_FOR_USER_SQL },
  { name: 'agents: default safe fallback on create', sql: FIND_DEFAULT_USER_SAFE_ID_SQL },
  { name: 'agents: duplicate-delegate pre-check', sql: FIND_NON_REVOKED_AGENT_BY_DELEGATE_SQL },
  { name: 'agents: existence check (tenant-scoped)', sql: FIND_AGENT_ID_FOR_USER_SQL },
  { name: 'agents: id+status gate (tenant-scoped)', sql: FIND_AGENT_ID_STATUS_FOR_USER_SQL },
  { name: 'agents: insert with API key', sql: INSERT_AGENT_WITH_KEY_SQL },
  { name: 'agents: safe info inside create tx', sql: FIND_SAFE_INFO_SQL },
  { name: 'agents: insert allowance inside create tx', sql: INSERT_AGENT_ALLOWANCE_SQL },
  { name: 'agents: profile update (CTE, tenant-scoped)', sql: UPDATE_AGENT_PROFILE_SQL },
  { name: 'agents: delete revoked agent', sql: DELETE_REVOKED_AGENT_SQL },
  { name: 'agents: revoke', sql: REVOKE_AGENT_SQL },
  { name: 'agents: rotate API key', sql: ROTATE_AGENT_API_KEY_SQL },
  { name: 'agents: pause', sql: PAUSE_AGENT_SQL },
  { name: 'agents: resume', sql: RESUME_AGENT_SQL },
  { name: 'agents: allowance upsert (mirror row)', sql: UPSERT_AGENT_ALLOWANCE_SQL },
  { name: 'agents: allowance delete', sql: DELETE_AGENT_ALLOWANCE_SQL },
  // User-safes aggregate (#988). IMPORTED from the repository — verbatim from
  // routes/user-safes.ts.
  { name: 'user-safes: list for user', sql: LIST_SAFES_FOR_USER_SQL },
  { name: 'user-safes: duplicate check by address+chain', sql: FIND_SAFE_ID_BY_ADDRESS_AND_CHAIN_SQL },
  { name: 'user-safes: count for first-safe default rule', sql: COUNT_SAFES_FOR_USER_SQL },
  { name: 'user-safes: ownership check (id+address)', sql: FIND_OWNED_SAFE_ADDRESS_SQL },
  { name: 'user-safes: ownership check (id+is_default)', sql: FIND_OWNED_SAFE_DEFAULT_FLAG_SQL },
  { name: 'user-safes: ownership check (id+address+chain)', sql: FIND_OWNED_SAFE_SQL },
  { name: 'user-safes: import insert', sql: INSERT_USER_SAFE_SQL },
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
  { name: 'user-safes: known approvers across safes', sql: LIST_KNOWN_APPROVERS_FOR_USER_SQL },
  { name: 'user-safes: approver metadata for safe', sql: LIST_APPROVER_METADATA_FOR_SAFE_SQL },
  { name: 'user-safes: approver metadata upsert (expression conflict target)', sql: UPSERT_APPROVER_METADATA_SQL },
  { name: 'user-safes: approver metadata delete', sql: DELETE_APPROVER_METADATA_SQL },
  {
    // Every authenticated agent request runs this, and it is where
    // `agent.chain_id` comes from — the value machine-payments.ts then uses for
    // asset resolution, sweep-chain checks and inserts. IMPORTED, per this
    // file's own rule, so the check tracks the real query rather than a copy.
    name: 'auth: agent lookup by API key (chain_id fallback, #990)',
    sql: AGENT_BY_API_KEY_SQL,
  },
  {
    name: 'execution-rail: loadExecutionRailState (the #757 regression)',
    sql: `SELECT us.execution_rail, a.session_permission_id
          FROM agents a
          LEFT JOIN user_safes us ON us.id = a.safe_id
          WHERE a.id = $1`,
  },
  {
    // IMPORTED since #995 — the pasted copy predated the repository.
    name: 'x402: exact-amount idempotency reload',
    sql: FIND_X402_INTENT_BY_KEY_SQL,
  },
  {
    name: 'payments: session intent insert (execution_rail pinned)',
    sql: `INSERT INTO payment_intents (
            agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
            to_address, amount_raw, amount_human, delegate_address,
            allowance_nonce, sign_hash,
            execution_rail, session_permission_id, session_user_op,
            status, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            'pending_signature', NOW() + interval '10 minutes')
          RETURNING *`,
  },
  {
    name: 'rotation: guarded session switch (recordRotatedSession)',
    sql: `UPDATE agents
          SET session_permission_id = $1
          WHERE id = $2
            AND session_permission_id IS NOT DISTINCT FROM $3
          RETURNING id`,
  },
  {
    name: 'delegate monitor: active delegates joined to their Safe chain',
    sql: `SELECT a.id AS agent_id, a.name AS agent_name,
                 a.delegate_address, us.chain_id
          FROM agents a
          JOIN user_safes us ON us.id = a.safe_id
          WHERE a.status = 'active' AND a.delegate_address IS NOT NULL`,
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
    name: 'hybrid accounts: owner config round-trip — account row + passkey set (#885)',
    sql: `SELECT key_id, public_key_x, public_key_y
          FROM hybrid_account_passkeys
          WHERE user_safe_id = $1
          ORDER BY created_at ASC`,
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
    name: 'delegations: authorization selection (pinned wins over open, #829)',
    sql: `SELECT delegation_hash, delegation_json, recipient_address
          FROM agent_delegations
          WHERE agent_id = $1
            AND token_address = LOWER($2)
            AND status = 'active'
            AND (recipient_address = LOWER($3) OR recipient_address IS NULL)
          ORDER BY (recipient_address IS NULL), created_at DESC`,
  },
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
  // approval_requests aggregate:
  { name: 'approvals: direct-payment over-allowance insert', sql: INSERT_PAYMENT_APPROVAL_SQL },
  { name: 'approvals: /send over-allowance insert (send key)', sql: INSERT_SEND_APPROVAL_SQL },
  { name: 'approvals: machine insert with ON CONFLICT arbiter', sql: INSERT_MACHINE_APPROVAL_SQL },
  { name: 'approvals: /send idempotency replay lookup', sql: FIND_SEND_APPROVAL_BY_KEY_SQL },
  { name: 'approvals: x402 idempotency lookup', sql: FIND_X402_APPROVAL_BY_KEY_SQL },
  { name: 'approvals: machine key/challenge idempotency lookup', sql: FIND_MACHINE_APPROVAL_BY_KEY_OR_CHALLENGE_SQL },
  { name: 'approvals: lazy expire before status read', sql: EXPIRE_OVERDUE_APPROVAL_SQL },
  { name: 'approvals: status projection', sql: FIND_APPROVAL_STATUS_ROW_SQL },
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
  { name: 'evidence: approval source read (agent-scoped)', sql: FIND_APPROVAL_FOR_EVIDENCE_SQL },
  { name: 'evidence: proof attach on intent', sql: ATTACH_EVIDENCE_FOR_INTENT_SQL },
  { name: 'evidence: proof attach on approval', sql: ATTACH_EVIDENCE_FOR_APPROVAL_SQL },
  { name: 'evidence: receipts list with settlement-scheme join (#1063)', sql: LIST_EVIDENCE_RECEIPTS_SQL },
  { name: 'evidence: intent settlement-fields echo (#1118)', sql: GET_INTENT_SETTLEMENT_FIELDS_SQL },
  { name: 'reconciliation: intent lookup', sql: FIND_RECONCILIATION_INTENT_SQL },
  { name: 'reconciliation: approval lookup', sql: FIND_RECONCILIATION_APPROVAL_SQL },
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
  { name: 'agents: token allowance policy gate', sql: FIND_TOKEN_ALLOWANCE_AMOUNT_SQL },
  { name: 'agents: /allowances config projection', sql: LIST_ALLOWANCE_CONFIG_FOR_AGENT_SQL },
  { name: 'agents: delegate address for residue check (#716)', sql: FIND_AGENT_DELEGATE_ADDRESS_SQL },
  // account entitlements:
  { name: 'entitlements: has (unrevoked) check', sql: HAS_ENTITLEMENT_SQL },
  { name: 'entitlements: grant upsert', sql: GRANT_ENTITLEMENT_SQL },
  { name: 'entitlements: revoke', sql: REVOKE_ENTITLEMENT_SQL },
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
