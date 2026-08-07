/**
 * Haven x402 Protocol Demo
 *
 * Demonstrates how an agent pays for HTTP 402-gated resources through Haven.
 *
 * Flow:
 *   1. Starts a tiny local server that gates a resource behind HTTP 402
 *   2. Agent (HavenClient) fetches the resource using haven.fetch()
 *   3. SDK detects 402, parses x402 headers, pays via Haven, retries
 *   4. Resource is delivered
 *
 * Usage:
 *   cd packages/backend
 *   npx tsx scripts/x402-demo.ts
 *
 * Required env vars (set in .env):
 *   AGENT_API_KEY         — copied from Haven dashboard (sk_agent_xxx)
 *   DELEGATE_PRIVATE_KEY  — private key of the agent's delegate EOA
 *
 * Optional:
 *   HAVEN_API_URL         — default: http://localhost:3001
 */

import * as http from 'http'
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

// Load .env
const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../..', '.env'),
  path.resolve(import.meta.dirname, '../../..', '.env'),
]
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p })
    break
  }
}

// ── Config ──────────────────────────────────────────────────────

const HAVEN_API_URL = process.env.HAVEN_API_URL ?? 'http://localhost:3001'
const AGENT_API_KEY = process.env.AGENT_API_KEY ?? ''
const DELEGATE_KEY = process.env.DELEGATE_PRIVATE_KEY ?? ''
const MOCK_SERVER_PORT = 4020

// EURe token on Gnosis Chain
const EURE_ADDRESS = '0xcB444e90D8198415266c6a2724b7900fb12FC56E'
// Merchant address (receives the payment)
const MERCHANT_ADDRESS = process.env.PAYMENT_TO ?? '0x3230Fc37bB2A81De452e55F923b949f0a7004306'

if (!AGENT_API_KEY || !DELEGATE_KEY) {
  console.error('Missing AGENT_API_KEY or DELEGATE_PRIVATE_KEY in env')
  process.exit(1)
}

// ── Mock x402 Server ────────────────────────────────────────────

function createMockServer(): Promise<http.Server> {
  const paidSessions = new Set<string>()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${MOCK_SERVER_PORT}`)

    if (url.pathname === '/api/premium-data') {
      // Check for payment proof
      const paymentSig = req.headers['payment-signature'] as string | undefined
      if (paymentSig) {
        try {
          const proof = JSON.parse(Buffer.from(paymentSig, 'base64').toString())
          if (proof.payload?.txHash) {
            paidSessions.add(proof.payload.txHash)
            console.log(`  [Mock Server] Payment verified: tx ${proof.payload.txHash.slice(0, 10)}...`)
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({
                success: true,
                transaction: proof.payload.txHash,
                network: 'eip155:100',
              })).toString('base64'),
            })
            res.end(JSON.stringify({
              data: {
                message: 'Premium data unlocked!',
                insight: 'The agent economy is growing 340% year over year.',
                source: 'Haven Research Institute',
                timestamp: new Date().toISOString(),
              },
            }))
            return
          }
        } catch {
          // Invalid proof, fall through to 402
        }
      }

      // No valid payment — return 402
      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: `http://localhost:${MOCK_SERVER_PORT}/api/premium-data`,
          description: 'Premium market research data',
          mimeType: 'application/json',
        },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:100',       // Gnosis Chain
            amount: '10000000000000000',  // 0.01 EURe (18 decimals)
            asset: EURE_ADDRESS,
            payTo: MERCHANT_ADDRESS,
            maxTimeoutSeconds: 60,
          },
        ],
      }

      res.writeHead(402, {
        'Content-Type': 'application/json',
        'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
      })
      res.end(JSON.stringify({ error: 'Payment required', x402Version: 2 }))
      return
    }

    // Default route
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', message: 'Mock x402 server running' }))
  })

  return new Promise((resolve) => {
    server.listen(MOCK_SERVER_PORT, () => {
      resolve(server)
    })
  })
}

// ── Main Demo ───────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════╗')
  console.log('║      Haven x402 Protocol Demo            ║')
  console.log('╚══════════════════════════════════════════╝')
  console.log()

  // 1. Start mock x402 server
  console.log('1. Starting mock x402 server...')
  const server = await createMockServer()
  console.log(`   Listening on http://localhost:${MOCK_SERVER_PORT}`)
  console.log(`   Resource: /api/premium-data (0.01 EURe)`)
  console.log()

  try {
    // 2. Import SDK dynamically (it's ESM)
    const { HavenClient, parsePaymentRequired, selectPaymentOption } = await import('../../sdk/src/index.js')

    const haven = new HavenClient({
      apiKey: AGENT_API_KEY,
      delegateKey: DELEGATE_KEY,
      baseUrl: HAVEN_API_URL,
    })

    console.log(`2. HavenClient configured`)
    console.log(`   API: ${HAVEN_API_URL}`)
    console.log(`   Delegate: ${haven.delegateAddress}`)
    console.log()

    // 3. First, show what happens without Haven (plain 402)
    console.log('3. Fetching resource WITHOUT Haven...')
    const plainResponse = await fetch(`http://localhost:${MOCK_SERVER_PORT}/api/premium-data`)
    console.log(`   Status: ${plainResponse.status} (Payment Required)`)

    const paymentRequired = parsePaymentRequired(plainResponse)
    const option = selectPaymentOption(paymentRequired.accepts)
    console.log(`   Payment required:`)
    console.log(`     Amount: ${option?.amount} atomic units`)
    console.log(`     Asset: ${option?.asset}`)
    console.log(`     Pay to: ${option?.payTo}`)
    console.log(`     Network: ${option?.network}`)
    console.log()

    // 4. Now fetch WITH Haven — automatic x402 handling
    console.log('4. Fetching resource WITH haven.fetch()...')
    console.log('   (SDK handles 402 → pay → retry automatically)')
    console.log()

    const response = await haven.fetch(`http://localhost:${MOCK_SERVER_PORT}/api/premium-data`)

    if (response.status === 200) {
      const data = await response.json()
      console.log('   ✅ Resource delivered!')
      console.log(`   Status: ${response.status}`)
      console.log(`   Data: ${JSON.stringify(data.data, null, 2)}`)

      // Check payment response header
      const paymentResponse = response.headers.get('PAYMENT-RESPONSE')
      if (paymentResponse) {
        const settlement = JSON.parse(atob(paymentResponse))
        console.log()
        console.log('   Settlement:')
        console.log(`     Success: ${settlement.success}`)
        console.log(`     Tx: ${settlement.transaction}`)
        console.log(`     Network: ${settlement.network}`)
      }
    } else {
      console.log(`   ❌ Unexpected status: ${response.status}`)
      const body = await response.text()
      console.log(`   Body: ${body}`)
    }

    console.log()
    console.log('═══════════════════════════════════════════')
    console.log('Demo complete! The x402 flow:')
    console.log('  1. Agent fetched a paid API → got 402')
    console.log('  2. SDK parsed payment requirements')
    console.log('  3. SDK authorized payment through Haven')
    console.log('  4. Haven checked policy + executed on-chain')
    console.log('  5. SDK retried with payment proof')
    console.log('  6. Resource delivered to agent')
    console.log('═══════════════════════════════════════════')
  } catch (err) {
    console.error()
    console.error('Demo failed:', err instanceof Error ? err.message : err)
    if (err instanceof Error && err.stack) {
      console.error(err.stack)
    }
  } finally {
    server.close()
    process.exit(0)
  }
}

main()
