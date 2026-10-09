/**
 * The haven-ai-frontend Vercel project's Ignored Build Step (#3594). Two halves:
 *
 *  1. The PATH GUARD. The watched list is read from the watch file the
 *     `ignoreCommand` in this package's `vercel.json` names (the copy Vercel
 *     runs) and checked against what
 *     the build actually reads, each input derived from its own source: the
 *     served docs from `scripts/serve-docs.mjs`'s ALLOWLIST, the workspace
 *     packages from `package.json` and `next.config.ts`. A missing input would
 *     let a change that alters the deployed site skip its build.
 *  2. The RULE, run for real: the shared `scripts/vercel/ignore-build.sh`
 *     through `sh -c`, inside a throwaway git repo. The rule's general cases
 *     are covered in packages/ops/src/__tests__/vercel-ignore-build.test.ts;
 *     these are the frontend's own.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALLOWLIST } from '../../../scripts/serve-docs.mjs'
import {
  BUILD,
  SKIP,
  globToRegExp,
  isWatched as isWatchedBy,
  makeRepo,
  parseIgnoreCommand,
  readIgnoreCommand,
  rmSync,
} from '../../../../../scripts/vercel/ignore-build-harness.mjs'

const FRONTEND = join(__dirname, '..', '..', '..')
const ignoreCommand: string = readIgnoreCommand(FRONTEND)
const { forceVariable, watched } = parseIgnoreCommand(ignoreCommand) as { forceVariable: string; watched: string[] }

/** Whether a change to `path` (repo-relative) rebuilds the site: an include matches it and no `!` exclude does. */
function isWatched(path: string): boolean {
  return isWatchedBy(watched, path)
}

