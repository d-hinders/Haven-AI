import test from 'node:test'
import assert from 'node:assert/strict'
import { toPathspec, rankFindings } from './audit-staleness.mjs'

test('toPathspec adds :(glob) only for glob patterns', () => {
  assert.equal(toPathspec('packages/backend/src/index.ts'), 'packages/backend/src/index.ts')
  assert.equal(toPathspec('packages/mcp/**'), ':(glob)packages/mcp/**')
  assert.equal(toPathspec('docs/?.md'), ':(glob)docs/?.md')
})

test('rankFindings sorts by commit count, oldest verification breaking ties', () => {
  const ranked = rankFindings([
    { doc: 'a', commits: 2, lastVerified: '2026-06-01' },
    { doc: 'b', commits: 5, lastVerified: '2026-07-01' },
    { doc: 'c', commits: 2, lastVerified: '2026-05-01' },
  ])
  assert.deepEqual(ranked.map((f) => f.doc), ['b', 'c', 'a'])
})

// #4459: the real CLI, over a fixture tree with commits. `commitsSince` turns a
// git error into `[]`, so a fixture without commits would pass with the skip
// deleted; the `current` doc with the same `covers:` and date is the positive
// control that proves commits were counted at all.
import { runGuard } from '../test-support/guard-cli.mjs'

const doc = (status) => `---
owner: "@d-hinders"
status: ${status}
covers:
  - packages/thing/**
last-verified: "2020-01-01"
---

# Doc
`

test('CLI (#4459): a `record` doc is never ranked; a `current` doc with the same covers and date is', () => {
  const { status, out } = runGuard('docs/audit-staleness.mjs', {
    also: ['docs/validate-frontmatter.mjs', 'docs/package-docs.mjs'],
    gitCommit: true,
    args: ['--json'],
    files: {
      'packages/thing/index.ts': '// covered code\n',
      'docs/bug-reports/2020-01-01-run.md': doc('record'),
      // The skip keys on the status, not the folder: a record outside
      // docs/bug-reports/ is skipped, and a `current` doc inside it (the
      // run-report template's stand-in) is ranked.
      'docs/contributing/retro.md': doc('record'),
      'docs/bug-reports/_template.md': doc('current'),
      'docs/area/live.md': doc('current'),
      'docs/research/spike.md': doc('research'),
      // The audit always reads the root gravity files; uncoupled here.
      ...Object.fromEntries(['CLAUDE.md', 'AGENTS.md', 'README.md', 'ABOUT_HAVEN.md'].map((f) => [f, '---\nowner: "@d-hinders"\nstatus: current\ncovers: []  # fixture\nlast-verified: "2020-01-01"\n---\n'])),
    },
  })
  assert.equal(status, 0, out)
  const ranked = JSON.parse(out.slice(out.indexOf('{\n  "generated"'))).findings.map((f) => f.doc)
  assert.deepEqual(ranked.sort(), ['docs/area/live.md', 'docs/bug-reports/_template.md'])
})
