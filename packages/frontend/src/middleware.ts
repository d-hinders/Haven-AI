import { NextResponse, type NextRequest } from 'next/server'
import { classifyAgentUserAgent } from './lib/discovery'

/**
 * Discovery-surface fetch log (#2302, Agent Discovery GTM track).
 *
 * The AEO artifacts (`/llms.txt`, `/llms-full.txt`, `/402`, `/402.md`) are
 * static files in `public/`, so the backend never sees a request for them —
 * this middleware is the only place a fetch can be observed. When the
 * User-Agent classifies as a known AI agent/crawler family, emit ONE
 * structured log line and pass the request through untouched.
 *
 * Deliberately log-based, not a database write: these are unauthenticated
 * public fetches, and an ingest endpoint keyed by nothing would be an abuse
 * surface on a money-path backend. Vercel's log pipeline (query on
 * `evt=agent_discovery_fetch`, or a log drain later) is the trend instrument
 * the track's KPI needs — see docs/operations/agent-discovery-listings.md.
 *
 * Never throws into the request path: classification failures mean no log
 * line, never a broken fetch.
 */
export function middleware(request: NextRequest): NextResponse {
  try {
    const family = classifyAgentUserAgent(request.headers.get('user-agent'))
    if (family) {
      // eslint-disable-next-line no-console -- structured log IS the sink here
      console.log(
        JSON.stringify({
          evt: 'agent_discovery_fetch',
          surface: request.nextUrl.pathname,
          agent: family,
          ts: new Date().toISOString(),
        }),
      )
    }
  } catch {
    // Telemetry must never break the artifact fetch.
  }
  return NextResponse.next()
}

export const config = {
  // Exactly the agent-discovery surfaces — nothing else pays the middleware
  // invocation cost, and app routes keep their existing (middleware-free)
  // behaviour.
  matcher: ['/llms.txt', '/llms-full.txt', '/402', '/402/:path*', '/402.md'],
}
