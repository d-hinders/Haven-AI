// Unit tests for the dependency-boundary lint (#982 → absolute since #999).
// Run with: node --test scripts/dep-lint.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  foldViolations,
  parseExemptions,
  specifierMatchesTarget,
  applyExemptions,
  countInlineSqlCallSites,
  scanAll,
  EXCLUDED,
  MIN_EXEMPT_REASON_LENGTH,
} from './dep-lint.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ruleSet = createRequire(import.meta.url)(join(REPO_ROOT, '.dependency-cruiser.cjs'))

/** A dependency-cruiser violation, shaped as the real reporter emits it. */
const violation = (from, rule, to) => ({ from, to, rule: { name: rule, comment: `${rule} comment` } })

const GOOD_REASON = 'bootstraps the pool before repositories exist'

// ── Pass/fail core ──────────────────────────────────────────────────

test('folds violations into per-edge details', () => {
  const details = foldViolations([
    violation('packages/backend/src/routes/x402.ts', 'chain-sdk-not-in-routes', 'node_modules/ethers/x.js'),
    violation('packages/backend/src/routes/x402.ts', 'chain-sdk-not-in-routes', 'node_modules/viem/y.js'),
    violation('packages/backend/src/routes/payments.ts', 'pg-only-in-infra', 'packages/backend/src/db.ts'),
  ])
  assert.equal(details.length, 3)
  assert.deepEqual(details[2], {
    file: 'packages/backend/src/routes/payments.ts',
    rule: 'pg-only-in-infra',
    to: 'packages/backend/src/db.ts',
    comment: 'pg-only-in-infra comment',
  })
})

test('an unwaived violation fires', async () => {
  const details = foldViolations([
    violation('packages/backend/src/routes/payments.ts', 'pg-only-in-infra', 'packages/backend/src/db.ts'),
  ])
  const { firing, waived } = await applyExemptions(details, async () => "import pool from '../db.js'\n")
  assert.equal(firing.length, 1)
  assert.equal(waived.length, 0)
})

// ── Inline waivers ──────────────────────────────────────────────────

test('parseExemptions binds a comment-above to the next import specifier', () => {
  const found = parseExemptions(
    [
      `// dep-lint-exempt: ${GOOD_REASON}`,
      "import pool from '../db.js'",
    ].join('\n'),
  )
  assert.equal(found.length, 1)
  assert.equal(found[0].specifier, '../db.js')
  assert.equal(found[0].reason, GOOD_REASON)
})

test('parseExemptions binds an inline comment to its own import line', () => {
  const found = parseExemptions(`import pool from '../db.js' // dep-lint-exempt: ${GOOD_REASON}\n`)
  assert.equal(found.length, 1)
  assert.equal(found[0].specifier, '../db.js')
})

test('parseExemptions reaches across a multi-line import', () => {
  const found = parseExemptions(
    [
      `// dep-lint-exempt: ${GOOD_REASON}`,
      'import {',
      '  a,',
      '  b,',
      "} from '../db.js'",
    ].join('\n'),
  )
  assert.equal(found.length, 1)
  assert.equal(found[0].specifier, '../db.js')
})

test('specifierMatchesTarget resolves ESM .js specifiers to .ts sources', () => {
  assert.ok(
    specifierMatchesTarget('../db.js', 'packages/backend/src/routes/auth.ts', 'packages/backend/src/db.ts'),
  )
  assert.ok(
    specifierMatchesTarget('./db.js', 'packages/backend/src/index.ts', 'packages/backend/src/db.ts'),
  )
  // A different target must not match — the waiver is per-edge, not per-file.
  assert.equal(
    specifierMatchesTarget('../db.js', 'packages/backend/src/routes/auth.ts', 'packages/backend/src/config.ts'),
    false,
  )
})

test('specifierMatchesTarget matches bare and scoped packages by resolved prefix', () => {
  assert.ok(specifierMatchesTarget('pg', 'packages/backend/src/db.ts', 'node_modules/pg/lib/index.js'))
  assert.ok(
    specifierMatchesTarget(
      '@metamask/smart-accounts-kit',
      'packages/backend/src/rails/delegation-rail.ts',
      'node_modules/@metamask/smart-accounts-kit/dist/index.js',
    ),
  )
  assert.equal(
    specifierMatchesTarget('pg', 'packages/backend/src/db.ts', 'node_modules/pg-pool/index.js'),
    false,
    'pg must not waive pg-pool — the prefix match is per-package, not per-substring',
  )
})

