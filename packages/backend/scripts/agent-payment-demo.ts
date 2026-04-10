/**
 * Haven Agent Payment Demo
 *
 * A real Claude-powered agent that makes payments through Haven.
 * Claude receives a task, reasons about it, and autonomously calls
 * Haven's payment API when it decides a payment is needed.
 *
 * Usage:
 *   cd packages/backend
 *   npm run agent:demo
 *
 *   # Or with a custom task:
 *   npm run agent:demo -- "Pay 0.01 EURe to 0x55C9...755E for data access"
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY     — from console.anthropic.com
 *   AGENT_API_KEY         — Haven agent key (sk_agent_xxx)
 *   DELEGATE_PRIVATE_KEY  — agent's delegate EOA private key
 *   HAVEN_API_URL         — default: http://localhost:3001
 *   PAYMENT_TO            — default recipient for demo tasks
 */

import Anthropic from '@anthropic-ai/sdk'
import { ethers } from 'ethers'
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

// ── Load .env ─────────────────────────────────────────────────────

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

// ── Config ────────────────────────────────────────────────────────

const CONFIG = {
  anthropicKey:  process.env.ANTHROPIC_API_KEY     ?? '',
  havenUrl:      process.env.HAVEN_API_URL         ?? 'http://localhost:3001',
  agentApiKey:   process.env.AGENT_API_KEY         ?? '',
  delegateKey:   process.env.DELEGATE_PRIVATE_KEY  ?? '',
  defaultTo:     process.env.PAYMENT_TO            ?? '',
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
  magenta: '\x1b[35m',
}

// ── Preflight ─────────────────────────────────────────────────────

function preflight(): void {
  const errors: string[] = []
  if (!CONFIG.anthropicKey) errors.push('ANTHROPIC_API_KEY is not set')
  if (!CONFIG.agentApiKey) errors.push('AGENT_API_KEY is not set')
  if (!CONFIG.delegateKey) errors.push('DELEGATE_PRIVATE_KEY is not set')
  if (errors.length > 0) {
    console.log(`\n${c.red}${c.bold}Configuration errors:${c.reset}`)
    errors.forEach((e) => console.log(`  ${c.red}✗${c.reset} ${e}`))
    console.log(`\nSet the missing values in your .env file.\n`)
    process.exit(1)
  }
}

// ── Haven Payment Functions ───────────────────────────────────────

async function havenApi<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(`${CONFIG.havenUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.agentApiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json() as T
  return { ok: res.ok, status: res.status, data }
}

function signHash(privateKey: string, hash: string): string {
  const signingKey = new ethers.SigningKey(privateKey)
  const sig = signingKey.sign(hash)
  return sig.serialized
}

interface PaymentResult {
  success: boolean
  payment_id?: string
  tx_hash?: string
  status?: string
  token?: string
  amount?: string
  to?: string
  error?: string
  gnosisscan_url?: string
}

async function executePayment(
  token: string,
  amount: string,
  to: string,
): Promise<PaymentResult> {
  // Step 1: Create payment intent
  const createRes = await havenApi<{
    payment_id?: string
    sign_data?: { hash: string }
    error?: string
  }>('POST', '/payments', { token, amount, to })

  if (!createRes.ok || !createRes.data.payment_id) {
    return {
      success: false,
      error: createRes.data.error ?? `Failed to create payment intent (HTTP ${createRes.status})`,
    }
  }

  const { payment_id, sign_data } = createRes.data as {
    payment_id: string
    sign_data: { hash: string }
  }

  // Step 2: Sign
  const signature = signHash(CONFIG.delegateKey, sign_data.hash)

  // Step 3: Submit signature
  const signRes = await havenApi<{
    status?: string
    tx_hash?: string
    error?: string
    details?: string
  }>('POST', `/payments/${payment_id}/sign`, { signature })

  if (!signRes.ok) {
    return {
      success: false,
      payment_id,
      error: signRes.data.error ?? signRes.data.details ?? `Submission failed (HTTP ${signRes.status})`,
    }
  }

  // Step 4: Poll for confirmation
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const poll = await havenApi<{
      status: string
      tx_hash?: string
      error_message?: string
    }>('GET', `/payments/${payment_id}`)

    if (poll.ok) {
      const d = poll.data
      if (d.status === 'confirmed') {
        return {
          success: true,
          payment_id,
          tx_hash: d.tx_hash,
          status: 'confirmed',
          token,
          amount,
          to,
          gnosisscan_url: d.tx_hash ? `https://gnosisscan.io/tx/${d.tx_hash}` : undefined,
        }
      }
      if (d.status === 'failed') {
        return {
          success: false,
          payment_id,
          error: d.error_message ?? 'Transaction failed on-chain',
        }
      }
    }
    await new Promise((r) => setTimeout(r, 3000))
  }

  return { success: false, payment_id, error: 'Timed out waiting for confirmation' }
}