describe('frontend Vercel ignore step — the watched list covers every build input (#3594)', () => {
  it('names its own force variable', () => {
    expect(forceVariable).toBe('FRONTEND_FORCE_BUILD')
  })

  it('watches the frontend package itself', () => {
    expect(isWatched('packages/frontend/src/app/page.tsx')).toBe(true)
  })

  it('watches every served doc (next.config.ts copies them into public/docs at build time)', () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0)
    for (const { source } of ALLOWLIST as ReadonlyArray<{ source: string }>) {
      expect(isWatched(source), source).toBe(true)
    }
  })

  it('watches every @haven_ai workspace package the frontend depends on', () => {
    const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8'))
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => name.startsWith('@haven_ai/'))
    expect(deps.length).toBeGreaterThan(0)
    for (const name of deps) {
      const dir = `packages/${name.slice('@haven_ai/'.length)}`
      expect(isWatched(`${dir}/src/index.ts`), name).toBe(true)
    }
  })

  it('watches every package next.config.ts transpiles', () => {
    const config = readFileSync(join(FRONTEND, 'next.config.ts'), 'utf8')
    const match = config.match(/transpilePackages:\s*\[([^\]]*)\]/)
    expect(match, 'transpilePackages not found in next.config.ts').not.toBeNull()
    const names = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(isWatched(`packages/${name.replace(/^@haven_ai\//, '')}/src/index.ts`), name).toBe(true)
    }
  })

  it('watches every tsconfig the watched packages extend outside themselves', () => {
    const extended = new Set<string>()
    for (const pkg of ['frontend', 'core', 'ui']) {
      const config = JSON.parse(readFileSync(join(FRONTEND, '..', pkg, 'tsconfig.json'), 'utf8'))
      if (typeof config.extends === 'string' && config.extends.startsWith('../../')) {
        extended.add(config.extends.slice('../../'.length))
      }
    }
    expect([...extended]).toContain('tsconfig.base.json')
    for (const path of extended) expect(isWatched(path), path).toBe(true)
  })

  it('watches the root install inputs', () => {
    for (const path of ['package.json', 'package-lock.json', '.nvmrc']) {
      expect(isWatched(path), path).toBe(true)
    }
  })

  it('excludes only tests and screenshots, never a file the build reads (#3681)', () => {
    expect(watched.filter((entry) => entry.startsWith('!'))).toEqual([
      '!packages/frontend/e2e/**',
      '!packages/**/__tests__/**',
      '!packages/**/*.test.*',
    ])
    for (const path of [
      'packages/frontend/src/app/page.tsx',
      'packages/frontend/src/lib/testing.ts',
      'packages/frontend/next.config.ts',
      'packages/frontend/playwright.config.ts',
      'packages/ui/src/Button.tsx',
      'packages/core/src/chains.ts',
    ]) {
      expect(isWatched(path), path).toBe(true)
    }
  })

  it('no file the build reads imports an excluded one (#3681)', () => {
    const root = join(FRONTEND, '..', '..')
    const files = execFileSync('git', ['ls-files', 'packages/frontend/src', 'packages/frontend/scripts', 'packages/frontend/next.config.ts', 'packages/ui/src', 'packages/core/src'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((path) => /\.(tsx?|mjs|js)$/.test(path) && isWatched(path))
    expect(files.length).toBeGreaterThan(100)
    const offenders = files.filter((path) =>
      /(?:from|import|import\(|require\()\s*['"][^'"]*(?:\/e2e\/|__tests__|\.test)[^'"]*['"]/.test(readFileSync(join(root, path), 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('keeps the ignore command short: Vercel caps its length, so the list lives in the watch file', () => {
    expect(parseIgnoreCommand(ignoreCommand).watchFile).toBe('scripts/vercel/watch/frontend.txt')
    expect(ignoreCommand.length).toBeLessThan(256)
  })
})

describe('frontend Vercel ignore step — the rule (#3594)', () => {
  let r: ReturnType<typeof makeRepo>

  beforeEach(() => {
    r = makeRepo({ project: 'frontend', command: ignoreCommand })
  })

  afterEach(() => {
    r.cleanup()
  })

  it('skips a deploy when only backend, CI or unserved docs changed', () => {
    const deployed = r.commit('packages/frontend/src/app/page.tsx')
    r.commit('packages/backend/src/routes/payments.ts')
    r.commit('.github/workflows/ci.yml')
    r.commit('docs/operations/runbook.md')
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(SKIP)
  })

  it('builds when one served doc changed (case f)', () => {
    const deployed = r.commit('packages/frontend/src/app/page.tsx')
    r.commit('docs/product/agent-passport.md')
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(BUILD)
  })

  it('builds when the shared UI package changed', () => {
    const deployed = r.commit('packages/frontend/src/app/page.tsx')
    r.commit('packages/ui/src/Button.tsx')
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(BUILD)
  })

  it('the dev host never skips without a previous deployment (case g)', () => {
    r.commit('docs/operations/runbook.md')
    expect(r.run({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'dev' })).toBe(BUILD)
  })

  it('a preview/* branch with a frontend change builds even when its newest push is docs-only (case i)', () => {
    r.git('checkout', '-q', '-b', 'preview/x')
    r.commit('packages/frontend/src/app/page.tsx')
    r.commit('docs/operations/runbook.md')
    expect(r.run({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'preview/x' })).toBe(BUILD)
  })

  it('production, or a preview with no dev history it can find, builds (case k)', () => {
    r.git('checkout', '-q', '-b', 'preview/z')
    r.commit('packages/backend/src/routes/payments.ts')
    expect(r.run({ VERCEL_ENV: 'production' })).toBe(BUILD)
    const shallow = r.shallowClone()
    try {
      expect(r.run({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'preview/z' }, shallow)).toBe(BUILD)
    } finally {
      rmSync(shallow, { recursive: true, force: true })
    }
  })

  it('a backend-only preview/* branch spends no build on its first preview (case j; the skipped deployment still counts toward the cap, #3681)', () => {
    r.git('checkout', '-q', '-b', 'preview/y')
    r.commit('packages/backend/src/routes/payments.ts')
    expect(r.run({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'preview/y' })).toBe(SKIP)
  })

  it('skips when only Playwright screenshots or specs changed (#3681)', () => {
    const deployed = r.commit('packages/frontend/src/app/page.tsx')
    r.commit('packages/frontend/e2e/visual/home.spec.ts-snapshots/home-chromium-linux.png')
    r.commit('packages/frontend/e2e/visual/home.spec.ts')
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(SKIP)
  })

  it('skips when only unit tests changed, in the frontend, ui or core (#3681)', () => {
    const deployed = r.commit('packages/frontend/src/app/page.tsx')
    r.commit('packages/frontend/src/components/__tests__/Header.test.tsx')
    r.commit('packages/ui/src/__tests__/Button.test.tsx')
    r.commit('packages/core/src/chains.test.ts')
    r.commit('packages/frontend/src/__tests__/setup.ts') // not test-named: excluded by the __tests__ glob alone
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(SKIP)
  })

  it('builds when a test changed alongside a page (#3681)', () => {
    const deployed = r.commit('packages/frontend/src/app/page.tsx')
    r.commit('packages/frontend/src/components/__tests__/Header.test.tsx')
    r.commit('packages/frontend/src/app/page.tsx')
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(BUILD)
  })

  it('a PR that changes only tests spends no build on its first preview (#3681)', () => {
    r.git('checkout', '-q', '-b', 'feat/t')
    r.commit('packages/frontend/e2e/visual/home.spec.ts-snapshots/home-chromium-linux.png')
    r.commit('packages/frontend/src/lib/__tests__/x.test.ts')
    expect(r.run({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'feat/t' })).toBe(SKIP)
  })

  it.each([
    'packages/frontend/e2e/a/b.png',
    'packages/frontend/e2e.ts',
    'packages/frontend/src/__tests__/a.ts',
    'packages/frontend/src/a/__tests__/b/c.tsx',
    'packages/ui/src/x.test.ts',
    'packages/frontend/src/lib/testing.ts',
    'packages/frontend/src/app/page.tsx',
    'packages/frontendx/a.ts',
    // `*` must stay inside one directory (glob magic): without it git's `*`
    // crosses `/` and `*.test.*` would exclude this real source file.
    'packages/frontend/src/a.test.d/b.ts',
  ])('the harness and the script agree on %s (#3681)', (path) => {
    const deployed = r.commit('packages/backend/a.ts')
    r.commit(path)
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(isWatched(path) ? BUILD : SKIP)
  })

  it('FRONTEND_FORCE_BUILD=1 builds an unchanged commit (case h)', () => {
    const deployed = r.commit('packages/frontend/src/app/page.tsx')
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(SKIP)
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed, FRONTEND_FORCE_BUILD: '1' })).toBe(BUILD)
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed, OPS_FORCE_BUILD: '1' })).toBe(SKIP)
  })
})

