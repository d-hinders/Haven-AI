/**
 * Test harness for `scripts/vercel/ignore-build.sh` (#3594), shared by each
 * Vercel project's ignore-step test (packages/ops, packages/frontend). It runs
 * the project's REAL `ignoreCommand`, read from its vercel.json, through
 * `sh -c` as Vercel does, inside a throwaway git repo carrying a copy of the
 * script. Exit 0 = Vercel skips the build; anything else = it builds.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_SOURCE = join(HERE, 'ignore-build.sh')
const SCRIPT_IN_REPO = 'scripts/vercel/ignore-build.sh'

// The script exits exactly 1 when it decides to build. Asserting 1 (not merely
// non-zero) tells that apart from a broken wrapper: sh's own 2 or 127.
export const BUILD = 1
export const SKIP = 0

/** The `ignoreCommand` string from a project's vercel.json. */
export function readIgnoreCommand(projectRoot) {
  return JSON.parse(readFileSync(join(projectRoot, 'vercel.json'), 'utf8')).ignoreCommand
}

/**
 * The arguments the command passes to the shared script: the force-variable
 * name and the watched paths. Read from the command itself, so a test of the
 * list tests the copy that runs.
 */
export function parseIgnoreCommand(command) {
  const marker = `/${SCRIPT_IN_REPO}"`
  const at = command.indexOf(marker)
  if (at === -1) throw new Error(`ignoreCommand does not invoke ${SCRIPT_IN_REPO}: ${command}`)
  const [forceVariable, ...watched] = command.slice(at + marker.length).trim().split(/\s+/)
  return { forceVariable, watched }
}

/**
 * The environment every git and sh spawn gets: no inherited `GIT_*` (a git
 * hook exports GIT_DIR / GIT_INDEX_FILE, which would point these commands at
 * the HOST repository), no global or system git config, and no VERCEL_* or
 * *_FORCE_BUILD variable unless a test sets one. The GIT_* filter is the one
 * scripts/ci/money-path-classify.test.mjs uses.
 */
export function hermeticEnv(extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(GIT_|VERCEL_)/.test(key) || /_FORCE_BUILD$/.test(key)) delete env[key]
  }
  return Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, extra)
}

/**
 * A throwaway repository on branch `dev` with the shared script committed and
 * one unrelated commit. `run` executes `command` from `packages/<project>`.
 */
export function makeRepo({ project, command }) {
  const repo = mkdtempSync(join(tmpdir(), `${project}-ignore-`))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: hermeticEnv() }).trim()
  git('init', '-q', '-b', 'dev')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')

  /** Write a file and commit it; returns the new commit's SHA. */
  const commit = (path, content = `${Date.now()}-${Math.random()}`) => {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), content)
    git('add', '-A')
    git('commit', '-q', '-m', `touch ${path}`)
    return git('rev-parse', 'HEAD')
  }

  mkdirSync(join(repo, 'scripts', 'vercel'), { recursive: true })
  copyFileSync(SCRIPT_SOURCE, join(repo, SCRIPT_IN_REPO))
  // The project's Root Directory must exist in every clone, shallow ones
  // included, so the seed commit carries a file in it.
  commit(`packages/${project}/vercel.json`, '{}')

  /**
   * Run the ignore step from the project's Root Directory, as Vercel does.
   * `vars` are VERCEL_* (and force) variables; undefined values are left unset.
   */
  const run = (vars = {}, root = repo) => {
    const env = {}
    for (const [key, value] of Object.entries(vars)) if (value !== undefined) env[key] = value
    return spawnSync('sh', ['-c', command], { cwd: join(root, 'packages', project), env: hermeticEnv(env) }).status ?? -1
  }

  /** A shallow (depth 1) clone of the repo, for the missing-commit cases. */
  const shallowClone = () => {
    const dir = mkdtempSync(join(tmpdir(), `${project}-ignore-shallow-`))
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo}`, dir], { env: hermeticEnv() })
    return dir
  }

  const cleanup = () => rmSync(repo, { recursive: true, force: true })
  return { repo, git, commit, run, shallowClone, cleanup }
}

export { rmSync }