// ── Tool Definitions ──────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: 'make_payment',
    description:
      'Send a payment from the Haven-managed Safe wallet. ' +
      'The payment will be validated against the agent\'s on-chain spending policy. ' +
      'Supported tokens: EURe, USDC.e, xDAI. All on Gnosis Chain.',
    input_schema: {
      type: 'object' as const,
      properties: {
        token: {
          type: 'string',
          description: 'Token to send. One of: EURe, USDC.e, xDAI',
        },
        amount: {
          type: 'string',
          description: 'Amount to send as a decimal string, e.g. "0.01"',
        },
        to: {
          type: 'string',
          description: 'Recipient Ethereum address (0x...)',
        },
        reason: {
          type: 'string',
          description: 'Brief reason for this payment (for audit trail)',
        },
      },
      required: ['token', 'amount', 'to', 'reason'],
    },
  },
]

// ── Agent Loop ────────────────────────────────────────────────────

async function runAgent(taskPrompt: string): Promise<void> {
  const client = new Anthropic({ apiKey: CONFIG.anthropicKey })

  const systemPrompt =
    `You are a payment agent operating through Haven, a self-custodial wallet infrastructure. ` +
    `You can make payments using the make_payment tool. ` +
    `You have a budget managed by on-chain spending policies — if a payment exceeds your allowance, it will be rejected. ` +
    `Always confirm the payment details before calling the tool. ` +
    `After a successful payment, report the transaction hash and Gnosisscan link.`

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: taskPrompt },
  ]

  console.log(`\n${c.dim}Claude is thinking...${c.reset}\n`)

  // Conversation loop — handle tool calls until Claude gives a final response
  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages,
    })

    // Process response content blocks
    let hasToolUse = false

    for (const block of response.content) {
      if (block.type === 'text') {
        console.log(`${c.cyan}${c.bold}Claude:${c.reset} ${block.text}\n`)
      }

      if (block.type === 'tool_use') {
        hasToolUse = true
        const input = block.input as {
          token: string
          amount: string
          to: string
          reason: string
        }

        console.log(`${c.magenta}${c.bold}  → Tool call:${c.reset} make_payment`)
        console.log(`${c.dim}    Token:  ${input.token}`)
        console.log(`    Amount: ${input.amount}`)
        console.log(`    To:     ${input.to}`)
        console.log(`    Reason: ${input.reason}${c.reset}\n`)

        // Execute the payment
        console.log(`${c.dim}  Executing payment via Haven...${c.reset}`)
        const result = await executePayment(input.token, input.amount, input.to)

        if (result.success) {
          console.log(`${c.green}${c.bold}  ✓ Payment confirmed!${c.reset}`)
          console.log(`${c.dim}    Tx: ${result.tx_hash}${c.reset}`)
          if (result.gnosisscan_url) {
            console.log(`${c.blue}    → ${result.gnosisscan_url}${c.reset}`)
          }
          console.log()
        } else {
          console.log(`${c.red}  ✗ Payment failed: ${result.error}${c.reset}\n`)
        }

        // Send tool result back to Claude
        messages.push({ role: 'assistant', content: response.content })
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            },
          ],
        })
      }
    }

    // If no tool use, Claude gave a final response — we're done
    if (!hasToolUse || response.stop_reason === 'end_turn') {
      break
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${c.bold}${c.white}Haven Agent Demo${c.reset}`)
  console.log('  ' + '─'.repeat(40))

  preflight()

  const wallet = new ethers.Wallet(CONFIG.delegateKey)
  console.log(`${c.dim}  Agent API:   ${CONFIG.agentApiKey.slice(0, 20)}...`)
  console.log(`  Delegate:    ${wallet.address}`)
  console.log(`  Haven:       ${CONFIG.havenUrl}${c.reset}`)

  // Task from CLI args or default demo
  const customTask = process.argv.slice(2).join(' ').trim()
  const defaultTo = CONFIG.defaultTo || '0x55C9d84427756D6f82480427Bb778F6dc0cC755E'

  const task = customTask ||
    `You are a purchasing agent for a small research company. ` +
    `Our data provider (address: ${defaultTo}) has sent an invoice for 0.01 EURe ` +
    `for this month's API access. Please process this payment.`

  console.log(`\n${c.bold}Task:${c.reset} ${c.white}${task}${c.reset}`)
  console.log('  ' + '─'.repeat(40))

  await runAgent(task)

  console.log('  ' + '─'.repeat(40))
  console.log(`${c.dim}  Demo complete.${c.reset}\n`)
}

main().catch((err) => {
  console.error(`\n${c.red}Unexpected error:${c.reset}`, err)
  process.exit(1)
})
