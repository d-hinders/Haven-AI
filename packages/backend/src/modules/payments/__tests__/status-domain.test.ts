/**
 * Characterization + guard: what `GET /payments/:id` can actually say (#2115).
 *
 * ## What this file licenses
 *
 * The deletion of `messageForRail` from `agent-payment-status.ts`. That
 * function overrode the payment intent's own message on the x402 and MPP rails
 * for four statuses — `pending`, `approved`, `proposed`, `executed` — with
 * prose telling an agent to hold its merchant session open and poll for a user
 * approval. No live rail can produce any of those statuses, and no live rail
 * has an approval to wait for.
 *
 * ## Why a real database rather than a mock
 *
 * The claim is *what values a column can hold*, which
 * `docs/contributing/testing-strategy.md` (epic #1219) puts on real Postgres by
 * rule. It matters here more than usual: `payment_intents.status` is a plain
 * `VARCHAR(20)` with **no CHECK constraint** (migration `000_initial`), so the
 * domain is not enforced by the schema — it is a property of the writes. A
 * mocked pool would assert the author's belief about those writes, which is
 * exactly the reasoning this file replaces. Zero mocks; real Postgres (#1220).
 *
 * ## The two halves of the argument
 *
 * 1. **Structural** — every `status = '…'` literal in the repository layer that
 *    writes this table is one of five values. That is what makes the other
 *    statuses unconstructible rather than merely unobserved.
 * 2. **Behavioural** — seeded rows, read back through `getAgentPaymentStatus`,
 *    and the emitted `message` / `next_action` asserted by VALUE. The retired
 *    statuses are seeded too (the DB permits them; nothing in the app writes
 *    them) to pin the fail-closed answer: if a pre-retirement row is ever read
 *    back, the verdict is stop, and the word "approval" does not appear.
 */
import { readFileSync } from 'node:fs'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { getAgentPaymentStatus } from '../agent-payment-status.js'
import { type AgentContext } from '../../../middleware/agentAuth.js'

/**
 * The whole reachable domain. Four INSERTs write `'pending_signature'`; the
 * UPDATEs write these four others. Anything else is unconstructible.
 */
const REACHABLE_STATUSES = ['pending_signature', 'submitted', 'confirmed', 'expired', 'failed']

/**
 * The `approval_requests` statuses `messageForRail` used to override on. They
 * were fed here by `approvalState`, which #2055 deleted with the table.
 */
const RETIRED_STATUSES = ['pending', 'approved', 'proposed', 'executed']

/** Every non-test source file that writes `payment_intents.status`. */
const STATUS_WRITER_FILES = [
  'src/infra/repositories/payment-intents.ts',
  'src/infra/repositories/x402-authorizations.ts',
  'src/infra/repositories/agent-rekeys.ts',
]

/**
 * Every `INSERT INTO payment_intents` / `UPDATE payment_intents` statement in a
 * source file, as raw SQL text up to the end of its template literal.
 *
 * Scoped to WRITES against this one table on purpose. A file-wide scan for
 * `status = '…'` also picks up sibling tables — `agent_rekeys` (`pending`,
 * `replaced`) and the reconciliation-event join (`open`) both live in these
 * files — and would report a status domain that has nothing to do with
 * `payment_intents`.
 */
