import { FastifyInstance, FastifyRequest } from 'fastify'
import {
  CONNECTOR_PACKAGE,
  HostedMcpConfigError,
  apiBaseUrl,
  hostedMcpUrl,
} from './agent-connection-setups.js'
import { deployableChainIds, SUPPORTED_CHAIN_IDS } from '../domain/chains.js'

/**
 * `GET /discovery` — the public, read-only facts an agent's CODE needs (#2531).
 *
 * `llms.txt` is prose for a model. This is the same environment described as
 * data, and it exists so the frontend's `/.well-known/haven.json` manifest does
 * not duplicate the backend's env logic: which connector channel this
 * deployment hands out (#2422), which hosted MCP it points at, which chains it
 * serves. Duplicating that in the frontend would mean a channel change
 * propagating to one surface and not the other, which is the same class of
 * defect as a doc that stops being true.
 *
 * ## What is deliberately NOT here
 *
 * No per-user or per-agent data, no relayer address, and nothing from
 * `/health`. Every value below is already public somewhere else — the
 * connector package is printed in every setup handout, the chain list is
 * `GET /chains`, and the hosted MCP URL is handed to every connecting agent.
 * This route re-serves them together; it does not widen what is public. A test
 * enumerates the keys so adding one is a decision rather than a side effect.
 */
export interface DiscoveryDocument {
  hosted_mcp_url: string | null
  /** Why `hosted_mcp_url` is null, when it is. Absent otherwise. */
  hosted_mcp_note?: string
  connector_package: string
  openapi_url: string
  chains: { deployable: number[]; supported: readonly number[] }
}

export function buildDiscoveryDocument(request: FastifyRequest): DiscoveryDocument {
  const base = apiBaseUrl(request)

  // `hostedMcpUrl` THROWS for a non-production backend with no
  // HAVEN_HOSTED_MCP_URL — the right behaviour for a connect handout, which
  // must not invent another environment's URL. It is the wrong behaviour here:
  // a discovery document that 500s tells an agent nothing, while one that says
  // "this deployment has no hosted MCP, connect with --local" tells it exactly
  // what to do next. The refusal is reported, not propagated.
  let hostedMcp: string | null = null
  let note: string | undefined
  try {
    hostedMcp = hostedMcpUrl(request)
  } catch (err) {
    if (!(err instanceof HostedMcpConfigError)) throw err
    note = 'This deployment has no hosted MCP configured. Connect with --local, or ask its operator to set HAVEN_HOSTED_MCP_URL.'
  }

  return {
    hosted_mcp_url: hostedMcp,
    ...(note ? { hosted_mcp_note: note } : {}),
    connector_package: CONNECTOR_PACKAGE,
    openapi_url: `${base}/openapi.json`,
    chains: { deployable: deployableChainIds(), supported: SUPPORTED_CHAIN_IDS },
  }
}

export default async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/discovery', async (request, reply) => {
    return reply
      // The body depends on how the request arrived (the origin is derived), so
      // a shared cache that does not key on that could hand one caller another
      // caller's host. Same reasoning as the served OpenAPI document.
      .header('cache-control', 'public, max-age=0, must-revalidate')
      .header('vary', 'host, x-forwarded-proto, x-forwarded-host')
      .send(buildDiscoveryDocument(request))
  })
}
