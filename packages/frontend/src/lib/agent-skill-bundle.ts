/**
 * Haven agent skill + SDK starter downloads.
 *
 * Two clearly separated artifacts:
 *
 * 1. **The skill** (`buildGenericSkillMd` / `buildSkillBundle`) — a single
 *    generic, secret-free SKILL.md, byte-for-byte identical for every agent.
 *    Identity and live budget come from the `haven_get_agent` /
 *    `haven_get_allowances` runtime tools, never from the file. This is the
 *    download fallback for runtimes the connector cannot write to; the
 *    connector auto-installs the same content where supported.
 *
 * 2. **The SDK starter** (`buildSdkStarterBundle`) — an optional, per-agent
 *    runnable example using @haven_ai/sdk with env-filled credentials. This
 *    is NOT the skill and must never be presented as one.
 *
 * Canonical copy lives in packages/sdk/src/skill-content.ts (the SDK is the
 * single source of truth, consumed directly by packages/connect for connector
 * auto-install). This inline copy is deliberately decoupled: frontend keeps
 * zero @haven_ai/* dependencies so it can deploy standalone on Vercel without
 * an unpublished SDK export. The parity test in
 * __tests__/agent-skill-bundle.test.ts imports the canonical string from the
 * SDK source and asserts byte-for-byte equality, so the two cannot drift.
 */

import JSZip from 'jszip'
import { buildHandoff, buildDotenv, type HandoffInput } from './agent-handoff'

// ── The generic skill ──────────────────────────────────────────────

export function buildGenericSkillMd(): string {
  return `---
name: haven-pay
description: Pay for things from the user's Haven wallet within their agent rules. Use when the user asks to send, pay, tip, or transfer crypto — or when a request hits an HTTP 402 (x402) paywall.
---

# Haven: pay from a Haven wallet

This skill lets the agent make payments from the user's Haven wallet through
the Haven MCP tools. Every payment is checked against the agent's on-chain
budget before money moves; payments above the remaining budget wait for the
user's approval in Haven.

## When to use this skill

- The user asks to send money, pay someone, tip, donate, or transfer tokens.
- A request returns HTTP 402 (x402): use the Haven pay tools to settle it,
  then retry the original request.

## Identity and budget come from the tools — never assume them

Do not guess the wallet address, network, or budget. Read them live:

- \`haven_get_agent\` — agent identity, Haven wallet address, network.
- \`haven_get_allowances\` — current per-token budgets and what remains.

Budgets reset on a period the user chose. If a payment exceeds the remaining
budget it is queued for the user to approve in the Haven dashboard — this is
normal, not an error.

## Paying

- **Direct transfer:** \`haven_pay\` with recipient, amount, and token.
- **x402 paywall:** \`haven_quote_x402\` to get a quote, then
  \`haven_pay_x402_quote\`. In the hosted setup the signing step happens in
  the local Haven signer; follow the tool results — they tell you the next
  action at every step. Retry the original request only when the result says
  \`retry_original_x402_request\`.
- **Paid MCP tool call:** \`haven_pay_mcp_tool\` with the merchant URL, tool
  name, and arguments, then finish in two calls (fast path): \`haven_sign_x402\`
  on the local signer (pass \`payload_hash\`, the nested \`x402.expected\` object,
  and \`payment_required\`) returns \`{ signature, payment_header }\`; then
  \`haven_settle_mcp_tool\` (pass \`payment_id\`, \`signature\`, \`payment_header\`,
  \`merchant_url\`, \`tool_name\`, \`arguments\`, \`mcp_transport\`) funds and settles
  in one step and returns the tool result. If it returns \`settled: false\`,
  funding is queued for the user's approval — tell them and check status later,
  do not re-pay. Step-by-step alternative:
  \`haven_sign\` → \`haven_submit\` → \`haven_x402_sign_header\` →
  \`haven_complete_mcp_tool\`. Pass \`payment_required\`, \`arguments\`, and
  \`mcp_transport\` verbatim from the \`haven_pay_mcp_tool\` result. The returned
  \`expires_at\` is the signing window; if a tool returns
  \`PAYMENT_WINDOW_EXPIRED\`, re-run \`haven_pay_mcp_tool\` with the same
  \`idempotency_key\`. Do not call the merchant yourself — Haven completes the
  merchant leg for you.
- **Prices:** show the user the live price from the pay-tool result, never a
  catalog price. \`haven_discover_tools\` prices are indicative
  (\`price_is_indicative\`) and can be stale. The pay-tool result's \`amount\` /
  \`amount_atomic\` is the amount Haven authorizes for the call — a ceiling the
  merchant settles at or below — so present it as the most the user will pay.
  Pass \`max_amount\` (atomic units) to \`haven_pay_mcp_tool\` /
  \`haven_pay_x402_quote\` to reject a quote whose authorized amount is above the
  user's cap, before any funds move.
- **Status:** \`haven_get_payment_status\` with a \`payment_id\` to check on
  queued or in-flight payments. Do not poll in a tight loop.

## Approval semantics

- A result with \`pending_approval\` means the payment exceeded the remaining
  budget and is waiting for the user in Haven. Tell the user, then check
  status later.
- Never ask the user for private keys. Signing happens only in the local Haven
  signer; the hosted Haven tools never receive the signing key. If a tool
  reports a missing or invalid credential, tell the user to re-run the Haven
  setup command.

## Failure handling

Haven tool failures are shaped like \`{ success: false, code, message, ... }\`
or older \`{ error, status, details? }\` responses. Branch on \`code\` when
present and surface \`message\` or \`error\` verbatim. Common cases:

- \`pending_approval\`: queued for the user's approval (see above).
- \`insufficient_funds\`: the Haven wallet doesn't hold enough of that token.
  Suggest the user add funds in the Haven dashboard.
- \`PRICE_EXCEEDS_MAX\`: the live merchant price exceeded your \`max_amount\`.
  No funds moved; ask the user before retrying with a higher cap.
- \`PAYMENT_WINDOW_EXPIRED\`: re-run \`haven_pay_mcp_tool\` with the same
  \`idempotency_key\`, then sign the fresh \`payload_hash\`.
- \`MERCHANT_REJECTED_AFTER_FUNDING\`: stop retrying the merchant and use
  \`haven_sweep_delegate\` to recover stranded delegate funds.
- Budget exceeded: tell the user how much remains (from
  \`haven_get_allowances\`) and that they can raise the budget in Haven.

## Revoke

If this agent's credential may have leaked, tell the user to pause or revoke
the agent in the Haven dashboard under Agents. New requests stop immediately
for that credential.
`
}

