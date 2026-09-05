import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * The `owner_cli` opt-in (#2526).
 *
 * A device-code login (`POST /auth/device/*`) mints the ordinary 7-day owner
 * JWT carrying `purpose: 'owner_cli'`, for a CLI an AGENT drives. #1640 already
 * refuses every `purpose`-carrying token on every authenticated route, and that
 * refusal stays exactly as it is: the default answer for a new route is NO.
 *
 * ## Why an allow-list and not a deny-list
 *
 * A deny-list is a promise that somebody will remember. Every route added after
 * it is written is granted by default, and the day nobody remembers is the day
 * an agent-driven token can sign something. An allow-list inverts that: a new
 * route refuses until a person puts it here, which is a decision with a name on
 * it. `owner-cli-route-census.test.ts` discovers every registered route and
 * measures what `routeAllowsOwnerCli` actually answers for each, checks that
 * every entry here is real and behind `authMiddleware`, and holds the list
 * against an independent opinion about which path shapes are authority.
 *
 * That is deliberately NOT phrased as "it asserts there is no third state",
 * which is what this comment used to say. The no-third-state property is
 * structural — `isOwnerCliAllowed` returns a boolean and nothing falls through
 * — and the assertion that claimed to prove it was written in terms of
 * `isOwnerCliAllowed` itself, so it reduced to `!X && X` and could not fail.
 * A test written in terms of the thing it checks cannot check it.
 *
 * ## What is deliberately absent
 *
 * Everything that changes AUTHORITY rather than reading or arranging it:
 * signer changes, re-keying, passkey management, credential/password/email
 * changes, account provisioning, transfers, and delegation build/activate/
 * revoke. An owner CLI session can create an agent and hand it a budget request
 * — it cannot approve that budget, and it cannot move a key. The human keeps
 * every signature, which is this epic's standing owner constraint.
 */

export const OWNER_CLI_PURPOSE = 'owner_cli'

export interface AllowedRoute {
  method: string
  /** The OpenAPI-shaped path, e.g. `/agents/{id}/pause`. */
  path: string
}

/**
 * Exactly what C2/C3/B4 need, and nothing more.
 *
 * Paths are written in the OpenAPI shape (`{id}`) so the census can compare
 * them against `fastifyPathToOpenApi`'s output without a second normalisation
 * rule to keep in step.
 */
export const OWNER_CLI_ALLOWED_ROUTES: readonly AllowedRoute[] = [
  // Agents: create, read, and lifecycle that does not touch keys or authority.
  { method: 'POST', path: '/agents' },
  { method: 'GET', path: '/agents' },
  { method: 'GET', path: '/agents/{id}' },
  { method: 'POST', path: '/agents/{id}/pause' },
  { method: 'POST', path: '/agents/{id}/resume' },
  { method: 'POST', path: '/agents/{id}/revoke' },
  { method: 'POST', path: '/agents/{id}/archive' },
  { method: 'POST', path: '/agents/{id}/unarchive' },
  // The issue named `POST /agents/{id}/rename`; that route does not exist.
  // Renaming is `PUT /agents/{id}` (name + description). Corrected to the real
  // name — the census test caught it on its first run, which is the whole
  // reason it also checks this direction.
  { method: 'PUT', path: '/agents/{id}' },
  { method: 'POST', path: '/agents/{id}/rotate-key' },
  // Budgets are READ here. Building, activating and revoking a delegation are
  // authority changes and stay refused — C3 adds build + revoke later, and
  // never activate, which is the signature the human keeps.
  { method: 'GET', path: '/agents/{id}/delegations' },
  // Connect setups: create one and watch it, which is what an agent needs to
  // hand its user an approval link.
  { method: 'POST', path: '/agent-connection-setups' },
  { method: 'GET', path: '/agent-connection-setups/{setupId}' },
  // `GET /agent-connection-setups/{setupId}/connector-status` was on this list
  // and is deliberately NOT: it never reaches `authMiddleware` at all. It is
  // gated by `authenticateConnectorStatusRequest`, which demands a literal
  // `sk_agent_...` key, so an owner token gets that route's own 401 from a
  // different code path and the entry granted precisely nothing. A list entry
  // that grants nothing is worse than no entry — it reads as coverage. The
  // owner-facing `GET /agent-connection-setups/{setupId}` above is the read a
  // CLI session actually has, and the census test now refuses any entry whose
  // route is not behind `authMiddleware`, so this cannot come back silently.
  // Read-only account context.
  { method: 'GET', path: '/user/safes' },
  // Also corrected from the issue's text: balances are served under their own
  // prefix, and the activity surface has no bare route — it has a feed and a
  // per-agent stats read. Granting a path that does not exist grants nothing
  // and reads like coverage, which is the failure mode this list must not have.
  { method: 'GET', path: '/balances/{safeAddress}' },
  { method: 'GET', path: '/agent-activity/feed' },
  { method: 'GET', path: '/agent-activity/{id}/stats' },
  { method: 'GET', path: '/transactions' },
  { method: 'GET', path: '/catalog' },
  { method: 'GET', path: '/contacts' },
  { method: 'POST', path: '/contacts' },
  { method: 'DELETE', path: '/contacts/{id}' },
  { method: 'GET', path: '/auth/me' },
] as const

/** Is this route one an `owner_cli` token may reach? Default: no. */
export function isOwnerCliAllowed(method: string, path: string): boolean {
  const wanted = method.toUpperCase()
  return OWNER_CLI_ALLOWED_ROUTES.some((r) => r.method === wanted && r.path === path)
}

/**
 * The token's purpose, or null. Never throws — a malformed `user` object is a
 * token that has not been verified, which the caller has already handled.
 */
export function tokenPurpose(request: FastifyRequest): string | null {
  const purpose = (request.user as { purpose?: unknown } | undefined)?.purpose
  return typeof purpose === 'string' ? purpose : null
}

/**
 * Does this request carry an `owner_cli` token? Used by `authMiddleware` to
 * decide whether the route's own opt-in applies.
 */
export function isOwnerCliRequest(request: FastifyRequest): boolean {
  return tokenPurpose(request) === OWNER_CLI_PURPOSE
}

/**
 * Does the route this request matched accept an `owner_cli` token?
 *
 * Read from the LIST above rather than from a per-route marker, and that is a
 * deliberate departure from the issue's `allowOwnerCli(handlerOpts)` sketch.
 *
 * These modules attach auth with one `app.addHook('onRequest', authMiddleware)`
 * for the whole module, so a marker would have to be added to ~22 individual
 * registrations across nine files. That creates a failure this design does not
 * have: a route on the list whose marker was forgotten (grants nothing, reads
 * like coverage) or a marker on a route nobody listed (grants something nobody
 * decided). Two sources of truth that must agree is a worse property than one
 * that cannot disagree.
 *
 * It also makes the census test guard the REAL enforcement. If the list were a
 * parallel document, the census would prove the document consistent while the
 * middleware did something else.
 *
 * `allowOwnerCli()` is still exported for a route that wants the decision
 * visible in its own file — it is additive, not an alternative: a route is
 * allowed if the list says so OR it carries the marker.
 */
export function routeAllowsOwnerCli(request: FastifyRequest): boolean {
  const config = (request.routeOptions?.config ?? {}) as { allowOwnerCli?: unknown }
  if (config.allowOwnerCli === true) return true

  const url = request.routeOptions?.url
  if (typeof url !== 'string') return false
  // Fastify reports `/agents/:id`; the list is written in the OpenAPI shape so
  // the census can compare it to `fastifyPathToOpenApi` without a second
  // normalisation rule to keep in step.
  const openapiPath = url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
  return isOwnerCliAllowed(request.method, openapiPath)
}

/**
 * Marker a route may set to opt in from its own registration, for a decision
 * worth reading where the route is declared. Additive to the list above.
 */
export function allowOwnerCli(): { config: { allowOwnerCli: true } } {
  return { config: { allowOwnerCli: true } }
}

/** Unused re-export guard so a future reply-typed helper has a home. */
export type OwnerCliReply = FastifyReply
