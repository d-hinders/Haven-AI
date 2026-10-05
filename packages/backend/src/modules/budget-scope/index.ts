/**
 * Public entry point for the budget-scope module (#3616, epic #3615 S-A).
 * Outside callers (the payment entrypoints, which adopted it in #3617/#3618/
 * #3619, and tests) must import ONLY from this file — the
 * `no-deep-cross-module-import` dependency-cruiser rule
 * (`docs/architecture/10-module-boundaries.md`). `resolver.ts`, `precheck.ts`
 * and `refusal-body.ts` are private; this file is the seam.
 *
 * One module answers, for a payment request, every budget question the
 * entrypoints used to answer separately: the redemption links, the links the
 * period pre-check reads, the task-cap input, the scope refusals, and the
 * `delegation_budget_exceeded` body builders. #3616 added it; #3617–#3619
 * moved the entrypoints onto it; #3620's matrix
 * (`__tests__/entrypoint-matrix.ts`) pins what each entrypoint answers.
 */

export {
  resolveBudgetScope,
  BUDGET_SCOPE_KINDS,
  refuseBothScopeIds,
  periodPrecheckLinks,
  TASK_BUDGET_REFUSAL_STATUS,
  TASK_BUDGET_REFUSAL_MESSAGE,
  SUB_BUDGET_REFUSAL_STATUS,
  SUB_BUDGET_REFUSAL_MESSAGE,
} from './resolver.js'
export type {
  BudgetScopeInput,
  BudgetScopeResolution,
  BudgetScopeKind,
  BudgetScopeSelections,
  TaskBudgetScopeSelections,
  SubBudgetScopeSelections,
  TaskCapInput,
  ScopeRefusal,
  ScopeRefusalCode,
} from './resolver.js'

export { evaluatePeriodPrecheck } from './precheck.js'
export type { PeriodPrecheckInput, PeriodPrecheckOutcome, LinkRead } from './precheck.js'

export {
  buildPeriodExceededBody,
  periodExceededLedgerDetail,
  taskCapExceededLedgerDetail,
} from './refusal-body.js'
export type {
  PeriodExceededBodyInput,
  PeriodExceededBodyCommon,
  DirectPeriodExceededInput,
  X402PeriodExceededInput,
  MppPeriodExceededInput,
  SignLegPeriodExceededInput,
} from './refusal-body.js'
