// Unit tests for the shared ratcheting engine (#2759).
//
// This module had NO test file of its own until now, which is part of why it
// drifted: six gates import it, each gate's suite exercises the paths that gate
// happens to take, and nothing tested the engine's own contract. #2728 found a
// missing `--update` refusal in two of the six; #2747 found a seventh gate that
// had cloned the engine rather than importing it; #2759 is the defect below.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newViolations, hasShrunk, assertUsableBaseline, readBaseline } from './ratchet.mjs'

// `fileURLToPath`, not `.pathname`: the latter percent-encodes, so a checkout
// under a path containing a space (or `#`, or `%`) makes `git -C` fail with
// "cannot change to '.../space%20check/'". Measured. Every other REPO_ROOT in
// scripts/ already uses `fileURLToPath`; this was the one exception.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// ── The defect: a non-numeric count silently allows everything ──────────────

test('newViolations: a non-numeric `allowed` compares FALSE, which is why the read boundary refuses it', () => {
  // Not a test of desired behaviour — a test of the reason `assertUsableBaseline`
  // exists. `1 > 'x'` is false in JavaScript, so an entry whose value is a
  // string disables itself and the gate reports a clean bill of health over a
  // live violation. Pinning it here means anyone who later "fixes" the
  // comparison instead has to confront this file.
  assert.deepEqual(newViolations({ 'a.md': { r: 1 } }, { 'a.md': { r: 'x' } }), [])
  assert.equal(hasShrunk({ 'a.md': { r: 1 } }, { 'a.md': { r: 'x' } }), false)
  // And with a real number it is caught, which is the control: without this the
  // assertion above also passes against an engine that never reports anything.
  assert.equal(newViolations({ 'a.md': { r: 1 } }, { 'a.md': { r: 0 } }).length, 1)
})

test('assertUsableBaseline: accepts an empty baseline and a well-formed one', () => {
  // The accept path first. A validator that refuses everything satisfies every
  // refusal test below and breaks all six gates.
  assert.deepEqual(assertUsableBaseline({}), {})
  const good = { 'a.md': { r: 0 }, 'b.md': { r: 12 } }
  assert.equal(assertUsableBaseline(good), good)
})

test('assertUsableBaseline: refuses the shapes `JSON.parse` accepts but the engine cannot use', () => {
  for (const bad of [null, [], 'x', 3, true]) {
    assert.throws(() => assertUsableBaseline(bad, 'b.json'), /expected a JSON object/)
  }
})

test('assertUsableBaseline: refuses a per-file entry that is not a key→count map', () => {
  for (const bad of [null, [1], 'x', 7]) {
    assert.throws(() => assertUsableBaseline({ 'a.md': bad }, 'b.json'), /should map keys to counts/)
  }
})

test('assertUsableBaseline: refuses a non-numeric count, naming file and key', () => {
  assert.throws(
    () => assertUsableBaseline({ 'a.md': { 'my-rule': 'x' } }, 'b.json'),
    /b\.json: "a\.md" \[my-rule\] is "x", not a number/,
  )
  // The diagnosis has to say WHICH file: a message naming only the key sends
  // the reader through six baselines to find it.
  assert.throws(() => assertUsableBaseline({ 'a.md': { r: null } }), /"a\.md" \[r\] is null/)
})

test('assertUsableBaseline: NaN and Infinity are reported as themselves', () => {
  // `JSON.stringify(NaN)` is the string "null", so the obvious message would
  // report a NaN entry as null and send the reader looking for the wrong value.
  assert.throws(() => assertUsableBaseline({ 'a.md': { r: NaN } }), /is NaN, not a number/)
  // Infinity too: EVERY non-finite number stringifies to "null", not just NaN.
  // The first version special-cased NaN alone, so a baseline containing `1e400`
  // reported as null and sent the reader after a JSON null not in the file.
  assert.throws(() => assertUsableBaseline({ 'a.md': { r: Infinity } }), /is Infinity, not a number/)
  assert.throws(() => assertUsableBaseline({ 'a.md': { r: -Infinity } }), /is -Infinity, not a number/)
  // And a string still keeps its quotes, which is how a reader tells `"3"` from
  // `3` in the message — the naive fix for the above dropped them.
  assert.throws(() => assertUsableBaseline({ 'a.md': { r: '3' } }), /is "3", not a number/)
})

test('assertUsableBaseline: a negative or fractional count is ALLOWED through', () => {
  // Deliberately in scope for the comparison, not for the validator: `count >
  // -1` and `count > 0.5` are meaningful comparisons, and refusing them would
  // be a second, unstated rule. Recorded so the omission reads as a decision.
  assert.doesNotThrow(() => assertUsableBaseline({ 'a.md': { r: -1 } }))
  assert.doesNotThrow(() => assertUsableBaseline({ 'a.md': { r: 0.5 } }))
})

