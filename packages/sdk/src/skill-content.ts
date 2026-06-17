/**
 * The generic Haven payment skill — canonical copy.
 *
 * This SDK file is the single source of truth for the generic, secret-free
 * skill content: no wallet address, no budget numbers, no per-agent values.
 * The agent learns its identity and live budget at runtime via the
 * `haven_get_agent` / `haven_get_allowances` MCP tools, so the same file works
 * for every user. `packages/connect` imports this directly to auto-install the
 * skill into runtime skills folders.
 *
 * `packages/frontend/src/lib/agent-skill-bundle.ts` keeps a deliberately
 * decoupled inline copy (the download fallback): frontend has zero
 * `@haven_ai/*` dependencies so it can deploy standalone on Vercel without an
 * unpublished SDK export. A parity test in that package's test suite imports
 * this canonical string and asserts byte-for-byte equality, so the two copies
 * cannot drift.
 */

export const HAVEN_SKILL_MD = `---
name: haven-pay
description: Pay for things from the user's Haven wallet within their agent rules. Use when the user asks to send, pay, tip, or transfer crypto — or when a request hits an HTTP 402 (x402) paywall.
---

# Haven: pay from a Haven wallet

This skill lets the agent make payments from the user's Haven wallet through
the Haven MCP tools. Every payment is checked against the agent's on-chain
budget before money moves; payments above the remaining budget wait for the
user's approval in Haven.

Hosted tools run in the \`mcp__haven__\` namespace. Local signing tools run in
the \`mcp__haven-signer__\` namespace and keep the delegate key on this machine.

## When to use this skill

- The user asks to send money, pay someone, tip, donate, or transfer tokens.
- A request returns HTTP 402 (x402): use the Haven pay tools to settle it,
  then retry the original request.

## Identity and budget come from the tools — never assume them

Do not guess the wallet address, network, or budget. Read them live:

- \`haven_get_agent\` — agent identity, Haven wallet address, network.
- \`haven_get_allowances\` — current per-token budgets and what remains.

Budgets reset on a period the user chose. If a payment exceeds the remaining
budget it is queued for the user to approve in the Haven dashboard — this is
normal, not an error.

## Paying

- **Direct transfer:** \`haven_pay\` with recipient, amount, and token.
- **x402 paywall:** \`haven_quote_x402\` to get a quote, then
  \`haven_pay_x402_quote\`. In the hosted setup the signing step happens in
  the local Haven signer; follow the tool results — they tell you the next
  action at every step. Retry the original request only when the result says
  \`retry_original_x402_request\`.
- **Paid MCP tool call:** \`mcp__haven__haven_pay_mcp_tool\` with the merchant
  URL, tool name, and arguments, then finish in two calls (fast path):
  \`mcp__haven-signer__haven_sign_x402\` on the local signer (pass
  \`payload_hash\`, \`x402_expected\` as the nested \`x402.expected\` object, and
  \`payment_required\`) returns \`{ signature, payment_header }\`; then
  \`mcp__haven__haven_settle_mcp_tool\` (pass \`payment_id\`, \`signature\`,
  \`payment_header\`, \`merchant_url\`, \`tool_name\`, \`arguments\`,
  \`mcp_transport\`) funds and settles in one step and returns the tool result.
  If it returns \`settled: false\`, funding is queued for the user's approval —
  tell them and check status later, do not re-pay. Step-by-step alternative:
  \`mcp__haven-signer__haven_sign\` → \`mcp__haven__haven_submit\` →
  \`mcp__haven-signer__haven_x402_sign_header\` →
  \`mcp__haven__haven_complete_mcp_tool\`. Pass \`payment_required\`,
  \`arguments\`, and \`mcp_transport\` verbatim from the
  \`mcp__haven__haven_pay_mcp_tool\` result. The returned \`expires_at\` is the
  signing window; if a tool returns \`PAYMENT_WINDOW_EXPIRED\`, re-run
  \`mcp__haven__haven_pay_mcp_tool\` with the same
  \`idempotency_key\`. Do not call the merchant yourself — Haven completes the
  merchant leg for you.
- **Prices:** show the user the live price from the pay-tool result, never a
  catalog price. \`haven_discover_tools\` prices are indicative
  (\`price_is_indicative\`) and can be stale. The pay-tool result's \`amount\` /
  \`amount_atomic\` is the amount Haven authorizes for the call — a ceiling the
  merchant settles at or below — so present it as the most the user will pay.
  Pass \`max_amount\` (atomic units) to \`haven_pay_mcp_tool\` /
  \`haven_pay_x402_quote\` to reject a quote whose authorized amount is above the
  user's cap, before any funds move.
- **Status:** \`haven_get_payment_status\` with a \`payment_id\` to check on
  queued or in-flight payments. Do not poll in a tight loop.

## Approval semantics

- A result with \`pending_approval\` means the payment exceeded the remaining
  budget and is waiting for the user in Haven. Tell the user, then check
  status later.
- Never ask the user for private keys. Signing happens only in the local Haven
  signer; the hosted Haven tools never receive the signing key. If a tool
  reports a missing or invalid credential, tell the user to re-run the Haven
  setup command.

## Failure handling

Haven tool failures are shaped like \`{ success: false, code, message, ... }\`
or older \`{ error, status, details? }\` responses. Branch on \`code\` when
present and surface \`message\` or \`error\` verbatim. Common cases:

- \`pending_approval\`: queued for the user's approval (see above).
- \`insufficient_funds\`: the Haven wallet doesn't hold enough of that token.
  Suggest the user add funds in the Haven dashboard.
- \`PRICE_EXCEEDS_MAX\`: the live merchant price exceeded your \`max_amount\`.
  No funds moved; ask the user before retrying with a higher cap.
- \`PAYMENT_WINDOW_EXPIRED\`: re-run \`mcp__haven__haven_pay_mcp_tool\` with the same
  \`idempotency_key\`, then sign the fresh \`payload_hash\`.
- \`MERCHANT_REJECTED_AFTER_FUNDING\`: stop retrying the merchant and use
  \`mcp__haven__haven_sweep_delegate\` to recover stranded delegate funds.
- Budget exceeded: tell the user how much remains (from
  \`haven_get_allowances\`) and that they can raise the budget in Haven.

## Revoke

If this agent's credential may have leaked, tell the user to pause or revoke
the agent in the Haven dashboard under Agents. New requests stop immediately
for that credential.
`

/** Directory name for the installed skill folder. */
export const SKILL_FOLDER_NAME = 'haven-pay'
