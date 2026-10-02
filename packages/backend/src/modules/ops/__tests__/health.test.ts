/**
 * `GET /ops/health` (#3514, epic #3507) — the system-health read's building
 * blocks, against a real Postgres. What is pinned here, beyond the SQL (the
 * reused queries' real-DB behaviour lives with their repositories):
 *
 * - `buildOpsHealth` reuses the monitors' own repository functions with the
 *   arguments their existing callers pass, and projects every row into an
 *   explicit positive projection — the raw row (which carries
 *   `machine_metadata` and `delegation_hash`) never reaches the payload;
 * - the delegate balance section is the monitor's injected LAST report, or
 *   `not_available_on_this_replica` — never a scan;
 * - an empty database answers empty lists;
 * - `collectStuckLanesForChain` labels lanes by the predicate
 *   `cancelStuckOutboundLane` answers to, composed from the same exported
 *   constants (characterisation: the cancel path's own tests pin that path;
 *   this pins that the ops read and it read the SAME definitions).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { seedOpsAgent, seedOpsIntent, seedOpsUser } from '../../../infra/__tests__/helpers/ops-fixtures.js'
import { buildOpsHealth, collectStuckLanesForChain } from '../health.js'
import { OPS_HEALTH_LIST_LIMIT } from '../health.js'
import type { HealthOpsPayload } from '../../../routes/health-payload-types.js'
import type { DelegateBalanceReport } from '../../../domain/delegate-balance.js'
import type { Executor } from '../../../infra/transaction.js'
import {
  MAX_BUMPS_PER_NONCE,
  REBROADCAST_SAFE_SUBMITTERS,
  STALE_BROADCAST_SECONDS,
} from '../../../domain/outbound-lane-policy.js'

const DIAGNOSTICS: HealthOpsPayload = {
  relayer: [],
  passport: {
    verification: { configured: false, issuer: null },
    chains: [],
    unverifiableChainIds: [],
  },
  trustProxy: { hops: 0, authRateLimitArmed: false },
  accounting: { exhaustedSyncs: null, connectionsNeedingAttention: null, webhookCounters: null, unavailable: true },
  request_validation: {
    mode: 'off',
    wouldRefuse: 0,
    wouldCoerce: 0,
    byRouteField: {},
    coerceByRouteField: {},
    since: '2026-10-02T00:00:00.000Z',
    seenByRoute: {},
  },
}

const buildDeps = (report: DelegateBalanceReport | null = null) => ({
  buildOpsDiagnostics: async () => DIAGNOSTICS,
  lastDelegateBalanceReport: () => report,
})

/** The builder's clock comes from the DB for the reused SQL; derive the test's NOW from it. */
const NOW: number = await (async () => {
  const { rows } = await db.query<{ now: Date }>(`SELECT now() AS now`)
  return new Date(rows[0].now).getTime()
})()

/** One ERC-7710 settlement_scheme intent, sweepable per the reused SQL. */
async function seedSweepableIntent(opts: { ageSeconds: number }): Promise<string> {
  const userId = await seedOpsUser()
  const agentId = await seedOpsAgent(userId)
  const age = new Date(NOW - opts.ageSeconds * 1000).toISOString()
  const { rows } = await db.query<{ id: string }>(
    `UPDATE payment_intents
        SET status = 'submitted', tx_hash = NULL, payment_rail = 'x402', execution_rail = 'delegation',
            machine_metadata = $2::jsonb, delegation_hash = $3
      WHERE id = $1
      RETURNING id`,
    [
      await seedOpsIntent(userId, agentId, { status: 'submitted', createdAt: age }),
      JSON.stringify({ settlement_scheme: 'erc7710' }),
      '0x' + 'dd'.repeat(32),
    ],
  )
  return rows[0].id
}

