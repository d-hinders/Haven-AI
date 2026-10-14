/**
 * The harness-neutral data model for the agent eval suite (#3958, epic #3957).
 *
 * Three artifacts flow through here, and keeping their shapes in ONE file is
 * the point: a task file written by hand, a tool-call log recorded by an
 * adapter (Hermes today, Claude Code in #3959), and a grader verdict. Neither
 * adapter nor task format may define its own copy of these.
 *
 * The model is deliberately log-shaped, not model-shaped: nothing here knows
 * about prompts, tokens or model providers. A "run" is a list of tool calls
 * with their results plus the agent's final user-facing message — everything a
 * grader may read. The graders never call the model and never call the agent;
 * the only live I/O they touch is the injected chain/backend probe.
 */

/** The recorded role of the server a tool call went to (`next_tool_server_role`). */
export type ServerRole = 'hosted' | 'signer'

/** The result envelope of one recorded tool call, as the grader may read it. */
export interface RecordedToolResult {
  /** False when the tool errored. Absent when the call never completed. */
  ok?: boolean
  /** The backend `error_code` the result carried, if any (e.g. `delegation_budget_exceeded`). */
  errorCode?: string
  /** The `next_tool_name` the refusal/step guidance pointed at, if any. */
  nextTool?: string
  /** The role that goes with {@link nextTool}. */
  nextToolServerRole?: ServerRole
}

/**
 * One tool call as the harness recorded it.
 *
 * `name` is the name AS RECORDED — it may carry the MCP server prefix the
 * runtime writes for a derived pair (`mcp__haven-<slug>-dev__haven_pay`).
 * Graders must never compare `name` directly: run it through
 * `bareToolName()` (see `tools.ts`).
 */
export interface RecordedToolCall {
  name: string
  /** The server role when the harness knows one; absent otherwise. */
  serverRole?: ServerRole
  args?: Record<string, unknown>
  result?: RecordedToolResult
  /** Wall-clock ms since the run started, when the harness timestamps calls. */
  atMs?: number
}

/** One completed agent run over one task: the log a grader reads. */
export interface AgentRunLog {
  taskId: string
  /** 1-based trial number within the suite run. */
  trial: number
  calls: RecordedToolCall[]
  /**
   * The agent's final user-facing message — the "told the user" evidence the
   * refusal graders require. Empty/absent when the run produced no text.
   */
  finalMessage?: string
}

/**
 * The amount rule a task carries, resolved at launch from a LIVE read
 * (#2016's discipline, inherited by #3958: never a hardcoded budget number).
 *
 * `remaining_period_budget` — the agent's live remaining period budget in
 * atomic units. `delta_atomic` shifts it: `0` for exact-remaining sends,
 * positive to go over budget (the `over-budget-refused` leg derives
 * remaining + 1 USDC the same way).
 */
export interface AmountRule {
  rule: 'remaining_period_budget'
  /** bigint-as-string. Added to the live remaining budget. */
  delta_atomic: string
}

export interface TaskSource {
  /** Where this task's expectation comes from — the citation is mandatory. */
  kind: 'bug-report' | 'scenario' | 'issue'
  /** Repo-relative path (bug-report/scenario) or the issue number as a string. */
  ref: string
  /** One line naming the specific finding/invariant this task pins. */
  note: string
}

/** The instruction placeholders the runner renders before launch. */
export type InstructionPlaceholder = 'amount' | 'recipient'

/**
 * One eval task — the file the runner loads (JSON, never Markdown, #3958).
 *
 * `instruction` may carry `{amount}` / `{recipient}` placeholders, rendered
 * from the resolved amount rule + run config. Tasks that phrase the amount
 * verbally ("your entire remaining budget") leave the placeholder out; the
 * resolved amount still feeds the graders.
 */
export interface EvalTask {
  id: string
  title: string
  category: 'direct-payment' | 'x402-paywall' | 'over-budget'
  instruction: string
  /** What the run needs provisioned before launch (documented in the runbook). */
  requires: string[]
  amount: AmountRule
  /** Graders to apply, in order. All must pass for the trial to pass. */
  graders: Array<{ name: string; options?: Record<string, unknown> }>
  /** True when the task expects an on-chain USDC transfer as its outcome. */
  expectTransfer: boolean
  source: TaskSource
}

/** The task after the runner resolved its amount rule + instruction. */
export interface ResolvedTask {
  task: EvalTask
  /** Atomic units. The live remaining budget + delta. */
  amountAtomic: bigint
  /** The rendered instruction the agent actually received. */
  instruction: string
  recipient?: string
  /** The agent account transfers are expected FROM (the delegate account). */
  agentAccount?: string
  /** Block height at launch — the `fromBlock` every chain probe reads from. */
  startedAtBlock?: number
}

/** One grader's verdict. Same shape spirit as `scenarios/types.ts`. */
export interface GraderResult {
  pass: boolean
  detail: string
}

/**
 * What a grader may reach besides the log. Everything live is injected so a
 * unit test can run a grader against a recorded log and a fake probe with no
 * model and no network — the #3958 acceptance criterion.
 */
export interface GraderContext {
  resolved?: ResolvedTask
  /** Chain probe: exact USDC Transfer(from → to, amount) at/after `fromBlock`. */
  probeTransfer?: (expected: {
    from: string
    to: string
    amountAtomic: bigint
    fromBlock?: number
  }) => Promise<{ ok: true; txHash: string } | { ok: false; error: string }>
  /** Backend probe: the payment's status for one id. */
  probePaymentStatus?: (paymentId: string) => Promise<
    { ok: true; status: string } | { ok: false; error: string }
  >
}

/** The graders a task file may name. The registry is closed on purpose. */
export type GraderName =
  | 'transfer_settled'
  | 'payment_status_settled'
  | 'no_payment_retry_after_refusal'
  | 'agent_status_before_payment'
  | 'x402_request_mode_replay'
  | 'tool_called'
