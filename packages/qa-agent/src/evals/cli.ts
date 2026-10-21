/**
 * CLI entry for the eval suite: `npm run evals -w packages/qa-agent -- --help`.
 *
 * Modes:
 *   --list           print the loaded tasks and exit (no agent, no chain).
 *   --compare-with=… regression-only compare: the new report (--new-report=)
 *                    against earlier comparable reports (#3992 D) — alerts
 *                    only on a task that failed pass^k on the last two
 *                    comparable nights after a stable 5-of-7 baseline. No
 *                    agent, no chain, no eval env needed.
 *   (default)        run the suite: k trials per task through the adapter
 *                    lane (`QA_EVAL_ADAPTER`: `hermes` default,
 *                    `claude-code` for #3959's lane), applying the graders,
 *                    writing the JSON report + readable summary + the
 *                    `$GITHUB_STEP_SUMMARY` markdown.
 *   --limit=N        run only the FIRST N tasks in the canonical (tiered)
 *                    order — chosen BEFORE any `--shuffle`, so the 5-task
 *                    cost-pilot / PR-subset slice is stable (#3992 B).
 *   --task=<id>[,…]  run EXACTLY the named task ids (#4218), filtered from
 *                    the canonical (tiered) set — tier order and any
 *                    `--shuffle` still apply, a repeated id runs once, and
 *                    NO prerequisite is added implicitly (a tier-3 id
 *                    alone runs without the drainer). Mutually exclusive
 *                    with `--limit`; refused with exit 2 (before any eval
 *                    env is needed) on an unknown id, an empty value, an
 *                    empty list element, a repeated flag, or `--limit`.
 *   --shuffle=SEED   shuffle the task order WITHIN tiers only; the seed and
 *                    the executed order are recorded in the report (#3992 B).
 *
 * Per-trial resolution (#3992 A2): the suite no longer resolves every task
 * once at launch. A resolver is called immediately before EACH trial; it
 * reads the observer block and the live budget at that moment (and waits,
 * bounded, until the backend reflects the previous settled spend — the
 * /allowances read can lag the observer node). A resolve failure is a RED
 * TRIAL, not an exit. The runner itself still reads no budget and no chain
 * (runner.ts's contract); everything live is injected here.
 *
 * The run needs: QA_HAVEN_API_URL and QA_PAYMENT_TO (loadQaConfig()), the
 * eval agent's API key (QA_EVAL_AGENT_API_KEY by convention — the runbook names the exact env), the recipient
 * (QA_EVAL_RECIPIENT), the agent account (QA_EVAL_AGENT_ACCOUNT) and — for
 * the chain probe — QA_RPC_URL_BASE_SEPOLIA is inherited from `lib/chain.ts`.
 * The x402 URL tasks additionally read QA_EVAL_X402_TARGET (the `{target}`
 * placeholder — an address and a URL cannot be one env var); required only
 * when the loaded task set renders it. Model identity rides env too
 * (#3992 C): QA_EVAL_MODEL, QA_EVAL_INFERENCE_SERVER_BUILD,
 * QA_EVAL_HARNESS_VERSION — anything absent renders "not reported".
 * Missing config fails BEFORE the first agent session, not mid-night.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  ClaudeCodeAdapter,
  claudeCodeConfigFromEnv,
  writeSessionEvidence,
  type ClaudeCodeSession,
} from './claude-code.js'
import { hermesAdapterConfigFromEnv, runHermesTask } from './hermes.js'
import {
  anyTaskUsesTarget,
  loadTasks,
  resolveTask,
  selectTaskSequence,
  exhaustedThresholdAtomic,
  taskNeedsDelegateSnapshot,
} from './tasks.js'
import {
  renderSummary,
  runSuite,
  type BudgetIncreaseEvent,
  type EvalAdapter,
  type HostedMcpInfo,
  type PriorTrialOutcome,
} from './runner.js'
import { renderMarkdownSummary } from './summary.js'
import { compareAgainstBaseline, formatCompareVerdict, parseCompareReport } from './compare.js'
import { observerProvider, describeObserverRpc, ERC20_BALANCE_ABI, SEPOLIA_USDC, USDC_DECIMALS } from '../lib/chain.js'
import { ethers } from 'ethers'
import { HavenApi } from '../lib/haven-api.js'
import { readOnchainBudget, type BudgetUse } from '../lib/delegation-budget.js'
import { loadQaConfig } from '../config.js'
import type { AgentRunLog, EvalTask, GraderContext, ResolvedTask } from './types.js'

function env(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    console.error(`Missing ${name} — see docs/operations/agent-evals.md for the full env contract.`)
    process.exit(2)
  }
  return v
}

/** Anything that can name the current observer block height (the real provider does). */
export interface BlockNumberSource {
  getBlockNumber(): Promise<number>
}

