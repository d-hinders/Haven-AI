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
- **Paid MCP tool call:** \`haven_pay_mcp_tool\` with the merchant URL, tool
  name, and arguments. Then follow the returned steps: \`haven_sign\` the
  funding hash, \`haven_submit\` the signature, \`haven_x402_sign_header\` to
  build the payment header, and finally \`haven_complete_mcp_tool\` to settle
  with the merchant and get the tool result. Pass \`payment_id\`,
  \`payment_required\`, \`mcp_transport\`, and \`arguments\` through verbatim from the
  \`haven_pay_mcp_tool\` result. Do not call the merchant yourself — Haven
  completes the merchant leg for you.
- **Prices:** show the user the live merchant price, never a catalog price.
  \`haven_discover_tools\` prices are indicative (\`price_is_indicative\`) and can
  be stale; the authoritative price is in the pay-tool result
  (\`amount\` / \`amount_atomic\`, from the merchant's 402). Pass \`max_amount\`
  (atomic units) to \`haven_pay_mcp_tool\` / \`haven_pay_x402_quote\` to reject a
  quote above the user's cap before any funds move.
- **Status:** \`haven_get_payment_status\` with a \`payment_id\` to check on
  queued or in-flight payments. Do not poll in a tight loop.

## Approval semantics

- A result with \`pending_approval\` means the payment exceeded the remaining
  budget and is waiting for the user in Haven. Tell the user, then check
  status later.
- Never ask the user for private keys and never try to sign anything
  yourself — Haven signs. If a tool reports a missing or invalid credential,
  tell the user to re-run the Haven setup command.

## Failure handling

Haven errors are shaped \`{ error, status, details? }\` and written for
humans — surface the message verbatim. Common cases:

- \`pending_approval\`: queued for the user's approval (see above).
- \`insufficient_funds\`: the Haven wallet doesn't hold enough of that token.
  Suggest the user add funds in the Haven dashboard.
- Budget exceeded: tell the user how much remains (from
  \`haven_get_allowances\`) and that they can raise the budget in Haven.

## Revoke

If this agent's credential may have leaked, tell the user to pause or revoke
the agent in the Haven dashboard under Agents. New requests stop immediately
for that credential.
`

/** Directory name for the installed skill folder. */
export const SKILL_FOLDER_NAME = 'haven-pay'
