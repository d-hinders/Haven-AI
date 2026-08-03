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

describe('ops probe: register-passport-schema (#971)', () => {
  it('loads and runs without DATABASE_URL', () => {
    const env = { ...process.env }
    delete env.DATABASE_URL
    // Point at an unroutable address so the run is fast and deterministic
    // offline: we care about reaching the RPC stage, not about the answer.
    env.RPC_URL_BASE_SEPOLIA = 'http://127.0.0.1:1'

    const run = spawnSync('npx', ['tsx', 'scripts/register-passport-schema.ts'], {
      cwd: BACKEND,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    })

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
  }, 130_000)
})