/**
 * The grader probes, built once per run and injected into the runner
 * (#3992 A1). `probePaymentStatus` reads the payment object off the dev
 * backend — without it the `payment_status_settled` grader failed every
 * live trial by construction. The EIP-3009 bridge task (#4205) adds three
 * more: the machine-payment status projection (polled — the #3888 sweeper
 * records the merchant settlement 60–180 s after funding), the receipts
 * row, and the delegate EOA's live USDC balance.
 */

/** How long the merchant-settlement probe polls before giving up (~3 min, #3888's 60–180 s window). */
export const MERCHANT_SETTLEMENT_POLL_MS = 180_000
const MERCHANT_SETTLEMENT_POLL_INTERVAL_MS = 5_000

/**
 * Parse a payment record's human amount (`amount`, e.g. "0.001") into atomic
 * units at USDC's 6 decimals (#4091). Strict decimal string parsing — no
 * float. Returns undefined for anything unparsable: the guard then falls
 * back to waiting for any decrease instead of deducting a wrong size.
 */
function parseHumanAmountToAtomic(amount: unknown): bigint | undefined {
  if (typeof amount !== 'string' || !/^\d+(\.\d+)?$/.test(amount)) return undefined
  const [whole, frac = ''] = amount.split('.')
  const frac6 = frac.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS)
  // A human amount with MORE than 6 decimals cannot be a USDC amount —
  // refuse it rather than silently truncating.
  if (frac.length > USDC_DECIMALS) return undefined
  return BigInt(`${whole}${frac6}`)
}

/**
 * The run-start budget check. A full run ends by draining the period budget
 * (the tier-2 drainer), so a second run in the same period starts on an empty
 * budget and every task fails at resolve — 28 identical red trials that say
 * nothing about the agent (2026-10-20, run 39428253905). When the selected
 * tasks need a funded budget and the read says it is exhausted, stop before
 * any agent session with one message that says what to do.
 *
 * Returns undefined when the run may go ahead.
 */
export function budgetPreflightMessage(
  tasks: Array<Pick<EvalTask, 'tier'>>,
  read: { remaining: bigint } | { error: string },
): string | undefined {
  const needsFunds = tasks.some((t) => (t.tier ?? 1) !== 3)
  if (!needsFunds || !('error' in read)) return undefined
  if (!/exhausted/i.test(read.error)) return undefined
  return (
    'The eval agent\'s period budget is already spent, so no task that pays can run. ' +
    'A full run drains it on purpose (the "spend everything" task), so a second run in the same period finds it empty. ' +
    'Wait for the next period refill, or edit the eval agent\'s budget on the dev dashboard to start a new period now (the dashboard needs a real change, e.g. the amount by 0.01 USDC, and two passkey approvals), then run again. ' +
    `Budget read: ${read.error}`
  )
}

/**
 * The parsed `--task=<id>[,<id>…]` selection (#4218), or the refusal. A
 * union so the caller can `process.exit(2)` on `{ error }` and spread
 * `taskIds` into `selectTaskSequence` otherwise.
 */
export type TaskSelection = { limit?: number; taskIds?: string[] } | { error: string }

/**
 * Parse the `--task=` selection against the loaded task set (#4218). PURE:
 * `main()` calls it BEFORE `loadQaConfig()`, the env checks and the budget
 * preflight, so a typo'd id exits 2 with the named value and needs no eval
 * env — it is never hidden behind a budget exit 3. Refusals, each naming
 * the bad value:
 *   - an id that matches no task file;
 *   - `--task=` (empty) or a list with an empty element (`--task=a,`);
 *   - a repeated `--task=` flag;
 *   - `--task` together with `--limit`.
 * Only the exact `--task=` prefix is a filter — `--tasks=` is an unknown
 * flag, not one. Surrounding whitespace on ids is trimmed; a repeated id is
 * allowed and runs once (selectTaskSequence dedupes).
 */
