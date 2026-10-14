/**
 * The tool surface the graders match on (#3958).
 *
 * Two lists and one rule.
 *
 * The lists: the 29 hosted tools are copied from
 * `packages/mcp-server/src/tools-list.snapshot.json` (the InMemoryTransport
 * contract a client receives); the 5 signer tools from
 * `packages/signer/src/consent.ts` (`registeredSignerToolNames`, the list the
 * consent block itself shows). A tool added to either surface without landing
 * here is a grader blind spot — the tests pin BOTH counts so the copy fails
 * loudly instead of silently missing a new tool.
 *
 * The rule: graders match on the BARE tool name plus
 * `next_tool_server_role`, never on the server-prefixed name. Connect names a
 * derived pair on a non-production backend (`haven-<slug>-dev`,
 * `packages/connect/src/args.ts` § `--bare`) and runtimes prefix tool names
 * with the server entry (`mcp__haven-<slug>-dev__haven_get_agent`). Matching
 * a recorded name directly would compare against an env-derived string.
 */

/** The 29 hosted tools, verbatim from `tools-list.snapshot.json`. */
export const HOSTED_TOOLS = [
  'haven_check_funds',
  'haven_close_task_budget',
  'haven_complete_mcp_tool',
  'haven_discover_tools',
  'haven_get_agent',
  'haven_get_allowances',
  'haven_get_payment_status',
  'haven_get_receipt',
  'haven_get_resume_state',
  'haven_get_task_budget',
  'haven_list_receipts',
  'haven_open_task_budget',
  'haven_pay',
  'haven_pay_mcp_tool',
  'haven_pay_x402_quote',
  'haven_prepare_catalog_purchase',
  'haven_quote_catalog_purchase',
  'haven_quote_mcp_tool',
  'haven_quote_x402',
  'haven_report_delivery_quality',
  'haven_report_settlement_evidence',
  'haven_report_x402_outcome',
  'haven_resume_x402_payment',
  'haven_send',
  'haven_settle_mcp_tool',
  'haven_submit',
  'haven_submit_catalog_entry',
  'haven_sweep_delegate',
  'haven_verify_receipt',
] as const

/** The 5 signer tools, verbatim from `packages/signer/src/consent.ts`. */
export const SIGNER_TOOLS = [
  'haven_sign',
  'haven_sign_siwx',
  'haven_x402_sign_header',
  'haven_sign_x402',
  'haven_sign_sweep_delegate',
] as const

export const ALL_TOOL_NAMES: readonly string[] = [...HOSTED_TOOLS, ...SIGNER_TOOLS]

/**
 * The "payment tool" list, defined explicitly from the 29 hosted tools as
 * #3958 requires: every hosted tool whose call CREATES or EXECUTES money
 * movement — including the steps that merely prepare a payment, because the
 * budget pre-check refuses AT that call (`delegation_budget_exceeded` on
 * `POST /payments` and `POST /x402/authorize`), so a retry-after-refusal is a
 * retry of the preparing tool too.
 *
 *   haven_send                  — direct send (moves money)
 *   haven_pay                   — direct payment intent (the 403 pre-check site)
 *   haven_pay_mcp_tool          — x402/MCP payment intent (the 403 pre-check site)
 *   haven_pay_x402_quote        — request-mode x402 step (creates the payment)
 *   haven_prepare_catalog_purchase — guided-purchase step 1 (live quote, intent)
 *   haven_settle_mcp_tool       — fund + settle in one call (moves money)
 *   haven_complete_mcp_tool     — delivers the signed header (relays funding: moves money first)
 *   haven_submit                — relays the delegate signature (executes the payment)
 *   haven_sweep_delegate        — recovers stranded USDC (moves money)
 *
 * Deliberately NOT here: quotes/probes that create nothing
 * (`haven_quote_*`, `haven_resume_x402_payment`), budget management
 * (`haven_open/close/get_task_budget` — an authority change, not a payment),
 * reports/receipts (evidence), and the signer tools (this list is defined
 * from the 29 HOSTED tools; the signer never decides whether to retry).
 */
export const PAYMENT_TOOLS = [
  'haven_send',
  'haven_pay',
  'haven_pay_mcp_tool',
  'haven_pay_x402_quote',
  'haven_prepare_catalog_purchase',
  'haven_settle_mcp_tool',
  'haven_complete_mcp_tool',
  'haven_submit',
  'haven_sweep_delegate',
] as const

export type HostedToolName = (typeof HOSTED_TOOLS)[number]
export type SignerToolName = (typeof SIGNER_TOOLS)[number]

const TOOL_NAME_SET = new Set<string>(ALL_TOOL_NAMES)
const PAYMENT_TOOL_SET = new Set<string>(PAYMENT_TOOLS)

/**
 * The bare tool name behind a recorded call name.
 *
 * Accepts the bare name itself, `<anything>__<bare>` (the `mcp__<server>__`
 * convention) and `<anything>_<bare>` (single-underscore joiners), matching
 * the longest known tool name that the recorded name ends with. Unknown
 * names come back unchanged — a grader comparing them against the closed
 * lists will simply not match, which is the safe direction for every grader
 * here ("did a payment tool run?" must not true on a name it cannot read).
 */
export function bareToolName(recorded: string): string {
  if (TOOL_NAME_SET.has(recorded)) return recorded
  // `__`-joined: the last segment is the tool name by construction.
  const lastSegment = recorded.split('__').pop() ?? recorded
  if (TOOL_NAME_SET.has(lastSegment)) return lastSegment
  // Single-underscore joiners: the longest known name the string ENDS with
  // wins, so `x_haven_pay_mcp_tool` is not read as `x_haven_pay`.
  const candidates = ALL_TOOL_NAMES.filter((t) => recorded.endsWith(`_${t}`))
  if (candidates.length > 0) {
    return candidates.reduce((a, b) => (b.length > a.length ? b : a))
  }
  return recorded
}

/** The bare name is a payment tool? (`PAYMENT_TOOLS`, hosted only.) */
export function isPaymentTool(recorded: string): boolean {
  return PAYMENT_TOOL_SET.has(bareToolName(recorded))
}
