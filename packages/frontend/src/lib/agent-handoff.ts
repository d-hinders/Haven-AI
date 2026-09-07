/**
 * Agent credential handoff generator.
 *
 * Produces a single Markdown file containing everything an external developer
 * needs to make a live delegation agent "payment ready": identity, policy summary, secrets,
 * env-var block, SDK quickstart, and revocation link.
 *
 * All data is assembled client-side from values already available on the
 * Create Agent "Done" step — nothing touches the backend. This preserves the
 * one-time-view property of the secrets: if the user reloads, everything is
 * gone, same as before.
 */

import { getChainConfig } from '@/lib/chains'

// ── Input types ───────────────────────────────────────────────────

export interface HandoffAllowance {
  tokenSymbol: string
  /** Human-readable amount (e.g. "10", not parsed units) */
  amount: string
  /** Reset period in minutes — matches the budget-period encoding */
  resetPeriodMin: number
}

export interface HandoffInput {
  agent: {
    id: string
    name: string
    description?: string
    delegateAddress: string
    safeAddress: string
    safeName?: string
    chainId: number
  }
  policy: {
    allowances: HandoffAllowance[]
  }
  credentials: {
    apiKey: string
    /** Delegate private key — only present if Haven generated the keypair. */
    delegatePrivateKey: string | null
  }
  /** Override for the Haven API base URL included in the handoff. */
  apiBaseUrl?: string
  /** Override for the Haven app URL used in the revoke link. */
  appBaseUrl?: string
}

export interface HandoffArtifacts {
  /** Human-readable Markdown — the primary artefact. */
  markdown: string
  /** Just the env-var block, for developers who only want the secrets. */
  dotenv: string
  /** Suggested filename (slug-based, no secrets). */
  filename: string
}

// ── Helpers ────────────────────────────────────────────────────────

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  )
}

function resetLabel(mins: number): string {
  if (mins === 0) return 'one-time'
  if (mins === 60) return 'per hour'
  if (mins === 1440) return 'per day'
  if (mins === 10080) return 'per week'
  if (mins === 43200) return 'per 30 days'
  if (mins < 60) return `per ${mins}m`
  if (mins % 1440 === 0) return `per ${mins / 1440}d`
  if (mins % 60 === 0) return `per ${mins / 60}h`
  return `per ${mins}m`
}

// ── Env block ──────────────────────────────────────────────────────

export function buildDotenv(input: HandoffInput): string {
  const { agent, credentials, apiBaseUrl } = input
  const lines = [
    `# Haven credentials for "${agent.name}"`,
    `# Shown once at creation — cannot be recovered. Treat like a password.`,
    ``,
    `HAVEN_AGENT_ID=${agent.id}`,
    `HAVEN_API_KEY=${credentials.apiKey}`,
    `HAVEN_DELEGATE_ADDRESS=${agent.delegateAddress}`,
  ]
  if (credentials.delegatePrivateKey) {
    lines.push(`HAVEN_DELEGATE_KEY=${credentials.delegatePrivateKey}`)
  } else {
    lines.push(`# HAVEN_DELEGATE_KEY=<private key for ${agent.delegateAddress}>`)
  }
  lines.push(
    `HAVEN_WALLET_ADDRESS=${agent.safeAddress}`,
    `HAVEN_SAFE_ADDRESS=${agent.safeAddress}`,
    `HAVEN_CHAIN_ID=${agent.chainId}`,
  )
  if (apiBaseUrl) lines.push(`HAVEN_API_URL=${apiBaseUrl}`)
  return lines.join('\n') + '\n'
}

// ── SDK example ────────────────────────────────────────────────────

/**
 * Minimal runnable SDK example. Kept deliberately short so a developer can
 * paste it into a scratch file and make a real payment in under a minute.
 */
