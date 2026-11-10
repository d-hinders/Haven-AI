// Self-test for scripts/lint-route-line-ceiling.mjs (#4762, epic #4759 slice 3).
//
// Spawns the real CLI over fixture trees (`--root=`) rather than a copy of the
// gate, so the assertions cover the code CI runs. The cases the issue names are
// all here: a baselined file one line over its entry fails; one at or under its
// entry passes; a file at the threshold with no entry passes; one line over the
// threshold with no entry fails; `--update` lowers an entry, drops the entry of
// a file that fell to the threshold or under, and refuses to raise or add one.
//
// Run with: node --test scripts/lint-route-line-ceiling.test.mjs
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  countLines,
  scan,
  THRESHOLD,
  ROUTES_DIR,
  BASELINE_REL,
  DEFAULT_ROOT,
} from './lint-route-line-ceiling.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'scripts/lint-route-line-ceiling.mjs')

/** A fixture tree: `files` maps a route-file name to its line count. */
async function fixture(files, baseline) {
  const root = await mkdtemp(join(tmpdir(), 'route-line-ceiling-'))
  await mkdir(join(root, ROUTES_DIR), { recursive: true })
  for (const [name, lines] of Object.entries(files)) {
    await writeFile(join(root, ROUTES_DIR, name), 'x\n'.repeat(lines))
  }
  if (baseline !== undefined) {
    await writeFile(join(root, BASELINE_REL), JSON.stringify(baseline, null, 2) + '\n')
  }
  return root
}

