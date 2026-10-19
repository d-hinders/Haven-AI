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
