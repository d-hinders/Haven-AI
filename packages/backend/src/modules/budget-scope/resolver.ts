/**
 * The budget-scope resolver (#3616, epic #3615 S-A).
 *
 * One module answers, for a payment request, every budget question the three
 * entrypoints answer separately today: the redemption links, the links the
 * period pre-check reads, the task-cap input, and the scope refusals. The
 * resolution logic is the UNION of `resolveTaskBudgetOrRefusal` and
 * `resolveSubBudgetOrRefusal` (`modules/x402/delegation-authorize.ts`) and the
 * inline task/sub resolution in `routes/payments.ts` — behaviour unchanged by
 * construction; this slice changes no entrypoint (S-B/S-C/S-D adopt it).
 *
 * Scope selection (today's `budgetOptions` ternary, `routes/payments.ts:750`):
 * a named sub-budget wins over a named task budget over the (token, to)
 * delegation — the entrypoints make both-ids impossible before resolution
 * (`refuseBothScopeIds`), so the sub-first order here is defensive parity, not
 * a new precedence.
 *
 * ## Rules the module keeps (and where they came from)
 *
 * - **#3329 review finding E, twice over for sub-budgets**: a task budget's
 *   parent is read BY THE ROW'S OWN `parent_delegation_hash` — never
 *   re-derived by (token, to), which can name a DIFFERENT active grant than
 *   the one the child's `authority` names. A sub-budget's grant names A's
 *   parent-child row by hash, and that row names A's budget delegation by
 *   hash again. The module routes both through `selectDelegationByHash`
 *   (`rails/delegation-authorization.ts`), which IS
 *   `selectActiveDelegationByHash` (`infra/repositories/delegation-budgets.ts`)
 *   — the x402 copies wrap the repository function, the payments copy calls it
 *   directly; one implementation either way (see the PR body's copy table).
 * - **Ordering inside each scope**: not-found (404) → parent lookups (409) →
 *   the service-layer payment checks (`resolveTaskBudgetChildForPayment` /
 *   `resolveSubBudgetForPayment`), whose refusal codes pass through with the
 *   shared refusal tables verbatim. Both x402 copies and the payments inline
 *   copy agree on every code, status and message (the tables are duplicated
 *   byte-identical in both files today — this module is now their one home).
 * - **The merchant pin is an explicit output, not an inherited default**
 *   (#3616 "open for the builder"): the none-scope selection is
 *   `SELECT_DELEGATION_FOR_PAYMENT_SQL` — same token, `recipient = $3 OR
 *   NULL`, live window, `ORDER BY (recipient_address IS NULL)` — so a
 *   recipient-pinned grant beats the open budget. The selection carries
 *   `pinned: recipient_address !== null` so an adopter SEES the pin rule
 *   instead of inheriting it (#3331).
 */
import { findForAgent as findTaskBudgetForAgent } from '../../infra/repositories/task-budgets.js'
import {
  findForAgent as findSubBudgetForAgent,
  findOpenParentChildByHash,
} from '../../infra/repositories/sub-budgets.js'
import { selectDelegation, selectDelegationByHash } from '../../rails/delegation-authorization.js'
import type { DelegationForPaymentRow } from '../../infra/repositories/delegation-budgets.js'
import type { Delegation } from '../../rails/delegation-policy.js'
import { resolveTaskBudgetChildForPayment, type TaskBudgetPaymentRefusal } from '../task-budgets/index.js'
import { resolveSubBudgetForPayment, type SubBudgetPaymentRefusal } from '../sub-budgets/index.js'

/** #3329 §3: the task-budget refusal table's HTTP status per code. */
export const TASK_BUDGET_REFUSAL_STATUS: Record<TaskBudgetPaymentRefusal, number> = {
  task_budget_not_found: 404,
  task_budget_not_open: 409,
  task_budget_token_mismatch: 409,
  task_budget_recipient_mismatch: 409,
  task_budget_parent_mismatch: 409,
}

/** #3329 §3: the task-budget refusal messages, verbatim from both current copies. */
export const TASK_BUDGET_REFUSAL_MESSAGE: Record<TaskBudgetPaymentRefusal, string> = {
  task_budget_not_found: 'Task budget not found',
  task_budget_not_open: 'Task budget is not open (closed, closing, pending, or expired)',
  task_budget_token_mismatch: "This payment's token does not match the task budget's token",
  task_budget_recipient_mismatch: "This payment's recipient does not match the task budget's pinned recipient",
  task_budget_parent_mismatch: 'The task budget was not carved from the budget delegation selected for this payment',
}

/** #3330 §3: the sub-budget refusal table's HTTP status per code. */
export const SUB_BUDGET_REFUSAL_STATUS: Record<SubBudgetPaymentRefusal, number> = {
  sub_budget_not_found: 404,
  sub_budget_not_open: 409,
  sub_budget_token_mismatch: 409,
  sub_budget_recipient_mismatch: 409,
  sub_budget_parent_mismatch: 409,
}

