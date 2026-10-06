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
const REPO_ROOT = join(HERE, '..', '..')

// The script exits exactly 1 when it decides to build. Asserting 1 (not merely
// non-zero) tells that apart from a broken wrapper: sh's own 2 or 127.
export const BUILD = 1
export const SKIP = 0

/** The `ignoreCommand` string from a project's vercel.json. */
export function readIgnoreCommand(projectRoot) {
  return JSON.parse(readFileSync(join(projectRoot, 'vercel.json'), 'utf8')).ignoreCommand
}

/**
 * What the command passes to the shared script: the force-variable name and
 * the watch file, plus the watched paths that file lists. Read from the command
 * and the file it names, so a test of the list tests the copy that runs.
 */
export function parseIgnoreCommand(command) {
  const marker = `/${SCRIPT_IN_REPO}"`
  const at = command.indexOf(marker)
  if (at === -1) throw new Error(`ignoreCommand does not invoke ${SCRIPT_IN_REPO}: ${command}`)
  const args = command.slice(at + marker.length).trim().split(/\s+/)
  if (args.length !== 2) throw new Error(`ignoreCommand must pass <FORCE_VARIABLE> <watch file>: ${command}`)
  const [forceVariable, watchFile] = args
  return { forceVariable, watchFile, watched: readWatchFile(watchFile) }
}

/**
 * The paths a watch file lists, parsed the way the script parses it. An entry
 * containing whitespace is refused: the script word-splits the list, so it
 * would watch two paths where this parser saw one.
 */
export function readWatchFile(watchFile) {
  const entries = readFileSync(join(REPO_ROOT, watchFile), 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
  for (const entry of entries) {
    if (/\s/.test(entry)) throw new Error(`${watchFile}: entry "${entry}" contains whitespace; the script word-splits the list`)
  }
  // An exclude-only list would make git watch EVERYTHING but the excludes.
  if (!entries.some((entry) => !entry.startsWith('!'))) throw new Error(`${watchFile}: lists no include entry`)
  return entries
}

/**
 * A git `glob` pathspec as a RegExp: `**` crosses directories (a leading
 * `**\/` and an inner `/**\/` may match none), `*` and `?` stay inside one.
 */
export function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?'
      i += 2
    } else if (glob.startsWith('**', i)) {
      out += '.*'
      i += 1
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/**
 * Whether a change to `path` (repo-relative) rebuilds the project under the
 * `watched` list, as the script's pathspecs decide it: an include entry (a
 * path prefix) matches it and no `!` exclude glob does (#3681).
 */
export function isWatched(watched, path) {
  const includes = watched.filter((entry) => !entry.startsWith('!'))
  const excludes = watched.filter((entry) => entry.startsWith('!')).map((entry) => globToRegExp(entry.slice(1)))
  return (
    includes.some((entry) => path === entry || path.startsWith(`${entry}/`)) &&
    !excludes.some((re) => re.test(path))
  )
}

/**
 * The environment every git and sh spawn gets: no inherited `GIT_*` (a git
 * hook exports GIT_DIR / GIT_INDEX_FILE, which would point these commands at
 * the HOST repository), no global or system git config, and no VERCEL_* or
 * *_FORCE_BUILD or IGNORE_BUILD_DEV_URL variable unless a test sets one. The
 * GIT_* filter is the one
 * scripts/ci/money-path-classify.test.mjs uses.
 */
export function hermeticEnv(extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(GIT_|VERCEL_)/.test(key) || /_FORCE_BUILD$/.test(key) || key === 'IGNORE_BUILD_DEV_URL') delete env[key]
  }
  return Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, extra)
}

/**
 * A throwaway repository on branch `dev` with the shared script committed and
 * one unrelated commit. `run` executes `command` from `packages/<project>`.
 * `watchContent`, when given, replaces the project's real watch file, so the
 * script's general behaviour can be tested on a synthetic list.
 */
export function makeRepo({ project, command, watchContent = /** @type {string | undefined} */ (undefined) }) {
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

  mkdirSync(join(repo, 'scripts', 'vercel', 'watch'), { recursive: true })
  copyFileSync(SCRIPT_SOURCE, join(repo, SCRIPT_IN_REPO))
  const { watchFile } = parseIgnoreCommand(command)
  if (watchContent === undefined) copyFileSync(join(REPO_ROOT, watchFile), join(repo, watchFile))
  else writeFileSync(join(repo, watchFile), watchContent)
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

  /** `run`, plus the step's combined log, for the cases that pin what it says. */
  const runLog = (vars = {}, root = repo) => {
    const env = {}
    for (const [key, value] of Object.entries(vars)) if (value !== undefined) env[key] = value
    const result = spawnSync('sh', ['-c', command], {
      cwd: join(root, 'packages', project),
      env: hermeticEnv(env),
      encoding: 'utf8',
    })
    return { status: result.status ?? -1, log: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  /**
   * A shallow clone (default depth 1) of the repo's current branch, for the
   * missing-commit cases. Like Vercel's, it holds that branch only. Unless
   * `withOrigin` is set the `origin` remote is removed, so the script can
   * fetch dev only from a public-URL source the test supplies
   * (`IGNORE_BUILD_DEV_URL`, or Vercel's owner and slug variables).
   */
  const shallowClone = ({ withOrigin = false, depth = 1 } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), `${project}-ignore-shallow-`))
    execFileSync('git', ['clone', '-q', '--depth', String(depth), `file://${repo}`, dir], { env: hermeticEnv() })
    if (!withOrigin) execFileSync('git', ['remote', 'remove', 'origin'], { cwd: dir, env: hermeticEnv() })
    return dir
  }

  const cleanup = () => rmSync(repo, { recursive: true, force: true })
  return { repo, git, commit, run, runLog, shallowClone, cleanup }
}

export { rmSync }
