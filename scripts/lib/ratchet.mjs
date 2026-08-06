// Shared ratcheting-baseline engine for the lint gates (code review 2026-07-13).
//
// design-lint (#855) and copy-lint (#902) each carried a near line-for-line
// copy of the same ratchet: a committed baseline of existing debt
// (file → key → count) that may only SHRINK — new occurrences, or growth of
// an existing count, fail. This module is the single implementation; a third
// ratcheting gate should import it rather than clone either script.
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

/** Read the baseline, or {} when none exists yet. */
export function readBaseline(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}
