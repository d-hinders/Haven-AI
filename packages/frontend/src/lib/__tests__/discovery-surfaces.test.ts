import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUTHENTICATED_PREFIXES,
  AUTH_MARKED_PREFIXES,
  AUTH_MARKED_STANDALONE,
  AUTH_MARKER_CONTENT,
  AUTH_MARKER_NAME,
  PUBLIC_SURFACES,
  buildRobotsTxt,
  buildSitemapXml,
  originFrom,
} from '@/lib/discovery-surfaces'

const FRONTEND_ROOT = join(__dirname, '..', '..', '..')
const ORIGIN = 'https://example.test'

function read(relative: string): string {
  return readFileSync(join(FRONTEND_ROOT, relative), 'utf8')
}

/** A served artifact under `public/`, or null if the path is not one. */
function readPublic(servedPath: string): string | null {
  try {
    return readFileSync(join(FRONTEND_ROOT, 'public', servedPath.replace(/^\//, '')), 'utf8')
  } catch {
    return null
  }
}

/**
 * The discovery hooks of #2521. These guard the two failure modes the
 * 2026-09-04 cold test hit: an artifact nothing advertises, and an auth wall a
 * non-browser client reads as a public page.
 */
describe('public surfaces resolve to something that exists', () => {
  // A sitemap that lists a 404 is worse than no sitemap: it is a promise the
  // deployment does not keep. Each entry must be a real app route or a real
  // file under public/.
  it.each(PUBLIC_SURFACES)('%s is a real route or public artifact', (surface) => {
    const candidates =
      surface === '/'
        ? ['src/app/page.tsx']
        : [
            `src/app${surface}/page.tsx`, // an app route
            `public${surface}`, // a public file, e.g. /llms.txt
            `public${surface}/index.html`, // a public directory, e.g. /402 and /exit
          ]

    const found = candidates.some((candidate) => existsSync(join(FRONTEND_ROOT, candidate)))
    expect(found, `${surface} resolves to none of: ${candidates.join(', ')}`).toBe(true)
  })

  // The deployment 308-redirects the slashed form to the bare one, so a trailing
  // slash in the sitemap advertises a redirect instead of a document. Caught by
  // curling the dev preview, not by `next start`, which resolves static directory
  // indexes the other way round — hence a structural guard here as well.
  it('never carries a trailing slash', () => {
    for (const surface of PUBLIC_SURFACES) {
      if (surface === '/') continue
      expect(surface.endsWith('/'), `${surface} would 308 rather than 200`).toBe(false)
    }
  })

  it('never advertises an authenticated route', () => {
    // Widened to string deliberately: with the `as const` literals TypeScript
    // proves the comparison can never hold, and the point of the assertion is to
    // keep holding once someone edits either list.
    const publicSurfaces: readonly string[] = PUBLIC_SURFACES
    const authPrefixes: readonly string[] = AUTHENTICATED_PREFIXES
    for (const surface of publicSurfaces) {
      for (const prefix of authPrefixes) {
        expect(
          surface === prefix || surface.startsWith(`${prefix}/`),
          `${surface} is under the authenticated prefix ${prefix}`,
        ).toBe(false)
      }
    }
  })
})

describe('the authenticated prefix list is pinned to the filesystem', () => {
  // This is the guard that matters most here, because the failure is silent:
  // a new authenticated route simply goes un-disallowed and un-marked, and
  // nothing looks wrong. The issue specifying this work listed five prefixes;
  // the route group actually holds thirteen.
  const routeGroupSegments = readdirSync(join(FRONTEND_ROOT, 'src/app/(authenticated)'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/${entry.name}`)
    .sort()

  it('lists every segment of the (authenticated) route group', () => {
    expect([...AUTH_MARKED_PREFIXES].sort()).toEqual(routeGroupSegments)
  })

  it('claims no marked prefix that is not in the route group', () => {
    for (const prefix of AUTH_MARKED_PREFIXES) {
      expect(routeGroupSegments, `${prefix} is not a (authenticated) route`).toContain(prefix)
    }
  })

  it('every standalone marked route has its own layout emitting the marker', () => {
    for (const route of AUTH_MARKED_STANDALONE) {
      const layout = read(`src/app${route}/layout.tsx`)
      expect(layout).toContain('AUTH_MARKER_NAME')
      expect(layout).not.toContain("'use client'")
    }
  })

  it('robots disallows the marked routes and the standalone ones alike', () => {
    const all: readonly string[] = AUTHENTICATED_PREFIXES
    for (const prefix of [...AUTH_MARKED_PREFIXES, ...AUTH_MARKED_STANDALONE]) {
      expect(all).toContain(prefix)
    }
  })
})

describe('robots.txt', () => {
  it('allows crawling and carries an ABSOLUTE sitemap URL', () => {
    const robots = buildRobotsTxt(ORIGIN)
    expect(robots).toContain('User-agent: *')
    expect(robots).toContain('Allow: /')
    // The robots spec requires a fully-qualified Sitemap URL; a relative one is
    // silently ignored by crawlers, which is the same class of defect as A1's
    // dead hosts.
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`)
  })

  it('names the agent-readable artifacts, so they need no guessing', () => {
    const robots = buildRobotsTxt(ORIGIN)
    for (const artifact of ['/llms.txt', '/llms-full.txt', '/402.md', '/api/openapi.json']) {
      expect(robots).toContain(artifact)
    }
  })

  it('disallows every authenticated prefix', () => {
    const robots = buildRobotsTxt(ORIGIN)
    for (const prefix of AUTHENTICATED_PREFIXES) {
      expect(robots).toContain(`Disallow: ${prefix}`)
    }
  })

  it('hardcodes no host — every absolute URL is the origin it was given', () => {
    const robots = buildRobotsTxt(ORIGIN)
    const absolute = robots.match(/https?:\/\/[^\s]+/g) ?? []
    for (const url of absolute) {
      expect(url.startsWith(ORIGIN), `${url} is not on the request origin`).toBe(true)
    }
  })
})

describe('sitemap.xml', () => {
  it('lists every public surface as an absolute URL', () => {
    const xml = buildSitemapXml(ORIGIN)
    for (const surface of PUBLIC_SURFACES) {
      expect(xml).toContain(`<loc>${ORIGIN}${surface}</loc>`)
    }
  })

  it('lists nothing else', () => {
    const xml = buildSitemapXml(ORIGIN)
    expect(xml.match(/<loc>/g)?.length).toBe(PUBLIC_SURFACES.length)
  })

  it('hardcodes no host', () => {
    const xml = buildSitemapXml(ORIGIN)
    for (const url of xml.match(/https?:\/\/[^<\s]+/g) ?? []) {
      // The xmlns declaration is a namespace identifier, not a link.
      if (url.startsWith('http://www.sitemaps.org/')) continue
      expect(url.startsWith(ORIGIN), `${url} is not on the request origin`).toBe(true)
    }
  })
})

describe('originFrom', () => {
  it('prefers the forwarded host, so a proxied deployment reports its public origin', () => {
    expect(
      originFrom(new URL('http://internal:3000/robots.txt'), 'haven.example', 'https'),
    ).toBe('https://haven.example')
  })

  it('takes the first entry of a comma-joined forwarded header', () => {
    expect(
      originFrom(new URL('http://internal:3000/x'), 'first.example, second.example', 'https, http'),
    ).toBe('https://first.example')
  })

  it('defaults a forwarded host with no proto to https', () => {
    expect(originFrom(new URL('http://internal:3000/x'), 'haven.example', null)).toBe(
      'https://haven.example',
    )
  })

  it('falls back to the request origin when nothing is forwarded', () => {
    expect(originFrom(new URL('http://localhost:3000/robots.txt'), null, null)).toBe(
      'http://localhost:3000',
    )
  })
})

describe('the hooks are actually wired into the app', () => {
  it('the root layout advertises llms.txt and the OpenAPI spec with RELATIVE hrefs', () => {
    const layout = read('src/app/layout.tsx')
    expect(layout).toContain('rel="alternate"')
    expect(layout).toContain('href="/llms.txt"')
    expect(layout).toContain('href="/api/openapi.json"')
    // An absolute host here is the A1 defect (#2520) reintroduced one layer up:
    // it would be wrong on every deployment but the one it was written for.
    expect(layout).not.toMatch(/href="https?:\/\//)
  })

  /**
   * The CHAIN, not the links (#2538).
   *
   * Every assertion around this one checks a hook in isolation: the layout has
   * a `rel="alternate"`, the landing page has the sentence, the footer has the
   * item. None of them checks that following one ARRIVES anywhere, and
   * measuring the hooks turned up why that matters: all three point at the
   * same file, `/llms.txt`, so the entire "found it from the landing HTML
   * alone" route hangs on one link inside it. Delete that line and every test
   * in this file stays green while an agent handed the URL can no longer reach
   * the runbook without falling back to `robots.txt` or guessing.
   *
   * That is the regression the cold-agent scenario scores as band 3 -> 2
   * (`docs/operations/qa-explore-ui-cadence.md` § Second scenario). Scoring it
   * weekly in a report is worth having; catching it here is better.
   */
  it('a landing-HTML hook actually REACHES the agent runbook, not just some file', () => {
    const layout = read('src/app/layout.tsx')
    const page = read('src/app/page.tsx')
    const footer = read('src/components/marketing/SiteFooter.tsx')

    // Each hook's destination, taken from the hook rather than assumed.
    const destinations = [
      layout.match(/rel="alternate"[\s\S]{0,200}?href="(\/[^"]+)"/)?.[1],
      page.match(/If you are an AI agent[\s\S]{0,300}?href="(\/[^"]+)"/)?.[1],
      footer.match(/'For agents',\s*href: '(\/[^']+)'/)?.[1],
    ]
    for (const destination of destinations) {
      expect(destination, 'a landing hook lost its destination').toBeTruthy()
    }

    // Follow each one hop into the file it names, and require that at least
    // one of them names the runbook.
    //
    // A hook that points STRAIGHT at the runbook counts, and that case has to
    // be handled first: `/for-agents.md` does not contain its own path, so
    // reading its body and looking for the string would score a direct link as
    // "did not reach". That is the shape a future fix for the single point of
    // failure this test documents would most naturally take, so the test must
    // not fail the fix (haven-reviewer, #2538).
    const RUNBOOK = '/for-agents.md'
    const reached = destinations.filter((destination) => {
      if (destination === RUNBOOK) return true
      const body = readPublic(destination!)
      return body !== null && body.includes(RUNBOOK)
    })
    expect(
      reached.length,
      `no landing hook reaches /for-agents.md — followed ${destinations.join(', ')}`,
    ).toBeGreaterThan(0)
  })

  it('the landing page carries the agent sentence in server-rendered content', () => {
    const page = read('src/app/page.tsx')
    expect(page).not.toContain("'use client'")
    expect(page).toContain('If you are an AI agent reading this for your user')
    expect(page).toContain('href="/llms.txt"')
  })

  it('the footer links to the agent entry point', () => {
    const footer = read('src/components/marketing/SiteFooter.tsx')
    expect(footer).toContain('For agents')
    expect(footer).toContain("href: '/llms.txt'")
  })

  it('the authenticated layout is a server component that emits the auth marker', () => {
    const layout = read('src/app/(authenticated)/layout.tsx')
    expect(layout).not.toContain("'use client'")
    expect(layout).toContain('AUTH_MARKER_NAME')
    expect(layout).toContain('export const metadata')
    // The redirect is ProtectedRoute's job and must stay untouched by the split.
    expect(read('src/components/AuthenticatedShell.tsx')).toContain('<ProtectedRoute>')
  })

  it('middleware observes the two new discovery surfaces', () => {
    const middleware = read('src/middleware.ts')
    expect(middleware).toContain("'/robots.txt'")
    expect(middleware).toContain("'/sitemap.xml'")
  })
})

describe('the auth marker', () => {
  it('is the name a non-browser client is told to look for', () => {
    expect(AUTH_MARKER_NAME).toBe('haven:auth')
    expect(AUTH_MARKER_CONTENT).toBe('required')
  })
})
