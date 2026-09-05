import { type NextRequest } from 'next/server'
import { originFrom } from '@/lib/discovery-surfaces'
import { buildManifest, MANIFEST_SCHEMA_VERSION } from '@/lib/capability-manifest'

/**
 * `/.well-known/haven.json` — the capability manifest (#2531).
 *
 * `llms.txt` is prose for a model to read. This is the same environment as
 * DATA, for an agent's code: where to sign up, which steps only a human can
 * do, where the API and its spec are, which connector package this deployment
 * hands out, which chains it serves.
 *
 * Generated per request, never hand-maintained. The environment-dependent
 * values come from the backend's own `GET /discovery`, so a connector-channel
 * change (#2422) propagates here instead of being restated — a restated fact
 * is a fact that goes out of date on one surface and not the other.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<Response> {
  const origin = originFrom(
    request.nextUrl,
    request.headers.get('x-forwarded-host'),
    request.headers.get('x-forwarded-proto'),
  )
  const manifest = await buildManifest(origin)
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Same reasoning as robots.txt and sitemap.xml: the body embeds an
      // origin derived from `x-forwarded-host`, so a shared cache that does
      // not key on that header could pin one caller's host into a document
      // every other caller reads.
      'cache-control': 'public, max-age=0, must-revalidate',
      vary: 'x-forwarded-host, x-forwarded-proto',
      'x-haven-manifest-version': String(MANIFEST_SCHEMA_VERSION),
    },
  })
}
