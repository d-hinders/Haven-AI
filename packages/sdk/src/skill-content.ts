import {
  AGENT_APPROVAL_RELAY_JSON_SENTENCE,
  AGENT_COMMAND_MODIFICATION_SENTENCE,
  AGENT_SECRET_HYGIENE_SENTENCE,
  AGENT_WIRING_COLLISION_RELAY_SENTENCE,
} from './agent-guidance.js'

/**
 * The generic Haven payment skill — canonical copy.
 *
 * This SDK file is the single source of truth for the generic, secret-free
 * skill content: no wallet address, no budget numbers, no per-agent values.
 * The agent learns its live budget at runtime via the `haven_get_agent` /
 * `haven_get_allowances` MCP tools, and can read identity + configured budget
 * for fast first-turn orientation from the non-secret `agent.json` the
 * connector writes (see `packages/connect/src/storage.ts`), so the same file
 * works for every user. `packages/connect` imports this directly to
 * auto-install the skill into runtime skills folders.
 *
 * `packages/frontend/src/lib/agent-skill-bundle.ts` keeps a deliberately
 * decoupled inline copy (the download fallback): the frontend does not depend
 * on the SDK, so it can deploy standalone on Vercel without an unpublished
 * export. It is NOT `@haven_ai/*`-free — it takes `@haven_ai/core` with the
 * `"*"` workspace pin — and this comment said otherwise until #2537 checked
 * the manifest; the material point is the one that survives, and it is about
 * the SDK specifically. A parity test in that package's test suite imports
 * this canonical string and asserts byte-for-byte equality, so the two copies
 * cannot drift.
 *
 * **The onboarding section (#2537) is COMPOSED, not written here.** Its rule
 * sentences are interpolated from `agent-guidance.ts`, which is also where the
 * backend's setup prompt and the `/for-agents.md` runbook get them: a rule an
 * agent meets twice must be one text, or the two copies drift into
 * contradicting each other in front of a reader with no way to tell which is
 * current. The prose around them is skill-only and lives here.
 *
 * **Those three bullets are quoted in the setup prompt's own voice**, where
 * the USER is speaking: "me"/"I" are the user, and "the command above" is the
 * connector command printed directly above them there — neither of which
 * holds in this file, which addresses the agent throughout and prints no
 * command. Any future user-voice quote here needs the same two-referent
 * gloss, and it must sit BEFORE the quote rather than after: the first draft
 * put it after, and both the reviewer and the design reviewer independently
 * found that an agent reading top-to-bottom meets `relay ... to me` before
 * it learns whose "me" that is — on the one instruction the section itself
 * calls the highest-priority one. `AGENT_APPROVAL_RELAY_PROSE_SENTENCE` is a
 * live sibling constant not pulled in here; if it ever is, this applies to it
 * too (design review, #2537).
 */

