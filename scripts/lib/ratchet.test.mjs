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
import { newViolations, hasShrunk, assertUsableBaseline, readBaseline, runGate } from './ratchet.mjs'

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
  // row ALL carried a hand-written "FIVE gates" for 46 minutes after #2747
  // added the sixth (20:12 to 20:58; the wording itself dates from #2728 at
  // 17:46, so ~3h for the sites that predate it). An earlier draft said "a
  // week" — a duration nobody had measured, asserted inside the argument
  // against unmeasured figures, and it survived the commit that claimed to
  // have corrected it in both places because the edit had no assertion behind
  // it. Five copies of one number is five chances to be wrong, and the
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
  // than a dump whose frames all sit inside this module. Node's own framing
  // (`triggerUncaughtException`, the version footer) is still there — measured,
  // and an earlier draft of this comment said it was not. Removing that
  // framing needs an entrypoint catch, which is #2761.
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

// ── runGate: a refusal and a bug want opposite treatment (#2761) ────────────

test('runGate: a frameless refusal prints one line; a bug keeps its frames', async () => {
  // Driven through the real gates below as processes; this pins the DECISION,
  // which is made on evidence (does the error carry stack frames?) rather than
  // on a flag a caller could forget to set.
  const seen = []
  const origErr = console.error
  const origExit = process.exit
  console.error = (...a) => seen.push(a)
  process.exit = () => {}
  try {
    // A refusal: `refusal()` strips the stack because its frames point inside
    // the engine and tell the operator nothing.
    runGate('g', () => {
      throw assertRefusal()
    })
    await new Promise((r) => setImmediate(r))
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], ['✗ g: boom'])

    // A bug: the frames ARE the diagnosis, so the whole error goes out and the
    // wording says `failed` rather than naming a condition.
    seen.length = 0
    runGate('g', () => {
      throw new ReferenceError('nope')
    })
    await new Promise((r) => setImmediate(r))
    assert.equal(seen.length, 1)
    assert.equal(seen[0][0], '✗ g failed:')
    assert.ok(seen[0][1] instanceof ReferenceError)
  } finally {
    console.error = origErr
    process.exit = origExit
  }
})

test('runGate: a SYNCHRONOUS throw is caught — design-lint has no async main', async () => {
  // `main().catch(...)` would let a sync throw escape before any handler
  // existed, which is why this uses `Promise.resolve().then(main)`. design-lint
  // is the gate that makes this not hypothetical: its `main` is synchronous.
  //
  // The await before the restore is not incidental: the handler runs on a
  // microtask, so restoring in a bare `finally` hands the real `process.exit`
  // back BEFORE it fires and kills the test run. Measured — that is exactly
  // what a first version of this test did.
  const origErr = console.error
  const origExit = process.exit
  const seen = []
  let exited
  console.error = (...a) => seen.push(a)
  process.exit = (c) => {
    exited = c
  }
  try {
    assert.doesNotThrow(() =>
      runGate('g', () => {
        throw new Error('sync')
      }),
    )
    assert.equal(exited, undefined, 'nothing has exited yet — the handler is deferred')
    await new Promise((r) => setImmediate(r))
    assert.equal(exited, 1, 'and then it does')
    assert.equal(seen[0][0], '✗ g failed:')
  } finally {
    console.error = origErr
    process.exit = origExit
  }
})

/** A frameless error of the shape `refusal()` produces. */
function assertRefusal() {
  const err = new TypeError('boom')
  err.stack = 'TypeError: boom'
  return err
}

test('runGate: a one-argument call THROWS rather than silently succeeding', () => {
  // #2761 review, blocking. `runGate(main)` is the call the issue's own text
  // proposes, and `.then(main)` accepted the non-callable, passed the value
  // through, and exited 0 having never entered the gate — a blocking CI job
  // that is a silent no-op reporting success.
  assert.throws(() => runGate(() => {}), /did not pass a function/)
  assert.throws(() => runGate('g', undefined), /`g` did not pass a function/)
  assert.throws(() => runGate('g', 'not a function'), /did not pass a function/)
})

test('runGate: an fs errno is an operator condition, not a crash', async () => {
  // EACCES carries frames, so the frames heuristic alone filed the most
  // operator-facing condition in #2761's acceptance criteria as a bug —
  // `failed:` plus three frames and an errno dump. It is a fact about the
  // environment rather than a defect in this code.
  const seen = []
  const origErr = console.error
  const origExit = process.exit
  console.error = (...a) => seen.push(a)
  process.exit = () => {}
  try {
    const err = new Error("EACCES: permission denied, open '/x/baseline.json'")
    err.code = 'EACCES'
    runGate('g', () => {
      throw err
    })
    await new Promise((r) => setImmediate(r))
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], ["✗ g: EACCES: permission denied, open '/x/baseline.json'"])
    // A bug that happens to carry a `code` is still a bug: the classification
    // is by errno VALUE, not by the presence of the field.
    seen.length = 0
    const bug = new ReferenceError('nope')
    bug.code = 'ERR_SOMETHING_ELSE'
    runGate('g', () => {
      throw bug
    })
    await new Promise((r) => setImmediate(r))
    assert.equal(seen[0][0], '✗ g failed:')
  } finally {
    console.error = origErr
    process.exit = origExit
  }
})
