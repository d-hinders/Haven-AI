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
function ignoreStep(previousSha: string | undefined, vercelEnv?: string, root = repo): number {
  const env = { ...process.env }
  delete env.VERCEL_GIT_PREVIOUS_SHA
  delete env.VERCEL_ENV
  if (previousSha !== undefined) env.VERCEL_GIT_PREVIOUS_SHA = previousSha
  if (vercelEnv !== undefined) env.VERCEL_ENV = vercelEnv
  return spawnSync('sh', ['-c', ignoreCommand], { cwd: join(root, 'packages', 'ops'), env }).status ?? -1
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ops-ignore-'))
  git('init', '-q', '-b', 'dev')
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

  it('builds when the previous deployment is unknown, or garbage', () => {
    commit('packages/frontend/page.tsx')
    expect(ignoreStep('0123456789abcdef0123456789abcdef01234567')).not.toBe(0)
    expect(ignoreStep('not-a-sha; exit 0')).not.toBe(0)
  })

  it('builds when the previous deployment is missing from a real shallow clone', () => {
    const deployed = commit('packages/frontend/page.tsx')
    commit('docs/a.md')
    commit('docs/b.md')
    const shallow = mkdtempSync(join(tmpdir(), 'ops-ignore-shallow-'))
    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo}`, shallow])
      // Nothing the console builds from changed, yet the deployed commit is
      // not in the clone, so the step cannot prove that, and must build.
      expect(ignoreStep(deployed, undefined, shallow)).not.toBe(0)
    } finally {
      rmSync(shallow, { recursive: true, force: true })
    }
  })

  describe('a first preview (no previous deployment) falls back to the newest commit, to spare the deployment cap', () => {
    it('skips a preview whose newest commit does not touch the console', () => {
      commit('packages/ops/src/a.ts')
      commit('packages/frontend/page.tsx')
      expect(ignoreStep(undefined, 'preview')).toBe(0)
      expect(ignoreStep('', 'preview')).toBe(0)
    })

    it('builds a preview whose newest commit touches the console', () => {
      commit('packages/ui/src/Card.tsx')
      expect(ignoreStep(undefined, 'preview')).not.toBe(0)
    })

    it('never applies to production, or to an unset VERCEL_ENV', () => {
      commit('packages/ops/src/a.ts')
      commit('packages/frontend/page.tsx')
      expect(ignoreStep(undefined, 'production')).not.toBe(0)
      expect(ignoreStep(undefined)).not.toBe(0)
    })
  })
})
