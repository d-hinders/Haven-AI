/**
 * Agent credential JSON builder.
 *
 * Produces the canonical Haven agent credential artifact that the user
 * downloads on the Create Agent "Done" step. The same JSON can be fed into:
 *
 *   - `@haven_ai/mcp` via the `--credentials <path>` arg or the
 *     `HAVEN_CREDENTIALS` env var — both accept this file shape.
 *   - Any custom integration that reads the documented fields.
 *
 * The MCP credential loader requires only `api_key` + `delegate_key`. We emit
 * a richer superset (agent identity, network, current allowance snapshot,
 * revoke URL, timestamps) so the file is self-documenting and future MCP
 * versions can surface "what this credential authorizes" without re-fetching.
 * Unknown fields are ignored by today's loader, so the superset is safe.
 *
 * Important: `budget_summary` is a SNAPSHOT at creation time. The user can
 * change allowances later in Haven, and the on-chain Safe AllowanceModule is
 * the authoritative gate either way. Tools that need live data should call
 * `haven_get_allowances` against Haven's API.
 */

import { getChainConfig } from '@/lib/chains'
import type { HandoffInput } from './agent-handoff'
import { resolveHostedMcpUrl } from './hosted-connect'

/** Slug used in the downloaded filename. Identical rule to agent-handoff.ts. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  )
}

export interface AgentCredentialBudgetEntry {
  token: string
  amount: string
  reset_period_min: number
}

export interface AgentCredentialJson {
  $schema: string
  version: 1
  type: 'haven.agent_credential'
  agent_id: string
  agent_name: string
  agent_slug: string
  api_key: string
  delegate_key: string
  delegate_address: string
  safe_address: string
  chain_id: number
  network: string | null
  api_url: string | null
  /**
   * Hosted MCP endpoint for this credential. Edge signers use this to connect
   * without a local server. Resolves from `NEXT_PUBLIC_HAVEN_MCP_URL` at
   * build/runtime; falls back to the default Railway-issued URL.
   * See `docs/deploy/hosted-mcp.md`.
   */
  mcp_url: string
  budget_summary: AgentCredentialBudgetEntry[]
  revoke_url: string
  created_at: string
  notes: {
    custody: string
    budget_summary: string
    refresh: string
  }
}

export interface AgentCredentialArtifact {
  json: AgentCredentialJson
  jsonText: string
  filename: string
}

const SCHEMA_URL = 'https://haven.ai/schemas/agent-credential.v1.json'

function resolveNetworkName(chainId: number): string | null {
  try {
    return getChainConfig(chainId).name
  } catch {
    return null
  }
}

function defaultRevokeUrl(appBaseUrl: string | undefined): string {
  const base = (appBaseUrl ?? 'https://haven-ai-frontend.vercel.app').replace(/\/+$/, '')
  return `${base}/agents`
}

/**
 * Build the credential artifact downloaded by the Create Agent modal.
 *
 * @throws if the input lacks the agent's delegate private key — the MCP
 * server cannot sign without it. The Create Agent flow always generates a
 * delegate keypair today, so the throw is a defensive guard rather than a
 * branch we expect to hit at runtime.
 */
export function buildAgentCredential(input: HandoffInput): AgentCredentialArtifact {
  const { agent, policy, credentials, apiBaseUrl, appBaseUrl } = input

  if (!credentials.delegatePrivateKey) {
    throw new Error(
      'Haven credential cannot be generated without a delegate private key. ' +
      'The Create Agent flow must generate the delegate keypair before reaching the Done step.',
    )
  }

  const slug = slugify(agent.name)
  const json: AgentCredentialJson = {
    $schema: SCHEMA_URL,
    version: 1,
    type: 'haven.agent_credential',
    agent_id: agent.id,
    agent_name: agent.name,
    agent_slug: slug,
    api_key: credentials.apiKey,
    delegate_key: credentials.delegatePrivateKey,
    delegate_address: agent.delegateAddress,
    safe_address: agent.safeAddress,
    chain_id: agent.chainId,
    network: resolveNetworkName(agent.chainId),
    api_url: apiBaseUrl ?? null,
    mcp_url: resolveHostedMcpUrl(),
    budget_summary: policy.allowances.map((a) => ({
      token: a.tokenSymbol,
      amount: a.amount,
      reset_period_min: a.resetPeriodMin,
    })),
    revoke_url: defaultRevokeUrl(appBaseUrl),
    created_at: new Date().toISOString(),
    notes: {
      custody:
        'Haven is non-custodial. The delegate_key in this file lives only on this machine. ' +
        'Haven\'s backend never receives it. Treat this file like a private key — keep it offline ' +
        'and revoke the agent at revoke_url if it leaks. ' +
        'Restrict file permissions immediately after saving: ' +
        'macOS/Linux: `chmod 600 path/to/this/file.json`. ' +
        'Windows (PowerShell): ' +
        '`icacls path\\to\\this\\file.json /inheritance:r /grant:r "$env:UserName:R"`. ' +
        'Do not store this file in cloud-synced folders (iCloud, Dropbox, OneDrive) or shared dotfile repositories.',
      budget_summary:
        'budget_summary is a snapshot of the on-chain Safe AllowanceModule limits at credential ' +
        'creation. The on-chain limits are the authoritative gate. If you change allowances in ' +
        'Haven later, this snapshot will be stale; the agent will still be constrained by the ' +
        'updated on-chain limits.',
      refresh:
        'You can update the budget in Haven without regenerating this credential. The same api_key ' +
        'and delegate_key continue to work; only the on-chain allowances change.',
    },
  }

  const jsonText = JSON.stringify(json, null, 2) + '\n'
  const filename = `haven-agent-${slug}.json`

  return { json, jsonText, filename }
}
