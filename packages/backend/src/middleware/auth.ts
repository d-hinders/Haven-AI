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
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify()
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' })
  }

  const purpose = (request.user as { purpose?: unknown } | undefined)?.purpose
  if (purpose === undefined) return

  // #2526: ONE exception to #1640's blanket refusal, and it is an opt-IN.
  //
  // A device-code login mints an owner token carrying `purpose: 'owner_cli'`
  // for a CLI an agent drives. A route accepts it only by setting the marker
  // (`allowOwnerCli()` in its own registration); everything else — including
  // every route added after this line was written — keeps refusing, because
  // the default is still the refusal below.
  //
  // The check is `routeAllowsOwnerCli` AND the purpose being exactly
  // `owner_cli`: an opted-in route must not thereby accept the Fortnox OAuth
  // state token, whose whole point is that it is single-purpose.
  if (purpose === OWNER_CLI_PURPOSE && routeAllowsOwnerCli(request)) return

  // Deliberately the same body as a failed verification: which kind of token
  // was presented is not something an unauthenticated caller needs told.
  return reply.code(401).send({ error: 'Unauthorized' })
}