function buildSdkExample(hasDelegateKey: boolean): string {
  if (!hasDelegateKey) {
    // User brought their own delegate key — we can't assume how they load it.
    return [
      `import { HavenClient } from '@haven_ai/sdk'`,
      ``,
      `const delegateKey = process.env.HAVEN_DELEGATE_KEY`,
      `if (!delegateKey) throw new Error('Set HAVEN_DELEGATE_KEY before making payments')`,
      ``,
      `const haven = new HavenClient({`,
      `  apiKey: process.env.HAVEN_API_KEY!,`,
      `  // Load your delegate key however your app does it (KMS, vault, env):`,
      `  delegateKey,`,
      `  baseUrl: process.env.HAVEN_API_URL,`,
      `})`,
      ``,
      `const result = await haven.pay({`,
      `  to: '0xRecipientAddress',`,
      `  amount: '1',      // human-readable, e.g. "1" for 1 USDC`,
      `  token: 'USDC',`,
      `})`,
      ``,
      `console.log('Confirmed:', result.txHash)`,
    ].join('\n')
  }
  return [
    `import { HavenClient } from '@haven_ai/sdk'`,
    ``,
    `const delegateKey = process.env.HAVEN_DELEGATE_KEY`,
    `if (!delegateKey) throw new Error('HAVEN_DELEGATE_KEY is not set')`,
    ``,
    `const haven = new HavenClient({`,
    `  apiKey: process.env.HAVEN_API_KEY!,`,
    `  delegateKey,`,
    `  baseUrl: process.env.HAVEN_API_URL,`,
    `})`,
    ``,
    `// Single call: creates intent, signs with delegate key, relays, waits.`,
    `const result = await haven.pay({`,
    `  to: '0xRecipientAddress',`,
    `  amount: '1',      // human-readable, e.g. "1" for 1 USDC`,
    `  token: 'USDC',`,
    `})`,
    ``,
    `console.log('Confirmed:', result.txHash)`,
  ].join('\n')
}

function buildPaidApiExample(): string {
  return [
    `// One-call path for standard x402 paywalls.`,
    `const response = await haven.fetch('https://paid-api.example/data')`,
    `const data = await response.json()`,
    ``,
    `console.log(data)`,
    ``,
    `// Quote-first path when the agent needs to check a price cap before paying.`,
    `const quote = await haven.quoteX402('https://paid-api.example/data', undefined, {`,
    `  idempotencyKey: 'paid-api-data',`,
    `})`,
    `if (Number(quote.amount) > 0.05) throw new Error('Price is above the user cap')`,
    `const paidResponse = await haven.payX402Quote(quote)`,
    `const paidData = await paidResponse.json()`,
  ].join('\n')
}

// ── Markdown generator ─────────────────────────────────────────────

