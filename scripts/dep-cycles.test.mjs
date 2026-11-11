// Tests for the runtime import-cycle pass (#4763).
// Run with: node --test scripts/dep-cycles.test.mjs
//
// Three things are pinned here, and each is a way the pass could be green
// while covering nothing:
//
//   1. COVERAGE — the scan actually reaches every one of the eleven packages,
//      reads `.tsx`, and resolves the frontend's `@/` alias. A pass that
//      silently scanned nothing would report zero cycles forever, which is the
//      failure shape #982's chain-SDK lesson is about.
//   2. THE BOUNDARY OF THE OWNER DECISION — a planted VALUE-import cycle is
//      reported (and a `dep-lint-exempt` comment does not silence it), while a
//      planted TYPE-ONLY cycle is not. Those two live-scan tests are the
//      difference between "runtime cycles only" and the repo's stricter
//      definition, pinned rather than described.
//   3. THE PROCESS — the CLI exits non-zero on a cycle and zero on a clean
//      tree, driven as a real process against a fixture repo (#2721).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CYCLE_SCAN_PACKAGES, scanAll, scanPackage, EXCLUDED } from './dep-cycles.mjs'
import { runGuard } from './test-support/guard-cli.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The eleven packages `npm run lint:deps` does not scan, in name order. */
const EXPECTED_PACKAGES = [
  'cli',
  'connect',
  'demo-merchant-mcp',
  'frontend',
  'mcp',
  'mcp-server',
  'ops',
  'qa-agent',
  'sdk',
  'signer',
  'ui',
]

// ── Coverage ────────────────────────────────────────────────────────────────

test('the pass polices exactly the eleven packages the strict gate does not scan', () => {
  assert.deepEqual([...CYCLE_SCAN_PACKAGES], EXPECTED_PACKAGES)
  // backend and core keep the STRICT definition through `npm run lint:deps`;
  // scanning them here too would give rule 7 two answers for one tree.
  for (const strict of ['backend', 'core']) {
    assert.equal(CYCLE_SCAN_PACKAGES.includes(strict), false, `${strict} belongs to lint:deps`)
  }
})

test('the scan reaches every one of the eleven packages, reads .tsx, and resolves @/ aliases', async () => {
  const results = await scanAll()
  assert.equal(results.length, EXPECTED_PACKAGES.length)

  for (const r of results) {
    assert.ok(
      r.files.length > 0,
      `no source file was scanned in packages/${r.package}/src — a rule over an unwalked tree reports zero forever`,
    )
    assert.ok(
      r.files.every((f) => f.startsWith(`packages/${r.package}/src/`)),
      `${r.package} reported a file outside its own src/`,
    )
  }

  // `.tsx` is read, not just `.ts`: 253 of the frontend's source files are
  // components, and a cycle through a component is a cycle.
  const tsx = results.flatMap((r) => r.files.filter((f) => f.endsWith('.tsx')))
  assert.ok(tsx.length > 0, 'no .tsx file was scanned — the pass would miss every component cycle')

  // The frontend's `@/` alias resolves to a real file, which is the proof its
  // own tsconfig was applied. Without it every `@/` import is an unresolved
  // specifier and a cycle through one is invisible.
  const frontend = results.find((r) => r.package === 'frontend')
  assert.ok(frontend.aliasEdges.length > 0, 'no @/ alias edge resolved in the frontend')
  assert.ok(
    frontend.aliasEdges.every((e) => e.resolved.startsWith('packages/frontend/src/')),
    'an @/ alias edge resolved outside packages/frontend/src',
  )
  assert.ok(
    frontend.aliasEdges.some((e) => /\.tsx?$/.test(e.resolved)),
    'no @/ alias edge resolved to a source file — the alias is being reported, not followed',
  )
})

test('the exclude pattern keeps tests and declarations out of the graph', () => {
  for (const excluded of [
    'packages/sdk/src/__tests__/x.test.ts',
    'packages/sdk/src/client.test.ts',
    'packages/frontend/src/app/page.test.tsx',
    'packages/sdk/src/types.d.ts',
    'packages/frontend/src/e2e/flow.ts',
  ]) {
    assert.ok(EXCLUDED.test(excluded), `should be excluded: ${excluded}`)
  }
  for (const included of ['packages/sdk/src/client.ts', 'packages/frontend/src/app/page.tsx']) {
    assert.equal(EXCLUDED.test(included), false, `should be scanned: ${included}`)
  }
})

