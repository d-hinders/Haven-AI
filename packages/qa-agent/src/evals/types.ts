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
  /**
   * True when the tool answered with `idempotent_replay: true`: it returned
   * an EARLIER payment for the same idempotency key and created nothing new
   * (2026-10-23: bridge trial 2 replayed trial 1's payment and graded green).
   */
  idempotentReplay?: boolean
  /**
   * The offline verdict a `haven_verify_receipt` result carried (#4677): the
   * `reason` beside a boolean `verified` — `not_verifiable_offline` for a
   * direct or eip3009 bundle, `not_a_signed_receipt` for a list row, or a
   * signer-mismatch reason. Absent on every other tool's result.
   */
  receiptVerdict?: string
  /**
   * The `task_budget.status` a task-budget tool result carried (#4677):
   * `pending` after open, `open` after the open signature is submitted,
   * `closing` after close, `closed` after the close signature is submitted.
   * The grader reads the two explicit `haven_get_task_budget` reads from it,
   * and the FINAL state from the backend probe — a call alone proves nothing.
   */
  taskBudgetStatus?: string
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
export type InstructionPlaceholder = 'amount' | 'recipient' | 'target' | 'payment_id' | 'landing_url'

/**
 * The cold-agent profile (#4680): a fresh agent with no Haven MCP servers, no
 * repository knowledge and no Haven credentials, given only the dev landing
 * URL. The harness builds a per-trial `HOME` and an MCP config holding ONE
 * eval-only command tool, so the agent can run the CLI the manifest serves
 * without a shell.
 *
 * `landingUrl` comes from the workflow (`QA_EVAL_DEV_LANDING_URL`), never from
 * the task file: the same task must run against a preview or a local target.
 * `cliPackage` is read from the deployment's manifest at trial start, so the
 * task follows the product rather than pinning a dist-tag.
 */
export interface ColdProfile {
  /** The dev landing URL the agent is given. */
  landingUrl: string
  /** The CLI package spec the manifest serves (`packages.cli.one_liner`). */
  cliPackage: string
}

/**
 * The adapter lanes a task may run on (#4678).
 *
 * Absent means EVERY lane — the eleven starter tasks keep running on both
 * lanes unchanged. A task that needs a per-trial MCP config names
 * `['claude-code']`: Hermes' template takes only `{instruction}` and `{log}`
 * and its MCP wiring lives in its profile, so it cannot take one.
 */
export type EvalLane = 'hermes' | 'claude-code'

/**
 * The state the harness prepares for ONE trial before the agent starts
 * (#4678). A task with no `setup` runs against the shared eval agent exactly
 * as before.
 *
 * `fundingAtomic` is the ONLY amount a throwaway trial takes from the eval
 * agent's period budget: the funding payment is made BY the eval agent, and
 * returned USDC does not restore period budget. `"0"` means the trial needs
 * no eval-budget funds at all (the revoked-agent task), which is what exempts
 * it from the run-start exit-3 preflight.
 */
export interface ThrowawaySetup {
  kind: 'throwaway-identity'
  /**
   * The label in the throwaway email (`qa-<label>-<rand>@haven.test`) and in
   * the `QA <label> (throwaway)` name — #4679's purge matches on BOTH, so
   * neither may drift.
   */
  label: string
  /** The budget granted to the throwaway agent, atomic. */
  budgetAtomic: string
  /** USDC moved from the eval account into the throwaway account, atomic. */
  fundingAtomic: string
  /**
   * A short grant expiry, seconds from build (the ended-budget task). The
   * backend accepts any future `expires_at` (`routes/agent-delegations.ts`),
   * so the trial sets one and then POLLS the authoritative allowance signal
   * until the budget reads as ended — a fixed sleep races wall-clock and
   * block time.
   */
  expiresInSeconds?: number
  /**
   * The prepared state the harness builds before the agent starts:
   *  - `interrupted-purchase` — a payment intent the agent must RESUME, never
   *    pay again;
   *  - `ended-budget` — a grant that has already ended, verified observable
   *    before launch;
   *  - `revoked-agent` — the agent's key is revoked before launch.
   */
  prepare?: 'interrupted-purchase' | 'ended-budget' | 'revoked-agent'
}