export function parseTaskSelection(args: string[], tasks: EvalTask[]): TaskSelection {
  const flags = args.filter((a) => a.startsWith('--task='))
  if (flags.length > 1) {
    return { error: `--task given ${flags.length} times (${flags.join(' ')}) — pass ONE comma-separated list` }
  }
  const raw = flags[0]?.split('=').slice(1).join('=')
  if (raw === undefined) return {}
  if (args.some((a) => a.startsWith('--limit='))) {
    return { error: `--task and --limit are mutually exclusive (got ${flags[0]}) — a task selection needs no limit` }
  }
  if (raw.trim() === '') {
    return { error: '--task= is empty — name at least one task id (run --list for them)' }
  }
  const ids = raw.split(',').map((s) => s.trim())
  if (ids.some((id) => id.length === 0)) {
    return { error: `--task has an empty id in "${raw}" — name a comma-separated list of task ids` }
  }
  const known = new Set(tasks.map((t) => t.id))
  const unknown = [...new Set(ids.filter((id) => !known.has(id)))]
  if (unknown.length > 0) {
    return { error: `--task names no task file: ${unknown.map((id) => `"${id}"`).join(', ')} — run --list for the ids` }
  }
  return { taskIds: [...new Set(ids)] }
}

export function buildGraderContext(deps: {
  api: HavenApi
  provider: BlockNumberSource
  /** Injectable delay for the settlement poll (tests). */
  sleep?: (ms: number) => Promise<void>
}): Omit<GraderContext, 'resolved'> {
  const sleep = deps.sleep ?? defaultSleep
  return {
    probeTransfer: async (expected) => {
      const { proveUsdcTransferSince } = await import('../lib/chain.js')
      return proveUsdcTransferSince(
        { from: expected.from, to: expected.to, amount: expected.amountAtomic },
        { fromBlock: expected.fromBlock ?? (await deps.provider.getBlockNumber()), timeoutMs: 120_000, provider: deps.provider as never },
      )
    },
    probePaymentStatus: async (paymentId) => {
      const res = await deps.api.getPayment(paymentId)
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status} reading payment ${paymentId}: ${res.data.error ?? 'backend rejected the read'}` }
      }
      // #4091: the record's amount rides along when present — the grader
      // turns it into the prior trial's actual settled spend. Unparsable or
      // absent → undefined (the guard falls back to any-decrease).
      const amountAtomic = parseHumanAmountToAtomic((res.data as { amount?: unknown }).amount)?.toString()
      return { ok: true, status: res.data.status, ...(amountAtomic !== undefined ? { amountAtomic } : {}) }
    },
    // #4205: the merchant-settlement signal is POLLED, not read once — the
    // #3888 sweeper records the settlement 60–180 s after funding when the
    // agent's own settle did not, so an immediate read would red a correct
    // run. A window that closes without the flag is a definitive
    // `recorded: false`, and a persistent read error is the error it was.
    probeMerchantSettlement: async (paymentId) => {
      const deadline = Date.now() + MERCHANT_SETTLEMENT_POLL_MS
      let lastError: string | undefined
      for (;;) {
        const res = await deps.api.getMachinePaymentStatus(paymentId)
        if (res.ok && res.data.merchant_settlement_recorded === true) return { ok: true, recorded: true }
        if (!res.ok) {
          lastError = `HTTP ${res.status} reading machine-payment status for ${paymentId}: backend rejected the read`
        }
        if (Date.now() > deadline) {
          return lastError !== undefined ? { ok: false, error: lastError } : { ok: true, recorded: false }
        }
        await sleep(MERCHANT_SETTLEMENT_POLL_INTERVAL_MS)
      }
    },
    probeReceipt: async (paymentId) => {
      const res = await deps.api.listReceipts(25)
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status} reading machine-payment receipts: backend rejected the read` }
      }
      return { ok: true, row: (res.data.receipts ?? []).find((r) => r.payment_id === paymentId) ?? null }
    },
    probeDelegateBalance: async (address) => {
      try {
        const usdc = new ethers.Contract(SEPOLIA_USDC, [...ERC20_BALANCE_ABI], deps.provider as never)
        const atomic: bigint = await usdc.balanceOf(address)
        return { ok: true, atomic: atomic.toString() }
      } catch (error) {
        return { ok: false, error: `balanceOf(${address}) failed: ${String((error as Error)?.message ?? error).slice(0, 200)}` }
      }
    },
  }
}

