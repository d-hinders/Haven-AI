import { type NextRequest } from 'next/server'
import { buildSitemapXml, originFrom } from '@/lib/discovery-surfaces'

/**
 * `/sitemap.xml`, generated for the same reason `/robots.txt` is (#2521): the
 * sitemap spec requires absolute `<loc>` URLs, and no host may be hardcoded.
 *
 * Public surfaces only — an authenticated route must never appear here, which
 * the guard test asserts against `AUTHENTICATED_PREFIXES`.
 */
export const dynamic = 'force-dynamic'

export function GET(request: NextRequest): Response {
  const origin = originFrom(
    request.nextUrl,
    request.headers.get('x-forwarded-host'),
    request.headers.get('x-forwarded-proto'),
  )
  return new Response(buildSitemapXml(origin), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      // Deliberately NOT shared-cacheable. The body embeds an origin derived
      // from `x-forwarded-host`, so an `s-maxage` window on a cache that does
      // not key on that header would let one spoofed request pin an attacker's
      // host into a crawler-facing `Sitemap:`/`<loc>` for the whole TTL. These
      // responses are a few hundred bytes of string concatenation; there is
      // nothing to buy by caching them.
      'cache-control': 'public, max-age=0, must-revalidate',
      vary: 'x-forwarded-host, x-forwarded-proto',
    },
  })
}
