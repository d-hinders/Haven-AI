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
  FIND_SETUP_BY_AGENT_API_KEY_SQL,
  FIND_SETUP_BY_TOKEN_HASH_SQL,
  FIND_SETUP_FOR_USER_SQL,
  FIND_USER_SAFE_BY_ID_SQL,
  INSERT_AGENT_SQL,
  INSERT_SETUP_ALLOWANCE_SQL,
  INSERT_SETUP_SQL,
  LIST_ACTIVE_DELEGATIONS_SQL,
  LIST_SETUP_ALLOWANCES_SQL,
  LOCK_SETUP_FOR_USER_SQL,
  MARK_SETUP_REGISTERED_SQL,
  MERGE_INSTALL_STATUS_SQL,
  REVOKE_PENDING_AGENT_SQL,
  UPDATE_APPROVAL_STATE_SQL,
  UPDATE_CONNECTOR_METADATA_SQL,
} from '../src/infra/repositories/agent-connection-setups.js'

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
    name: 'x402: exact-amount idempotency reload',
    sql: `SELECT * FROM payment_intents
          WHERE agent_id = $1
            AND (x402_idempotency_key = $2 OR machine_idempotency_key = $2)
            AND COALESCE(payment_rail, source) = 'x402'
            AND status <> 'failed'
          ORDER BY created_at DESC`,
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
    name: 'evidence: post-settle residue reconciliation insert',
    sql: `INSERT INTO machine_payment_reconciliation_events (
            agent_id, user_id, payment_intent_id, rail, event_type, tx_hash,
            resource_url, merchant_address, reason, details
          ) VALUES ($1, $2, $3, $4, 'delegate_residue_after_settlement', $5, $6, $7, $8, $9)
          ON CONFLICT (payment_intent_id, event_type)
            WHERE payment_intent_id IS NOT NULL
          DO UPDATE SET details = EXCLUDED.details, updated_at = NOW()`,
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
    name: 'payments: delegation intent insert (rail + delegation pinned, #829; budget hash #1059)',
    sql: `INSERT INTO payment_intents (
            agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
            to_address, amount_raw, amount_human, delegate_address,
            allowance_nonce, sign_hash,
            execution_rail, delegation_hash, budget_delegation_hash, prepared_user_op,
            status, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
            'pending_signature', NOW() + interval '10 minutes')
          RETURNING *`,
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
