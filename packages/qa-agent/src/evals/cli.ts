/**
 * CLI entry for the eval suite: `npm run evals -w packages/qa-agent -- --help`.
 *
 * Modes:
 *   --list           print the loaded tasks and exit (no agent, no chain).
 *   (default)        run the suite: resolve every task against the live
 *                    budget, run k trials per task through the adapter
 *                    (Hermes, `QA_EVAL_HERMES_COMMAND`), apply the graders,
 *                    write the JSON report + readable summary.
 *
 * The run needs: QA_API_URL, the eval agent's API key (QA_DELEGATION_AGENT_API_KEY
 * by convention — the runbook names the exact env), the recipient
 * (QA_PAYMENT_TO), the agent account (QA_DELEGATION_ACCOUNT) and — for the
 * chain probe — QA_RPC_URL_BASE_SEPOLIA is inherited from `lib/chain.ts`.
 * Missing config fails BEFORE the first agent session, not mid-night.
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { hermesAdapterConfigFromEnv, runHermesTask } from './hermes.js'
import { loadTasks, resolveTask } from './tasks.js'
import { renderSummary, runSuite, type EvalAdapter } from './runner.js'
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

  const cfg = loadQaConfig()
  const apiKey = env('QA_EVAL_AGENT_API_KEY')
  const recipient = env('QA_EVAL_RECIPIENT')
  const agentAccount = env('QA_EVAL_AGENT_ACCOUNT')
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
  for (const task of tasks) {
    const r = await resolveTask(task, { budget: budgetSource, recipient, agentAccount, startedAtBlock })
    if ('error' in r) {
      console.error(r.error)
      process.exit(2)
    }
    resolved.push(r.resolved)
  }

  const hermesCfg = hermesAdapterConfigFromEnv()
  const adapter: EvalAdapter = {
    name: 'hermes',
    runTask: (task, trial) => runHermesTask(hermesCfg, { taskId: task.task.id, trial, instruction: task.instruction }),
  }

  console.log(`Running ${resolved.length} tasks × ${trials} trials via ${adapter.name}.`)
  console.log(`Observer: ${describeObserverRpc()}; chain evidence reads from block ${startedAtBlock}.`)
  const report = await runSuite({
    resolved,
    adapter,
    trials,
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

  await writeFile(resolve(outPath), JSON.stringify(report, null, 2))
  const summary = renderSummary(report)
  console.log(summary)
  await writeFile(resolve(`${outPath}.summary.txt`), summary + '\n')
  const anyFail = report.tasks.some((t) => !t.passAll)
  process.exit(anyFail ? 1 : 0)
}

main().catch((err) => {
  console.error((err as Error).message)
  process.exit(2)
})