/**
 * #3821: every push to any branch created a frontend deployment, a skipped one
 * included, and those count toward Vercel Hobby's daily cap of 100. Only `dev`
 * (the dev host), `main` (production) and opt-in `preview/*` branches deploy.
 * Vercel deploys a branch when ANY `true` rule matches it, and deploys a branch
 * that matches no rule.
 */
describe('frontend Vercel project deploys dev, main and preview/* only (#3821)', () => {
  const config = JSON.parse(readFileSync(join(FRONTEND, 'vercel.json'), 'utf8'))
  const rules = Object.entries(config.git?.deploymentEnabled ?? {}) as Array<[string, boolean]>
  const deploys = (branch: string) => {
    const matched = rules.filter(([glob]) => globToRegExp(glob).test(branch))
    return matched.length === 0 || matched.some(([, on]) => on === true)
  }

  it('turns every branch off and dev, main and preview/** on', () => {
    expect(config.git.deploymentEnabled).toEqual({ '**': false, dev: true, main: true, 'preview/**': true })
  })

  it.each([
    ['dev', true],
    ['main', true],
    ['preview/foo', true],
    ['preview/a/b', true],
    ['feat/1234-x', false],
    ['release/0.10.0', false],
    ['hotfix/x', false],
    ['previews', false],
    ['development', false],
  ])('branch %s deploys: %s', (branch, expected) => {
    expect(deploys(branch)).toBe(expected)
  })
})
