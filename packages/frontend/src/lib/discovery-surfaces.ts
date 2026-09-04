/**
 * The public surfaces an agent (or a crawler) may discover, in one place.
 *
 * `/robots.txt` and `/sitemap.xml` are generated from this list, and the guard
 * test asserts the list against the routes that actually exist — so adding a
 * public page and forgetting to advertise it is a test failure rather than a
 * silent omission (#2521).
 *
 * The 2026-09-04 cold test found `llms.txt`, `402.md` and the OpenAPI spec only
 * by guessing the convention; nothing in the served HTML pointed at them. See
 * `docs/bug-reports/agent-first-cold-test-2026-09-04.md`.
 */

/**
 * Public routes and artifacts, advertised in the sitemap. Never an authenticated route.
 *
 * `/api/openapi.json` is deliberately NOT here, though the root layout and
 * robots.txt both advertise it: a sitemap lists documents a crawler should
 * index, and the spec is an API artifact reached by an agent that was told
 * about it, not a page. Stated because the rest of this file makes a point of
 * keeping its lists symmetric.
 *
 * No entry carries a trailing slash: the deployment 308-redirects `/exit/` to
 * `/exit` and `/402/` to `/402`, so the slashed form in a sitemap advertises a
 * redirect rather than a document. Verified against the dev preview, not against
 * `next start`, which resolves static directory indexes differently.
 */
export const PUBLIC_SURFACES = [
  '/',
  '/how-it-works',
  '/protocols',
  '/protocols/x402',
  '/protocols/mpp',
  '/402',
  '/402.md',
  '/llms.txt',
  '/llms-full.txt',
  '/docs/account-recovery.md',
  '/docs/agent-key-rotation.md',
  '/docs/agent-passport.md',
  '/docs/security-model.md',
  '/exit',
  '/signup',
  '/login',
] as const

/**
 * The route segments under `src/app/(authenticated)/`. Every page below that
 * layout carries `<meta name="haven:auth" content="required">`.
 *
 * Hand-written, but NOT hand-maintained: the guard test pins this list to the
 * directory listing in both directions, so adding an authenticated route and
 * forgetting this list fails the suite. The issue that specified this work named
 * five of these; the build found thirteen.
 */
export const AUTH_MARKED_PREFIXES = [
  '/account',
  '/accounting',
  '/accounts',
  '/agents',
  '/catalog',
  '/contacts',
  '/custody',
  '/dashboard',
  '/design-system',
  '/profile',
  '/reporting',
  '/settings',
  '/transactions',
] as const

/**
 * `/onboarding` needs a session too (`OnboardingClient` reads `useAuth` and
 * /login redirects into it) but sits OUTSIDE the `(authenticated)` group, so it
 * has its own tiny server layout carrying the same marker. Listed apart from the
 * group above because the group is pinned to a directory and this is not in it.
 */
export const AUTH_MARKED_STANDALONE = ['/onboarding'] as const

/**
 * Everything `robots.txt` disallows: every surface that needs a session. All of
 * these answer 200 with an SSR shell and redirect client-side, so a crawler gets
 * nothing from them.
 */
export const AUTHENTICATED_PREFIXES = [
  ...AUTH_MARKED_PREFIXES,
  ...AUTH_MARKED_STANDALONE,
] as const

/** The name of the meta tag that marks an authenticated surface for non-browser clients. */
export const AUTH_MARKER_NAME = 'haven:auth'
export const AUTH_MARKER_CONTENT = 'required'

/**
 * The origin a request arrived on. Both artifacts need ABSOLUTE URLs — the
 * robots and sitemap specs require them — while the epic's invariant is that no
 * host is hardcoded, so dev preview and production resolve alike (#2519). Taking
 * the origin off the request satisfies both without any env configuration.
 */
export function originFrom(url: URL, forwardedHost?: string | null, forwardedProto?: string | null): string {
  const host = forwardedHost?.split(',')[0]?.trim()
  if (host) {
    const proto = forwardedProto?.split(',')[0]?.trim() || 'https'
    return `${proto}://${host}`
  }
  return url.origin
}

export function buildRobotsTxt(origin: string): string {
  return `# Haven — agent payments within your rules
#
# If you are an AI agent reading this for your user, start at /llms.txt.
#
# The agent-readable artifacts are named explicitly because an agent should not
# have to guess the convention — the 2026-09-04 cold test found them only by
# guessing:
#
#   /llms.txt          what Haven is, and where to start
#   /llms-full.txt     the model, the x402 flow, the integration surface
#   /402.md            your agent hit a 402 — how to pay it
#   /api/openapi.json  the full OpenAPI 3.1 spec

User-agent: *
Allow: /

# Authenticated surfaces answer 200 with an SSR shell and redirect client-side.
# They carry <meta name="${AUTH_MARKER_NAME}" content="${AUTH_MARKER_CONTENT}"> and hold nothing for a crawler.
${AUTHENTICATED_PREFIXES.map((p) => `Disallow: ${p}`).join('\n')}

Sitemap: ${origin}/sitemap.xml
`
}

export function buildSitemapXml(origin: string): string {
  const urls = PUBLIC_SURFACES.map(
    (path) => `  <url>\n    <loc>${origin}${path}</loc>\n  </url>`,
  ).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}