export interface BudgetSourceFor {
  (use: BudgetUse): Promise<{ remaining: bigint } | { error: string }>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface PerTrialResolverDeps {
  /** The live budget read; `use` carries the refusal semantics (delegation-budget.ts). */
  readBudget: BudgetSourceFor
  /** The observer node's current block height. */
  blockNumber: () => Promise<number>
  recipient?: string
  x402Target?: string
  agentAccount?: string
  /** How long the consistency guard waits for the backend to reflect a settled spend. */
  consistencyTimeoutMs?: number
  consistencyPollMs?: number
  /** Injectable delay for tests. */
  sleep?: (ms: number) => Promise<void>
  /**
   * The resolve-time delegate EOA snapshot (#4205): the agent's delegate
   * address (`GET /machine-payments/agent` `delegate_address`) and its live
   * USDC balance, read immediately before the trial. Only consulted for
   * tasks whose graders need it (`taskNeedsDelegateSnapshot`) — the other
   * tasks' hot path gains no extra reads. Absent (or failing) for a task
   * that needs it → the trial's graders fail with that named cause rather
   * than silently grading against a missing snapshot.
   */
  delegateSnapshot?: () => Promise<{ delegateEoa: string; balanceAtomic: bigint } | { error: string }>
}

export interface PerTrialResolver {
  resolve: (task: EvalTask, trial: number, prior?: PriorTrialOutcome) => Promise<ResolvedTask>
  /** Budget INCREASES detected between trials (a refill boundary crossed mid-run). */
  budgetEvents: BudgetIncreaseEvent[]
}

/**
 * The CLI's per-trial resolver (#3992 A2). Immediately before each trial:
 * 1. the consistency guard — when the previous trial (of ANY task) settled a
 *    payment, wait until the backend budget read reflects that spend (it
 *    reads /allowances, which can lag the observer node). A budget INCREASE
 *    is recorded as a refill-boundary event instead. On timeout: throw → the
 *    trial is red with the named cause.
 * 2. a fresh observer block — the trial's own `fromBlock`, so its evidence
 *    can never see an earlier trial's transfer.
 * 3. the amount from the budget read of THIS moment (tier-3 tasks read with
 *    `exhausted-ok`: their precondition IS a spent budget).
 */
export function createPerTrialResolver(deps: PerTrialResolverDeps): PerTrialResolver {
  const timeoutMs = deps.consistencyTimeoutMs ?? 120_000
  const pollMs = deps.consistencyPollMs ?? 2_000
  const sleep = deps.sleep ?? defaultSleep
  const budgetEvents: BudgetIncreaseEvent[] = []
  let lastRemaining: bigint | undefined

  const readRemaining = async (use: BudgetUse): Promise<bigint> => {
    const read = await deps.readBudget(use)
    if ('error' in read) throw new Error(read.error)
    return read.remaining
  }

  const resolve = async (task: EvalTask, trial: number, prior?: PriorTrialOutcome): Promise<ResolvedTask> => {
    const use: BudgetUse = task.tier === 3 ? 'exhausted-ok' : 'floor'
    // #4071/#4091: a settled trial's spend is NOT always the resolved amount.
    // What the guard deducts is derived from the prior trial's own evidence:
    //  - a PASSING `transfer_settled` probes an on-chain transfer of exactly
    //    the resolved amount — there the two are equal by construction;
    //  - otherwise (the whole x402 family, where the MERCHANT's price is what
    //    settles) the passing `payment_status_settled` carries the sum of the
    //    confirmed payments' actual amounts (#4091);
    //  - when neither evidence exists the spend size is unknown: the guard
    //    waits for ANY decrease, never for an invented drop (the 2026-10-17
    //    run red on four innocent trials: resolved 316406, actually 1000).
    // `settled_amount_unknown` still means "the resolved amount is not the
    // spend" — with the derivation it is belt-and-suspenders rather than the
    // mechanism, but its invariant (never with expectTransfer) is unchanged.
    const transferProved = prior?.record.graders.some((g) => g.name === 'transfer_settled' && g.pass) ?? false
    let derivedSpend: bigint | undefined
    if (prior?.settled === true) {
      if (transferProved) {
        derivedSpend = prior.resolved.amountAtomic
      } else {
        let known = false
        let total = 0n
        for (const g of prior.record.graders) {
          if (g.name === 'payment_status_settled' && g.pass && g.settledSpendAtomic !== undefined) {
            total += BigInt(g.settledSpendAtomic)
            known = true
          }
        }
        if (known) derivedSpend = total
      }
    }
    const spend = derivedSpend ?? 0n
    const priorSpendSizeUnknown = prior?.settled === true && derivedSpend === undefined
    if ((spend > 0n || priorSpendSizeUnknown) && lastRemaining !== undefined) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const remaining = await readRemaining(use)
        if (lastRemaining !== undefined && remaining > lastRemaining) {
          // A refill boundary was crossed mid-run (the runbook's Daily
          // period question) — record it, don't fight it.
          budgetEvents.push({
            detectedBeforeTask: task.id,
            detectedBeforeTrial: trial,
            previousRemainingAtomic: lastRemaining.toString(),
            observedRemainingAtomic: remaining.toString(),
          })
          lastRemaining = remaining
          break
        }
        const caughtUp =
          spend > 0n
            ? remaining <= lastRemaining - spend
            : // The spend size is the agent's: any decrease proves the read
              // moved past the pre-spend value.
              remaining < lastRemaining
        if (caughtUp) {
          lastRemaining = remaining
          break
        }
        if (Date.now() > deadline) {
          throw new Error(
            spend > 0n
              ? `budget consistency timeout: the backend still reports ${remaining} after the previous ` +
                  `trial's settled spend of ${spend} (expected ≤ ${lastRemaining - spend}) — the ` +
                  `/allowances read did not catch up within ${timeoutMs}ms`
              : `budget consistency timeout: the backend still reports ${remaining} after the previous ` +
                  `trial's settled purchase (${prior?.taskId}, spend size set by the merchant, not by ` +
                  `this run) — the /allowances read never decreased within ${timeoutMs}ms`,
          )
        }
        await sleep(pollMs)
      }
    } else {
      lastRemaining = await readRemaining(use)
    }
    const startedAtBlock = await deps.blockNumber()
    const remaining = lastRemaining
    // A tier-3 task's setup IS an exhausted budget: verify it at run time
    // instead of trusting the tier order. If the drainer did not actually
    // drain (it failed, its spend has not landed, or a Daily refill came
    // mid-run), the trial is red with a named cause — otherwise an agent
    // declining a purchase that would have fit could pass, and a correct
    // agent that paid would fail.
    const exhaustedBelow = exhaustedThresholdAtomic(task)
    if (exhaustedBelow !== undefined && remaining !== undefined && remaining >= exhaustedBelow) {
      throw new Error(
        `tier-3 precondition not met: remaining budget ${remaining} atomic is not below ${exhaustedBelow} (${task.requires.find((r) => r.startsWith('EXHAUSTED'))}) — the budget was not exhausted when this task ran`,
      )
    }
    const r = await resolveTask(task, {
      budget: async () => ({ remaining }),
      recipient: deps.recipient,
      x402Target: deps.x402Target,
      agentAccount: deps.agentAccount,
      startedAtBlock,
    })
    if ('error' in r) throw new Error(r.error)
    // The resolve-time delegate EOA snapshot (#4205): read ONLY when this
    // task's graders need it, and at THIS moment — the stranded-balance
    // grader compares a delta against the trial's own start, never a
    // historical balance. A failing snapshot is a red trial with the cause,
    // same contract as the budget read.
    if (taskNeedsDelegateSnapshot(task) && deps.delegateSnapshot) {
      const snap = await deps.delegateSnapshot()
      if ('error' in snap) throw new Error(`delegate EOA snapshot failed for task ${task.id}: ${snap.error}`)
      r.resolved.delegateEoa = snap.delegateEoa
      r.resolved.delegateEoaBalanceBeforeAtomic = snap.balanceAtomic.toString()
    }
    return r.resolved
  }

  return { resolve, budgetEvents }
}

