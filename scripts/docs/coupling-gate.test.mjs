// Unit tests for the coupling gate's pure core.
// Run with: npm run docs:test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { implicatedDocs, ageDays, isIncidentalPath } from './coupling-gate.mjs'

const DOCS = [
  { doc: 'docs/architecture/04-x402.md', covers: ['packages/backend/src/routes/x402.ts'], lastVerified: '2026-06-01' },
  { doc: 'docs/regulatory/casp.md', covers: ['packages/backend/src/routes/x402.ts', 'packages/backend/src/routes/payments.ts'], lastVerified: '2026-06-01' },
  { doc: 'docs/product/README.md', covers: [], lastVerified: '2026-06-01' }, // narrative
  { doc: 'docs/operations/hosted-mcp.md', covers: ['packages/mcp-server/**'], lastVerified: '2026-06-01' },
]

test('flags docs whose covers match a changed file', () => {
  const f = implicatedDocs(['packages/backend/src/routes/x402.ts'], DOCS)
  assert.deepEqual(f.map((x) => x.doc).sort(), ['docs/architecture/04-x402.md', 'docs/regulatory/casp.md'])
})

test('records every matched file on a doc', () => {
  const f = implicatedDocs(
    ['packages/backend/src/routes/x402.ts', 'packages/backend/src/routes/payments.ts'],
    DOCS,
  )
  const casp = f.find((x) => x.doc === 'docs/regulatory/casp.md')
  assert.deepEqual(casp.matched, [
    'packages/backend/src/routes/payments.ts',
    'packages/backend/src/routes/x402.ts',
  ])
})

test('does not flag a doc that was itself changed', () => {
  const f = implicatedDocs(
    ['packages/backend/src/routes/x402.ts', 'docs/architecture/04-x402.md'],
    DOCS,
  )
  assert.deepEqual(f.map((x) => x.doc), ['docs/regulatory/casp.md'])
})

test('ignores narrative docs (empty covers)', () => {
  const f = implicatedDocs(['docs/product/README.md', 'packages/x/y.ts'], DOCS)
  assert.equal(f.length, 0)
})

test('matches ** globs across directories', () => {
  const f = implicatedDocs(['packages/mcp-server/src/http.ts'], DOCS)
  assert.deepEqual(f.map((x) => x.doc), ['docs/operations/hosted-mcp.md'])
})

test('returns nothing when no changed file is covered', () => {
  assert.equal(implicatedDocs(['packages/frontend/src/app/page.tsx'], DOCS).length, 0)
})

test('ageDays computes whole-day differences', () => {
  const now = Date.parse('2026-06-11T00:00:00Z')
  assert.equal(ageDays('2026-06-01', now), 10)
  assert.equal(ageDays('not-a-date', now), null)
})

test('#1824: a freshly stamped last-verified no longer suppresses anything', () => {
  // These docs are stamped 2026-06-01. Before #1824, running the gate ON that
  // date suppressed both. The date is no longer an input at all, so the only
  // question left is whether a covered file changed.
  const f = implicatedDocs(['packages/backend/src/routes/x402.ts'], DOCS)
  assert.deepEqual(f.map((x) => x.doc).sort(), ['docs/architecture/04-x402.md', 'docs/regulatory/casp.md'])
})

test('#1824: the real scenario — another PR stamped the doc today', () => {
  // The case that motivated the issue, reproduced concretely rather than
  // described. docs/product/design-system.md `covers:` TransactionMovement.tsx
  // by EXACT path (not a wide glob), and on 2026-08-22 its last-verified was
  // stamped by unrelated button/focus-ring work whose eight chained notes each
  // said "nothing else re-verified in this pass". A PR touching that component
  // must still be told the doc describes it.
  const docs = [
    {
      doc: 'docs/product/design-system.md',
      covers: ['packages/frontend/src/components/haven/TransactionMovement.tsx'],
      lastVerified: '2026-08-22',
    },
  ]
  const f = implicatedDocs(
    ['packages/frontend/src/components/haven/TransactionMovement.tsx'],
    docs,
  )
  assert.deepEqual(f.map((x) => x.doc), ['docs/product/design-system.md'])
})

