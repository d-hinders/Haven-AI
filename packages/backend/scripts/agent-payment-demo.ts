/**
 * Haven Agent Payment Demo
 *
 * A real Claude-powered agent that makes payments through Haven.
 * Claude receives a task, reasons about it, and autonomously calls
 * Haven's payment API when it decides a payment is needed.
 *
 * This demo uses @haven-fi/sdk to handle the entire payment flow.
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
import { HavenClient, havenTools } from '@haven-fi/sdk'
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

// ── Haven Client (SDK) ───────────────────────────────────────────

const haven = new HavenClient({
  apiKey: CONFIG.agentApiKey,
  delegateKey: CONFIG.delegateKey,
  baseUrl: CONFIG.havenUrl,
})

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

  // Use pre-built tool definitions from the SDK
  const tools = havenTools.claude() as Anthropic.Tool[]

  console.log(`\n${c.dim}Claude is thinking...${c.reset}\n`)

  // Conversation loop — handle tool calls until Claude gives a final response
  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
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
        const input = block.input as Record<string, unknown>

        console.log(`${c.magenta}${c.bold}  → Tool call:${c.reset} ${block.name}`)
        for (const [key, val] of Object.entries(input)) {
          console.log(`${c.dim}    ${key.padEnd(8)} ${val}${c.reset}`)
        }
        console.log()

        // Execute using SDK — one line handles the entire 3-step flow
        console.log(`${c.dim}  Executing via Haven SDK...${c.reset}`)
        const result = await haven.executeTool(block.name, input)

        if (result.success) {
          console.log(`${c.green}${c.bold}  ✓ Payment confirmed!${c.reset}`)
          console.log(`${c.dim}    Tx: ${result.tx_hash}${c.reset}`)
          if (result.explorer_url) {
            console.log(`${c.blue}    → ${result.explorer_url}${c.reset}`)
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
  console.log(`\n${c.bold}${c.white}Haven Agent Demo${c.reset} ${c.dim}(powered by @haven-fi/sdk)${c.reset}`)
  console.log('  ' + '─'.repeat(40))

  preflight()

  console.log(`${c.dim}  Agent API:   ${CONFIG.agentApiKey.slice(0, 20)}...`)
  console.log(`  Delegate:    ${haven.delegateAddress}`)
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
