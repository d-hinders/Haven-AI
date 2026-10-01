/**
 * The ops console's read-only database role (#3510, epic #3507 invariant 5).
 *
 * One source of truth for what the role can read, used by both the operator
 * script (`scripts/ops-readonly-role.ts`, which prints the SQL to run in
 * Railway) and the real-DB tests that prove it. It is deliberately NOT a
 * migration: every replica runs migrations at boot, so a `CREATE ROLE` the
 * migration user may not run — or two replicas racing one — would stop the
 * backend from starting, and a role is cluster-wide while the test harness
 * isolates by schema.
 *
 * Rules the SQL enforces:
 * - **Column-level grants only.** Never a table-level `GRANT SELECT`, which
 *   would silently extend to every column a later migration adds. A new
 *   column stays unreadable (fails closed) until this list names it and the
 *   script is re-run; the drift test flags it.
 * - **A positive allowlist.** Tables not listed are not readable at all
 *   (`agent_connection_setups`, `device_authorizations`,
 *   `accounting_connections`, `catalog_submissions`, `user_passkeys`,
 *   `rate_limit_counters`, `owner_company_details`, `ops_access_log`, …).
 * - **Read-only and bounded at the role:** `default_transaction_read_only`,
 *   a 5 s `statement_timeout` and `CONNECTION LIMIT 5`, so a heavy ops query
 *   cannot starve the primary.
 * - **No unredacted vendor secret in a free-text column.** The script refuses
 *   (raises, nothing granted) while any granted free-text column still holds
 *   one — older rows predate the write-boundary scrub.
 */

/** Columns the role may SELECT, per table. Anything absent is unreadable. */
export const OPS_READONLY_GRANTS: Readonly<Record<string, readonly string[]>> = {
  // `password_hash` withheld.
  users: [
    'id', 'email', 'wallet_address', 'account_address', 'created_at', 'updated_at',
    'currency_preference', 'name', 'via',
  ],
  smart_accounts: [
    'id', 'user_id', 'account_address', 'name', 'is_default', 'created_at', 'updated_at',
    'chain_id', 'execution_rail', 'account_type', 'owner_address', 'single_signer_waiver_at',
  ],
  // `api_key_hash` and `api_key_prefix` withheld (credential material; ops needs neither).
  agents: [
    'id', 'user_id', 'name', 'type', 'status', 'created_at', 'updated_at', 'description',
    'delegate_address', 'max_x402_per_hour', 'account_id', 'last_seen_at', 'archived_at',
    'mcp_server_name', 'organization_id', 'tax_declaration_enabled',
  ],
  // `delegation_json` granted by owner decision (2026-09-30, #3510): a signed
  // delegation to a named delegate confers no spend authority without that
  // delegate's key, and is public in calldata once redeemed.
  agent_delegations: [
    'id', 'agent_id', 'chain_id', 'token_address', 'recipient_address', 'delegation_hash',
    'delegation_json', 'version', 'status', 'budget_atomic', 'period_seconds', 'start_date',
    'expires_at', 'created_at', 'updated_at', 'rekey_id', 'carry_role', 'merchant_id',
  ],
  agent_task_budgets: [
    'id', 'agent_id', 'chain_id', 'token_address', 'recipient_address', 'parent_delegation_hash',
    'delegation_hash', 'delegation_json', 'label', 'max_atomic', 'status', 'expires_at',
    'prepared_user_op', 'close_tx_hash', 'created_at', 'updated_at', 'opened_at', 'closed_at',
  ],
  agent_sub_budgets: [
    'id', 'agent_id', 'parent_agent_id', 'parent_sub_budget_id', 'chain_id', 'token_address',
    'recipient_address', 'parent_delegation_hash', 'delegation_hash', 'delegation_json', 'label',
    'period_amount_atomic', 'status', 'expires_at', 'prepared_user_op', 'close_tx_hash',
    'created_at', 'updated_at', 'opened_at', 'closed_at',
  ],
  // `signature` and the three idempotency keys withheld (the agent's signature
  // over a prepared operation, and client-chosen replay keys — ops needs none).
  payment_intents: [
    'id', 'agent_id', 'user_id', 'account_address', 'token_symbol', 'token_address', 'to_address',
    'amount_raw', 'amount_human', 'delegate_address', 'allowance_nonce', 'sign_hash', 'tx_hash',
    'status', 'error_message', 'created_at', 'signed_at', 'submitted_at', 'confirmed_at',
    'expires_at', 'source', 'x402_resource_url', 'x402_category', 'chain_id', 'usd_value',
    'eur_value', 'x402_merchant_address', 'payment_rail', 'payment_resource_url',
    'merchant_address', 'machine_challenge_id', 'machine_metadata', 'execution_rail',
    'delegation_hash', 'prepared_user_op', 'budget_delegation_hash', 'sek_value', 'task_budget_id',
    'sub_budget_id',
  ],
  payment_refusals: [
    'id', 'user_id', 'account_id', 'agent_id', 'chain_id', 'token_symbol', 'amount_atomic',
    'usd_value', 'eur_value', 'merchant_to', 'resource_url', 'reason', 'source', 'detail',
    'attempts', 'created_at', 'sek_value',
  ],
  // EVERY column: `LIST_UNMINED_OUTBOUND_TXS_SQL` is `SELECT *`, which fails
  // under a partial column grant. `error` is scrubbed at its writer (#3510).
  outbound_txs: [
    'id', 'chain_id', 'submitter', 'to_address', 'data', 'value_atomic', 'status', 'claimed_at',
    'nonce', 'max_fee_per_gas', 'max_priority_fee_per_gas', 'tx_hash', 'replaced_by', 'error',
    'created_at', 'updated_at',
  ],
  agent_passports: [
    'agent_id', 'chain_id', 'status', 'assurance_level', 'attestation_uid', 'tx_hash', 'attempts',
    'anchoring_started_at', 'last_error', 'requested_at', 'anchored_at', 'updated_at',
    'revocation_status', 'revocation_requested_at', 'revocation_confirmed_at',
    'revocation_tx_hash', 'revocation_attempts', 'revocation_last_error',
    'revocation_next_attempt_at', 'agent_eoa', 'smart_account', 'uid_repair_confirmed_at',
    'uid_repair_next_at',
  ],
  // Public-key material only (`user_passkeys`, which holds `raw_attestation`, is not granted).
  hybrid_account_passkeys: ['id', 'account_id', 'key_id', 'public_key_x', 'public_key_y', 'label', 'created_at'],
}

