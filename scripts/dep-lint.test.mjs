// Unit tests for the dependency-boundary lint (#982, epic #980).
// Run with: node --test scripts/dep-lint.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { foldViolations, newViolations, hasShrunk, scanAll, EXCLUDED } from './dep-lint.mjs'
import { writeBaseline, readBaseline } from './lib/ratchet.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ruleSet = createRequire(import.meta.url)(join(REPO_ROOT, '.dependency-cruiser.cjs'))

/** A dependency-cruiser violation, shaped as the real reporter emits it. */
const violation = (from, rule, to) => ({ from, to, rule: { name: rule, comment: `${rule} comment` } })

// ── The ratchet contract ────────────────────────────────────────────

test('folds violations into per-file, per-rule counts', () => {
  const { counts, details } = foldViolations([
    violation('packages/backend/src/routes/x402.ts', 'chain-sdk-not-in-routes', 'node_modules/ethers/x.js'),
    violation('packages/backend/src/routes/x402.ts', 'chain-sdk-not-in-routes', 'node_modules/viem/y.js'),
    violation('packages/backend/src/routes/payments.ts', 'pg-only-in-infra', 'packages/backend/src/db.ts'),
  ])
  assert.equal(counts['packages/backend/src/routes/x402.ts']['chain-sdk-not-in-routes'], 2)
  assert.equal(counts['packages/backend/src/routes/payments.ts']['pg-only-in-infra'], 1)
  assert.equal(details.length, 3)
})

test('a NEW violation fails against the baseline', () => {
  const baseline = { 'packages/backend/src/routes/x402.ts': { 'chain-sdk-not-in-routes': 1 } }
  // Same file, a rule it was not baselined for.
  const { counts } = foldViolations([
    violation('packages/backend/src/routes/x402.ts', 'chain-sdk-not-in-routes', 'node_modules/ethers/x.js'),
    violation('packages/backend/src/routes/x402.ts', 'pg-only-in-infra', 'packages/backend/src/db.ts'),
  ])
  const failures = newViolations(counts, baseline)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].key, 'pg-only-in-infra')
  assert.equal(failures[0].allowed, 0)
})

test('GROWTH of an existing baselined count fails', () => {
  const baseline = { 'packages/backend/src/routes/x402.ts': { 'chain-sdk-not-in-routes': 1 } }
  const { counts } = foldViolations([
    violation('packages/backend/src/routes/x402.ts', 'chain-sdk-not-in-routes', 'node_modules/ethers/x.js'),
    violation('packages/backend/src/routes/x402.ts', 'chain-sdk-not-in-routes', 'node_modules/viem/y.js'),
  ])
  const failures = newViolations(counts, baseline)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].count, 2)
  assert.equal(failures[0].allowed, 1)
})

test('the baseline is per-file — the same rule in a NEW file is not grandfathered', () => {
  const baseline = { 'packages/backend/src/routes/x402.ts': { 'chain-sdk-not-in-routes': 1 } }
  const { counts } = foldViolations([
    violation('packages/backend/src/routes/balances.ts', 'chain-sdk-not-in-routes', 'node_modules/ethers/x.js'),
  ])
  assert.equal(newViolations(counts, baseline).length, 1)
})

test('a REMOVED violation passes and is reported as shrinkable', () => {
  const baseline = {
    'packages/backend/src/routes/x402.ts': { 'chain-sdk-not-in-routes': 2 },
    'packages/backend/src/routes/balances.ts': { 'chain-sdk-not-in-routes': 1 },
  }
  const { counts } = foldViolations([
    violation('packages/backend/src/routes/x402.ts', 'chain-sdk-not-in-routes', 'node_modules/ethers/x.js'),
  ])
  assert.equal(newViolations(counts, baseline).length, 0, 'shrinking must not fail')
  assert.equal(hasShrunk(counts, baseline), true)
})

test('an unchanged tree is a no-op — no failures and nothing to tighten', () => {
  const baseline = { 'packages/backend/src/routes/x402.ts': { 'chain-sdk-not-in-routes': 1 } }
  const { counts } = foldViolations([
    violation('packages/backend/src/routes/x402.ts', 'chain-sdk-not-in-routes', 'node_modules/ethers/x.js'),
  ])
  assert.equal(newViolations(counts, baseline).length, 0)
  assert.equal(hasShrunk(counts, baseline), false)
})

