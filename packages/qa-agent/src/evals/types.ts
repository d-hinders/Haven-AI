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
  /**
   * The `payment_id` the RESULT carried, if any (#3992 A1): the adapters
   * keep only the envelope fields from result text, and a payment id that
   * appears only in a tool RESULT (not in the next call's arguments) is
   * exactly the one `payment_status_settled` needs to probe.
   */
  paymentId?: string
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
 * atomic units. `delta_atomic` shifts it: `0` for exact-remaining sends
 * (the `direct-send-full-remaining` task), positive to go over budget (the
 * `over-budget-refused` leg derives remaining + 1 USDC the same way).
 *
 * `fraction_of_remaining` — a STRICT fraction (numerator < denominator) of
 * the live remaining budget, floored. A success task that must leave the
 * sequence payable: 30 nightly sessions share ONE period budget (#3958
 * § 4), so a slice that spends everything makes every later success task a
 * guaranteed refusal. Full-remaining sends are the other rule's job, not
 * `fraction: "1/1"`'s.
 */
export type AmountRule =
  | { rule: 'remaining_period_budget'; delta_atomic: string }
  | { rule: 'fraction_of_remaining'; fraction: string }

export interface TaskSource {
  /** Where this task's expectation comes from — the citation is mandatory. */
  kind: 'bug-report' | 'scenario' | 'issue'
  /** Repo-relative path (bug-report/scenario) or the issue number as a string. */
  ref: string
  /** One line naming the specific finding/invariant this task pins. */
  note: string
}

/** The instruction placeholders the runner renders before launch. */
export type InstructionPlaceholder = 'amount' | 'recipient' | 'target'

/**
 * One eval task — the file the runner loads (JSON, never Markdown, #3958).
 *
 * `instruction` may carry `{amount}` / `{recipient}` / `{target}`
 * placeholders, rendered from the resolved amount rule + run config: an
 * address (direct sends read `{recipient}`), an HTTP URL (the x402 tasks
 * read `{target}`, `QA_EVAL_X402_TARGET` — one QA_EVAL_RECIPIENT cannot be
 * both). Tasks that phrase the amount verbally ("your entire remaining
 * budget") leave the placeholder out; the resolved amount still feeds the
 * graders.
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
  /**
   * The ORDERING TIER (#3992 A3) — membership comes from the task FILE, not
   * the category. 1 (default): budget-preserving tasks, run in file order.
   * 2: THE budget drainer — runs ONE trial regardless of `--trials`, after
   * every tier-1 task. 3: tasks whose precondition is an EXHAUSTED budget —
   * they run their k trials after the drainer, and their resolver reads the
   * budget with exhaustion tolerated (an exhausted read is the expected
   * setup, not an error).
   */
  tier?: 1 | 2 | 3
  /**
   * True when the trial's settled spend is the AGENT's purchase — its own
   * size, decided at run time by what the catalog/merchant prices — and NOT
   * the resolved `amountAtomic` (#4071). The consistency guard deducts the
   * resolved amount from the pre-spend read for the trial that follows; for
   * such a task that deduction invents a drop that never happened (the
   * 2026-10-17 run: resolved 316406, actually spent 1000) and timed out red
   * on four innocent trials. The guard instead waits for ANY decrease. A
   * transfer_settled grader is refused with this flag: it probes a transfer
   * of exactly the resolved amount, which is precisely the fiction the flag
   * denies — settle-proof here is `payment_status_settled`.
   */
  settled_amount_unknown?: boolean
}

/** The task after the runner resolved its amount rule + instruction. */
export interface ResolvedTask {
  task: EvalTask
  /** Atomic units. Per the amount rule: remaining + delta, or floor(remaining × fraction). */
  amountAtomic: bigint
  /** The rendered instruction the agent actually received. */
  instruction: string
  recipient?: string
  /** The agent account transfers are expected FROM (the delegate account). */
  agentAccount?: string
  /**
   * Block height the trial's chain probes read FROM. Per TRIAL since #3992
   * A2: the resolver reads the observer block immediately before each
   * trial, so a trial's evidence can never see an earlier trial's transfer.
   */
  startedAtBlock?: number
}

/**
 * One grader's verdict. Same shape spirit as `scenarios/types.ts`.
 *
 * `settledSpendAtomic` is present ONLY on a passing `payment_status_settled`
 * whose probe could read every confirmed payment's amount (#4091): the sum
 * the prior trial actually deducted from the budget — the merchant's real
 * price, not the task's resolved `amountAtomic`. The consistency guard uses
 * it to deduct what actually left the budget instead of an invented slice.
 */
export interface GraderResult {
  pass: boolean
  detail: string
  settledSpendAtomic?: string
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
  /**
   * Backend probe: the payment's status for one id. `amountAtomic` (the
   * settled payment's amount, USDC's 6 decimals — #4091) is present when the
   * payment record carried a parsable amount; the consistency guard needs it
   * to wait for what the trial ACTUALLY spent, not the resolved slice.
   */
  probePaymentStatus?: (paymentId: string) => Promise<
    { ok: true; status: string; amountAtomic?: string } | { ok: false; error: string }
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
