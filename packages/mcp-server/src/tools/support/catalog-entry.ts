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
import { refusalNextStep } from './guidance.js'

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
        nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.StopAndTellUser, nextTool: null, nextToolOmittedReason: 'the user has to decide before anything is called again; suggested_tool names the tool for after that' }),
        suggestedTool: 'haven_discover_tools',
      })
    }
    throw err
  }

  // #3423 item 1: check the PROTOCOL first, the same order `discoveryHintFor`
  // (`catalog-purchase.ts`) already uses. An http row has no `tool_name` at
  // all, so the mcp-row fallback below (`haven_pay_mcp_tool`, which needs a
  // tool name) cannot be followed — this is a plain-HTTP x402 paywall, and
  // the right next call is the same one discovery already names for it.
  // Precedent for a refusal that names a DIFFERENT tool: task-budgets.ts's
  // unresolved-token refusal (#3213).
  if (entry.protocol !== 'mcp') {
    throw new HostedToolError({
      code: 'CATALOG_ENTRY_UNUSABLE',
      message:
        `Catalog entry "${entry.id}" (${entry.name}) is a plain-HTTP x402 paywall, not an MCP ` +
        'tool — this guided preflight only handles MCP catalog rows. Nothing was contacted and ' +
        'nothing was reserved. Call haven_quote_x402 with the entry\'s resource URL instead.',
      statusCode: 409,
      nextStep: refusalNextStep({
        nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
        nextTool: 'haven_quote_x402',
        nextArguments: { url: entry.resourceUrl },
      }),
      suggestedTool: 'haven_quote_x402',
    })
  }

  if (entry.status === 'degraded' || !entry.toolName) {
    throw new HostedToolError({
      code: 'CATALOG_ENTRY_UNUSABLE',
      message:
        `Catalog entry "${entry.id}" (${entry.name}) is ` +
        (entry.status === 'degraded'
          ? 'marked degraded — Haven has not been able to verify its live price recently. '
          // #3423 review round 1 nit: by this point `entry.protocol === 'mcp'`
          // already (the http check above threw otherwise), so `tool_name`
          // is the only metadata that can be missing here.
          : 'missing the MCP tool_name this guided preflight needs. ') +
        'Use haven_pay_mcp_tool directly with an explicit merchant_url and tool_name instead.',
      statusCode: 409,
      nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.StopAndTellUser, nextTool: null, nextToolOmittedReason: 'the user has to decide before anything is called again; suggested_tool names the tool for after that' }),
      suggestedTool: 'haven_pay_mcp_tool',
    })
  }

  return entry as HavenCatalogEntry & { toolName: string }
}
