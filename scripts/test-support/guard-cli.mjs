// Drive a guard script as a PROCESS, against a fixture repo the test owns
// (#2721, epic #2720).
//
// ## Why this exists
//
// 33 of 44 guard self-tests only call the functions their script exports, and
// 13 guards keep a refusal in `main()` that those tests cannot reach. Two such
// refusals were mutated to `if (false)` in one week and the suites stayed green
// (#2690, #2704) — the guard was gone and nothing noticed. Testing the exported
// predicate proves the predicate; only running the process proves the guard.
//
// ## The seam, and why it needs no change to the guards
//
// Most of these scripts derive their repo root from their own location
// (`join(dirname(fileURLToPath(import.meta.url)), '..')`). So the fixture is
// built by COPYING the script into a throwaway tree: the root it computes is
// then the fixture's, and the real repo is never scanned. No guard gains a
// test-only env var, and the code under test is the shipped file byte for byte.
//
// ## The realpath, which is not optional
//
// These scripts self-guard with `import.meta.url === \`file://${process.argv[1]}\``.
// On macOS `mktemp -d` returns `/var/folders/…` reached through a symlink, so
// `argv[1]` and `import.meta.url` disagree, `main()` never runs, and the script
// exits 0 having done NOTHING. Measured: a fixture with a real violation
// reported exit 0 and printed nothing at all — a false pass that looks exactly
// like a clean run. `realpathSync` is what stops this helper from certifying
// silence as success.
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * Build a fixture repo, run one guard in it, and return `{ status, out }`.
 *
 * `files` maps repo-relative paths to contents; directories are created.
 * `also` names sibling scripts the guard imports, copied alongside it.
 */
