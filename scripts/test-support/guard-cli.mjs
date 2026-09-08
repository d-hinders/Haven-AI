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
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
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
  { files = {}, also = [], args = [], env = {}, linkNodeModules = false, mtimes = {}, readBack = [] } = {},
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
    const res = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
      encoding: 'utf-8',
      cwd: root,
      env: { ...process.env, ...env },
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
