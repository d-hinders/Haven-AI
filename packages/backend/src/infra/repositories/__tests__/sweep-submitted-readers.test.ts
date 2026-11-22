/**
 * #5035 — the six `ds.status = 'submitted'` readers must not count an
 * outcome-unknown sweep as landed.
 *
 * A sweep booked `outcome_unknown` was broadcast but its receipt was not
 * confirmed; it may still land, but it has NOT landed. The six queries that
 * read `delegate_sweeps` as "landed" all filter `ds.status = 'submitted'`, so
 * the new status is excluded by construction — this test pins that predicate
 * in each of the six files, so a future edit that widens one of them to
 * `IN ('submitted', 'outcome_unknown')` (or drops the filter) goes red.
 *
 * A source scan, not a DB test: the point is the predicate itself, and the
 * analytics/dashboard queries are not exported as constants. The behavioural
 * half — an outcome_unknown row is not attributed in transaction history until
 * the confirmer marks it submitted — is pinned on the real-Postgres harness in
 * `machine-payments.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The six readers the issue names, with the line each predicate sits on. */
const READERS = [
  { file: 'analytics.ts', occurrences: 3 },
  { file: 'dashboard.ts', occurrences: 2 },
  { file: 'transaction-history.ts', occurrences: 1 },
] as const

describe('#5035 the six submitted-sweep readers exclude outcome_unknown', () => {
  for (const { file, occurrences } of READERS) {
    it(`${file}: every sweep "landed" predicate is status = 'submitted'`, () => {
      const source = readFileSync(join(REPO_DIR, file), 'utf8')
      const submitted = source.match(/ds\.status = 'submitted'/g) ?? []
      expect(submitted).toHaveLength(occurrences)
      // The new status must never be counted as landed by these readers.
      expect(source).not.toContain("'outcome_unknown'")
    })
  }
})
