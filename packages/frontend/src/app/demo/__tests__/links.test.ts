import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEMO_MD_CONTENT } from '@/lib/demo-md-content'

/**
 * Link check for `/demo` and `/demo.md` (#3477).
 *
 * Neither page is in `public/`, so `.lychee.toml` (docs-only) never crawls
 * them, and `discovery-artifacts.test.ts`'s `ARTIFACTS` list deliberately
 * excludes `/demo.md` (see its route handler's header comment) — so this is
 * the one place that checks these links resolve.
 */
const FRONTEND_ROOT = join(__dirname, '..', '..', '..', '..')
const PAGE_SOURCE = readFileSync(join(FRONTEND_ROOT, 'src/app/demo/page.tsx'), 'utf8')

const ALLOWED_OFFSITE_HOSTS = new Set(['faucet.circle.com', 'services.sandbox.ampersend.ai'])

/** Every `href="..."` value in a TSX/Markdown source, own-site or off-site. */
function hrefs(text: string): string[] {
  const jsxHrefs = [...text.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
  const mdHrefs = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1])
  return [...jsxHrefs, ...mdHrefs]
}

/** An own-site path resolves to a real route, a public artifact, or itself (/demo, /demo.md). */
function ownSiteLinkResolves(path: string): boolean {
  const bare = path.split(/[?#]/)[0]
  if (bare === '/') return existsSync(join(FRONTEND_ROOT, 'src/app/page.tsx'))
  if (bare === '/demo') return existsSync(join(FRONTEND_ROOT, 'src/app/demo/page.tsx'))
  if (bare === '/demo.md') return existsSync(join(FRONTEND_ROOT, 'src/app/demo.md/route.ts'))
  const candidates = [
    join(FRONTEND_ROOT, `src/app${bare}/page.tsx`),
    join(FRONTEND_ROOT, `public${bare}`),
  ]
  return candidates.some((candidate) => existsSync(candidate))
}

describe('/demo and /demo.md links resolve (#3477)', () => {
  it.each(hrefs(PAGE_SOURCE))('/demo: %s is a real route, a public artifact, or an allow-listed off-site host', (href) => {
    if (href.startsWith('http')) {
      const hostname = new URL(href).hostname
      expect(ALLOWED_OFFSITE_HOSTS.has(hostname), `${href} is not allow-listed`).toBe(true)
      return
    }
    expect(ownSiteLinkResolves(href), `${href} resolves to nothing`).toBe(true)
  })

  it.each(hrefs(DEMO_MD_CONTENT))(
    '/demo.md: %s is a real route, a public artifact, or an allow-listed off-site host',
    (href) => {
      if (href.startsWith('http')) {
        const hostname = new URL(href).hostname
        expect(ALLOWED_OFFSITE_HOSTS.has(hostname), `${href} is not allow-listed`).toBe(true)
        return
      }
      expect(ownSiteLinkResolves(href), `${href} resolves to nothing`).toBe(true)
    },
  )

  it('found at least one own-site link in each, and at least one off-site link overall (guard against a vacuous pass)', () => {
    // Per-file, not just combined, for own-site links: each of these pages
    // must itself navigate somewhere on this site.
    for (const [name, hrefList] of [
      ['page', hrefs(PAGE_SOURCE)],
      ['demo.md', hrefs(DEMO_MD_CONTENT)],
    ] as const) {
      expect(hrefList.length, name).toBeGreaterThan(0)
      expect(hrefList.some((h) => h.startsWith('/')), `${name}: no own-site link found`).toBe(true)
    }
    // Off-site is checked COMBINED across both files, not per-file: both name
    // Circle's faucet, and only `/demo.md` names Ampersend.
    const allHrefs = [...hrefs(PAGE_SOURCE), ...hrefs(DEMO_MD_CONTENT)]
    expect(allHrefs.some((h) => h.startsWith('http')), 'no off-site link found in either file').toBe(true)
  })
})
