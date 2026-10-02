// @vitest-environment node
/**
 * The ops Vercel project's Ignored Build Step (#3591, moved to the shared
 * `scripts/vercel/ignore-build.sh` by #3594). Runs the REAL `ignoreCommand`
 * from this package's `vercel.json`, through `sh -c` as Vercel does, inside a
 * throwaway git repo that carries a copy of the script. Exit 0 = Vercel skips
 * the build; anything else = it builds. The frontend project's test
 * (packages/frontend/src/lib/__tests__/vercel-ignore-build.test.ts) runs the
 * same script with its own list.
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BUILD,
  SKIP,
  makeRepo,
  parseIgnoreCommand,
  readIgnoreCommand,
  rmSync,
} from '../../../../scripts/vercel/ignore-build-harness.mjs'

const PACKAGE_ROOT = join(__dirname, '..', '..')
const ignoreCommand: string = readIgnoreCommand(PACKAGE_ROOT)

let r: ReturnType<typeof makeRepo>

beforeEach(() => {
  r = makeRepo({ project: 'ops', command: ignoreCommand })
})

afterEach(() => {
  r.cleanup()
})

describe('ops Vercel ignore step (#3591, #3594)', () => {
  it('passes the shared script the force variable and the watched list', () => {
    const { forceVariable, watched } = parseIgnoreCommand(ignoreCommand)
    expect(forceVariable).toBe('OPS_FORCE_BUILD')
    expect(watched).toEqual(
      expect.arrayContaining([
        'packages/ops',
        'packages/ui',
        'packages/core',
        'scripts/docs',
        // #3594: core's build reads the base tsconfig, and a lockfile-only
        // bump of `next` must rebuild the console.
        'tsconfig.base.json',
        'package.json',
        'package-lock.json',
        '.nvmrc',
      ]),
    )
  })

  it('skips when nothing the console builds from changed since the last deployment', () => {
    const deployed = r.commit('packages/ops/src/a.ts')
    r.commit('packages/frontend/page.tsx')
    r.commit('docs/guide.md')
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(SKIP)
  })

  it('builds an ops change even when an unrelated commit landed on top (the #3591 bug)', () => {
    const deployed = r.commit('packages/frontend/page.tsx')
    r.commit('packages/ops/src/middleware.ts') // the fix whose own build was lost
    r.commit('packages/frontend/page.tsx') // the newer, unrelated tip of dev
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(BUILD)
  })

  it.each([
    'packages/ops/src/x.ts',
    'packages/ui/src/Button.tsx',
    'packages/core/src/chains.ts',
    'scripts/docs/gen.mjs',
    'tsconfig.base.json',
    'package.json',
    'package-lock.json',
    '.nvmrc',
  ])('builds when %s changed since the last deployment', (path) => {
    const deployed = r.commit('packages/frontend/page.tsx')
    r.commit(path)
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(BUILD)
  })

  it('builds when no previous deployment is recorded, in production or with VERCEL_ENV unset', () => {
    r.commit('packages/frontend/page.tsx')
    expect(r.run({})).toBe(BUILD)
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: '' })).toBe(BUILD)
    expect(r.run({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' })).toBe(BUILD)
  })

  it('builds when the previous deployment is unknown, or garbage', () => {
    r.commit('packages/frontend/page.tsx')
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: '0123456789abcdef0123456789abcdef01234567' })).toBe(BUILD)
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: 'not-a-sha; exit 0' })).toBe(BUILD)
  })

  it('builds when the previous deployment is missing from a real shallow clone', () => {
    const deployed = r.commit('packages/frontend/page.tsx')
    r.commit('docs/a.md')
    r.commit('docs/b.md')
    const shallow = r.shallowClone()
    try {
      // Nothing the console builds from changed, yet the deployed commit is
      // not in the clone, so the step cannot prove that, and must build.
      expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed }, shallow)).toBe(BUILD)
    } finally {
      rmSync(shallow, { recursive: true, force: true })
    }
  })

  describe('a PR branch with no previous deployment compares with its merge base with dev (#3594)', () => {
    const preview = (ref = 'feature') => ({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: ref })

    it('skips a branch that changed nothing watched', () => {
      r.commit('packages/ops/src/a.ts') // on dev, before the branch
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('packages/frontend/page.tsx')
      r.commit('docs/guide.md')
      expect(r.run(preview())).toBe(SKIP)
    })

    it('builds a branch that changed a watched path, even under a newer unrelated commit (the #3591 shape)', () => {
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('packages/ui/src/Card.tsx')
      r.commit('docs/guide.md') // the newest push is docs-only
      expect(r.run(preview())).toBe(BUILD)
    })

    it('builds when the clone has no merge base with dev', () => {
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('docs/guide.md')
      const shallow = r.shallowClone() // depth 1, the branch only: no dev ref
      try {
        expect(r.run(preview(), shallow)).toBe(BUILD)
      } finally {
        rmSync(shallow, { recursive: true, force: true })
      }
    })

    it('never applies to the dev or main branches, whose deployments must never be stale', () => {
      r.commit('docs/guide.md')
      expect(r.run(preview('dev'))).toBe(BUILD)
      expect(r.run(preview('main'))).toBe(BUILD)
    })

    it('a later preview push uses the previous deployment, not the merge base', () => {
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('packages/ops/src/a.ts')
      const deployed = r.commit('docs/guide.md')
      r.commit('docs/more.md')
      expect(r.run({ ...preview(), VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(SKIP)
    })
  })

  it('OPS_FORCE_BUILD=1 builds an unchanged commit (an env-only change needs a rebuild)', () => {
    const deployed = r.commit('packages/frontend/page.tsx')
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(SKIP)
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed, OPS_FORCE_BUILD: '1' })).toBe(BUILD)
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed, OPS_FORCE_BUILD: '0' })).toBe(SKIP)
    // The other project's force variable does not force this one.
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed, FRONTEND_FORCE_BUILD: '1' })).toBe(SKIP)
  })
})