/**
 * Granted columns whose NAME looks sensitive but whose content is reviewed
 * safe. The drift test refuses any other granted column matching
 * `SENSITIVE_COLUMN_NAME`.
 */
export const OPS_REVIEWED_SENSITIVE_COLUMNS: Readonly<Record<string, string>> = {
  'agent_delegations.delegation_json': 'owner decision 2026-09-30 (#3510): delegation to a named delegate, no spend authority',
  'agent_task_budgets.delegation_json': 'owner decision 2026-09-30 (#3510)',
  'agent_sub_budgets.delegation_json': 'owner decision 2026-09-30 (#3510)',
  'hybrid_account_passkeys.key_id': 'passkey credential id — public identifier, not a secret',
  'payment_intents.sign_hash': 'the hash the agent signs — public once submitted, not a credential',
  'payment_intents.delegation_hash': 'keccak identity of a delegation, not a credential',
  'payment_intents.budget_delegation_hash': 'keccak identity of a delegation, not a credential',
  'agent_delegations.delegation_hash': 'keccak identity of a delegation, not a credential',
  'agent_task_budgets.delegation_hash': 'keccak identity of a delegation, not a credential',
  'agent_task_budgets.parent_delegation_hash': 'keccak identity of a delegation, not a credential',
  'agent_sub_budgets.delegation_hash': 'keccak identity of a delegation, not a credential',
  'agent_sub_budgets.parent_delegation_hash': 'keccak identity of a delegation, not a credential',
  // On-chain public identifiers: a token contract, a transaction or an
  // attestation id — anyone can read them from the chain.
  'agent_delegations.token_address': 'ERC-20 contract address',
  'agent_task_budgets.token_address': 'ERC-20 contract address',
  'agent_sub_budgets.token_address': 'ERC-20 contract address',
  'payment_intents.token_address': 'ERC-20 contract address',
  'payment_intents.token_symbol': 'token ticker (USDC)',
  'payment_refusals.token_symbol': 'token ticker (USDC)',
  'payment_intents.tx_hash': 'public transaction hash',
  'outbound_txs.tx_hash': 'public transaction hash',
  'agent_task_budgets.close_tx_hash': 'public transaction hash',
  'agent_sub_budgets.close_tx_hash': 'public transaction hash',
  'agent_passports.tx_hash': 'public transaction hash',
  'agent_passports.revocation_tx_hash': 'public transaction hash',
  'agent_passports.attestation_uid': 'public EAS attestation uid',
  'hybrid_account_passkeys.public_key_x': 'passkey PUBLIC key coordinate',
  'hybrid_account_passkeys.public_key_y': 'passkey PUBLIC key coordinate',
  'agent_delegations.rekey_id': 'foreign key to a re-key record ("rekey" matches /key/), not key material',
}

