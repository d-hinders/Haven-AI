/**
 * The haven-ai-frontend Vercel project's Ignored Build Step (#3594). Two halves:
 *
 *  1. The PATH GUARD. The watched list is read from the `ignoreCommand` in this
 *     package's `vercel.json` (the copy Vercel runs) and checked against what
 *     the build actually reads, each input derived from its own source: the
 *     served docs from `scripts/serve-docs.mjs`'s ALLOWLIST, the workspace
 *     packages from `package.json` and `next.config.ts`. A missing input would
 *     let a change that alters the deployed site skip its build.
 *  2. The RULE, run for real: the shared `scripts/vercel/ignore-build.sh`
 *     through `sh -c`, inside a throwaway git repo. The rule's general cases
 *     are covered in packages/ops/src/__tests__/vercel-ignore-build.test.ts;
 *     these are the frontend's own.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALLOWLIST } from '../../../scripts/serve-docs.mjs'
import {
  BUILD,
  SKIP,
  makeRepo,
  parseIgnoreCommand,
  readIgnoreCommand,
} from '../../../../../scripts/vercel/ignore-build-harness.mjs'

const FRONTEND = join(__dirname, '..', '..', '..')
const ignoreCommand: string = readIgnoreCommand(FRONTEND)
const { forceVariable, watched } = parseIgnoreCommand(ignoreCommand) as { forceVariable: string; watched: string[] }

/** Whether `path` (repo-relative) falls under a watched entry, as a git pathspec would match it. */
function isWatched(path: string): boolean {
  return watched.some((entry) => path === entry || path.startsWith(`${entry}/`))
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

  it('watches the base tsconfig the core and ui builds extend, and the root install inputs', () => {
    for (const path of ['tsconfig.base.json', 'package.json', 'package-lock.json', '.nvmrc']) {
      expect(isWatched(path), path).toBe(true)
    }
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

  it('a frontend PR gets a preview even when its newest push is docs-only (case i)', () => {
    r.git('checkout', '-q', '-b', 'feat/x')
    r.commit('packages/frontend/src/app/page.tsx')
    r.commit('docs/operations/runbook.md')
    expect(r.run({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'feat/x' })).toBe(BUILD)
  })

  it('a backend-only PR spends no deployment on its first preview (case j)', () => {
    r.git('checkout', '-q', '-b', 'feat/y')
    r.commit('packages/backend/src/routes/payments.ts')
    expect(r.run({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'feat/y' })).toBe(SKIP)
  })

  it('FRONTEND_FORCE_BUILD=1 builds an unchanged commit (case h)', () => {
    const deployed = r.commit('packages/frontend/src/app/page.tsx')
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(SKIP)
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed, FRONTEND_FORCE_BUILD: '1' })).toBe(BUILD)
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed, OPS_FORCE_BUILD: '1' })).toBe(SKIP)
  })
})