export type TaskSetup = ThrowawaySetup

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
  category:
    | 'direct-payment'
    | 'x402-paywall'
    | 'over-budget'
    | 'interrupted-purchase'
    | 'budget-ended'
    | 'agent-revoked'
    | 'task-budget'
    | 'onboarding'
  instruction: string
  /** What the run needs provisioned before launch (documented in the runbook). */
  requires: string[]
  /**
   * The amount rule. REQUIRED for a task with no `setup`; a task with a
   * `setup` may omit it, because its money is the setup's `fundingAtomic` —
   * the eval agent's period budget is touched by exactly that amount and by
   * nothing the resolver invents (#4678). An `onboarding` task may omit it
   * too: it spends nothing and is exempt from the budget read (#4680).
   */
  amount?: AmountRule
  /** Graders to apply, in order. All must pass for the trial to pass. */
  graders: Array<{ name: string; options?: Record<string, unknown> }>
  /** True when the task expects an on-chain USDC transfer as its outcome. */
  expectTransfer: boolean
  source: TaskSource
  /**
   * The adapter lanes this task may run on (#4678). Absent = every lane.
   * A task naming lanes that exclude the running lane is reported `skipped`,
   * and a skipped task NEVER counts as passed.
   */
  lanes?: EvalLane[]
  /**
   * The per-trial prepared state (#4678). Absent = the shared eval agent,
   * no setup, no teardown — the eleven starter tasks are unchanged.
   */
  setup?: TaskSetup
  /**
   * The cold-agent profile (#4680). `'cold'` means the harness builds a
   * per-trial `HOME` and an MCP config holding ONE eval-only command tool —
   * no Haven MCP servers, no Haven credentials — and the instruction renders
   * `{landing_url}` from the workflow's dev landing URL. Absent = the lane's
   * normal profile.
   */
  profile?: 'cold'
  /**
   * A per-task command template for the Claude lane (#4678). Absent = the
   * lane's `QA_EVAL_CLAUDE_CODE_COMMAND`. The template may read the trial's
   * own env (`QA_EVAL_TRIAL_*`), which is how a throwaway trial gets its own
   * MCP config without Hermes' profile-bound wiring.
   */
  commandTemplate?: string
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
  /**
   * The eval agent's delegate EOA (`GET /machine-payments/agent`
   * `delegate_address`), snapshotted at resolve time for the EIP-3009
   * bridge task (#4205). On the bridge Haven's own funding transfer goes to
   * this EOA, so the settlement-shape grader pins `settlement_address` to
   * it and the stranded-balance grader reads its USDC balance.
   */
  delegateEoa?: string
  /**
   * The delegate EOA's USDC balance (atomic) read at RESOLVE time —
   * immediately before the trial, by the same snapshot as
   * {@link delegateEoa} — NOT a historical `balanceOf` replayed later
   * (#4205): earlier stranded funds may already sit on the EOA, so the
   * stranded-balance grader compares a delta against THIS reading, taken
   * at the moment the trial started.
   */
  delegateEoaBalanceBeforeAtomic?: string
  /**
   * The trial's OWN agent API key (#4678) — a throwaway trial's, never the
   * eval agent's. The CLI builds that trial's grader context from it, so a
   * `GET /payments/:id` on a throwaway trial cannot read with the eval key.
   */
  trialApiKey?: string
  /**
   * Extra env for the adapter's child process (#4678): the trial's MCP
   * config path, its `HOME`, its API key. The Claude lane merges these over
   * the inherited env; Hermes has no per-trial config and never sees them.
   */
  trialEnv?: Record<string, string>
  /** The per-task command template override (#4678). */
  commandTemplate?: string
  /**
   * The payment id the harness PREPARED for an interrupted-purchase trial
   * (#4678). The agent is handed it and must resume it, never pay again.
   */
  preparedPaymentId?: string
  /** The throwaway account address this trial runs against (#4678). */
  trialAccountAddress?: string
  /**
   * The cold profile's resolved facts (#4680): the landing URL the agent was
   * given and the CLI package the manifest served at trial start. The graders
   * read them, so a score is measured against what the deployment actually
   * advertised rather than a value baked into the task file.
   */
  coldProfile?: ColdProfile
}

