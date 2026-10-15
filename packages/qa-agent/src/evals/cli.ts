/**
 * CLI entry for the eval suite: `npm run evals -w packages/qa-agent -- --help`.
 *
 * Modes:
 *   --list           print the loaded tasks and exit (no agent, no chain).
 *   (default)        run the suite: resolve every task against the live
 *                    budget, run k trials per task through the adapter lane
 *                    (`QA_EVAL_ADAPTER`: `hermes` default, `claude-code` for
 *                    #3959's lane), apply the graders, write the JSON report
 *                    + readable summary + the `$GITHUB_STEP_SUMMARY` markdown.
 *   --limit=N        run only the FIRST N tasks in sequence order — the
 *                    5-task cost-pilot / PR-subset slice (#3959).
 *
 * The run needs: QA_API_URL, the eval agent's API key (QA_DELEGATION_AGENT_API_KEY
 * by convention — the runbook names the exact env), the recipient
 * (QA_PAYMENT_TO), the agent account (QA_DELEGATION_ACCOUNT) and — for the
 * chain probe — QA_RPC_URL_BASE_SEPOLIA is inherited from `lib/chain.ts`.
 * The x402 URL tasks additionally read QA_EVAL_X402_TARGET (the `{target}`
 * placeholder — an address and a URL cannot be one env var); required only
 * when the loaded task set renders it.
 * Missing config fails BEFORE the first agent session, not mid-night.
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  ClaudeCodeAdapter,
  claudeCodeConfigFromEnv,
  writeSessionEvidence,
  type ClaudeCodeSession,
} from './claude-code.js'
import { hermesAdapterConfigFromEnv, runHermesTask } from './hermes.js'
import { anyTaskUsesTarget, loadTasks, orderTasksForSequence, resolveTask } from './tasks.js'
import { renderSummary, runSuite, type EvalAdapter, type HostedMcpInfo } from './runner.js'
import { renderMarkdownSummary } from './summary.js'
import { observerProvider, describeObserverRpc } from '../lib/chain.js'
import { HavenApi } from '../lib/haven-api.js'
import { readOnchainBudget } from '../lib/delegation-budget.js'
import { loadQaConfig } from '../config.js'

function env(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    console.error(`Missing ${name} — see docs/operations/agent-evals.md for the full env contract.`)
    process.exit(2)
  }
  return v
}

async function main() {
  const args = process.argv.slice(2)
  const { tasks, invalid } = await loadTasks()

  if (args.includes('--list')) {
    for (const t of tasks) {
      console.log(`${t.id}  [${t.category}]  graders: ${t.graders.map((g) => g.name).join(', ')}`)
      console.log(`  source: ${t.source.kind}: ${t.source.ref} — ${t.source.note}`)
    }
    for (const i of invalid) console.error(`INVALID ${i.error}`)
    process.exit(invalid.length > 0 ? 1 : 0)
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
  // The cost pilot / PR subset slice (#3959): the FIRST N tasks in sequence
  // order — slice tasks first, the budget-draining full-remaining send last,
  // so a 5-task pilot cannot zero the period budget on task one.
  const limitRaw = args.find((a) => a.startsWith('--limit='))?.split('=')[1]
  const limit = limitRaw === undefined ? undefined : Number(limitRaw)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    console.error('--limit must be a positive integer')
    process.exit(2)
  }

  const cfg = loadQaConfig()
  const apiKey = env('QA_EVAL_AGENT_API_KEY')
  const recipient = env('QA_EVAL_RECIPIENT')
  const agentAccount = env('QA_EVAL_AGENT_ACCOUNT')
  // The x402 URL tasks render {target}, not {recipient}: an address and an
  // HTTP target cannot be one env var. Required only when a loaded task
  // actually renders it, and checked BEFORE the first agent session.
  const ordered = orderTasksForSequence(tasks)
  const selected = limit !== undefined ? ordered.slice(0, limit) : ordered
  const x402Target = process.env.QA_EVAL_X402_TARGET?.trim() || undefined
  if (anyTaskUsesTarget(selected) && !x402Target) {
    console.error('Missing QA_EVAL_X402_TARGET — a loaded task renders {target} (the x402 URL tasks); see docs/operations/agent-evals.md.')
    process.exit(2)
  }
  const outPath = args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? `evals-report-${Date.now()}.json`

  // The budget read: live, or nothing — a guessed amount would turn a
  // success task into a refusal three trials deep (the #2016 discipline).
  const api = new HavenApi(cfg, apiKey)
  const budgetSource = async () => {
    const read = await readOnchainBudget(api, 'USDC', 'floor')
    return 'error' in read ? read : { remaining: read.remaining }
  }

  const provider = observerProvider()
  const startedAtBlock = await provider.getBlockNumber()

  const resolved = []
  for (const task of selected) {
    const r = await resolveTask(task, { budget: budgetSource, recipient, x402Target, agentAccount, startedAtBlock })
    if ('error' in r) {
      console.error(r.error)
      process.exit(2)
    }
    resolved.push(r.resolved)
  }

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
  // built from the PR checkout; a dev-deployed run names the URL and says so.
  const hostedMcpSource = args.find((a) => a.startsWith('--hosted-mcp-source='))?.split('=')[1]
  const hostedMcp: HostedMcpInfo | undefined = hostedMcpSource
    ? {
        source: hostedMcpSource === 'pr-checkout' ? 'pr-checkout' : 'dev-deployed',
        url: args.find((a) => a.startsWith('--hosted-mcp-url='))?.split('=')[1],
        commit: args.find((a) => a.startsWith('--hosted-mcp-commit='))?.split('=')[1],
      }
    : undefined

  console.log(`Running ${resolved.length} tasks × ${trials} trials via ${adapter.name}.`)
  console.log(`Observer: ${describeObserverRpc()}; chain evidence reads from block ${startedAtBlock}.`)
  const report = await runSuite({
    resolved,
    adapter,
    trials,
    hostedMcp,
    graderContext: {
      probeTransfer: async (expected) => {
        const { proveUsdcTransferSince } = await import('../lib/chain.js')
        return proveUsdcTransferSince(
          { from: expected.from, to: expected.to, amount: expected.amountAtomic },
          { fromBlock: expected.fromBlock ?? startedAtBlock, timeoutMs: 120_000, provider },
        )
      },
    },
  })

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
    report.model = [...adapter.sessions].reverse().find((s) => s.model !== undefined)?.model
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

main().catch((err) => {
  console.error((err as Error).message)
  process.exit(2)
})
