import { createHash } from 'node:crypto'
import type {
  MachinePaymentChallenge,
  MachinePaymentReceipt,
} from './types.js'
import { decodeBase64Json, encodeBase64Json } from './base64.js'

function normalizeChallenge(value: unknown): MachinePaymentChallenge | null {
  const candidate = value as Partial<MachinePaymentChallenge> | null
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    candidate.rail !== 'mpp_demo' ||
    typeof candidate.version !== 'string' ||
    typeof candidate.challengeId !== 'string' ||
    typeof candidate.resource !== 'string' ||
    typeof candidate.description !== 'string' ||
    // TODO: relax these checks when non-demo machine payment rails are added.
    candidate.network?.chainId !== 8453 ||
    candidate.network?.name !== 'base' ||
    candidate.asset?.symbol !== 'USDC' ||
    typeof candidate.asset?.address !== 'string' ||
    candidate.asset.decimals !== 6 ||
    typeof candidate.amount?.display !== 'string' ||
    typeof candidate.amount?.atomic !== 'string' ||
    typeof candidate.recipient !== 'string' ||
    typeof candidate.expiresAt !== 'string'
  ) {
    return null
  }

  return {
    rail: candidate.rail,
    version: candidate.version,
    challengeId: candidate.challengeId,
    resource: candidate.resource,
    description: candidate.description,
    network: candidate.network,
    asset: candidate.asset,
    amount: candidate.amount,
    recipient: candidate.recipient,
    expiresAt: candidate.expiresAt,
    metadata: candidate.metadata,
  }
}

export function parseMachinePaymentChallenge(response: Response): MachinePaymentChallenge {
  const header = response.headers.get('MACHINE-PAYMENT-CHALLENGE')
  if (!header) {
    throw new Error('No MACHINE-PAYMENT-CHALLENGE header found in 402 response.')
  }

  const parsed = normalizeChallenge(
    decodeBase64Json<unknown>(header, 'MACHINE-PAYMENT-CHALLENGE header'),
  )
  if (!parsed) throw new Error('Invalid machine payment challenge')
  return parsed
}

export async function parseMachinePaymentChallengeResponse(
  response: Response,
): Promise<MachinePaymentChallenge> {
  try {
    return parseMachinePaymentChallenge(response)
  } catch (headerErr) {
    try {
      const body = await response.clone().json() as { challenge?: unknown }
      const parsed = normalizeChallenge(body.challenge)
      if (parsed) return parsed
    } catch {
      // Fall through to the original, more specific header error.
    }

    throw headerErr
  }
}

export function buildMachinePaymentIdempotencyKey(
  challenge: MachinePaymentChallenge,
): string {
  const material = [
    challenge.rail,
    challenge.challengeId,
    challenge.resource,
    challenge.recipient.toLowerCase(),
    challenge.asset.address.toLowerCase(),
    challenge.amount.atomic,
    challenge.network.chainId,
  ].join('|')

  return `${challenge.rail}:${createHash('sha256').update(material).digest('hex').slice(0, 16)}`
}

export function encodeMachinePaymentProof(receipt: Omit<MachinePaymentReceipt, 'proofHeader'>): string {
  return encodeBase64Json({
    rail: receipt.rail,
    challengeId: receipt.challengeId,
    paymentId: receipt.paymentId,
    txHash: receipt.txHash,
    settledVia: 'haven',
    payer: receipt.payer,
    chainId: receipt.chainId,
  })
}
