// @vitest-environment node
/**
 * The ops Vercel project's Ignored Build Step (#3591). Runs the REAL
 * `ignoreCommand` from `vercel.json`, through `sh -c` as Vercel does, inside a
 * throwaway git repo that carries a copy of the script. Exit 0 = Vercel skips
 * the build; anything else = it builds.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const PACKAGE_ROOT = join(__dirname, '..', '..')
const SCRIPT = 'packages/ops/scripts/vercel-ignore-build.sh'
const ignoreCommand: string = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'vercel.json'), 'utf8')).ignoreCommand

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

/** Write a file and commit it; returns the new commit's SHA. */
function commit(path: string, content = `${Date.now()}-${Math.random()}`): string {
  mkdirSync(join(repo, path, '..'), { recursive: true })
  writeFileSync(join(repo, path), content)
  git('add', '-A')
  git('commit', '-q', '-m', `touch ${path}`)
  return git('rev-parse', 'HEAD')
}

/** Run the ignore step from the project's Root Directory, as Vercel does. Returns the exit code. */
function ignoreStep(previousSha: string | undefined): number {
  const env = { ...process.env }
  delete env.VERCEL_GIT_PREVIOUS_SHA
  if (previousSha !== undefined) env.VERCEL_GIT_PREVIOUS_SHA = previousSha
  return spawnSync('sh', ['-c', ignoreCommand], { cwd: join(repo, 'packages', 'ops'), env }).status ?? -1
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ops-ignore-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(repo, 'packages', 'ops', 'scripts'), { recursive: true })
  copyFileSync(join(PACKAGE_ROOT, 'scripts', 'vercel-ignore-build.sh'), join(repo, SCRIPT))
  commit('packages/frontend/page.tsx')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('ops Vercel ignore step (#3591)', () => {
  it('skips when nothing the console builds from changed since the last deployment', () => {
    const deployed = commit('packages/ops/src/a.ts')
    commit('packages/frontend/page.tsx')
    commit('docs/guide.md')
    expect(ignoreStep(deployed)).toBe(0)
  })

  it('builds an ops change even when an unrelated commit landed on top (the #3591 bug)', () => {
    const deployed = commit('packages/frontend/page.tsx')
    commit('packages/ops/src/middleware.ts') // the fix whose own build was lost
    commit('packages/frontend/page.tsx') // the newer, unrelated tip of dev
    expect(ignoreStep(deployed)).not.toBe(0)
  })

  it.each(['packages/ops/src/x.ts', 'packages/ui/src/Button.tsx', 'packages/core/src/chains.ts', 'scripts/docs/gen.mjs'])(
    'builds when %s changed since the last deployment',
    (path) => {
      const deployed = commit('packages/frontend/page.tsx')
      commit(path)
      expect(ignoreStep(deployed)).not.toBe(0)
    },
  )

  it('builds when no previous deployment is recorded', () => {
    commit('packages/frontend/page.tsx')
    expect(ignoreStep(undefined)).not.toBe(0)
    expect(ignoreStep('')).not.toBe(0)
  })

  it('builds when the previous deployment is not in the clone (a shallow clone, or garbage)', () => {
    commit('packages/frontend/page.tsx')
    expect(ignoreStep('0123456789abcdef0123456789abcdef01234567')).not.toBe(0)
    expect(ignoreStep('not-a-sha; exit 0')).not.toBe(0)
  })
})
