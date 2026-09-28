// #3412 — no upgrade hint names a bare connector re-run.
//
// `connectorRerunCommand()` with no arguments renders `npx @haven_ai/connect@<ch>`:
// a SETUP command, which on an already set-up machine stops at
// "Missing --setup <hv_setup_...> setup token". Every upgrade hint must use
// `connectorUpgradeCommand()` (SDK) / `hostedConnectorUpgradeCommand()` (hosted
// MCP) instead. The bare form is legitimate only where the user is mid-setup or
// restoring credentials, or where it is a prefix constant that call sites extend
// with flags — those sites are the allowlist below, with EXACT counts, so a new
// bare call anywhere (including a new one inside an allowlisted file) fails.
//
// Before #3412 this guard would have failed on eight sites: the signer's
// initialize instructions and out-of-date refusal, the SDK's
// signerUpdateFallback, and five hosted-MCP hints.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const BARE = /\b(?:hosted)?[cC]onnectorRerunCommand\(\)/g

// file → [allowed count, why the bare form is right there]
const ALLOWLIST = {
  'packages/connect/src/doctor.ts': [1, '`RERUN` prefix constant; every use appends flags'],
  'packages/connect/src/runtime.ts': [1, '`RERUN_HINT` prefix constant for setup-time output'],
  'packages/connect/src/runtime-install.ts': [3, 'mid-setup retry: the user is running setup'],
  'packages/signer/src/tools.ts': [2, 'identity restore: re-running setup is the fix'],
  'packages/sdk/src/connector-channel.ts': [1, 'the helper\'s own doc comment'],
}

function sourceFiles() {
  return execFileSync('git', ['ls-files', '-z', 'packages/*/src/*.ts', 'packages/*/src/**/*.ts'], { encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && !/\.test\.ts$/.test(f) && !f.includes('/test-support/'))
}

function bareCounts() {
  const counts = {}
  for (const file of sourceFiles()) {
    const hits = readFileSync(file, 'utf8').match(BARE)
    if (hits) counts[file] = hits.length
  }
  return counts
}

test('the pattern matches a bare call and not an upgrade or flagged call (positive + negative control)', () => {
  assert.equal('x ${connectorRerunCommand()} y'.match(BARE)?.length, 1)
  assert.equal('x ${hostedConnectorRerunCommand()} y'.match(BARE)?.length, 1)
  assert.equal("connectorRerunCommand('--doctor')".match(BARE), null)
  assert.equal('connectorUpgradeCommand()'.match(BARE), null)
})

test('every allowlisted site is still found (the scan can say yes)', () => {
  const counts = bareCounts()
  for (const [file, [allowed]] of Object.entries(ALLOWLIST)) {
    assert.equal(counts[file] ?? 0, allowed, `${file}: expected exactly ${allowed} allowlisted bare call(s)`)
  }
})

test('no bare connector re-run outside the allowlist — upgrade hints use the doctor form', () => {
  const offenders = Object.entries(bareCounts())
    .filter(([file, n]) => !(file in ALLOWLIST) || n > ALLOWLIST[file][0])
    .map(([file, n]) => `${file} (${n})`)
  assert.deepEqual(
    offenders,
    [],
    'A bare connectorRerunCommand() stops at "Missing --setup" on an existing install. ' +
      'Use connectorUpgradeCommand() (or hostedConnectorUpgradeCommand() in the hosted MCP) for an upgrade hint; ' +
      'extend ALLOWLIST only for a genuine setup-time hint, with its reason.',
  )
})