/** #3330 §3: the sub-budget refusal messages, verbatim from both current copies. */
export const SUB_BUDGET_REFUSAL_MESSAGE: Record<SubBudgetPaymentRefusal, string> = {
  sub_budget_not_found: 'Sub-budget not found',
  sub_budget_not_open: 'Sub-budget is not open (closed, closing, pending, or expired)',
  sub_budget_token_mismatch: "This payment's token does not match the sub-budget's token",
  sub_budget_recipient_mismatch: "This payment's recipient does not match the sub-budget's pinned recipient",
  sub_budget_parent_mismatch:
    "The sub-budget's chain is broken — its parent-child link is closed or it was not carved from the budget delegation selected for this payment",
}

/** Every refusal scope resolution itself can produce today, plus the both-ids guard. */
export type ScopeRefusalCode =
  | TaskBudgetPaymentRefusal
  | SubBudgetPaymentRefusal
  | 'both_scope_ids'

/**
 * One scope refusal, with the status code and message the entrypoints answer
 * today. `message` for `both_scope_ids` is per-surface prose (the direct
 * route's body names the snake_case body fields, x402 the camelCase ones) —
 * `refuseBothScopeIds` produces the two verbatim bodies; a resolution-time
 * both-ids answer (a caller that skipped its guard) carries the x402 wording.
 */
export interface ScopeRefusal {
  code: ScopeRefusalCode
  status: number
  message: string
}

/** Which budget scope the payment resolves to. `none` includes "no grant found". */
export type BudgetScopeKind = 'none' | 'taskBudget' | 'subBudget'

/** The task-cap input for `checkTaskBudgetCap` minus the amount/chain (the caller's). */
export interface TaskCapInput {
  taskBudgetId: string
  delegationHash: string
  maxAtomic: string
}

export interface TaskBudgetScopeSelections {
  /** The task budget's signed child — redemption chain `[child, budget]`. */
  childDelegation: Delegation
  /** #3329 review finding E: the EXACT parent, selected by hash. */
  parentDelegation: DelegationForPaymentRow
  /** The cap input for `checkTaskBudgetCap` (#3500). */
  taskCap: TaskCapInput
}

export interface SubBudgetScopeSelections {
  /** B's signed grant — redemption chain `[grant, parent-child, budget]`. */
  grantDelegation: Delegation
  /** A's signed self-delegated narrowing (the middle link). */
  parentChildDelegation: Delegation
  /** A's EXACT budget grant, selected by hash. */
  parentDelegation: DelegationForPaymentRow
}

export interface BudgetScopeSelections {
  kind: BudgetScopeKind
  taskBudget?: TaskBudgetScopeSelections
  subBudget?: SubBudgetScopeSelections
  /**
   * The (token, recipient) selection — none-scope only. Null when the agent
   * holds no applicable active grant (the caller answers its own 403).
   */
  delegation?: DelegationForPaymentRow | null
  /**
   * #3331/#3616: true when the none-scope selection is a RECIPIENT-PINNED
   * grant (`SELECT_DELEGATION_FOR_PAYMENT_SQL` prefers the pin over the open
   * budget). Made explicit so adopters see the pin rule instead of
   * inheriting it.
   */
  pinned?: boolean
}

export type BudgetScopeResolution =
  | { ok: true; scope: BudgetScopeSelections }
  | { ok: false; refusal: ScopeRefusal }

export interface BudgetScopeInput {
  agentId: string
  tokenAddress: string
  /** The payment's recipient (the eventual redemption's `to`); lowered here once. */
  recipient: string
  taskBudgetId?: string
  subBudgetId?: string
}

const taskRefusal = (code: TaskBudgetPaymentRefusal): ScopeRefusal => ({
  code,
  status: TASK_BUDGET_REFUSAL_STATUS[code],
  message: TASK_BUDGET_REFUSAL_MESSAGE[code],
})

const subRefusal = (code: SubBudgetPaymentRefusal): ScopeRefusal => ({
  code,
  status: SUB_BUDGET_REFUSAL_STATUS[code],
  message: SUB_BUDGET_REFUSAL_MESSAGE[code],
})

/**
 * The verbatim both-ids bodies the two entrypoints answer today — the guard
 * runs BEFORE resolution on both (`routes/payments.ts:447`,
 * `delegation-authorize.ts:386`); adopters keep calling this first so the
 * wire prose cannot change.
 */
export function refuseBothScopeIds(surface: 'payments' | 'x402'): { status: number; body: Record<string, unknown> } {
  if (surface === 'payments') {
    return {
      status: 400,
      body: { error: 'Pass exactly one of task_budget_id or sub_budget_id — never both' },
    }
  }
  return {
    status: 400,
    body: { error: 'Pass exactly one of taskBudgetId or subBudgetId — never both' },
  }
}

/**
 * Resolve the budget scope for a payment — the union of the three current
 * resolution copies. Refuses on: both ids sent; task budget not found /
 * parent not active / payment checks failed; sub-budget not found / chain
 * broken / payment checks failed. The none-scope (token, recipient)
 * selection always runs when no id is named, and may answer null.
 */