// ── The gate count, derived rather than written ────────────────────────────

test('the importer count in the comments matches the real importer list', () => {
  // #2759. The engine's header, its `updateRefusals` docstring,
  // `lint-wire-types.mjs`, `frontend-copy-lint.test.mjs` and the routing-matrix
  // row ALL carried a hand-written "FIVE gates" for a week after #2747 added
  // the sixth. Five copies of one number is five chances to be wrong, and the
  // repo already made this argument once, about `docs:check`'s validator count
  // (#2666: derive it, do not write it).
  //
  // A comment cannot compute, so the number stays written — but it stops being
  // unchecked. Add or remove a gate and this reddens, naming the drift.
  //
  // What it does NOT catch, said rather than implied (review): the grep matches
  // a COMMENTED-OUT import, so a gate that stops importing while leaving the
  // line behind still counts; the `*.mjs` pathspec makes a future `.ts`/`.js`
  // gate invisible; and `git grep` sees TRACKED files only, so an unstaged new
  // gate is invisible locally though not in CI. Each is a narrower hole than
  // the hand-written number this replaces, and none is worth a parser here.
  // `git grep` exits 1 on zero matches, which would surface a total-loss
  // regression as an opaque execFileSync error instead of this test's own
  // assertion. Catch it and let the deepEqual below do the reporting.
  let out = ''
  try {
    out = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'grep', '-l', '--', "from '.*lib/ratchet.mjs'", '--', '*.mjs'],
      { encoding: 'utf-8' },
    )
  } catch (err) {
    if (err.status !== 1) throw err
  }
  const importers = out
    .trim()
    .split('\n')
    .filter((f) => f && !f.endsWith('.test.mjs') && !f.endsWith('lib/ratchet.mjs'))
    .sort()

  assert.deepEqual(importers, [
    'packages/frontend/scripts/design-lint.mjs',
    'scripts/db-mock-ratchet.mjs',
    'scripts/docs/ui-gate-wording.mjs',
    'scripts/frontend-copy-lint.mjs',
    'scripts/lint-wire-types.mjs',
    'scripts/retired-rail-prose-ratchet.mjs',
  ])
  // The count the prose claims, in one place, next to the list that proves it.
  assert.equal(importers.length, 6, 'the comments say SIX gates import this engine')
})

// ── The two guards #2759's own review found untested ────────────────────────

test('refusal(): a malformed baseline throws WITHOUT frames, a real bug keeps them', () => {
  // Review measured that deleting the `err.stack` replacement reddened 0 of
  // 522 tests. A guard nothing observes is the defect this engine's own history
  // is made of, so both halves are pinned here.
  //
  // Half one: the refusal is presented as a refusal. Its stack is exactly the
  // message, so the four gates with no entrypoint catch print that line rather
  // than a `node:internal` dump whose frames all sit inside this module.
  let thrown
  try {
    assertUsableBaseline({ 'a.md': { r: 'x' } }, 'b.json')
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown instanceof TypeError, 'still a TypeError, so existing handling is unchanged')
  assert.equal(thrown.stack, `TypeError: ${thrown.message}`)
  assert.doesNotMatch(thrown.stack, /at assertUsableBaseline/)

  // Half two, and the one that makes the trick defensible: a genuine BUG in
  // this module is not a refusal and must keep its frames. Without this, the
  // helper could be widened to swallow everything and nothing would notice.
  assert.throws(
    () => assertUsableBaseline({ get bad() { throw new ReferenceError('boom') } }),
    (err) => err instanceof ReferenceError && /at /.test(err.stack),
  )
})

test('readBaseline validates too — the second read path', () => {
  // No gate calls `readBaseline` today, which is exactly why review flagged the
  // validation added to it as unproven: reverting it reddened 0 of 522, because
  // the hole would sit in a function no current caller touches. That is the
  // same argument the PR used to justify validating it, applied to the guard
  // itself.
  const dir = mkdtempSync(join(tmpdir(), 'ratchet-read-'))
  try {
    const file = join(dir, 'baseline.json')
    writeFileSync(file, JSON.stringify({ 'a.md': { r: 'x' } }))
    assert.throws(() => readBaseline(file), /\[r\] is "x", not a number/)

    writeFileSync(file, JSON.stringify({ 'a.md': { r: 2 } }))
    assert.deepEqual(readBaseline(file), { 'a.md': { r: 2 } })
    // And an absent file is still {} rather than a refusal.
    assert.deepEqual(readBaseline(join(dir, 'missing.json')), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
