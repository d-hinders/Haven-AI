import { randomUUID } from 'crypto'
import { FastifyInstance, FastifyRequest } from 'fastify'
import { ethers } from 'ethers'
import pool from '../db.js'
import { config } from '../config.js'
import { getExplorerUrl } from '../lib/chains.js'
import { isValidAddress } from '../lib/machine-payments.js'

const RAIL = 'mpp_demo'
const VERSION = '2026-05-12'
const CHAIN_ID = 8453
const NETWORK_NAME = 'base'
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_DECIMALS = 6
const PRICE_DISPLAY = '0.01'
const PRICE_ATOMIC = '10000'
const CHALLENGE_TTL_MS = 5 * 60 * 1000

interface PaymentProof {
  rail?: string
  challengeId?: string
  paymentId?: string
  txHash?: string
}

interface PaymentIntentReceiptRow {
  id: string
  tx_hash: string
  to_address: string
  amount_raw: string
  chain_id: number
}

interface ExistingReceiptRow {
  id: string
  payment_intent_id: string | null
  tx_hash: string
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

function parseB64Json<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString()) as T
  } catch {
    return null
  }
}

function demoRecipient(): string | null {
  const configured = process.env.MPP_DEMO_RECIPIENT_ADDRESS
  if (configured && isValidAddress(configured)) return ethers.getAddress(configured.toLowerCase())

  if (config.relayerPrivateKey) {
    try {
      return ethers.computeAddress(config.relayerPrivateKey)
    } catch {
      return null
    }
  }

  return null
}

function buildResourceUrl(request: FastifyRequest): string {
  return `${request.protocol}://${request.hostname}/demo/mpp/market-summary`
}

function buildChallenge(resourceUrl: string, recipient: string) {
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()
  return {
    rail: RAIL,
    version: VERSION,
    challengeId: randomUUID(),
    resource: resourceUrl,
    description: 'Haven market summary demo',
    network: {
      chainId: CHAIN_ID,
      name: NETWORK_NAME,
    },
    asset: {
      symbol: 'USDC',
      address: USDC_ADDRESS,
      decimals: USDC_DECIMALS,
    },
    amount: {
      display: PRICE_DISPLAY,
      atomic: PRICE_ATOMIC,
    },
    recipient,
    expiresAt,
    metadata: {
      demoResource: 'market-summary',
      settlement: 'safe_allowance_transfer',
    },
  }
}

function marketSummary(payment: PaymentIntentReceiptRow, receiptId: string, reused = false) {
  return {
    title: 'Haven Market Summary',
    paid: true,
    reused,
    rail: RAIL,
    receipt_id: receiptId,
    payment_id: payment.id,
    txHash: payment.tx_hash,
    explorerUrl: getExplorerUrl(CHAIN_ID, 'tx', payment.tx_hash),
    paidAt: new Date().toISOString(),
    summary: {
      headline: 'Stablecoin agent payments are moving from protocol experiments into usable product loops.',
      bullets: [
        'Base USDC gives demos a familiar dollar unit and fast settlement.',
        'Haven keeps the agent constrained by wallet-specific rules and budget checks.',
        'The audit trail connects the challenge, policy decision, payment, and unlocked resource.',
      ],
      demoPrice: `${PRICE_DISPLAY} USDC`,
    },
  }
}

