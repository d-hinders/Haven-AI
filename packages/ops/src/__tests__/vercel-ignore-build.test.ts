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
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BUILD,
  SKIP,
  globToRegExp,
  hermeticEnv,
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
  it('passes the shared script the force variable and the watch file, and the file lists the console inputs', () => {
    const { forceVariable, watchFile, watched } = parseIgnoreCommand(ignoreCommand)
    expect(forceVariable).toBe('OPS_FORCE_BUILD')
    expect(watchFile).toBe('scripts/vercel/watch/ops.txt')
    // Vercel's project settings cap the ignore command's length; the list lives
    // in the watch file so the command stays short (#3594 review).
    expect(ignoreCommand.length).toBeLessThan(256)
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
    // #3681 added `!` excludes for the frontend only; the console's list has none.
    expect(watched.filter((entry: string) => entry.startsWith('!'))).toEqual([])
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
    expect(r.run({ VERCEL_ENV: '' })).toBe(BUILD)
    // Production builds on its own, whatever the branch: not because of the
    // dev/main exception.
    expect(r.run({ VERCEL_ENV: 'production' })).toBe(BUILD)
    expect(r.run({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'feat/x' })).toBe(BUILD)
    expect(r.run({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' })).toBe(BUILD)
  })

  it('builds when the watch file is missing', () => {
    const deployed = r.commit('packages/frontend/page.tsx')
    r.git('rm', '-q', 'scripts/vercel/watch/ops.txt')
    r.git('commit', '-q', '-m', 'drop the watch file')
    expect(r.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(BUILD)
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

    it('builds when the clone has no merge base with dev and cannot fetch one (case k)', () => {
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('docs/guide.md')
      const shallow = r.shallowClone() // depth 1, the branch only, no origin: no dev ref
      try {
        expect(r.run(preview(), shallow)).toBe(BUILD)
      } finally {
        rmSync(shallow, { recursive: true, force: true })
      }
    })

    it('fetches dev when the clone holds the deployed branch only, as Vercel clones it', () => {
      r.commit('packages/ops/src/a.ts') // on dev, before the branch
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('docs/guide.md')
      const unchanged = r.shallowClone({ withOrigin: true, depth: 3 })
      r.commit('packages/ops/src/b.ts')
      const changed = r.shallowClone({ withOrigin: true, depth: 3 })
      try {
        expect(r.run(preview(), unchanged)).toBe(SKIP)
        expect(r.run(preview(), changed)).toBe(BUILD)
      } finally {
        rmSync(unchanged, { recursive: true, force: true })
        rmSync(changed, { recursive: true, force: true })
      }
    })

    // The first build log after #3601 (PR #3622's first preview, #3594) read
    // "no merge base with dev found (none in the clone, and fetching dev failed
    // or shares no commit)": these cases cover each cause it lumped together.
    const withClone = (opts: { withOrigin?: boolean; depth?: number }, body: (dir: string) => void) => {
      const dir = r.shallowClone(opts)
      try {
        body(dir)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it('fetches dev from the public repository URL when the clone has no origin', () => {
      r.commit('packages/ops/src/a.ts') // on dev, before the branch
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('docs/guide.md')
      const url = { IGNORE_BUILD_DEV_URL: `file://${r.repo}` }
      withClone({ depth: 3 }, (dir) => expect(r.run({ ...preview(), ...url }, dir)).toBe(SKIP))
      r.commit('packages/ops/src/b.ts')
      withClone({ depth: 3 }, (dir) => expect(r.run({ ...preview(), ...url }, dir)).toBe(BUILD))
    })

    it('falls back to the public repository URL when fetching from origin fails', () => {
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('docs/guide.md')
      withClone({ withOrigin: true, depth: 3 }, (dir) => {
        execFileSync('git', ['remote', 'set-url', 'origin', `file://${dir}-gone`], { cwd: dir, env: hermeticEnv() })
        expect(r.run({ ...preview(), IGNORE_BUILD_DEV_URL: `file://${r.repo}` }, dir)).toBe(SKIP)
      })
    })

    it('derives that URL from Vercel\'s GitHub owner and slug', () => {
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('docs/guide.md')
      // Map the derived https URL onto the local repository, so the test
      // proves the exact URL the script asks for without the network.
      const mapped = {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.file://${r.repo}.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/acme/haven.git',
      }
      const vercel = { VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'acme', VERCEL_GIT_REPO_SLUG: 'haven' }
      withClone({ depth: 3 }, (dir) => expect(r.run({ ...preview(), ...vercel, ...mapped }, dir)).toBe(SKIP))
      // Another provider gets no URL, and says so.
      withClone({ depth: 3 }, (dir) => {
        const { status, log } = r.runLog({ ...preview(), ...vercel, ...mapped, VERCEL_GIT_PROVIDER: 'gitlab' }, dir)
        expect(status).toBe(BUILD)
        expect(log).toContain("no origin remote, and no public repository URL (provider 'gitlab', owner 'acme', slug 'haven')")
      })
    })

    it('deepens the clone once when the shallow histories share no commit', () => {
      r.commit('packages/ops/src/a.ts') // on dev, before the branch
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('docs/guide.md')
      r.commit('docs/more.md')
      // Depth 1: the clone holds the tip alone, so dev's fetched history and
      // the clone meet nowhere until the branch side is deepened.
      withClone({ withOrigin: true, depth: 1 }, (dir) => expect(r.run(preview(), dir)).toBe(SKIP))
      r.commit('packages/ops/src/b.ts')
      withClone({ withOrigin: true, depth: 1 }, (dir) => expect(r.run(preview(), dir)).toBe(BUILD))
    })

    it('deepens from the public repository URL when that is the source that answered', () => {
      r.commit('packages/ops/src/a.ts') // on dev, before the branch
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('docs/guide.md')
      r.commit('docs/more.md')
      const url = { IGNORE_BUILD_DEV_URL: `file://${r.repo}` }
      withClone({ depth: 1 }, (dir) => expect(r.run({ ...preview(), ...url }, dir)).toBe(SKIP))
    })

    it('ignores an override URL git would read as an option', () => {
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('docs/guide.md')
      withClone({ depth: 1 }, (dir) => {
        const { status, log } = r.runLog({ ...preview(), IGNORE_BUILD_DEV_URL: '--upload-pack=touch /tmp/x' }, dir)
        expect(status).toBe(BUILD)
        expect(log).toContain('no public repository URL')
      })
    })

    it('names the step that failed when it cannot find a merge base', () => {
      r.git('checkout', '-q', '-b', 'feature')
      r.commit('docs/guide.md')
      withClone({ depth: 1 }, (dir) => {
        const { status, log } = r.runLog(preview(), dir)
        expect(status).toBe(BUILD)
        expect(log).toContain('no dev ref in the clone, no origin remote, and no public repository URL')
      })
      withClone({ depth: 1 }, (dir) => {
        const { status, log } = r.runLog({ ...preview(), IGNORE_BUILD_DEV_URL: `file://${r.repo}-gone` }, dir)
        expect(status).toBe(BUILD)
        expect(log).toContain(`fetching dev failed from: file://${r.repo}-gone`)
      })
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

describe('exclude entries, on a synthetic watch list (#3681)', () => {
  let s: ReturnType<typeof makeRepo>
  const withList = (watchContent: string) => {
    s = makeRepo({ project: 'ops', command: ignoreCommand, watchContent })
    return s
  }
  afterEach(() => s?.cleanup())

  it('a `!` glob excludes matching files under an include, and only those', () => {
    const t = withList('packages/ops\n!packages/ops/**/__tests__/**\n')
    const deployed = t.commit('packages/ops/src/a.ts')
    t.commit('packages/ops/src/__tests__/setup.ts') // not test-named: the __tests__ glob alone excludes it
    expect(t.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(SKIP)
    t.commit('packages/ops/src/__testsx/a.ts')
    expect(t.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(BUILD)
  })

  it.each([
    ['a bare `!`', 'packages/ops\n!\n'],
    ['a `!` followed by whitespace', 'packages/ops\n! packages/ops/a\n'],
    ['excludes only', '!packages/ops/**/__tests__/**\n'],
  ])('builds on %s, which would otherwise skip every change', (_name, list) => {
    const t = withList(list)
    const deployed = t.commit('packages/backend/a.ts')
    t.commit('packages/ops/src/__tests__/b.ts') // each malformed list would skip this
    expect(t.run({ VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(BUILD)
  })
})

/**
 * #3681: every push to any branch used to create a haven-ops deployment, a
 * skipped one included, and skipped deployments count toward Vercel Hobby's
 * daily cap. A preview of the console cannot sign in anyway
 * (docs/operations/ops-console.md), so only `dev`, its Production Branch,
 * deploys. Vercel deploys a branch when ANY `true` rule matches it.
 */
describe('ops Vercel project deploys from dev only (#3681)', () => {
  const config = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'vercel.json'), 'utf8'))
  const rules = Object.entries(config.git?.deploymentEnabled ?? {}) as Array<[string, boolean]>
  // Vercel deploys a branch that matches no rule, so the `**: false` rule is
  // what keeps a feature branch from deploying.
  const deploys = (branch: string) => {
    const matched = rules.filter(([glob]) => globToRegExp(glob).test(branch))
    return matched.length === 0 || matched.some(([, on]) => on === true)
  }

  it('turns every branch off and dev on', () => {
    expect(config.git.deploymentEnabled).toEqual({ '**': false, dev: true })
  })

  it.each([
    ['dev', true],
    ['main', false],
    ['feat/1234-x', false],
    ['release/0.5.0', false],
    ['development', false],
  ])('branch %s deploys: %s', (branch, expected) => {
    expect(deploys(branch)).toBe(expected)
  })
})
