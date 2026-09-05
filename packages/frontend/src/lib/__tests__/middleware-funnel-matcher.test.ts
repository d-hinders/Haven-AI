/**
 * The discovery middleware's matcher and its one honest limit (#2529, D1).
 *
 * Two things are asserted here, and the second is the point of the slice.
 *
 * 1. The matcher covers the funnel pages an agent hands its human, so an
 *    agent-UA fetch of `/signup` is observable at all. Asserted against the
 *    EXPORTED `config.matcher`, not against the file's source text: a source
 *    grep passes on a path that appears in a comment, and the neighbouring
 *    guard in `discovery-surfaces.test.ts` does exactly that.
 *
 * 2. The series this produces is a LOWER BOUND on crawler-style agents and
 *    must never be read as the agent-driven share. `classifyAgentUserAgent`
 *    matches crawler UA needles; the scenario epic #2519 exists for — a coding
 *    agent driving onboarding — arrives with an ordinary browser UA and does
 *    not classify. The last test pins that with the real UA string, so the
 *    limit is a failing test if anyone "fixes" the classifier into pretending
 *    otherwise.
 */
import { describe, expect, it, vi } from 'vitest'
import { config, middleware } from '../../middleware'
import { classifyAgentUserAgent } from '../discovery'

const FUNNEL_SURFACES = ['/signup', '/login', '/onboarding', '/for-agents.md', '/device'] as const
const DISCOVERY_SURFACES = ['/llms.txt', '/llms-full.txt', '/402', '/402.md', '/robots.txt', '/sitemap.xml'] as const

describe('the discovery middleware matcher', () => {
  it('observes every funnel page an agent hands its human', () => {
    for (const path of FUNNEL_SURFACES) {
      expect(config.matcher).toContain(path)
    }
  })

  it('keeps the #2302 discovery surfaces it already had', () => {
    for (const path of DISCOVERY_SURFACES) {
      expect(config.matcher).toContain(path)
    }
  })

  it('stays an explicit list — no catch-all that would run on every route', () => {
    // A `/:path*` at the root would silently make every app route pay the
    // middleware, which is the cost this matcher exists to avoid.
    expect(config.matcher).not.toContain('/')
    expect(config.matcher.some((m) => m === '/:path*' || m === '/(.*)')).toBe(false)
  })
})

describe('what the middleware actually logs', () => {
  function fetchAs(userAgent: string | null, pathname: string): string[] {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    try {
      middleware({
        headers: { get: (h: string) => (h === 'user-agent' ? userAgent : null) },
        nextUrl: { pathname },
      } as never)
    } finally {
      spy.mockRestore()
    }
    return lines
  }

  it('logs one structured line for an agent UA on a funnel page', () => {
    const lines = fetchAs('Mozilla/5.0 (compatible; ClaudeBot/1.0)', '/signup')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      evt: 'agent_discovery_fetch',
      surface: '/signup',
    })
  })

  it('logs nothing for an ordinary browser', () => {
    expect(
      fetchAs(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        '/signup',
      ),
    ).toEqual([])
  })

  it('is a LOWER BOUND: a coding agent driving onboarding does not classify', () => {
    // The scenario the epic exists for. Its fetches are indistinguishable from
    // its user's browser, so this series can never be the headline number —
    // `via=agent` (#2522) and `run_mode` (#2528) are. Positive control below
    // proves the classifier can say yes, so this "no" is a fact about the UA.
    const codingAgentUa =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    expect(classifyAgentUserAgent(codingAgentUa)).toBeNull()
    expect(classifyAgentUserAgent('ClaudeBot/1.0')).not.toBeNull()
  })
})
