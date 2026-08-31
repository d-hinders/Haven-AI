import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { HavenClient } from '@haven_ai/sdk'
import {
  createToolHandlers,
  toolDescriptions,
  toolSchemas,
  type HostedToolName,
  type ToolPayload,
} from './tools.js'

export const HOSTED_SERVER_NAME = '@haven_ai/mcp-server'
export const HOSTED_SERVER_VERSION = '0.1.32-alpha.0'

/**
 * MCP `instructions` — the critical path, surfaced to the model at
 * `initialize` (some clients show this even when they never render individual
 * tool descriptions). Kept deliberately free of any version literal: nothing
 * here should ever need a version bump to stay true, so a guard test in
 * `server.test.ts` pins that. Full per-tool detail lives in `toolDescriptions`
 * below; this is the orientation a model reads before picking a tool at all.
 */
export const HOSTED_INSTRUCTIONS = [
  'Haven hosted MCP server: keyless. It constructs and relays payments and never',
  'holds or receives a signing key — signing happens only in the local',
  'haven-signer MCP server. Call haven_get_agent first, every session: identity,',
  'spend_authority_readiness, and live remaining budget in one call. That signal',
  'covers hosted identity + on-chain spend authority ONLY — it cannot see the',
  'local signer; a signer tool call (tools/list suffices) is the signer check.',
  '',
  'For a catalogued MCP merchant, use haven_discover_tools to find a catalog_id,',
  'then haven_quote_catalog_purchase when you need its live price before choosing',
  'a cap. Quotes are informational only: they never reserve a price or create',
  'a payment. Use haven_quote_mcp_tool for an arbitrary MCP merchant. When ready',
  'to buy, call haven_prepare_catalog_purchase with { catalog_id, max_amount_human } —',
  'a spending cap is required. Give it in whole tokens as the user said it:',
  'max_amount_human "1" is 1 USDC. (max_amount is the atomic-unit form, where',
  '"1" is 0.000001 USDC; send one or the other, never both.)',
  'When the user stated NO cap (the common "buy X" case): quote first,',
  'then cap at the live quoted amount. Never invent headroom and never ask the',
  'user for a number they did not volunteer. If the price then rises before',
  'prepare, the cap check refuses safely — re-quote and confirm the new price',
  'with the user. A cap the user DID state always wins over this convention.',
  'Every payment tool response carries next_action,',
  'next_tool, and next_arguments — follow those fields first; description prose',
  'is fallback, not the source of truth. next_tool is Claude-family namespaced',
  '(mcp__<server>__<tool>); if your runtime names servers differently (Codex',
  'config keys: haven, haven_signer), resolve via the paired next_tool_server +',
  'next_tool_name — the bare tool name on that logical server.',
  '',
  'Signing and settling, every x402 payment tool: the response guidance names',
  'the signer tool — pass JUST { payment_id }; the signer fetches the exact',
  'bytes itself, so never copy or re-type typed_data. (haven_pay is the',
  'exception: sign it per its own response guidance, passing typed_data_b64',
  'through unchanged when present.) On the EIP-3009 shape, settle',
  'with payment_id + signature + payment_header. On the erc7710 shape there is',
  'no funding leg and NO payment_header — settle with payment_id + signature',
  'only. The guidance says which shape you are on.',
  'A quote expires at expires_at: re-run the same tool with the SAME',
  'idempotency_key before signing again. An out-of-date signer refuses to sign',
  'with a machine-readable version-mismatch error (code, supported_versions,',
  'received_version) — stop, tell the user to re-run',
  'npx @haven_ai/connect@alpha; nothing has been spent at that point.',
  'If a merchant rejects AFTER funding, the delegate holds stranded funds —',
  'recover them with haven_sweep_delegate.',
  '',
  'A payment outside the agent budget is declined before any money moves. Haven',
  'holds no approval queue, so there is nothing to poll and no approval will ever',
  'arrive for it. On a decline, on a guidance block with safe_to_continue',
  'false, or on any status you do not recognise, stop and tell the user — do not',
  'retry, re-sign, or re-pay — and ask them to grant or raise the budget in Haven.',
  'Spend authority is enforced on-chain by the user\'s account; Haven',
  'never holds keys and cannot override it.',
].join('\n')

export interface HostedClientOptions {
  /** Agent API key (identity) extracted from the request Bearer token. */
  apiKey: string
  /** Haven backend base URL the server relays through. */
  baseUrl?: string
}

/**
 * Build a **keyless** Haven client for one tenant (one request/session).
 *
 * The client is constructed without a `delegateKey`, so it can construct
 * intents (`createIntent`) and relay signatures (`submitSignature`) but cannot
 * sign. This is the non-custodial guarantee in code: the hosted server has no
 * key material and no signing path.
 *
 * @throws if a delegate key ever leaks into this path — a defensive guard so a
 * future refactor can't silently make the hosted server custodial.
 */
export function createHostedHavenClient(options: HostedClientOptions): HavenClient {
  // Base mainnet RPC, so the server can wait for ≥1 on-chain confirmation of
  // the Safe→delegate funding tx before delivering the X-PAYMENT header to the
  // merchant (ensureFundingConfirmed). Read-only RPC — no signing capability.
  const chainRpcs: Record<number, string> = {}
  const baseRpc = process.env.BASE_RPC_URL?.trim()
  if (baseRpc) chainRpcs[8453] = baseRpc

  const client = new HavenClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    chainRpcs,
    // Intentionally NO delegateKey. See custody invariant in
    // docs/architecture/06-hosted-mcp-connect-flow.md.
  })

  if (client.delegateAddress !== undefined) {
    throw new Error(
      'Hosted Haven MCP server must be keyless: a delegate key was present on the client. ' +
        'The hosted server constructs and relays only — the edge signs.',
    )
  }

  return client
}

/**
 * Build an MCP server bound to a keyless Haven client.
 *
 * Each tool dispatch is wrapped in `haven.withRequestContext` so every Haven
 * API request that dispatch issues carries `X-Haven-MCP-Tool: <name>` and the
 * backend can attribute the audit-log row. The async-local store keeps
 * concurrent tenants' headers from leaking into each other.
 */
export function buildHostedMcpServer(haven: HavenClient): McpServer {
  const server = new McpServer(
    {
      name: HOSTED_SERVER_NAME,
      version: HOSTED_SERVER_VERSION,
    },
    { instructions: HOSTED_INSTRUCTIONS },
  )

  const handlers = createToolHandlers(haven)
  // The fluent `.tool(name, description, schema, handler)` overload keeps this
  // in step with the local @haven_ai/mcp package's registration style.
  const registerTool = (server as unknown as {
    tool: (
      name: string,
      description: string,
      schema: unknown,
      handler: (args: unknown) => Promise<unknown>,
    ) => void
  }).tool.bind(server)

  for (const name of Object.keys(toolSchemas) as HostedToolName[]) {
    registerTool(
      name,
      toolDescriptions[name],
      toolSchemas[name],
      async (args: unknown) =>
        haven.withRequestContext({ 'X-Haven-MCP-Tool': name }, async () =>
          toMcpResult(await handlers[name](args)),
        ),
    )
  }

  return server
}

function toMcpResult(payload: ToolPayload) {
  return {
    isError: !payload.success,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}
