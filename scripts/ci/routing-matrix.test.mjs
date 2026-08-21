// Drives the package-to-job routing matrix (#1623, epic #1621).
//
// Two layers, and the second is the one that keeps this useful over time:
//
//   1. Every row in routing-matrix.mjs is asserted against the classifier, on
//      ALL TEN outputs. Asserting only the flag expected to be true would miss
//      the failure that actually matters — a rule that turns on MORE than it
//      should, quietly running (or skipping) a job nobody looked at.
//
//   2. Meta-tests that the matrix still covers the rules. A characterization
//      table silently stops characterizing the moment someone adds a rule and
//      no fixture exercises it, and nothing about the table's own green tick
//      would tell you. So adding a rule without a row fails here.
//
// Run with: node --test scripts/ci/routing-matrix.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  OUTPUT_NAMES,
  SURFACE_RULES,
  DOC_ONLY_PATTERNS,
  DOC_EXCEPTIONS,
  PROPAGATION_RULES,
  classifyChangedFiles,
  globToRegExp,
} from './change-classifier.mjs'
import { ROUTING_MATRIX, CONTRACT, RETAINED } from './routing-matrix.mjs'

/** Expand a row's true-flag list into the full ten-flag object. */
function expectedOutputs(expect) {
  const outputs = Object.fromEntries(OUTPUT_NAMES.map((name) => [name, false]))
  for (const name of expect) {
    assert.ok(name in outputs, `matrix row names unknown output: ${name}`)
    outputs[name] = true
  }
  return outputs
}

const label = (row) => `${row.kind}: ${row.files.length ? row.files.join(' + ') : '(empty diff)'}`

describe('the routing matrix — all ten outputs per row', () => {
  for (const row of ROUTING_MATRIX) {
    test(label(row), () => {
      assert.deepEqual(
        classifyChangedFiles(row.files),
        expectedOutputs(row.expect),
        `${row.kind} row changed behaviour.\n  Why this row exists: ${row.why}\n` +
          (row.kind === CONTRACT
            ? '  This is a compatibility constraint — something depends on this routing. Do not update the fixture to match new behaviour without arguing the routing change on its own merits.'
            : '  This row is pinned but not endorsed. Changing it may be correct — say so in the PR and update the `why`.'),
      )
    })
  }
})

describe('the matrix stays well-formed', () => {
  test('every row declares a kind and a substantive why', () => {
    for (const row of ROUTING_MATRIX) {
      assert.ok(
        row.kind === CONTRACT || row.kind === RETAINED,
        `row ${label(row)} has no valid kind`,
      )
      // A one-word reason is how "retained" quietly becomes "nobody looked".
      assert.ok(
        typeof row.why === 'string' && row.why.length >= 40,
        `row ${label(row)} needs a real reason, got: ${JSON.stringify(row.why)}`,
      )
      assert.ok(Array.isArray(row.files), `row ${label(row)} has no files array`)
      assert.ok(Array.isArray(row.expect), `row ${label(row)} has no expect array`)
    }
  })

  test('both kinds are represented', () => {
    // If RETAINED ever empties out, the distinction has stopped being used
    // rather than stopped being needed.
    for (const kind of [CONTRACT, RETAINED]) {
      assert.ok(
        ROUTING_MATRIX.some((r) => r.kind === kind),
        `no ${kind} rows — the distinction is no longer being applied`,
      )
    }
  })

  test('no duplicate rows', () => {
    const keys = ROUTING_MATRIX.map((r) => JSON.stringify(r.files))
    assert.equal(new Set(keys).size, keys.length, 'two rows assert the same file list')
  })
})