test('#1824: a doc THIS change edited is still skipped — that path is untouched', () => {
  // The half of the old heuristic that was actually load-bearing was never the
  // date: it is `changedSet.has(doc)`. Verifying a doc means editing it, so the
  // author who re-read it is not nagged. Asserted explicitly, because removing
  // the date check would look identical to breaking this one if it regressed.
  const docs = [
    { doc: 'docs/a.md', covers: ['packages/x/**'], lastVerified: '2026-06-01' },
  ]
  const f = implicatedDocs(['packages/x/y.ts', 'docs/a.md'], docs)
  assert.equal(f.length, 0)
})

test('carries the contract flag through to findings (#646 strict mode)', () => {
  const docs = [
    { doc: 'docs/a.md', covers: ['packages/x/**'], lastVerified: '2026-06-01', contract: true },
    { doc: 'docs/b.md', covers: ['packages/x/**'], lastVerified: '2026-06-01' },
  ]
  const f = implicatedDocs(['packages/x/y.ts'], docs)
  assert.deepEqual(
    f.map((x) => [x.doc, x.contract]).sort(),
    [['docs/a.md', true], ['docs/b.md', false]],
  )
})

// --- #1077, as extended by #1824 ---
//
// #1077's finding was that a wall-clock heuristic must not weaken the BLOCKING
// half: it would make a required check green at 23:59 and red at 00:01 with no
// code change. It fixed that by carving contract-docs-under-strict out of the
// suppression. #1824 found the carve-out was the wrong shape — the same
// argument applies to the advisory half, so the suppression is gone entirely
// and these tests now assert its absence in both postures.

const CONTRACT_DOCS = [
  { doc: 'docs/regulatory/casp.md', covers: ['packages/x/**'], lastVerified: '2026-06-01', contract: true },
  { doc: 'docs/advisory.md', covers: ['packages/x/**'], lastVerified: '2026-06-01' },
]

test('strict mode flags a contract doc regardless of its stamp (#1077)', () => {
  // #1077's own assertion was `deepEqual([casp.md])` — which held only because
  // the advisory doc was suppressed alongside. That made the test's exact list
  // depend on a behaviour it was not testing. It now asserts what #1077 was
  // actually about: the contract doc is present, and it carries the flag the
  // strict gate blocks on.
  const f = implicatedDocs(['packages/x/y.ts'], CONTRACT_DOCS, { strict: true })
  const casp = f.find((x) => x.doc === 'docs/regulatory/casp.md')
  assert.ok(casp, 'a contract doc covering a changed file must be implicated under strict')
  assert.equal(casp.contract, true)
})

test('#1824: strict mode now flags the ADVISORY doc too', () => {
  // Was `strict mode still same-day-suppresses an advisory doc`. Under strict,
  // the advisory doc is still reported — it simply does not FAIL the build.
  // Reporting and blocking are separate axes, and the old code conflated them.
  const f = implicatedDocs(['packages/x/y.ts'], CONTRACT_DOCS, { strict: true })
  assert.equal(f.some((x) => x.doc === 'docs/advisory.md'), true)
})

test('#1824: advisory mode flags both, where it used to flag neither', () => {
  const f = implicatedDocs(['packages/x/y.ts'], CONTRACT_DOCS)
  assert.deepEqual(f.map((x) => x.doc).sort(), ['docs/advisory.md', 'docs/regulatory/casp.md'])
})

// --- #1077: tests and generated files are incidental to prose ---

test('isIncidentalPath recognises tests and generated files', () => {
  for (const p of [
    'packages/frontend/src/components/__tests__/BudgetGrantAction.test.tsx',
    'packages/backend/src/routes/agent-connection-setups.test.ts',
    'packages/sdk/src/x402.spec.ts',
    'packages/core/src/api-types.ts',
  ]) {
    assert.equal(isIncidentalPath(p), true, p)
  }
  for (const p of [
    'packages/frontend/src/components/BudgetGrantAction.tsx',
    'packages/backend/src/routes/agent-connection-setups.ts',
    'packages/backend/src/lib/latest.ts', // "test" as a substring must not match
  ]) {
    assert.equal(isIncidentalPath(p), false, p)
  }
})

