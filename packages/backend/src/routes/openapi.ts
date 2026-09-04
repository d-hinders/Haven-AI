import { FastifyInstance } from 'fastify'
import { openapiSpec } from '../openapi/spec.js'
import { apiBaseUrl } from '../domain/request-origin.js'

/**
 * The served OpenAPI document (#2530).
 *
 * `servers[0]` is derived from the request rather than read from the static
 * spec. The static list named the production Railway host first, always — so
 * the DEV backend served a spec telling clients to call production, and a
 * client that fetched the spec through the frontend's `/api` proxy was told to
 * call an origin that serves the marketing site. Both were measured on the
 * dev preview, not hypothesised.
 *
 * Production stays listed, as the documented second entry: a human reading the
 * spec from a preview still needs to see where the real API is.
 *
 * A deployment fronted by the frontend's `/api` proxy sets `HAVEN_API_URL` to
 * the full public URL including that prefix. The prefix cannot be derived
 * here — the rewrite strips it before the backend sees the path — and
 * `request-origin.ts` records why guessing was removed rather than kept. The static
 * `servers` list in `spec.ts` remains the source of those documented entries;
 * this route prepends the live one and de-duplicates, so the same host is
 * never listed twice when the spec IS being served from production.
 *
 * Cache-control drops from the previous `max-age=300` to `no-cache` with a
 * `Vary`: the body now depends on how the request arrived, and a shared cache
 * that does not key on that would hand one caller another caller's origin.
 */
export default async function openapiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/openapi.json', async (request, reply) => {
    const live = apiBaseUrl(request.headers)
    const documented = openapiSpec.servers.filter((entry) => entry.url !== live)
    return reply
      .header('cache-control', 'public, max-age=0, must-revalidate')
      .header('vary', 'host, x-forwarded-proto, x-forwarded-host')
      .send({
        ...openapiSpec,
        servers: [{ url: live, description: 'This deployment, as reached by your request' }, ...documented],
      })
  })
}