describe('the matrix covers the rules', () => {
  /** Rows whose file list is a single path — the ones that isolate one rule. */
  const singles = ROUTING_MATRIX.filter((r) => r.files.length === 1).map((r) => r.files[0])

  /** The first SURFACE_RULES entry a path matches, mirroring first-match-wins. */
  const matchingRule = (file) =>
    SURFACE_RULES.find((rule) => rule.patterns.some((p) => globToRegExp(p).test(file)))

  test('every surface rule is exercised by at least one row', () => {
    // Coverage by FIRST match, not by any match: `packages/frontend/*` and
    // `packages/*` both match a frontend file, but only the first one actually
    // decides. Requiring a first-match row is what proves the catch-all arm is
    // reachable at all.
    const uncovered = SURFACE_RULES.filter(
      (rule) => !singles.some((file) => matchingRule(file) === rule),
    ).map((rule) => rule.patterns.join(' | '))

    assert.deepEqual(
      uncovered,
      [],
      'these routing rules have no matrix row that reaches them. Add a fixture to ' +
        'routing-matrix.mjs — an unexercised rule is one nobody would notice breaking.',
    )
  })

  test('every individual pattern matches at least one row', () => {
    // Weaker than first-match on purpose: some patterns are deliberately
    // redundant (AGENTS.md is already covered by *.md) and can never win a
    // first-match race. They should still have a fixture naming them.
    const allPatterns = [
      ...SURFACE_RULES.flatMap((r) => r.patterns),
      ...DOC_ONLY_PATTERNS,
      ...DOC_EXCEPTIONS.flatMap((r) => r.patterns),
    ]
    const everyFile = ROUTING_MATRIX.flatMap((r) => r.files)
    const uncovered = allPatterns.filter(
      (p) => !everyFile.some((file) => globToRegExp(p).test(file)),
    )
    assert.deepEqual(uncovered, [], 'these patterns have no fixture that matches them')
  })

  test('every doc-only pattern and doc exception is exercised', () => {
    for (const pattern of DOC_ONLY_PATTERNS) {
      const hit = ROUTING_MATRIX.some(
        (row) => row.files.some((f) => globToRegExp(pattern).test(f)) && row.expect.length === 0,
      )
      assert.ok(hit, `doc-only pattern ${pattern} has no row asserting it routes nowhere`)
    }
    for (const rule of DOC_EXCEPTIONS) {
      for (const pattern of rule.patterns) {
        const hit = ROUTING_MATRIX.some((row) =>
          row.files.some((f) => globToRegExp(pattern).test(f) && row.expect.length > 0),
        )
        assert.ok(hit, `doc exception ${pattern} has no row asserting what it routes to`)
      }
    }
  })

  test('deleting any propagation rule breaks at least one row', () => {
    // The question worth asking is not "does some row trigger this rule" —
    // every full-matrix row trivially satisfies every propagation rule, since
    // all ten flags are already true there, so that version passes even with
    // the isolating fixtures deleted. The question is whether any fixture would
    // NOTICE the rule going away. So delete it and look for a row that changes.
    //
    // This is what protects #1625's rewrite of the propagation table: a rule it
    // drops or mis-transcribes has to change a row here.
    for (const rule of PROPAGATION_RULES) {
      const without = PROPAGATION_RULES.filter((r) => r !== rule)
      const noticed = ROUTING_MATRIX.filter((row) => {
        const full = classifyChangedFiles(row.files)
        const reduced = classifyChangedFiles(row.files, { propagationRules: without })
        return OUTPUT_NAMES.some((name) => full[name] !== reduced[name])
      })

      assert.ok(
        noticed.length > 0,
        `deleting the propagation rule ${rule.when.join('|')} -> ${rule.then.join(',')} ` +
          'changes no matrix row, so no fixture is actually characterizing it. ' +
          'Add a row whose routing depends on this rule alone.',
      )
    }
  })

  test('every output name appears true in some row and false in some row', () => {
    // A flag that is true in every fixture, or false in every fixture, is not
    // actually being characterized — the matrix would pass with it hardwired.
    for (const name of OUTPUT_NAMES) {
      const results = ROUTING_MATRIX.map((row) => classifyChangedFiles(row.files)[name])
      assert.ok(results.includes(true), `no matrix row ever turns ${name} on`)
      assert.ok(results.includes(false), `no matrix row ever leaves ${name} off`)
    }
  })
})
