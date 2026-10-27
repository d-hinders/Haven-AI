/**
 * #4468: the payment-scope refusal contract — the ten codes a payment that
 * names a task budget or a sub-budget can be refused with, and the HTTP status
 * each one answers.
 *
 * ONE artifact, read by both sides. The backend's scope resolver answers these
 * codes (`packages/backend/src/modules/budget-scope/resolver.ts`), and the
 * hosted MCP's `normalizeError` must answer every one of them with a typed
 * `code` and the backend's own `error_code` — never the generic `API_ERROR`.
 * Before #4468 each side kept its own literal list, so a member added on the
 * backend side reached the agent as `API_ERROR` with no `error_code` and
 * nothing failed: the refusal's typed reason survived only as English in
 * `message`. The hosted test walks `PAYMENT_SCOPE_REFUSAL_CODES` and fails on
 * any member `normalizeError` does not answer, and the backend's status tables
 * are typed `Record<Union, number>` off the same unions, so a member cannot be
 * added on one side alone.
 *
 * Pure data — no imports, no I/O (the `core-stays-pure` rule).
 */

/** Reasons a task budget cannot authorize a payment (#3329 §3 refusal table). */
export const TASK_BUDGET_PAYMENT_REFUSALS = [
  'task_budget_not_found',
  'task_budget_not_open',
  'task_budget_token_mismatch',
  'task_budget_recipient_mismatch',
  'task_budget_parent_mismatch',
] as const

export type TaskBudgetPaymentRefusal = (typeof TASK_BUDGET_PAYMENT_REFUSALS)[number]

/** Reasons a sub-budget cannot authorize a payment (#3330 §3 refusal table). */
export const SUB_BUDGET_PAYMENT_REFUSALS = [
  'sub_budget_not_found',
  'sub_budget_not_open',
  'sub_budget_token_mismatch',
  'sub_budget_recipient_mismatch',
  'sub_budget_parent_mismatch',
] as const

export type SubBudgetPaymentRefusal = (typeof SUB_BUDGET_PAYMENT_REFUSALS)[number]

/**
 * Every payment-scope refusal code, both scopes — the list the hosted MCP's
 * answer table and its test both walk. The two scopes are disjoint by
 * construction (the `task_budget_` / `sub_budget_` prefixes), so the union is
 * exactly ten members.
 */
export const PAYMENT_SCOPE_REFUSAL_CODES = [
  ...TASK_BUDGET_PAYMENT_REFUSALS,
  ...SUB_BUDGET_PAYMENT_REFUSALS,
] as const

export type PaymentScopeRefusalCode = (typeof PAYMENT_SCOPE_REFUSAL_CODES)[number]

/**
 * The HTTP status each task-budget refusal answers (#3329 §3). `not_found` is
 * the only 404; every other code is a 409 — the row exists but cannot be used
 * as the payment names it.
 */
export const TASK_BUDGET_REFUSAL_STATUS: Record<TaskBudgetPaymentRefusal, number> = {
  task_budget_not_found: 404,
  task_budget_not_open: 409,
  task_budget_token_mismatch: 409,
  task_budget_recipient_mismatch: 409,
  task_budget_parent_mismatch: 409,
}

/** The HTTP status each sub-budget refusal answers (#3330 §3), same shape. */
export const SUB_BUDGET_REFUSAL_STATUS: Record<SubBudgetPaymentRefusal, number> = {
  sub_budget_not_found: 404,
  sub_budget_not_open: 409,
  sub_budget_token_mismatch: 409,
  sub_budget_recipient_mismatch: 409,
  sub_budget_parent_mismatch: 409,
}

/** The status for any payment-scope refusal code, whichever scope it belongs to. */
export const PAYMENT_SCOPE_REFUSAL_STATUS: Record<PaymentScopeRefusalCode, number> = {
  ...TASK_BUDGET_REFUSAL_STATUS,
  ...SUB_BUDGET_REFUSAL_STATUS,
}
