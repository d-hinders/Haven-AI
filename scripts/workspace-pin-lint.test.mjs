// Self-test for the workspace pin lint (#1526). Same reasoning as
// `lint:deps:test` / `lint:db-mocks:test`: a guard nobody tests is a guard
// that can start passing vacuously.
//
// The synthetic manifests below matter more than the real-tree assertion at
// the end — a lint that only ever sees a green tree cannot demonstrate it
// would fail on a red one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { violationsFor, lint, isWildcardRange, WORKSPACE_LINK_RANGE } from './workspace-pin-lint.mjs'

test('a published package exact-pinning an internal dep is clean', () => {
  assert.deepEqual(
    violationsFor({ name: '@haven_ai/mcp', dependencies: { '@haven_ai/sdk': '0.1.25-alpha.0' } }),
    [],
  )
})

test('a published package wildcarding an internal dep is a violation', () => {
  const [v] = violationsFor({ name: '@haven_ai/mcp', dependencies: { '@haven_ai/sdk': '*' } })
  assert.equal(v.kind, 'published-wildcard')
  assert.equal(v.dep, 'dependencies.@haven_ai/sdk')
})

test('a private consumer using "*" is clean', () => {
  assert.deepEqual(
    violationsFor({ name: '@haven_ai/backend', private: true, dependencies: { '@haven_ai/sdk': '*' } }),
    [],
  )
})

// The direction that was previously unenforced, and the one #1526 is about.
test('a private consumer EXACT-pinning an internal dep is a violation', () => {
  const [v] = violationsFor({
    name: '@haven_ai/mcp-server',
    private: true,
    dependencies: { '@haven_ai/sdk': '0.1.25-alpha.0' },
  })
  assert.equal(v.kind, 'private-exact-pin')
  assert.match(v.detail, /install scope/)
})

test('devDependencies and peerDependencies are policed too', () => {
  const violations = violationsFor({
    name: '@haven_ai/mcp-server',
    private: true,
    devDependencies: { '@haven_ai/signer': '0.1.25-alpha.0' },
    peerDependencies: { '@haven_ai/sdk': '0.1.25-alpha.0' },
  })
  assert.equal(violations.length, 2)
  assert.deepEqual(
    violations.map((v) => v.dep).sort(),
    ['devDependencies.@haven_ai/signer', 'peerDependencies.@haven_ai/sdk'],
  )
})

test('third-party deps are ignored on both sides of the rule', () => {
  assert.deepEqual(violationsFor({ name: '@haven_ai/mcp', dependencies: { viem: '*', zod: '^3' } }), [])
  assert.deepEqual(
    violationsFor({ name: '@haven_ai/backend', private: true, dependencies: { fastify: '^5.0.0' } }),
    [],
  )
})

test('`private: false` is treated as published, not as private', () => {
  // An explicit `false` is the same as omitting it, per npm. Getting this
  // backwards would silently invert the rule for that package.
  const [v] = violationsFor({
    name: '@haven_ai/thing',
    private: false,
    dependencies: { '@haven_ai/sdk': '*' },
  })
  assert.equal(v.kind, 'published-wildcard')
})

test('isWildcardRange catches every non-pinning form', () => {
  for (const range of ['*', 'latest', 'workspace:*', '^0.1.*', undefined, null]) {
    assert.equal(isWildcardRange(range), true, `expected wildcard: ${String(range)}`)
  }
  for (const range of ['0.1.25-alpha.0', '1.0.0']) {
    assert.equal(isWildcardRange(range), false, `expected concrete: ${range}`)
  }
})

test('WORKSPACE_LINK_RANGE is the range npm links a sibling for', () => {
  assert.equal(WORKSPACE_LINK_RANGE, '*')
})

test('the real workspace is clean', async () => {
  const { violations, checked } = await lint()
  assert.deepEqual(violations, [], `expected no violations, got:\n${JSON.stringify(violations, null, 2)}`)
  assert.ok(checked >= 8, `expected to scan the workspace packages, scanned ${checked}`)
})

// --- The CLI path (#2721, epic #2720)
//
// Everything above tests `violationsFor` and `lint`. Neither reaches the
// refusal, which lives in `main()`: the non-zero exit and the message a
// contributor acts on. That gap is not hypothetical — two refusals in this
// repo were mutated to `if (false)` in one week and their suites stayed green
// (#2690, #2704). These cases run the shipped script as a process against a
// fixture repo, so the exit code and the message are the things under test.

import { runGuard } from './test-support/guard-cli.mjs'

const manifest = (deps) =>
  JSON.stringify({ name: '@haven_ai/a', version: '1.0.0', dependencies: deps })

test('CLI: a violating tree exits non-zero and names the offending pin', () => {
  const { status, out } = runGuard('workspace-pin-lint.mjs', {
    files: { 'packages/a/package.json': manifest({ '@haven_ai/b': '*' }) },
  })
  assert.equal(status, 1)
  // The pin AND the reason. Exit code alone cannot tell "refused correctly"
  // from "crashed on a malformed fixture".
  assert.match(out, /@haven_ai\/a → dependencies\.@haven_ai\/b = "\*"/)
  assert.match(out, /published packages must pin a concrete version/)
})

test('CLI: a clean tree exits 0 and says what it checked', () => {
  // The control. Without it the case above passes against a script that
  // refuses everything — which is the failure mode a refusal test invites.
  const { status, out } = runGuard('workspace-pin-lint.mjs', {
    files: { 'packages/a/package.json': manifest({ '@haven_ai/b': '1.2.3' }) },
  })
  assert.equal(status, 0)
  assert.match(out, /✓ internal @haven_ai\/\* pins correct across 1 workspace package/)
})

test('CLI: the private-consumer direction refuses too', () => {
  // The rule has two halves and they fail in opposite directions. A test that
  // only covered the published half would pass against a guard that had lost
  // the private one entirely.
  const { status, out } = runGuard('workspace-pin-lint.mjs', {
    files: {
      'packages/a/package.json': JSON.stringify({
        name: '@haven_ai/a',
        version: '1.0.0',
        private: true,
        dependencies: { '@haven_ai/b': '1.2.3' },
      }),
    },
  })
  assert.equal(status, 1)
  assert.match(out, /private workspace consumers must use "\*"/)
})
