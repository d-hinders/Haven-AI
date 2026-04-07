/**
 * Haven Payment Flow Test Script
 *
 * Simulates exactly what a real agent would do to send a payment via Haven.
 * Runs the full three-step flow:
 *   1. POST /payments       — create intent, receive hash to sign
 *   2. Sign locally         — raw ECDSA with delegate private key
 *   3. POST /payments/:id/sign — submit signature, Haven executes on-chain
 *   4. GET  /payments/:id   — poll until confirmed
 *
 * Usage:
 *   cd packages/backend
 *   npx tsx scripts/test-payment-flow.ts
 *
 * Required env vars (set in .env or export before running):
 *   AGENT_API_KEY         — copied from Haven dashboard (sk_agent_xxx)
 *   DELEGATE_PRIVATE_KEY  — private key of the agent's delegate EOA
 *   PAYMENT_TO            — recipient address
 *
 * Optional env vars:
 *   HAVEN_API_URL         — default: http://localhost:3000
 *   PAYMENT_TOKEN         — default: EURe
 *   PAYMENT_AMOUNT        — default: 0.01
 */

import { ethers } from 'ethers'
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

// ── Load .env ─────────────────────────────────────────────────────

const envPath = path.resolve(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath })
}

// ── Config ────────────────────────────────────────────────────────

const CONFIG = {
  apiUrl:           process.env.HAVEN_API_URL        ?? 'http://localhost:3000',
  agentApiKey:      process.env.AGENT_API_KEY        ?? '',
  delegateKey:      process.env.DELEGATE_PRIVATE_KEY ?? '',
  paymentTo:        process.env.PAYMENT_TO           ?? '',
  paymentToken:     process.env.PAYMENT_TOKEN        ?? 'EURe',
  paymentAmount:    process.env.PAYMENT_AMOUNT       ?? '0.01',
}

// ── Console helpers ───────────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
  white:  '\x1b[37m',
}

const log = {
  header: (msg: string) => console.log(`\n${c.bold}${c.white}${msg}${c.reset}`),
  step:   (n: number, total: number, msg: string) =>
    console.log(`\n${c.bold}${c.cyan}[${n}/${total}] ${msg}${c.reset}`),
  info:   (label: string, value: string) =>
    console.log(`      ${c.dim}${label.padEnd(12)}${c.reset} ${value}`),
  ok:     (msg: string) => console.log(`      ${c.green}✓${c.reset} ${msg}`),
  warn:   (msg: string) => console.log(`      ${c.yellow}⚠${c.reset}  ${msg}`),
  error:  (msg: string) => console.log(`      ${c.red}✗${c.reset} ${msg}`),
  link:   (url: string) => console.log(`      ${c.blue}→${c.reset} ${c.dim}${url}${c.reset}`),
  raw:    (msg: string) => console.log(`   ${c.dim}${msg}${c.reset}`),
}

// ── Preflight checks ──────────────────────────────────────────────

function preflight(): void {
  const errors: string[] = []

  if (!CONFIG.agentApiKey) {
    errors.push('AGENT_API_KEY is not set')
  } else if (!CONFIG.agentApiKey.startsWith('sk_agent_')) {
    errors.push(`AGENT_API_KEY looks wrong — expected "sk_agent_..." got "${CONFIG.agentApiKey.slice(0, 15)}..."`)
  }

  if (!CONFIG.delegateKey) {
    errors.push('DELEGATE_PRIVATE_KEY is not set')
  } else {
    try {
      new ethers.Wallet(CONFIG.delegateKey)
    } catch {
      errors.push('DELEGATE_PRIVATE_KEY is not a valid private key')
    }
  }

  if (!CONFIG.paymentTo) {
    errors.push('PAYMENT_TO is not set')
  } else if (!ethers.isAddress(CONFIG.paymentTo)) {
    errors.push(`PAYMENT_TO is not a valid address: ${CONFIG.paymentTo}`)
  }

  if (isNaN(Number(CONFIG.paymentAmount)) || Number(CONFIG.paymentAmount) <= 0) {
    errors.push(`PAYMENT_AMOUNT must be a positive number, got: ${CONFIG.paymentAmount}`)
  }

  if (errors.length > 0) {
    console.log(`\n${c.red}${c.bold}Configuration errors:${c.reset}`)
    errors.forEach((e) => console.log(`  ${c.red}✗${c.reset} ${e}`))
    console.log(`\nSet the missing values in packages/backend/.env or export them.\n`)
    process.exit(1)
  }
}

// ── API helpers ───────────────────────────────────────────────────

