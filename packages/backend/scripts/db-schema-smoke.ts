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
 * Run (needs DATABASE_URL): npm run db:schema-smoke -w @haven/backend
 */

import { getPool } from '../src/db.js'
import { runMigrations } from '../src/db/migrate.js'

interface SmokeQuery {
  name: string
  sql: string
}

/**
 * Curated money-path queries. `$N` params are fine — PREPARE type-checks them.
 * Keep each verbatim from its source so the check tracks the real query.
 */
const QUERIES: SmokeQuery[] = [
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
    name: 'recipients: loadAgentRecipients with allowance-budget inheritance (#784)',
    sql: `SELECT r.recipient_address, r.token_address, r.label, r.budget_amount,
                 a.allowance_amount
          FROM agent_recipients r
          LEFT JOIN agent_allowances a
            ON a.agent_id = r.agent_id AND a.token_address = r.token_address
          WHERE r.agent_id = $1 AND LOWER(r.token_address) = LOWER($2)
          ORDER BY r.created_at, r.id`,
  },
  {
    name: 'schedule: window + policy inputs for lazy rollover (#769)',
    sql: `SELECT a.session_schedule_from_period, a.session_schedule_period_count,
                 a.session_permission_id, a.delegate_address,
                 al.reset_period_min
          FROM agents a
          LEFT JOIN agent_allowances al
            ON al.agent_id = a.id AND LOWER(al.token_address) = LOWER($2)
          WHERE a.id = $1`,
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
    name: 'payments: delegation intent insert (rail + delegation pinned, #829)',
    sql: `INSERT INTO payment_intents (
            agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
            to_address, amount_raw, amount_human, delegate_address,
            allowance_nonce, sign_hash,
            execution_rail, delegation_hash, prepared_user_op,
            status, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            'pending_signature', NOW() + interval '10 minutes')
          RETURNING *`,
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