export function runGuard(
  script,
  {
    files = {},
    also = [],
    args = [],
    env = {},
    linkNodeModules = false,
    binOnPath = false,
    gitInit = false,
    gitCommit = false,
    mtimes = {},
    chmod = {},
    readBack = [],
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-cli-')))
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    for (const name of [script, ...also]) {
      const src = join(SCRIPTS_DIR, name)
      const dest = join(root, 'scripts', name)
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest)
    }
    // Some guards import a real dependency (dependency-cruiser). Node resolves
    // `node_modules` by walking up from the file, and a temp root has none, so
    // the import fails before `main()` runs — which would look like a guard
    // that refused nothing.
    if (linkNodeModules) {
      symlinkSync(join(SCRIPTS_DIR, '..', 'node_modules'), join(root, 'node_modules'), 'dir')
    }
    for (const [rel, body] of Object.entries(files)) {
      const dest = join(root, rel)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, body)
    }
    // Some guards enumerate their scan set with `git ls-files` rather than by
    // walking the tree — a deliberate choice, since it excludes untracked and
    // ignored files for free. A plain temp directory answers that with a fatal
    // error, so the guard sees NO files and reports a clean scan over nothing:
    // the false pass this harness exists to stop, arriving through the file
    // list instead of through `main()`. `git add` is given the fixture's own
    // paths explicitly rather than `-A`, so the index holds exactly what the
    // test wrote.
    if (gitInit || gitCommit) {
      const paths = Object.keys(files)
      if (!paths.length) {
        throw new Error('runGuard: gitInit with no files stages nothing, so a git-enumerating guard reports a clean scan over ZERO files — the false pass this option exists to close')
      }
      execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' })
      // `-c core.excludesFile=/dev/null` and `-f`: a contributor's global
      // gitignore (or an `init.templateDir` carrying `info/exclude`) can match
      // fixture paths like `docs/**` or `*.md`, and then `git add` refuses and
      // every case here reddens on the machine of whoever has that config.
      // stderr is inherited rather than swallowed so the reason is legible —
      // measured, the ignored-paths explanation was otherwise lost.
      execFileSync('git', ['-c', 'core.excludesFile=/dev/null', '-C', root, 'add', '-f', '--', ...paths], {
        stdio: ['ignore', 'ignore', 'inherit'],
      })
    }
    // A guard that asks git about HEAD -- ancestry, a two-dot diff, the blob a
    // file had before it changed -- gets a fatal error in a repo with no
    // commits, and several of them read that error as "no answer" and fail
    // closed. That is the right direction but the wrong test: it exercises the
    // unreadable-git path, never the one CI runs. So `gitCommit` gives the
    // fixture a real HEAD. Identity is passed with `-c` rather than taken from
    // the machine, because a contributor with no `user.email` set otherwise
    // sees every such case fail for a reason that is not the guard's.
    // `gitCommit` implies `gitInit` rather than refusing without it: an
    // implication cannot be got wrong, and an error path no suite exercises is
    // one more untested refusal in a helper that exists to end untested
    // refusals.
    //
    // The `-c` flags are the same defence the staging step above documents,
    // extended to the two settings that break a COMMIT rather than an add:
    // a global `commit.gpgsign=true` fails the fixture with `gpg failed to sign
    // the data`, and a global `core.hooksPath` runs a contributor's own
    // pre-commit hook inside the fixture. Both were reproduced; either one
    // reddens every case here for a reason that is not the guard's.
    if (gitCommit) {
      execFileSync('git', [
        '-c', 'user.name=Guard Fixture',
        '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=/dev/null',
        '-C', root, 'commit', '-q', '-m', 'fixture',
      ], { stdio: ['ignore', 'ignore', 'inherit'] })
    }
    // Permissions, where a guard's behaviour on an UNREADABLE file is the thing
    // under test (#2761). Applied after the writes and before the run; the
    // `finally` below removes the root, and `rmSync` is unaffected by a 000
    // file's own mode because the containing directory stays writable.
    for (const [rel, mode] of Object.entries(chmod)) {
      chmodSync(join(root, rel), mode)
    }
    // Explicit mtimes where a guard compares them (review finding, blocking).
    // Relying on write ORDER is not enough: file-creation order is stable but
    // timestamp RESOLUTION is not, and `check-dist-freshness` treats
    // `dist >= src` as fresh — so on a coarse-grained filesystem the two came
    // out equal and the staleness test passed on macOS while failing on the
    // ubuntu runner. Worse than a red build: where the ordering sometimes
    // holds, the test is flaky-GREEN and a pass proves nothing.
    for (const [rel, seconds] of Object.entries(mtimes)) {
      utimesSync(join(root, rel), seconds, seconds)
    }
    // A guard that shells out to a command it does not own (`gh`, say) can only
    // be driven offline by putting a stand-in ahead of the real one on PATH.
    // The fixture root is not known to the caller before this function runs, so
    // the prepend happens here rather than through `env` -- a caller writing a
    // relative PATH entry would be depending on cwd resolution, which is a
    // silent no-op wherever it does not hold.
    // Prepended to whatever PATH the caller set rather than written into a
    // separate object: with a later `...env` spread a caller passing both
    // `binOnPath` and `env.PATH` would silently get the REAL command back --
    // the same silent no-op this option exists to avoid.
    const baseEnv = { ...process.env, ...env }
    if (binOnPath) baseEnv.PATH = `${join(root, 'bin')}${delimiter}${baseEnv.PATH ?? ''}`
    const res = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
      encoding: 'utf-8',
      cwd: root,
      env: baseEnv,
      // A hung guard should name itself rather than burn the job's ceiling.
      timeout: 120_000,
    })
    // On timeout `spawnSync` returns status `null`, which fails every
    // `assert.equal(status, <number>)` below -- correct, but the report reads
    // `null !== 1` and says nothing about a timeout. Surface the cause the
    // comment above promises.
    if (res.error?.code === 'ETIMEDOUT') {
      throw new Error(`guard \`${script}\` timed out after 120s (signal ${res.signal})`)
    }
    // Read fixture files back BEFORE the `finally` removes the root, so a test
    // can assert what a guard WROTE and not only what it printed.
    const wrote = Object.fromEntries(
      readBack.map((rel) => {
        try {
          return [rel, readFileSync(join(root, rel), 'utf-8')]
        } catch {
          return [rel, null]
        }
      }),
    )
    return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, wrote }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
