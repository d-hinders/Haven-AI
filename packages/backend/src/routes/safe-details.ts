import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { findOwnedSafesWithType } from '../infra/repositories/user-safes.js'
import { isSupportedChain } from '../domain/chains.js'
import { getSafeDetails } from '../modules/accounts/index.js'
import { ETH_ADDRESS_RE } from '@haven_ai/core'

function parseChainId(value: unknown): number | null {
  if (value === undefined) return null
  if (Array.isArray(value)) return Number.NaN

  const raw = String(value).trim()
  if (!/^[1-9]\d*$/.test(raw)) return Number.NaN

  const chainId = Number(raw)
  return Number.isSafeInteger(chainId) ? chainId : Number.NaN
}

export default async function safeDetailRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{ Params: { safeAddress: string }; Querystring: { chain_id?: string } }>(
    '/:safeAddress/details',
    async (request, reply) => {
      const { safeAddress } = request.params
      const requestedChainId = parseChainId(request.query.chain_id)
      const { sub } = request.user as { sub: string }

      if (!ETH_ADDRESS_RE.test(safeAddress)) {
        return reply.code(400).send({ error: 'Invalid address' })
      }

      if (Number.isNaN(requestedChainId)) {
        return reply.code(400).send({ error: 'Invalid chain_id' })
      }

      if (requestedChainId !== null && !isSupportedChain(requestedChainId)) {
        return reply.code(400).send({ error: `Unsupported chain: ${requestedChainId}` })
      }

      // Ownership check (repository query, #999).
      const ownedSafes = await findOwnedSafesWithType(sub, safeAddress, requestedChainId)
      if (ownedSafes.length === 0) {
        return reply.code(403).send({ error: 'Not your Safe' })
      }
      // #1107: a delegator_hybrid account has no Safe contract — probing it
      // with the Safe ABI throws, which surfaced as a 500 that hid real 500s.
      // A wrong-account-type request is a clean, explicable 409.
      if (ownedSafes[0].account_type === 'delegator_hybrid') {
        return reply.code(409).send({
          error: 'This account is not a Safe — its approval methods are its signer set (see /accounts/hybrid/:address/signers)',
        })
      }

      const chainId = requestedChainId ?? ownedSafes[0].chain_id
      return getSafeDetails(safeAddress, chainId)
    },
  )
}