export async function resolveBudgetScope(input: BudgetScopeInput): Promise<BudgetScopeResolution> {
  if (input.taskBudgetId && input.subBudgetId) {
    return {
      ok: false,
      refusal: {
        code: 'both_scope_ids',
        status: 400,
        message: 'Pass exactly one of taskBudgetId or subBudgetId — never both',
      },
    }
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const recipientLower = input.recipient.toLowerCase()

  // ── Task budget (#3329) ──────────────────────────────────────────────
  // Payments copy (`routes/payments.ts:591`) and x402 copy
  // (`resolveTaskBudgetOrRefusal`) agree step for step: find → parent by the
  // row's OWN hash → the service payment checks.
  if (input.taskBudgetId) {
    const row = await findTaskBudgetForAgent(input.taskBudgetId, input.agentId)
    if (!row) return { ok: false, refusal: taskRefusal('task_budget_not_found') }
    // #3329 review finding E: by hash, never re-derived by (token, to).
    const parentDelegation = await selectDelegationByHash(input.agentId, row.parent_delegation_hash)
    if (!parentDelegation) return { ok: false, refusal: taskRefusal('task_budget_parent_mismatch') }
    const resolved = resolveTaskBudgetChildForPayment(row, input.tokenAddress, recipientLower, parentDelegation, nowSec)
    if (!resolved.ok) return { ok: false, refusal: taskRefusal(resolved.refusal as TaskBudgetPaymentRefusal) }
    return {
      ok: true,
      scope: {
        kind: 'taskBudget',
        taskBudget: {
          childDelegation: resolved.childDelegation as Delegation,
          parentDelegation,
          taskCap: {
            taskBudgetId: row.id,
            delegationHash: row.delegation_hash,
            maxAtomic: row.max_atomic,
          },
        },
      },
    }
  }

  // ── Sub-budget (#3330) ───────────────────────────────────────────────
  // Grant → its parent-child row by hash → A's budget by that row's hash →
  // the service payment checks (which re-verify BOTH hash bindings).
  if (input.subBudgetId) {
    const grantRow = await findSubBudgetForAgent(input.subBudgetId, input.agentId)
    if (!grantRow) return { ok: false, refusal: subRefusal('sub_budget_not_found') }
    const parentChildRow = await findOpenParentChildByHash(grantRow.parent_delegation_hash, nowSec)
    if (!parentChildRow) return { ok: false, refusal: subRefusal('sub_budget_parent_mismatch') }
    const parentDelegation = await selectDelegationByHash(
      parentChildRow.agent_id,
      parentChildRow.parent_delegation_hash,
    )
    if (!parentDelegation) return { ok: false, refusal: subRefusal('sub_budget_parent_mismatch') }
    const resolved = resolveSubBudgetForPayment(
      grantRow,
      parentChildRow,
      input.tokenAddress,
      recipientLower,
      parentDelegation,
      nowSec,
    )
    if (!resolved.ok) return { ok: false, refusal: subRefusal(resolved.refusal as SubBudgetPaymentRefusal) }
    return {
      ok: true,
      scope: {
        kind: 'subBudget',
        subBudget: {
          grantDelegation: resolved.childDelegation as Delegation,
          parentChildDelegation: JSON.parse(parentChildRow.delegation_json) as Delegation,
          parentDelegation,
        },
      },
    }
  }

  // ── None scope: the payment's own (token, recipient) selection ───────
  // `SELECT_DELEGATION_FOR_PAYMENT_SQL`: recipient-pinned grant wins over
  // the open budget (`ORDER BY (recipient_address IS NULL)`). `pinned`
  // carries that rule out explicitly (#3331).
  const delegation = await selectDelegation(input.agentId, input.tokenAddress, recipientLower)
  return {
    ok: true,
    scope: {
      kind: 'none',
      delegation,
      pinned: delegation?.recipient_address != null,
    },
  }
}

/**
 * #3617: the delegation JSONs the PERIOD pre-check reads for a resolved
 * scope — the rule `routes/payments.ts` (#3503) applies, now shared with
 * both `/x402/authorize` legs so the three cannot drift apart:
 *
 * - sub-budget: every link of the chain it redeems — B's grant, A's
 *   parent-child and A's budget — each carries its own period caveat, so all
 *   three are read and the smallest remaining decides
 *   (`evaluatePeriodPrecheck`);
 * - task budget: the task budget's PARENT, read by hash (#3329 finding E) —
 *   the child's own cap is the separate `taskCap` check (#3500);
 * - none: the (token, recipient) selection, when there is one.
 *
 * Never the caller's own (token, recipient) grant when a scope is named: that
 * grant is not a link of the chain the scope redeems.
 */
export function periodPrecheckLinks(scope: BudgetScopeSelections): string[] {
  if (scope.subBudget) {
    return [
      JSON.stringify(scope.subBudget.grantDelegation),
      JSON.stringify(scope.subBudget.parentChildDelegation),
      scope.subBudget.parentDelegation.delegation_json,
    ]
  }
  if (scope.taskBudget) return [scope.taskBudget.parentDelegation.delegation_json]
  return scope.delegation ? [scope.delegation.delegation_json] : []
}
