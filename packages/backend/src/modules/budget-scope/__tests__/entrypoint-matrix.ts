/**
 * #3620 (epic #3615 S-E) — the entrypoint × scope × request-state matrix.
 *
 * One table names what every budget-deciding entrypoint answers for every
 * scope in every request state. `entrypoint-matrix.test.ts` fails on any
 * cell without an entry, and `entrypoint-matrix.db.test.ts` runs every
 * applicable cell through the real route against a real database and
 * compares the answer with the entry. A new scope (a member added to
 * `BUDGET_SCOPE_KINDS`) or a new entrypoint therefore cannot ship until each
 * of its cells has a decision.
 *
 * Request states, as the executor builds them:
 *
 * - `fresh`: a new idempotency key, and a request OVER the narrowest link the
 *   scope redeems while every other link is ample: B's grant for a
 *   sub-budget, the task budget's parent for a task budget, the selected
 *   (token, recipient) grant otherwise. A pre-check that reads the wrong link,
 *   or the wrong scope, lets it through.
 * - `settledReplay`: the same key as a row that CONFIRMED with a `tx_hash`,
 *   replayed after every link went short.
 * - `pendingReplay`: the same key as an unexpired `pending_signature` row the
 *   entrypoint itself created, replayed after every link went short.
 * - `terminalReplay`: the same key as a row that is neither pending nor
 *   confirmed (`failed`), replayed after every link went short.
 *
 * Scope columns: every member of `BUDGET_SCOPE_KINDS`, plus `merchantPin`, a
 * `none` scope whose selected grant is recipient-pinned to the merchant paid.
 */
import { BUDGET_SCOPE_KINDS } from '../index.js'

export const MATRIX_ENTRYPOINTS = ['payments', 'x402-erc7710', 'x402-funding', 'budget-precheck'] as const
export type MatrixEntrypoint = (typeof MATRIX_ENTRYPOINTS)[number]

export const MATRIX_SCOPES = [...BUDGET_SCOPE_KINDS, 'merchantPin'] as const
export type MatrixScope = (typeof MATRIX_SCOPES)[number]

export const MATRIX_STATES = ['fresh', 'settledReplay', 'pendingReplay', 'terminalReplay'] as const
export type MatrixState = (typeof MATRIX_STATES)[number]

/**
 * An applicable cell's observed answer, normalised by `observe()` in the
 * executor: `"<status> <error_code>"` for a typed refusal,
 * `"200 sufficient"` / `"200 sufficient replay"` / `"403 delegation_budget_exceeded"`
 * for the pre-check, `"201 sign_data"` for a signable answer,
 * `"200 stored"` for a stored settled result, else `"<status>"`.
 */
export interface MatrixCell {
  outcome: string
  /** Why this is the right answer, with the decision or issue it rests on. */
  why: string
}

/** A cell the entrypoint cannot express, with the reason. */
export interface NotApplicableCell {
  notApplicable: string
}

export type MatrixEntry = MatrixCell | NotApplicableCell

export function isNotApplicable(entry: MatrixEntry): entry is NotApplicableCell {
  return 'notApplicable' in entry
}

const REFUSED = '403 delegation_budget_exceeded'

const fresh = (link: string, decision: string): MatrixCell => ({
  outcome: REFUSED,
  why: `over ${link}: refused before anything is signable (${decision})`,
})
const settled = (why: string): MatrixCell => ({ outcome: '200 stored', why })
const pending = (why: string): MatrixCell => ({ outcome: '201 sign_data', why })
const terminalFreesKey = (why: string): MatrixCell => ({ outcome: REFUSED, why })

/** The three rows that create their own intents share their replay answers. */
function authorizeRow(
  freshCells: Record<MatrixScope, MatrixCell>,
  replay: { settled: string; pending: string; terminal: string },
): Record<string, Record<MatrixState, MatrixEntry>> {
  const row: Record<string, Record<MatrixState, MatrixEntry>> = {}
  for (const scope of ['none', 'taskBudget', 'subBudget', 'merchantPin'] as const) {
    row[scope] = {
      fresh: freshCells[scope],
      settledReplay: settled(replay.settled),
      pendingReplay: pending(replay.pending),
      terminalReplay: terminalFreesKey(replay.terminal),
    }
  }
  return row
}

const X402_REPLAY = {
  settled:
    'delegationReplay answers a confirmed row with a tx_hash from the stored row, before any budget read; the scope ' +
    'ids must equal the row\'s (#3392 / #3330 pin)',
  pending:
    'delegationReplay rebuilds the stored sign context for an unexpired pending row, before any budget read: the ' +
    'enforcer in the redeemed chain stays the gate (#961)',
  terminal:
    'a failed row is not replayed (delegationReplay returns null), so the request takes the fresh path and the ' +
    'pre-check refuses it',
}

/**
 * Keyed `entrypoint → scope → state`. Typed loosely on purpose: the
 * completeness test, not the compiler, names a missing cell, so a fifth
 * scope reddens a test that says which cells need a decision.
 */