function writeStatements(file: string): string[] {
  const source = readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8')
  return [...source.matchAll(/(?:UPDATE|INSERT\s+INTO)\s+payment_intents\b[^`]*/g)].map((m) => m[0])
}

let seq = 0

/** Seeds a row and hands back both halves the read needs. */
async function seed(status: string, rail: string): Promise<{ agent: AgentContext; paymentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`status-domain-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agentRow = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'status domain agent') RETURNING id`,
    [userId],
  )
  const agentId = agentRow.rows[0].id
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, source, payment_rail)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000c1',
             '100000', '0.10', '0x00000000000000000000000000000000000000d1',
             0, '0xsign', $3, NOW() + interval '10 minutes', $4, $4)
     RETURNING id`,
    [agentId, userId, status, rail],
  )
  return {
    agent: {
      id: agentId,
      user_id: userId,
      name: 'status domain agent',
      delegate_address: '0x00000000000000000000000000000000000000d1',
      safe_address: '0x00000000000000000000000000000000000000f1',
      chain_id: 8453,
      status: 'active',
    },
    paymentId: intent.rows[0].id,
  }
}

describeDb('#2115 — the payment-status response cannot promise an approval', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  // ── 1. Structural: the reachable status domain ──────────────────────────

  it('every status literal in the repository layer is one of the five reachable values', () => {
    // `payment_intents.status` has no CHECK constraint, so the domain is a
    // property of the writes, not of the schema. Collect every `status = '…'`
    // literal across the files that touch the table — assignments and guards
    // alike — and assert the set. A new literal (a resurrected queue state, or
    // a genuinely new lifecycle state) has to confront this test.
    const seen = new Set<string>()
    for (const file of STATUS_WRITER_FILES) {
      for (const statement of writeStatements(file)) {
        for (const match of statement.matchAll(/\bstatus\s*=\s*'([a-z_]+)'/g)) seen.add(match[1])
      }
    }
    expect([...seen].sort()).toEqual([...REACHABLE_STATUSES].sort())
  })

  it('the four INSERTs all write pending_signature and name no retired status', async () => {
    const {
      INSERT_DELEGATION_INTENT_SQL,
      INSERT_LEGACY_INTENT_SQL,
      INSERT_SEND_INTENT_SQL,
      INSERT_MACHINE_INTENT_X402_KEY_SQL,
      INSERT_MACHINE_INTENT_MACHINE_KEY_SQL,
    } = await import('../../../infra/repositories/payment-intents.js')
    for (const sql of [
      INSERT_DELEGATION_INTENT_SQL,
      INSERT_LEGACY_INTENT_SQL,
      INSERT_SEND_INTENT_SQL,
      INSERT_MACHINE_INTENT_X402_KEY_SQL,
      INSERT_MACHINE_INTENT_MACHINE_KEY_SQL,
    ]) {
      expect(sql).toContain("'pending_signature'")
      for (const retired of RETIRED_STATUSES) expect(sql).not.toContain(`'${retired}'`)
    }
  })

  it('there is no approval_requests table a status could be read back from', async () => {
    // The closing half: #2055's migration 070 dropped it, so the statuses
    // `messageForRail` branched on have no source left at all.
    const { rows } = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'approval_requests'
       ) AS exists`,
    )
    expect(rows[0].exists).toBe(false)
  })

  // ── 2. Behavioural: what each reachable status actually says ────────────

  const EXPECTED: Record<string, { message: string; nextAction: string; phase: string }> = {
    pending_signature: {
      message: 'Haven is waiting for the agent to sign and submit this payment.',
      nextAction: 'sign_and_submit_payment',
      phase: 'agent_signature_required',
    },
    submitted: {
      message: 'The payment was submitted and is waiting for confirmation.',
      nextAction: 'check_status_later',
      phase: 'payment_submitted',
    },
    confirmed: {
      message: 'The payment is confirmed.',
      nextAction: 'none',
      phase: 'payment_confirmed',
    },
    expired: {
      message: 'The payment expired before it was completed.',
      nextAction: 'request_again_if_user_still_wants_it',
      phase: 'expired',
    },
    failed: {
      message: 'The payment failed.',
      nextAction: 'stop_and_tell_user',
      phase: 'failed',
    },
  }

  for (const rail of ['x402', 'mpp']) {
    for (const status of REACHABLE_STATUSES) {
      it(`${rail}/${status} answers the payment-intent message, with no rail override`, async () => {
        const { agent, paymentId } = await seed(status, rail)
        const result = await getAgentPaymentStatus(agent, paymentId)
        expect(result).not.toBeNull()
        expect(result?.rail).toBe(rail)
        expect(result?.status).toBe(status)
        expect(result?.message).toBe(EXPECTED[status].message)
        expect(result?.next_action).toBe(EXPECTED[status].nextAction)
        expect(result?.phase).toBe(EXPECTED[status].phase)
      })
    }
  }

  // ── 3. Behavioural: the retired statuses, fail-closed ───────────────────

  for (const rail of ['x402', 'mpp']) {
    for (const status of RETIRED_STATUSES) {
      it(`${rail}/${status} tells the agent to stop, and never mentions an approval`, async () => {
        // These rows cannot be created by any live code path (part 1). They are
        // seeded here directly to pin what the module WOULD say — because
        // `messageForRail` used to answer this case with "waiting for user
        // approval in Haven … poll this payment id and resume … after
        // approval", which the SDK passes straight through to the agent
        // (`mapPaymentStatusResult`).
        const { agent, paymentId } = await seed(status, rail)
        const result = await getAgentPaymentStatus(agent, paymentId)
        expect(result?.message).toBe(
          `This payment is in an unrecognised state ("${status}") that no live Haven rail produces. ` +
            'Do not poll or retry it — tell the user to review this payment in Haven.',
        )
        expect(result?.next_action).toBe('stop_and_tell_user')
        // Not `approv` — the status NAME is interpolated, so "approved"
        // legitimately appears. What must not appear is the promise: the noun
        // "approval", and the poll instruction that used to accompany it.
        expect(result?.message.toLowerCase()).not.toContain('approval')
        expect(result?.message.toLowerCase()).not.toContain('waiting for')
        expect(result?.message.toLowerCase()).not.toContain('poll this payment')
      })
    }
  }

  it('the module source carries no rail-specific status message at all', async () => {
    // The behavioural assertions above would still pass if someone reinstated
    // `messageForRail` for a status not seeded here. Pin the absence directly:
    // the reachable messages come from `paymentIntentState`, and the call site
    // passes `state.message` through unmodified.
    const source = readFileSync(new URL('../agent-payment-status.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('function messageForRail')
    expect(source).toContain('message: state.message,')
  })

  // ── 4. Positive controls ────────────────────────────────────────────────

  it('POSITIVE CONTROL: the read path is actually sensitive to the seeded status', async () => {
    // Every assertion above compares an emitted message to an expected one. If
    // the seeding helper silently wrote one status for all of them, or if the
    // read collapsed to a constant, the whole table would pass vacuously.
    // Prove the messages are pairwise DISTINCT across the domain, read back
    // through the same path.
    const messages: string[] = []
    for (const status of [...REACHABLE_STATUSES, RETIRED_STATUSES[0]]) {
      const { agent, paymentId } = await seed(status, 'x402')
      const result = await getAgentPaymentStatus(agent, paymentId)
      messages.push(result?.message ?? '')
    }
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('POSITIVE CONTROL: the status-literal scan can see a literal that is really there', async () => {
    // The structural test asserts a set is EXACTLY the five reachable values.
    // A regex that matched nothing would produce an empty set and fail loudly
    // — but a regex that matched nothing in ONE of the three files would not.
    // Assert each file contributes at least one literal.
    for (const file of STATUS_WRITER_FILES) {
      const statements = writeStatements(file)
      expect(statements.length, `${file} contributed no payment_intents write — the scan is blind there`)
        .toBeGreaterThan(0)
      const hits = statements.flatMap((s) => [...s.matchAll(/\bstatus\s*=\s*'([a-z_]+)'/g)])
      expect(hits.length, `${file} contributed no status literal — the scan is blind there`)
        .toBeGreaterThan(0)
    }
  })
})