export function buildHandoff(input: HandoffInput): HandoffArtifacts {
  const { agent, policy, credentials, apiBaseUrl, appBaseUrl } = input

  // Resolve chain name defensively — an unknown id shouldn't crash the page.
  let chainName = `chain ${agent.chainId}`
  try {
    chainName = getChainConfig(agent.chainId).name
  } catch {
    /* fall through */
  }

  const hasDelegateKey = !!credentials.delegatePrivateKey
  const revokeUrl = `${(appBaseUrl ?? 'https://haven-ai-frontend.vercel.app').replace(/\/+$/, '')}/agents`

  const policyLines: string[] = []
  if (policy.allowances.length === 0) {
    policyLines.push(`- **Allowances:** none configured`)
  } else {
    policyLines.push(`- **Allowances:**`)
    for (const a of policy.allowances) {
      policyLines.push(`  - ${a.amount} ${a.tokenSymbol} ${resetLabel(a.resetPeriodMin)}`)
    }
  }
  policyLines.push(
    `- **Over-budget payments:** declined — the agent budget is enforced on-chain before any money moves.`,
  )

  const credentialLines: string[] = [
    `**API key** — authenticates every request to Haven:`,
    ``,
    '```',
    credentials.apiKey,
    '```',
  ]
  if (hasDelegateKey) {
    credentialLines.push(
      ``,
      `**Delegate private key** — signs each payment locally before Haven relays it within on-chain rules:`,
      ``,
      '```',
      credentials.delegatePrivateKey!,
      '```',
    )
  } else {
    credentialLines.push(
      ``,
      `**Delegate private key:** you brought your own — make sure the agent has`,
      `access to the private key for \`${agent.delegateAddress}\` in its environment.`,
    )
  }

  const dotenv = buildDotenv(input)
  const sdkExample = buildSdkExample(hasDelegateKey)

  const markdown = ([
    `# Haven agent — ${agent.name}`,
    ``,
    `Everything this agent needs to connect to Haven and make payments within your rules.`,
    `Keep this file private:`,
    `it contains credentials that ${hasDelegateKey ? 'cannot be shown again' : 'authenticate the agent'}.`,
    ``,
    agent.description ? `> ${agent.description}` : null,
    agent.description ? `` : null,
    `## Identity`,
    ``,
    `- **Agent ID:** \`${agent.id}\``,
    `- **Haven wallet:** \`${agent.safeAddress}\`${agent.safeName ? ` (${agent.safeName})` : ''}`,
    `- **Credential address:** \`${agent.delegateAddress}\``,
    `- **Network:** ${chainName} (chain id \`${agent.chainId}\`)`,
    ``,
    `## Agent rules`,
    ``,
    ...policyLines,
    ``,
    `Agent budgets are enforced on-chain before money moves. Payments above`,
    `the remaining budget are declined instead of raising the agent's automatic`,
    `limits; the budget re-arms automatically at its reset period.`,
    ``,
    `## Credentials`,
    ``,
    ...credentialLines,
    ``,
    `## Environment variables`,
    ``,
    `Drop this into the agent's \`.env\`:`,
    ``,
    '```dotenv',
    dotenv.trimEnd(),
    '```',
    ``,
    `## Quickstart (Node.js)`,
    ``,
    `Install the SDK:`,
    ``,
    '```bash',
    `npm install @haven_ai/sdk`,
    '```',
    ``,
    `Make a payment:`,
    ``,
    '```ts',
    sdkExample,
    '```',
    ``,
    `## Paid APIs and machine-payment requests`,
    ``,
    `Use \`haven.fetch()\` when an API may ask the agent to pay. The SDK handles`,
    `standard x402 (HTTP 402) responses by paying within the agent rules, then`,
    `retrying the request with the payment header the API expects. (The legacy`,
    `internal machine-payment demo challenge is retired, #1328 — x402 is the`,
    `merchant protocol.)`,
    ``,
    '```ts',
    buildPaidApiExample(),
    '```',
    ``,
    `## When a payment is declined`,
    ``,
    `If a direct payment, x402 request, or machine-payment request is outside`,
    `the agent's rules — above the remaining budget, to a recipient the budget`,
    `does not allow, or after the budget expired — Haven declines it before any`,
    `money moves. The rules are enforced on-chain, so nothing is queued and`,
    `there is nothing to approve afterwards. The SDK surfaces the decline as a`,
    `structured \`HavenApiError\`. Tell the user; they can raise the agent`,
    `budget in the Haven dashboard, and the budget re-arms at its reset period.`,
    `Check an in-flight payment with \`get_payment_status\` and its payment id.`,
    ``,
    `For x402, follow the SDK's structured results. The pay helpers perform the`,
    `merchant retry themselves, so do not wait on a signal while a call is in`,
    `flight. If you used \`quoteX402()\`, keep the returned quote or the error's`,
    `\`resumeState\`: it identifies the payment if you need to ask about it`,
    `later. If the process crashes after payment, a later`,
    `\`get_payment_status\` call may report`,
    `\`nextAction: 'retry_original_x402_request'\` — only then call`,
    `\`resumeX402Payment()\` with the preserved resume state or payment id.`,
    `Do not rewrite the SDK, start a new merchant session, or retry a`,
    `declined payment in a tight loop.`,
    ``,
    `## First payment — sanity check`,
    ``,
    `Once the env vars are loaded, this one-liner should print a confirmed tx hash`,
    `(replace the recipient with an address you control):`,
    ``,
    '```bash',
    `node --input-type=module -e "import('@haven_ai/sdk').then(async ({HavenClient})=>{`,
    `  const h = new HavenClient({apiKey:process.env.HAVEN_API_KEY, delegateKey:process.env.HAVEN_DELEGATE_KEY, baseUrl:process.env.HAVEN_API_URL});`,
    `  const r = await h.pay({to:'0xRecipient', amount:'0.01', token:'USDC'});`,
    `  console.log(r.txHash);`,
    `})"`,
    '```',
    ``,
    `## Stop the live delegation agent`,
    ``,
    `If this file leaks or the agent misbehaves, pause or revoke this live delegation agent from the Haven dashboard:`,
    ``,
    `${revokeUrl}`,
    ``,
    `Revoking the agent stops new Haven requests for this credential. Archive`,
    `the agent separately if it should leave the main Haven agent list. This`,
    `handoff does not manage permissions from a retired Safe rail; those remain`,
    `outside Haven.`,
    ``,
    apiBaseUrl ? `---` : null,
    apiBaseUrl ? `` : null,
    apiBaseUrl ? `API base URL: \`${apiBaseUrl}\`` : null,
  ] as (string | null)[])
    .filter((line): line is string => line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') + '\n'

  const filename = `skill-haven-agent-${slugify(agent.name)}.md`

  return { markdown, dotenv, filename }
}
