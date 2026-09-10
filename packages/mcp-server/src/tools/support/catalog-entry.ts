/**
 * Shared hosted-MCP support — catalog wrappers that refuse rows which cannot
 * produce a live MCP quote.
 *
 * Extracted VERBATIM from `tools.ts` by #2808 (behavior-preserving move).
 * Called by the catalog quote tool (#2810 slice) AND the guided paid
 * preflight (same slice), with an error shape the generic x402 resume tests
 * also pin — cross-slice by consumption, so it lives in shared support.
 *
 * One-direction dependencies: imports only the SDK and `../errors.js`.
 * Never imports a capability module.
 */
import { AgentPaymentNextAction, HavenApiError, HavenClient, type HavenCatalogEntry } from '@haven_ai/sdk'
import { HostedToolError } from './errors.js'

/**
 * The catalog wrappers must refuse rows that cannot produce a live MCP quote.
 * Keep the existing manual fallback and error shape identical across the quote
 * and paid-preflight paths rather than teaching agents two catalog semantics.
 */
export async function getUsableCatalogMcpEntry(
  haven: HavenClient,
  catalogId: string,
): Promise<HavenCatalogEntry & { toolName: string }> {
  let entry: HavenCatalogEntry
  try {
    entry = await haven.getCatalogEntry(catalogId)
  } catch (err) {
    if (err instanceof HavenApiError && err.statusCode === 404) {
      throw new HostedToolError({
        code: 'CATALOG_ENTRY_NOT_FOUND',
        message:
          `No catalog entry "${catalogId}" is visible to this agent. It may not exist, ` +
          'be delisted, or be curated for a different chain than this agent\'s. Call ' +
          'haven_discover_tools to see entries available on this chain.',
        statusCode: 404,
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        suggestedTool: 'haven_discover_tools',
      })
    }
    throw err
  }

  if (entry.status === 'degraded' || entry.protocol !== 'mcp' || !entry.toolName) {
    throw new HostedToolError({
      code: 'CATALOG_ENTRY_UNUSABLE',
      message:
        `Catalog entry "${entry.id}" (${entry.name}) is ` +
        (entry.status === 'degraded'
          ? 'marked degraded — Haven has not been able to verify its live price recently. '
          : 'missing the MCP tool metadata (protocol/tool_name) this guided preflight needs. ') +
        'Use haven_pay_mcp_tool directly with an explicit merchant_url and tool_name instead.',
      statusCode: 409,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      suggestedTool: 'haven_pay_mcp_tool',
    })
  }

  return entry as HavenCatalogEntry & { toolName: string }
}
