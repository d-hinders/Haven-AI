import { FastifyRequest, FastifyReply } from 'fastify'

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
  if (purpose !== undefined) {
    // Deliberately the same body as a failed verification: which kind of token
    // was presented is not something an unauthenticated caller needs told.
    return reply.code(401).send(OWNER_UNAUTHORIZED_BODY)
  }
}
