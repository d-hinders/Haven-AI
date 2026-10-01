/**
 * Ops console authentication (#3509, epic #3507 invariants 2, 4 and 7).
 *
 * Accepts only `Authorization: Bearer <ops token>` — never a cookie, because
 * CORS here is `origin: true, credentials: true` and a cookie session would be
 * forgeable cross-site. The token is verified by the standalone ops verifier
 * (`modules/ops/tokens.ts`), which pins HS256, the ops audience and this
 * backend's issuer, so a dashboard JWT never passes. The GitHub id is then
 * re-checked against the CURRENT allowlist on every request: dropping an id
 * from `OPS_ALLOWED_GITHUB_IDS` locks that founder out on the next request,
 * not when their token expires.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { OpsConfig } from '../config/ops.js'
import { verifyOpsToken, type OpsOperator } from '../modules/ops/index.js'

export const OPS_UNAUTHORIZED_BODY = {
  error: 'Unauthorized',
  hint: 'This route needs an ops console session: sign in through the ops app with an allowlisted GitHub account.',
} as const

const operators = new WeakMap<FastifyRequest, OpsOperator>()

/** The signed-in operator for a request that passed `createOpsAuth`. */
export function opsOperatorOf(request: FastifyRequest): OpsOperator {
  const operator = operators.get(request)
  if (!operator) throw new Error('opsOperatorOf called on a request the ops auth hook did not admit')
  return operator
}

export function createOpsAuth(cfg: OpsConfig, now?: () => number) {
  return async function opsAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return reply.code(401).send(OPS_UNAUTHORIZED_BODY)
    }
    const operator = verifyOpsToken(
      { secret: cfg.jwtSecret, issuer: cfg.publicOrigin, now: now?.() },
      header.slice('Bearer '.length).trim(),
    )
    if (!operator || !cfg.allowedGithubIds.includes(Number(operator.githubId))) {
      return reply.code(401).send(OPS_UNAUTHORIZED_BODY)
    }
    operators.set(request, operator)
  }
}
