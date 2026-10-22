// Self-test for the test:local watchdog wrapper (#4271).
//
// Drives scripts/test-local.mjs AS A PROCESS through a STUB child
// (TEST_LOCAL_STUB) — never vitest, which this job has no `npm ci` for. Every
// waiting case sets its own `{ timeout }`, so a mutation that removes the
// watchdog goes RED instead of hanging the job. Each stub writes its pid (and
// its grandchild's) with fs.writeSync — buffered async writes would be lost to
// the SIGKILL — and liveness is checked with `process.kill(pid, 0)`, the same
// check on macOS and Linux.
//
// Mutations each of these cases holds (name them in the PR):
// - removing the silence watchdog  → the stall test goes red (its timeout fires);
// - killing only the direct child  → the grandchild test goes red (the
//   grandchild survives the group kill);
// - removing the wall-clock cap    → the cap test goes red (its timeout fires).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildVitestArgv } from './test-local.mjs'

const WRAPPER = fileURLToPath(new URL('./test-local.mjs', import.meta.url))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Stub that spawns a grandchild (NOT detached — it stays in the wrapper's
// child's process group, so a group kill reaps it, while it would outlive its
// parent if the parent merely exited), prints both pids, then hangs silently.
const STUB_SILENT = `import { spawn } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
fs.writeSync(1, 'child ' + process.pid + ' grandchild ' + gc.pid + '\\n')
setInterval(() => {}, 1 << 30)
`

// Stub that keeps producing output forever — silence never trips, only the cap.
const STUB_TICKING = `import fs from 'node:fs'
setInterval(() => fs.writeSync(1, 'tick\\n'), 20)
`

const STUB_EXITING = `process.exit(Number(process.env.STUB_EXIT ?? 0))
`

function makeStub(dir, name, source) {
  const file = path.join(dir, name)
  writeFileSync(file, source)
  return file
}

// Spawns the wrapper with the stub; resolves a handle that collects output.
function runWrapper(t, { stubSource, stubName = 'stub.mjs', args = [], env = {} }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'test-local-'))
  const stub = makeStub(dir, stubName, stubSource)
  const child = spawn(process.execPath, [WRAPPER, ...args], {
    env: {
      ...process.env,
      TEST_LOCAL_STUB: stub,
      TEST_LOCAL_SILENCE_MS: '300',
      TEST_LOCAL_CAP_MS: '20000',
      TEST_LOCAL_KILL_GRACE_MS: '200',
      ...env,
    },
    cwd: path.dirname(WRAPPER),
  })
  t.after(() => {
    try {
      child.kill('SIGKILL')
    } catch {}
  })
  let output = ''
  child.stdout.on('data', (c) => {
    output += c
  })
  let error = ''
  child.stderr.on('data', (c) => {
    error += c
  })
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  )
  return { child, exited, output: () => output, error: () => error }
}

// Waits until the stub has printed both pids (wrapper forwards them on stdout).
async function waitForPids(run) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const m = run.output().match(/child (\d+) grandchild (\d+)/)
    if (m) return { childPid: Number(m[1]), grandchildPid: Number(m[2]) }
    if (Date.now() > deadline) throw new Error('stub never printed pids; output: ' + run.output())
    await sleep(50)
  }
}

// Liveness via process.kill(pid, 0) — ESRCH means gone. Polls because a just
// SIGKILLed process can linger as a zombie until its parent (or init) reaps it.
async function assertDead(pid, label) {
  const deadline = Date.now() + 5_000
  for (;;) {
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch {}
    if (!alive) return
    if (Date.now() > deadline) {
      throw new Error(`${label} (pid ${pid}) is still alive after the run was killed`)
    }
    await sleep(50)
  }
}

