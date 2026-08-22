/**
 * The passport schema probe runs with **nothing but an RPC URL** (#971).
 *
 * `scripts/register-passport-schema.ts` says so in its own docstring:
 *
 *   > Deliberately NOT via `lib/chains.js`: that pulls in `config.ts`, which
 *   > `requireEnv`s DATABASE_URL at import time — so verifying contract pins
 *   > would have needed a running Postgres. An ops probe must stay runnable
 *   > with nothing but an RPC URL.
 *
 * That property had nothing holding it, and it broke. When `lib/passport`
 * gained an `index.ts` barrel (module-boundaries rule 6), the script was
 * pointed at the barrel — which re-exports issuance, revocation, verification
 * and x402-delivery, all of which reach `db.js` → `config.ts`. The probe then
 * died on `Missing required environment variable: DATABASE_URL` before its
 * first line, and an operator hit that mid-session with a funded key in hand.
 *
 * The cost of the regression is what makes it worth a test: this script is the
 * one step of #971 that cannot ship in a PR, so it is run by a human, once,
 * usually under time pressure, on a machine that has no reason to have a
 * Postgres URL.
 *
 * This spawns the REAL script with `DATABASE_URL` explicitly removed. It does
 * not assert success — without network the probe correctly exits 1 reporting
 * an unreachable RPC. It asserts the process got far enough to *try*, which is
 * exactly the property that regressed.
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * Subprocess budget for the probe (#1761).
 *
 * This budget exists to bound a HANG, not to bound a slow machine — so it is
 * derived from the worst *legitimate* runtime observed, with room above it,
 * rather than from a comfortable-looking round number.
 *
 * Measured runtimes of this one test, `npx tsx` cold each time:
 *
 * | Condition                                    | Test    | Machine |
 * |----------------------------------------------|---------|---------|
 * | idle                                         | 17.3 s  | #1761   |
 * | moderately loaded                            | 40.8 s  | #1761   |
 * | solo, load avg 12.5 (12 cores)               |  8.4 s  | this    |
 * | solo, load avg 109                           |  9.2 s  | this    |
 * | inside the full passport suite (21 files)    | 15.8 s  | this    |
 *
 * Two things that measurement set actually shows, both load-bearing here:
 *
 * 1. **Load average is a poor predictor; sibling vitest workers are the real
 *    cost.** Going from load 12.5 to load 109 moved this test by <1 s (8.4 →
 *    9.2 s), while merely running it inside its own suite — 21 files across 12
 *    workers, contending for CPU with work of the same shape — nearly doubled
 *    it (8.4 → 15.8 s). CI is the second condition, not the first.
 * 2. **The spread across machines is ~2x** (8.4 s here vs 17.3 s idle in
 *    #1761), so any budget has to survive hardware it was not measured on.
 *
 * Worst runtime directly observed anywhere is 40.8 s. #1761 separately measured
 * the whole suite running ~8x slower loaded than idle, which puts the ceiling
 * for a legitimate run on a badly loaded machine near 17.3 x 8 ≈ 140 s.
 *
 * 300 s is ~2x that extrapolated ceiling, ~7x the worst directly observed run,
 * and ~19x this machine's in-suite figure. It is also short enough that a real
 * hang costs one test's worth of CI time rather than a job timeout. The old
 * 120 s sat *below* the 140 s ceiling, which is what made it thin.
 */
const PROBE_TIMEOUT_MS = 300_000

describe('ops probe: register-passport-schema (#971)', () => {
  it('loads and runs without DATABASE_URL', () => {
    const env = { ...process.env }
    delete env.DATABASE_URL
    // Point at an unroutable address so the run is fast and deterministic
    // offline: we care about reaching the RPC stage, not about the answer.
    env.RPC_URL_BASE_SEPOLIA = 'http://127.0.0.1:1'

    const startedAt = Date.now()
    const run = spawnSync('npx', ['tsx', 'scripts/register-passport-schema.ts'], {
      cwd: BACKEND,
      env,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    })
    const elapsedMs = Date.now() - startedAt

    // Report a killed subprocess AS a killed subprocess, before asserting on
    // its output (#1761).
    //
    // On timeout `spawnSync` kills the child and returns NORMALLY, setting
    // `error.code = 'ETIMEDOUT'` and `signal = 'SIGTERM'`. Without this check
    // the run falls straight through to the assertions below with empty or
    // truncated output, and the test fails as "produced no recognisable
    // output" — which reads as a broken ops probe and sends the next engineer
    // to investigate the script. The budget being exceeded is a different
    // failure with a different fix, and it should say so itself.
    // `SpawnSyncReturns.error` is typed as plain `Error`, but Node populates it
    // with an errno-bearing one — `code` is where the ETIMEDOUT lives.
    const spawnError = run.error as NodeJS.ErrnoException | undefined

    if (spawnError !== undefined || run.signal !== null) {
      const timedOut = spawnError?.code === 'ETIMEDOUT'
      expect.fail(
        timedOut
          ? `The ops probe did not fail — it was KILLED for exceeding its subprocess budget. ` +
              `Budget ${PROBE_TIMEOUT_MS} ms, elapsed ${elapsedMs} ms, signal ${run.signal ?? 'none'}. ` +
              `This says nothing about whether the probe itself is healthy: its output below is ` +
              `truncated at the kill, so do NOT read it as evidence either way. Either the machine ` +
              `was slower than the budget allows for, or the probe genuinely hung. See #1761 for how ` +
              `this budget was derived, and re-derive it rather than simply raising it again.`
          : `The ops probe subprocess did not complete: ` +
              `${spawnError?.code ?? 'killed'} — ${spawnError?.message ?? `signal ${run.signal}`}. ` +
              `Elapsed ${elapsedMs} ms. This is NOT the ${PROBE_TIMEOUT_MS} ms budget firing — that ` +
              `case reports itself separately — so do not reach for the budget to fix it. Something ` +
              `else ended the process: an external kill (OOM, CI cancellation) or a failure to spawn ` +
              `at all. The output assertions below were skipped because the process never produced a ` +
              `complete result.`,
      )
    }

    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`

    // The regression, named exactly. If this fires, something re-imported a
    // module that reaches config.ts at import time — most likely by switching
    // an import back to `lib/passport/index.js`.
    expect(
      output,
      'The ops probe now requires DATABASE_URL. It must stay runnable with nothing but an ' +
        'RPC URL (#971): an operator runs it once, by hand, on a machine with no Postgres. ' +
        'Check whether an import was moved to lib/passport/index.js — the barrel pulls in ' +
        'issuance/revocation/verification, which reach db.js → config.ts at import time.',
    ).not.toMatch(/Missing required environment variable/)

    // Positive control. Without this the test would pass just as happily if the
    // script failed to start for some entirely different reason, or printed
    // nothing at all — absence of one string is not evidence of progress.
    expect(
      output,
      'The probe produced no recognisable output, so "no DATABASE_URL error" proves nothing.',
    ).toMatch(/chain 84532/)
    // NOTE: this vitest timeout is NOT what governs this test, and raising it
    // protects nothing (#1761). `spawnSync` blocks the event loop for its whole
    // duration, so vitest's timer cannot fire while the probe runs — this test
    // was once observed taking 40 755 ms and PASSING under `--testTimeout=30000`.
    // The only budget that governs it is `PROBE_TIMEOUT_MS` above. This value is
    // kept above that budget purely so it never becomes the reported cause, and
    // so it stops being a second, misleading number to reach for.
  }, PROBE_TIMEOUT_MS + 30_000)
})
