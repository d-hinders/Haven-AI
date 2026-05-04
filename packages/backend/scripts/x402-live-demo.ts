/**
 * Haven x402 Live Demo
 *
 * Visar hela x402-flödet mot den hostade demo-endpointen.
 * Ingen lokal server behövs — agenten betalar och får tillbaka data.
 *
 * Usage:
 *   cd packages/backend
 *   npm run demo:x402
 *
 * Kräver i .env:
 *   AGENT_API_KEY         — från Haven-dashboarden (sk_agent_xxx)
 *   DELEGATE_PRIVATE_KEY  — agentens delegate EOA private key
 *
 * Valfritt:
 *   HAVEN_API_URL         — default: http://localhost:3002
 */

import { HavenClient } from '@haven_ai/sdk'
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

// ── Ladda .env ────────────────────────────────────────────────────

const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../..', '.env'),
  path.resolve(import.meta.dirname, '../../..', '.env'),
]
for (const p of envCandidates) {
  if (fs.existsSync(p)) { dotenv.config({ path: p }); break }
}

// ── Config ────────────────────────────────────────────────────────

const HAVEN_URL   = process.env.HAVEN_API_URL        ?? 'http://localhost:3002'
const API_KEY     = process.env.AGENT_API_KEY         ?? ''
const DELEGATE    = process.env.DELEGATE_PRIVATE_KEY  ?? ''
const DEMO_URL    = `${HAVEN_URL}/demo/x402/data`

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  blue: '\x1b[34m', red: '\x1b[31m', white: '\x1b[37m',
}

// ── Preflight ─────────────────────────────────────────────────────

if (!API_KEY || !DELEGATE) {
  console.error(`\n${c.red}Saknar env-variabler:${c.reset}`)
  if (!API_KEY)  console.error(`  AGENT_API_KEY         — kopiera från Haven-dashboarden`)
  if (!DELEGATE) console.error(`  DELEGATE_PRIVATE_KEY  — agentens delegate private key`)
  console.error(`\nLägg till dem i packages/backend/.env\n`)
  process.exit(1)
}

// ── Kör demo ──────────────────────────────────────────────────────

async function main() {
  console.log(`\n${c.bold}${c.white}Haven x402 Live Demo${c.reset}`)
  console.log(`${'─'.repeat(44)}`)
  console.log(`${c.dim}  Haven URL:  ${HAVEN_URL}`)
  console.log(`  Demo URL:   ${DEMO_URL}`)
  console.log(`  Agent key:  ${API_KEY.slice(0, 20)}...${c.reset}\n`)

  const haven = new HavenClient({
    apiKey: API_KEY,
    delegateKey: DELEGATE,
    baseUrl: HAVEN_URL,
  })

  // Steg 1: Försök hämta utan betalning (visar 402)
  console.log(`${c.cyan}${c.bold}Steg 1:${c.reset} Hämtar utan betalning...`)
  const raw = await fetch(DEMO_URL)
  console.log(`  → HTTP ${raw.status} ${raw.statusText}`)
  if (raw.status === 402) {
    const header = raw.headers.get('PAYMENT-REQUIRED')
    if (header) {
      const info = JSON.parse(Buffer.from(header, 'base64').toString())
      const opt = info.accepts[0]
      console.log(`  → Kräver: ${opt.amount} ${opt.asset.slice(0, 10)}... på ${opt.network}`)
      console.log(`  → Betala till: ${opt.payTo}`)
    }
  }

  console.log()

  // Steg 2: Betala automatiskt med haven.fetch()
  console.log(`${c.cyan}${c.bold}Steg 2:${c.reset} Betalar automatiskt med haven.fetch()...`)
  console.log(`${c.dim}  (SDK hanterar 402 → betala → retry automatiskt)${c.reset}`)

  const response = await haven.fetch(DEMO_URL)

  if (!response.ok) {
    const err = await response.text()
    console.error(`\n${c.red}Fel (HTTP ${response.status}):${c.reset} ${err}`)
    process.exit(1)
  }

  const data = await response.json() as {
    message: string
    paidAt: string
    txHash: string
    explorerUrl: string
    fact: string
  }

  console.log(`\n${c.green}${c.bold}✓ Betalning bekräftad!${c.reset}`)
  console.log(`${'─'.repeat(44)}`)
  console.log(`  ${c.bold}${data.message}${c.reset}`)
  console.log(`  ${c.dim}Betalt:  ${data.paidAt}${c.reset}`)
  console.log(`  ${c.dim}Tx:      ${data.txHash}${c.reset}`)
  console.log(`  ${c.blue}  → ${data.explorerUrl}${c.reset}`)
  console.log(`\n  ${c.yellow}💡 ${data.fact}${c.reset}`)
  console.log(`${'─'.repeat(44)}`)
  console.log(`\n${c.dim}Kolla agentens aktivitetsflöde i dashboarden för att se betalningen.${c.reset}\n`)
}

main().catch((err) => {
  console.error(`\n${c.red}Oväntat fel:${c.reset}`, err.message ?? err)
  process.exit(1)
})