export default async function demoMppRoutes(app: FastifyInstance): Promise<void> {
  app.get('/market-summary', async (request, reply) => {
    const recipient = demoRecipient()
    if (!recipient) {
      return reply.code(503).send({
        error: 'MPP demo recipient is not configured',
        detail: 'Set MPP_DEMO_RECIPIENT_ADDRESS or RELAYER_PRIVATE_KEY.',
      })
    }

    const resourceUrl = buildResourceUrl(request)
    const proofHeader = request.headers['machine-payment-proof'] as string | undefined

    if (!proofHeader) {
      const challenge = buildChallenge(resourceUrl, recipient)
      reply.header('MACHINE-PAYMENT-CHALLENGE', b64(challenge))
      return reply.code(402).send({
        error: 'Machine payment required',
        challenge,
        hint: 'Authorize the challenge with Haven, then retry with MACHINE-PAYMENT-PROOF.',
      })
    }

    const proof = parseB64Json<PaymentProof>(proofHeader)
    if (
      !proof ||
      proof.rail !== RAIL ||
      !proof.challengeId ||
      !proof.paymentId ||
      !proof.txHash
    ) {
      return reply.code(400).send({ error: 'Invalid machine payment proof' })
    }

    const paymentResult = await pool.query<PaymentIntentReceiptRow>(
      `SELECT id, tx_hash, to_address, amount_raw, chain_id
       FROM payment_intents
       WHERE id = $1
         AND tx_hash = $2
         AND status = 'confirmed'
         AND payment_rail = 'mpp_demo'
         AND machine_challenge_id = $3
         AND payment_resource_url = $4
         AND chain_id = $5
         AND amount_raw = $6
         AND LOWER(token_address) = LOWER($7)
         AND LOWER(to_address) = LOWER($8)
       LIMIT 1`,
      [
        proof.paymentId,
        proof.txHash.toLowerCase(),
        proof.challengeId,
        resourceUrl,
        CHAIN_ID,
        PRICE_ATOMIC,
        USDC_ADDRESS,
        recipient,
      ],
    )

    const payment = paymentResult.rows[0]
    if (!payment) {
      return reply.code(402).send({
        verified: false,
        error: 'Payment proof does not match a confirmed MPP demo payment',
      })
    }

    const existing = await pool.query<ExistingReceiptRow>(
      `SELECT id, payment_intent_id, tx_hash
       FROM machine_payment_receipts
       WHERE challenge_id = $1
       LIMIT 1`,
      [proof.challengeId],
    )

    if (existing.rows[0]) {
      const receipt = existing.rows[0]
      if (receipt.payment_intent_id === payment.id && receipt.tx_hash === payment.tx_hash) {
        reply.header('MACHINE-PAYMENT-RESPONSE', b64({
          success: true,
          rail: RAIL,
          challengeId: proof.challengeId,
          paymentId: payment.id,
          txHash: payment.tx_hash,
          reused: true,
        }))
        return reply.code(200).send(marketSummary(payment, receipt.id, true))
      }

      return reply.code(409).send({
        error: 'Machine payment challenge was already used',
        challengeId: proof.challengeId,
      })
    }

    const receiptResult = await pool.query<{ id: string }>(
      `INSERT INTO machine_payment_receipts (
        rail, challenge_id, payment_intent_id, tx_hash, resource_url,
        recipient_address, amount_raw, chain_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id`,
      [
        RAIL,
        proof.challengeId,
        payment.id,
        payment.tx_hash,
        resourceUrl,
        recipient.toLowerCase(),
        PRICE_ATOMIC,
        CHAIN_ID,
      ],
    )

    reply.header('MACHINE-PAYMENT-RESPONSE', b64({
      success: true,
      rail: RAIL,
      challengeId: proof.challengeId,
      paymentId: payment.id,
      txHash: payment.tx_hash,
    }))
    return reply.code(200).send(marketSummary(payment, receiptResult.rows[0].id))
  })

  app.get('/', async (request) => {
    const recipient = demoRecipient()
    const resourceUrl = buildResourceUrl(request)
    return {
      status: recipient ? 'ok' : 'missing_recipient',
      endpoint: '/demo/mpp/market-summary',
      rail: RAIL,
      network: { chainId: CHAIN_ID, name: NETWORK_NAME },
      asset: { symbol: 'USDC', address: USDC_ADDRESS, decimals: USDC_DECIMALS },
      amount: { display: PRICE_DISPLAY, atomic: PRICE_ATOMIC },
      recipient,
      challenge: recipient ? buildChallenge(resourceUrl, recipient) : null,
    }
  })
}
