// The agent-evals workflow must build `@haven_ai/core` before any workspace
// package that imports it.
//
// `npm ci` does not create core's `dist/`. The Claude Code lane's first real
// run (2026-10-19, the #3959 cost pilot) died in its build step with
// `Could not resolve "@haven_ai/core"` from packages/mcp-server: zero tasks
// run, nothing graded, and the failure only shows after the owner has
// approved the protected-environment deployment. Same defect class as
// `e2e-workspace-deps.test.mjs` (#1930), asserted rather than remembered.
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

/** Workspace packages whose build imports `@haven_ai/core`. */
const CORE_CONSUMERS = ['sdk', 'signer', 'mcp-server']
const buildIndex = (pkg) => workflow.indexOf(`npm run build -w packages/${pkg}`)

test('agent-evals builds @haven_ai/core', () => {
  assert.notEqual(buildIndex('core'), -1, 'agent-evals.yml never runs `npm run build -w packages/core`')
})

test('agent-evals builds @haven_ai/core before every package that imports it', () => {
  const core = buildIndex('core')
  for (const pkg of CORE_CONSUMERS) {
    const at = buildIndex(pkg)
    if (at === -1) continue
    assert.ok(core !== -1 && core < at, `packages/${pkg} is built before packages/core in agent-evals.yml`)
  }
})
