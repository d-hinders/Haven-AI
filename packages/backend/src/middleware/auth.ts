import { FastifyRequest, FastifyReply } from 'fastify'
import { OWNER_CLI_PURPOSE, routeAllowsOwnerCli } from './owner-cli.js'

/**
 * Dashboard session auth.
 *
 * A verified signature is NOT sufficient on its own (#1640). The app signs a
 * few short-lived tokens for narrow, single-purpose flows — today the Fortnox
 * OAuth `state` (`purpose: 'fortnox_oauth'`, 10 minutes, carried in a URL
 * query string). Those tokens verify with the same secret as a session token,
 * so without this check they were accepted as ordinary Bearer credentials on
 * every authenticated route: a "purpose-scoped" token that was not scoped at
 * all, sitting in browser history, provider logs and proxy logs.
 *
 * The rule is therefore stated the safe way round: a token carrying ANY
 * `purpose` claim is refused here, and the one flow that wants such a token
 * checks the specific purpose itself. A future single-purpose token inherits
 * this refusal by default rather than by remembering to ask for it.
 */
/**
 * The refusal body, built once (#2530).
 *
 * `error` is unchanged and asserted verbatim by existing tests; `hint` is
 * additive, and says which credential this door wants and where to read about
 * it. An agent that hits a 401 with no further information has to guess
 * between an owner session and an agent key — the cold test did exactly that.
 *
 * ONE object, referenced by both refusal sites on purpose. The #1640 rule is
 * that a purpose-scoped token gets a body IDENTICAL to a failed verification,
 * so that which kind of token was presented is not something an
 * unauthenticated caller is told. Two separately-written literals would let
 * that identity drift the first time someone edited one of them; sharing the
 * constant makes the identity structural rather than remembered.
 */
export const OWNER_UNAUTHORIZED_BODY = {
  error: 'Unauthorized',
  hint: 'This route needs an owner session: sign in to the dashboard, or run `haven login`. Agent API keys (`sk_agent_…`) are refused here — see /openapi.json.',
} as const

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify()
  } catch {
    return reply.code(401).send(OWNER_UNAUTHORIZED_BODY)
  }

  const purpose = (request.user as { purpose?: unknown } | undefined)?.purpose
  if (purpose === undefined) return

  // #2526: ONE exception to #1640's blanket refusal, and it is an opt-IN.
  //
  // A device-code login mints an owner token carrying `purpose: 'owner_cli'`
  // for a CLI an agent drives. A route accepts it only by being on the
  // owner-CLI allow-list (or carrying the explicit marker); everything else —
  // including every route added after this line was written — keeps refusing,
  // because the default is still the refusal below.
  //
  // The check is `routeAllowsOwnerCli` AND the purpose being exactly
  // `owner_cli`: an opted-in route must not thereby accept the Fortnox OAuth
  // state token, whose whole point is that it is single-purpose.
  if (purpose === OWNER_CLI_PURPOSE && routeAllowsOwnerCli(request)) return

  // Deliberately the same body as a failed verification: which kind of token
  // was presented is not something an unauthenticated caller needs told.
  // #2530's shared constant, so the two refusal sites cannot drift apart.
  return reply.code(401).send(OWNER_UNAUTHORIZED_BODY)
}
