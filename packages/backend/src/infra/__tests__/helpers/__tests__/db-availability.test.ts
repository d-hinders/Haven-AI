/**
 * The guard on the skipping harness (#1763).
 *
 * These tests deliberately do NOT use `describeDb`. A guard against "the
 * real-DB suites skipped and nobody noticed" that itself skipped when there
 * is no database would be the same defect one level up — which is exactly
 * the shape this repo keeps producing. Everything here is a pure function
 * over booleans and strings, so it runs on every machine, with or without
 * Postgres, in CI and out of it.
 *
 * Mutation evidence for each branch is recorded in the pull request for
 * #1763: flipping any single return value below turns at least one of these
 * red.
 */
import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  ciFailureMessage,
  decideDbMode,
  DEFAULT_TEST_DATABASE_URL,
  readDbModeInputs,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  SKIP_ACK_ENV,
  unacknowledgedFailureMessage,
} from '../db-availability.js'

describe('decideDbMode', () => {
  it('runs the real-DB suites whenever a database is reachable', () => {
    for (const ci of [true, false]) {
      for (const acknowledged of [true, false]) {
        expect(decideDbMode({ available: true, ci, acknowledged })).toBe('run')
      }
    }
  })

  it('FAILS in CI when the database is unreachable, acknowledged or not', () => {
    expect(decideDbMode({ available: false, ci: true, acknowledged: false })).toBe('fail-ci')
    // The acknowledgement is for a human at a terminal. It is not an override,
    // and a CI job that could set it would be able to green a run that proved
    // nothing — the outcome epic #1219 exists to prevent.
    expect(decideDbMode({ available: false, ci: true, acknowledged: true })).toBe('fail-ci')
  })

  it('FAILS locally by default when the database is unreachable (#1763 inversion)', () => {
    expect(decideDbMode({ available: false, ci: false, acknowledged: false })).toBe(
      'fail-unacknowledged',
    )
  })

  it('skips locally only when the narrowing is explicitly acknowledged', () => {
    expect(decideDbMode({ available: false, ci: false, acknowledged: true })).toBe(
      'skip-acknowledged',
    )
  })

  it('never returns a mode that lets an unreachable database pass unremarked', () => {
    // The property, stated once so a future branch has to satisfy it: with no
    // database, every mode either fails or is an acknowledged skip. There is
    // no path to 'run'.
    for (const ci of [true, false]) {
      for (const acknowledged of [true, false]) {
        expect(decideDbMode({ available: false, ci, acknowledged })).not.toBe('run')
      }
    }
  })
})

describe('readDbModeInputs', () => {
  it('reads CI as present-and-non-empty, matching the harness it replaced', () => {
    expect(readDbModeInputs({ CI: 'true' }).ci).toBe(true)
    expect(readDbModeInputs({ CI: '1' }).ci).toBe(true)
    expect(readDbModeInputs({}).ci).toBe(false)
    expect(readDbModeInputs({ CI: '' }).ci).toBe(false)
  })

  it(`treats only ${SKIP_ACK_ENV}=1 as an acknowledgement`, () => {
    expect(readDbModeInputs({ [SKIP_ACK_ENV]: '1' }).acknowledged).toBe(true)
    // Not a truthiness check: a stray 'false' or '0' in a shell profile must
    // not silently buy a narrowed run.
    expect(readDbModeInputs({ [SKIP_ACK_ENV]: 'true' }).acknowledged).toBe(false)
    expect(readDbModeInputs({ [SKIP_ACK_ENV]: '0' }).acknowledged).toBe(false)
    expect(readDbModeInputs({}).acknowledged).toBe(false)
  })
})

describe('resolveTestDatabaseUrl', () => {
  it('prefers an explicit DATABASE_URL', () => {
    expect(resolveTestDatabaseUrl({ DATABASE_URL: 'postgres://x@y:1/z' })).toBe(
      'postgres://x@y:1/z',
    )
  })

  it('falls back to the same default vitest.setup.ts applies', () => {
    expect(resolveTestDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL)
  })

  it('vitest.setup.ts IMPORTS that default rather than restating it', async () => {
    // The assertion above is a tautology on its own (the function against its
    // own constant) and could never catch the drift that matters: global setup
    // probes before setup files run, so a second hand-copied literal in
    // vitest.setup.ts would let the guard report on a host the workers never
    // connect to. Structural, because the value equality cannot be checked —
    // importing the setup file here would mutate this worker's env.
    const setup = await readFile(
      new URL('../../../../../vitest.setup.ts', import.meta.url),
      'utf8',
    )
    expect(setup).toContain('DEFAULT_TEST_DATABASE_URL')
    // The negative tripwire matches the LITERAL, not an assignment shape
    // (review nit). A pattern like /DATABASE_URL \?\?= ['"]postgres:/ pins one
    // syntax and is walked around by bracket access, `||`, a template literal,
    // or staging the value through a third variable — a guard against a
    // literal drifting back that a reformat can dodge is a guard that cannot
    // fail in most of the cases it was written for. Compared against the
    // constant rather than a second copy of the string, so this assertion
    // cannot become the duplication it forbids.
    expect(setup).not.toContain(DEFAULT_TEST_DATABASE_URL)
  })
})

describe('redactDatabaseUrl', () => {
  it('removes the password before a connection string reaches a log line', () => {
    const redacted = redactDatabaseUrl('postgres://haven:hunter2@localhost:5432/haven')
    expect(redacted).not.toContain('hunter2')
    expect(redacted).toContain('localhost:5432')
  })

  it('keeps a password-less URL readable', () => {
    expect(redactDatabaseUrl('postgres://localhost:5432/haven')).toContain('localhost:5432')
  })

  it('never throws on an unparseable value', () => {
    expect(redactDatabaseUrl('not a url')).toBe('<unparseable DATABASE_URL>')
  })
})

describe('failure messages', () => {
  it('the CI message still names the epic it protects', () => {
    expect(ciFailureMessage(DEFAULT_TEST_DATABASE_URL)).toContain('#1219')
  })

  it('the local message names BOTH ways out, so the error is actionable', () => {
    const message = unacknowledgedFailureMessage(DEFAULT_TEST_DATABASE_URL)
    expect(message).toContain('docker compose up -d postgres')
    expect(message).toContain(SKIP_ACK_ENV)
  })

  it('the local message warns that a SCOPED run fails too (#1763 review nit 3)', () => {
    // Global setup runs before collection and cannot see the file selection, so
    // `vitest run one-pure-unit.test.ts` fails on a database-free machine as
    // well. Surprising enough to belong in the message rather than only in the
    // docs — pinned so a future edit cannot quietly drop it.
    expect(unacknowledgedFailureMessage(DEFAULT_TEST_DATABASE_URL)).toContain('scoped')
  })

  it('neither message leaks a password', () => {
    const url = 'postgres://haven:hunter2@localhost:5432/haven'
    expect(ciFailureMessage(url)).not.toContain('hunter2')
    expect(unacknowledgedFailureMessage(url)).not.toContain('hunter2')
  })
})
