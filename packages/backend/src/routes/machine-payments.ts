import { FastifyInstance } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import {
  authorizeMachinePayment,
  type MachinePaymentRail,
} from '../lib/machine-payments.js'

interface MachinePaymentChallengeBody {
  rail: MachinePaymentRail
  version: string
  challengeId: string
  resource: string
  description: string
  network: {
    chainId: number
    name: 'base'
  }
  asset: {
    symbol: 'USDC'
    address: string
    decimals: 6
  }
  amount: {
    display: string
    atomic: string
  }
  recipient: string
  expiresAt: string
  metadata?: Record<string, unknown>
}

interface AuthorizeBody {
  challenge: MachinePaymentChallengeBody
  idempotencyKey?: string
  signature?: string
}

function validateMppDemoChallenge(challenge: MachinePaymentChallengeBody): string | null {
  if (!challenge || typeof challenge !== 'object') return 'challenge is required'
  if (challenge.rail !== 'mpp_demo') return 'Only mpp_demo challenges are supported'
  if (!challenge.challengeId || typeof challenge.challengeId !== 'string') return 'challengeId is required'
  if (!challenge.resource || typeof challenge.resource !== 'string') return 'resource is required'
  if (challenge.network?.chainId !== 8453 || challenge.network?.name !== 'base') {
    return 'MPP demo payments must use Base'
  }
  if (
    challenge.asset?.symbol !== 'USDC' ||
    challenge.asset?.decimals !== 6 ||
    challenge.asset?.address?.toLowerCase() !== '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  ) {
    return 'MPP demo payments must use Base USDC'
  }
  if (challenge.amount?.atomic !== '10000' || challenge.amount?.display !== '0.01') {
    return 'MPP demo payments are fixed at 0.01 USDC'
  }
  if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
    return 'MPP demo challenge has expired'
  }
  return null
}

export default async function machinePaymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  app.post<{ Body: AuthorizeBody }>('/authorize', async (request, reply) => {
    const agent = request.agent as AgentContext
    const { challenge, signature } = request.body

    const validationError = validateMppDemoChallenge(challenge)
    if (validationError) {
      return reply.code(400).send({ error: validationError })
    }

    const idempotencyKey =
      request.body.idempotencyKey ??
      `mpp_demo:${challenge.challengeId}:${agent.id}`

    const result = await authorizeMachinePayment({
      agent,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey,
      metadata: challenge.metadata,
      signature,
    })

    return reply.code(result.statusCode).send(result.body)
  })
}