test('argv: single worker, verbose reporter, paths appended, no timeout flags', () => {
  const argv = buildVitestArgv(['src/lib', 'src/components/haven'])
  assert.deepEqual(argv, ['vitest', 'run', '--maxWorkers=1', '--reporter=verbose', 'src/lib', 'src/components/haven'])
  for (const arg of argv) {
    assert.ok(!/^--(test|hook)Timeout/.test(arg), `wrapper must not pass ${arg}`)
  }
})

test('argv: --all passes no paths to vitest', () => {
  assert.deepEqual(buildVitestArgv([]), ['vitest', 'run', '--maxWorkers=1', '--reporter=verbose'])
})

test("passes the stub's own exit status through (0)", { timeout: 20_000 }, async (t) => {
  const run = runWrapper(t, { stubSource: STUB_EXITING, stubName: 'exit0.mjs', args: ['src/lib'] })
  const { code } = await run.exited
  assert.equal(code, 0)
})

test("passes the stub's own exit status through (a code other than 1)", { timeout: 20_000 }, async (t) => {
  const run = runWrapper(t, {
    stubSource: STUB_EXITING,
    stubName: 'exit3.mjs',
    args: ['src/lib'],
    env: { STUB_EXIT: '3' },
  })
  const { code } = await run.exited
  assert.equal(code, 3)
})

test('refuses with no paths and no --all, and runs nothing', { timeout: 20_000 }, async (t) => {
  const run = runWrapper(t, {
    stubSource: STUB_EXITING,
    stubName: 'exit0.mjs',
    // No paths: the wrapper must refuse BEFORE spawning anything, so the stub
    // (which would exit 0) must never run.
    args: [],
  })
  const { code } = await run.exited
  assert.ok(code !== 0, `expected a non-zero refusal, got ${code}`)
  assert.match(run.error(), /no paths given/)
})

test('a silent run is killed at the silence threshold with exit 86', { timeout: 20_000 }, async (t) => {
  const run = runWrapper(t, { stubSource: STUB_SILENT, args: ['src/lib'] })
  const { code } = await run.exited
  assert.equal(code, 86)
  assert.match(run.error(), /STALL/)
  assert.match(run.error(), /no output for \d+ms/)
})

test('after a stall-kill neither the child nor its grandchild is alive', { timeout: 20_000 }, async (t) => {
  const run = runWrapper(t, { stubSource: STUB_SILENT, args: ['src/lib'] })
  const { childPid, grandchildPid } = await waitForPids(run)
  const { code } = await run.exited
  assert.equal(code, 86, 'the stall watchdog must fire for the group kill to be exercised')
  await assertDead(childPid, 'stub child')
  await assertDead(grandchildPid, 'grandchild')
})

test('a run past the wall-clock cap is killed with exit 87', { timeout: 20_000 }, async (t) => {
  const run = runWrapper(t, {
    stubSource: STUB_TICKING,
    args: ['src/lib'],
    env: { TEST_LOCAL_CAP_MS: '600' },
  })
  const { code } = await run.exited
  assert.equal(code, 87)
  assert.match(run.error(), /CAP/)
})

test('SIGTERM to the wrapper reaps the child and the grandchild', { timeout: 20_000 }, async (t) => {
  const run = runWrapper(t, { stubSource: STUB_SILENT, args: ['src/lib'] })
  const { childPid, grandchildPid } = await waitForPids(run)
  run.child.kill('SIGTERM')
  const { code } = await run.exited
  assert.equal(code, 143)
  await assertDead(childPid, 'stub child')
  await assertDead(grandchildPid, 'grandchild')
})

test('SIGINT to the wrapper reaps the child and the grandchild', { timeout: 20_000 }, async (t) => {
  const run = runWrapper(t, { stubSource: STUB_SILENT, args: ['src/lib'] })
  const { childPid, grandchildPid } = await waitForPids(run)
  run.child.kill('SIGINT')
  const { code } = await run.exited
  assert.equal(code, 130)
  await assertDead(childPid, 'stub child')
  await assertDead(grandchildPid, 'grandchild')
})