// ── The checked-in tree ─────────────────────────────────────────────────────

test('the checked-in tree has zero runtime cycles across the eleven packages', async () => {
  const results = await scanAll()
  assert.deepEqual(
    results.flatMap((r) => r.cycles.map((c) => `${c.from} → ${c.to}`)),
    [],
    'a runtime import cycle was introduced — break it by moving the shared piece into a leaf; ' +
      'no-circular can never be waived',
  )
})

// ── Live scans: the owner decision's boundary ───────────────────────────────

/**
 * Plant a two-file fixture pair in a non-backend package's `src`, scan that
 * package, and remove the files. `packages/cli` is used because it is small
 * (16 source files) and holds no cycle of its own, so the assertion is about
 * the planted pair and nothing else.
 */
async function withFixturePair(aSource, bSource, fn) {
  const dir = join(REPO_ROOT, 'packages', 'cli', 'src')
  const a = join(dir, '__dep_cycles_live_scan_fixture_a__.ts')
  const b = join(dir, '__dep_cycles_live_scan_fixture_b__.ts')
  writeFileSync(a, aSource)
  writeFileSync(b, bSource)
  try {
    return await fn(await scanPackage('cli'))
  } finally {
    rmSync(a, { force: true })
    rmSync(b, { force: true })
  }
}

const VALUE_A = "import { b } from './__dep_cycles_live_scan_fixture_b__.js'\nexport const a = b + 1\n"
const VALUE_B = "import { a } from './__dep_cycles_live_scan_fixture_a__.js'\nexport const b = a + 1\n"

test('a planted value-import cycle is reported, and a dep-lint-exempt comment does not silence it', async () => {
  const reported = await withFixturePair(VALUE_A, VALUE_B, (r) => r.cycles)
  assert.deepEqual(
    reported.map((c) => `${c.from} → ${c.to}`),
    [
      'packages/cli/src/__dep_cycles_live_scan_fixture_a__.ts → ' +
        'packages/cli/src/__dep_cycles_live_scan_fixture_b__.ts',
    ],
    'a two-file value-import cycle must be reported',
  )

  // `no-circular` is unwaivable everywhere else in this repo, and this pass
  // honours no waivers at all — the comment is inert, not a licence.
  const waived = await withFixturePair(
    '// dep-lint-exempt: this waiver must not silence a runtime cycle\n' + VALUE_A,
    VALUE_B,
    (r) => r.cycles,
  )
  assert.equal(waived.length, 1, 'a dep-lint-exempt comment must not silence a runtime cycle')
})

test('a planted type-only cycle is NOT reported — the boundary of the owner decision', async () => {
  const typeOnlyA =
    "import type { B } from './__dep_cycles_live_scan_fixture_b__.js'\n" +
    'export interface A {\n  b?: B\n}\nexport const a = 1\n'
  const typeOnlyB =
    "import type { A } from './__dep_cycles_live_scan_fixture_a__.js'\n" +
    'export interface B {\n  a?: A\n}\nexport const b = 2\n'

  const reported = await withFixturePair(typeOnlyA, typeOnlyB, (r) => r.cycles)
  assert.deepEqual(
    reported,
    [],
    'type-only imports are not edges here (owner decision 2026-11-10) — the nine known ' +
      'type-only cycles are listed in docs/architecture/10-module-boundaries.md',
  )
})

// ── The CLI path (#2721) ────────────────────────────────────────────────────

const fixture = (files) => ({
  linkNodeModules: true,
  files: { 'packages/cli/tsconfig.json': '{}\n', ...files },
})

test('CLI: a planted runtime cycle exits non-zero and names both files', () => {
  const { status, out } = runGuard(
    'dep-cycles.mjs',
    fixture({
      'packages/cli/src/a.ts': "import { b } from './b.js'\nexport const a = b + 1\n",
      'packages/cli/src/b.ts': "import { a } from './a.js'\nexport const b = a + 1\n",
    }),
  )
  assert.equal(status, 1)
  assert.match(out, /packages\/cli\/src\/a\.ts → packages\/cli\/src\/b\.ts/)
})

test('CLI: a clean tree exits 0', () => {
  // The control: without it the case above passes against a guard that refuses
  // everything.
  const { status, out } = runGuard(
    'dep-cycles.mjs',
    fixture({ 'packages/cli/src/a.ts': 'export const a = 1\n' }),
  )
  assert.equal(status, 0)
  assert.match(out, /No runtime import cycles/)
})
