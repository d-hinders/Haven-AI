// Guards `.github/labels.yml` against the limits the GitHub Labels API enforces
// at sync time rather than at review time (#2276 follow-up).
//
// Why this exists, precisely: `operator-verify` was added in #2276 with a
// 113-character description. Every check on that pull request was green,
// because nothing in CI reads this file — the only consumer is the *Sync
// labels* workflow, which runs on `dev` AFTER the merge. It failed there with
//
//   Cannot create "operator-verify" label: Validation Failed:
//   description is too long (maximum is 100 characters)
//
// so the label was never created and the guard that PR shipped was left with
// its PRIMARY signal inert — the label-based control it documents could not
// fire, because there was no label. The self-contradiction backstop still
// worked, which is exactly why nobody would have noticed.
//
// The same failure had already been running silently: `money-path`'s
// description was 101 characters, so every sync since it was lengthened had
// been failing to UPDATE it. The label existed (created earlier, when the
// description was shorter), so the only symptom was a red run nobody read.
//
// The lesson is the repo's usual one — a file whose only validator runs after
// the merge has no validator as far as a pull request is concerned. This test
// moves GitHub's limit to where the change is reviewed.
//
// Run with: node --test scripts/ci/labels-yml.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LABELS_YML = fileURLToPath(new URL('../../.github/labels.yml', import.meta.url))

// https://docs.github.com/rest/issues/labels — the API rejects longer.
const MAX_DESCRIPTION_CHARS = 100

/**
 * Parse the `- name: / color: / description:` triples.
 *
 * Deliberately not a YAML dependency: `scripts/ci/` runs on bare node with no
 * install step.
 *
 * Quote-agnostic on purpose. The first version of this parser matched only
 * double-quoted scalars, because that is what the file happens to use today —
 * and `haven-reviewer` broke it by appending a single-quoted label with a
 * 150-character description, which `readLabels()` skipped entirely and the
 * suite passed. Single quotes are valid YAML and the labeler action accepts
 * them, so that was this guard carrying the very defect it exists to catch:
 * a too-long description reaching *Sync labels* unseen. The convention is a
 * property of today's content, not of the format, and a guard may not depend
 * on one silently.
 */
function readLabels() {
  const lines = readFileSync(LABELS_YML, 'utf8').split('\n')
  const labels = []
  for (const line of lines) {
    const name = /^- name:\s*(["'])(.*)\1\s*$/.exec(line)
    if (name) {
      labels.push({ name: name[2], description: null })
      continue
    }
    const description = /^\s+description:\s*(["'])(.*)\1\s*$/.exec(line)
    if (description && labels.length > 0) {
      labels[labels.length - 1].description = description[2]
    }
  }
  return labels
}

/** Every list entry in the file, however it is quoted — the parser's own control. */
function countRawEntries() {
  return readFileSync(LABELS_YML, 'utf8')
    .split('\n')
    .filter((line) => /^- name:/.test(line)).length
}

describe('.github/labels.yml (#2276 follow-up)', () => {
  // Meta-test first. Every assertion below is a filter over `readLabels()`, so
  // a parser that silently returns [] would make all of them pass — the exact
  // shape of unfalsifiable guard #2307 removed 56 of. Pin the parse itself.
  test('the parser reads EVERY entry in the file', () => {
    const labels = readLabels()
    assert.ok(labels.length >= 5, `expected to parse several labels, got ${labels.length}`)
    assert.ok(
      labels.some((l) => l.name === 'money-path'),
      'money-path not parsed — the regexes no longer match the file shape',
    )
    // The load-bearing one. `>= 5` would still hold if a NEW entry were
    // skipped, and every assertion below is a filter over what was parsed —
    // so an entry the parser cannot see is an entry with no guard at all.
    // Pin the parsed count to the raw count instead of a floor.
    assert.equal(
      labels.length,
      countRawEntries(),
      'a label in the file was not parsed — it is silently exempt from every check below',
    )
    const missing = labels.filter((l) => l.description === null).map((l) => l.name)
    assert.deepEqual(missing, [], `label(s) parsed with no description: ${missing.join(', ')}`)
  })

  test(`no description exceeds GitHub's ${MAX_DESCRIPTION_CHARS}-character limit`, () => {
    const tooLong = readLabels()
      .filter((l) => (l.description ?? '').length > MAX_DESCRIPTION_CHARS)
      .map((l) => `${l.name} (${l.description.length} chars)`)
    assert.deepEqual(
      tooLong,
      [],
      `Sync labels will FAIL on these after the merge, and the label will not be ` +
        `created or updated:\n  ${tooLong.join('\n  ')}`,
    )
  })

  test('names are unique', () => {
    const names = readLabels().map((l) => l.name)
    assert.equal(new Set(names).size, names.length, `duplicate label name in ${names.join(', ')}`)
  })
})
