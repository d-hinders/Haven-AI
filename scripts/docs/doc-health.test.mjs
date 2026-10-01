// Run with: node --test scripts/docs/doc-health.test.mjs (#3511)

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildDocHealth, FLAGS } from './doc-health.mjs'
import { docFilesFrom, ROOT_DOCS } from './validate-frontmatter.mjs'

const SCRIPT = fileURLToPath(new URL('./doc-health.mjs', import.meta.url))
const AT = '2026-10-01T12:00:00.000Z'

function fm({ owner = '"@d-hinders"', status = 'current', covers = '\n  - scripts/docs/**', lastVerified = '2026-09-30' } = {}) {
  const lines = ['---']
  if (owner !== null) lines.push(`owner: ${owner}`)
  lines.push(`status: ${status}`, `covers:${covers}`, `last-verified: "${lastVerified}"`, '---', '', '# Doc')
  return lines.join('\n')
}

function flagsOf(report, path) {
  return report.docs.find((d) => d.path === path)?.flags
}

test('each flag fires on its fixture, and a healthy doc carries none', () => {
  const r = buildDocHealth({
    generatedAt: AT,
    packageDocs: [],
    docs: [
      { path: 'docs/ok.md', raw: fm() },
      { path: 'docs/no-fm.md', raw: '# No front-matter\n' },
      { path: 'docs/no-owner.md', raw: fm({ owner: null }) },
      { path: 'docs/empty.md', raw: fm({ covers: ' []  # narrative' }) },
      { path: 'docs/old.md', raw: fm({ lastVerified: '2026-07-01' }) },
    ],
  })
  assert.deepEqual(flagsOf(r, 'docs/ok.md'), [])
  assert.deepEqual(flagsOf(r, 'docs/no-fm.md'), ['no-front-matter'])
  assert.deepEqual(flagsOf(r, 'docs/no-owner.md'), ['no-owner'])
  assert.deepEqual(flagsOf(r, 'docs/empty.md'), ['empty-covers'])
  assert.deepEqual(flagsOf(r, 'docs/old.md'), ['unverified-90d'])
  assert.deepEqual(r.counts, { 'no-front-matter': 1, 'no-owner': 1, 'empty-covers': 1, 'unverified-90d': 1 })
  assert.deepEqual(Object.keys(r.counts), FLAGS)
})

test('unverified-90d is strictly more than 90 days before generatedAt', () => {
  const r = buildDocHealth({
    generatedAt: AT,
    packageDocs: [],
    docs: [
      { path: 'docs/day90.md', raw: fm({ lastVerified: '2026-07-03' }) },
      { path: 'docs/day91.md', raw: fm({ lastVerified: '2026-07-02' }) },
    ],
  })
  assert.deepEqual(flagsOf(r, 'docs/day90.md'), [])
  assert.deepEqual(flagsOf(r, 'docs/day91.md'), ['unverified-90d'])
})

test('archived and research docs are never unverified-90d', () => {
  const r = buildDocHealth({
    generatedAt: AT,
    packageDocs: [],
    docs: [
      { path: 'docs/research/spike.md', raw: fm({ status: 'research', lastVerified: '2025-01-01' }) },
      { path: 'docs/legacy.md', raw: fm({ status: 'archived', lastVerified: '2025-01-01' }) },
    ],
  })
  assert.deepEqual(flagsOf(r, 'docs/research/spike.md'), [])
  assert.deepEqual(flagsOf(r, 'docs/legacy.md'), [])
})

test('docs/archive/** is outside the population', () => {
  const r = buildDocHealth({
    generatedAt: AT,
    packageDocs: [],
    docs: [
      { path: 'docs/archive/decision-log.md', raw: fm({ status: 'archived' }) },
      { path: 'docs/ok.md', raw: fm() },
    ],
  })
  assert.deepEqual(r.docs.map((d) => d.path), ['docs/ok.md'])
})

