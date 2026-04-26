/**
 * Agent credential handoff generator.
 *
 * Produces a single Markdown file containing everything an external developer
 * needs to make the agent "payment ready": identity, policy summary, secrets,
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
  /** Reset period in minutes — matches the allowance-module encoding */
  resetPeriodMin: number
}

export interface HandoffRecipient {
  address: string
  label?: string
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
    restrictRecipients: boolean
    allowedRecipients: HandoffRecipient[]
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
    `HAVEN_API_KEY=${credentials.apiKey}`,
  ]
  if (credentials.delegatePrivateKey) {
    lines.push(`HAVEN_DELEGATE_KEY=${credentials.delegatePrivateKey}`)
  }
  lines.push(
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
      `const haven = new HavenClient({`,
      `  apiKey: process.env.HAVEN_API_KEY!,`,
      `  // Load your delegate key however your app does it (KMS, vault, env):`,
      `  delegateKey: process.env.HAVEN_DELEGATE_KEY!,`,
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
    `const haven = new HavenClient({`,
    `  apiKey: process.env.HAVEN_API_KEY!,`,
    `  delegateKey: process.env.HAVEN_DELEGATE_KEY!,`,
    `  baseUrl: process.env.HAVEN_API_URL,`,
    `})`,
    ``,
    `// Single call: creates intent, signs with delegate key, executes, waits.`,
    `const result = await haven.pay({`,
    `  to: '0xRecipientAddress',`,
    `  amount: '1',      // human-readable, e.g. "1" for 1 USDC`,
    `  token: 'USDC',`,
    `})`,
    ``,
    `console.log('Confirmed:', result.txHash)`,
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
  const revokeUrl = `${(appBaseUrl ?? 'https://app.haven.xyz').replace(/\/+$/, '')}/agents`

  const policyLines: string[] = []
  if (policy.allowances.length === 0) {
    policyLines.push(`- **Allowances:** none configured`)
  } else {
    policyLines.push(`- **Allowances:**`)
    for (const a of policy.allowances) {
      policyLines.push(`  - ${a.amount} ${a.tokenSymbol} ${resetLabel(a.resetPeriodMin)}`)
    }
  }
  if (policy.restrictRecipients) {
    if (policy.allowedRecipients.length === 0) {
      policyLines.push(
        `- **Recipients:** allowlist enabled but empty — the agent cannot send anywhere until you add recipients.`,
      )
    } else {
      policyLines.push(`- **Allowed recipients:**`)
      for (const r of policy.allowedRecipients) {
        policyLines.push(
          `  - \`${r.address}\`${r.label ? ` — ${r.label}` : ''}`,
        )
      }
    }
  } else {
    policyLines.push(`- **Recipients:** any address`)
  }

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
      `**Delegate private key** — signs each payment locally before Haven executes it:`,
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
    `Everything this agent needs to make payments via Haven. Keep this file private:`,
    `it contains credentials that ${hasDelegateKey ? 'cannot be shown again' : 'authenticate the agent'}.`,
    ``,
    agent.description ? `> ${agent.description}` : null,
    agent.description ? `` : null,
    `## Identity`,
    ``,
    `- **Agent ID:** \`${agent.id}\``,
    `- **Safe account:** \`${agent.safeAddress}\`${agent.safeName ? ` (${agent.safeName})` : ''}`,
    `- **Delegate address:** \`${agent.delegateAddress}\``,
    `- **Network:** ${chainName} (chain id \`${agent.chainId}\`)`,
    ``,
    `## Policy`,
    ``,
    ...policyLines,
    ``,
    `The Haven backend enforces this policy on every request. An agent presenting`,
    `these credentials can only spend within these limits — losing them ≠ losing`,
    `the Safe.`,
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
    `## Revoke`,
    ``,
    `If this file leaks or the agent misbehaves, revoke it from the Haven dashboard:`,
    ``,
    `${revokeUrl}`,
    ``,
    `Revocation is instant and cannot be undone — you'll need to create a new`,
    `agent to restore payments.`,
    ``,
    apiBaseUrl ? `---` : null,
    apiBaseUrl ? `` : null,
    apiBaseUrl ? `API base URL: \`${apiBaseUrl}\`` : null,
  ] as (string | null)[])
    .filter((line): line is string => line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') + '\n'

  const filename = `${slugify(agent.name)}-haven.md`

  return { markdown, dotenv, filename }
}