test('a wildcard glob does not implicate via a test file alone', () => {
  const docs = [{ doc: 'docs/product/design-review.md', covers: ['packages/frontend/src/components/**'], lastVerified: '2026-06-01' }]
  const f = implicatedDocs(
    ['packages/frontend/src/components/__tests__/BudgetGrantAction.test.tsx'],
    docs
  )
  assert.equal(f.length, 0)
})

test('a non-test sibling under the same glob still implicates', () => {
  const docs = [{ doc: 'docs/product/design-review.md', covers: ['packages/frontend/src/components/**'], lastVerified: '2026-06-01' }]
  const f = implicatedDocs(
    [
      'packages/frontend/src/components/BudgetGrantAction.tsx',
      'packages/frontend/src/components/__tests__/BudgetGrantAction.test.tsx',
    ],
    docs
  )
  // Implicated by the source file, and the incidental test is not listed as evidence.
  assert.deepEqual(f.map((x) => x.matched), [['packages/frontend/src/components/BudgetGrantAction.tsx']])
})

test('strict mode does not filter incidental paths for a contract doc (review finding)', () => {
  // casp-risk-guardrails.md covers `packages/sdk/src/**` — a wildcard. Filtering
  // test files out of a BLOCKING gate reopens the same green-when-it-should-be-red
  // hole this gate exists to close: a test-only PR against a money-path package.
  const docs = [{
    doc: 'docs/regulatory/casp.md',
    covers: ['packages/sdk/src/**'],
    lastVerified: '2026-06-01',
    contract: true,
  }]
  const changed = ['packages/sdk/src/client.test.ts']
  assert.equal(implicatedDocs(changed, docs, { strict: true }).length, 1)
  // Advisory posture keeps the noise reduction.
  assert.equal(implicatedDocs(changed, docs).length, 0)
})

test('packages whose content IS tests are never incidental', () => {
  // e2e-qa-runbook.md covers `packages/frontend/e2e/live/**` and agent-qa.md
  // covers `packages/qa-agent/**` — those specs are the documented subject, not
  // a test of some other source.
  assert.equal(isIncidentalPath('packages/frontend/e2e/live/smoke.spec.ts'), false)
  assert.equal(isIncidentalPath('packages/qa-agent/src/scenarios/x402.test.ts'), false)

  const docs = [{ doc: 'docs/operations/agent-qa.md', covers: ['packages/qa-agent/**'], lastVerified: '2026-06-01' }]
  const f = implicatedDocs(['packages/qa-agent/src/scenarios/x402.test.ts'], docs)
  assert.deepEqual(f.map((x) => x.doc), ['docs/operations/agent-qa.md'])
})

// --- #1854: the e2e carve-out must not protect generated snapshots ---

const BASELINE = 'packages/frontend/e2e/__screenshots__/design-system.visual.spec.ts/design-system-desktop.png'
// The one doc in the repo whose `covers` glob reaches the baselines.
const RUN_REPORT = [{
  doc: 'docs/bug-reports/_run-report-template.md',
  covers: ['packages/frontend/e2e/**'],
  lastVerified: '2026-06-01',
}]