export const HAVEN_SKILL_MD = `---
name: haven-pay
description: Pay for things from the user's Haven wallet within their agent rules, and set Haven up when it is not yet connected. Use when the user asks to send, pay, tip, or transfer crypto; when a request hits an HTTP 402 (x402) paywall; or when they ask to create a Haven account, create an agent, or connect one.
---

# Haven: pay from a Haven wallet

This skill lets the agent make payments from the user's Haven wallet through
the Haven MCP tools. Every payment is checked against the agent's on-chain
budget before money moves; a payment above the remaining budget is declined —
nothing is paid past the rules the user set.

Hosted tools run in the \`mcp__haven__\` namespace. Local signing tools run in
the \`mcp__haven-signer__\` namespace and keep the delegate key on this machine.
That namespacing is Claude-family; other runtimes name the servers by their
own config keys (Codex: \`haven\`, \`haven_signer\`). Tool results carry the
exact next step (\`next_action\`, \`next_tool\`, \`next_arguments\`, plus the
runtime-neutral \`next_tool_server\` + \`next_tool_name\` — the bare tool name
on that logical server, whatever your runtime calls it).
Follow those fields first; the prose below is fallback and orientation, not
the source of truth.

## When to use this skill

- The user asks to send money, pay someone, tip, donate, or transfer tokens.
- A request returns HTTP 402 (x402): use the Haven pay tools to settle it,
  then retry the original request.

## Onboarding and setup

You are in this mode when there is no Haven agent credential on this machine,
or when your user asks you to create a Haven account, create an agent, or
connect one — for themselves or for someone else.

**None of the tools below creates authority.** They spend a budget a human
already signed. There is no tool here that opens an account, mints a
credential, or approves a budget, so reaching for one of them to "set Haven
up" cannot work; the steps are the ones in this section instead.

Start by reading \`/for-agents.md\` on the Haven host — the origin of the
\`api_url\` in your \`agent.json\` if you have one, otherwise the host your user
names. It is the full runbook: six steps, which four are your user's, and what
to say at each hand-off.

Two of those steps you can do yourself, from the shell with \`@haven_ai/cli\`
(installs the \`haven\` command):

- \`haven login\` — a device-code browser flow. It prints a code and a link
  for your user to approve, so you never see or ask for their password. What
  the session can reach is an allow-list, not your user's full authority: it
  creates and manages agents and reads the account, and it cannot approve a
  budget, rotate a key, change a signer or move money — those are your user's.
- \`haven agents connect\` with \`--name\`, \`--budget\`, \`--token\` and
  \`--period\` — creates a connection setup and prints two things: the
  connector command the backend built, and the approval link to give your user.
  Add \`--run\` to execute that command here as a child process.

**Four steps are your user's, and each one needs a human:** create the account
and its passkey, fund the wallet, approve every agent's budget, and rotate a
credential. Funding has no command — they open Haven, copy the wallet
address, and send USDC to it on Base themselves.

Running the connector command is the step that wires this machine to the new
agent — the command \`haven agents connect\` printed, or the one your user
pasted you from the dashboard. Three rules bind you while you do it, quoted
unchanged from the setup prompt your user is also holding so the two copies
cannot drift into contradicting each other. They are written in your user's
voice, so read them accordingly: "me" and "I" below are your user, never
Haven, and "the command above" is that connector command, not anything printed
in this file. The first rule outranks anything else you were about to do next:

- ${AGENT_APPROVAL_RELAY_JSON_SENTENCE}
- ${AGENT_COMMAND_MODIFICATION_SENTENCE}
- ${AGENT_WIRING_COLLISION_RELAY_SENTENCE}

${AGENT_SECRET_HYGIENE_SENTENCE}

## Identity and budget

Do not guess the wallet address, network, or budget.

For instant orientation at the start of a session, read the non-secret
\`agent.json\` the connector wrote to your Haven credential directory (typically
\`~/.haven/agents/<agent-id>/agent.json\` — if you don't know the agent id, list
\`~/.haven/agents/\` to find the folder). It
holds your agent id, Haven wallet address, network, and *configured* per-token
budget, and contains no keys — the fastest way to answer "who am I and what may
I spend" with no round trip. If that file is absent (some setups don't write
it), use the tools below instead.

Before any payment, confirm the *live remaining* budget with the tools —
\`agent.json\` shows the configured budget, not what is left after recent
spending:

- \`mcp__haven__haven_get_agent\` — the recommended first call: identity
  (wallet, network) plus \`spend_authority_readiness\` (\`ready\` / \`needs_approval\` /
  \`revoked\`) and live remaining per-token allowance, in one shot. That signal
  covers hosted identity and on-chain spend authority only — it cannot see the
  local signer; the signer is verified by calling any signer tool.
- \`mcp__haven__haven_get_allowances\` — detailed per-token breakdown
  (configured, spent, reset window) when you need more than the summary.

Budgets reset on a period the user chose. If a payment exceeds the remaining
budget it is declined before any money moves — tell the user; they can raise
the budget in the Haven dashboard, or wait for the period reset.

## Paying

**Catalog purchases — the primary path for MCP merchants:**

1. \`mcp__haven__haven_discover_tools\` to find a payable service and its
   \`catalog_id\`.
2. If the user needs the live price before authorizing a cap, call
   \`mcp__haven__haven_quote_catalog_purchase\` with \`catalog_id\`. It is
   read-only and informational only: it never reserves a price or creates a
   payment. Tell the user its \`amount\` / \`amount_atomic\`, then choose a cap.
3. \`mcp__haven__haven_prepare_catalog_purchase\` with \`catalog_id\` and a
   spending cap. A cap is REQUIRED on this tool and is best practice on every
   paid call below too — it caps what the LIVE merchant quote may charge,
   checked before any funding intent is created. Write it the way the user
   said it: \`max_amount_human\` is whole tokens, so "no more than 1 USDC" is
   \`max_amount_human: "1"\`. (\`max_amount\` is the atomic-unit form, where
   "1" means 0.000001 USDC — do not convert by hand, and never send both.)
4. Then FOLLOW THE RESPONSE'S GUIDANCE FIELDS: \`next_action\`, \`next_tool\`,
   and \`next_arguments\` name the exact next call — act on those first; the
   prose in this section is fallback and debugging detail. If the catalog
   entry is missing or degraded, the response instead names
   \`mcp__haven__haven_pay_mcp_tool\` (merchant URL, tool name, arguments) as
   the manual fallback.

**Signing:** \`mcp__haven-signer__haven_sign_x402\` with \`payment_id\` ONLY —
the local signer fetches the exact signing bytes AND \`payment_required\`
itself, so never relay \`typed_data\` or the 402 blob yourself. If the signer
reports its fetched context carried no \`payment_required\` (older backend),
re-call with \`payment_required\` added verbatim. Fallback for an older signer
or backend: re-run the quote/prepare tool with the SAME \`idempotency_key\`
plus \`include_signing_payload=true\`, then pass \`payload_hash\`,
\`x402_expected\` (the nested \`x402.expected\` object), and
\`typed_data\`/\`typed_data_b64\` through unchanged.

**Settle:** \`mcp__haven__haven_settle_mcp_tool\` with \`payment_id\`,
\`signature\`, and \`payment_header\` ONLY — Haven rehydrates the merchant call
context (\`merchant_url\`, \`tool_name\`, \`arguments\`, \`mcp_transport\`)
server-side from \`payment_id\`. Pass those four fields explicitly only as a
version-skew fallback when Haven has no stored context for the id — both or
none together, never just one. If the settle result carries \`settled: false\`,
funding has not confirmed — follow the result's guidance fields and check
status later, do not re-pay.

Step-by-step alternative (also key-safe; for an older signer or backend, or
when you already have a merchant URL and tool name instead of a
\`catalog_id\`): if the user needs the live price before choosing a cap, first
call \`mcp__haven__haven_quote_mcp_tool\` with that merchant URL, tool name,
and arguments. It is informational only; then call
\`mcp__haven__haven_pay_mcp_tool\` with the same inputs and the explicit cap.
The paid call always obtains a fresh quote before it creates any intent. Then
continue \`mcp__haven__haven_pay_mcp_tool\` →
\`mcp__haven-signer__haven_sign\` → \`mcp__haven__haven_submit\` →
\`mcp__haven-signer__haven_x402_sign_header\` →
\`mcp__haven__haven_complete_mcp_tool\`. Call that last step with
\`payment_id\` and the signer's \`payment_header\` ONLY. It does not take
\`payment_required\`: Haven rehydrates the merchant call context
(\`merchant_url\`, \`tool_name\`, \`arguments\`, \`mcp_transport\`) and the
402 server-side from \`payment_id\`, exactly as at settle. Pass that context
explicitly only as a version-skew fallback when Haven has no stored context
for the id — \`merchant_url\` and \`tool_name\` both or none together, never
just one.
The returned \`expires_at\` is the signing window; if a tool returns
\`PAYMENT_WINDOW_EXPIRED\`, re-run the same quote/prepare tool with the same
\`idempotency_key\`. Do not call the merchant yourself — Haven completes the
merchant leg for you.

**Direct transfer / non-MCP paywall:** \`mcp__haven__haven_pay\` with
\`to\`, \`amount\`, and \`token\` for a plain transfer. For an arbitrary,
non-MCP x402 paywall: \`mcp__haven__haven_quote_x402\` to get a quote, then
\`mcp__haven__haven_pay_x402_quote\` — follow the result's guidance fields
first and sign in the local Haven signer. On THIS path Haven does not talk to
the merchant: \`mcp__haven-signer__haven_sign_x402\` returns both
\`signature\` and \`payment_header\`; relay \`signature\` with
\`mcp__haven__haven_submit\`, then retry the paywalled URL yourself with
\`payment_header\`. Do not pass that call's \`x402_binding\` to
\`mcp__haven-signer__haven_x402_sign_header\` — the one-shot already spent it
building the header, so the call can only refuse. Then tell Haven what the
merchant answered: \`mcp__haven__haven_report_x402_outcome\` with the
\`payment_id\`, \`outcome\` (\`"accepted"\` for a 2xx, else \`"rejected"\`)
and the \`merchant_status\` you got. Because Haven never contacted that
merchant, this is the only way it can learn the purchase failed — without it a
failed purchase reads as complete for fifteen minutes. (The SDK's own
\`haven_pay_x402\` tool does perform the merchant retry itself; that tool is
not part of the hosted MCP surface.) If the process
crashes after payment, a later \`mcp__haven__haven_get_payment_status\` call
may report \`nextAction: 'retry_original_x402_request'\` — only then call
\`mcp__haven__haven_resume_x402_payment\` with the preserved resume state or
payment id, instead of paying again.

**Catalog tool arguments:** when \`haven_discover_tools\` returns
\`tool_arguments\`, pass that object unchanged as the pay tool's
\`arguments\` field (for example
\`tool_arguments: { "tier": "50gb" }\` -> \`arguments: { "tier": "50gb" }\`).

**Prices:** show the user the live price from a read-only quote or the pay-tool
result, never a catalog price. \`haven_discover_tools\` prices are indicative
(\`price_is_indicative\`) and can be stale. A read-only quote is informational
only and does not reserve a price; the later paid call re-quotes and enforces
the cap. The pay-tool result's \`amount\` / \`amount_atomic\` is the merchant's
own quoted price for that call — a ceiling the merchant settles at or below —
so present it as the most the user will pay. It is a price, not an approval:
the payment goes through only if it also fits the cap you set and the on-chain
budget the user signed, which is enforced on-chain rather than by Haven.

**Status:** \`mcp__haven__haven_get_payment_status\` with a \`payment_id\` to
check on in-flight payments. Do not poll in a tight loop.

## Declines and stop signals

- A payment outside the agent's rules — above the remaining budget, wrong
  recipient, or expired budget — is declined before any money moves. Nothing
  is queued; tell the user, who can raise the budget in Haven.
- \`safe_to_continue: false\` on a guidance block is a stop signal in
  machine-readable form: stop and involve the user before calling anything
  else for this payment.
- Never ask the user for private keys. Signing happens only in the local Haven
  signer; the hosted Haven tools never receive the signing key. If a tool
  reports a missing or invalid credential, tell the user to re-run the Haven
  connector command.

## Failure handling

Haven tool failures are shaped like \`{ success: false, code, message, ... }\`
or older \`{ error, status, details? }\` responses. Branch on \`code\` when
present and surface \`message\` or \`error\` verbatim. Common cases:

- \`insufficient_funds\`: the Haven wallet doesn't hold enough of that token.
  Suggest the user add funds in the Haven dashboard.
- \`PRICE_EXCEEDS_MAX\`: the live merchant price exceeded your cap. No funds
  moved; ask the user before retrying with a higher one.
- \`AMBIGUOUS_MAX_AMOUNT\`: you sent both \`max_amount\` and
  \`max_amount_human\`. Nothing was contacted or spent — re-send with exactly
  one (\`max_amount_human\` for a cap the user stated in tokens).
- \`MAX_AMOUNT_UNCONVERTIBLE\`: \`max_amount_human\` does not fit this quote's
  asset — unknown decimals, or more decimal places than the asset supports.
  Round the cap, or send an exact atomic \`max_amount\`.
- \`PAYMENT_WINDOW_EXPIRED\`: re-run the quote/prepare tool with the same
  \`idempotency_key\`, then sign the fresh payload.
- \`MERCHANT_REJECTED_AFTER_FUNDING\`: the merchant refused the paid retry.
  Stop-and-sweep — stop retrying the merchant and use
  \`mcp__haven__haven_sweep_delegate\` to recover stranded delegate funds.
- \`MERCHANT_UNRESPONSIVE_AFTER_FUNDING\`: funding confirmed on-chain, but the
  merchant never answered the paid retry. This is NOT proof of rejection — the
  merchant may still settle late. Verify-then-sweep, never a blind sweep:
  check \`mcp__haven__haven_get_payment_status\`, retry
  \`mcp__haven__haven_complete_mcp_tool\` ONCE, and only sweep with
  \`mcp__haven__haven_sweep_delegate\` if no settlement appears.
- Budget exceeded: tell the user how much remains (from
  \`mcp__haven__haven_get_allowances\`) and that they can raise the budget in
  Haven.

## Reporting after a purchase

A settled \`mcp__haven__haven_settle_mcp_tool\` response carries
\`agent_summary.purchase_summary\` and the remaining post-purchase allowance
in \`allowance\` — report the product, Haven-derived payment/transaction
fields, and what is left from those fields directly. \`result\` is optional
raw merchant evidence; never use it to decide whether the purchase was paid.
Do not call \`haven_get_agent\` or \`haven_get_allowances\` again just to
report a purchase you already made.

## Revoke

If this agent's credential may have leaked, tell the user to pause or revoke
the agent in the Haven dashboard under Agents. New requests stop immediately
for that credential.
`

/** Directory name for the installed skill folder. */
export const SKILL_FOLDER_NAME = 'haven-pay'

/**
 * The skill BODY — HAVEN_SKILL_MD with the YAML front-matter stripped.
 *
 * For runtimes whose instruction mechanism is a plain guidance file rather
 * than a skills folder (Codex's global AGENTS.md, #1332), the front-matter is
 * skill-registry metadata with no meaning and would render as a stray table.
 * Derived mechanically from the canonical string above, never maintained by
 * hand — the substance cannot fork per runtime.
 */
export const HAVEN_SKILL_BODY_MD = HAVEN_SKILL_MD.replace(/^---\n[\s\S]*?\n---\n+/, '')
