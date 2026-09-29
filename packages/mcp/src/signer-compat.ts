/**
 * #3419: the task-budget old-signer recovery notice, LOCAL surface.
 *
 * The hosted builder of the same name lives in
 * `packages/mcp-server/src/tools/support/signer-compat.ts`; this package
 * cannot import it (no dependency on the hosted package — they are separate
 * runtimes, and a runtime dependency the other way would drag the hosted
 * server's connector channel into every local install), so the shape is
 * duplicated here ON PURPOSE and pinned identical by two tests:
 * `packages/mcp/src/task-budgets.test.ts` (fields present on the local
 * handoffs) and `packages/mcp-server/src/hosted-signer-integration.test.ts`
 * (hosted and local builders agree field-for-field, from the same SDK
 * constant).
 *
 * The SINGLE SOURCES are shared, not copied: `TASK_SIGN_CONTEXT_VERSION`
 * comes from `@haven_ai/sdk` (the same constant the backend emits and the
 * signer's `SUPPORTED_TASK_SIGN_CONTEXT_VERSIONS` derives from), and the
 * recovery route is built from the same `connectorUpgradeCommand()` the
 * signer's own update hints use. What is pinned to `'0.6.0-alpha.0'` here is
 * the same ONE fact the hosted constant pins: the first `@haven_ai/signer`
 * release whose `haven_sign` accepts the `task_budget_id` argument form
 * (#3329) — `client-releases.data.ts` is the record, and the hosted
 * package's `TASK_BUDGET_MIN_SIGNER_VERSION` (the exported constant the
 * cross-package pin ties to it) carries the identical value.
 *
 * Like the hosted notice this is ADVISORY DATA on the handoff result, never a
 * gate: the local runtime cannot see the signer either, and the signer keeps
 * enforcing its own versions at the sign-context fetch.
 */
import { TASK_SIGN_CONTEXT_VERSION, connectorUpgradeCommand } from '@haven_ai/sdk'

/**
 * The first `@haven_ai/signer` release whose `haven_sign` accepts the
 * `task_budget_id` argument form (#3329). ONE constant on this surface, with
 * exactly one job: the value `signer_compatibility.min_signer_version`
 * reports on the two task-budget handoffs below. The hosted package exports
 * `TASK_BUDGET_MIN_SIGNER_VERSION` with the same value, tied to the same
 * release record (`client-releases.data.ts`) by its cross-package pin.
 */
export const TASK_BUDGET_MIN_SIGNER_VERSION = '0.6.0-alpha.0'

/** The capability key both runtimes report in `signer_compatibility.signer_capability`. */
export const SIGNER_CAPABILITY_KEY = 'haven/signer-compatibility'

/**
 * The recovery notice every result that hands off to
 * `haven_sign { task_budget_id }` carries — the local twin of the hosted
 * `taskSignerCompatibilityNotice()`. Field-for-field the same shape:
 *
 * - `task_sign_context_version` — from the SDK's single source;
 * - `min_signer_version` — the constant above;
 * - `signer_capability` — the existing capability key;
 * - `check` / `fallback` — the recovery sentence as prose and as data: the
 *   trigger substring (the generic refusal every pre-0.6.0 signer answers,
 *   both historic lines begin with it), then close the pending budget, update
 *   via the connector doctor and its printed repair line, reopen. No relay
 *   fallback exists for this signing context (an `eip712_delegation` payload
 *   the 0.5.x unbound allowlist refuses and a 0.4.x signer must not be
 *   steered into), so none is named.
 */
export function taskSignerCompatibilityNotice() {
  return {
    task_sign_context_version: TASK_SIGN_CONTEXT_VERSION,
    min_signer_version: TASK_BUDGET_MIN_SIGNER_VERSION,
    signer_capability: SIGNER_CAPABILITY_KEY,
    check:
      'Call next_tool with next_arguments EXACTLY as given — the signer fetches the exact bytes ' +
      'by task_budget_id. If haven_sign answers SIGNING_ERROR with a message starting "Pass ' +
      "payment_id (preferred for delegation-rail x402\", the signer predates task budgets and signed " +
      'nothing: first close this budget with haven_close_task_budget { task_budget_id } to release ' +
      `it, then update the connector by running \`${connectorUpgradeCommand()}\` and the repair ` +
      'line it prints, then open the budget again.',
    fallback:
      'haven_sign answered SIGNING_ERROR with a message starting "Pass payment_id (preferred for ' +
      'delegation-rail x402" — the signer predates task budgets and signed nothing: call ' +
      'haven_close_task_budget { task_budget_id } to release the pending budget, then update the ' +
      `connector by running \`${connectorUpgradeCommand()}\` and the repair line it prints, ` +
      'then open the budget again. There is no relay fallback for this signing context.',
  }
}