test('a committed visual baseline is incidental despite living under packages/frontend/e2e/', () => {
  // The carve-out above returns false for everything under that prefix. The
  // baselines are generated by the *Update visual baselines* workflow and
  // described by no runbook, so they must be reached FIRST.
  assert.equal(isIncidentalPath(BASELINE), true)
  // Not reachable by falling through: the path ends `.png`, and the directory
  // component `design-system.visual.spec.ts` is not `__tests__`.
  assert.equal(/(^|\/)__tests__\//.test(BASELINE), false)
  assert.equal(/\.(test|spec)\.[cm]?[jt]sx?$/.test(BASELINE), false)
})

test('a baseline-only regeneration does not implicate a doc covering packages/frontend/e2e/**', () => {
  // The #1854 case: on #1845 this fired three times, once per CI run.
  const f = implicatedDocs([BASELINE], RUN_REPORT)
  assert.deepEqual(f, [])
})

test('an e2e SPEC change still implicates the docs that describe the specs (#1076 preserved)', () => {
  // The half that must NOT be traded away. e2e-qa-runbook.md and agent-qa.md
  // are about these specs; a spec edit is a real staleness signal.
  assert.equal(isIncidentalPath('packages/frontend/e2e/design-system.visual.spec.ts'), false)
  const docs = [{
    doc: 'docs/operations/e2e-qa-runbook.md',
    covers: ['packages/frontend/e2e/**'],
    lastVerified: '2026-06-01',
  }]
  const f = implicatedDocs(['packages/frontend/e2e/design-system.visual.spec.ts'], docs)
  assert.deepEqual(f.map((x) => x.doc), ['docs/operations/e2e-qa-runbook.md'])
  // And a spec edit shipped alongside a baseline regeneration still implicates,
  // listing only the spec as evidence — the PNG is not offered as a reason.
  const both = implicatedDocs([BASELINE, 'packages/frontend/e2e/design-system.visual.spec.ts'], docs)
  assert.deepEqual(both.map((x) => x.matched), [['packages/frontend/e2e/design-system.visual.spec.ts']])
})

test('a doc that names a baseline path EXACTLY is still implicated by it', () => {
  // The documented escape hatch: exact `covers` entries bypass the incidental
  // filter, so pinning a baseline by name opts back in deliberately.
  const docs = [{ doc: 'docs/product/design-system.md', covers: [BASELINE], lastVerified: '2026-06-01' }]
  const f = implicatedDocs([BASELINE], docs)
  assert.deepEqual(f.map((x) => x.doc), ['docs/product/design-system.md'])
})

test('a contract doc under --strict still sees a baseline change (blocking half untouched)', () => {
  // Noise reduction never weakens the blocking half — same carve-out the other
  // incidental kinds already get.
  const docs = [{
    doc: 'docs/regulatory/casp.md',
    covers: ['packages/frontend/e2e/**'],
    lastVerified: '2026-06-01',
    contract: true,
  }]
  assert.equal(implicatedDocs([BASELINE], docs, { strict: true }).length, 1)
  assert.equal(implicatedDocs([BASELINE], docs).length, 0)
})

test('an EXACT covers entry still implicates via a test file', () => {
  // 07-edge-signer.md deliberately pins hosted-signer-integration.test.ts.
  const docs = [{
    doc: 'docs/architecture/07-edge-signer.md',
    covers: ['packages/mcp-server/src/hosted-signer-integration.test.ts'],
    lastVerified: '2026-06-01',
  }]
  const f = implicatedDocs(['packages/mcp-server/src/hosted-signer-integration.test.ts'], docs)
  assert.deepEqual(f.map((x) => x.doc), ['docs/architecture/07-edge-signer.md'])
})

// ── #1337: computed-empty vs uncomputable change-sets ────────────────────────
import { changedFilesWithProvenance } from './coupling-gate.mjs'
import { execFileSync as _exec } from 'node:child_process'
import { test as test1337 } from 'node:test'
import assert1337 from 'node:assert'

test1337('a CI three-dot range that computes to empty is provably computed (pure merge/sync PR passes strict)', () => {
  const head = _exec('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  process.env.BASE_SHA = head
  process.env.HEAD_SHA = head
  try {
    const r = changedFilesWithProvenance()
    assert1337.deepStrictEqual(r.files, [])
    assert1337.strictEqual(r.computed, true)
  } finally {
    delete process.env.BASE_SHA
    delete process.env.HEAD_SHA
  }
})

test1337('a BROKEN range stays fail-closed: empty but not computed (#1076 protection intact)', () => {
  process.env.BASE_SHA = '0000000000000000000000000000000000000000'
  process.env.HEAD_SHA = 'HEAD'
  try {
    const r = changedFilesWithProvenance()
    assert1337.deepStrictEqual(r.files, [])
    assert1337.strictEqual(r.computed, false)
  } finally {
    delete process.env.BASE_SHA
    delete process.env.HEAD_SHA
  }
})

// ── #1366: satisfied-by shards ────────────────────────────────────────────────

import { test as test1366 } from 'node:test'
import assert1366 from 'node:assert'

const SHARDED_DOC = {
  doc: 'docs/regulatory/casp-risk-guardrails.md',
  covers: ['packages/signer/**', 'packages/backend/src/routes/payments.ts'],
  lastVerified: '2020-01-01',
  contract: true,
  satisfiedBy: ['docs/regulatory/casp-changelog/**'],
}

test1366('a changed shard satisfies the contract doc in strict mode (#1366)', () => {
  const f = implicatedDocs(
    ['packages/signer/src/core.ts', 'docs/regulatory/casp-changelog/2026-08-12-1399.md'],
    [SHARDED_DOC],
    { strict: true },
  )
  assert1366.deepStrictEqual(f, [])
})

/**
 * #1824 review: the three tests in this block used to be called as
 * `implicatedDocs(changed, docs, undefined, { strict: true })` — the pre-#1824
 * four-argument form. After the signature lost its `today` parameter, that
 * `undefined` landed in the options slot and `{ strict: true }` was dropped
 * silently by JS, so every test here ran in ADVISORY mode while its name said
 * strict. They still passed, because their fixtures produce the same answer in
 * both postures.
 *
 * Fixing the call form alone would have been cosmetic. `filterIncidental` is
 * the ONLY strict-dependent branch in `implicatedDocs`, and none of these
 * fixtures reach it — their changed file is ordinary source. So this test is
 * added to make the distinction real: the changed file is a TEST file, which
 * advisory mode filters as incidental and strict mode deliberately does not
 * (the #1076 carve-out — a contract doc whose covered paths are all incidental
 * would otherwise pass `--strict` silently).
 *
 * With this fixture the two postures disagree, so passing the wrong one is no
 * longer invisible. Verified by re-breaking the call to the four-argument form:
 * this test goes red, and only this one.
 */
test1366('#1824: strict vs advisory actually diverge on a sharded contract doc', () => {
  const changed = ['packages/signer/src/core.test.ts']
  const strictFindings = implicatedDocs(changed, [SHARDED_DOC], { strict: true })
  assert1366.strictEqual(strictFindings.length, 1, 'strict must not filter incidental paths for a contract doc')
  assert1366.strictEqual(strictFindings[0].contract, true)

  const advisoryFindings = implicatedDocs(changed, [SHARDED_DOC])
  assert1366.strictEqual(advisoryFindings.length, 0, 'advisory mode filters a test file as incidental')
})

test1366('MUTATION PROOF: the same change WITHOUT a shard still blocks (#1366)', () => {
  const f = implicatedDocs(
    ['packages/signer/src/core.ts'],
    [SHARDED_DOC],
    { strict: true },
  )
  assert1366.strictEqual(f.length, 1)
  assert1366.strictEqual(f[0].contract, true)
})

test1366('a shard satisfies ONLY docs that declare it — not every contract doc (#1366)', () => {
  const other = {
    doc: 'docs/architecture/04-x402-payment-sequence.md',
    covers: ['packages/signer/**'],
    lastVerified: '2020-01-01',
    contract: true,
    satisfiedBy: [],
  }
  const f = implicatedDocs(
    ['packages/signer/src/core.ts', 'docs/regulatory/casp-changelog/2026-08-12-1399.md'],
    [SHARDED_DOC, other],
    { strict: true },
  )
  assert1366.strictEqual(f.length, 1)
  assert1366.strictEqual(f[0].doc, other.doc)
})

// #1496 — a doc with satisfied-by is satisfied by a shard, NOT by editing the
// doc; and the strict error names that path. Three one-day merge conflicts
// came from PRs editing the same last-verified line while their shards
// already satisfied the gate — because the message never said so.
test('a satisfied-by shard suppresses the strict contract finding (#1496)', () => {
  const docs = [{
    doc: 'docs/regulatory/casp-risk-guardrails.md',
    covers: ['packages/backend/src/modules/x402/**'],
    lastVerified: '2020-01-01',
    contract: true,
    satisfiedBy: ['docs/regulatory/casp-changelog/**'],
  }]
  const withShard = implicatedDocs(
    ['packages/backend/src/modules/x402/helpers.ts', 'docs/regulatory/casp-changelog/2026-08-16-1.md'],
    docs, { strict: true },
  )
  assert.deepEqual(withShard, [])
  const withoutShard = implicatedDocs(
    ['packages/backend/src/modules/x402/helpers.ts'],
    docs, { strict: true },
  )
  assert.equal(withoutShard.length, 1)
})

/**
 * #1790: a release bump now WRITES the Supported Runtime Manifest table in
 * `docs/operations/mcp-runtime-compatibility.md`, which it previously left a
 * human to re-pin by hand.
 *
 * That changes something subtle about this gate, and the change is worth
 * pinning rather than reasoning about again later. Satisfaction here is
 * FILE PRESENCE — `if (changedSet.has(doc)) continue` — with no opinion about
 * who wrote the diff or whether `last-verified` moved. Before #1790, the only
 * way that doc could appear in a release diff was a human editing it, so
 * "touched" and "read by a human" were the same event. They are not any more.
 *
 * The acceptance criterion #1790 must keep is that **a bump alone cannot
 * produce a release PR that satisfies the gate with zero human input**. It
 * still holds — but via `casp-risk-guardrails.md`, whose `covers:` spans the
 * published packages every release touches and which is satisfied only by a
 * hand-written shard. That is a real guarantee resting on another doc's
 * `covers:` breadth, which nothing else would notice being narrowed.
 *
 * So: assert it directly, against the repo's REAL front-matter. If someone ever
 * narrows CASP's coverage (entirely plausible — "connect isn't money-path"),
 * this fails instead of the human-read requirement disappearing silently.
 *
 * #1739 — be exact about WHICH entries carry this, because the loose phrasing
 * ("CASP's five published-package `covers:` entries") is wrong in both
 * directions and would mislead whoever narrows the list next. The entries a
 * bump-only diff actually lands on are `packages/mcp/src/**`,
 * `packages/signer/src/**`, `packages/connect/src/**` and
 * `packages/mcp-server/src/**` — and `mcp-server` is a PRIVATE package, never
 * published. `packages/sdk/src/**` is covered but contributes nothing here: the
 * bump rewrites no source constant under it, only `packages/sdk/package.json`.
 *
 * #1826 — `packages/cli/src/**` now carries it too. It is a published package
 * the bump DOES write (`CLI_VERSION` in `commands.ts`), and it was the one such
 * entry CASP did not cover; #1826 added it (with
 * `packages/backend/src/routes/agents.ts`) after finding the agent-authority
 * surface gated by no contract doc. So FIVE entries carry this guarantee:
 * `packages/mcp/src/**`, `packages/signer/src/**`, `packages/connect/src/**`,
 * `packages/mcp-server/src/**` and `packages/cli/src/**`. Narrowing any one of
 * them weakens it; narrowing all five removes it.
 */
test('a bump-only release diff still FAILS the strict gate — no shard, no green (#1790)', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const run = promisify(execFile)

  const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

  // Exactly what `npm run release:bump` produces and nothing more: the version
  // constants it rewrites, plus the contract-doc table it now writes itself.
  // Deliberately NO casp-changelog shard and NO other hand edit.
  const bumpOnly = [
    'packages/sdk/package.json',
    'packages/connect/src/runtime-manifest.ts',
    'packages/connect/src/runtime.ts',
    'packages/mcp/src/server.ts',
    'packages/signer/src/server.ts',
    'packages/mcp-server/src/server.ts',
    'packages/cli/src/commands.ts',
    'docs/operations/mcp-runtime-compatibility.md',
  ].join(',')

  let failed = false
  let output = ''
  try {
    const { stdout } = await run(
      'node',
      [join(ROOT, 'scripts', 'docs', 'coupling-gate.mjs'), '--strict', `--changed=${bumpOnly}`, '--out=/dev/null'],
      { cwd: ROOT },
    )
    output = stdout
  } catch (err) {
    failed = true
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }

  assert.ok(
    failed,
    'the strict coupling gate went GREEN on a bump-only diff — a release could now be opened with no human-written contract-doc content at all (#1790)',
  )
  assert.match(
    output,
    /casp-risk-guardrails\.md/,
    'the blocking finding should be the CASP guardrails doc, which only a hand-written shard satisfies',
  )
})

// ── #2192: only an ADDED satisfied-by file clears the gate ────────────────────
//
// The defect: `satisfiedBy` asked only whether SOME changed file matched the
// glob, never whether it was new. So a money-path PR could clear the blocking
// contract-doc gate by editing a shard that merged months ago, writing no
// verification record at all — silently, on green CI.
//
// The bug lived in the seam between "what git reports" and "what the gate asks
// of it", so the seam is covered from both ends: `parseNameStatus` against real
// `git diff --name-status` text, and a spawned end-to-end pair that drives the
// real script — main(), the message, the exit code — against the repo's real
// front-matter.

import { test as test2192 } from 'node:test'
import assert2192 from 'node:assert/strict'
import { execFileSync as exec2192 } from 'node:child_process'
import { join as join2192, dirname as dirname2192 } from 'node:path'
import { fileURLToPath as fileURLToPath2192 } from 'node:url'
import { parseNameStatus } from './coupling-gate.mjs'

const ROOT2192 = dirname2192(dirname2192(dirname2192(fileURLToPath2192(import.meta.url))))

// Deliberately routes/payments.ts and not packages/signer/src/core.ts: signer
// is ALSO covered by mcp-runtime-compatibility.md, another contract doc with no
// `satisfied-by`, so the positive control below would block for a reason that
// has nothing to do with this rule. payments.ts is covered by the CASP
// guardrails doc alone, which makes both directions unambiguous.
const MONEY_FILE = 'packages/backend/src/routes/payments.ts'
const OLD_SHARD = 'docs/regulatory/casp-changelog/2026-08-12-1399.md'
const NEW_SHARD = 'docs/regulatory/casp-changelog/2026-08-29-2192.md'

test2192('editing an ALREADY-MERGED shard no longer satisfies the contract doc (#2192)', () => {
  const f = implicatedDocs([MONEY_FILE, OLD_SHARD], [SHARDED_DOC], {
    strict: true,
    added: new Set(), // the shard was modified, not added
  })
  assert2192.equal(f.length, 1, 'an edit to a pre-existing shard must NOT clear the gate')
  assert2192.equal(f[0].doc, 'docs/regulatory/casp-risk-guardrails.md')
  assert2192.deepEqual(
    f[0].editedOnlySatisfyMatches,
    [OLD_SHARD],
    'the near-miss is carried so the error message can explain why the edit did not count',
  )
})

test2192('adding a new shard still satisfies it (#2192)', () => {
  const f = implicatedDocs([MONEY_FILE, NEW_SHARD], [SHARDED_DOC], {
    strict: true,
    added: new Set([NEW_SHARD]),
  })
  assert2192.deepEqual(f, [], 'writing your own shard is the whole intended remedy')
})

test2192('a new shard PLUS an edit to an old one still satisfies it (#2192)', () => {
  // The rule is "at least one ADDED match", never "no modified matches" —
  // otherwise tidying an old shard in the same PR would block a change that
  // did write its own record. This is what keeps #2191's duplicate cleanup
  // and ordinary release flows working.
  const f = implicatedDocs([MONEY_FILE, OLD_SHARD, NEW_SHARD], [SHARDED_DOC], {
    strict: true,
    added: new Set([NEW_SHARD]),
  })
  assert2192.deepEqual(f, [])
})

test2192('unknown add/modify status restores the pre-#2192 behaviour (#2192)', () => {
  // `added: null` is what a bare `--changed=` list produces. Permissive by
  // design and scoped to that path only: the job that gates a PR sets BASE_SHA
  // and always supplies real status.
  const f = implicatedDocs([MONEY_FILE, OLD_SHARD], [SHARDED_DOC], { strict: true, added: null })
  assert2192.deepEqual(f, [])
})

test2192('a RENAMED shard does not count as added (#2192)', () => {
  // An old record under a new name is not a new record. `parseNameStatus`
  // reports the new path (matching --name-only) but only marks `A` as added.
  const { files, added } = parseNameStatus(
    `M\t${MONEY_FILE}\nR100\t${OLD_SHARD}\t${NEW_SHARD}\n`,
  )
  assert2192.deepEqual(files, [MONEY_FILE, NEW_SHARD], 'renames report the NEW path')
  assert2192.equal(added.size, 0, 'a rename is not an add')
  assert2192.equal(implicatedDocs(files, [SHARDED_DOC], { strict: true, added }).length, 1)
})

test2192('a deleted old shard alongside an UNRELATED new one still counts as added (#2192)', () => {
  // The case-3 fold-in shape this repo endorses: remove a duplicate while
  // writing your own shard. Measured on git 2.43 — an unrelated pair reports
  // `D` + `A`, so the new shard counts and nothing is wrongly blocked. Only a
  // near-identical pair collapses to `R`, and blocking THAT is correct.
  // This pins the shape so `--no-renames` is never needed to "fix" it; see the
  // `parseNameStatus` docblock for why that fix would reopen the bypass.
  const { files, added } = parseNameStatus(
    `M\t${MONEY_FILE}\nD\tdocs/regulatory/casp-changelog/2026-08-14-1403 3.md\nA\t${NEW_SHARD}\n`,
  )
  assert2192.ok(added.has(NEW_SHARD), 'the genuinely new shard must still count as added')
  assert2192.deepEqual(implicatedDocs(files, [SHARDED_DOC], { strict: true, added }), [])
})

test2192('parseNameStatus reads status and path, tolerating renames and blanks', () => {
  const { files, added } = parseNameStatus('A\ta.ts\nM\tb.ts\n\nD\tc.ts\nR100\told.md\tnew.md\n')
  assert2192.deepEqual(files, ['a.ts', 'b.ts', 'c.ts', 'new.md'])
  assert2192.deepEqual([...added], ['a.ts'])
})

test2192('end-to-end: the real script BLOCKS a money-path diff whose only shard match is an edit (#2192)', () => {
  let failed = false
  let output = ''
  try {
    output = exec2192(
      'node',
      [
        join2192(ROOT2192, 'scripts', 'docs', 'coupling-gate.mjs'),
        '--strict',
        `--changed=${MONEY_FILE},${OLD_SHARD}`,
        '--added=', // nothing added: the shard was edited
        '--out=/dev/null',
      ],
      { cwd: ROOT2192, encoding: 'utf8' },
    )
  } catch (err) {
    failed = true
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  assert2192.ok(
    failed,
    'the gate went GREEN on a money-path diff whose only satisfying file was an EDIT to an already-merged shard — the #2192 defect',
  )
  assert2192.match(output, /casp-risk-guardrails\.md/)
  assert2192.match(
    output,
    /EDITED, not added/,
    'the error must say why an apparently-satisfying edit did not satisfy, or it reads as "add a shard" to someone looking at the shard they just edited',
  )
})

test2192('end-to-end: the real script PASSES the same diff once a new shard is added (#2192)', () => {
  // The positive control. Without it, a gate that refused everything would
  // pass the test above for the wrong reason.
  const output = exec2192(
    'node',
    [
      join2192(ROOT2192, 'scripts', 'docs', 'coupling-gate.mjs'),
      '--strict',
      `--changed=${MONEY_FILE},${OLD_SHARD},${NEW_SHARD}`,
      `--added=${NEW_SHARD}`,
      '--out=/dev/null',
    ],
    { cwd: ROOT2192, encoding: 'utf8' },
  )
  assert2192.doesNotMatch(output, /BLOCKING/)
})
