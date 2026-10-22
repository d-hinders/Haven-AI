/**
 * Plain-language labels for the agent's Tool calls tab (#4227, epic #4224).
 *
 * The tab leads each audit row with a plain-language label and carries the
 * raw tool name second, as `code`. The labels map over the CLOSED allowlist
 * `MCP_TOOL_NAMES` — the frontend mirror of
 * `packages/backend/src/middleware/agentToolAudit.ts` (and
 * `packages/mcp`'s registered set — the same 8 names
 * `lib/mcp-consent-hash.ts` hashes). A name retired from the allowlist still
 * appears in old audit rows, so an unknown name falls back to its raw name
 * rather than disappearing or guessing.
 *
 * Keep in sync with `packages/backend/src/middleware/agentToolAudit.ts` →
 * `MCP_TOOL_NAMES`; the lib test iterates this list.
 */
export const MCP_TOOL_NAMES = [
  'haven_quote_x402',
  'haven_pay_x402_quote',
  'haven_resume_x402_payment',
  'haven_get_payment_status',
  'haven_get_resume_state',
  'haven_get_agent',
  'haven_get_allowances',
  'haven_list_receipts',
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

/**
 * One label per allowlisted tool, written for the owner reading an audit
 * trail: what the agent DID, not which endpoint it hit. The x402 wording
 * follows the tools' own summaries (`packages/sdk/src/tool-descriptions.ts`).
 */
const TOOL_CALL_LABELS: Record<McpToolName, string> = {
  // Inspected an HTTP 402 paid resource without paying.
  haven_quote_x402: 'Quoted a paid API',
  // Paid an inspected quote through the delegate.
  haven_pay_x402_quote: 'Paid a quote',
  // Retried a payment whose Haven-side funding confirmed but whose merchant
  // response was never recorded.
  haven_resume_x402_payment: 'Resumed a payment',
  // Fetched structured payment status for agent recovery.
  haven_get_payment_status: 'Checked a payment',
  // Rehydrated stored x402 resume state by payment id.
  haven_get_resume_state: 'Read a payment’s resume state',
  // Identity AND live spend authority in one call.
  haven_get_agent: 'Checked identity and budget',
  // Configured and on-chain allowance state.
  haven_get_allowances: 'Read budgets',
  // Machine-payment receipts, newest first.
  haven_list_receipts: 'Listed payment receipts',
}

/**
 * The label for a tool-call row: the plain-language label for an allowlisted
 * name, otherwise the raw name as-is — a retired tool must still render, and
 * the raw name is the one fact the audit log is certain of.
 */
export function toolCallLabel(toolName: string): string {
  return (TOOL_CALL_LABELS as Record<string, string>)[toolName] ?? toolName
}

/**
 * Known `error_code` values in words, for the error/denied rows' subtitle.
 *
 * The audit middleware captures whatever the response body named as
 * `code`/`error` on a >=400 status, so the value is open-ended: the map
 * covers the codes Haven's own refusals set; anything else (including the
 * backend's full-sentence `error` values, which are already words) renders
 * as-is. Null/absent renders nothing — the caller decides.
 */
const ERROR_CODE_LABELS: Record<string, string> = {
  // The agent's own delegation budget could not cover the call.
  delegation_budget_exceeded: 'Over the agent budget',
  // The sponsoring wallet's budget refused.
  relayer_budget_exceeded: 'Over the wallet budget',
  // The target wallet has no delegation rail for the agent.
  no_delegation_for_target: 'No budget on that wallet',
  signature_rejected: 'Signature rejected',
  account_validation_failed: 'Account validation failed',
  submission_outcome_unknown: 'Submission outcome unknown',
  onchain_execution_failed: 'On-chain execution failed',
  payment_intent_expired: 'Payment intent expired',
}

export function errorCodeLabel(errorCode: string | null | undefined): string | null {
  if (!errorCode) return null
  return ERROR_CODE_LABELS[errorCode] ?? errorCode
}