/** Names that need a review entry before they may be granted. */
export const SENSITIVE_COLUMN_NAME = /hash|token|secret|cipher|password|attestation|delegation_json|signature|key/i

/**
 * Granted columns that may carry provider free text, each with the redaction
 * that guards its writer. The script refuses while any row still holds an
 * unredacted vendor secret in one of them.
 */
export const OPS_FREE_TEXT_COLUMNS: Readonly<Record<string, string>> = {
  'payment_intents.error_message': 'redactVendorSecrets at routes/payments.ts before failSubmittedIntent',
  'outbound_txs.error': 'redactVendorSecrets inside markOutboundTxFailed (#3510)',
  'agent_passports.last_error': 'redactVendorSecrets in modules/passport/issuance.ts before markFailed',
  'agent_passports.revocation_last_error': 'redactVendorSecrets in modules/passport/revocation.ts',
}

/** Names that need a free-text review entry before they may be granted. */
export const FREE_TEXT_COLUMN_NAME = /error|message|reason|detail/i

/**
 * Free-text-shaped names reviewed as NOT provider free text (enum-like or an
 * allowlisted JSON shape), so they need no write-boundary redaction.
 */
export const OPS_REVIEWED_STRUCTURED_COLUMNS: Readonly<Record<string, string>> = {
  'payment_refusals.reason': 'closed classification from classifyRevertForLedger',
  'payment_refusals.detail': 'JSONB with an allowlisted key set (migration 087)',
}

/**
 * Postgres regex for an UNREDACTED vendor secret — the three shapes
 * `redactVendorSecrets` removes, minus their already-redacted forms. Used by
 * the script's refusal guard.
 */
export const UNREDACTED_SECRET_PG_REGEX =
  String.raw`(api[_-]?key|key|token|secret)=(?!REDACTED)[^&[:space:]"'\\)]+` +
  String.raw`|https?://[^[:space:]/@]+:[^[:space:]@]+@` +
  String.raw`|/(rpc|v2)/(?!REDACTED)[A-Za-z0-9_-]{16,}`

export const DEFAULT_OPS_READONLY_ROLE = 'haven_ops_readonly'
export const OPS_READONLY_STATEMENT_TIMEOUT = '5s'
export const OPS_READONLY_CONNECTION_LIMIT = 5

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

function ident(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`${what} ${JSON.stringify(name)} is not a plain lowercase identifier`)
  return `"${name}"`
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * The full, idempotent script for one role on one schema, in one transaction:
 * create the role if missing, refuse while a free-text column holds an
 * unredacted secret, revoke everything, then grant exactly the allowlist.
 * Re-running it after a migration applies the current list.
 */
export function buildOpsReadonlyRoleSql(opts: { role?: string; schema: string }): string {
  const roleName = opts.role ?? DEFAULT_OPS_READONLY_ROLE
  const role = ident(roleName, 'role')
  const schema = ident(opts.schema, 'schema')
  const guards = Object.keys(OPS_FREE_TEXT_COLUMNS).map((qualified) => {
    const [table, column] = qualified.split('.')
    return `EXISTS (SELECT 1 FROM ${schema}.${ident(table, 'table')} WHERE ${ident(column, 'column')} ~* ${literal(UNREDACTED_SECRET_PG_REGEX)})`
  })
  const lines: string[] = [
    '-- Ops console read-only role (#3510). Generated by packages/backend/src/infra/ops-readonly-role.ts.',
    'BEGIN;',
    'DO $ops$',
    'BEGIN',
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(roleName)}) THEN`,
    `    CREATE ROLE ${role} NOLOGIN;`,
    '  END IF;',
    `  IF ${guards.join('\n     OR ')} THEN`,
    `    RAISE EXCEPTION 'ops read-only role: a granted free-text column still holds an unredacted vendor secret; scrub it before granting (see the ops-console runbook)';`,
    '  END IF;',
    'END',
    '$ops$;',
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${role};`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${role};`,
  ]
  for (const [table, columns] of Object.entries(OPS_READONLY_GRANTS)) {
    const cols = columns.map((c) => ident(c, 'column')).join(', ')
    lines.push(`GRANT SELECT (${cols}) ON ${schema}.${ident(table, 'table')} TO ${role};`)
  }
  lines.push(
    `ALTER ROLE ${role} SET default_transaction_read_only = on;`,
    `ALTER ROLE ${role} SET statement_timeout = ${literal(OPS_READONLY_STATEMENT_TIMEOUT)};`,
    `ALTER ROLE ${role} CONNECTION LIMIT ${OPS_READONLY_CONNECTION_LIMIT};`,
    'COMMIT;',
  )
  return `${lines.join('\n')}\n`
}
