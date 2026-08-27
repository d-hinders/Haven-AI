/**
 * Characterization: the approval-keyed EVIDENCE/RECONCILIATION WRITE path is
 * unreachable, while every READ of `approval_request_id` still works (#2118,
 * epic #1440).
 *
 * This file exists to be written BEFORE the write builders are deleted, per
 * `money.md` §2 — `infra/repositories/**` is on the money-path perimeter, and
 * the claim being pinned is about what the DATABASE does, so it belongs on the
 * real-Postgres harness rather than in a positional-mock route test
 * (`docs/contributing/testing-strategy.md`, epic #1219).
 *
 * The two halves are deliberately asymmetric, because the risk is:
 *
 *   1. WRITE side — no caller can supply `'approval_request_id'`. Proven
 *      structurally by reading the call sites, not by asserting on a mock.
 *   2. READ side — a historical row that carries `approval_request_id` and a
 *      NULL `payment_intent_id` still surfaces through `GET /receipts` with
 *      `payment_id` set. THIS is the one that bites: migration 070 dropped
 *      `approval_requests` with CASCADE *specifically* so these rows would
 *      survive holding their values, and `mapEvidence` uses the column as
 *      their only `payment_id` anchor. Delete the column or the fallback and
 *      every pre-#2055 receipt silently returns `payment_id: null`.
 *
 * Half 2 must keep passing forever. Half 1 is the licence to delete.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { listEvidenceReceiptsForAgent } from '../machine-payments.js'
import { mapEvidence, type MachinePaymentEvidenceRow } from '../../../modules/mpp/evidence.js'

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

let seq = 0
const ADDR = (n: string) => `0x${n.repeat(40).slice(0, 40)}`

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`ar-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'legacy-era agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

/**
 * A pre-#2055 evidence row: anchored on `approval_request_id`, with NO
 * payment intent. Inserted with raw SQL on purpose — the repository helper
 * that used to write this shape is exactly what #2118 removes, so building it
 * through the helper would make this test disappear along with the thing it
 * is guarding against.
 */
async function seedHistoricalApprovalEvidence(
  agentId: string,
  userId: string,
  approvalRequestId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO machine_payment_evidence (
       payment_intent_id, approval_request_id, agent_id, user_id, rail, proof_status,
       tx_hash, chain_id, resource_url, merchant_address, payer_address,
       settlement_address, token_symbol, token_address, amount_raw, amount_human
     ) VALUES (
       NULL, $1, $2, $3, 'x402', 'payment_confirmed',
       $4, 8453, 'https://merchant.example/paid', $5, $6,
       $7, 'USDC', $8, '1000000', '1.000000'
     )`,
    [
      approvalRequestId,
      agentId,
      userId,
      `0x${'a'.repeat(64)}`,
      ADDR('1'),
      ADDR('2'),
      ADDR('3'),
      ADDR('4'),
    ],
  )
}

describeDb('approval-keyed reference: writes unreachable, reads intact (#2118)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  // ── Half 1: the WRITE path cannot be reached ────────────────────────────
  //
  // These were first written against the PRE-deletion shape (a two-member
  // union that callers narrowed to one). #2118 removed the union, so the
  // guarantee is now structural rather than conventional and the assertions
  // say so. The anti-tautology guard is the LAST test in this block: it fails
  // if the deletion is ever widened into the read path.

  it('the repository exposes no reference-column union to select an approval write with', () => {
    const repo = src('../machine-payments.ts')

    expect(repo).not.toMatch(/export type EvidenceReferenceColumn/)
    // The five approval-anchored statements are gone by name.
    for (const constant of [
      'UPSERT_EVIDENCE_BASE_FOR_APPROVAL_SQL',
      'ATTACH_EVIDENCE_FOR_APPROVAL_SQL',
      'UPSERT_RECONCILIATION_EVENT_FOR_APPROVAL_SQL',
      'FIND_RECONCILIATION_EVENT_FOR_APPROVAL_SQL',
      'RESOLVE_RECONCILIATION_FOR_APPROVAL_SQL',
    ]) {
      expect(repo, `${constant} is back`).not.toContain(constant)
    }
  })

  it('no production module names approval_request_id as a write target', () => {
    // The shapes a re-introduction would take: an object property, a
    // positional argument, or an ON CONFLICT / WHERE clause keyed on it.
    for (const rel of [
      '../machine-payments.ts',
      '../../../modules/mpp/evidence.ts',
      '../../../modules/mpp/reconciliation.ts',
    ]) {
      const body = src(rel)
      expect(body, `${rel}: approval column selected as a write target`).not.toMatch(
        /(referenceColumn|conflictColumn)\s*[:=]\s*'approval_request_id'/,
      )
      expect(body, `${rel}: approval column passed positionally`).not.toMatch(
        /\(\s*'approval_request_id'\s*[,)]/,
      )
      expect(body, `${rel}: statement keyed on the approval column`).not.toMatch(
        /ON CONFLICT \(approval_request_id/,
      )
    }
  })

  it('the evidence INSERT still WRITES the approval_request_id column (always NULL) — the deletion stopped here', () => {
    // Anti-tautology guard, and the reason it is in the WRITE half: it would
    // be easy to "finish the job" by stripping the column from the INSERT
    // entirely. That would break nothing in this file's write assertions and
    // silently orphan every historical row's anchor. The column must stay in
    // the statement even though only NULL is ever written to it.
    const repo = src('../machine-payments.ts')
    expect(repo).toMatch(/INSERT INTO machine_payment_evidence \([^)]*approval_request_id/s)
    expect(repo).toMatch(
      /INSERT INTO machine_payment_reconciliation_events \([^)]*approval_request_id/s,
    )
    // …and the input type pins it to null, so no caller can supply one.
    expect(repo).toMatch(/approvalRequestId: null/)
  })

  // ── Half 2: the READ path must survive the deletion ─────────────────────

  it('a historical approval-anchored evidence row still lists, and keeps its payment_id anchor', async () => {
    const agent = await seedAgent()
    const approvalRequestId = '11111111-2222-3333-4444-555555555555'
    await seedHistoricalApprovalEvidence(agent.agentId, agent.userId, approvalRequestId)

    const rows = await listEvidenceReceiptsForAgent<MachinePaymentEvidenceRow>(
      agent.agentId,
      50,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].payment_intent_id).toBeNull()
    expect(rows[0].approval_request_id).toBe(approvalRequestId)

    // The assertion the whole issue turns on: `payment_id` falls back to the
    // approval id. If this ever reads null, every pre-#2055 receipt has lost
    // its anchor and the deletion went too far.
    const mapped = mapEvidence(rows[0])
    expect(mapped.payment_id).toBe(approvalRequestId)
    expect(mapped.approval_request_id).toBe(approvalRequestId)
    expect(mapped.payment_intent_id).toBeNull()
  })

  it('the approval_request_id COLUMN still exists on both evidence tables', async () => {
    const cols = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name = 'approval_request_id'
        ORDER BY table_name`,
    )
    const tables = cols.rows.map((r) => r.table_name)
    expect(tables).toContain('machine_payment_evidence')
    expect(tables).toContain('machine_payment_reconciliation_events')
  })

  it('the approval_requests TABLE is gone — so nothing could anchor a NEW write to one', async () => {
    const t = await db.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'approval_requests'`,
    )
    expect(t.rows).toHaveLength(0)
  })
})