async function seedOutboundTx(opts: {
  chainId: number
  submitter: string
  nonce: number
  status?: string
  ageSeconds: number
  attempts?: number
}): Promise<string> {
  const attempts = opts.attempts ?? 0
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO outbound_txs (chain_id, submitter, to_address, data, value_atomic, status, nonce, tx_hash, updated_at)
     VALUES ($1, $2, $3, '0x', '0', $4, $5, $6, NOW() - ($7 * interval '1 second'))
     RETURNING id`,
    [
      opts.chainId,
      opts.submitter,
      '0x' + '22'.repeat(20),
      opts.status ?? 'broadcast',
      opts.nonce,
      '0x' + (opts.nonce.toString(16).padStart(4, '6')),
      opts.ageSeconds,
    ],
  )
  // Attempt rows (`replaced`/`failed` at the same nonce) feed the lane cap.
  for (let i = 0; i < attempts; i++) {
    await db.query(
      `INSERT INTO outbound_txs (chain_id, submitter, to_address, data, value_atomic, status, nonce, error)
       VALUES ($1, $2, $3, '0x', '0', 'failed', $4, 'bump broadcast failed')`,
      [opts.chainId, opts.submitter, '0x' + '22'.repeat(20), opts.nonce],
    )
  }
  return rows[0].id
}

describeDb('ops system-health builder (#3514)', () => {
  const ONE_CHAIN = [84532]
  const created: string[] = []

  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    created.length = 0
  })

  async function seedEachKind(): Promise<void> {
    // 1. sweepable in_window: 2 h old, inside the sweeper's 24 h horizon.
    created.push(await seedSweepableIntent({ ageSeconds: 2 * 60 * 60 }))
    // 2. sweepable past_horizon: 2 days old — the sweeper no longer retries it.
    created.push(await seedSweepableIntent({ ageSeconds: 2 * 24 * 60 * 60 }))
    // 3. a stuck revocation: agent revoked, passport still anchored, 2 h old.
    const userId = await seedOpsUser()
    const agentId = await seedOpsAgent(userId)
    await db.query(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [agentId])
    await db.query(
      `INSERT INTO agent_passports (agent_id, chain_id, status, attestation_uid, revocation_requested_at, revocation_attempts)
       VALUES ($1, 84532, 'anchored', $2, NOW() - interval '2 hours', 2)`,
      [agentId, '0x' + 'aa'.repeat(32)],
    )
    // 4. a stuck lane at the cap, and one below it, on the walked chain.
    created.push(await seedOutboundTx({ chainId: 84532, submitter: 'sweep', nonce: 7, ageSeconds: STALE_BROADCAST_SECONDS * 10, attempts: MAX_BUMPS_PER_NONCE }))
    created.push(await seedOutboundTx({ chainId: 84532, submitter: 'sweep', nonce: 8, ageSeconds: STALE_BROADCAST_SECONDS * 10 }))
    // 5. a young lane: below the stale threshold — not a stuck lane.
    created.push(await seedOutboundTx({ chainId: 84532, submitter: 'sweep', nonce: 9, ageSeconds: 10 }))
  }

  it('seeds one row of each kind and projects each into the payload, labelled by the reused predicates', async () => {
    await seedEachKind()

    const health = await buildOpsHealth(db, buildDeps(null), () => ONE_CHAIN)

    expect(health.sweepable_intents.map((i) => i.window).sort()).toEqual(['in_window', 'past_horizon'])
    const past = health.sweepable_intents.find((i) => i.window === 'past_horizon')
    expect(past).toBeDefined()
    expect(past!.id).toBeTruthy()
    expect(past!.amount_human).toBeTruthy()
    // Positive projection: nothing of the raw row's secret-shaped columns.
    for (const intent of health.sweepable_intents) {
      expect(Object.keys(intent).sort()).toEqual([
        'agent_id', 'age_seconds', 'amount_human', 'chain_id', 'id', 'status', 'token_symbol', 'window',
      ].sort())
    }
    expect(health.stuck_revocations).toHaveLength(1)
    expect(health.stuck_revocations[0].revocation_attempts).toBe(2)
    expect(health.stuck_revocations[0].age_seconds).toBeGreaterThanOrEqual(3600)
    // The capped lane is the operator's; the uncapped one is still the worker's.
    expect(health.stuck_lanes).toHaveLength(2)
    expect(health.stuck_lanes.map((l) => l.reason).sort()).toEqual(['capped_needs_operator', 'stale_unmined'])
    expect(health.stuck_lanes.every((l) => l.chain_id === 84532)).toBe(true)
    // The young lane never appears.
    const young = created[created.length - 1]
    expect(health.stuck_lanes.map((l) => l.id)).not.toContain(young)
    // Diagnostics ride along, built by the injected builder.
    expect(health.ops_diagnostics).toEqual(DIAGNOSTICS)
  })

  it('an empty database answers empty lists and the not-available delegate section', async () => {
    const health = await buildOpsHealth(db, buildDeps(null), () => ONE_CHAIN)
    expect(health.sweepable_intents).toEqual([])
    expect(health.evidence_orphans).toEqual([])
    expect(health.stuck_revocations).toEqual([])
    expect(health.stuck_reanchors).toEqual([])
    expect(health.stuck_lanes).toEqual([])
    expect(health.delegate_balances).toEqual({ available: false, reason: 'not_available_on_this_replica' })
  })

  it('the delegate section projects the injected report — counts, lingering balances, atomic strings', async () => {
    const report: DelegateBalanceReport = {
      findings: [
        {
          agentId: '00000000-0000-4000-8000-000000000001',
          agentName: 'Scout',
          delegateAddress: '0x' + '33'.repeat(20),
          chainId: 84532,
          balanceAtomic: 1234567n,
          state: 'lingering',
        },
      ],
      dustTotalAtomic: 42n,
      dustAlert: false,
      lingering: [
        {
          agentId: '00000000-0000-4000-8000-000000000001',
          agentName: 'Scout',
          delegateAddress: '0x' + '33'.repeat(20),
          chainId: 84532,
          balanceAtomic: 1234567n,
          state: 'lingering',
        },
      ],
      unread: [{ agentId: '00000000-0000-4000-8000-000000000002', chainId: 84532 }],
      chainErrors: {},
      scannedAt: '2026-10-02T11:00:00.000Z',
    }

    const health = await buildOpsHealth(db, buildDeps(report), () => ONE_CHAIN)
    expect(health.delegate_balances).toEqual({
      available: true,
      scanned_at: '2026-10-02T11:00:00.000Z',
      report: {
        scanned_delegates: 1,
        unread: 1,
        lingering: [
          {
            agent_id: '00000000-0000-4000-8000-000000000001',
            agent_name: 'Scout',
            delegate_address: '0x' + '33'.repeat(20),
            chain_id: 84532,
            balance_atomic: '1234567',
          },
        ],
        dust_total_atomic: '42',
        dust_alert: false,
        chain_errors: {},
      },
    })
  })

  it('every stuck list is capped at the ops glance limit', async () => {
    const userId = await seedOpsUser()
    for (let i = 0; i < OPS_HEALTH_LIST_LIMIT + 5; i++) {
      const agentId = await seedOpsAgent(userId)
      await db.query(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [agentId])
      await db.query(
        `INSERT INTO agent_passports (agent_id, chain_id, status, attestation_uid, revocation_requested_at, revocation_attempts)
         VALUES ($1, 84532, 'anchored', $2, NOW() - interval '2 hours', 1)`,
        [agentId, '0x' + 'bb'.repeat(31) + String(i).padStart(2, '0')],
      )
    }
    const health = await buildOpsHealth(db, buildDeps(null), () => ONE_CHAIN)
    expect(health.stuck_revocations).toHaveLength(OPS_HEALTH_LIST_LIMIT)
  })

  it('collectStuckLanesForChain claims nothing: the read runs as a plain SELECT and never leases a row', async () => {
    const id = await seedOutboundTx({ chainId: 84532, submitter: 'sweep', nonce: 11, ageSeconds: STALE_BROADCAST_SECONDS * 10 })
    await collectStuckLanesForChain(db, 84532, NOW)
    const { rows } = await db.query<{ claimed_at: Date | null }>(`SELECT claimed_at FROM outbound_txs WHERE id = $1`, [id])
    expect(rows[0].claimed_at).toBeNull()
  })

  it('a NON-rebroadcast-safe stuck lane is stale_unmined, not capped — the cap only reads rebroadcast-safe rows', async () => {
    // passport_attest is deliberately absent from REBROADCAST_SAFE_SUBMITTERS.
    expect(REBROADCAST_SAFE_SUBMITTERS.has('passport_attest')).toBe(false)
    await seedOutboundTx({ chainId: 84532, submitter: 'passport_attest', nonce: 12, ageSeconds: STALE_BROADCAST_SECONDS * 10, attempts: MAX_BUMPS_PER_NONCE + 2 })
    const lanes = await collectStuckLanesForChain(db, 84532, NOW)
    expect(lanes).toHaveLength(1)
    expect(lanes[0].reason).toBe('stale_unmined')
  })
})
