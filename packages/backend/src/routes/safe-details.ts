import { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import { authMiddleware } from '../middleware/auth.js'
import pool from '../db.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

// Minimal Safe ABI for reading state
const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
]

const cache = new Map<string, { data: unknown; ts: number }>()
const CACHE_TTL = 30_000 // 30 seconds

export default async function safeDetailRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{ Params: { safeAddress: string } }>(
    '/:safeAddress/details',
    async (request, reply) => {
      const { safeAddress } = request.params
      const { sub } = request.user as { sub: string }

      if (!ETH_ADDRESS_RE.test(safeAddress)) {
        return reply.code(400).send({ error: 'Invalid address' })
      }

      // Verify ownership
      const userResult = await pool.query(
        'SELECT id FROM users WHERE id = $1 AND LOWER(safe_address) = LOWER($2)',
        [sub, safeAddress],
      )
      if (userResult.rows.length === 0) {
        return reply.code(403).send({ error: 'Not your Safe' })
      }

      // Check cache
      const cacheKey = `safe-details:${safeAddress.toLowerCase()}`
      const cached = cache.get(cacheKey)
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        return cached.data
      }

      const rpcUrl = process.env.RPC_URL ?? 'https://rpc.gnosischain.com'
      const provider = new ethers.JsonRpcProvider(rpcUrl)
      const safeContract = new ethers.Contract(safeAddress, SAFE_ABI, provider)

      const [owners, threshold, nonce] = await Promise.all([
        safeContract.getOwners() as Promise<string[]>,
        safeContract.getThreshold() as Promise<bigint>,
        safeContract.nonce() as Promise<bigint>,
      ])

      const responseData = {
        address: safeAddress,
        owners: owners.map((o: string) => o),
        threshold: Number(threshold),
        nonce: Number(nonce),
      }

      cache.set(cacheKey, { data: responseData, ts: Date.now() })
      return responseData
    },
  )
}
