import type { AgentNextStep, AgentPaymentNextAction } from './types.js'

/**
 * #3101 (epic #3105, slice 2/5): the typed next-step builder.
 *
 * Every hosted payment tool ends by naming the agent's next tool and its
 * arguments (#1308). Until this module, the tool was a free string and the
 * arguments a `Record<string, unknown>`, so nothing tied the keys to the tool
 * named beside them — three sites handed `{ payment_id: null }` to a tool
 * whose `payment_id` is a required string, and the compiler could not see it.
 *
 * The builder is generic over a TARGET MAP the caller supplies: bare tool
 * name → { role, validate }. It is deliberately schema-library-agnostic (the
 * SDK carries no zod): the hosted server derives each target's argument type
 * from its own zod shape and passes a `validate` closure; this module only
 * needs to know the role (to render `mcp__<server>__<tool>`) and how to say
 * whether arguments parse. Keyed on the bare name + role (decision 1) so the
 * namespaced string is rendered in exactly one place and the runtime-neutral
 * `next_tool_server` / `next_tool_name` / `next_tool_server_role` fields are
 * derived from the same input rather than parsed back out of a literal.
 *
 * Decisions 3 and 8: `nextTool` is REQUIRED on the input and may be `null` —
 * a site that forgets it is a compile error; a site with no next tool says
 * why, and the wire omits `next_tool` and carries `next_tool_omitted_reason`.
 * `next_tool` is never null on the wire.
 */
export type NextToolServerRole = 'hosted' | 'signer'

/** The DEFAULT server name each role is wired under (#1588, #2550). */
export const NEXT_TOOL_SERVER_NAMES: Record<NextToolServerRole, string> = {
  hosted: 'haven',
  signer: 'haven-signer',
}

/** Default server name → role. An unknown server yields no role rather than a guess (#2550). */
export const NEXT_TOOL_SERVER_ROLES: Record<string, NextToolServerRole> = {
  haven: 'hosted',
  'haven-signer': 'signer',
}

/** Renders the Claude-family namespaced tool name — the one string clients have followed since #1308. */
export function renderNextTool(role: NextToolServerRole, name: string): string {
  return `mcp__${NEXT_TOOL_SERVER_NAMES[role]}__${name}`
}

/** Parses a namespaced literal back into its parts; `role` is absent for an unknown server. */
export function parseNextTool(literal: string): { server: string; name: string; role?: NextToolServerRole } | null {
  const m = /^mcp__([a-z0-9-]+)__([a-z0-9_]+)$/.exec(literal)
  if (!m) return null
  const role = NEXT_TOOL_SERVER_ROLES[m[1]]
  return { server: m[1], name: m[2], ...(role ? { role } : {}) }
}

/**
 * One target the builder may hand off to. `TArgs` is the argument type the
 * caller derived from the tool's declared schema; `validate` is the runtime
 * twin of that type and returns `null` when the arguments parse, else why not.
 */
export interface NextStepTarget<TArgs> {
  role: NextToolServerRole
  validate: (input: unknown) => string | null
  /** Phantom carrier for the argument type; never read at runtime. */
  readonly _args?: TArgs
}

export type NextStepTargets = Record<string, NextStepTarget<unknown>>

/** The argument type a target carries. */
export type NextStepArguments<Targets extends NextStepTargets, T extends keyof Targets> =
  Targets[T] extends NextStepTarget<infer A> ? A : never

/**
 * The handoff half of a next step: a registered tool with arguments that
 * tool accepts, or no tool with the reason. A discriminated union over the
 * target map's keys, so a wrong key, a missing required key, an unregistered
 * tool name and an omitted `nextTool` are each a compile error at the site.
 */
export type NextStepHandoff<Targets extends NextStepTargets> =
  | { [T in keyof Targets & string]: { nextTool: T; nextArguments: NextStepArguments<Targets, T> } }[keyof Targets & string]
  | { nextTool: null; nextToolOmittedReason: string }

export type NextStepInput<Targets extends NextStepTargets> = NextStepHandoff<Targets> & {
  nextAction: AgentPaymentNextAction
  safeToContinue: boolean
  reason: string
}

/** The wire shape: `AgentNextStep` (its `next_tool` family) — never a null `next_tool`. */
export type NextStep = AgentNextStep

/**
 * Per-`next_action` default tool (decision 9): the tool a site names unless it
 * has a reason to override. Only actions with ONE sensible target are listed;
 * `sign_and_submit_payment` and `retry_original_x402_request` are deliberately
 * absent: the signer tool
 * depends on the settlement scheme (`haven_sign` for erc7710 delegations,
 * `haven_sign_x402` for the EIP-3009 bridge) and a wrong default there would be
 * worse than none.
 */
export const DEFAULT_NEXT_TOOL_BY_ACTION = {
  check_status_later: 'haven_get_payment_status',
  sweep_stranded_funds: 'haven_sweep_delegate',
  // `retry_original_x402_request` is NOT here: its only live emitter
  // (state-direct-recovery.ts, erc7710) names no tool on purpose — the retry
  // is the agent's own HTTP call — so a default would contradict the site.
} as const satisfies Partial<Record<AgentPaymentNextAction, string>>

export function defaultNextToolFor(action: AgentPaymentNextAction): string | undefined {
  return (DEFAULT_NEXT_TOOL_BY_ACTION as Partial<Record<AgentPaymentNextAction, string>>)[action]
}

/**
 * Builds a `nextStep` function bound to a target map. The returned function
 * renders the wire fields from the bare name + role, and re-validates the
 * arguments at runtime: on a mismatch it FAILS SAFE — omits the tool and says
 * why in `next_tool_omitted_reason` — rather than throwing out of a handler
 * that has already moved money. The compile-time twin makes that branch
 * unreachable from typed sites; it exists for callers that bypass the types.
 */
export function createNextStepBuilder<Targets extends NextStepTargets>(targets: Targets) {
  return function nextStep(input: NextStepInput<Targets>): NextStep {
    // The generic mapped union does not narrow inside this body; the
    // structural view below is what the union guarantees at every call site.
    const i = input as unknown as {
      nextTool: string | null
      nextArguments?: unknown
      nextToolOmittedReason?: string
    }
    const base = {
      next_action: input.nextAction,
      safe_to_continue: input.safeToContinue,
      reason: input.reason,
    }
    if (i.nextTool === null) {
      return { ...base, next_tool_omitted_reason: i.nextToolOmittedReason ?? 'no next tool' }
    }
    const target = targets[i.nextTool]
    if (!target) {
      return { ...base, next_tool_omitted_reason: `${i.nextTool} is not a registered next-step target` }
    }
    const problem = target.validate(i.nextArguments)
    if (problem) {
      return { ...base, next_tool_omitted_reason: `next_arguments do not parse under ${i.nextTool}: ${problem}` }
    }
    return {
      ...base,
      next_tool: renderNextTool(target.role, i.nextTool),
      next_tool_server: NEXT_TOOL_SERVER_NAMES[target.role],
      next_tool_name: i.nextTool,
      next_tool_server_role: target.role,
      next_arguments: i.nextArguments as Record<string, unknown>,
    }
  }
}