async function apiCall<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: T }> {
  const url = `${CONFIG.apiUrl}${path}`
  const headers: Record<string, string> = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${CONFIG.agentApiKey}`,
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await res.json() as T
  return { ok: res.ok, status: res.status, data }
}

// ── Signing ───────────────────────────────────────────────────────

/**
 * Sign a hash with raw ECDSA (no Ethereum message prefix).
 * This matches what AllowanceModule's checkSignature expects.
 */
function signHash(privateKey: string, hash: string): string {
  const signingKey = new ethers.SigningKey(privateKey)
  const sig = signingKey.sign(hash)
  return sig.serialized // 0x + r(32 bytes) + s(32 bytes) + v(1 byte)
}

// ── Polling ───────────────────────────────────────────────────────

async function pollStatus(
  paymentId: string,
  timeoutMs = 90_000,
  intervalMs = 3_000,
): Promise<{ status: string; tx_hash?: string; error_message?: string }> {
  const deadline = Date.now() + timeoutMs
  let lastStatus = ''

  while (Date.now() < deadline) {
    const { ok, data } = await apiCall<{
      status: string
      tx_hash?: string
      error_message?: string
    }>('GET', `/payments/${paymentId}`)

    if (!ok) throw new Error(`Status poll failed`)

    const d = data as { status: string; tx_hash?: string; error_message?: string }

    if (d.status !== lastStatus) {
      if (lastStatus) process.stdout.write(` → ${c.cyan}${d.status}${c.reset}`)
      else             process.stdout.write(`      Status: ${c.cyan}${d.status}${c.reset}`)
      lastStatus = d.status
    } else {
      process.stdout.write('.')
    }

    if (d.status === 'confirmed' || d.status === 'failed' || d.status === 'expired') {
      process.stdout.write('\n')
      return d
    }

    await new Promise((r) => setTimeout(r, intervalMs))
  }

  process.stdout.write('\n')
  throw new Error('Timed out waiting for confirmation (90s)')
}

// ── Main flow ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.header('Haven Payment Flow Test')
  console.log('  ' + '─'.repeat(40))

  // Preflight
  preflight()

  const wallet = new ethers.Wallet(CONFIG.delegateKey)
  const startTime = Date.now()

  log.info('API URL:',    CONFIG.apiUrl)
  log.info('Delegate:',   wallet.address)
  log.info('Token:',      CONFIG.paymentToken)
  log.info('Amount:',     `${CONFIG.paymentAmount} ${CONFIG.paymentToken}`)
  log.info('To:',         CONFIG.paymentTo)

  // ── Step 1: Create payment intent ────────────────────────────────

  log.step(1, 4, 'Creating payment intent...')

  const createRes = await apiCall<{
    payment_id?: string
    status?: string
    expires_at?: string
    sign_data?: {
      hash: string
      components: Record<string, unknown>
      instructions: string
    }
    error?: string
    supported?: string[]
  }>('POST', '/payments', {
    token:  CONFIG.paymentToken,
    amount: CONFIG.paymentAmount,
    to:     CONFIG.paymentTo,
  })

  if (!createRes.ok || !createRes.data.payment_id) {
    log.error(`Failed to create payment intent (HTTP ${createRes.status})`)
    log.raw(JSON.stringify(createRes.data, null, 2))
    process.exit(1)
  }

  const { payment_id, sign_data, expires_at } = createRes.data as {
    payment_id: string
    sign_data: { hash: string; components: Record<string, unknown> }
    expires_at: string
  }

  log.ok(`Intent created: ${c.bold}${payment_id}${c.reset}`)
  log.info('Expires:',    new Date(expires_at).toLocaleTimeString())
  log.info('Hash:',       sign_data.hash)

  // Show components for debugging
  console.log(`\n   ${c.dim}Sign components:${c.reset}`)
  for (const [key, val] of Object.entries(sign_data.components)) {
    log.raw(`  ${key.padEnd(16)} ${val}`)
  }

  // ── Step 2: Sign the hash ─────────────────────────────────────────

  log.step(2, 4, 'Signing with delegate key...')

  const signature = signHash(CONFIG.delegateKey, sign_data.hash)

  // Verify locally before submitting
  const recovered = ethers.recoverAddress(sign_data.hash, signature)
  if (recovered.toLowerCase() !== wallet.address.toLowerCase()) {
    log.error('Local signature verification failed — recovered address does not match delegate')
    log.info('Expected:', wallet.address)
    log.info('Recovered:', recovered)
    process.exit(1)
  }

  log.ok(`Signed by: ${wallet.address}`)
  log.info('Signature:', `${signature.slice(0, 20)}...${signature.slice(-8)}`)
  log.ok('Local verification passed (recovered address matches delegate)')

  // ── Step 3: Submit signature ──────────────────────────────────────

  log.step(3, 4, 'Submitting signature to Haven...')

  const signRes = await apiCall<{
    payment_id?: string
    status?: string
    tx_hash?: string
    error?: string
    details?: string
  }>('POST', `/payments/${payment_id}/sign`, { signature })

  if (!signRes.ok) {
    log.error(`Submission failed (HTTP ${signRes.status})`)
    log.raw(JSON.stringify(signRes.data, null, 2))
    process.exit(1)
  }

  const signData = signRes.data as { tx_hash?: string; status?: string }

  if (signData.tx_hash) {
    log.ok(`Transaction submitted`)
    log.info('Tx hash:', signData.tx_hash)
    log.link(`https://gnosisscan.io/tx/${signData.tx_hash}`)
  } else {
    log.ok(`Submission accepted (status: ${signData.status})`)
  }

  // ── Step 4: Poll for confirmation ─────────────────────────────────

  log.step(4, 4, 'Waiting for on-chain confirmation...')

  let result: { status: string; tx_hash?: string; error_message?: string }
  try {
    result = await pollStatus(payment_id)
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  // ── Final summary ─────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log('\n  ' + '─'.repeat(40))

  if (result.status === 'confirmed') {
    console.log(`\n${c.green}${c.bold}  Payment confirmed! ✓${c.reset}\n`)
    log.info('Token:',    `${CONFIG.paymentAmount} ${CONFIG.paymentToken}`)
    log.info('To:',       CONFIG.paymentTo)
    log.info('Tx hash:',  result.tx_hash ?? 'unknown')
    log.info('Duration:', `${elapsed}s`)
    if (result.tx_hash) {
      log.link(`https://gnosisscan.io/tx/${result.tx_hash}`)
    }
  } else if (result.status === 'failed') {
    console.log(`\n${c.red}${c.bold}  Payment failed.${c.reset}\n`)
    log.error(result.error_message ?? 'Unknown error')
  } else {
    console.log(`\n${c.yellow}${c.bold}  Unexpected final status: ${result.status}${c.reset}\n`)
  }

  console.log()
}

main().catch((err) => {
  console.error(`\n${c.red}Unexpected error:${c.reset}`, err)
  process.exit(1)
})
