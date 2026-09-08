// Shared ratcheting-baseline engine for the lint gates (code review 2026-07-13).
//
// design-lint (#855) and copy-lint (#902) each carried a near line-for-line
// copy of the same ratchet: a committed baseline of existing debt
// (file → key → count) that may only SHRINK — new occurrences, or growth of
// an existing count, fail. This module is the single implementation; a further
// ratcheting gate should import it rather than clone either script. There are
// FIVE as of #2728 — design-lint, copy-lint, the wire-type ratchet, the
// db-mock ratchet and the retired-rail prose ratchet — and the two that had
// cloned instead of imported were the two missing a `--update` refusal.
//
// The `key` dimension is whatever the gate counts per file: a rule id for
// design-lint, a banned phrase for copy-lint.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/**
 * Compare scanned counts ({file: {key: n}}) against the baseline (same
 * shape). Returns [{file, key, count, allowed}] for every count that EXCEEDS
 * what the baseline allows — a new occurrence, or growth of an existing one.
 * Equal/shrunk/removed counts pass. The baseline is per-file: the same key
 * newly appearing in a different file is NOT grandfathered.
 */
export function newViolations(counts, baseline) {
  const failures = []
  for (const [file, keys] of Object.entries(counts)) {
    for (const [key, count] of Object.entries(keys)) {
      const allowed = baseline[file]?.[key] ?? 0
      if (count > allowed) failures.push({ file, key, count, allowed })
    }
  }
  return failures
}

/** True when any baselined count is higher than what the tree now has — the
 *  signal to tighten the ratchet with --update. */
export function hasShrunk(counts, baseline) {
  for (const [file, keys] of Object.entries(baseline)) {
    for (const [key, allowed] of Object.entries(keys)) {
      if ((counts[file]?.[key] ?? 0) < allowed) return true
    }
  }
  return false
}

/** Write the baseline deterministically (files and keys sorted) so diffs stay
 *  reviewable. Returns the serialized string (also written to path). */
export function writeBaseline(path, counts) {
  const sorted = Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((f) => [f, Object.fromEntries(Object.entries(counts[f]).sort())]),
  )
  const json = JSON.stringify(sorted, null, 2) + '\n'
  writeFileSync(path, json)
  return json
}

/**
 * The `--update` guard, as a pure function so it can be tested rather than
 * only read: an update may TIGHTEN the baseline, never raise it. Returns the
 * violations that block the write ([] when the write is allowed).
 *
 * `firstRun` -- and NOT "the baseline is empty" -- is what opens the one
 * allowance, because those are different states and conflating them disables
 * the guard permanently (#2728, found by review). `writeBaseline` PRODUCES
 * `{}` whenever a gate reaches zero debt, so a gate keyed on emptiness is one
 * successful cleanup away from accepting anything forever -- and the cleanup
 * is the step every one of these gates tells you to run. It is not
 * hypothetical: `packages/frontend/design-lint-baseline.json` is `{}` today.
 * The allowance now means the baseline FILE does not exist yet, which is the
 * state it was always meant to describe. Use `loadBaseline()` to get both.
 *
 * This lives here rather than in one gate because `--update` is the command a
 * gate's own failure message sends you to, so a gate that omits the check
 * turns its remedy into a laundering step. Of the five gates on this module,
 * three had a line-for-line copy of this decision and TWO had none at all
 * (`frontend-copy-lint`, the subject of #2728, and `design-lint`, which review
 * found by reading the importer list rather than the issue) -- exactly the
 * duplication this module's header says it exists to prevent.
 */
export function updateRefusals(counts, baseline, { firstRun = false } = {}) {
  if (firstRun) return []
  return newViolations(counts, baseline)
}

/**
 * Read a baseline and say whether the file existed. The pair matters: `{}` is
 * both what an absent file reads as and what a fully-cleaned gate writes, and
 * only one of those may accept growth. See `updateRefusals`.
 */
/**
 * Refuse a baseline the comparison cannot use, at the READ boundary rather than
 * in the comparison (#2759).
 *
 * `newViolations` does `count > allowed`, and `1 > "x"` is `false`. So an entry
 * whose value is a string, null, an array or an object silently disables
 * itself: the gate reports a clean bill of health over a live violation, and
 * `hasShrunk` stays quiet for the same reason, so not even the "residue shrank"
 * hint fires. Measured on `scripts/docs/ui-gate-wording.mjs` with
 * `{"docs/thing.md": {"blanket-merge-pause": "x"}}` — exit 0, "1 baselined
 * occurrence(s) remain", violation live.
 *
 * Validating here rather than inside `newViolations` is deliberate: it is one
 * place for all six gates, it keeps the comparison a pure numeric predicate,
 * and it puts the error where the file is named — a comparison that throws can
 * only say WHICH key, not which file it came from.
 *
 * This does not reach `scripts/docs/covers-gaps.mjs`, whose baseline stores gap
 * FILE ARRAYS by design and which does not import this module (#2679). Audited
 * before shipping: 155 entries across the six gates on this engine, all
 * numeric, so this is a pure tightening rather than a build someone else has to
 * fix. The 40 array-valued entries in the repo all live in covers-gaps'.
 */
export function assertUsableBaseline(baseline, path = 'baseline') {
  if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) {
    const shape = Array.isArray(baseline) ? 'an array' : baseline === null ? 'null' : typeof baseline
    throw new TypeError(`${path}: expected a JSON object, got ${shape}`)
  }
  for (const [file, keys] of Object.entries(baseline)) {
    if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
      const shape = Array.isArray(keys) ? 'an array' : keys === null ? 'null' : typeof keys
      throw new TypeError(`${path}: entry "${file}" should map keys to counts, got ${shape}`)
    }
    for (const [key, allowed] of Object.entries(keys)) {
      if (typeof allowed !== 'number' || !Number.isFinite(allowed)) {
        // `JSON.stringify(NaN)` is the string "null", which would report a
        // NaN entry as null and send the reader looking for the wrong thing.
        const shown = Number.isNaN(allowed) ? 'NaN' : JSON.stringify(allowed)
        throw new TypeError(
          `${path}: "${file}" [${key}] is ${shown}, not a number — ` +
            'the comparison is `count > allowed`, so a non-numeric entry silently allows ' +
            'everything for that key rather than failing loudly',
        )
      }
    }
  }
  return baseline
}

export function loadBaseline(path) {
  // ONE `existsSync`, feeding both halves. Calling `readBaseline(path)` (which
  // does its own) and then `!existsSync(path)` leaves a window in which the two
  // disagree, and one direction of that disagreement is unsafe: a file deleted
  // between the calls yields a parsed, non-empty baseline paired with
  // `firstRun: true`, so `updateRefusals` returns [] and growth is accepted.
  // Narrow, but this is a guard whose entire job is to refuse -- and the defect
  // it was written for was also "two states that look alike" (review nit).
  const exists = existsSync(path)
  return {
    baseline: exists ? assertUsableBaseline(JSON.parse(readFileSync(path, 'utf8')), path) : {},
    firstRun: !exists,
  }
}

/** Read the baseline, or {} when none exists yet. */
export function readBaseline(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}
