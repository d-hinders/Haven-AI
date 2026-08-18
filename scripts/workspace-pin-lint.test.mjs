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