function run(root, ...args) {
  return spawnSync(process.execPath, [CLI, `--root=${root}`, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

const readBaseline = async (root) => JSON.parse(await readFile(join(root, BASELINE_REL), 'utf8'))

describe('countLines — the measure the baseline is stated in', () => {
  test('matches `wc -l`: a trailing newline does not add a line', () => {
    assert.equal(countLines(''), 0)
    assert.equal(countLines('a'), 1)
    assert.equal(countLines('a\n'), 1)
    assert.equal(countLines('a\nb\n'), 2)
    assert.equal(countLines('a\nb'), 2)
    // The off-by-one this pins: `split('\n').length` says 2 for 'a\n'.
    assert.equal('a\n'.split('\n').length, 2)
  })

  test('agrees with the real `wc -l` on a real route file', () => {
    // The doc's "Largest route" row and the issue's measurements are `wc -l`
    // numbers, so a reader checking the baseline by hand must get the same
    // answer. Measured, not assumed.
    const file = join(ROOT, ROUTES_DIR, 'payments.ts')
    const wc = Number(execFileSync('wc', ['-l', file], { encoding: 'utf8' }).trim().split(/\s+/)[0])
    assert.equal(countLines(readFileSync(file, 'utf8')), wc)
  })
})

describe('scan — the numerator', () => {
  test('counts only direct, non-test .ts files; a file at the threshold is zero', async () => {
    const root = await fixture({
      'small.ts': THRESHOLD,
      'big.ts': THRESHOLD + 1,
      'ignored.test.ts': THRESHOLD + 100,
      'notes.md': THRESHOLD + 100,
    })
    try {
      await mkdir(join(root, ROUTES_DIR, 'nested'), { recursive: true })
      await writeFile(join(root, ROUTES_DIR, 'nested', 'deep.ts'), 'x\n'.repeat(THRESHOLD + 50))
      const { counts, fileCount } = await scan(root)
      assert.deepEqual(counts, { [`${ROUTES_DIR}/big.ts`]: { lines: THRESHOLD + 1 } })
      // The census counts every non-test direct .ts file it READ, small ones
      // included — that is what makes the zero-scan refusal honest.
      assert.equal(fileCount, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the gate', () => {
  test('is green at the repository head with the committed baseline', () => {
    const r = spawnSync(process.execPath, [CLI], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /no backend route file grew past its ceiling/)
  })

  test('the committed baseline has exactly one entry per route file over the threshold, each equal to its line count', async () => {
    // The acceptance criterion, checked against the tree rather than trusted.
    const { counts } = await scan(DEFAULT_ROOT)
    const committed = JSON.parse(readFileSync(join(DEFAULT_ROOT, BASELINE_REL), 'utf8'))
    assert.deepEqual(committed, counts)
    for (const [file, entry] of Object.entries(committed)) {
      assert.ok(entry.lines > THRESHOLD, `${file} is baselined but not over ${THRESHOLD} lines`)
      assert.equal(entry.lines, countLines(readFileSync(join(DEFAULT_ROOT, file), 'utf8')))
    }
  })

  test('a baselined file one line over its entry FAILS', async () => {
    const root = await fixture({ 'big.ts': THRESHOLD + 2 }, { [`${ROUTES_DIR}/big.ts`]: { lines: THRESHOLD + 1 } })
    try {
      const r = run(root)
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stderr, /grew past their shrink-only line ceiling/)
      assert.match(r.stderr, new RegExp(`big\\.ts \\[lines\\]: baseline ${THRESHOLD + 1}, now ${THRESHOLD + 2}`))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a baselined file AT or UNDER its entry passes', async () => {
    for (const lines of [THRESHOLD + 1, THRESHOLD]) {
      const root = await fixture({ 'big.ts': lines }, { [`${ROUTES_DIR}/big.ts`]: { lines: THRESHOLD + 1 } })
      try {
        const r = run(root)
        assert.equal(r.status, 0, `${lines} lines: ${r.stdout}${r.stderr}`)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  test('a file AT the threshold with no entry passes; one line over with no entry FAILS', async () => {
    const ok = await fixture({ 'new.ts': THRESHOLD }, {})
    try {
      const r = run(ok)
      assert.equal(r.status, 0, r.stdout + r.stderr)
    } finally {
      await rm(ok, { recursive: true, force: true })
    }

    const bad = await fixture({ 'new.ts': THRESHOLD + 1 }, {})
    try {
      const r = run(bad)
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stderr, new RegExp(`new\\.ts \\[lines\\]: baseline 0, now ${THRESHOLD + 1}`))
    } finally {
      await rm(bad, { recursive: true, force: true })
    }
  })

  test('--update LOWERS an entry', async () => {
    const root = await fixture({ 'big.ts': THRESHOLD + 1 }, { [`${ROUTES_DIR}/big.ts`]: { lines: THRESHOLD + 2 } })
    try {
      const r = run(root, '--update')
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.deepEqual(await readBaseline(root), { [`${ROUTES_DIR}/big.ts`]: { lines: THRESHOLD + 1 } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('--update DROPS the entry of a file that fell to the threshold or under', async () => {
    const root = await fixture({ 'big.ts': THRESHOLD }, { [`${ROUTES_DIR}/big.ts`]: { lines: THRESHOLD + 1 } })
    try {
      const r = run(root, '--update')
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.deepEqual(await readBaseline(root), {})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('--update REFUSES to raise an entry, and leaves the baseline untouched', async () => {
    const baseline = { [`${ROUTES_DIR}/big.ts`]: { lines: THRESHOLD + 1 } }
    const root = await fixture({ 'big.ts': THRESHOLD + 2 }, baseline)
    try {
      const r = run(root, '--update')
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stderr, /refuses to RAISE the baseline/)
      assert.deepEqual(await readBaseline(root), baseline)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('--update REFUSES to add an entry for a file over the threshold', async () => {
    const root = await fixture({ 'new.ts': THRESHOLD + 1 }, {})
    try {
      const r = run(root, '--update')
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stderr, /refuses to RAISE the baseline/)
      assert.deepEqual(await readBaseline(root), {})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a routes directory matching no files is REFUSED, and --update writes nothing (#3230)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'route-line-ceiling-'))
    try {
      const baseline = { [`${ROUTES_DIR}/big.ts`]: { lines: THRESHOLD + 1 } }
      await mkdir(join(root, 'packages/backend'), { recursive: true })
      await writeFile(join(root, BASELINE_REL), JSON.stringify(baseline, null, 2) + '\n')
      for (const args of [[], ['--update']]) {
        const r = run(root, ...args)
        assert.equal(r.status, 1, `${args.join(' ') || 'check'}: ${r.stdout}${r.stderr}`)
        assert.match(r.stderr, /matched no source files/)
        assert.deepEqual(await readBaseline(root), baseline, 'the baseline must be untouched')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