/** The compare mode (#3992 D): no eval env, no agent, no chain — pure report reading. */
async function runCompare(args: string[]): Promise<void> {
  const newReportPath = args.find((a) => a.startsWith('--new-report='))?.split('=')[1]
  if (!newReportPath) {
    throw new Error('--compare-with needs --new-report=<path> naming the NEW report.')
  }
  const historyArg = args.find((a) => a.startsWith('--compare-with='))?.split('=')[1] ?? ''
  const historyPaths = historyArg.split(',').map((s) => s.trim()).filter(Boolean)
  const newRaw = await readFile(resolve(newReportPath), 'utf8')
  const newOutcome = parseCompareReport(newRaw, newReportPath)
  if ('error' in newOutcome) throw new Error(newOutcome.error)
  const history: Array<{ outcome: ReturnType<typeof parseCompareReport> }> = []
  for (const p of historyPaths) {
    try {
      history.push({ outcome: parseCompareReport(await readFile(resolve(p), 'utf8'), p) })
    } catch (err) {
      history.push({ outcome: { error: `${p}: ${(err as Error).message}` } })
    }
  }
  const verdict = compareAgainstBaseline(newOutcome.report, history)
  console.log(formatCompareVerdict(verdict, newOutcome.report))
  process.exit(verdict.alerts.length > 0 ? 1 : 0)
}