test('a waived edge passes and carries its reason', async () => {
  const details = foldViolations([
    violation('packages/backend/src/routes/auth.ts', 'pg-only-in-infra', 'packages/backend/src/db.ts'),
  ])
  const { firing, waived } = await applyExemptions(
    details,
    async () => `// dep-lint-exempt: ${GOOD_REASON}\nimport pool from '../db.js'\n`,
  )
  assert.equal(firing.length, 0)
  assert.equal(waived.length, 1)
  assert.equal(waived[0].reason, GOOD_REASON)
})

test('a too-short reason does NOT waive — it fails with its own message', async () => {
  const details = foldViolations([
    violation('packages/backend/src/routes/auth.ts', 'pg-only-in-infra', 'packages/backend/src/db.ts'),
  ])
  const { firing, waived, badReasons } = await applyExemptions(
    details,
    async () => "// dep-lint-exempt: TODO\nimport pool from '../db.js'\n",
  )
  assert.ok('TODO'.length < MIN_EXEMPT_REASON_LENGTH, 'the guard constant must catch a bare TODO')
  assert.equal(waived.length, 0)
  assert.equal(firing.length, 0)
  assert.equal(badReasons.length, 1)
})

test('no-circular can never be waived', async () => {
  const details = foldViolations([
    violation('packages/backend/src/a.ts', 'no-circular', 'packages/backend/src/b.ts'),
  ])
  const { firing, waived } = await applyExemptions(
    details,
    async () => `// dep-lint-exempt: ${GOOD_REASON}\nimport { b } from './b.js'\n`,
  )
  assert.equal(waived.length, 0)
  assert.equal(firing.length, 1)
})

// ── The inline-SQL call-site gauge (#999) ───────────────────────────

test('the gauge counts .query( and .query<T>( call sites, not just files', () => {
  const { callSites, fileCount } = countInlineSqlCallSites([
    {
      path: 'packages/backend/src/routes/user.ts',
      source: 'await pool.query(`SELECT 1`)\nawait pool.query<Row>(`SELECT 2`)\n',
    },
    { path: 'packages/backend/src/routes/auth.ts', source: 'await db.query(sql)\n' },
    { path: 'packages/backend/src/domain/tokens.ts', source: 'const clean = true\n' },
  ])
  // Intensity, not presence: 3 call sites across 2 files — the ratchet this
  // gauge replaced would have reported "2" forever while the 3 grew.
  assert.equal(callSites, 3)
  assert.equal(fileCount, 2)
})

test('the gauge excludes db/, db.ts, infra/repositories/ and non-backend files', () => {
  const { callSites } = countInlineSqlCallSites([
    { path: 'packages/backend/src/db.ts', source: 'pool.query(x)' },
    { path: 'packages/backend/src/db/migrate.ts', source: 'pool.query(x)' },
    { path: 'packages/backend/src/infra/repositories/agents.ts', source: 'db.query(x)' },
    { path: 'packages/core/src/chains.ts', source: 'thing.query(x)' },
  ])
  assert.equal(callSites, 0)
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
  assert.equal(re.test('packages/backend/src/domain/chains.ts'), false)
})

test('the scan exclude is DERIVED from the config, so the two cannot drift', () => {
  // The file list handed to dependency-cruiser and the paths it would itself
  // ignore must be the same set. Restating the regex in the script is how they
  // silently diverge, so it is derived — this asserts that stays true.
  assert.equal(EXCLUDED.source, new RegExp(ruleSet.options.exclude.path).source)
  for (const excluded of [
    'packages/backend/src/routes/__tests__/x402.test.ts',
    'packages/backend/src/infra/relayer.test.ts',
    'packages/backend/src/loop-harness/allowance-differential.test.ts',
    'packages/backend/src/docs-drift/env-example-drift.test.ts',
  ]) {
    assert.ok(EXCLUDED.test(excluded), `should be excluded: ${excluded}`)
  }
  for (const included of [
    'packages/backend/src/routes/x402.ts',
    'packages/backend/src/rails/execution-rail.ts',
  ]) {
    assert.equal(EXCLUDED.test(included), false, `should be scanned: ${included}`)
  }
})

