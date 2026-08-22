/**
 * #1815 — pin the prose claim "only `dev` or `hotfix/*` may merge into `main`"
 * to what `dev-gate.yml` actually enforces.
 * Run with: node --test scripts/docs/branch-gate-claims.test.mjs
 *
 * WHAT THIS GUARDS, AND WHAT IT DOES NOT. Be precise about this, because a
 * guard whose limits are unstated gets trusted past them.
 *
 * It guards: the *allowed-source set*. `dev-gate.yml` is the only enforcement
 * of which branches may enter `main`, and `branch-and-release-flow.md` is the
 * canonical doc every other release document defers to. Widening the gate (a
 * `release/*` escape hatch, say) or narrowing it (dropping `hotfix/*`) without
 * touching that doc turns the repo's most-linked branch claim into a lie. This
 * test makes that drift a red build naming the mismatch.
 *
 * It does NOT guard the defect that motivated #1815. The README did not state
 * the allowed set incorrectly — it stated a wrong *instruction* ("merge to
 * main") while never mentioning the set at all. Nothing derived from the gate
 * can catch a document that omits the claim. Prose-matching for "merge to
 * main" was considered and rejected: the `dev → main` promotion IS a merge to
 * main, so the phrase is legitimate in most of its occurrences, and a matcher
 * loose enough to catch the bad one flags the good ones. A guard that must be
 * suppressed on its true positives is worse than none — it teaches its own
 * readers to ignore it.
 *
 * So the *instruction* stays protected by review, and this test protects the
 * source of truth those instructions point at. Stated plainly rather than
 * left for someone to discover when it fails to fire.
 *
 * Source text is parsed rather than imported, following network-map-pins /
 * dep-lint / lint-wire-types: YAML shell conditions are not importable, and
 * the point is to read what CI reads.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const GATE = '.github/workflows/dev-gate.yml'
const CANONICAL_DOC = 'docs/contributing/branch-and-release-flow.md'

/**
 * Extract the branch names the gate permits from its bash condition.
 *
 * The condition is a chain of `!=` comparisons joined by `&&` — the branch is
 * REJECTED when it matches none of them, so every literal compared against
 * `$SOURCE` is an allowed source. Parsing the negated form rather than a
 * hand-kept list is the point: a new `&& "$SOURCE" != release/*` clause is
 * picked up with no edit here.
 */
function allowedSourcesFromGate(yaml) {
  const marker = 'if [[ "$SOURCE"'
  const start = yaml.indexOf(marker)
  assert.notEqual(
    start,
    -1,
    `the source-branch condition was not found in ${GATE} — the gate was ` +
      `restructured; re-read it and update this test rather than deleting it`,
  )
  const condition = yaml.slice(start, yaml.indexOf('\n', yaml.indexOf('then', start)))

  // Matches both quoted literals ("dev") and bare globs (hotfix/*).
  const allowed = [...condition.matchAll(/!=\s*"?([A-Za-z0-9_./*-]+?)"?\s*(?:&&|\]\])/g)].map(
    (m) => m[1],
  )

  assert.ok(
    allowed.length > 0,
    `parsed zero allowed branches out of ${GATE}'s condition. This test would ` +
      `then pass by comparing two empty sets, so it fails instead. Condition ` +
      `read: ${condition}`,
  )
  return allowed
}

test('dev-gate permits exactly the branches the canonical doc claims', () => {
  const allowed = allowedSourcesFromGate(read(GATE))
  const doc = read(CANONICAL_DOC)

  for (const branch of allowed) {
    assert.ok(
      doc.includes(`\`${branch}\``),
      `${GATE} lets \`${branch}\` merge into \`main\`, but ${CANONICAL_DOC} ` +
        `never names it. Every other release doc defers to that file, so an ` +
        `unlisted allowed branch is invisible to the whole repo. Add it to ` +
        `the branch table and the dev-gate sentence.`,
    )
  }

  // The reverse direction: the doc must not advertise a path the gate refuses.
  //
  // Anchored on the two ends of the claim rather than on sentence punctuation.
  // A `[^.;]*` span looked right and captured nothing, because the very first
  // `.` it hits is inside `.github/workflows/dev-gate.yml` — and an empty
  // capture compared against a non-empty set fails loudly, which is the only
  // reason that bug surfaced here instead of shipping as a vacuous pass.
  const OPEN = 'The `dev-gate` workflow'
  const CLOSE = 'merge into `main`'
  const from = doc.indexOf(OPEN)
  const to = doc.indexOf(CLOSE, from)
  assert.ok(
    from !== -1 && to !== -1,
    `${CANONICAL_DOC} no longer contains the "${OPEN} … ${CLOSE}" claim this ` +
      `test pins. If it was reworded, re-point the test; if it was deleted, ` +
      `the canonical claim is gone and that is the bug.`,
  )

  // Everything backticked between those anchors, minus the two tokens that are
  // the workflow's own name and path rather than branches.
  const namedInClaim = [...doc.slice(from, to).matchAll(/`([A-Za-z0-9_./*-]+)`/g)]
    .map((m) => m[1])
    .filter((n) => n !== '.github/workflows/dev-gate.yml' && n !== 'dev-gate')

  assert.deepEqual(
    namedInClaim.sort(),
    [...allowed].sort(),
    `the branches named in ${CANONICAL_DOC}'s dev-gate sentence do not match ` +
      `what ${GATE} enforces. Gate allows: ${allowed.join(', ')}. Doc claims: ` +
      `${namedInClaim.join(', ')}.`,
  )
})
