// test:local — a watchdog wrapper for scoped local frontend vitest runs (#4271).
//
// While shipping #4259 (PR #4270, 2026-10-22) a whole-suite
// `vitest run --pool=forks --poolOptions.forks.singleFork=true` stopped writing
// output one minute in; the session waited ~75 minutes before anyone noticed,
// and killing it left a worker holding ~330 MB. This wrapper turns that hang
// into a failure:
//
//   npm run test:local -w packages/frontend -- src/lib src/components/haven
//
// - runs vitest SINGLE-WORKER (`--maxWorkers=1`) with the verbose reporter
//   (`--reporter=verbose`) over the given paths, which are package-relative
//   (npm `-w` runs inside packages/frontend);
// - builds core first, as `test` does, so an out-of-date core build cannot
//   cause reds unrelated to the change;
// - kills the run's WHOLE PROCESS GROUP when it writes no output (stdout or
//   stderr) for longer than TEST_LOCAL_SILENCE_MS (default 300000) — SIGTERM
//   first, SIGKILL after a grace period — and exits 86 with a message naming
//   the stall and how long the run was silent;
// - applies an overall wall-clock cap, TEST_LOCAL_CAP_MS (default 1800000),
//   with its own exit code 87 and message;
// - on ANY exit — normal, stall, cap, or SIGINT/SIGTERM to the wrapper —
//   reaps every process in the group, so it never leaves a worker orphaned.
//   Accepted residue: a process that LEAVES the group (`setsid`, or a detached
//   spawn) is not reaped;
// - passes NO `testTimeout` or `hookTimeout`, on the command line or anywhere
//   else — the timing posture pinned by `src/__tests__/suite-timing-posture.test.ts`
//   and the frontend playbook §4 is untouched.
//
// It refuses to run with no paths unless `--all` is passed (exit 64): a
// whole-suite run is CI's job.
//
// Dependency-free on purpose: Node built-ins only — no `tree-kill`, no vitest
// import — because its self-test (`test-local.test.mjs`) runs in CI's
// `ci_config_checks` job, which has no `npm ci` and a 5-minute budget.
//
// Uses POSIX process groups (Linux/macOS). `TEST_LOCAL_STUB=<script>` replaces
// the vitest child with `[node <script> <paths…>]` and skips the core build;
// it exists only for the self-test. `TEST_LOCAL_KILL_GRACE_MS` (default 5000)
// is the SIGTERM→SIGKILL grace period, also exposed so the self-test can run
// sub-second.

import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

export const EXIT_USAGE = 64
export const EXIT_STALL = 86
export const EXIT_CAP = 87

const POLL_MS = 100
const DEFAULT_SILENCE_MS = 300_000
const DEFAULT_CAP_MS = 1_800_000
const DEFAULT_KILL_GRACE_MS = 5_000

export function parseArgs(argv) {
  const paths = []
  let all = false
  for (const arg of argv) {
    if (arg === '--all') {
      all = true
      continue
    }
    if (arg.startsWith('--')) {
      return {
        error: `test:local: unknown flag ${arg} — pass package-relative paths (npm -w runs inside packages/frontend), or --all for the whole suite (which is CI's job).`,
      }
    }
    paths.push(arg)
  }
  if (paths.length > 0 && all) {
    return { error: 'test:local: pass either paths or --all, not both.' }
  }
  if (paths.length === 0 && !all) {
    return {
      error:
        'test:local: no paths given — a whole-suite run is CI\'s job. Pass package-relative paths (e.g. `npm run test:local -w packages/frontend -- src/lib`), or --all to override.',
    }
  }
  return { paths, all }
}

// The argv the wrapper builds for vitest. No testTimeout, no hookTimeout —
// asserted on by test-local.test.mjs; the posture stays at the default
// (frontend.md:417, suite-timing-posture.test.ts).
export function buildVitestArgv(paths) {
  return ['vitest', 'run', '--maxWorkers=1', '--reporter=verbose', ...paths]
}

