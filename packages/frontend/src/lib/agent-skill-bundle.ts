/**
 * Agent "skill bundle" generator.
 *
 * Produces a zipped folder that a developer can drop into an agent runtime
 * (Claude Code `~/.claude/skills/`, MCP-aware tooling, or any folder-based
 * agent config) and have the agent making Haven payments immediately.
 *
 * Contents:
 *   SKILL.md           — tool description / when-to-use rules
 *   README.md          — the same handoff document (duplicated for humans)
 *   .env.example       — env vars with values pre-filled
 *   pay.ts             — minimal reference implementation using @haven_ai/sdk
 *   package.json       — dependencies so the example runs standalone
 *
 * The zip is built client-side with JSZip. No backend calls.
 */

import JSZip from 'jszip'
import { buildHandoff, buildDotenv, type HandoffInput } from './agent-handoff'

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  )
}

// ── SKILL.md ───────────────────────────────────────────────────────

function buildSkillMd(input: HandoffInput): string {
  const { agent, policy, appBaseUrl } = input
  const policySummary = policy.allowances
    .map((a) => `${a.amount} ${a.tokenSymbol}`)
    .join(', ') || 'none configured'
  const revokeUrl = `${(appBaseUrl ?? 'https://haven-ai-frontend.vercel.app').replace(/\/+$/, '')}/agents`

  return `---
name: haven-pay
description: Make stablecoin payments via Haven on behalf of the user. Use when the user asks to send, pay, tip, or transfer crypto — or when the agent hits an HTTP 402 response from a paid API.
---

# Haven: pay and receive via a non-custodial agent wallet

This skill lets the agent make payments from a Haven-managed Safe account.
Every payment is checked against the agent's server-side policy before it
executes; the agent cannot spend beyond the configured limits.

## When to use this skill

- The user asks to send money, pay someone, tip, donate, or transfer tokens.
- The agent makes a request and receives an HTTP 402 response (x402) — use
  \`haven.fetch()\` instead of \`fetch()\` and Haven handles the payment loop.

## Agent identity

- **Name:** ${agent.name}
- **Safe account:** \`${agent.safeAddress}\`
- **Network:** chain id \`${agent.chainId}\`
- **Delegate:** \`${agent.delegateAddress}\`

## What this agent is allowed to do

- **Spending limits:** ${policySummary}
- **Recipients:** ${policy.restrictRecipients ? `allowlist (${policy.allowedRecipients.length} entries)` : 'any address'}

If a payment exceeds these limits, Haven rejects it server-side — the skill
surfaces a structured error. Don't try to work around limits; tell the user
to adjust the policy in the Haven dashboard.

## Setup (one-time)

1. Copy \`.env.example\` to \`.env\` — credentials are pre-filled.
2. \`npm install\`
3. Ready. See \`pay.ts\` for the minimal call.

## Usage

\`\`\`ts
import { haven } from './pay'

// Direct payment
const result = await haven.pay({
  to: '0xRecipient',
  amount: '1',
  token: 'USDC',
})

// x402 fetch — handles 402 → pay → retry automatically
const res = await haven.fetch('https://paid-api.example/data')
const data = await res.json()
\`\`\`

## What to return on failure

Haven errors are shaped \`{ error, status, details? }\`. Surface the error
message to the user verbatim — it's written for humans. Common cases:

- \`policy_violation\`: the payment exceeds a limit. Tell the user which
  limit and suggest raising it in the dashboard.
- \`recipient_not_allowed\`: the allowlist blocks this address. Offer to
  add the recipient in the dashboard.
- \`insufficient_funds\`: the Safe doesn't have enough of that token.

## Revoke

If this skill or its credentials leak, revoke the agent at
${revokeUrl} — payments stop immediately.
`
}

// ── pay.ts ─────────────────────────────────────────────────────────

function buildPayTs(): string {
  return `/**
 * Haven payment helper — minimal reference implementation.
 *
 * Imports the HavenClient with credentials loaded from env, and re-exports
 * it so the rest of your agent code can just \`import { haven } from './pay'\`.
 */

import { HavenClient } from '@haven_ai/sdk'

const apiKey = process.env.HAVEN_API_KEY
const delegateKey = process.env.HAVEN_DELEGATE_KEY

if (!apiKey) throw new Error('HAVEN_API_KEY is not set')
if (!delegateKey) throw new Error('HAVEN_DELEGATE_KEY is not set')

export const haven = new HavenClient({
  apiKey,
  delegateKey,
  baseUrl: process.env.HAVEN_API_URL,
})

// Convenience helpers the skill uses directly.

export async function pay(to: string, amount: string, token = 'USDC') {
  return haven.pay({ to, amount, token })
}

export async function fetchWith402(url: string, init?: RequestInit) {
  return haven.fetch(url, init)
}
`
}

// ── package.json ───────────────────────────────────────────────────

function buildPackageJson(input: HandoffInput): string {
  const name = slugify(input.agent.name)
  return (
    JSON.stringify(
      {
        name: `haven-skill-${name}`,
        version: '0.1.0',
        description: `Haven payment skill for ${input.agent.name}`,
        type: 'module',
        private: true,
        dependencies: {
          '@haven_ai/sdk': '^0.1.0',
        },
      },
      null,
      2,
    ) + '\n'
  )
}

// ── Public API ─────────────────────────────────────────────────────

export interface SkillBundle {
  /** Zipped archive as a Blob, ready for download. */
  blob: Blob
  /** Suggested filename for the zip (no secrets in the name). */
  filename: string
}

/**
 * Build a drop-in skill folder zipped for download.
 *
 * Produces a .zip with SKILL.md, README.md, .env.example, pay.ts, package.json.
 */
export async function buildSkillBundle(input: HandoffInput): Promise<SkillBundle> {
  const zip = new JSZip()
  const slug = slugify(input.agent.name)
  const folder = zip.folder(`haven-skill-${slug}`)
  if (!folder) {
    throw new Error('Failed to initialise zip folder')
  }

  const handoff = buildHandoff(input)
  const dotenv = buildDotenv(input)

  folder.file('SKILL.md', buildSkillMd(input))
  folder.file('README.md', handoff.markdown)
  folder.file('.env.example', dotenv)
  folder.file('pay.ts', buildPayTs())
  folder.file('package.json', buildPackageJson(input))

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })

  return {
    blob,
    filename: `haven-skill-${slug}.zip`,
  }
}
