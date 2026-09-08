// Unit tests for the shared ratcheting engine (#2759).
//
// This module had NO test file of its own until now, which is part of why it
// drifted: six gates import it, each gate's suite exercises the paths that gate
// happens to take, and nothing tested the engine's own contract. #2728 found a
// missing `--update` refusal in two of the six; #2747 found a seventh gate that
// had cloned the engine rather than importing it; #2759 is the defect below.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newViolations, hasShrunk, assertUsableBaseline } from './ratchet.mjs'

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
  assert.throws(() => assertUsableBaseline({ 'a.md': { r: Infinity } }), /is null, not a number/)
})

test('assertUsableBaseline: a negative or fractional count is ALLOWED through', () => {
  // Deliberately in scope for the comparison, not for the validator: `count >
  // -1` and `count > 0.5` are meaningful comparisons, and refusing them would
  // be a second, unstated rule. Recorded so the omission reads as a decision.
  assert.doesNotThrow(() => assertUsableBaseline({ 'a.md': { r: -1 } }))
  assert.doesNotThrow(() => assertUsableBaseline({ 'a.md': { r: 0.5 } }))
})
