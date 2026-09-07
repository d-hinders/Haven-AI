#!/usr/bin/env node

import { run } from './commands.js'
import { promptPasswordWith } from './prompt.js'

/**
 * The bin entry, and deliberately nothing else.
 *
 * It used to also define `promptPasswordWith`, which meant importing this file
 * to test that function EXECUTED the CLI — `run(process.argv.slice(2))` against
 * vitest's own argv, ending in `process.exit(1)`. The suite still reported 102
 * passing tests with one unhandled error beside them, which is exactly the
 * shape of failure a `grep` for "Tests" hides (#2525 review round 3, caught by
 * CI). An entry point that self-executes must not also be an import target, so
 * the prompt lives in `prompt.ts` and this file only wires and runs.
 */
function promptPassword(): Promise<string> {
  return promptPasswordWith({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr })
}

run(process.argv.slice(2), { promptPassword })
  .then((code) => process.exit(code))
  .catch((err) => {
    // The last resort: anything that escaped run()'s own handling. It should be
    // unreachable — run() catches around both parseArgs and dispatch — but if
    // it is ever reached under `--json`, a bare sentence on stderr with exit 1
    // would be the one refusal a machine caller cannot parse. So it emits the
    // same failure shape as everything else (#2525 review, finding 2).
    const message = err instanceof Error ? err.message : String(err)
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'failed', message } }, null, 2)}\n`)
    } else {
      process.stderr.write(`${message}\n`)
    }
    process.exit(1)
  })