export function envInt(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `test:local: ${name} must be a positive integer of milliseconds, got ${JSON.stringify(raw)}`,
    )
  }
  return n
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    process.stderr.write(parsed.error + '\n')
    process.exit(EXIT_USAGE)
  }

  let silenceMs
  let capMs
  let graceMs
  try {
    silenceMs = envInt('TEST_LOCAL_SILENCE_MS', DEFAULT_SILENCE_MS)
    capMs = envInt('TEST_LOCAL_CAP_MS', DEFAULT_CAP_MS)
    graceMs = envInt('TEST_LOCAL_KILL_GRACE_MS', DEFAULT_KILL_GRACE_MS)
  } catch (err) {
    process.stderr.write(err.message + '\n')
    process.exit(EXIT_USAGE)
  }

  const stub = process.env.TEST_LOCAL_STUB
  if (!stub) {
    // As `test` does, so an out-of-date core build cannot cause reds unrelated
    // to the change. Stub mode (self-test only) skips it.
    const build = spawnSync('npm', ['--prefix', '../core', 'run', 'build'], {
      stdio: 'inherit',
    })
    if (build.status !== 0) process.exit(build.status ?? 1)
  }

  const argv = stub
    ? [process.execPath, stub, ...parsed.paths]
    : buildVitestArgv(parsed.paths)
  process.stderr.write(`test:local: ${argv.join(' ')}\n`)

  // detached: the child becomes its own process-group leader (pgid == pid), so
  // the wrapper can signal and reap the whole run — vitest's workers included.
  const child = spawn(argv[0], argv.slice(1), {
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: true,
  })

  let lastOutputAt = Date.now()
  const markOutput = (chunk) => {
    lastOutputAt = Date.now()
    process.stdout.write(chunk)
  }
  child.stdout.on('data', markOutput)
  child.stderr.on('data', markOutput)

  const killGroup = (signal) => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, signal)
    } catch (err) {
      if (err.code !== 'ESRCH') throw err
    }
  }
  const reap = () => killGroup('SIGKILL')

  // Exactly one path — stall, cap, child exit, or a wrapper signal — owns the
  // exit. Without the claim, the stub's own SIGTERM death would race the
  // stall/cap owner and report 143 instead of the watchdog's code.
  let decided = false
  const claim = () => {
    if (decided) return false
    decided = true
    return true
  }
  const finish = (code, message) => {
    clearInterval(watchdog)
    clearTimeout(capTimer)
    if (message) process.stderr.write(message + '\n')
    process.exit(code)
  }

  // These timers stay REFERENCED: once the killed child's pipes close, the
  // loop would otherwise drain and the process would exit 0 before the grace
  // timer delivers the watchdog's own exit code. Every exit path here is an
  // explicit process.exit, so nothing relies on the loop draining.
  const watchdog = setInterval(() => {
    if (decided) return
    const silentFor = Date.now() - lastOutputAt
    if (silentFor <= silenceMs) return
    if (!claim()) return
    // SIGTERM first; SIGKILL after the grace period, then the stall exit.
    killGroup('SIGTERM')
    setTimeout(() => {
      reap()
      finish(
        EXIT_STALL,
        `test:local: STALL — the run wrote no output for ${silentFor}ms (TEST_LOCAL_SILENCE_MS=${silenceMs}); killed its process group. Raise TEST_LOCAL_SILENCE_MS only with a reason.`,
      )
    }, graceMs)
  }, POLL_MS)

  const capTimer = setTimeout(() => {
    if (!claim()) return
    killGroup('SIGTERM')
    setTimeout(() => {
      reap()
      finish(
        EXIT_CAP,
        `test:local: CAP — the run exceeded TEST_LOCAL_CAP_MS=${capMs}; killed its process group. A run this long belongs in CI.`,
      )
    }, graceMs)
  }, capMs)

  child.on('error', (err) => {
    if (!claim()) return
    finish(127, `test:local: failed to start the run — ${err.message}`)
  })
  child.on('exit', (code, signal) => {
    // Reap stragglers on the normal path too — a worker that outlived vitest
    // is exactly the ~330 MB orphan the incident left behind.
    reap()
    if (!claim()) return
    if (signal) {
      const SIGNUMS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }
      process.exit(128 + (SIGNUMS[signal] ?? 15))
    }
    process.exit(code ?? 1)
  })

  for (const [sig, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.on(sig, () => {
      if (!claim()) return
      killGroup('SIGTERM')
      reap()
      finish(code, `test:local: ${sig} received; reaped the run's process group.`)
    })
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  await main()
}
