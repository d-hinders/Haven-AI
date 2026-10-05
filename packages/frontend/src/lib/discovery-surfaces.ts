/**
 * The public surfaces an agent (or a crawler) may discover, in one place.
 *
 * `/robots.txt` and `/sitemap.xml` are generated from this list, and the guard
 * test asserts the list against the routes that actually exist — so adding a
 * public page and forgetting to advertise it is a test failure rather than a
 * silent omission (#2521).
 *
 * Precisely: the guard only checks list → filesystem (every entry here
 * resolves to a real route or artifact), not the reverse. It does not fail a
 * public, unauthenticated page that exists but was never added here —
 * `/demo` (`src/app/demo/page.tsx`, #3477) is exactly that, deliberately: a
 * semi-private investor demo, not advertised; the team hands the link to
 * invited investors. It must stay out of the sitemap, `robots.txt`, `llms.txt` and
 * every other discovery surface. `src/app/demo/__tests__/not-listed.test.ts`
 * pins its absence with its own assertions rather than relying on this file's
 * guard to catch a page it structurally cannot see.
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
  '/for-agents.md',
  // #3596: the runbook above, also served as small, linked step files — one
  // skill per step, the pattern `/.well-known/agent-skills/index.json` (kept
  // OUT of this list on purpose, matching haven.json and the OpenAPI spec
  // below) lists in full. `AGENT_SKILL_STEPS` (`agent-skill-steps.ts`) is the
  // generating list; this literal array is pinned against it the same way
  // every other entry here is pinned against the filesystem.
  '/agent-skills/what-haven-is.md',
  '/agent-skills/the-sequence.md',
  '/agent-skills/budget-changes-later.md',
  '/agent-skills/hand-off-scripts.md',
  '/agent-skills/what-you-run.md',
  '/agent-skills/how-to-verify.md',
  '/agent-skills/if-you-cannot-open-a-browser.md',
  '/agent-skills/if-something-breaks.md',
  '/agent-skills/vocabulary.md',
  '/llms.txt',
  '/llms-full.txt',
  '/docs/account-recovery.md',
  '/docs/agent-key-rotation.md',
  '/docs/agent-passport.md',
  '/docs/security-model.md',
  '/exit',
  // #3304: "what changed / do I need to update" — named by every client_update
  // hint and by both discovery documents, so it must be public.
  '/releases',
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
  // #2947: the analytics page shell. Registered here or the route ships
  // un-disallowed in robots and without the auth marker on its shell.
  '/analytics',
  '/contacts',
  '/dashboard',
  '/design-system',
  '/device',
  // #3079: renamed from `/catalog`. Unlike `/reporting` below, `/catalog`
  // does NOT stay on disk as its own redirect page — `next.config.ts`
  // `redirects()` 308s it to `/marketplace` before any route in this group
  // ever runs — so it is removed here rather than kept alongside the new
  // entry: this list is pinned bidirectionally to the directory listing
  // (see the guard test), and an entry with no backing directory fails it.
  '/marketplace',
  '/profile',
  // #2859 renamed the feed page's route. `/reporting` remains on disk as a
  // redirect to `/accounting`, so the filesystem-pinned list carries both.
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
#   /for-agents.md     you are the agent and your user has no account yet
#   /api/openapi.json  the full OpenAPI 3.1 spec
#   /.well-known/agent-skills/index.json  the above, indexed one skill per step
#   /agent-skills/<step>.md               /for-agents.md split into linked steps

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
