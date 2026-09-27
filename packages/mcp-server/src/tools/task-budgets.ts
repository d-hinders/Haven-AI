/**
 * #3329 — the TASK BUDGET capability of the hosted MCP surface.
 *
 * Two tools, one owner:
 *
 *   haven_open_task_budget   reserve a budget for one task that ends by
 *                            itself — a short-lived child of the agent's own
 *                            budget, capped and time-boxed independently of
 *                            the period reset.
 *   haven_close_task_budget  end one early, releasing whatever of its cap
 *                            was unspent back to the agent's own budget.
 *
 * Both are keyless like every hosted tool: they construct the request and
 * relay Haven's response, which either says the task budget is already
 * settled (`status: 'closed'`, or the open call's newly-`pending` row before
 * a signature exists) or hands back a signing context for the local signer;
 * `haven_submit` (owned by `tools/state-direct-recovery.ts`) relays the
 * resulting signature by `task_budget_id`.
 *
 * DEPENDENCY RULE (epic #2806, extended by #3329): this module imports the
 * #2807 contract and parsing seams and the #2808 shared support, and NEVER
 * another capability module — the same rule `module-boundaries.test.ts`
 * enforces on every module under `tools/`.
 */
import { AgentPaymentNextAction, resolveTokenFromAddress, type HavenClient } from '@haven_ai/sdk'
import type { HostedToolHandlers, HostedToolName } from './contracts.js'
import { parseStrict } from './parsing.js'
import { runTool, HostedToolError } from './support/errors.js'
import { refusalNextStep, taskBudgetNextStep } from './support/guidance.js'
import { humanToAtomic } from './support/cap-price.js'

/**
 * #3329 (review fix): the hand-off both tools return once a signature is
 * needed. `next_tool_name: 'haven_sign'` / `next_tool_server_role: 'signer'` /
 * `next_arguments: { task_budget_id }` come from the typed builder — the
 * plain-prose "Sign the returned sign_data with the local signer" this used
 * to say instead named no tool a client could dispatch on, so the only
 * observable behavior was a model reading prose and guessing which signer
 * tool to call with which argument (and, on the wrong guess, a signer refusal
 * over typed_data it does not recognise for this shape).
 */
function taskBudgetSignHandoff(taskBudgetId: string) {
  return taskBudgetNextStep({
    nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
    nextTool: 'haven_sign',
    nextArguments: { task_budget_id: taskBudgetId },
    reason:
      'Sign with the local signer tool named above, passing task_budget_id EXACTLY as given — it ' +
      'fetches the signing context itself. Then relay the signature with haven_submit, passing ' +
      'task_budget_id (not payment_id).',
  })
}

/** See `state-direct-recovery.ts` for why this is a tuple, not a `Record`. */
export const TASK_BUDGET_TOOLS = [
  'haven_open_task_budget',
  'haven_close_task_budget',
] as const satisfies readonly HostedToolName[]

export type TaskBudgetToolName = (typeof TASK_BUDGET_TOOLS)[number]

const TOKEN_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

/**
 * Resolve a token SYMBOL or ADDRESS to this agent's own allowance for it —
 * the same #3213 reasoning `state-direct-recovery.ts`'s
 * `resolveTokenAddressFromAllowances` uses for `haven_check_funds`, kept as
 * its own copy here rather than a cross-capability import (the #3329
 * dependency rule forbids reaching into a sibling module for it): a task
 * budget can only ever be a child of a budget this agent already holds, so
 * the agent's own allowances are the source of truth for which tokens (and
 * their decimals) are even eligible, never a guess.
 */
async function resolveTaskBudgetToken(
  haven: HavenClient,
  symbolOrAddress: string | undefined,
): Promise<{ address: string; symbol: string; decimals: number }> {
  const wanted = (symbolOrAddress ?? 'USDC').toLowerCase()
  const { allowances } = await haven.getAllowances()
  const match = TOKEN_ADDRESS_PATTERN.test(wanted)
    ? allowances.find((a) => a.tokenAddress.toLowerCase() === wanted)
    : allowances.find((a) => (a.tokenSymbol ?? '').toLowerCase() === wanted)
  if (!match) {
    const known = allowances.map((a) => `${a.tokenSymbol} (${a.tokenAddress})`)
    throw new HostedToolError({
      code: 'INVALID_INPUT',
      message:
        `token "${symbolOrAddress ?? 'USDC'}" is not the symbol or address of any allowance ` +
        `this agent holds${known.length > 0 ? ` (it holds: ${known.join(', ')})` : ' (it holds none)'}. ` +
        'Nothing was reserved.',
      statusCode: 400,
      nextStep: refusalNextStep({
        nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
        nextTool: 'haven_get_allowances',
        nextArguments: {},
      }),
    })
  }
  const resolved = resolveTokenFromAddress(match.tokenAddress)
  return { address: match.tokenAddress, symbol: match.tokenSymbol, decimals: resolved?.decimals ?? 6 }
}

export function createTaskBudgetHandlers(haven: HavenClient): HostedToolHandlers<TaskBudgetToolName> {
  return {
    haven_open_task_budget: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_open_task_budget', input)
        const token = await resolveTaskBudgetToken(haven, typeof args.token === 'string' ? args.token : undefined)
        const maxAmountAtomic = humanToAtomic(args.max_amount_human, token.decimals)
        if (maxAmountAtomic === null) {
          throw new HostedToolError({
            code: 'MAX_AMOUNT_UNCONVERTIBLE',
            message:
              `max_amount_human ("${args.max_amount_human}") carries more decimal places than ` +
              `${token.symbol} supports (${token.decimals}). Haven refuses rather than silently ` +
              'change the amount. Nothing was reserved. Round the amount, or use fewer decimal places.',
            statusCode: 400,
            nextStep: refusalNextStep({
              nextAction: AgentPaymentNextAction.StopAndTellUser,
              nextTool: null,
              nextToolOmittedReason: 'the user has to decide the amount before anything is called again',
            }),
          })
        }
        const result = await haven.openTaskBudget({
          tokenAddress: token.address,
          maxAmountAtomic: maxAmountAtomic.toString(),
          ttlSeconds: (args.ttl_minutes as number) * 60,
          recipientAddress: typeof args.recipient === 'string' ? args.recipient : undefined,
          label: typeof args.label === 'string' ? args.label : undefined,
        })
        return {
          task_budget: result.taskBudget,
          ...(result.signData
            ? { sign_data: result.signData, ...taskBudgetSignHandoff(result.taskBudget.id) }
            : {}),
        }
      }),

    haven_close_task_budget: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_close_task_budget', input)
        const result = await haven.closeTaskBudget(args.task_budget_id as string)
        if (result.status === 'closed') {
          return { task_budget: result.taskBudget, status: 'closed' as const }
        }
        return {
          task_budget: result.taskBudget,
          sign_data: result.signData,
          ...taskBudgetSignHandoff(args.task_budget_id as string),
        }
      }),
  }
}
