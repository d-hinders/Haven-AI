import { type NextRequest } from 'next/server'
import { originFrom } from '@/lib/discovery-surfaces'
import { buildAgentSkillIndex } from '@/lib/agent-skill-index'

/**
 * `/.well-known/agent-skills/index.json` — the agent-skills index (#3596),
 * beside `/.well-known/haven.json`.
 *
 * The pattern is Circle's agent stack
 * (`https://agents.circle.com/.well-known/agent-skills/index.json`): one
 * small skill per step, each linking to the next. This document lists every
 * agent-readable document Haven serves — the onboarding runbook and its step
 * files (`/agent-skills/<step>.md`) — plus pointers to the capability
 * manifest, the OpenAPI spec and the hosted MCP URL.
 *
 * Generated per request from the same origin and discovery facts as
 * `haven.json` — see `agent-skill-index.ts` for why every URL here is
 * absolute (unlike the manifest's relative own-origin fields).
 *
 * Served on our own host only: no registry listing, no submission anywhere.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<Response> {
  const origin = originFrom(
    request.nextUrl,
    request.headers.get('x-forwarded-host'),
    request.headers.get('x-forwarded-proto'),
  )
  const index = await buildAgentSkillIndex(origin)
  return new Response(JSON.stringify(index, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Same reasoning as haven.json: the body embeds an origin derived from
      // `x-forwarded-host`, so a shared cache that does not key on that
      // header could pin one caller's host into a document every other
      // caller reads.
      'cache-control': 'public, max-age=0, must-revalidate',
      vary: 'x-forwarded-host, x-forwarded-proto',
    },
  })
}
