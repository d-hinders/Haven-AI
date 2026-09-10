/**
 * Shared hosted-MCP support — agent guidance and purchase summaries.
 *
 * Extracted VERBATIM from `tools.ts` by #2808 (behavior-preserving move).
 * `buildAgentGuidance` is the structured next-step contract (#1308) every
 * payment tool emits; `buildPurchaseSummary` is the #1349 merchant-display
 * normalizer the settle paths share. Both are emitted from handler bodies in
 * more than one planned capability slice (#2809–#2812), so they live in
 * shared support — never copied.
 *
 * One-direction dependencies: imports only the SDK. Never imports a
 * capability module.
 */
import {
  HavenClient,
  type AgentNextStep,
  type AgentPaymentSummary,
  type AgentPaymentWarning,
  type AgentPurchaseSummary,
} from '@haven_ai/sdk'

/**
 * Default server name → the ROLE it plays, for `next_tool_server_role` (#2550).
 *
 * Keyed on the default names because those are what the `next_tool` literals
 * carry; a client using `--name <slug>` reads the ROLE and resolves the server
 * itself. An unrecognised server yields no role rather than a guess — a wrong
 * role would be worse than an absent one, since the whole point of the field
 * is to be trustworthy when the name is not.
 */
const NEXT_TOOL_SERVER_ROLES: Record<string, 'hosted' | 'signer'> = {
  haven: 'hosted',
  'haven-signer': 'signer',
}

/**
 * The guidance envelope `buildAgentGuidance` emits: the next-step contract
 * plus the two envelope fields that ride with it (#2557).
 *
 * Declared so the return below is BOUND to a type rather than inferred. The
 * type had fallen behind the emission twice — `next_tool_server` /
 * `next_tool_name` (#1588) and `next_tool_server_role` (#2550) were both
 * emitted for a while before `AgentNextStep` mentioned them — because nothing
 * connected the two.
 *
 * Local and unexported on purpose: `AgentNextStep` is the SDK's published
 * next-step contract, while `agent_summary` and `warnings` are this server's
 * envelope around it. Exporting a second public type for an internal shape
 * would widen the SDK's surface to fix an internal binding.
 *
 * **What this does and does not catch** — measured, not assumed. A new
 * property written DIRECTLY into the returned literal is an excess-property
 * error. A property introduced through a conditional spread
 * (`...(cond ? { x } : {})`) is NOT: TypeScript does not excess-property-check
 * spread results, and every optional field here arrives that way. So this
 * binds the shape without closing the exact hole the two drifts came through.
 * It is worth having anyway — it makes `AgentNextStep` load-bearing instead of
 * decorative, so a field REMOVED or RETYPED there breaks the build — but do
 * not read it as a guarantee that the next added field cannot drift.
 */
type AgentGuidanceEnvelope = AgentNextStep & {
  agent_summary: AgentPaymentSummary
  warnings: AgentPaymentWarning[]
}

export function buildAgentGuidance(input: {
  nextAction: AgentNextStep['next_action']
  nextTool?: string
  nextArguments?: Record<string, unknown>
  safeToContinue: boolean
  reason: string
  summary: AgentPaymentSummary
  warnings?: AgentPaymentWarning[]
}): AgentGuidanceEnvelope {
  // #1588: next_tool is Claude-family namespaced (mcp__<server>__<tool>) and
  // kept byte-identical for existing clients; the pair below is the
  // runtime-neutral resolution — Codex names servers by config key
  // (haven, haven_signer), so the prefixed form matches nothing callable
  // there. Derived, not duplicated: one emission point cannot drift.
  const parsedNextTool = input.nextTool
    ? /^mcp__([a-z0-9-]+)__([a-z0-9_]+)$/.exec(input.nextTool)
    : null
  // #2550: the two fields above name the DEFAULT local servers, because a
  // literal is all this process has — a connector run with `--name <slug>`
  // wires `haven-<slug>` / `haven-signer-<slug>`, and nothing about that slug
  // ever reaches Haven. So on a named install `next_tool` and
  // `next_tool_server` both point at a server the client does not have, while
  // the hosted instructions tell the agent to follow those fields FIRST.
  //
  // The role is the runtime-neutral answer: it says WHICH of the client's own
  // servers to call, so the client resolves against config it can actually
  // see. Deliberately ADDITIVE — the three fields above stay byte-identical,
  // because every default install follows them correctly today and fixing a
  // named-install bug must not break the majority case to do it. A client that
  // ignores the role is exactly as correct, and exactly as broken, as before.
  //
  // Derived from the parsed server, not from a second literal beside each call
  // site: one emission point cannot drift, and six hardcoded `next_tool`
  // literals are what produced this defect.
  const nextToolServerRole = parsedNextTool
    ? NEXT_TOOL_SERVER_ROLES[parsedNextTool[1]]
    : undefined
  return {
    next_action: input.nextAction,
    ...(input.nextTool ? { next_tool: input.nextTool } : {}),
    ...(parsedNextTool
      ? { next_tool_server: parsedNextTool[1], next_tool_name: parsedNextTool[2] }
      : {}),
    ...(nextToolServerRole ? { next_tool_server_role: nextToolServerRole } : {}),
    ...(input.nextArguments ? { next_arguments: input.nextArguments } : {}),
    safe_to_continue: input.safeToContinue,
    reason: input.reason,
    agent_summary: input.summary,
    warnings: input.warnings ?? [],
  }
}

/**
 * #1349: normalize only the small merchant display fields agents need to
 * report a purchase. Merchant content is deliberately never allowed to set
 * status, money, network, merchant identity, or transaction hashes.
 */
export function buildPurchaseSummary(input: {
  payment: Awaited<ReturnType<HavenClient['getPaymentStatus']>> | null
  merchantResult: unknown
  fundingTxHash: string | null
  settlementTxHash: string | null
  allowance: AgentPurchaseSummary['allowance']
}): AgentPurchaseSummary {
  const merchantSummary = merchantPurchaseMetadata(input.merchantResult)
  return {
    status: 'settled',
    product: merchantSummary.product,
    amount: input.payment?.amount ?? null,
    amount_atomic: input.payment?.amountAtomic ?? null,
    asset: input.payment?.asset ?? null,
    network: input.payment?.network ?? (input.payment ? `eip155:${input.payment.chainId}` : null),
    merchant: {
      address: input.payment?.merchantAddress ?? null,
      resource_url: input.payment?.resourceUrl ?? null,
    },
    invoice_id: merchantSummary.invoiceId,
    funding_tx_hash: input.fundingTxHash ?? input.payment?.txHash ?? null,
    // The merchant's optional PAYMENT-RESPONSE receipt can name its own tx.
    // Preserve it as evidence, never as the source of the settled status.
    settlement_tx_hash: input.settlementTxHash,
    allowance: input.allowance,
  }
}

function merchantPurchaseMetadata(result: unknown): { product: string | null; invoiceId: string | null } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { product: null, invoiceId: null }
  const structuredContent = (result as { structuredContent?: unknown }).structuredContent
  if (!structuredContent || typeof structuredContent !== 'object' || Array.isArray(structuredContent)) {
    return { product: null, invoiceId: null }
  }
  const summary = (structuredContent as { summary?: unknown }).summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return { product: null, invoiceId: null }
  const value = summary as { product_name?: unknown; product?: unknown; invoice_id?: unknown }
  return {
    product: typeof value.product_name === 'string' ? value.product_name : typeof value.product === 'string' ? value.product : null,
    invoiceId: typeof value.invoice_id === 'string' ? value.invoice_id : null,
  }
}