test('CASP changelog shards are excluded, not flagged; their README and the root docs stay in', () => {
  const paths = docFilesFrom([
    'docs/regulatory/casp-changelog/2026-10-01-3506.md',
    'docs/regulatory/casp-changelog/README.md',
    'docs/product/analytics.md',
    'docs/diagram.png',
  ])
  assert.ok(!paths.includes('docs/regulatory/casp-changelog/2026-10-01-3506.md'))
  assert.ok(paths.includes('docs/regulatory/casp-changelog/README.md'))
  assert.ok(paths.includes('docs/product/analytics.md'))
  assert.ok(!paths.includes('docs/diagram.png'))
  for (const root of ROOT_DOCS) assert.ok(paths.includes(root), root)
})

test('governed package docs join the population from their manifest records', () => {
  const r = buildDocHealth({
    generatedAt: AT,
    docs: [],
    packageDocs: [
      { doc: 'packages/sdk/README.md', owner: '@d-hinders', status: 'current', covers: ['packages/sdk/src/**'], 'last-verified': '2026-06-01' },
    ],
  })
  assert.deepEqual(r.docs, [
    { path: 'packages/sdk/README.md', owner: '@d-hinders', status: 'current', lastVerified: '2026-06-01', flags: ['unverified-90d'] },
  ])
})

test('output is sorted by path and states what an empty panel means', () => {
  const r = buildDocHealth({
    generatedAt: AT,
    packageDocs: [{ doc: 'packages/a/README.md', owner: 'x', status: 'current', covers: ['x'], 'last-verified': '2026-09-30' }],
    docs: [
      { path: 'docs/z.md', raw: fm() },
      { path: 'AGENTS.md', raw: fm() },
      { path: 'docs/a.md', raw: fm() },
    ],
  })
  assert.deepEqual(r.docs.map((d) => d.path), ['AGENTS.md', 'docs/a.md', 'docs/z.md', 'packages/a/README.md'])
  assert.equal(r.total, 4)
  assert.ok(r.notes.some((n) => /hard CI gate/.test(n)))
  assert.ok(r.notes.some((n) => /NOT the commit-based staleness signal/.test(n)))
})

test('the CLI is deterministic on the real tree: two runs with the same --generated-at are byte-identical', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-health-'))
  const outs = [join(dir, 'a.json'), join(dir, 'b.json')]
  for (const out of outs) {
    const r = spawnSync(process.execPath, [SCRIPT, '--out', out, '--generated-at', AT], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  const [a, b] = outs.map((o) => readFileSync(o, 'utf8'))
  assert.equal(a, b)
  const report = JSON.parse(a)
  assert.equal(report.generatedAt, AT)
  assert.ok(report.total > 0)
  // The real tree: no CASP shard and no archive doc ever reaches the report,
  // and the validator gate means no governed doc lacks front-matter or owner.
  assert.ok(!report.docs.some((d) => /^docs\/regulatory\/casp-changelog\/(?!README\.md$)/.test(d.path)))
  assert.ok(!report.docs.some((d) => d.path.startsWith('docs/archive/')))
  assert.equal(report.counts['no-front-matter'], 0)
  assert.equal(report.counts['no-owner'], 0)
})

test('the CLI refuses an unknown argument and a bad --generated-at', () => {
  const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' })
  assert.notEqual(bad.status, 0)
  const date = spawnSync(process.execPath, [SCRIPT, '--generated-at', 'yesterday'], { encoding: 'utf8' })
  assert.notEqual(date.status, 0)
})

test('generatedAt: a zone-less time or free text is refused; a date or zoned time is normalised to ISO', () => {
  const run = (generatedAt) => buildDocHealth({ docs: [], packageDocs: [], generatedAt })
  assert.throws(() => run('October 1, 2026'), /ISO date/)
  assert.throws(() => run('2026-10-01T00:00:00'), /ISO date/)
  assert.equal(run('2026-10-01').generatedAt, '2026-10-01T00:00:00.000Z')
  assert.equal(run('2026-10-01T02:00:00+02:00').generatedAt, '2026-10-01T00:00:00.000Z')
})

test('the CLI names the flag whose value is missing', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--out', '--generated-at', AT], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /--out needs a value/)
})
