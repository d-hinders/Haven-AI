// The money-path classifier refuses an EMPTY change instead of answering it.
//
// With nothing committed since the merge base it used to print
// "0 of 0 on the perimeter => not money-path" and exit 0. On #3221 that zero
// was produced for a PR whose diff touched `routes/x402.ts` (a named runtime
// glob): the change was uncommitted, and a three-dot diff never sees the
// working tree. These tests drive the real script against a throwaway git
// repository and assert on what it DID — exit code and stream — so the
// refusal is proven to fire and proven not to fire when there is a change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./money-path-classify.mjs', import.meta.url))

// Inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE, … — set when tests run from
// inside a git hook) would point every git call below at the HOST repository.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))

function repo(made) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mp-classify-'))
  made.push(dir)
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV })
  git('init', '-q', '-b', 'base')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git('add', '.')
  git('commit', '-q', '-m', 'seed')
  git('checkout', '-q', '-b', 'feature')
  return { dir, git }
}

function run(dir) {
  return spawnSync('node', [SCRIPT, 'base'], { cwd: dir, encoding: 'utf8', env: ENV })
}

test('an empty change with a DIRTY tree is refused with exit 2 and names the cause', () => {
  const made = []
  try {
    const { dir } = repo(made)
    mkdirSync(path.join(dir, 'packages/backend/src/routes'), { recursive: true })
    writeFileSync(path.join(dir, 'packages/backend/src/routes/x402.ts'), 'export {}\n')
    const r = run(dir)
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /Nothing to classify/)
    assert.match(r.stderr, /uncommitted changes/)
    // The refusal must not ALSO print a verdict a reader could take as one.
    assert.doesNotMatch(r.stdout, /not money-path/)
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true })
  }
})

test('an empty change with a CLEAN tree is refused with exit 2 and says so', () => {
  const made = []
  try {
    const { dir } = repo(made)
    const r = run(dir)
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /working tree is clean too/)
    assert.doesNotMatch(r.stdout, /not money-path|=> MONEY-PATH/)
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true })
  }
})

test('control: a COMMITTED money-path change is classified, exit 0, not refused', () => {
  const made = []
  try {
    const { dir, git } = repo(made)
    mkdirSync(path.join(dir, 'packages/backend/src/routes'), { recursive: true })
    writeFileSync(path.join(dir, 'packages/backend/src/routes/x402.ts'), 'export {}\n')
    git('add', '.')
    git('commit', '-q', '-m', 'change')
    const r = run(dir)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stderr, /Nothing to classify/)
    assert.match(r.stdout, /1 runtime-glob \+ 0 control-glob = 1 of 1 on the perimeter/)
    assert.match(r.stdout, /=> MONEY-PATH\./)
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true })
  }
})

test('a committed diff beside a dirty tree is classified AND warns that the dirty part was not', () => {
  const made = []
  try {
    const { dir, git } = repo(made)
    writeFileSync(path.join(dir, 'README.md'), 'changed\n')
    git('add', '.')
    git('commit', '-q', '-m', 'docs')
    mkdirSync(path.join(dir, 'packages/backend/src/routes'), { recursive: true })
    writeFileSync(path.join(dir, 'packages/backend/src/routes/x402.ts'), 'export {}\n')
    const r = run(dir)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /0 of 1 on the perimeter/)
    assert.match(r.stderr, /uncommitted path\(s\) in the working tree are NOT classified/)
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true })
  }
})
