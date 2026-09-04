import { type NextRequest } from 'next/server'
import { buildRobotsTxt, originFrom } from '@/lib/discovery-surfaces'

/**
 * `/robots.txt`, generated rather than static (#2521).
 *
 * The robots spec requires `Sitemap:` to be a fully-qualified URL, and epic
 * #2519's invariant forbids hardcoding a host — so the origin comes off the
 * request and the dev preview, production and any future custom domain each
 * emit their own correct absolute URL with no configuration.
 */
export const dynamic = 'force-dynamic'

export function GET(request: NextRequest): Response {
  const origin = originFrom(
    request.nextUrl,
    request.headers.get('x-forwarded-host'),
    request.headers.get('x-forwarded-proto'),
  )
  return new Response(buildRobotsTxt(origin), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
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
