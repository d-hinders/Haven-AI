/**
 * Hosted MCP tool HANDLERS — the #2807 compatibility facade, post-#2812.
 *
 * The tool contracts (names, schemas, input-policy decisions, descriptions,
 * payload types) live in `tools/contracts.ts`; the registration seam in
 * `tools/registry.ts`; argument parsing in `tools/parsing.ts`. The cross-tool
 * SAFETY SUPPORT (error normalization + `HostedToolError`, agent guidance and
 * purchase summaries, cap/price selection, MCP transport serialization and
 * merchant-context validation, the expiry-aware signing context, quote
 * responses and status predicates) lives in `tools/support/*` — the derived
 * helper-to-capability mapping that justifies each placement lives in
 * `tools/support/shared-helper-ownership.test.ts`.
 *
 * Every hosted tool is now owned by a capability module and composed into
 * `createToolHandlers` as a typed contribution:
 *
 *   #2809  state / direct-payment / recovery  -> tools/state-direct-recovery.ts
 *   #2810  catalog / quote / prepare          -> tools/catalog-purchase.ts
 *   #2811  plain-HTTP x402                    -> tools/plain-http-x402.ts
 *   #2812  paid-MCP completion                -> tools/paid-mcp-completion.ts
 *
 * This module is now a THIN compatibility/composition facade: it keeps the
 * `createToolHandlers` composition root (the one place every entry imports),
 * the strict-refusal thrower wiring, and the re-export surface unchanged —
 * `index.ts`, `server.ts`, tests and embedders import it exactly as before.
 * It carries NO tool-specific handler and NO tool-specific branching: the
 * permanent tool-ownership and module-boundary guard that enforces that lives
 * in `tools/module-boundaries.test.ts`.
 */
import { HavenClient } from '@haven_ai/sdk'
import {
  type HostedToolHandlers,
} from './tools/contracts.js'
import { setStrictRefusalThrower } from './tools/parsing.js'
import { createCatalogPurchaseHandlers } from './tools/catalog-purchase.js'
import { createPaidMcpCompletionHandlers } from './tools/paid-mcp-completion.js'
import { createPlainHttpX402Handlers } from './tools/plain-http-x402.js'
import { createStateDirectRecoveryHandlers } from './tools/state-direct-recovery.js'
import { HostedToolError } from './tools/support/errors.js'

// #2807: the parsing seam throws through the SUPPORT module's HostedToolError
// so `normalizeError` keeps a single instanceof branch. The wiring stays HERE
// (this module is the composition root every entry imports); the class moved
// to `tools/support/errors.ts` in #2808. Set at module load; the arrow only
// reads the class when invoked, long after declaration.
setStrictRefusalThrower((details) => {
  throw new HostedToolError(details)
})

export {
  toolSchemas,
  toolDescriptions,
  STRICT_INPUT_TOOLS,
  PERMISSIVE_INPUT_TOOLS,
  MCP_TRANSPORT_CASE_HINT,
  type HostedToolName,
  type StrictInputToolName,
  type PermissiveInputToolName,
  type ToolSuccess,
  type ToolFailure,
  type ToolPayload,
  type HostedToolHandler,
  type HostedToolHandlers,
} from './tools/contracts.js'
export {
  toolInputSchema,
  strictRefusalMessage,
  findHostedToolRegistryIssues,
  findHostedToolRegistryIssuesFor,
  assertHostedToolRegistry,
  type HostedToolRegistryIssue,
  type HostedToolRegistryIssueKind,
  type HostedToolRegistryInputs,
} from './tools/registry.js'
export {
  parse,
  parseStrict,
  setStrictRefusalThrower,
  type StrictRefusalThrower,
  type HostedStrictRefusalDetails,
} from './tools/parsing.js'
export { HostedToolError, signerCompatibilityNotice } from './tools/support/index.js'
export {
  createStateDirectRecoveryHandlers,
  STATE_DIRECT_RECOVERY_TOOLS,
  type StateDirectRecoveryToolName,
} from './tools/state-direct-recovery.js'
export {
  createPlainHttpX402Handlers,
  PLAIN_HTTP_X402_TOOLS,
  type PlainHttpX402ToolName,
} from './tools/plain-http-x402.js'
export {
  createPaidMcpCompletionHandlers,
  PAID_MCP_COMPLETION_TOOLS,
  type PaidMcpCompletionToolName,
  type ResolvedMerchantCallContext,
} from './tools/paid-mcp-completion.js'

export function createToolHandlers(haven: HavenClient): HostedToolHandlers {
  return {
    // #2809: state, direct payment and recovery — haven_get_agent,
    // haven_get_allowances, haven_sweep_delegate, haven_send, haven_pay,
    // haven_submit, haven_get_payment_status, haven_get_resume_state,
    // haven_list_receipts, haven_verify_receipt — are owned by the capability
    // module and composed in here. The `HostedToolHandlers` annotation on this
    // function is what keeps the spread honest in ONE direction: a tool the
    // capability stops contributing and this literal does not re-add is a
    // compile error (TS2741 names the missing one), not a boot-time registry
    // issue. The other direction is NOT compile-checked — a key written below
    // that the spread already provides shadows it silently — so do not add a
    // handler here for a tool a capability owns; the disjointness assertion in
    // tools/module-boundaries.test.ts is what catches it.
    ...createStateDirectRecoveryHandlers(haven),

    // #2810: catalog discovery/submission and the quote/prepare/pay path —
    // haven_discover_tools, haven_submit_catalog_entry, haven_quote_mcp_tool,
    // haven_pay_mcp_tool, haven_quote_catalog_purchase,
    // haven_prepare_catalog_purchase — are owned by the capability module and
    // composed in here. Same one-directional guarantee as the spread above: a
    // tool the capability stops contributing is a compile error, a tool
    // re-declared BELOW is a silent shadow, so do not add a handler here for a
    // tool this capability owns.
    ...createCatalogPurchaseHandlers(haven),

    // #2811: the plain-HTTP x402 lifecycle — haven_quote_x402,
    // haven_pay_x402_quote, haven_resume_x402_payment,
    // haven_report_x402_outcome — are owned by the capability module and
    // composed in here. Same one-directional guarantee as the spreads above.
    ...createPlainHttpX402Handlers(haven),

    // #2812: the paid-MCP completion — haven_complete_mcp_tool,
    // haven_settle_mcp_tool — are owned by the capability module and composed
    // in here. Same one-directional guarantee as the spreads above: a tool the
    // capability stops contributing is a compile error, a tool re-declared
    // BELOW is a silent shadow, so do not add a handler here for a tool this
    // capability owns.
    ...createPaidMcpCompletionHandlers(haven),
  }
}