test('the core-stays-pure matcher covers every banned dependency', () => {
  // core is imported by a Node server AND a browser bundle, so this rule is the
  // pure end of the stable-dependency rule. Same failure mode as the chain-SDK
  // rule: it matches RESOLVED npm paths, so assert it against realistic ones.
  const rule = ruleSet.forbidden.find((r) => r.name === 'core-stays-pure')
  const re = new RegExp(rule.to.path)
  for (const resolved of [
    'node_modules/fastify/fastify.js',
    'node_modules/pg/lib/index.js',
    'node_modules/ethers/lib.commonjs/index.js',
    'node_modules/viem/_cjs/index.js',
    'node_modules/permissionless/index.js',
    'node_modules/@metamask/smart-accounts-kit/dist/index.js',
  ]) {
    assert.ok(re.test(resolved), `core must not be allowed to import ${resolved}`)
  }
  assert.equal(new RegExp(rule.from.path).test('packages/core/src/address.ts'), true)
  assert.equal(new RegExp(rule.from.path).test('packages/backend/src/infra/relayer.ts'), false)
})

test('every forbidden rule has a name, an actionable comment, and error severity', () => {
  for (const rule of ruleSet.forbidden) {
    assert.ok(rule.name, 'rule needs a name — it is what a waiver is scoped to')
    assert.ok(rule.comment && rule.comment.length > 20, `${rule.name} needs an actionable comment`)
    assert.equal(rule.severity, 'error')
  }
})

// ── Live integration ────────────────────────────────────────────────

test('the live scan detects real violations and reports zero cycles', async () => {
  // #994 emptied EVERY real chain-sdk-not-in-routes violation, so there is no
  // real "known-bad" route file to assert against. Use a temporary fixture,
  // written into and removed from the real scanned tree around one `cruise()`
  // call, so this still proves the FULL pipeline (file walk -> cruise() ->
  // rule match -> path resolution) fires, not just the regex.
  const fixturePath = join(
    REPO_ROOT, 'packages', 'backend', 'src', 'routes', '__dep_lint_live_scan_fixture__.ts',
  )
  writeFileSync(fixturePath, "import { ethers } from 'ethers'\nexport const _fixture = ethers\n")

  let details, fileCount
  try {
    ;({ details, fileCount } = await scanAll())
  } finally {
    rmSync(fixturePath, { force: true })
  }

  assert.ok(fileCount > 100, `expected to scan the backend tree, saw ${fileCount} files`)

  // The rule that silently passed must actually fire on a known-bad file.
  assert.ok(
    details.some(
      (d) =>
        d.file === 'packages/backend/src/routes/__dep_lint_live_scan_fixture__.ts' &&
        d.rule === 'chain-sdk-not-in-routes',
    ),
    'a routes/ file importing ethers must trip the chain-SDK rule',
  )

  // The shared kernel is clean. Paired with the scan-coverage test below, which
  // proves packages/core files actually reached the cruiser — without that, this
  // assertion would pass vacuously.
  assert.ok(
    details.every((d) => d.rule !== 'core-stays-pure'),
    'core-stays-pure must have zero violations — it can never be waived into existence',
  )

  // Rule 7 is the one to defend hardest; the tree is cycle-free and must stay
  // that way. Absolute AND unwaivable. (The fixture imports only `ethers`, so
  // it cannot introduce a cycle.)
  assert.equal(
    details.filter((d) => d.rule === 'no-circular').length,
    0,
    'a dependency cycle was introduced — break it; no-circular cannot be waived',
  )
})

test('the scan actually reaches packages/core (else core-stays-pure is vacuous)', async () => {
  const { scannedFiles } = await scanAll()
  assert.ok(
    scannedFiles.some((f) => f.startsWith('packages/core/src/')),
    'no packages/core file was scanned — core-stays-pure could never fire',
  )
  assert.ok(scannedFiles.some((f) => f.startsWith('packages/backend/src/')))
})

test('the checked-in tree is green: every violation is waived, every waiver has a real reason', async () => {
  const { details } = await scanAll()
  const { firing, badReasons } = await applyExemptions(details)
  assert.deepEqual(
    firing.map((f) => `${f.file} → ${f.to} (${f.rule})`),
    [],
    'unwaived dependency-boundary violation — fix the boundary or add a reviewed dep-lint-exempt',
  )
  assert.deepEqual(
    badReasons.map((b) => `${b.file}: "${b.reason}"`),
    [],
    'a dep-lint-exempt comment carries a non-reason',
  )
})