export const ENTRYPOINT_MATRIX: Partial<
  Record<MatrixEntrypoint, Partial<Record<string, Partial<Record<MatrixState, MatrixEntry>>>>>
> = {
  payments: authorizeRow(
    {
      none: fresh('the selected (token, recipient) grant', '#3503'),
      taskBudget: fresh("the task budget's parent, read by hash", '#3503, #3329 finding E'),
      subBudget: fresh("B's grant, every link read and the smallest deciding", '#3503, #3330'),
      merchantPin: fresh('the recipient-pinned grant, which the selection prefers', '#3503, #3331'),
    } as Record<MatrixScope, MatrixCell>,
    {
      settled:
        'findPaymentReplay answers a confirmed row through statusReplay, before scope resolution; the scope ids must ' +
        'equal the row\'s (#3392 / #3330 pin)',
      pending:
        'findPaymentReplay re-serves the stored sign data for an unexpired pending row, before scope resolution (#961, ' +
        '#3271)',
      terminal:
        'the send-key lookup skips failed and expired rows (FIND_SEND_INTENT_BY_KEY_SQL), so the key is free, the ' +
        'request takes the fresh path and the pre-check refuses it',
    },
  ),
  'x402-erc7710': authorizeRow(
    {
      none: fresh('the selected (token, payTo) grant', '#2082'),
      taskBudget: fresh("the task budget's parent, read by hash", '#2082, #3329 finding E'),
      subBudget: fresh("B's grant, every link read and the smallest deciding", '#3617'),
      merchantPin: fresh('the recipient-pinned grant, which the selection prefers', '#2082, #3331'),
    } as Record<MatrixScope, MatrixCell>,
    X402_REPLAY,
  ),
  'x402-funding': authorizeRow(
    {
      none: fresh('the selected (token, payTo) grant', '#2706'),
      taskBudget: fresh("the task budget's parent, read by hash", '#3617, epic #3615 decision 3 default'),
      subBudget: fresh("B's grant, every link read and the smallest deciding", '#3617, epic #3615 decision 1 default'),
      merchantPin: {
        outcome: '201 sign_data',
        why:
          'pinned budgets are erc7710-only (decision-log 2026-07-15): this leg redeems to the delegate EOA, so the ' +
          '(token, payTo) selection never matches a merchant pin and the leg pays from the open grant, which is ' +
          'ample here. Scope matching on this leg uses payTo, not merchantPayTo (#3617, correction on #3615).',
      },
    } as Record<MatrixScope, MatrixCell>,
    X402_REPLAY,
  ),
  'budget-precheck': {
    none: {
      fresh: fresh("the agent's own (token, merchant) budget", '#3054'),
      settledReplay: {
        outcome: '200 sufficient=true replay',
        why: 'a settled, unscoped keyed row is sufficient by construction: the money already moved (#3492 / #3527)',
      },
      pendingReplay: {
        outcome: REFUSED,
        why: 'only a SETTLED row bypasses the compare; a pending child is still refused (#3527, #3619 parity table)',
      },
      terminalReplay: {
        outcome: REFUSED,
        why: 'a failed row is not settled, so the compare runs and refuses (#3619 parity table)',
      },
    },
    taskBudget: {
      fresh: {
        notApplicable:
          'the hosted pre-check request carries no scope id: it compares against the agent\'s own (token, merchant) ' +
          'budget only (modules/mpp/budget-precheck.ts), so a task-budget request cannot be expressed',
      },
      settledReplay: {
        outcome: REFUSED,
        why:
          'a task-budget-scoped row is never a settled replay for the pre-check (budget-precheck.ts isSettledX402Replay, ' +
          '#3619 parity table): the compare runs and refuses',
      },
      pendingReplay: { outcome: REFUSED, why: 'not settled and scoped: the compare runs and refuses (#3619)' },
      terminalReplay: { outcome: REFUSED, why: 'not settled and scoped: the compare runs and refuses (#3619)' },
    },
    subBudget: {
      fresh: {
        notApplicable:
          'the hosted pre-check request carries no scope id: it compares against the agent\'s own (token, merchant) ' +
          'budget only, so a sub-budget request cannot be expressed',
      },
      settledReplay: {
        outcome: REFUSED,
        why: 'a sub-budget-scoped row is never a settled replay for the pre-check (#3619 parity table): the compare runs',
      },
      pendingReplay: { outcome: REFUSED, why: 'not settled and scoped: the compare runs and refuses (#3619)' },
      terminalReplay: { outcome: REFUSED, why: 'not settled and scoped: the compare runs and refuses (#3619)' },
    },
    merchantPin: {
      fresh: fresh('the recipient-pinned budget, which the pre-check prefers for a pinned merchant', '#3518'),
      settledReplay: {
        outcome: '200 sufficient=true replay',
        why: 'a settled, unscoped keyed row is sufficient by construction (#3492 / #3527)',
      },
      pendingReplay: { outcome: REFUSED, why: 'only a SETTLED row bypasses the compare (#3527)' },
      terminalReplay: { outcome: REFUSED, why: 'a failed row is not settled, so the compare runs (#3619)' },
    },
  },
}
