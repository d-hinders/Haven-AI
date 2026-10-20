// The agent-evals workflow must build `@haven_ai/core` before the workspace
// package that imports it, must install the `claude` CLI it runs, and must
// give the eval step every env var `loadQaConfig()` requires.
//
// `npm ci` does not create core's `dist/`. The Claude Code lane's first real
// run (2026-10-19, the #3959 cost pilot) died in its build step with
// `Could not resolve "@haven_ai/core"` from packages/mcp-server: zero tasks
// run, nothing graded, and the failure only showed after the owner had
// approved the protected-environment deployment. Same defect class as
// `e2e-workspace-deps.test.mjs` (#1930), asserted rather than remembered.
//
// Only live (uncommented) lines count, and the consumer's build line must be
// present: a commented-out core build or a respelled consumer line must fail
// this guard, not slip past it.
//
// Run with: node --test scripts/ci/agent-evals-workspace-deps.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflow = readFileSync(path.join(ROOT, '.github/workflows/agent-evals.yml'), 'utf8')

/** The live (non-comment) lines of the workflow, in order. */
const live = workflow.split('\n').filter((line) => !/^\s*#/.test(line))
const lineOf = (re) => live.findIndex((line) => re.test(line))

// mcp-server is the package whose build imports `@haven_ai/core`
// (src/tools/contracts.ts, paid-mcp-completion.ts, plain-http-x402.ts).
const CORE_BUILD = /^\s*npm run build -w packages\/core\s*$/
const MCP_SERVER_BUILD = /^\s*npm run build -w packages\/mcp-server\s*$/

test('agent-evals builds @haven_ai/core before packages/mcp-server', () => {
  const core = lineOf(CORE_BUILD)
  const mcp = lineOf(MCP_SERVER_BUILD)
  assert.notEqual(core, -1, 'agent-evals.yml has no live `npm run build -w packages/core` line')
  assert.notEqual(mcp, -1, 'agent-evals.yml has no live `npm run build -w packages/mcp-server` line — update this guard if the build was respelled')
  assert.ok(core < mcp, 'packages/mcp-server is built before packages/core in agent-evals.yml')
})

test('agent-evals installs a pinned claude CLI before running the eval slice', () => {
  const install = lineOf(/^\s*run: npm install -g @anthropic-ai\/claude-code@\d+\.\d+\.\d+(\s|$)/)
  const run = lineOf(/^\s*- name: Run the eval slice\s*$/)
  assert.notEqual(install, -1, 'agent-evals.yml never installs an exactly pinned @anthropic-ai/claude-code')
  assert.notEqual(run, -1, 'agent-evals.yml has no "Run the eval slice" step — update this guard')
  assert.ok(install < run, 'the claude CLI is installed after the eval slice runs')
})

// `loadQaConfig()` (packages/qa-agent/src/config.ts) throws before the first
// agent session when either of these is missing — the second pilot run
// (2026-10-19) stopped on QA_PAYMENT_TO. Keep this list in step with its
// `required` object.
const QA_CONFIG_REQUIRED = ['QA_HAVEN_API_URL', 'QA_PAYMENT_TO']

test('the eval step sets every env var loadQaConfig requires', () => {
  const run = lineOf(/^\s*- name: Run the eval slice\s*$/)
  assert.notEqual(run, -1, 'agent-evals.yml has no "Run the eval slice" step — update this guard')
  const nextStep = live.findIndex((line, i) => i > run && /^\s*- (name|uses|run):/.test(line))
  const step = live.slice(run, nextStep === -1 ? undefined : nextStep)
  for (const name of QA_CONFIG_REQUIRED) {
    assert.ok(
      step.some((line) => new RegExp(`^\\s*${name}:\\s*\\S`).test(line)),
      `"Run the eval slice" does not set ${name}, which loadQaConfig() requires`,
    )
  }
})

test('the guard required list matches loadQaConfig()', () => {
  const config = readFileSync(path.join(ROOT, 'packages/qa-agent/src/config.ts'), 'utf8')
  const block = config.match(/const required = \{([\s\S]*?)\} as const/)
  assert.ok(block, 'could not find `const required = { ... } as const` in packages/qa-agent/src/config.ts — update this guard')
  const names = [...block[1].matchAll(/'(QA_[A-Z0-9_]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(names, [...QA_CONFIG_REQUIRED].sort())
})

// The third pilot run would have spent an approval with signing broken and the
// evidence lost (review of the QA_PAYMENT_TO fix, 2026-10-19): claude starts
// stdio MCP servers from its own cwd, which is not the repo root, and the eval
// CLI resolves --out against packages/qa-agent while the upload reads the
// workspace root.
test('the signer MCP server is launched by absolute path', () => {
  const writer = live.find((line) => line.includes("'haven-signer-eval'"))
  assert.ok(writer, 'agent-evals.yml no longer writes a haven-signer-eval MCP server — update this guard')
  assert.ok(!/args: \['packages\//.test(writer), 'the signer MCP server is launched by a relative packages/ path')
  assert.ok(writer.includes("process.env.GITHUB_WORKSPACE + '/packages/signer/dist/cli.js'"), 'the signer path is not anchored to GITHUB_WORKSPACE')
  assert.ok(writer.includes('HAVEN_X402_BINDING_SIGNER'), 'the signer MCP env does not pass HAVEN_X402_BINDING_SIGNER, so x402 signing refuses')
})

test('the report is written where the summary and upload steps read it', () => {
  const run = live.find((line) => line.includes('npm run evals -w packages/qa-agent'))
  assert.ok(run, 'agent-evals.yml no longer runs the eval CLI — update this guard')
  assert.ok(run.includes('--out="$GITHUB_WORKSPACE/evals-report.json"'), '--out is not anchored to GITHUB_WORKSPACE')
})

test('claude runs from an empty directory with only the wired MCP servers', () => {
  const cmd = live.join('\n')
  assert.ok(/cd "\$RUNNER_TEMP\/claude-cwd" &&/.test(cmd), 'claude does not run from an empty directory, so the repo CLAUDE.md reaches the agent under test')
  assert.ok(cmd.includes('--strict-mcp-config'), 'claude is not limited to the MCP servers the workflow wires (--strict-mcp-config)')
})

// Actions runs `bash -e`, so a failing `claude` ends the login-check step
// before the judge prints the reason — pilot run #6 (2026-10-19) failed in
// 3s with no message. And the `cd` into the empty dir must not move the step,
// or the judge's relative path never resolves (review of that fix).
test('the login check turns off -e, isolates the cd, and runs the judge by absolute path', () => {
  const step = lineOf(/^\s*- name: Check the Claude Code login/)
  assert.notEqual(step, -1, 'agent-evals.yml has no login-check step — update this guard')
  const end = live.findIndex((line, i) => i > step && /^\s*- (name|uses|run):/.test(line))
  const body = live.slice(step, end === -1 ? undefined : end)
  const setE = body.findIndex((line) => /^\s*set \+e\s*$/.test(line))
  const claude = body.findIndex((line) => /claude -p /.test(line))
  assert.notEqual(claude, -1, 'the login-check step no longer runs claude -p — update this guard')
  assert.ok(setE !== -1 && setE < claude, 'the login-check step runs claude under bash -e, so its failure hides the reason')
  assert.match(body[claude], /^\s*\( cd "\$RUNNER_TEMP\/claude-cwd" && claude -p .*\) >/, 'claude in the login check is not run in a subshell, so its cd moves the step')
  assert.ok(body.some((line) => /^\s*node "\$GITHUB_WORKSPACE\/scripts\/ci\/agent-evals-login-check\.mjs"/.test(line)), 'the login-check judge is not run by absolute path')
})

// Owner decision 2026-10-19: the evals run only when the owner starts them.
// A schedule or pull_request trigger queued runs that sat waiting for the
// owner's environment approval and blocked the owner's own runs behind them.
test('agent-evals is triggered by workflow_dispatch only', () => {
  const on = live.findIndex((line) => /^on:\s*$/.test(line))
  assert.notEqual(on, -1, 'agent-evals.yml has no top-level `on:` block — update this guard')
  const end = live.findIndex((line, i) => i > on && /^\S/.test(line))
  const block = live.slice(on + 1, end === -1 ? undefined : end).filter((line) => line.trim() !== '')
  // Trigger keys sit at the block's first indentation level, quoted or not.
  const indent = block.length ? block[0].match(/^\s*/)[0].length : 0
  const triggers = block
    .filter((line) => line.match(/^\s*/)[0].length === indent)
    .map((line) => line.trim().match(/^['"]?([a-z_]+)['"]?:/)?.[1] ?? line.trim())
  assert.deepEqual(triggers, ['workflow_dispatch'])
})

// ── #4137: the session transcripts upload only as a redacted, scanned copy ──
//
// Owner decision 2026-10-20: a redacted artifact, fail-closed, 3 days. The
// redactor (packages/qa-agent/src/evals/redact-sessions.ts) stages, rescans
// and moves only on a clean scan, and sets `clean`; these guards keep the
// workflow wired to that: the gate on `clean`, the retention, no raw upload,
// every secret passed to the redactor, the environment and the allowlist.

/** Every step as its live lines, split at the `      - ` step markers. */
const steps = (() => {
  const jobSteps = live.findIndex((line) => /^\s{4}steps:\s*$/.test(line))
  const out = []
  for (const line of live.slice(jobSteps + 1)) {
    if (/^\s{6}- /.test(line)) out.push([line])
    else if (out.length) out[out.length - 1].push(line)
  }
  return out
})()
const stepNamed = (re) => steps.find((s) => s.some((line) => new RegExp(`^\\s{6}- name: ${re.source}`).test(line)))
const fieldOf = (step, key) => step.find((line) => new RegExp(`^\\s+(- )?${key}:`).test(line))?.replace(new RegExp(`^\\s+(- )?${key}:\\s*`), '').trim()
const uploadSteps = steps.filter((s) => s.some((line) => /uses: actions\/upload-artifact@/.test(line)))

/** An upload step's `path:` entries, single-line or block. */
function uploadPaths(step) {
  const i = step.findIndex((line) => /^\s+path:/.test(line))
  if (i === -1) return []
  const inline = step[i].replace(/^\s+path:\s*/, '').trim()
  if (inline !== '|' && inline !== '>' && inline !== '') return [inline]
  const indent = step[i].match(/^\s*/)[0].length
  const block = []
  for (const line of step.slice(i + 1)) {
    if (line.trim() === '') continue
    if (line.match(/^\s*/)[0].length <= indent) break
    block.push(line.trim())
  }
  return block
}

const redact = stepNamed(/Redact the session transcripts/)
const sessionsUpload = uploadSteps.find((s) => s.some((line) => /name: agent-evals-sessions-\$\{\{ github\.run_id \}\}/.test(line)))
const redactRun = redact ? redact.slice(redact.findIndex((line) => /^\s+run:/.test(line))).join(' ') : ''
const listFlag = (flag) => (redactRun.match(new RegExp(`--${flag}=([A-Z0-9_,]+)`))?.[1] ?? '').split(',').filter(Boolean)

test('the redact step runs always() with id redact, and the sessions upload is gated on its clean scan', () => {
  assert.ok(redact, 'agent-evals.yml has no "Redact the session transcripts" step — update this guard')
  assert.equal(fieldOf(redact, 'id'), 'redact')
  assert.equal(fieldOf(redact, 'if'), 'always()', 'the redact step must run even when the eval step failed (it exits 1 whenever a task fails)')
  assert.match(redactRun, /npm run evals:redact -w packages\/qa-agent --/, 'the redact step no longer runs the qa-agent redactor')
  assert.ok(sessionsUpload, 'agent-evals.yml has no agent-evals-sessions-<run_id> upload — update this guard')
  assert.equal(fieldOf(sessionsUpload, 'if'), "always() && steps.redact.outputs.clean == 'true'", 'the sessions upload is not gated on the redactor clean scan')
  assert.ok(steps.indexOf(redact) < steps.indexOf(sessionsUpload), 'the sessions upload runs before the redactor')
})

test('the sessions upload keeps 3 days and uploads the redactor upload directory only', () => {
  assert.ok(sessionsUpload, 'no sessions upload step — update this guard')
  assert.equal(fieldOf(sessionsUpload, 'retention-days'), '3')
  const out = redactRun.match(/--out="\$RUNNER_TEMP\/([^"]+)"/)?.[1]
  assert.ok(out, 'the redactor has no --out="$RUNNER_TEMP/..." upload directory')
  assert.deepEqual(uploadPaths(sessionsUpload), [`\${{ runner.temp }}/${out}`])
  const stage = redactRun.match(/--stage="\$RUNNER_TEMP\/([^"]+)"/)?.[1]
  assert.ok(stage && stage !== out, 'the redactor must stage into a directory other than the upload directory')
})

test('no upload path names the raw claude-sessions streams', () => {
  assert.ok(uploadSteps.length >= 2, 'expected the report and sessions uploads — update this guard')
  for (const step of uploadSteps) {
    for (const p of uploadPaths(step)) assert.ok(!/claude-sessions/.test(p), `an upload path names the raw session streams: ${p}`)
  }
})

test('every secret the workflow references is passed to the redactor, by name', () => {
  assert.ok(redact, 'no redact step — update this guard')
  const referenced = [...new Set([...live.join('\n').matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort()
  const required = listFlag('required')
  const optional = listFlag('optional')
  assert.ok(required.length > 0, 'the redactor gets no --required secret names')
  for (const name of referenced) {
    assert.ok(required.includes(name) || optional.includes(name), `secrets.${name} is referenced but not passed to the redactor (--required or --optional)`)
    assert.ok(
      redact.some((line) => new RegExp(`^\\s+${name}: \\$\\{\\{ secrets\\.${name} \\}\\}\\s*$`).test(line)),
      `the redact step env does not set ${name} from secrets.${name}`,
    )
  }
  // Optional is only for a `vars.X || secrets.X` fallback: a secret the job
  // reads directly must be REQUIRED, so an empty one refuses.
  const direct = referenced.filter((name) => live.some((line) => line.includes(`secrets.${name}`) && !line.includes(`vars.${name} || secrets.${name}`) && !redact.includes(line)))
  for (const name of direct) assert.ok(required.includes(name), `secrets.${name} is read directly, so it must be --required, not --optional`)
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'AGENT_EVALS_API_KEY', 'AGENT_EVALS_DELEGATE_KEY', 'QA_RPC_URL_BASE_SEPOLIA']) {
    assert.ok(required.includes(name), `${name} must be a required redactor secret`)
  }
})

test('the evals job keeps environment: agent-evals', () => {
  const job = live.findIndex((line) => /^\s{2}claude-code-evals:\s*$/.test(line))
  assert.notEqual(job, -1, 'the claude-code-evals job is gone — update this guard')
  const end = live.findIndex((line, i) => i > job && /^\s{4}steps:\s*$/.test(line))
  assert.ok(live.slice(job, end).some((line) => /^\s{4}environment: agent-evals\s*$/.test(line)), 'the evals job no longer declares environment: agent-evals')
})

test('the claude tool allowlist is unchanged', () => {
  assert.ok(live.some((line) => /^\s+--allowedTools mcp__haven-eval mcp__haven-signer-eval\s*$/.test(line)), 'the --allowedTools line changed')
  const DENY =
    'Bash,BashOutput,KillShell,Read,Edit,Write,NotebookEdit,Glob,Grep,WebFetch,WebSearch,TodoWrite,Task,SlashCommand,ExitPlanMode,Skill,Workflow,ToolSearch,Monitor,CronCreate,CronDelete,CronList,ScheduleWakeup,SendMessage,ListAgents,TaskStop,EnterWorktree,ExitWorktree,PushNotification'
  assert.ok(live.some((line) => line.trim() === `--disallowedTools ${DENY}`), 'the --disallowedTools list changed')
})
