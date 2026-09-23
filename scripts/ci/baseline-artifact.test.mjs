// Tests for the before/after artifact of rewritten baselines (#3234).
//
// The IO half is driven through the real entry point in a throwaway git repo
// whose HEAD holds the "before" bytes and whose working tree holds the
// regenerated "after" bytes — the exact state the workflow step runs in,
// between the audit and the commit. A stub `compare` on PATH stands in for
// ImageMagick, which the GitHub runner has and a laptop may not.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMovedWithPaths, plan, renderManifest } from './baseline-artifact.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'baseline-artifact.mjs')
const DIR = 'packages/frontend/e2e/__screenshots__/x.visual.spec.ts'

function repo({ devVersion = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-artifact-'))
  const g = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-C', root, ...args], { encoding: 'utf8' })
  g('init', '-q')
  g('config', 'user.email', 't@example.invalid')
  g('config', 'user.name', 't')
  fs.mkdirSync(path.join(root, DIR), { recursive: true })
  fs.writeFileSync(path.join(root, DIR, 'moved.png'), 'BEFORE-BYTES')
  fs.writeFileSync(path.join(root, DIR, 'gone.png'), 'GONE-BYTES')
  g('add', '-A')
  g('commit', '-q', '-m', 'fixture')
  if (devVersion !== null) {
    // origin/dev holds a different version of the baseline (the branch had
    // already moved it once); the remote is this repo itself.
    const branch = g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()
    g('checkout', '-q', '-b', 'dev')
    fs.writeFileSync(path.join(root, DIR, 'moved.png'), devVersion)
    g('commit', '-q', '-am', 'dev moved it')
    g('checkout', '-q', branch)
    g('remote', 'add', 'origin', root)
  }
  // The regeneration: one rewritten, one new, one deleted.
  fs.writeFileSync(path.join(root, DIR, 'moved.png'), 'AFTER-BYTES')
  fs.writeFileSync(path.join(root, DIR, 'new.png'), 'NEW-BYTES')
  fs.rmSync(path.join(root, DIR, 'gone.png'))
  // A stand-in `compare`: writes the diff path it was given and exits 1,
  // which is what ImageMagick does when the images differ.
  fs.mkdirSync(path.join(root, 'bin'))
  fs.writeFileSync(
    path.join(root, 'bin', 'compare'),
    `#!${process.execPath}\nconst a=process.argv.slice(2); if (a[0]==='-version') process.exit(0); require('fs').writeFileSync(a[a.length-1],'DIFF'); process.exit(1)\n`,
  )
  fs.chmodSync(path.join(root, 'bin', 'compare'), 0o755)
  return root
}

function run(root, moved, { withCompare = true } = {}) {
  const out = path.join(root, 'out')
  const summary = path.join(root, 'summary.md')
  const output = path.join(root, 'output.txt')
  const env = {
    ...process.env,
    MOVED_BASELINES: moved,
    OUT_DIR: out,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_OUTPUT: output,
    PATH: withCompare ? `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` : '/usr/bin:/bin',
  }
  const res = spawnSync(process.execPath, [SCRIPT], { cwd: root, env, encoding: 'utf8' })
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)
  return { res, out, read, output: read(output) ?? '', summary: read(summary) ?? '' }
}

const MOVED = JSON.stringify([
  { name: 'moved.png', path: `${DIR}/moved.png`, status: 'modified' },
  { name: 'new.png', path: `${DIR}/new.png`, status: 'added' },
  { name: 'gone.png', path: `${DIR}/gone.png`, status: 'deleted' },
])

describe('baseline-artifact — pure layer', () => {
  test('parseMovedWithPaths keeps PNG entries with a path and refuses non-lists as null', () => {
    assert.deepEqual(parseMovedWithPaths('[{"name":"a.png","path":"p/a.png","status":"modified"},{"name":"b"}]'), [
      { name: 'a.png', path: 'p/a.png', status: 'modified' },
    ])
    for (const raw of [undefined, '', 'nope', '{}']) assert.equal(parseMovedWithPaths(raw), null)
  })

  test('plan gives an added baseline no before and a deleted one no after', () => {
    const p = plan(JSON.parse(MOVED))
    assert.deepEqual(p.map((e) => [e.status, e.before, e.after]), [
      ['modified', true, true],
      ['added', false, true],
      ['deleted', true, false],
    ])
  })

  test('the manifest reminds the reader that regenerated is not reviewed', () => {
    assert.match(renderManifest(plan(JSON.parse(MOVED))), /Regenerated is not reviewed/)
    assert.match(renderManifest([]), /No baseline was rewritten/)
  })
})

describe('baseline-artifact — the real entry point (#3234)', () => {
  test('MUTATION PROOF: before is the branch tip (HEAD), after is the regenerated file on disk', () => {
    const root = repo()
    const { res, out, read, output, summary } = run(root, MOVED)
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.equal(read(path.join(out, 'before', DIR, 'moved.png')), 'BEFORE-BYTES')
    assert.equal(read(path.join(out, 'after', DIR, 'moved.png')), 'AFTER-BYTES')
    // Added: after only. Deleted: before only — read from HEAD, since the file is gone from disk.
    assert.equal(read(path.join(out, 'before', DIR, 'new.png')), null)
    assert.equal(read(path.join(out, 'after', DIR, 'new.png')), 'NEW-BYTES')
    assert.equal(read(path.join(out, 'before', DIR, 'gone.png')), 'GONE-BYTES')
    assert.equal(read(path.join(out, 'after', DIR, 'gone.png')), null)
    // A diff only where both sides exist.
    assert.equal(read(path.join(out, 'diff', DIR, 'moved.png')), 'DIFF')
    assert.equal(read(path.join(out, 'diff', DIR, 'new.png')), null)
    assert.match(output, /^count=3$/m)
    assert.match(output, new RegExp(`^dir=${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.match(summary, /Before\/after images for 3 rewritten baseline/)
    assert.match(read(path.join(out, 'README.md')) ?? '', /\| `moved\.png` \| modified \| yes \| yes \|/)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('dev\'s version is included as base only when it differs from the branch tip', () => {
    const root = repo({ devVersion: 'DEV-BYTES' })
    const { res, out, read } = run(root, MOVED)
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.equal(read(path.join(out, 'base', DIR, 'moved.png')), 'DEV-BYTES')
    // gone.png is identical on dev and HEAD: no base copy.
    assert.equal(read(path.join(out, 'base', DIR, 'gone.png')), null)
    assert.match(read(path.join(out, 'README.md')) ?? '', /\| `moved\.png` \| modified \| yes \| yes \| differs, included \|/)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('without `compare` on the runner it still collects the pairs and says there is no diff', () => {
    const root = repo()
    const { res, out, read } = run(root, MOVED, { withCompare: false })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, /`compare` is not on this runner/)
    assert.equal(read(path.join(out, 'after', DIR, 'moved.png')), 'AFTER-BYTES')
    assert.equal(read(path.join(out, 'diff', DIR, 'moved.png')), null)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('a run that rewrote nothing collects nothing and says so', () => {
    const root = repo()
    const { res, out, output } = run(root, '[]')
    assert.equal(res.status, 0)
    assert.match(res.stdout, /No baseline was rewritten/)
    assert.match(output, /^count=0$/m)
    assert.equal(fs.existsSync(out), false)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('an unreadable moved list warns and collects nothing — it does not fail the run', () => {
    const root = repo()
    const { res, output } = run(root, '')
    assert.equal(res.status, 0)
    assert.match(res.stdout, /::warning::The audit step wrote no readable `moved` list/)
    assert.match(output, /^count=0$/m)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