test('--update writes a deterministic, sorted baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dep-lint-'))
  try {
    const path = join(dir, 'baseline.json')
    const { counts } = foldViolations([
      violation('z.ts', 'pg-only-in-infra', 'db.ts'),
      violation('a.ts', 'pg-only-in-infra', 'db.ts'),
      violation('a.ts', 'chain-sdk-not-in-routes', 'node_modules/ethers/x.js'),
    ])
    const json = writeBaseline(path, counts)
    assert.ok(existsSync(path))
    // Files sorted, and keys within a file sorted — so diffs stay reviewable.
    assert.deepEqual(Object.keys(JSON.parse(json)), ['a.ts', 'z.ts'])
    assert.deepEqual(Object.keys(JSON.parse(json)['a.ts']), [
      'chain-sdk-not-in-routes',
      'pg-only-in-infra',
    ])
    // Round-trips, and re-writing identical counts is byte-stable.
    assert.deepEqual(readBaseline(path), JSON.parse(json))
    assert.equal(writeBaseline(path, counts), json)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Rule-config guards ──────────────────────────────────────────────
//
// These exist because the chain-SDK rule SILENTLY PASSED during development:
// dependency-cruiser reports resolved npm dependencies as
// `node_modules/<pkg>/...`, so a `^ethers` pattern matched nothing and the rule
// reported zero violations against a tree with ten of them. A rule that cannot
// fire is worse than no rule, so its matcher is asserted directly.

test('the chain-SDK matcher matches RESOLVED npm paths, not bare module names', () => {
  const rule = ruleSet.forbidden.find((r) => r.name === 'chain-sdk-not-in-routes')
  const re = new RegExp(rule.to.path)
  for (const resolved of [
    'node_modules/ethers/lib.commonjs/index.js',
    'node_modules/viem/_esm/index.js',
    'node_modules/permissionless/index.js',
    'node_modules/@metamask/smart-accounts-kit/dist/index.js',
  ]) {
    assert.ok(re.test(resolved), `should match ${resolved}`)
  }
  // Must not fire on an unrelated package that merely contains a name.
  assert.equal(re.test('node_modules/ethers-abi-shim-unrelated-pkg/index.js'), false)
  assert.equal(re.test('packages/backend/src/lib/chains.ts'), false)
})

test('the scan exclude is DERIVED from the config, so the two cannot drift', () => {
  // The file list handed to dependency-cruiser and the paths it would itself
  // ignore must be the same set. Restating the regex in the script is how they
  // silently diverge, so it is derived — this asserts that stays true.
  assert.equal(EXCLUDED.source, new RegExp(ruleSet.options.exclude.path).source)
  for (const excluded of [
    'packages/backend/src/routes/__tests__/x402.test.ts',
    'packages/backend/src/lib/relayer.test.ts',
    'packages/backend/src/loop-harness/allowance-differential.test.ts',
    'packages/backend/src/docs-drift/env-example-drift.test.ts',
  ]) {
    assert.ok(EXCLUDED.test(excluded), `should be excluded: ${excluded}`)
  }
  for (const included of [
    'packages/backend/src/routes/x402.ts',
    'packages/backend/src/lib/execution-rail.ts',
  ]) {
    assert.equal(EXCLUDED.test(included), false, `should be scanned: ${included}`)
  }
})

test('every forbidden rule has a name and an actionable comment', () => {
  for (const rule of ruleSet.forbidden) {
    assert.ok(rule.name, 'rule needs a name — it is the baseline key')
    assert.ok(rule.comment && rule.comment.length > 20, `${rule.name} needs an actionable comment`)
    assert.equal(rule.severity, 'error')
  }
})

// ── Live integration ────────────────────────────────────────────────

test('the live scan detects real violations and reports zero cycles', async () => {
  const { counts, details, fileCount } = await scanAll()
  assert.ok(fileCount > 100, `expected to scan the backend tree, saw ${fileCount} files`)

  // The rule that silently passed must actually fire on a known-bad file.
  assert.ok(
    counts['packages/backend/src/routes/x402.ts']?.['chain-sdk-not-in-routes'] > 0,
    'routes/x402.ts imports ethers — the chain-SDK rule must fire on it',
  )

  // Rule 7 is the one to defend hardest; the tree is currently cycle-free and
  // must stay that way. This is an absolute assertion, NOT a baselined one.
  assert.equal(
    details.filter((d) => d.rule === 'no-circular').length,
    0,
    'a dependency cycle was introduced — break it rather than baselining it',
  )
})

test('the committed baseline covers the live scan (checked-in state is green)', async () => {
  const { counts } = await scanAll()
  const baseline = readBaseline(join(REPO_ROOT, 'packages', 'backend', 'dep-lint-baseline.json'))
  assert.deepEqual(
    newViolations(counts, baseline),
    [],
    'committed baseline is stale — run `npm run lint:deps:update`',
  )
})