/**
 * One grader's verdict. Same shape spirit as `scenarios/types.ts`.
 *
 * `settledSpendAtomic` is present ONLY on a passing spend reporter:
 * `payment_status_settled` whose probe could read every confirmed payment's
 * amount (#4091), or `no_second_fresh_payment` for its one settled purchase
 * (#4676). The runner treats ANY passing grader carrying it as a settlement
 * (`runner.ts` recordSettled), and the loader refuses two reporters on one
 * task (`tasks.ts`) — a new reporter joins that list. It is the sum
 * the prior trial actually deducted from the budget — the merchant's real
 * price, not the task's resolved `amountAtomic`. The consistency guard uses
 * it to deduct what actually left the budget instead of an invented slice.
 */
export interface GraderResult {
  pass: boolean
  detail: string
  settledSpendAtomic?: string
  /**
   * The NUMERIC reading a scoring grader reports (#4680): discovery band 0-3,
   * first-reply steps named 0-3, tool calls to the hand-off, login command 0/1.
   * Present only on a grader that scores rather than merely passes/fails, so
   * the report and the summary can show the number beside the verdict — a
   * bare pass/fail would hide a band that fell from 3 to 2.
   */
  score?: number
  /** The maximum the {@link score} is out of, when the grader has one. */
  scoreMax?: number
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
  /**
   * Machine-payment status probe (the EIP-3009 bridge task, #4205): the
   * `GET /machine-payments/:id/status` projection, polled by the probe
   * implementation until `merchant_settlement_recorded` turns true or a
   * bounded window (~3 min — the #3888 sweeper records 60–180 s after
   * funding when the agent's own settle did not) expires. `recorded: false`
   * is a definitive answer, not an error: the merchant was funded but not
   * proven paid.
   */
  probeMerchantSettlement?: (paymentId: string) => Promise<{ ok: true; recorded: boolean } | { ok: false; error: string }>
  /**
   * Receipt probe (#4205): the `GET /machine-payments/receipts` row matched
   * by `payment_id`, or `null` when no row exists for it. The row carries
   * `settlement_scheme` / `settlement_address` / `merchant_address` — the
   * three signals the settlement-shape grader asserts.
   */
  probeReceipt?: (
    paymentId: string,
  ) => Promise<
    | { ok: true; row: { settlement_scheme?: string | null; settlement_address?: string | null; merchant_address?: string | null } | null }
    | { ok: false; error: string }
  >
  /**
   * USDC balance probe for the delegate EOA (#4205): the AFTER reading of
   * the stranded-balance grader, read only once the merchant settlement is
   * recorded. The BEFORE reading is the resolve-time snapshot on the
   * resolved task, never a historical balance.
   */
  probeDelegateBalance?: (address: string) => Promise<{ ok: true; atomic: string } | { ok: false; error: string }>
  /**
   * Task-budget state probe (#4677): `GET /task-budgets/:id` read with the
   * trial's own agent key. The task-budget grader reads the FINAL state from
   * here — `tool_called` only proves a call occurred, and a close that
   * returned `closing` is not a closed budget.
   */
  probeTaskBudget?: (taskBudgetId: string) => Promise<{ ok: true; status: string } | { ok: false; error: string }>
}

/** The graders a task file may name. The registry is closed on purpose. */
export type GraderName =
  | 'transfer_settled'
  | 'payment_status_settled'
  | 'haven_payment_submitted'
  | 'no_payment_retry_after_refusal'
  | 'agent_status_before_payment'
  | 'x402_request_mode_replay'
  | 'tool_called'
  | 'merchant_settlement_recorded'
  | 'eip3009_settlement_shape'
  | 'nothing_stranded_on_delegate'
  | 'resume_without_repayment'
  | 'declined_before_paying'
  | 'no_second_fresh_payment'
  | 'onboarding_discovery'
  | 'onboarding_first_reply'
  | 'onboarding_tool_calls'
  | 'onboarding_login_command'
  | 'client_out_of_date'
  | 'receipt_verified_offline'
  | 'task_budget_lifecycle'
