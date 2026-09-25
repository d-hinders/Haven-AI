/**
 * Public entry point for the task-budgets module (#3329). Outside callers
 * (routes, tests) must import ONLY from this file — the
 * `no-deep-cross-module-import` dependency-cruiser rule
 * (`docs/architecture/10-module-boundaries.md`). `task-budget-delegation.ts`
 * (pure caveat compiler) and `task-budget-service.ts` (orchestration) are
 * private; this file is the seam `routes/task-budgets.ts` and
 * `rails/delegation-authorization.ts` reach through.
 */

export {
  MAX_TASK_BUDGET_TTL_SECONDS,
  MIN_TASK_BUDGET_TTL_SECONDS,
  taskBudgetSalt,
} from './task-budget-delegation.js'
export type { BuiltTaskBudgetDelegation, TaskBudgetDelegationRequest } from './task-budget-delegation.js'

export {
  buildTaskBudgetChild,
  buildTaskBudgetSignContext,
  checkRemainderForNewTaskBudget,
  checkTaskBudgetForPayment,
  prepareTaskBudgetClose,
  recoverTaskBudgetChildSigner,
  resolveTaskBudgetChildForPayment,
  serializeClosePreparedUserOp,
  submitTaskBudgetClose,
} from './task-budget-service.js'
export type {
  BuildChildInput,
  CloseOutcome,
  RemainderCheck,
  TaskBudgetPaymentRefusal,
  TaskBudgetPaymentResolution,
  TaskBudgetSignContext,
} from './task-budget-service.js'
