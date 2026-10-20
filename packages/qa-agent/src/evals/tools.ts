/**
 * The tool surface the graders match on (#3958).
 *
 * Two surfaces and one rule.
 *
 * The surfaces: the 29 hosted tools of
 * `packages/mcp-server/src/tools-list.snapshot.json` (the InMemoryTransport
 * contract a client receives), split into `PAYMENT_TOOLS` and
 * `NON_PAYMENT_TOOLS`; and the 5 signer tools, the keys of the signer's
 * `toolSchemas` (what `registeredSignerToolNames()` in
 * `packages/signer/src/consent.ts` returns). A tool added to either surface
 * without landing here is a grader blind spot. `tools.test.ts` compares these
 * lists with their upstream sources by set equality (#4121): it reads the
 * snapshot JSON and imports `toolSchemas` from the built `@haven_ai/signer`.
 *
 * Why literal `as const` lists rather than an import of the upstream: the
 * snapshot lives under `packages/mcp-server/`, outside this package's
 * `rootDir: "src"`, so importing it here would break `tsc --noEmit`. That is
 * also why the test reads the file with `readFileSync`.
 *
 * The rule: graders match on the BARE tool name plus
 * `next_tool_server_role`, never on the server-prefixed name. Connect names a
 * derived pair on a non-production backend (`haven-<slug>-dev`,
 * `packages/connect/src/args.ts` § `--bare`) and runtimes prefix tool names
 * with the server entry (`mcp__haven-<slug>-dev__haven_get_agent`). Matching
 * a recorded name directly would compare against an env-derived string.
 */

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
 * Every other hosted tool is in `NON_PAYMENT_TOOLS` below. The signer tools
 * are in neither: this partition is of the 29 HOSTED tools, and the signer
 * never decides whether to retry.
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

/**
 * The hosted tools that move no money: their call creates and executes no
 * payment. The rule is the one above, applied the other way: quotes and
 * probes create nothing, opening or closing a task budget changes authority
 * rather than moving money, and reports and receipts are evidence.
 *
 * A new hosted tool has to land in exactly one of the two lists:
 * `tools.test.ts` fails while a snapshot tool is in neither, naming it
 * as unclassified, so the payment decision cannot be skipped.
 */
export const NON_PAYMENT_TOOLS = [
  'haven_check_funds',
  'haven_close_task_budget',
  'haven_discover_tools',
  'haven_get_agent',
  'haven_get_allowances',
  'haven_get_payment_status',
  'haven_get_receipt',
  'haven_get_resume_state',
  'haven_get_task_budget',
  'haven_list_receipts',
  'haven_open_task_budget',
  'haven_quote_catalog_purchase',
  'haven_quote_mcp_tool',
  'haven_quote_x402',
  'haven_report_delivery_quality',
  'haven_report_settlement_evidence',
  'haven_report_x402_outcome',
  'haven_resume_x402_payment',
  'haven_submit_catalog_entry',
  'haven_verify_receipt',
] as const

/** The 29 hosted tools: the two lists above, which partition the snapshot. */
export const HOSTED_TOOLS = [...PAYMENT_TOOLS, ...NON_PAYMENT_TOOLS] as const

/** The 5 signer tools: the keys of the signer's `toolSchemas`. */
export const SIGNER_TOOLS = [
  'haven_sign',
  'haven_sign_siwx',
  'haven_x402_sign_header',
  'haven_sign_x402',
  'haven_sign_sweep_delegate',
] as const

export const ALL_TOOL_NAMES: readonly string[] = [...HOSTED_TOOLS, ...SIGNER_TOOLS]

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
 * names come back unchanged, so they match nothing in the lists above.
 *
 * Matching nothing is NOT a safe default. For a "did a payment tool run?"
 * grader (`no_payment_retry_after_refusal`), a payment tool missing from
 * these lists is a call the grader cannot see, so the trial passes falsely.
 * That is why `tools.test.ts` holds the lists equal to their upstream
 * sources (#4121) instead of trusting an unknown name to fail.
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

const SIGNER_TOOL_SET = new Set<string>(SIGNER_TOOLS)

/** The bare name is a signer tool? (`SIGNER_TOOLS` — signing is money movement.) */
export function isSignerTool(recorded: string): boolean {
  return SIGNER_TOOL_SET.has(bareToolName(recorded))
}
