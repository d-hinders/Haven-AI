import { NextResponse, type NextRequest } from 'next/server'
import { classifyAgentUserAgent } from './lib/discovery'

/**
 * Discovery-surface fetch log (#2302, Agent Discovery GTM track).
 *
 * The AEO artifacts (`/llms.txt`, `/llms-full.txt`, `/402`, `/402.md`) are
 * static files in `public/`, and `/robots.txt` and `/sitemap.xml` (#2521) are
 * frontend route handlers, so the backend never sees a request for any of them —
 * this middleware is the only place a fetch can be observed. When the
 * User-Agent classifies as a known AI agent/crawler family, emit ONE
 * structured log line and pass the request through untouched.
 *
 * #2529 extends the matcher to the FUNNEL pages as well, and that widening
 * comes with a limit that has to be stated wherever the series is read: this
 * log is a LOWER BOUND on crawler-style agents, never the agent-driven share.
 * `classifyAgentUserAgent` matches crawler families by User-Agent needle, and
 * a Claude Code session driving onboarding fetches with an ordinary browser
 * UA — the exact scenario epic #2519 exists for classifies as NOT an agent.
 * The headline number comes from `via=agent` (#2522) and `run_mode` (#2528),
 * which record what the agent PASTED rather than what a client claimed to be.
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
  // The agent-discovery surfaces plus the funnel pages an agent hands its
  // human (#2529). Still an explicit list, not a catch-all: everything absent
  // from it pays no middleware invocation cost and keeps its existing
  // (middleware-free) behaviour.
  //
  // The second group is a deliberate widening of the first group's rule. These
  // are ordinary app routes, so before #2529 a crawler fetching `/signup` was
  // invisible; the funnel pages are exactly where an agent-driven visit shows
  // up, so leaving them unobserved left the cheapest signal on the floor.
  //
  // `/device` (C1, #2526) does not exist yet and answers 404 today. Listed
  // anyway, and the distinction is what makes that safe: a matcher OBSERVES a
  // fetch, it does not ADVERTISE a surface. Nothing tells an agent to go
  // there — `PUBLIC_SURFACES`, robots.txt and the sitemap are all unchanged —
  // so this cannot reproduce the "key pointing at a 404" defect #2520
  // removed. Until #2526 lands it logs probes, which is signal rather than a
  // broken promise, and the day the route ships it is already observed.
  matcher: [
    '/llms.txt',
    '/llms-full.txt',
    '/docs/:path*',
    '/402',
    '/402/:path*',
    '/402.md',
    '/robots.txt',
    '/sitemap.xml',
    '/signup',
    '/login',
    '/onboarding',
    '/for-agents.md',
    '/device',
  ],
}
