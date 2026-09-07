/**
 * Self-test for the visual-baseline inventory (#2318).
 *
 * A report nobody tests can start answering vacuously, which is the exact
 * defect the report exists to expose — so it is tested here for the same reason
 * every other lint on the `Repo CI config checks` job is (see `ci.yml`).
 *
 * Every case below carries its own POSITIVE CONTROL: an assertion that the
 * check can say "no" before a "yes" is believed. A guard proven only in the
 * passing direction is decoration (#2307).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  collectBaselines,
  renderSummary,
  run,
} from './visual-baseline-inventory.mjs'

function fixture(tree) {
  const root = mkdtempSync(path.join(tmpdir(), 'visual-baselines-'))
  for (const [spec, files] of Object.entries(tree)) {
    mkdirSync(path.join(root, spec), { recursive: true })
    for (const file of files) writeFileSync(path.join(root, spec, file), 'png')
  }
  return root
}

test('collects baselines grouped by spec, sorted at both levels', () => {
  const root = fixture({
    'b.visual.spec.ts': ['z.png', 'a.png'],
    'a.visual.spec.ts': ['only.png'],
  })
  try {
    assert.deepEqual(collectBaselines(root), [
      { spec: 'a.visual.spec.ts', baselines: ['only.png'] },
      { spec: 'b.visual.spec.ts', baselines: ['a.png', 'z.png'] },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ignores non-PNG files and spec directories holding none', () => {
  const root = fixture({
    'kept.visual.spec.ts': ['real.png', 'notes.md'],
    'empty.visual.spec.ts': ['README.md'],
  })
  try {
    const groups = collectBaselines(root)
    assert.deepEqual(groups, [{ spec: 'kept.visual.spec.ts', baselines: ['real.png'] }])
    // Positive control: the filter is doing work, not vacuously matching.
    assert.ok(!JSON.stringify(groups).includes('notes.md'))
    assert.ok(!JSON.stringify(groups).includes('empty.visual.spec.ts'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an empty or missing tree FAILS — the vacuous-pass case', () => {
  const empty = fixture({})
  try {
    const lines = []
    assert.equal(run(empty, (t) => lines.push(t)), 1)
    assert.match(lines.join('\n'), /pass\s+vacuously/)

    // Positive control: the same call on a populated tree must return 0, so a
    // function that returned 1 unconditionally could not pass this test.
    const populated = fixture({ 's.visual.spec.ts': ['one.png'] })
    try {
      const okLines = []
      assert.equal(run(populated, (t) => okLines.push(t)), 0)
      assert.match(okLines.join('\n'), /one\.png/)
    } finally {
      rmSync(populated, { recursive: true, force: true })
    }
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('a directory that does not exist is the missing-tree case, not a crash', () => {
  const lines = []
  assert.equal(run(path.join(tmpdir(), 'visual-baselines-does-not-exist'), (t) => lines.push(t)), 1)
  assert.match(lines.join('\n'), /No visual baselines found/)
})

test('the summary names every baseline it found, and says what the tick does NOT cover', () => {
  const summary = renderSummary([
    { spec: 'one.visual.spec.ts', baselines: ['alpha.png', 'beta.png'] },
  ])
  for (const needle of ['one.visual.spec.ts', 'alpha.png', 'beta.png']) {
    assert.ok(summary.includes(needle), `summary omitted ${needle}`)
  }
  assert.match(summary, /no pixel baseline at all/)
  // Positive control: a baseline that is NOT in the input must not appear —
  // otherwise "it names every baseline" would be satisfied by naming everything.
  assert.ok(!summary.includes('gamma.png'))
})

test('counts are pluralised off the real totals, not hardcoded', () => {
  const one = renderSummary([{ spec: 's.visual.spec.ts', baselines: ['a.png'] }])
  assert.match(one, /\*\*1\*\* committed baseline across \*\*1\*\* spec file:/)
  const many = renderSummary([
    { spec: 'a.visual.spec.ts', baselines: ['a.png', 'b.png'] },
    { spec: 'b.visual.spec.ts', baselines: ['c.png'] },
  ])
  assert.match(many, /\*\*3\*\* committed baselines across \*\*2\*\* spec files:/)
})
