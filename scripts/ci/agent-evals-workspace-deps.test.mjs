// The agent-evals workflow must build `@haven_ai/core` before the workspace
// package that imports it, and must install the `claude` CLI it runs.
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
  const install = lineOf(/npm install -g @anthropic-ai\/claude-code@\d+\.\d+\.\d+\b/)
  const run = lineOf(/^\s*- name: Run the eval slice\s*$/)
  assert.notEqual(install, -1, 'agent-evals.yml never installs an exactly pinned @anthropic-ai/claude-code')
  assert.notEqual(run, -1, 'agent-evals.yml has no "Run the eval slice" step — update this guard')
  assert.ok(install < run, 'the claude CLI is installed after the eval slice runs')
})