// ── SDK starter (optional, per-agent, clearly not the skill) ───────

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  )
}

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

// Convenience helpers.

export async function pay(to: string, amount: string, token = 'USDC') {
  return haven.pay({ to, amount, token })
}

export async function fetchWith402(url: string, init?: RequestInit) {
  return haven.fetch(url, init)
}
`
}

function buildPackageJson(input: HandoffInput): string {
  const name = slugify(input.agent.name)
  return (
    JSON.stringify(
      {
        name: `haven-sdk-starter-${name}`,
        version: '0.1.0',
        description: `Haven SDK starter for ${input.agent.name}`,
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
 * Build the generic skill download: a zip containing only
 * `haven-pay/SKILL.md`. Identical for every agent — takes no input.
 */
export async function buildSkillBundle(): Promise<SkillBundle> {
  const zip = new JSZip()
  const folder = zip.folder('haven-pay')
  if (!folder) {
    throw new Error('Failed to initialise zip folder')
  }

  folder.file('SKILL.md', buildGenericSkillMd())

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })

  return { blob, filename: 'haven-pay-skill.zip' }
}

/**
 * Build the optional per-agent SDK starter (README, .env.example, pay.ts,
 * package.json). Contains env-filled credentials — treat as sensitive and
 * never present it as "the skill".
 */
export async function buildSdkStarterBundle(input: HandoffInput): Promise<SkillBundle> {
  const zip = new JSZip()
  const slug = slugify(input.agent.name)
  const folder = zip.folder(`haven-sdk-starter-${slug}`)
  if (!folder) {
    throw new Error('Failed to initialise zip folder')
  }

  const handoff = buildHandoff(input)
  const dotenv = buildDotenv(input)

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
    filename: `haven-sdk-starter-${slug}.zip`,
  }
}
