/**
 * Hosted demo endpoint for the Haven x402 payment protocol.
 *
 * Lets any agent with Haven credentials test the full x402 flow against a
 * real hosted endpoint — no local server, no extra config needed.
 *
 * Flow:
 *   1. Agent fetches GET /demo/x402/data  →  402 + PAYMENT-REQUIRED header
 *   2. SDK detects 402, calls POST /x402/authorize, gets tx_hash + signature
 *   3. Agent retries with PAYMENT-SIGNATURE header  →  200 + demo payload
 *
 * Config (env vars, all optional — sensible defaults for Gnosis Chain):
 *   DEMO_X402_PAY_TO   — merchant wallet that receives the payment
 *   DEMO_X402_AMOUNT   — atomic units (default: 10000 = 0.01 EURe)
 *   DEMO_X402_ASSET    — token address (default: EURe on Gnosis)
 *   DEMO_X402_NETWORK  — CAIP-2 chain ID (default: eip155:100)
 */

import { FastifyInstance } from 'fastify'
import { getExplorerUrl } from '../lib/chains.js'

// ── Config ────────────────────────────────────────────────────────

const PAY_TO =
  process.env.DEMO_X402_PAY_TO ?? '0x3230Fc37bB2A81De452e55F923b949f0a7004306'
const AMOUNT =
  process.env.DEMO_X402_AMOUNT ?? '10000000000000000'   // 0.01 EURe (18 decimals)
const ASSET =
  process.env.DEMO_X402_ASSET ?? '0xcB444e90D8198415266c6a2724b7900fb12FC56E' // EURe Gnosis
const NETWORK =
  process.env.DEMO_X402_NETWORK ?? 'eip155:100'

const CHAIN_ID = Number(NETWORK.split(':')[1] ?? 100)

// Fun facts rotated on each successful payment
const FUN_FACTS = [
  'The first HTTP 402 status code was reserved in 1996 — it took 30 years to find a real use.',
  'Haven agents settle payments on Gnosis Chain in ~5 seconds for fractions of a cent in gas.',
  'The x402 protocol lets any AI agent pay for APIs autonomously — no human in the loop.',
  'Safe AllowanceModule enforces spending limits at the contract level — no backend can override them.',
  'EURe is a euro-backed stablecoin issued by Monerium, natively on Gnosis Chain.',
]

// ── In-memory replay guard ────────────────────────────────────────

/** txHash → timestamp of first use */
const seenTxHashes = new Map<string, number>()
const REPLAY_WINDOW_MS = 60 * 60 * 1000 // 1 hour

function isReplayed(txHash: string): boolean {
  const seen = seenTxHashes.get(txHash.toLowerCase())
  if (!seen) return false
  // Expire old entries
  if (Date.now() - seen > REPLAY_WINDOW_MS) {
    seenTxHashes.delete(txHash.toLowerCase())
    return false
  }
  return true
}

function markSeen(txHash: string) {
  seenTxHashes.set(txHash.toLowerCase(), Date.now())
}

// ── Helpers ────────────────────────────────────────────────────────

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

function parseProof(header: string): { txHash?: string } | null {
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString())
  } catch {
    return null
  }
}

// ── Route ─────────────────────────────────────────────────────────

export default async function demoX402Routes(app: FastifyInstance): Promise<void> {
  /**
   * GET /demo/x402/data
   *
   * Public — no agent auth. Acts as the merchant side of x402.
   *
   * Without PAYMENT-SIGNATURE header → 402
   * With valid PAYMENT-SIGNATURE header → 200 + demo payload
   */
  app.get('/data', async (request, reply) => {
    const proofHeader = request.headers['payment-signature'] as string | undefined

    // ── Check for payment proof ──────────────────────────────────
    if (proofHeader) {
      const proof = parseProof(proofHeader)
      const txHash = proof?.txHash ?? (proof as Record<string, unknown> | null)?.['payload']

      // Support both flat { txHash } and nested { payload: { txHash } }
      const resolvedTxHash: string | undefined =
        typeof txHash === 'string'
          ? txHash
          : typeof (proof as Record<string, unknown> | null)?.['payload'] === 'object'
            ? ((proof as Record<string, unknown>)['payload'] as Record<string, unknown>)?.['txHash'] as string | undefined
            : undefined

      if (!resolvedTxHash) {
        return reply.code(400).send({ error: 'Invalid PAYMENT-SIGNATURE: missing txHash' })
      }

      if (isReplayed(resolvedTxHash)) {
        return reply.code(409).send({
          error: 'Payment proof already used',
          txHash: resolvedTxHash,
        })
      }

      markSeen(resolvedTxHash)

      const paidAt = new Date().toISOString()
      const explorerUrl = getExplorerUrl(CHAIN_ID, 'tx', resolvedTxHash)
      const fact = FUN_FACTS[Math.floor(Math.random() * FUN_FACTS.length)]

      reply.header(
        'PAYMENT-RESPONSE',
        b64({ success: true, transaction: resolvedTxHash, network: NETWORK }),
      )

      return reply.code(200).send({
        message: "You paid! Here's your demo data.",
        paidAt,
        txHash: resolvedTxHash,
        explorerUrl,
        fact,
        tip: 'Try asking your agent to fetch this URL again — the SDK handles everything automatically.',
      })
    }

    // ── No proof — return 402 ────────────────────────────────────
    const resourceUrl = `${request.protocol}://${request.hostname}/demo/x402/data`

    const paymentRequired = {
      x402Version: 2,
      resource: {
        url: resourceUrl,
        description: 'Haven demo — pay a tiny amount to unlock this endpoint',
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: 'exact',
          network: NETWORK,
          amount: AMOUNT,
          asset: ASSET,
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
        },
      ],
    }

    reply.header('PAYMENT-REQUIRED', b64(paymentRequired))
    return reply.code(402).send({
      error: 'Payment required',
      x402Version: 2,
      hint: 'Use the Haven SDK (haven.fetch) or POST /x402/authorize to pay and retry.',
    })
  })

  /** GET /demo/x402 — health/info (public) */
  app.get('/', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      endpoint: '/demo/x402/data',
      network: NETWORK,
      asset: ASSET,
      amount: AMOUNT,
      payTo: PAY_TO,
      instructions: [
        '1. Create an agent in the Haven dashboard and copy its credentials.',
        '2. Use haven.fetch("…/demo/x402/data") — the SDK handles 402 → pay → retry automatically.',
        '3. Or: POST /x402/authorize with the payment details, then retry with PAYMENT-SIGNATURE header.',
      ],
    })
  })
}
