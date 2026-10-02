import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Link check for `/developers` and `/for-agents` (#3577, epic #3572).
 *
 * Neither page is in `public/`, so `.lychee.toml` (docs-only) never crawls
 * them. The `/demo` link test's resolver (`app/demo/__tests__/links.test.ts`)
 * accepts only `src/app<path>/page.tsx` and `public<path>`; these pages also
 * link to API routes and to the `/api/*` rewrite, so the resolver here knows
 * all three shapes.
 */
const FRONTEND_ROOT = join(__dirname, '..', '..', '..', '..', '..')

function read(relative: string): string {
  return readFileSync(join(FRONTEND_ROOT, relative), 'utf8')
}

function sourceOf(path: string): string | null {
  try {
    return read(path)
  } catch {
    return null
  }
}

const PAGES = [
  {
    name: '/developers',
    component: 'src/components/marketing/site/developers/DevelopersPage.tsx',
    // The page's hrefs live in its fixtures module too (REFERENCE_FILES).
    extraSources: ['src/components/marketing/site/developers/fixtures.ts'],
  },
  {
    name: '/for-agents',
    component: 'src/components/marketing/site/for-agents/ForAgentsPage.tsx',
    extraSources: [],
  },
] as const

/** Every `href="..."` value in a TSX source. These pages use plain hrefs. */
function hrefs(text: string): string[] {
  return [...text.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
}

/** Every `href: '...'` fixture value beside the JSX attributes above. */
function fixtureHrefs(text: string): string[] {
  return [...text.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1])
}

/**
 * An own-site path resolves to a real app route, a `route.ts` handler, a
 * public artifact, or the generated `/docs/*` files `scripts/serve-docs.mjs`
 * writes at build time (whose sources exist in the repo). The `/api/*`
 * rewrite (next.config.ts) makes any backend path answer, so `/api/...`
 * resolves by the rewrite itself.
 */
function ownSiteLinkResolves(path: string): boolean {
  const bare = path.split(/[?#]/)[0]
  if (bare === '/') return existsSync(join(FRONTEND_ROOT, 'src/app/page.tsx'))
  const candidates = [
    join(FRONTEND_ROOT, `src/app${bare}/page.tsx`),
    join(FRONTEND_ROOT, `src/app${bare}/route.ts`),
    join(FRONTEND_ROOT, `src/app${bare}.md/route.ts`),
    join(FRONTEND_ROOT, `public${bare}`),
  ]
  if (candidates.some((candidate) => existsSync(candidate))) return true
  // `/docs/<name>.md` is generated from repo docs at build (serve-docs.mjs);
  // resolve against the generator's ALLOWLIST source paths.
  if (bare.startsWith('/docs/')) {
    const serveDocs = sourceOf('packages/frontend/scripts/serve-docs.mjs')
    if (serveDocs) {
      const served = bare.replace(/^\/docs\//, '')
      const allowlisted = [...serveDocs.matchAll(/served:\s*'([^']+)'/g)].map((m) => m[1])
      if (allowlisted.includes(`${served}`)) return true
    }
  }
  // The /api/:path* rewrite targets the backend, which owns these paths.
  if (bare.startsWith('/api/')) return true
  return false
}

describe('the new public pages’ links resolve (#3577)', () => {
  for (const page of PAGES) {
    const sources = [page.component, ...page.extraSources].map(read).join('\n')
    const list = [...hrefs(sources), ...fixtureHrefs(sources)]
    it.each(list)(
      `${page.name}: %s is a real route, route handler, or public artifact`,
      (href) => {
        expect(href.startsWith('/') || href.startsWith('#'), `${href} is not own-site`).toBe(true)
        if (href.startsWith('#')) return
        expect(ownSiteLinkResolves(href), `${href} resolves to nothing`).toBe(true)
      },
    )

    it(`${page.name}: found own-site links (guard against a vacuous pass)`, () => {
      expect(list.length).toBeGreaterThan(0)
      expect(list.some((h) => h.startsWith('/'))).toBe(true)
    })
  }

  it('the /exit machine-readable link appears on /developers as the issue requires', () => {
    // The issue's /exit criterion: every machine-readable link resolves,
    // /exit among them. Pinned here so dropping the card cannot silently
    // drop the link.
    const developers = [PAGES[0].component, ...PAGES[0].extraSources].map(read).join('\n')
    expect([...hrefs(developers), ...fixtureHrefs(developers)]).toContain('/exit')
  })
})