async function main() {
  const args = process.argv.slice(2)
  const { tasks, invalid } = await loadTasks()

  if (args.includes('--list')) {
    for (const t of tasks) {
      console.log(`${t.id}  [${t.category}]  tier ${t.tier ?? 1}  graders: ${t.graders.map((g) => g.name).join(', ')}`)
      console.log(`  source: ${t.source.kind}: ${t.source.ref} — ${t.source.note}`)
    }
    for (const i of invalid) console.error(`INVALID ${i.error}`)
    process.exit(invalid.length > 0 ? 1 : 0)
  }

  if (args.some((a) => a.startsWith('--compare-with='))) {
    await runCompare(args)
  }

  if (invalid.length > 0) {
    for (const i of invalid) console.error(`INVALID ${i.error}`)
    process.exit(2)
  }
  const trials = Number(args.find((a) => a.startsWith('--trials='))?.split('=')[1] ?? '3')
  if (!Number.isInteger(trials) || trials < 1) {
    console.error('--trials must be a positive integer')
    process.exit(2)
  }
  // The cost pilot / subset slice (#3959): the FIRST N tasks in the
  // canonical (tiered) order — slice tasks first, the budget-draining
  // full-remaining send in tier 2, the exhausted-budget tasks in tier 3 —
  // so a 5-task pilot cannot zero the period budget on task one (#3992 B:
  // the subset is chosen BEFORE any shuffle and is shuffle-stable).
  const limitRaw = args.find((a) => a.startsWith('--limit='))?.split('=')[1]
  const limit = limitRaw === undefined ? undefined : Number(limitRaw)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    console.error('--limit must be a positive integer')
    process.exit(2)
  }
  // Deterministic within-tier shuffle (#3992 B); the seed rides the report.
  const shuffleRaw = args.find((a) => a.startsWith('--shuffle='))?.split('=')[1]
  let shuffleSeed: number | undefined
  if (shuffleRaw !== undefined) {
    shuffleSeed = Number(shuffleRaw)
    if (!Number.isInteger(shuffleSeed) || shuffleSeed < 0) {
      console.error('--shuffle must be a non-negative integer seed')
      process.exit(2)
    }
  }

  // The --task selection (#4218): parsed BEFORE loadQaConfig() and every
  // env check, so a typo'd id exits 2 naming it and needs no eval env — it
  // is never hidden behind a budget exit 3.
  const selection = parseTaskSelection(args, tasks)
  if ('error' in selection) {
    console.error(`--task: ${selection.error}`)
    process.exit(2)
  }
  const taskIds = 'taskIds' in selection ? selection.taskIds : undefined

  const cfg = loadQaConfig()
  const apiKey = env('QA_EVAL_AGENT_API_KEY')
  const recipient = env('QA_EVAL_RECIPIENT')
  const agentAccount = env('QA_EVAL_AGENT_ACCOUNT')
  // The x402 URL tasks render {target}, not {recipient}: an address and an
  // HTTP target cannot be one env var. Required only when a loaded task
  // actually renders it, and checked BEFORE the first agent session.
  const selected = selectTaskSequence(tasks, { limit, shuffleSeed, ...(taskIds ? { taskIds } : {}) })
  const x402Target = process.env.QA_EVAL_X402_TARGET?.trim() || undefined
  if (anyTaskUsesTarget(selected) && !x402Target) {
    console.error('Missing QA_EVAL_X402_TARGET — a loaded task renders {target} (the x402 URL tasks); see docs/operations/agent-evals.md.')
    process.exit(2)
  }
  const outPath = args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? `evals-report-${Date.now()}.json`

  // The budget read: live, or nothing — a guessed amount would turn a
  // success task into a refusal three trials deep (the #2016 discipline).
  // Tier-3 tasks read with `exhausted-ok` (their precondition IS a spent
  // budget); everything else refuses an exhausted/fallback read.
  const api = new HavenApi(cfg, apiKey)
  const budgetSource: BudgetSourceFor = async (use) => {
    const read = await readOnchainBudget(api, 'USDC', use)
    return 'error' in read ? read : { remaining: read.remaining }
  }

  // Run-start budget check: stop with one clear message instead of a run of
  // identical resolve failures when the period budget is already spent.
  const preflight = budgetPreflightMessage(selected, await budgetSource('floor'))
  if (preflight) {
    console.log(`::error::${preflight}`)
    await writeFile(resolve(`${outPath}.summary.md`), `## Agent evals: not run\n\n${preflight}\n`)
    await writeFile(resolve(`${outPath}.summary.txt`), `Agent evals: not run. ${preflight}\n`)
    process.exit(3)
  }

  const provider = observerProvider()
  // Per-trial resolution (#3992 A2): the block and the budget are read
  // immediately before each trial, never once at launch. The EIP-3009
  // bridge task (#4205) additionally snapshots the delegate EOA and its
  // USDC balance at the same moment — its stranded-balance grader is a
  // delta against the trial's own start.
  const delegateSnapshot = async (): Promise<{ delegateEoa: string; balanceAtomic: bigint } | { error: string }> => {
    const agent = await api.getAgent()
    if (!agent.ok) return { error: `HTTP ${agent.status} reading GET /machine-payments/agent` }
    const delegate = agent.data.delegate_address
    if (!delegate) return { error: 'agent identity carries no delegate_address' }
    try {
      const usdc = new ethers.Contract(SEPOLIA_USDC, [...ERC20_BALANCE_ABI], provider as never)
      const atomic: bigint = await usdc.balanceOf(delegate)
      return { delegateEoa: delegate, balanceAtomic: atomic }
    } catch (error) {
      return { error: `balanceOf(${delegate}) failed: ${String((error as Error)?.message ?? error).slice(0, 200)}` }
    }
  }
  const resolver = createPerTrialResolver({
    readBudget: budgetSource,
    blockNumber: () => provider.getBlockNumber(),
    recipient,
    x402Target,
    agentAccount,
    delegateSnapshot,
  })

  // The lane switch (#3959): `claude-code` runs the SAME task files and
  // graders through `claude -p`; `hermes` (default) is lane 1. Both refuse to
  // invent their command — each lane's template is caller-owned env.
  const adapterKind = process.env.QA_EVAL_ADAPTER?.trim() || 'hermes'
  if (!['hermes', 'claude-code'].includes(adapterKind)) {
    console.error(`QA_EVAL_ADAPTER must be "hermes" or "claude-code", got "${adapterKind}"`)
    process.exit(2)
  }
  let adapter: EvalAdapter
  if (adapterKind === 'claude-code') {
    adapter = new ClaudeCodeAdapter(claudeCodeConfigFromEnv())
  } else {
    const hermesCfg = hermesAdapterConfigFromEnv()
    adapter = {
      name: 'hermes',
      runTask: (task, trial) => runHermesTask(hermesCfg, { taskId: task.task.id, trial, instruction: task.instruction }),
    }
  }

  // Where the hosted MCP leg ran (#3959): the subset names the commit it
  // built from this checkout; a dev-deployed run names the URL and says so.
  const hostedMcpSource = args.find((a) => a.startsWith('--hosted-mcp-source='))?.split('=')[1]
  const hostedMcp: HostedMcpInfo | undefined = hostedMcpSource
    ? {
        source: hostedMcpSource === 'pr-checkout' ? 'pr-checkout' : 'dev-deployed',
        url: args.find((a) => a.startsWith('--hosted-mcp-url='))?.split('=')[1],
        commit: args.find((a) => a.startsWith('--hosted-mcp-commit='))?.split('=')[1],
      }
    : undefined

  // The tier-2 drainer runs ONE trial regardless of --trials (#3992 A3):
  // after one it has nothing left to drain, so its pass^k is not a k-trial
  // number and the report marks it "k=1 (drains budget)".
  const trialCountFor = (task: EvalTask): number => (task.tier === 2 ? 1 : trials)

  // "the drainer × 1" only when a drainer is actually selected (#4218) — a
  // filtered tier-1-only run must not claim one.
  const drainerNote = selected.some((t) => t.tier === 2) ? ', the drainer × 1' : ''
  console.log(`Running ${selected.length} tasks (order: ${selected.map((t) => t.id).join(' → ')}) — tier-1 tasks × ${trials} trials${drainerNote}, via ${adapter.name}.`)
  console.log(`Observer: ${describeObserverRpc()}; chain evidence reads from each trial's own start block.`)
  const report = await runSuite({
    tasks: selected,
    resolveForTrial: resolver.resolve,
    adapter,
    trials,
    trialCountFor,
    shuffleSeed,
    ...(taskIds ? { taskFilter: taskIds } : {}),
    hostedMcp,
    graderContext: buildGraderContext({ api, provider }),
  })
  if (resolver.budgetEvents.length > 0) report.budgetEvents = resolver.budgetEvents

  // Model identity in every report (#3992 C): env-supplied for the Hermes
  // lane (the runbook names the vars); the Claude Code lane's stream value
  // stands when the env does not name one.
  const envModel = process.env.QA_EVAL_MODEL?.trim() || undefined
  const envInferenceBuild = process.env.QA_EVAL_INFERENCE_SERVER_BUILD?.trim() || undefined
  const envHarnessVersion = process.env.QA_EVAL_HARNESS_VERSION?.trim() || undefined
  report.model = envModel ?? report.model
  if (envInferenceBuild) report.inferenceServerBuild = envInferenceBuild
  if (envHarnessVersion) report.harnessVersion = envHarnessVersion

  // Cost + model enrichment (the Claude Code lane's `total_cost_usd`, #3959):
  // the runner stays adapter-agnostic, so the CLI merges the adapter's
  // per-session cost records into the report before it is written.
  if (adapter instanceof ClaudeCodeAdapter && adapter.sessions.length > 0) {
    const byKey = new Map<string, ClaudeCodeSession>(adapter.sessions.map((s) => [`${s.taskId}:${s.trial}`, s]))
    for (const task of report.tasks) {
      for (const trial of task.trials) {
        const session = byKey.get(`${task.id}:${trial.trial}`)
        if (session?.costUsd !== undefined) trial.costUsd = session.costUsd
      }
    }
    report.totalCostUsd = adapter.sessions.reduce((acc, s) => acc + (s.costUsd ?? 0), 0)
    report.model = envModel ?? [...adapter.sessions].reverse().find((s) => s.model !== undefined)?.model ?? report.model
    // The pilot's per-session evidence: cost + wall time + model per session.
    await writeSessionEvidence(adapter.sessions, resolve(`${outPath}.sessions.json`))
  }

  await writeFile(resolve(outPath), JSON.stringify(report, null, 2))
  const summary = renderSummary(report)
  console.log(summary)
  await writeFile(resolve(`${outPath}.summary.txt`), summary + '\n')
  // The $GITHUB_STEP_SUMMARY half (#3959 scope 7): the agent-evals workflow
  // appends this file; readable without opening the artifact.
  await writeFile(resolve(`${outPath}.summary.md`), renderMarkdownSummary(report))
  const anyFail = report.tasks.some((t) => !t.passAll)
  process.exit(anyFail ? 1 : 0)
}

/** Runs only when this file is the process entry (the balances-cli.ts idiom) — tests import the helpers. */
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('evals/cli.ts')
  } catch {
    return false
  }
})()

if (isMain) {
  main().catch((err) => {
    console.error((err as Error).message)
    process.exit(2)
  })
}
