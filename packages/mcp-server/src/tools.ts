import { randomUUID } from 'node:crypto'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  HavenApiError,
  MerchantTimeoutError,
  X402UnexpectedStatusError,
  AgentPaymentWarningCode,
  type AgentNextStep,
  type AgentPurchaseSummary,
  type AgentPaymentWarning,
  type AgentPaymentSummary,
  HavenClient,
  HavenError,
  HavenPaymentStateError,
  SIGNER_UPDATE_FALLBACK,
  composeDescription,
  discoverMerchantMcpUrl,
  resolveTokenFromAddress,
  sameUrl,
  selectStandardPaymentOption,
  validateStandardX402PaymentHeader,
  X402PaymentHeaderValidationError,
  toolDescriptions as sharedDescriptions,
  verifyPaymentReceipt,
  x402AuthorizationAmount,
  type PaymentReceipt,
  type HavenCatalogEntry,
  type SweepAuthorization,
  type X402McpTransport,
  type X402PaymentRequired,
  selectX402SettlementScheme,
  normalizePaymentRequired,
  type X402Quote,
  type X402ResumeState,
} from '@haven_ai/sdk'
import { z } from 'zod/v3'

/**
 * Hosted MCP tool set — keyless.
 *
 * Every tool here either reads agent state or performs the construct/relay
 * half of a payment. None of them sign: quote/pay tools return the unsigned
 * hash for the edge signer to sign, and haven_submit relays a signature the
 * edge produced. The bound `HavenClient` is constructed without a
 * `delegateKey`, so the signing methods are unavailable by construction.
 *
 * The tool surface mirrors the local MCP (`@haven_ai/mcp`) where semantics
 * map cleanly. Tools that require local signing in the local MCP return
 * signing context (payload_hash + x402/mpp context) instead so the agent can
 * route to the local edge signer.
 *
 * Contract: docs/architecture/06-hosted-mcp-connect-flow.md.
 */
export type HostedToolName =
  | 'haven_get_agent'
  | 'haven_get_allowances'
  | 'haven_send'
  | 'haven_pay'
  | 'haven_submit'
  | 'haven_pay_mcp_tool'
  | 'haven_quote_mcp_tool'
  | 'haven_prepare_catalog_purchase'
  | 'haven_quote_catalog_purchase'
  | 'haven_complete_mcp_tool'
  | 'haven_settle_mcp_tool'
  | 'haven_quote_x402'
  | 'haven_pay_x402_quote'
  | 'haven_resume_x402_payment'
  | 'haven_get_payment_status'
  | 'haven_get_resume_state'
  | 'haven_list_receipts'
  | 'haven_verify_receipt'
  | 'haven_sweep_delegate'
  | 'haven_discover_tools'

/** Legacy aliases kept for one release cycle so existing agents don't break. */
export type HostedToolNameLegacy = 'haven_x402_authorize' | 'haven_list_transactions'

export const toolSchemas: Record<HostedToolName, z.ZodRawShape> = {
  haven_get_agent: {},
  haven_get_allowances: {},
  haven_sweep_delegate: {
    // Phase 2 only: the authorization returned by phase 1 and the signature from
    // the local signer. Omit both to run phase 1 (prepare). Passed through to the
    // backend, which re-derives and re-verifies everything before relaying.
    authorization: z
      .object({
        from: z.string(),
        to: z.string(),
        value: z.string(),
        validAfter: z.string(),
        validBefore: z.string(),
        nonce: z.string(),
        token: z.string(),
        chainId: z.number(),
      })
      .optional(),
    signature: z.string().optional(),
  },
  haven_discover_tools: {
    category: z.string().optional(),
    search: z.string().optional(),
    rail: z.enum(['x402', 'mpp']).optional(),
  },
  haven_send: {
    asset: z.enum(['ETH', 'USDC']),
    recipient: z.string().min(1),
    amount: z.string().min(1),
    idempotency_key: z.string().optional(),
  },
  haven_pay: {
    token: z.string().min(1),
    amount: z.string().min(1),
    to: z.string().min(1),
    idempotency_key: z.string().min(1).max(128).optional(),
  },
  haven_submit: {
    payment_id: z.string().min(1),
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'signature must be a 0x-prefixed hex string'),
  },
  haven_pay_mcp_tool: {
    // #1271: the exact MCP endpoint OR a base merchant URL — a non-402 probe
    // miss triggers one bounded same-origin discovery pass
    // (/.well-known/haven-demo-merchant, then /) and one retry at the
    // document's mcp_url. The response's merchant_url is the RESOLVED one.
    merchant_url: z.string().url(),
    tool_name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    // Required pre-funding price cap, atomic units of the merchant's asset
    // (same unit as payment_required.accepts[].amount). If the live merchant
    // price exceeds this, the call is rejected before any funding transfer.
    max_amount: z
      .string()
      .regex(/^[0-9]+$/, 'max_amount must be a decimal atomic amount')
      .optional(),
    // #1351: the SAME cap written in whole tokens — "1" means 1 USDC, not one
    // atomic unit. Preferred when the user stated a cap in tokens (they always
    // do); decimals come from the live quote's asset. Mutually exclusive with
    // max_amount: sending both is rejected before the merchant probe.
    max_amount_human: z
      .string()
      .regex(
        /^[0-9]+(\.[0-9]+)?$/,
        'max_amount_human must be a plain decimal amount in whole tokens, e.g. "1" or "0.25"',
      )
      .optional(),
    idempotency_key: z.string().optional(),
    // #1272: the bulky delegation-rail signing payload (typed_data /
    // typed_data_b64) is omitted by default — the signer fetches the exact
    // bytes itself from payment_id (#1263). Set true for diagnostics or an
    // older signer, re-running with the SAME idempotency_key: the replay
    // contract returns the ORIGINAL sign_data, so the bytes never change.
    include_signing_payload: z.boolean().optional(),
  },
  haven_quote_mcp_tool: {
    // The read-only counterpart to haven_pay_mcp_tool. It establishes the
    // merchant's MCP session and obtains its live 402, but deliberately takes
    // no cap/idempotency argument: a quote is informational only, never a
    // reservation or a payment input.
    merchant_url: z.string().url(),
    tool_name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
  },
  haven_prepare_catalog_purchase: {
    // #1306: the guided path — starts from a curated catalog row instead of a
    // hand-copied merchant_url/tool_name/tool_arguments. Chain-scoped to this
    // agent for free by the backend's /catalog/:id SQL (#1299).
    catalog_id: z.string().min(1),
    // A cap is REQUIRED on this tool, as on haven_pay_mcp_tool — this is the
    // guided path, so there is no cap_warning softness
    // here. Give it in EITHER spelling; both are enforced against the LIVE
    // quote before any funding intent is created. #1351: the requirement moved
    // out of the schema into readMaxAmountCap (which accepts either field and
    // still refuses, INVALID_INPUT, before any network call) because zod's raw
    // shape cannot express "exactly one of these two".
    max_amount: z
      .string()
      .regex(/^[0-9]+$/, 'max_amount must be a decimal atomic amount')
      .optional(),
    // #1351: preferred spelling — whole tokens, so "1" is 1 USDC. Mutually
    // exclusive with max_amount.
    max_amount_human: z
      .string()
      .regex(
        /^[0-9]+(\.[0-9]+)?$/,
        'max_amount_human must be a plain decimal amount in whole tokens, e.g. "1" or "0.25"',
      )
      .optional(),
    idempotency_key: z.string().optional(),
    // #1272: same contract as haven_pay_mcp_tool — see there.
    include_signing_payload: z.boolean().optional(),
  },
  haven_quote_catalog_purchase: {
    // The catalog convenience wrapper over haven_quote_mcp_tool. Unlike the
    // guided purchase, it must never inspect allowance, construct an intent,
    // or ask the local signer for anything.
    catalog_id: z.string().min(1),
  },
  haven_complete_mcp_tool: {
    payment_id: z.string().min(1),
    // #1307: OPTIONAL — omit merchant_url/tool_name and Haven rehydrates the
    // stored MCP call context (recorded by haven_pay_mcp_tool) from
    // payment_id. Pass all four explicitly only as the version-skew fallback
    // (older signer/backend, or a context Haven never stored).
    merchant_url: z.string().url().optional(),
    tool_name: z.string().min(1).optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    mcp_transport: z.object({
      handshake_required: z.boolean(),
      source: z.enum(['path', 'bazaar']),
    }).optional(),
    // The X-PAYMENT header built by the local signer (haven_x402_sign_header).
    // #1456: OPTIONAL — its absence selects erc7710, where Haven assembles the
    // header at settle instead of the signer building it locally.
    payment_header: z.string().min(1).optional(),
  },
  haven_settle_mcp_tool: {
    // Fast-path settle: fund (relay signature) AND deliver the merchant header
    // in one hosted call. Combines haven_submit + haven_complete_mcp_tool.
    payment_id: z.string().min(1),
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'signature must be a 0x-prefixed hex string'),
    // #1307: OPTIONAL — same rehydration-by-payment_id contract as
    // haven_complete_mcp_tool above.
    merchant_url: z.string().url().optional(),
    tool_name: z.string().min(1).optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    mcp_transport: z.object({
      handshake_required: z.boolean(),
      source: z.enum(['path', 'bazaar']),
    }).optional(),
    // The X-PAYMENT header built by the local signer (haven_sign_x402).
    // #1456: OPTIONAL — its absence selects erc7710, where Haven assembles the
    // header at settle instead of the signer building it locally.
    payment_header: z.string().min(1).optional(),
  },
  haven_quote_x402: {
    url: z.string().url(),
    method: z.string().optional(),
    headers: z.record(z.string()).optional(),
  },
  haven_pay_x402_quote: {
    // The parsed HTTP 402 PaymentRequired the agent received from the merchant
    // (or the paymentRequired field from a haven_quote_x402 result).
    // Validated downstream by the SDK; typed as an object (not z.unknown()) so
    // MCP clients embed it as JSON rather than serialising it to a string.
    payment_required: z.record(z.string(), z.unknown()),
    // Optional pre-funding price cap, atomic units (same unit as
    // payment_required.accepts[].amount). Rejected before funding if exceeded.
    max_amount: z
      .string()
      .regex(/^[0-9]+$/, 'max_amount must be a decimal atomic amount')
      .optional(),
    // #1351: the same cap in whole tokens ("1" = 1 USDC), converted with the
    // decimals of the asset in the selected payment option. Mutually exclusive
    // with max_amount.
    max_amount_human: z
      .string()
      .regex(
        /^[0-9]+(\.[0-9]+)?$/,
        'max_amount_human must be a plain decimal amount in whole tokens, e.g. "1" or "0.25"',
      )
      .optional(),
    idempotency_key: z.string().optional(),
    // #1272: same contract as haven_pay_mcp_tool — see there.
    include_signing_payload: z.boolean().optional(),
  },
  haven_resume_x402_payment: {
    payment_id: z.string().optional(),
    resume_state: z.record(z.string(), z.unknown()).optional(),
  },
  haven_get_payment_status: {
    payment_id: z.string().min(1),
  },
  haven_get_resume_state: {
    payment_id: z.string().min(1),
  },
  haven_list_receipts: {
    limit: z.number().int().min(1).max(100).optional(),
  },
  haven_verify_receipt: {
    receipt: z.unknown(),
  },
}

// ── Legacy tool schemas (one release cycle compatibility shim) ───────────────
export const legacyToolSchemas: Record<HostedToolNameLegacy, z.ZodRawShape> = {
  haven_x402_authorize: toolSchemas.haven_pay_x402_quote,
  haven_list_transactions: toolSchemas.haven_list_receipts,
}

/**
 * The `capabilities.experimental` key the local signer advertises its supported
 * expected-context versions under (#1155).
 *
 * Spelled out rather than imported: `@haven_ai/signer` is a devDependency here,
 * and the hosted server is keyless — it must not take a runtime dependency on
 * the signing package. One constant, referenced by every agent-facing surface
 * that names it, so a rename on the signer side has a single place to land;
 * `hosted-signer-integration.test.ts` imports both packages and pins this to
 * the signer's exported `SIGNER_CAPABILITY_KEY`.
 */
const SIGNER_CAPABILITY_KEY = 'haven/signer-compatibility'

/** Where the agent reads the signer's supported set, for use inside prose. */
const SIGNER_CAPABILITY_SOURCE =
  `capabilities.experimental["${SIGNER_CAPABILITY_KEY}"]`

const PAY_DESCRIPTION = [
  'Construct a payment within the agent budget and return the unsigned payload to sign.',
  'For read-only allowance, budget, spend-limit, remaining-amount, or reset-period questions,',
  'call haven_get_allowances instead of constructing a payment.',
  'Returns { payment_id, payload_hash, expires_at } when the amount fits the remaining',
  'budget. Sign with the local signer (haven_sign) then relay with haven_submit.',
  'DELEGATION-RAIL accounts: pass typed_data_b64 to haven_sign UNCHANGED alongside payload_hash',
  '(one opaque string; never re-type the nested typed_data JSON, #1255 — the payment_id fetch',
  'covers x402 intents only, not these direct payments); the account validates',
  'the typed data, and a bare-hash signature is rejected on-chain (#1254).',
  'Returns { status: "pending_approval", payload_hash: null } when the amount',
  'exceeds the budget; the user must approve it in Haven. Haven never receives the signing key.',
].join(' ')

/**
 * #1254: the delegation-rail signing fields, forwarded VERBATIM whenever the
 * backend sent them. The x402 quote path always did this; the direct
 * haven_pay/haven_send path dropped them — so the local signer raw-signed the
 * userOp hash and the Hybrid account rejected it at validation (AA24). One
 * helper now, so a future surface cannot re-make the mistake by omission.
 */
function delegationSignFields(signData: {
  signature_scheme?: string
  typed_data?: Record<string, unknown>
}): Record<string, unknown> {
  return signData.signature_scheme
    ? {
        signature_scheme: signData.signature_scheme,
        typed_data: signData.typed_data,
        // #1255: the same payload as ONE opaque base64 string. A redemption
        // UserOp's callData makes typed_data a multi-KB nested object, and an
        // agent re-emitting it between tool calls can truncate or reshape it —
        // the signer's digest check then refuses (correctly) and the payment
        // dies with no defect anywhere in the chain. The b64 form is copied
        // as a single string; the signer decodes it into the SAME digest
        // verification, so transport gets safer while the trust model is
        // unchanged.
        ...(signData.typed_data
          ? {
              typed_data_b64: Buffer.from(JSON.stringify(signData.typed_data)).toString('base64'),
            }
          : {}),
      }
    : {}
}

const SUBMIT_DESCRIPTION = [
  'Relay a delegate signature produced by the local signer to execute a previously constructed',
  'payment. Pass the payment_id from haven_pay, haven_pay_x402_quote,',
  'or a resume tool, and the signature over its payload_hash. Funding relay sends',
  '{ payment_id, signature } to Haven — never the signing key. Returns { status, tx_hash }.',
  'For decomposed x402 flows, next after confirmed funding: call mcp__haven-signer__haven_x402_sign_header.',
].join(' ')

const PAY_MCP_TOOL_DESCRIPTION = composeDescription({
  ...sharedDescriptions.payMcpTool,
  // #1311: sentence 1 = what this does + its position in the purchase flow;
  // sentence 2 = follow the structured fields; then the compact must-knows
  // (max_amount, payment_id-first signing); protocol notes (#-references,
  // discovery fallback, version-skew check, step-by-step alternative) are
  // kept in full but demoted to the end — debugging detail, not the first
  // thing an agent has to scan.
  summary:
    'Step 1 of the x402 MCP purchase flow: call a named tool on an MCP merchant that requires payment, probe the live price, and create the funding intent for the local signer to sign.',
  behavior:
    'FOLLOW THE STRUCTURED FIELDS FIRST (#1308): the response carries next_action, next_tool, next_arguments, agent_summary and warnings — act on those; the prose below is fallback and debugging detail. ' +
    'Sign with next_tool — mcp__haven-signer__haven_sign_x402, PREFERRED payment_id-only (#1263, #1355): pass JUST payment_id and the signer fetches the exact signing bytes AND payment_required itself, so you never copy bulky bytes (older signer/backend: add payment_required verbatim if the signer asks); the response is COMPACT by default (#1272: no typed_data/typed_data_b64). ' +
    'Then settle with mcp__haven__haven_settle_mcp_tool using the returned signature + payment_header — merchant_url/tool_name/arguments/mcp_transport are OPTIONAL there (#1307): Haven rehydrates them from this quote by payment_id; pass them explicitly only as a version-skew fallback. Next: call mcp__haven-signer__haven_sign_x402. ' +
    'ALWAYS cap paid merchant calls (#1275) — the cap is the user-intent ceiling for THIS purchase, compared against the LIVE quote before any funding moves, separate from and additional to the agent\'s on-chain budget. ' +
    'PREFER max_amount_human (#1351): whole tokens, exactly as the user says it — "no more than 1 USDC" is max_amount_human: "1". Decimals come from the live quote\'s own asset, so you never convert. ' +
    'max_amount is the ATOMIC-unit form and stays supported for callers that already hold an exact atomic figure: max_amount "500" is 0.0005 USDC, NOT 500 USDC. Passing BOTH is refused (AMBIGUOUS_MAX_AMOUNT) before the merchant is contacted. ' +
    'Send exactly one cap on every paid MCP call; omitting both is refused before the merchant is contacted. ' +
    'The returned amount/amount_atomic is the amount Haven authorizes for this call — a ceiling the merchant settles at or below — so show it to the user as the maximum, not any catalog/discovery price. Haven never receives the signing key. ' +
    'Protocol notes: builds the JSON-RPC tools/call envelope and probes the merchant to obtain the x402 payment_required. merchant_url may be the exact MCP endpoint or a BASE merchant URL (#1271): a non-402 miss triggers one bounded same-origin discovery pass of the merchant discovery document and one retry; the returned merchant_url is the resolved endpoint — pass THAT to settle/complete. ' +
    'Creates a funding intent and returns { payment_id, payload_hash, expires_at, payment_required, x402, signer_compatibility, merchant_url, tool_name, arguments, mcp_transport }. ' +
    'The funding/quote window expires at expires_at; if it expires, re-run haven_pay_mcp_tool with the same idempotency_key before signing again. ' +
    'Before the signing step, check signer_compatibility.x402_expected_context_version against the versions the haven-signer MCP server advertises at initialize ' +
    `(${SIGNER_CAPABILITY_SOURCE} and its instructions). If it is not in that set the local signer is out of date: STOP before signing and tell the user to update ` +
    '@haven_ai/signer by rerunning `npx @haven_ai/connect@alpha`. Nothing has been spent at that point. ' +
    'Fallback for an older signer/backend, or for diagnostics: re-run THIS tool with the SAME idempotency_key plus include_signing_payload=true — the replay returns the ORIGINAL sign_data with typed_data_b64 — then pass payload_hash, x402_expected (the nested x402.expected context, including expires_at), payment_required, and typed_data_b64 through UNCHANGED, one opaque string, never re-typed (#1255). Returns { signature, payment_header }. ' +
    'Step-by-step alternative (also key-safe): mcp__haven-signer__haven_sign → mcp__haven__haven_submit → mcp__haven-signer__haven_x402_sign_header → mcp__haven__haven_complete_mcp_tool. ' +
    'Pass payment_required, arguments, and mcp_transport through verbatim from this response.',
})

const QUOTE_MCP_TOOL_DESCRIPTION = composeDescription({
  summary:
    'Read the live x402 price for a named MCP merchant tool without creating a Haven payment, approval request, signing request, funding operation, or paid merchant retry.',
  behavior:
    'Use this when you need to tell the user the current merchant price before choosing a per-purchase cap. ' +
    'The result is INFORMATIONAL ONLY: it does not reserve a price or create payment authority. ' +
    'To buy, call haven_pay_mcp_tool afterwards with the returned merchant_url/tool_name/arguments and an explicit cap; that paid call always obtains a fresh live quote and checks the cap before it constructs any funding intent. ' +
    'merchant_url may be an exact MCP endpoint or a base merchant URL. A non-402 miss gets one bounded same-origin discovery attempt; merchant_url in the response is the resolved endpoint.',
  nextActionGuidance:
    'Next: tell the user the quoted maximum or choose an explicit cap, then call haven_pay_mcp_tool. Do not treat this quote as a price reservation or payment approval.',
})

const PREPARE_CATALOG_PURCHASE_DESCRIPTION = composeDescription({
  // #1311: sentence 1 (summary) states the critical-path position; behavior
  // leads with the structured-fields instruction and the compact must-knows
  // (max_amount required, rail-aware allowance shape, ready-to-sign shape),
  // then demotes the catalog-scoping/404 and rail-derivation detail to a
  // "Protocol notes" tail — kept in full, just not first to scan.
  summary:
    'Step 1 of the guided catalog purchase flow: load one Haven catalog entry by catalog_id, run the LIVE merchant quote, verify chain/cap/rail-aware allowance, and return a ready-to-sign x402 payment — no hand-copied merchant_url/tool_name/tool_arguments.',
  selectionGuidance:
    'Use this instead of haven_pay_mcp_tool when you already have a catalog_id from haven_discover_tools and a spending cap in mind. Do NOT use for read-only allowance or budget questions — use haven_get_allowances. If the catalog row is degraded or missing tool metadata, this refuses and names haven_pay_mcp_tool as the manual fallback.',
  behavior:
    'FOLLOW THE STRUCTURED FIELDS FIRST (#1308): the response carries next_action, next_tool, next_arguments, agent_summary and warnings — act on those; the prose below is fallback and debugging detail. ' +
    'A spending cap is REQUIRED on this tool, as on haven_pay_mcp_tool, and is enforced against the LIVE quote BEFORE any funding intent is created — this is the guided path, so there is no cap_warning fallback. ' +
    'Give it as max_amount_human (#1351, PREFERRED): whole tokens, so "no more than 1 USDC" is max_amount_human: "1", with decimals taken from the live quote\'s asset. max_amount is the atomic-unit alternative ("1" there means 0.000001 USDC). Send exactly one — both together is refused with AMBIGUOUS_MAX_AMOUNT, neither is refused with INVALID_INPUT, and both refusals happen before any network call. ' +
    'Returns a rail-aware allowance block { rail, sufficient, remaining_atomic, source }: on the legacy AllowanceModule rail an insufficient amount still proceeds and the resulting funding intent queues for wallet-owner approval, same as haven_pay_mcp_tool; on the delegation rail an over-budget quote REFUSES right here, before any funding intent exists, because that rail has no approval queue — an over-budget redemption would simply revert on-chain later. ' +
    'The ready-to-sign object returned on success is the SAME compact quote shape as haven_pay_mcp_tool/haven_pay_x402_quote (#1272: payment_id, payload_hash, expires_at, signer_compatibility, x402) plus catalog_id/catalog_name/catalog_price_* and the allowance block — never a separate signing surface. COMPACT by default; pass include_signing_payload=true only for diagnostics or an older signer. ' +
    'Protocol notes: loads the catalog entry by catalog_id — chain-scoped to this agent automatically (#1299): an unknown id or one curated for a DIFFERENT chain both refuse with a 404, no separate check needed. ' +
    'Runs the LIVE MCP quote against the entry\'s own resource_url/tool_name/tool_arguments — the same probe haven_pay_mcp_tool uses. ' +
    'sufficient is reported as null (with a warning) rather than a guess when the allowance/budget read itself fails — this preflight never hard-fails just because that check could not run; the on-chain policy remains the actual gate either way. ' +
    'The catalog\'s price_atomic/price_display are only ever indicative (catalog_price_is_indicative is always true) — the live quote in this same response (amount/amount_atomic/token) is authoritative, and a CATALOG_PRICE_DIFFERS warning fires when the two disagree.',
  nextActionGuidance:
    'Next: call mcp__haven-signer__haven_sign_x402 with { payment_id } — the signer fetches the exact signing payload itself (#1263), so you never copy bulky bytes. Then call mcp__haven__haven_settle_mcp_tool with the returned signature + payment_header and the merchant_url/tool_name/arguments/mcp_transport from THIS response; from there the flow is identical to haven_pay_mcp_tool. ' +
    'If the response carries status "pending_approval" (legacy rail, over the remaining allowance), tell the user and poll haven_get_payment_status — do not re-quote or re-pay while pending.',
})

const QUOTE_CATALOG_PURCHASE_DESCRIPTION = composeDescription({
  summary:
    'Read the live x402 price for one curated MCP catalog entry without creating a Haven payment, approval request, signing request, funding operation, or paid merchant retry.',
  behavior:
    'Use this before haven_prepare_catalog_purchase when the user needs the live price before choosing a cap. ' +
    'The catalog price is indicative only; amount/amount_atomic in this response are the live merchant quote. ' +
    'This result is INFORMATIONAL ONLY and does not reserve a price or create payment authority. ' +
    'To buy, call haven_prepare_catalog_purchase afterwards with catalog_id and exactly one explicit cap; it obtains a fresh live quote and checks that cap before constructing any funding intent. ' +
    'If the catalog row is degraded or lacks MCP metadata, use haven_pay_mcp_tool with an explicit merchant_url and tool_name instead.',
  nextActionGuidance:
    'Next: tell the user the quoted maximum or choose an explicit cap, then call haven_prepare_catalog_purchase. Do not treat this quote as a price reservation or payment approval.',
})

const COMPLETE_MCP_TOOL_DESCRIPTION = composeDescription({
  // #1311: summary carries the critical-path position; behavior leads with
  // the must-know call shape and the terminal next-step, then demotes the
  // protocol/response-shape detail to a "Protocol notes" tail.
  summary:
    'Final step of the x402 MCP purchase flow: deliver the signed X-PAYMENT header to the merchant after haven_x402_sign_header and return the tool result.',
  behavior:
    'Pass payment_id and the payment_header from haven_x402_sign_header; merchant_url/tool_name/arguments/mcp_transport are OPTIONAL (#1307) — Haven rehydrates them from the original haven_pay_mcp_tool quote by payment_id, so pass them only as a version-skew fallback. Call only after haven_submit has confirmed the funding transfer. ' +
    'Next: no further Haven tool is needed on success; return the merchant tool result to the user. ' +
    'Protocol notes: re-issues the MCP tools/call to the merchant with the X-PAYMENT header (running a fresh MCP initialize/session handshake server-side) and returns the merchant tool result. ' +
    'The payment_header is a signed, single-use, amount/merchant/nonce-bound authorization — not a key; Haven relays it but never holds signing authority. ' +
    'The payment_id is also used to attach merchant evidence or reconciliation context to the already-funded payment. ' +
    'If the funding window expired first, this returns code PAYMENT_WINDOW_EXPIRED with retry_with_new_quote=true.',
  nextActionGuidance:
    'If the merchant rejects the payment after funding, this returns code MERCHANT_REJECTED_AFTER_FUNDING and the delegate holds stranded funds — reconcile with mcp__haven__haven_sweep_delegate.',
})

const SETTLE_MCP_TOOL_DESCRIPTION = composeDescription({
  // #1311: same restructuring as COMPLETE_MCP_TOOL_DESCRIPTION above — this
  // is its fast-path sibling (haven_submit + haven_complete_mcp_tool combined).
  summary:
    'Fast-path final step of the x402 MCP purchase flow: fund and settle in one call — relay the funding signature, then deliver the signed X-PAYMENT header to the merchant and return the tool result.',
  behavior:
    'Pass payment_id, signature, and payment_header from haven_sign_x402 — merchant_url/tool_name/arguments/mcp_transport are OPTIONAL (#1307): Haven rehydrates them from the haven_pay_mcp_tool quote by payment_id; pass them explicitly only as a version-skew fallback. ' +
    'If funding does not confirm (e.g. pending_approval) it returns { payment_id, settled: false, funding_status } and does not contact the merchant. ' +
    'Next: no further Haven tool is needed on success; return the merchant tool result to the user. ' +
    'Protocol notes: combines haven_submit + haven_complete_mcp_tool — relays the funding signature to fund the delegate, then (only once funding confirms) re-issues the MCP tools/call to the merchant with the X-PAYMENT header (fresh MCP handshake server-side) and returns the merchant tool result. ' +
    'Both the signature and the payment_header are signed locally by the edge signer — Haven relays them but never holds the key. ' +
    'If the funding window expired it returns code PAYMENT_WINDOW_EXPIRED with retry_with_new_quote=true. ' +
    'Echoes payment_id on both the settled and not-settled responses so you can reconcile against haven_list_receipts / haven_get_payment_status without retaining it from haven_pay_mcp_tool.',
  nextActionGuidance:
    'If the merchant rejects after funding, this returns code MERCHANT_REJECTED_AFTER_FUNDING and the delegate holds stranded funds — reconcile with mcp__haven__haven_sweep_delegate.',
})

const QUOTE_X402_DESCRIPTION = composeDescription({
  ...sharedDescriptions.quoteX402,
  behavior:
    'Probes the merchant directly from the hosted MCP server and parses the 402 response. ' +
    'Haven is not contacted. Returns the full quote object including payment_required for ' +
    'mcp__haven__haven_pay_x402_quote. Next: call mcp__haven__haven_pay_x402_quote.',
})

// #1311: sentence 1 = critical-path position; sentence 2 = the
// structured-fields-first instruction; then the compact must-knows
// (allowance routing, max_amount, the sign→submit→header chain); the
// response-shape and signer-compatibility protocol notes are kept in full
// but demoted to the tail.
const PAY_X402_QUOTE_DESCRIPTION = [
  'Step 1 of a direct x402 purchase (non-MCP merchant): construct the funding step for an x402',
  'payment and return the unsigned hash for the local signer to sign.',
  'FOLLOW THE STRUCTURED FIELDS FIRST (#1308): the response carries next_action, next_tool,',
  'next_arguments, agent_summary and warnings — act on those; the prose below is fallback.',
  'For read-only allowance, budget, spend-limit, remaining-amount, or',
  'reset-period questions, call haven_get_allowances instead of calling this tool.',
  'Pass the payment_required from haven_quote_x402 or directly from the merchant 402 response.',
  'ALWAYS cap paid merchant calls (#1275): the user-intent ceiling for THIS purchase, enforced against the live quote before any funding moves — separate from the agent\'s on-chain budget.',
  'PREFER max_amount_human (#1351): whole tokens as the user states them ("no more than 1 USDC" → max_amount_human: "1"), converted with the decimals of the asset in the selected payment option. max_amount is the atomic-unit form ("1" = 0.000001 USDC); passing both is refused with AMBIGUOUS_MAX_AMOUNT before any funding intent. Omitting both accepts the quoted price as-is (the response carries cap_warning).',
  'Sign payload_hash via mcp__haven-signer__haven_sign (passing x402.expected) on the local signer, then relay',
  'with mcp__haven__haven_submit to fund the delegate wallet. After submission confirms, call',
  'mcp__haven-signer__haven_x402_sign_header on the local signer to build the EIP-3009 X-PAYMENT header, then',
  'retry the merchant yourself. Next: call mcp__haven-signer__haven_sign.',
  'Returns { status: "pending_approval", payload_hash: null } when the amount exceeds the',
  'budget. Haven never receives the signing key and never talks to the merchant.',
  'Protocol notes: returns { payment_id, payload_hash, expires_at, x402 } where x402 carries the accepted option,',
  'resource_url, merchant_to, funding_to, and x402.expected signing context including expires_at.',
  'COMPACT by default (#1272): typed_data/typed_data_b64 are omitted — the preferred signing call',
  'is mcp__haven-signer__haven_sign_x402 with just payment_id (#1263, #1355 — the signer also',
  'fetches payment_required; add it verbatim only if the signer asks).',
  'For diagnostics or an older signer, re-run this tool with the SAME idempotency_key plus',
  'include_signing_payload=true: the replay returns the ORIGINAL sign_data with typed_data_b64,',
  'to pass through UNCHANGED, one opaque string, never re-typed (#1255).',
  'If expires_at passes before signing, re-quote with the same idempotency_key before signing again.',
  'Also returns signer_compatibility.x402_expected_context_version — the expected-context version',
  'this result emits. Before signing, check it against the versions the haven-signer MCP server',
  `advertises at initialize (${SIGNER_CAPABILITY_SOURCE} and its`,
  'instructions). If it is not in that set the local signer is out of date: STOP before signing and',
  'tell the user to update @haven_ai/signer by rerunning `npx @haven_ai/connect@alpha`. Nothing has',
  'been spent yet — funds move only when haven_submit relays a signature.',
].join(' ')

// #1311: same restructuring pattern — critical-path position first, then
// the must-knows (when to call, what to pass, what it returns), then the
// signer-compatibility protocol note demoted to the tail.
const RESUME_X402_DESCRIPTION = [
  'Resume step of the x402 purchase flow: retrieve the signing context for an approved payment',
  'so the local signer can build the EIP-3009 X-PAYMENT header and the agent can retry the merchant.',
  'Use after haven_get_payment_status returns nextAction=retry_original_x402_request.',
  'Pass resume_state (from the original pending-approval response) or payment_id.',
  'Returns { payment_id, payment_required, x402 } with the same signing context shape as',
  'haven_pay_x402_quote so the signer can call haven_x402_sign_header with the x402_binding',
  '(or re-derive it via haven_sign if the binding was lost across a signer restart).',
  // #1155: resume leads straight back to signing, and the signer restart this
  // description already anticipates is exactly when the INSTALLED signer can
  // have changed since the original quote. There is no version to echo here —
  // the resume state carries no expected context — so this prompts a re-check
  // of the one the agent already holds rather than inventing a null to compare.
  'Protocol notes: this result carries no signer_compatibility of its own. Before signing, re-check the',
  'x402_expected_context_version from the ORIGINAL quote against the versions the haven-signer',
  `MCP server advertises at initialize (${SIGNER_CAPABILITY_SOURCE} and its instructions) —`,
  'a signer restart or reinstall since that quote may have changed which versions it verifies.',
  'On a mismatch, STOP before signing and tell the user to update @haven_ai/signer by rerunning',
  '`npx @haven_ai/connect@alpha`.',
  'Next: call mcp__haven-signer__haven_x402_sign_header when you have the x402_binding, or mcp__haven-signer__haven_sign first to re-derive it.',
].join(' ')

// #1328: QUOTE_MPP_DESCRIPTION / PAY_MPP_CHALLENGE_DESCRIPTION / RESUME_MPP_DESCRIPTION
// (the mpp_demo challenge/quote/resume tool descriptions) are retired along
// with the haven_quote_mpp / haven_pay_mpp_challenge / haven_resume_mpp_payment
// tools they described.

const SWEEP_DELEGATE_DESCRIPTION = [
  'Recover stranded USDC from the delegate wallet back to the user\'s Haven wallet, gaslessly.',
  'Use when a payment failed or expired after funding, or when a payment status returns',
  'nextAction=sweep_stranded_funds. Two phases, both keyless on this server:',
  '(1) Call with no arguments — returns { status: "signature_required", authorization, expected_auth }',
  '(or { status: "nothing_stranded" } if the delegate is empty).',
  '(2) Pass authorization and expected_auth to the local signer tool haven_sign_sweep_delegate,',
  'then call this tool again with { authorization, signature } to relay it.',
  'The delegate signs an EIP-3009 authorization off-chain (no ETH needed on the delegate);',
  'Haven\'s relayer submits it on-chain and pays gas. Returns { status: "swept", tx_hash, amount }.',
  'Recovers USDC only — stranded native ETH is not recoverable through this gasless path.',
].join(' ')

// #1311: hosted-only override — points the guided catalog-purchase path
// (haven_prepare_catalog_purchase, #1306) back at discovery, which the
// shared fragment cannot name because it does not exist on the local MCP
// surface. Everything else stays the shared summary/selectionGuidance/
// behavior; only nextActionGuidance is extended.
const DISCOVER_TOOLS_DESCRIPTION = composeDescription({
  ...sharedDescriptions.discoverTools,
  nextActionGuidance:
    sharedDescriptions.discoverTools.nextActionGuidance +
    ' For an MCP entry where you already have a spending cap in mind, prefer haven_prepare_catalog_purchase with the entry\'s catalog_id — it runs the live quote, cap, and rail-aware allowance check for you.',
})

export const toolDescriptions: Record<HostedToolName, string> = {
  haven_get_agent: composeDescription(sharedDescriptions.getAgent),
  haven_get_allowances: composeDescription(sharedDescriptions.getAllowances),
  haven_sweep_delegate: SWEEP_DELEGATE_DESCRIPTION,
  haven_discover_tools: DISCOVER_TOOLS_DESCRIPTION,
  haven_send: composeDescription(sharedDescriptions.send),
  haven_pay: PAY_DESCRIPTION,
  haven_submit: SUBMIT_DESCRIPTION,
  haven_pay_mcp_tool: PAY_MCP_TOOL_DESCRIPTION,
  haven_quote_mcp_tool: QUOTE_MCP_TOOL_DESCRIPTION,
  haven_prepare_catalog_purchase: PREPARE_CATALOG_PURCHASE_DESCRIPTION,
  haven_quote_catalog_purchase: QUOTE_CATALOG_PURCHASE_DESCRIPTION,
  haven_complete_mcp_tool: COMPLETE_MCP_TOOL_DESCRIPTION,
  haven_settle_mcp_tool: SETTLE_MCP_TOOL_DESCRIPTION,
  haven_quote_x402: QUOTE_X402_DESCRIPTION,
  haven_pay_x402_quote: PAY_X402_QUOTE_DESCRIPTION,
  haven_resume_x402_payment: RESUME_X402_DESCRIPTION,
  haven_get_payment_status: composeDescription(sharedDescriptions.getPaymentStatus),
  haven_get_resume_state: composeDescription(sharedDescriptions.getResumeState),
  haven_list_receipts: composeDescription(sharedDescriptions.listReceipts),
  haven_verify_receipt: composeDescription(sharedDescriptions.verifyReceipt),
}

export interface ToolSuccess<T> {
  success: true
  data: T
}

export interface ToolFailure {
  success: false
  code: string
  message: string
  /** Structured hint pointing the agent at the correct tool for this operation. */
  suggested_tool?: string
  statusCode?: number
  paymentId?: string
  status?: string
  phase?: string
  next_action?: string
  rail?: string
  idempotency_key?: string | null
  retry_with_new_quote?: boolean
}

export type ToolPayload<T = unknown> = ToolSuccess<T> | ToolFailure

export function createToolHandlers(
  haven: HavenClient,
): Record<HostedToolName, (input: unknown) => Promise<ToolPayload>> {
  return {
    haven_get_agent: async () => runTool(async () => haven.getAgentSummary()),

    haven_get_allowances: async () => runTool(async () => haven.getAllowances()),

    haven_sweep_delegate: async (input) =>
      runTool(async () => {
        const args = parse('haven_sweep_delegate', input)

        // Phase 2 — a signature is present: relay the delegate-signed authorization.
        if (args.signature) {
          if (!args.authorization) {
            throw new HavenApiError(
              'authorization is required alongside signature to submit a sweep. ' +
                'Call haven_sweep_delegate with no arguments first to get one.',
              400,
            )
          }
          const result = await haven.submitSweep(
            args.authorization as SweepAuthorization,
            args.signature as string,
          )
          return {
            status: 'swept',
            tx_hash: result.tx_hash,
            asset: result.asset,
            amount: result.amount,
            from_address: result.from_address,
            to_address: result.to_address,
            chain_id: result.chain_id,
            explorer_url: result.explorer_url,
          }
        }

        // Phase 1 — prepare. Keyless: the backend builds the authorization; the
        // local signer (haven_sign_sweep_delegate) signs it.
        const prep = await haven.prepareSweep()
        if (prep.nothing_stranded) {
          return {
            status: 'nothing_stranded',
            asset: prep.asset ?? 'USDC',
            chain_id: prep.chain_id,
            message: prep.message ?? 'No stranded funds to recover.',
          }
        }
        // #700: a stranded balance below the sweep floor is LEFT on the
        // delegate — the relayer gas to sweep it would exceed its value, and
        // the backend deliberately builds no authorization. Falling through
        // to signature_required here handed agents a "sign this" instruction
        // with authorization/expected_auth undefined — a dead end that read
        // as a serializer bug (found live, first prod sweep attempt).
        if (prep.below_min) {
          return {
            status: 'below_minimum',
            asset: prep.asset ?? 'USDC',
            amount: prep.amount,
            amount_atomic: prep.amount_atomic,
            min_usdc: prep.min_usdc,
            chain_id: prep.chain_id,
            message:
              prep.message ??
              `Stranded balance is below the ${prep.min_usdc ?? '1'} USDC sweep floor — ` +
                'left on the delegate because relayer gas would exceed the recovered value. ' +
                'It is swept automatically once the balance reaches the floor.',
          }
        }
        return {
          status: 'signature_required',
          authorization: prep.authorization,
          expected_auth: prep.expected_auth,
          asset: prep.asset,
          amount: prep.amount,
          amount_atomic: prep.amount_atomic,
          sign_with: 'haven_sign_sweep_delegate',
          next_step:
            'Call the local signer tool haven_sign_sweep_delegate with { authorization, expected_auth } ' +
            'to get a signature, then call haven_sweep_delegate again with { authorization, signature }.',
        }
      }),

    haven_discover_tools: async (input) =>
      runTool(async () => {
        const args = parse('haven_discover_tools', input)
        const entries = await haven.discoverTools({
          category: args.category,
          search: args.search,
          rail: args.rail,
        })
        return entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          description: entry.description,
          category: entry.category,
          resource_url: entry.resourceUrl,
          rail: entry.rail,
          protocol: entry.protocol,
          tool_name: entry.toolName,
          tool_arguments: entry.toolArguments,
          price_display: entry.priceDisplay,
          price_atomic: entry.priceAtomic,
          // Catalog price is a last-verified hint, NOT authoritative. Always
          // confirm the real price from the merchant's live 402 (returned as
          // payment_required / amount_atomic by haven_pay_mcp_tool) before
          // showing a price to the user or paying.
          price_is_indicative: true,
          asset: entry.asset,
          network: entry.network,
          status: entry.status,
          verified_at: entry.verifiedAt,
          // Hosted surface is keyless: x402 entries start with the quote half
          // of the split flow; MCP entries go through haven_pay_mcp_tool.
          // #1328: the 'mpp' rail's only-ever catalog row (the Haven MPP demo
          // resource) is delisted with the mpp_demo retirement, so this
          // fallback is unreachable today; it stays x402 rather than naming a
          // deleted tool in case a future non-demo 'mpp' rail entry appears.
          suggested_tool:
            entry.protocol === 'mcp' ? 'haven_pay_mcp_tool'
            : 'haven_quote_x402',
        }))
      }),

    haven_send: async (input) =>
      runTool(async () => {
        const args = parse('haven_send', input)
        try {
          const intent = await haven.createIntent({
            token: args.asset,
            amount: args.amount,
            to: args.recipient,
            // #1207: was accepted by this tool's schema but silently dropped —
            // now carried to the backend's replay contract.
            idempotencyKey: args.idempotency_key,
          })
          return {
            payment_id: intent.paymentId,
            status: intent.status,
            payload_hash: intent.signData.hash,
            expires_at: intent.expiresAt,
            // #1254: same forwarding as haven_pay — see the note there.
            ...delegationSignFields(intent.signData),
            asset: args.asset,
            amount: args.amount,
            recipient: args.recipient,
          }
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return {
              payment_id: err.paymentId,
              status: 'pending_approval',
              payload_hash: null,
              asset: args.asset,
              amount: args.amount,
              recipient: args.recipient,
            }
          }
          throw err
        }
      }),

    haven_pay: async (input) =>
      runTool(async () => {
        const args = parse('haven_pay', input)
        try {
          const intent = await haven.createIntent({
            token: args.token,
            amount: args.amount,
            to: args.to,
            idempotencyKey: args.idempotency_key,
          })
          return {
            payment_id: intent.paymentId,
            status: intent.status,
            payload_hash: intent.signData.hash,
            expires_at: intent.expiresAt,
            // #1254: on the delegation rail the account validates TYPED DATA,
            // not payload_hash. The x402 quote path always forwarded these;
            // this direct path dropped them, so the local signer raw-signed
            // the hash and the account rejected it on-chain (AA24). Found
            // live during the #908 mainnet canary.
            ...delegationSignFields(intent.signData),
            meta: { token: args.token, amount: args.amount, to: args.to },
          }
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return { payment_id: err.paymentId, status: 'pending_approval', payload_hash: null }
          }
          throw err
        }
      }),

    haven_submit: async (input) =>
      runTool(async () => {
        const args = parse('haven_submit', input)
        const result = await submitSignatureWithExpiryMapping(
          haven,
          args.payment_id,
          args.signature,
        )
        return { status: result.status, tx_hash: result.txHash ?? null }
      }),

    haven_pay_mcp_tool: async (input) =>
      runTool(async () => {
        const args = parse('haven_pay_mcp_tool', input)
        // #1351: shape-check the cap FIRST — a contradictory cap is refused
        // here, before the merchant is even contacted.
        const cap = readMaxAmountCap(args, { required: true })
        try {
          // #1271: a base merchant URL is accepted. The probe runs against the
          // URL as given first; only a non-402 miss triggers one bounded
          // same-origin discovery pass and ONE retry at the discovered endpoint.
          // #1306: shared with haven_prepare_catalog_purchase — see there.
          // #1348: prefetch the agent in parallel with the (slow) merchant
          // probe purely as a delegateAddress hint for createX402Intent. A
          // prefetch failure is IGNORED here — createX402Intent then runs its
          // own internal fetch and fails exactly as it always did, so error
          // shape and ordering are unchanged.
          // #1456: yields the AGENT, not just its delegate address — the
          // settlement-scheme rule needs the account's rail, and #1348 pins
          // this path to exactly ONE agent round-trip. A second GET for one
          // field would break that budget (its test caught precisely that).
          const agentPrefetch = haven.getAgent().then(
            (a) => a,
            () => undefined,
          )
          const { quote, merchantUrl } = await quoteMcpToolCall(haven, {
            merchantUrl: args.merchant_url as string,
            toolName: args.tool_name as string,
            toolArguments: (args.arguments as Record<string, unknown> | undefined) ?? {},
            idempotencyKey: args.idempotency_key as string | undefined,
          })
          // Enforce the required price cap against the LIVE merchant price,
          // before creating the funding intent. The catalog price is only a hint.
          // #1351: a human cap binds to the LIVE quote's own asset/decimals here.
          const capAtomic = resolveCapAtomic(cap, quote)
          assertWithinMaxAmount(quote.amountAtomic, capAtomic.atomic, quote.token, capAtomic.label)
          const prefetchedAgent = await agentPrefetch
          const prefetchedDelegate = prefetchedAgent?.delegateAddress

          // Both halves of the #1450 rule: the merchant must advertise erc7710
          // AND the account must be on the delegation rail. #1453's selector is
          // the single place that rule lives. A prefetch FAILURE deliberately
          // yields the 3009 path — guessing 'delegation' would build a request
          // the backend then refuses, and this tool's pre-#1456 behaviour was
          // 3009 anyway.
          const paySelection = selectX402SettlementScheme(
            (quote.paymentRequired as X402PaymentRequired).accepts,
            { delegationRail: prefetchedAgent?.executionRail === 'delegation' },
          )

          if (paySelection?.scheme === 'erc7710') {
            const prepared = await haven.prepareX402Erc7710(
              quote.paymentRequired as X402PaymentRequired,
              { resourceUrl: merchantUrl, delegationRail: true },
            )
            return {
              payment_id: prepared.paymentId,
              settlement_scheme: 'erc7710',
              settlement: {
                scheme: 'erc7710',
                funding_leg: false,
                merchant_pay_to: prepared.settlement.merchantPayTo,
                facilitator_addresses: prepared.settlement.facilitatorAddresses,
              },
              amount_atomic: quote.amountAtomic,
              amount: quote.amount,
              token: quote.token,
              merchant_url: merchantUrl,
              ...(merchantUrl !== args.merchant_url
                ? { merchant_url_discovered_from: args.merchant_url }
                : {}),
              tool_name: args.tool_name,
              arguments: args.arguments ?? {},
              ...(quote.mcpTransport
                ? { mcp_transport: serializeMcpTransport(quote.mcpTransport) }
                : {}),
              ...buildAgentGuidance({
                nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
                nextTool: 'mcp__haven-signer__haven_sign',
                nextArguments: { payment_id: prepared.paymentId },
                safeToContinue: true,
                reason:
                  'Sign locally: call next_tool with next_arguments EXACTLY as given — the signer ' +
                  "fetches the settlement child itself and verifies its caveats against Haven's " +
                  'signed context (#1455) before signing. Then call haven_settle_mcp_tool with the ' +
                  'returned signature and the merchant_url/tool_name/arguments from this response. ' +
                  'Do NOT pass payment_header: on this scheme Haven assembles it at settle, so ' +
                  'there is nothing to build locally and no funding transaction to wait for.',
                summary: {
                  payment_id: prepared.paymentId,
                  status: 'pending_signature',
                  amount: quote.amount,
                  amount_atomic: quote.amountAtomic,
                  token: quote.token,
                  network: prepared.settlement.network,
                  expires_at: undefined,
                  product: args.tool_name,
                },
                warnings: quoteWarnings({
                  capped: cap.kind !== 'none',
                  // The child's own short expiry is the binding window here,
                  // not the intent's — no quote-expiry warning applies.
                  expiresAt: undefined,
                  ...(merchantUrl !== args.merchant_url
                    ? { discoveredFrom: args.merchant_url }
                    : {}),
                }),
              }),
            }
          }

          const intent = await haven.createX402Intent(
            quote.paymentRequired as X402PaymentRequired,
            {
              idempotencyKey: args.idempotency_key ?? quote.idempotencyKey,
              ...(prefetchedDelegate ? { delegateAddress: prefetchedDelegate } : {}),
              // #1307: persist the merchant call context so haven_settle_mcp_tool /
              // haven_complete_mcp_tool can rehydrate it by payment_id instead of
              // the agent re-threading merchant_url/tool_name/arguments/mcp_transport.
              mcpCallContext: {
                merchantUrl,
                toolName: args.tool_name as string,
                arguments: (args.arguments as Record<string, unknown> | undefined) ?? {},
                ...(quote.mcpTransport ? { mcpTransport: quote.mcpTransport } : {}),
              },
            },
          )
          return {
            ...buildX402SigningContext(intent, args.include_signing_payload === true),
            // The raw merchant 402 PaymentRequired — the local signer needs this
            // verbatim in haven_x402_sign_header to build the EIP-3009 header.
            payment_required: quote.paymentRequired,
            // Authorized amount for this call — a ceiling the merchant settles
            // at or below (maxAmountRequired ?? amount). Show THIS to the user
            // as the maximum, not any catalog price (which is indicative/stale).
            amount_atomic: quote.amountAtomic,
            amount: quote.amount,
            token: quote.token,
            // Request details to pass back to haven_complete_mcp_tool after
            // signing. The RESOLVED endpoint (#1271), not the input as given —
            // settle/complete must hit the same URL the 402 came from.
            merchant_url: merchantUrl,
            ...(merchantUrl !== args.merchant_url
              ? { merchant_url_discovered_from: args.merchant_url }
              : {}),
            tool_name: args.tool_name,
            arguments: args.arguments ?? {},
            ...(quote.mcpTransport ? { mcp_transport: serializeMcpTransport(quote.mcpTransport) } : {}),
            // #1308: machine-readable next step — the agent follows this
            // before parsing any prose.
            ...buildAgentGuidance({
              nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
              nextTool: 'mcp__haven-signer__haven_sign_x402',
              nextArguments: { payment_id: intent.paymentId },
              safeToContinue: true,
              reason:
                'Sign locally: call next_tool with next_arguments EXACTLY as given (#1355: the ' +
                'signer fetches payment_required itself; only if it reports the context carried ' +
                'none, re-call with payment_required added VERBATIM from this response), then ' +
                'haven_settle_mcp_tool with the returned ' +
                'signature + payment_header and the merchant_url/tool_name/arguments/mcp_transport ' +
                'from this response.',
              summary: {
                payment_id: intent.paymentId,
                status: intent.status,
                amount: quote.amount,
                amount_atomic: quote.amountAtomic,
                token: quote.token,
                network: intent.network,
                expires_at: intent.expiresAt,
                product: args.tool_name,
              },
              warnings: quoteWarnings({
                capped: cap.kind !== 'none',
                expiresAt: intent.expiresAt,
                ...(merchantUrl !== args.merchant_url ? { discoveredFrom: args.merchant_url } : {}),
              }),
            }),
          }
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return {
              payment_id: err.paymentId,
              status: 'pending_approval',
              payload_hash: null,
              // #1308: over-budget is a USER decision — never continue silently.
              ...buildAgentGuidance({
                nextAction: AgentPaymentNextAction.WaitForUserApproval,
                nextTool: 'mcp__haven__haven_get_payment_status',
                nextArguments: { payment_id: err.paymentId ?? null },
                safeToContinue: false,
                reason:
                  'The amount exceeds the remaining budget, so the payment is queued for the ' +
                  'wallet owner. Tell the user, then poll next_tool — do NOT re-quote or re-pay ' +
                  'the same purchase while it is pending.',
                summary: { payment_id: err.paymentId ?? 'unknown', status: 'pending_approval' },
              }),
            }
          }
          throw err
        }
      }),

    haven_quote_mcp_tool: async (input) =>
      runTool(async () => {
        const args = parse('haven_quote_mcp_tool', input)
        const toolArguments = (args.arguments as Record<string, unknown> | undefined) ?? {}
        const { quote, merchantUrl } = await quoteMcpToolCall(haven, {
          merchantUrl: args.merchant_url as string,
          toolName: args.tool_name as string,
          toolArguments,
        })
        return buildMcpToolQuoteResponse({
          quote,
          merchantUrl,
          toolName: args.tool_name as string,
          toolArguments,
          requestedMerchantUrl: args.merchant_url as string,
        })
      }),

    haven_prepare_catalog_purchase: async (input) =>
      runTool(async () => {
        const args = parse('haven_prepare_catalog_purchase', input)
        // #1351: the cap is REQUIRED here and its shape is checked before the
        // catalog is even read — an uncapped or contradictory guided purchase
        // makes zero network calls.
        const cap = readMaxAmountCap(args, { required: true })
        try {
          // 1. Load a chain-scoped, usable MCP catalog row. The quote and
          // paid-preflight paths intentionally share this refusal contract.
          const entry = await getUsableCatalogMcpEntry(haven, args.catalog_id as string)

          // 2. Run the LIVE quote against the catalog entry's own merchant —
          // the SAME probe haven_pay_mcp_tool uses, shared rather than
          // duplicated (#1306 review requirement). #1348: the two Haven reads
          // steps 4-5 need (agent, allowances) are independent of the merchant
          // probe, so they START here and overlap its latency — the slowest
          // leg of this preflight. Failure semantics are unchanged by design:
          // the quote is AWAITED first, so its error still wins when several
          // legs fail; the agent read stays a hard pre-intent refusal (#1319);
          // the allowance read is settled to a result object the moment it
          // starts (never an unhandled rejection) and is consumed by the same
          // degrade-to-warning logic as before.
          const agentPromise = haven.getAgent()
          agentPromise.catch(() => {}) // awaited at step 5; guard the gap
          const allowancesPromise = haven
            .getAllowances()
            .then(
              (value) => ({ ok: true as const, value }),
              (error) => ({ ok: false as const, error }),
            )
          const { quote, merchantUrl } = await quoteMcpToolCall(haven, {
            merchantUrl: entry.resourceUrl,
            toolName: entry.toolName,
            toolArguments: entry.toolArguments ?? {},
            idempotencyKey: args.idempotency_key as string | undefined,
          })

          // 3. A cap is REQUIRED on this guided path (readMaxAmountCap above,
          // before any network call) — no cap_warning softness. Enforced
          // against the LIVE quote BEFORE any funding intent is created
          // (mutation-tested: reordering this after createX402Intent below
          // must fail a test). #1351: a human cap resolves against the LIVE
          // quote's asset/decimals here, never the catalog's indicative price.
          const capAtomic = resolveCapAtomic(cap, quote)
          assertWithinMaxAmount(quote.amountAtomic, capAtomic.atomic, quote.token, capAtomic.label)

          // 4. Rail-aware allowance/budget report. A failed read NEVER fails
          // this preflight — sufficient degrades to null with a warning, and
          // the on-chain policy remains the actual gate either way.
          const agent = await agentPromise
          const rail = agent.executionRail
          const source = rail === 'delegation' ? 'active_delegations' : 'allowance_module'
          const warnings: AgentPaymentWarning[] = []
          let allowanceBlock: {
            rail: 'legacy' | 'delegation'
            sufficient: boolean | null
            remaining_atomic?: string
            source: 'allowance_module' | 'active_delegations'
          }
          try {
            // #1090 machinery, reused via the SAME derivation the /agents/:id
            // allowances view and GET /machine-payments/allowances use — this
            // NEVER reads agent_allowances on the delegation rail, which is a
            // frozen onboarding mirror there (mutation-tested). #1348: the
            // read itself started back at step 2 (overlapping the merchant
            // probe); a rejection was captured there and is re-thrown here so
            // this catch block degrades it exactly as before.
            const allowancesResult = await allowancesPromise
            if (!allowancesResult.ok) throw allowancesResult.error
            const allowances = allowancesResult.value
            const match = allowances.allowances.find(
              (a) => a.tokenAddress.toLowerCase() === quote.asset.toLowerCase(),
            )
            const remainingAtomic = match ? match.onchain.remaining : '0'
            allowanceBlock = {
              rail,
              sufficient: BigInt(remainingAtomic) >= BigInt(quote.amountAtomic),
              remaining_atomic: remainingAtomic,
              source,
            }
            // #1319: the read above SUCCEEDED — this is distinct from the
            // catch block below, which fires when it fails outright. On the
            // delegation rail, `remaining` can still be an OPTIMISTIC number:
            // #1145's on-chain enforcer read falls back to the full
            // configured budget (never throws) when the RPC read itself
            // times out, so `sufficient` here can be computed from a figure
            // that was never actually confirmed live. `remainingIsFromChain`
            // is only ever set on the delegation rail (#1319 wire field) —
            // `undefined` on the legacy rail is not "optimistic", it is
            // "not applicable", so this only warns when the flag is
            // explicitly false.
            if (rail === 'delegation' && match?.onchain.remainingIsFromChain === false) {
              warnings.push({
                code: AgentPaymentWarningCode.AllowanceReadOptimistic,
                message:
                  'The reported remaining delegation budget could not be read live from chain, so ' +
                  `${remainingAtomic} ${quote.token} atomic is the configured full budget, not a confirmed ` +
                  'live figure. The on-chain policy (the budget caveat enforcer) remains the actual ' +
                  'spend gate at redemption regardless of this report.',
              })
            }
          } catch (err) {
            allowanceBlock = { rail, sufficient: null, source }
            warnings.push({
              code: AgentPaymentWarningCode.AllowanceCheckUnavailable,
              message:
                `Could not read ${rail === 'delegation' ? 'the active delegation budget' : 'the AllowanceModule allowance'} ` +
                `for this agent (${err instanceof Error ? err.message : String(err)}). Proceeding without a pre-check — ` +
                'the on-chain policy remains the actual spend gate; this only affects the guidance shown here.',
            })
          }

          // 5. Delegation rail: over-budget REVERTS at prepare, no approval
          // queue exists on that rail (#1090) — refuse BEFORE any funding
          // intent (mutation-tested: reading agent_allowances here instead of
          // the derived budgets must fail a test).
          if (rail === 'delegation' && allowanceBlock.sufficient === false) {
            throw new HostedToolError({
              code: 'DELEGATION_BUDGET_EXCEEDED',
              message:
                `The live quoted amount (${quote.amountAtomic} ${quote.token} atomic) exceeds the agent's ` +
                `remaining active delegation budget (${allowanceBlock.remaining_atomic} ${quote.token} atomic). ` +
                'There is no approval queue on the delegation rail — an over-budget redemption would revert ' +
                'on-chain. Ask the wallet owner to grant or raise the budget in Haven before retrying.',
              statusCode: 403,
              nextAction: AgentPaymentNextAction.FundSafeOrRaiseAllowance,
              suggestedTool: 'haven_get_allowances',
            })
          }

          // 6. Create the funding intent — IDENTICAL machinery to
          // haven_pay_mcp_tool (mcpCallContext persisted per #1307), so the
          // signer flow from here is IDENTICAL to today's:
          // haven_sign_x402 with payment_id + payment_required, then
          // haven_settle_mcp_tool.
          const intent = await haven.createX402Intent(quote.paymentRequired as X402PaymentRequired, {
            idempotencyKey: args.idempotency_key ?? quote.idempotencyKey,
            mcpCallContext: {
              merchantUrl,
              toolName: entry.toolName,
              arguments: entry.toolArguments ?? {},
              ...(quote.mcpTransport ? { mcpTransport: quote.mcpTransport } : {}),
            },
            // #1348: the agent was already fetched at step 4 — skip the
            // intent call's internal duplicate fetch.
            delegateAddress: agent.delegateAddress,
          })

          // 7. Catalog price is indicative; the live quote above is
          // authoritative — warn (never refuse) when they disagree.
          if (entry.priceAtomic && entry.priceAtomic !== quote.amountAtomic) {
            warnings.push({
              code: AgentPaymentWarningCode.CatalogPriceDiffers,
              message:
                `The catalog's indicative price (${entry.priceAtomic} atomic) differs from the live ` +
                `merchant quote (${quote.amountAtomic} ${quote.token} atomic). The live quote is authoritative.`,
            })
          }

          return {
            ...buildX402SigningContext(intent, args.include_signing_payload === true),
            // #1318 review: both sourced from the INTENT (one source of truth —
            // the quote's copies could drift on multi-option 402s), and no
            // top-level rail key: allowance.rail is the policy rail, the
            // protocol is implicit like every other success shape.
            network: intent.network,
            asset: intent.asset,
            // The raw merchant 402 PaymentRequired — the local signer needs this
            // verbatim in haven_x402_sign_header to build the EIP-3009 header.
            payment_required: quote.paymentRequired,
            amount_atomic: quote.amountAtomic,
            amount: quote.amount,
            token: quote.token,
            merchant_url: merchantUrl,
            tool_name: entry.toolName,
            arguments: entry.toolArguments ?? {},
            ...(quote.mcpTransport ? { mcp_transport: serializeMcpTransport(quote.mcpTransport) } : {}),
            catalog_id: entry.id,
            catalog_name: entry.name,
            // Catalog price is a last-verified hint, NEVER authoritative —
            // confirm the real price from amount_atomic above (#1306).
            catalog_price_atomic: entry.priceAtomic,
            catalog_price_display: entry.priceDisplay,
            catalog_price_is_indicative: true,
            allowance: allowanceBlock,
            // #1308: machine-readable next step — the agent follows this
            // before parsing any prose.
            ...buildAgentGuidance({
              nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
              nextTool: 'mcp__haven-signer__haven_sign_x402',
              nextArguments: { payment_id: intent.paymentId },
              safeToContinue: true,
              reason:
                'Sign locally: call next_tool with next_arguments EXACTLY as given (#1355: the ' +
                'signer fetches payment_required itself; only if it reports the context carried ' +
                'none, re-call with payment_required added VERBATIM from this response), then ' +
                'haven_settle_mcp_tool with the returned ' +
                'signature + payment_header and the merchant_url/tool_name/arguments/mcp_transport ' +
                'from this response.',
              summary: {
                payment_id: intent.paymentId,
                status: intent.status,
                amount: quote.amount,
                amount_atomic: quote.amountAtomic,
                token: quote.token,
                network: intent.network,
                expires_at: intent.expiresAt,
                product: entry.name,
              },
              warnings: [
                ...warnings,
                ...quoteWarnings({
                  // Always true on this path — a cap is required — but derived
                  // rather than hardcoded so it stays honest if that changes.
                  capped: cap.kind !== 'none',
                  expiresAt: intent.expiresAt,
                }),
              ],
            }),
          }
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return {
              payment_id: err.paymentId,
              status: 'pending_approval',
              payload_hash: null,
              // #1308: over-budget is a USER decision — never continue silently.
              // Legacy rail only reaches here — the delegation rail refused
              // earlier, before any intent existed.
              ...buildAgentGuidance({
                nextAction: AgentPaymentNextAction.WaitForUserApproval,
                nextTool: 'mcp__haven__haven_get_payment_status',
                nextArguments: { payment_id: err.paymentId ?? null },
                safeToContinue: false,
                reason:
                  'The amount exceeds the remaining allowance, so the payment is queued for the ' +
                  'wallet owner. Tell the user, then poll next_tool — do NOT re-quote or re-pay ' +
                  'the same purchase while it is pending.',
                summary: { payment_id: err.paymentId ?? 'unknown', status: 'pending_approval' },
              }),
            }
          }
          throw err
        }
      }),

    haven_complete_mcp_tool: async (input) =>
      runTool(async () => {
        const args = parse('haven_complete_mcp_tool', input)
        return deliverMerchantPayment(haven, args)
      }),

    haven_settle_mcp_tool: async (input) =>
      runTool(async () => {
        const args = parse('haven_settle_mcp_tool', input)
        // Fast path: fund (relay the signature) then deliver the merchant header
        // in one hosted call. The signature and X-PAYMENT header are both signed
        // by the local edge signer — Haven relays them but never holds the key.
        //
        // This MUST precede submitSignature: a malformed or substituted merchant
        // header is never a reason to fund the delegate balance. It is an
        // integrity preflight, not a merchant/facilitator verification or a
        // replacement for the local signer's expected-context binding.
        // #1456: erc7710 direct settlement inverts this whole sequence, so it
        // branches HERE rather than deeper — an earlier attempt put the branch
        // inside deliverMerchantPayment and the signature had already been
        // relayed as a FUNDING signature by then.
        //
        // On this scheme the signature IS the settlement child, not a funding
        // authorization: it goes to POST /x402/:id/settle, which returns the
        // merchant header Haven assembles. There is no funding leg to relay and
        // no agent-supplied header to preflight — the absence of
        // `payment_header` is what tells the two schemes apart, because the
        // 3009 path always carries one built by the local signer.
        if (!args.payment_header) {
          const paymentHeader = await haven.submitX402Erc7710(args.payment_id, args.signature)
          const merchant7710 = await deliverMerchantPayment(
            haven,
            { ...args, payment_header: paymentHeader },
            // No funding tx to confirm — passing one would make the delivery
            // helper wait for a transaction that will never exist.
            undefined,
            // #1508: and `undefined` alone is NOT enough. The helper still read
            // the payment status unconditionally, which is a 409 here because
            // the settle above already moved the intent to 'submitted'. Say
            // "there is no funding leg" explicitly instead of implying it.
            { noFundingLeg: true },
          )
          const summary7710 = await haven.getPostPurchaseAllowanceSummary(args.payment_id)
          return {
            payment_id: args.payment_id,
            settlement_scheme: 'erc7710',
            funding_tx_hash: null,
            settled: merchant7710.ok,
            settlement_tx_hash: merchant7710.settlement_tx_hash,
            result: merchant7710.result,
            allowance: summary7710.allowance,
            ...buildAgentGuidance({
              // Same terminal value the 3009 success path uses (#1308) — one
              // vocabulary, not a parallel one per scheme.
              nextAction: AgentPaymentNextAction.None,
              safeToContinue: true,
              reason:
                'Settled directly from the treasury through the budget delegation — no funding ' +
                'leg, so the delegate wallet never held these funds and there is nothing to sweep.',
              summary: {
                payment_id: args.payment_id,
                status: summary7710.payment?.status ?? 'settled',
                product: args.tool_name,
              },
              warnings: summary7710.warnings,
            }),
          }
        }

        await preflightMcpPaymentHeader(haven, args)
        const funding = await submitSignatureWithExpiryMapping(haven, args.payment_id, args.signature)
        if (funding.status !== 'confirmed') {
          // Funding did not confirm (e.g. queued for approval). Do not deliver the
          // merchant header — return the funding status so the agent can act.
          // Echo payment_id so the agent can cross-reference the queued payment
          // (haven_get_payment_status / haven_list_receipts) without re-deriving it.
          const fundingPending = isPendingApproval(funding.status)
          return {
            payment_id: args.payment_id,
            funding_status: funding.status,
            funding_tx_hash: funding.txHash ?? null,
            settled: false,
            // #1308 review: the two non-confirmed states have DIFFERENT next
            // actions — queued-for-approval is a user decision, a transient
            // funding state is a poll.
            ...buildAgentGuidance({
              nextAction: fundingPending
                ? AgentPaymentNextAction.WaitForUserApproval
                : AgentPaymentNextAction.CheckStatusLater,
              nextTool: 'mcp__haven__haven_get_payment_status',
              nextArguments: { payment_id: args.payment_id },
              safeToContinue: !fundingPending,
              reason: fundingPending
                ? 'Funding is queued for the wallet owner. Tell the user; do not re-sign or re-settle while pending.'
                : 'Funding is not confirmed yet. Poll next_tool, then finish settlement with haven_complete_mcp_tool once confirmed.',
              summary: { payment_id: args.payment_id, status: funding.status },
            }),
          }
        }
        const merchant = await deliverMerchantPayment(haven, args, funding.txHash)
        // #1310: rail-aware remaining-budget summary so the agent can report
        // spend without a separate haven_get_agent/haven_get_allowances round
        // trip. A failed read NEVER converts this settled success into a
        // failure — it degrades to a null block plus a warning, folded into
        // the SAME warnings[] buildAgentGuidance already emits.
        // Reuse the payment-status read the allowance helper already performs;
        // reporting must not add a second status round trip or race it.
        const { allowance, warnings, payment } = await haven.getPostPurchaseAllowanceSummary(args.payment_id)
        const purchaseSummary = buildPurchaseSummary({
          payment,
          merchantResult: merchant.result,
          fundingTxHash: funding.txHash ?? null,
          settlementTxHash: merchant.settlement_tx_hash,
          allowance,
        })
        // Pick explicit fields — don't spread the raw HTTP status/ok, which would
        // collide with the funding/payment-status meaning an agent expects here.
        // Echo payment_id so the agent can reconcile this settled payment against
        // haven_list_receipts / haven_get_payment_status without retaining it from
        // the haven_pay_mcp_tool step.
        return {
          payment_id: args.payment_id,
          funding_tx_hash: funding.txHash ?? null,
          settled: true,
          result: merchant.result,
          settlement_tx_hash: merchant.settlement_tx_hash,
          allowance,
          // #1308: done — nothing left but reporting.
          ...buildAgentGuidance({
            nextAction: AgentPaymentNextAction.None,
            safeToContinue: true,
            reason:
              'Funding and merchant settlement both succeeded. Report the result to the user ' +
              'from agent_summary.purchase_summary; `result` is optional raw merchant evidence, ' +
              'not Haven payment truth. The summary includes remaining allowance/budget when available.',
            summary: {
              payment_id: args.payment_id,
              status: 'settled',
              purchase_summary: purchaseSummary,
            },
            warnings,
          }),
        }
      }),

    haven_quote_catalog_purchase: async (input) =>
      runTool(async () => {
        const args = parse('haven_quote_catalog_purchase', input)
        const entry = await getUsableCatalogMcpEntry(haven, args.catalog_id as string)
        const toolArguments = entry.toolArguments ?? {}
        const { quote, merchantUrl } = await quoteMcpToolCall(haven, {
          merchantUrl: entry.resourceUrl,
          toolName: entry.toolName,
          toolArguments,
        })
        return buildMcpToolQuoteResponse({
          quote,
          merchantUrl,
          toolName: entry.toolName,
          toolArguments,
          requestedMerchantUrl: entry.resourceUrl,
          catalog: entry,
        })
      }),

    haven_quote_x402: async (input) => {
      const args = parse('haven_quote_x402', input)
      const init: RequestInit = {}
      if (args.method) init.method = args.method
      if (args.headers) init.headers = args.headers
      try {
        const quote: X402Quote = await haven.quoteX402(args.url, init)
        // Return the full quote — the agent passes paymentRequired to haven_pay_x402_quote.
        // Omit the captured request snapshot (it's server-side context, not useful at the agent).
        return {
          success: true,
          data: {
            rail: quote.rail,
            idempotency_key: quote.idempotencyKey,
            payment_required: quote.paymentRequired,
            accepted: quote.accepted,
            resource_url: quote.resourceUrl,
            description: quote.description,
            mime_type: quote.mimeType,
            amount_atomic: quote.amountAtomic,
            amount: quote.amount,
            token: quote.token,
            asset: quote.asset,
            network: quote.network,
            chain_id: quote.chainId,
            merchant_address: quote.merchantAddress,
            max_timeout_seconds: quote.maxTimeoutSeconds,
          },
        }
      } catch (err) {
        // #1328: quoteX402's defensive MACHINE-PAYMENT-CHALLENGE guard stays,
        // but nothing in Haven produces that header anymore (the mpp_demo
        // route it identified is retired) — fall through to the generic
        // error rather than suggesting the now-deleted haven_quote_mpp.
        return normalizeError(err)
      }
    },

    haven_pay_x402_quote: async (input) => {
      const args = parse('haven_pay_x402_quote', coerceJsonField(input, 'payment_required'))
      // #1469: agent-supplied shape, sanitized through the SAME normalizer the
      // parsed-Response path uses — it drops null/non-object accepts[] entries
      // and validates the envelope. The raw cast this replaced let a null hole
      // reach the selectors and 500 where every other caller gets a clean
      // refusal; the Zod schema only guarantees a string-keyed record.
      const payReq = normalizePaymentRequired(args.payment_required)
      if (!payReq) {
        return wrongTool(
          'WRONG_TOOL',
          'The payment_required argument is missing or is not a valid x402 PaymentRequired object. Call haven_quote_x402 first to obtain the payment_required, or use haven_pay_mcp_tool for a full round trip.',
          'haven_quote_x402',
        )
      }
      return runTool(async () => {
        // #1351: shape-check the cap before the funding intent — this tool has
        // no merchant probe of its own, so this is the first thing that runs.
        const cap = readMaxAmountCap(args, { required: false })
        try {
          // Enforce the optional price cap against the merchant-authoritative
          // selected option, before creating the funding intent.
          const option = selectStandardPaymentOption(payReq.accepts)
          if (option) {
            // #1351: this path holds a payment OPTION rather than a built
            // quote, so decimals come from the same address→token binding
            // X402Quote.decimals is built from — the merchant's own
            // asset/network, never an assumed 6.
            const optionToken = resolveTokenFromAddress(option.asset, option.network)
            const capAtomic = resolveCapAtomic(cap, {
              decimals: optionToken?.decimals ?? null,
              token: optionToken?.symbol ?? 'the merchant asset',
              asset: option.asset,
              network: option.network,
            })
            assertWithinMaxAmount(
              x402AuthorizationAmount(option),
              capAtomic.atomic,
              optionToken?.symbol,
              capAtomic.label,
            )
          } else if (cap.kind !== 'none') {
            // No selectable option means there is no merchant-authoritative
            // amount to compare a cap against — for EITHER spelling. Before
            // #1351 the cap was simply skipped here, which left the agent
            // believing the purchase was capped when nothing had been checked;
            // the honest answer is to refuse. This only ever narrows: the
            // uncapped call behaves exactly as it always did, and a
            // payment_required with no settleable option was never going to
            // produce a valid purchase anyway.
            const capField = cap.kind === 'human' ? 'max_amount_human' : 'max_amount'
            throw new HostedToolError({
              code: AgentPaymentFailureCode.MaxAmountUnconvertible,
              message:
                `${capField} ("${cap.value}") could not be enforced: this payment_required ` +
                'carries no payment option Haven can settle, so there is no merchant-authoritative ' +
                'amount to compare it against. Haven refuses rather than proceed on an unchecked ' +
                'cap. No funding intent was created and no funds were moved. Re-quote the ' +
                'merchant with haven_quote_x402.',
              statusCode: 400,
              nextAction: AgentPaymentNextAction.StopAndTellUser,
              suggestedTool: 'haven_quote_x402',
            })
          }
          const intent = await haven.createX402Intent(payReq, {
            idempotencyKey: args.idempotency_key,
          })
          return {
            ...buildX402SigningContext(intent, args.include_signing_payload === true),
            // #1275: optional-cap soft nudge for this generic x402 flow.
            // #1351: either spelling of the cap clears it.
            ...(cap.kind === 'none' ? { cap_warning: CAP_WARNING_TEXT } : {}),
            // #1308: decomposed-path next step.
            ...buildAgentGuidance({
              nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
              nextTool: 'mcp__haven-signer__haven_sign_x402',
              nextArguments: { payment_id: intent.paymentId },
              safeToContinue: true,
              reason:
                'Sign locally: call next_tool with next_arguments EXACTLY as given (#1355: the ' +
                'signer fetches payment_required itself; only if it reports the context carried ' +
                'none, re-call with payment_required added VERBATIM from this response). Then ' +
                'relay via haven_submit and finish with ' +
                'haven_x402_sign_header + the original merchant retry.',
              summary: {
                payment_id: intent.paymentId,
                status: intent.status,
                amount_atomic: intent.amountAtomic,
                network: intent.network,
                expires_at: intent.expiresAt,
              },
              warnings: quoteWarnings({
                capped: cap.kind !== 'none',
                expiresAt: intent.expiresAt,
              }),
            }),
          }
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return {
              payment_id: err.paymentId,
              status: 'pending_approval',
              payload_hash: null,
              // #1308 review: the decomposed twin gets the SAME unsafe-to-continue
              // signal as the one-call tool — this is the state the contract
              // exists for.
              ...buildAgentGuidance({
                nextAction: AgentPaymentNextAction.WaitForUserApproval,
                nextTool: 'mcp__haven__haven_get_payment_status',
                nextArguments: { payment_id: err.paymentId ?? null },
                safeToContinue: false,
                reason:
                  'The amount exceeds the remaining budget, so the payment is queued for the ' +
                  'wallet owner. Tell the user, then poll next_tool — do NOT re-quote or re-pay ' +
                  'the same purchase while it is pending.',
                summary: { payment_id: err.paymentId ?? 'unknown', status: 'pending_approval' },
              }),
            }
          }
          throw err
        }
      })
    },

    haven_resume_x402_payment: async (input) => {
      const args = parse('haven_resume_x402_payment', input)
      // #1328: the mpp-rail redirect (haven_resume_mpp_payment) is retired —
      // a non-x402 resume_state now falls through to resolveResumeState's own
      // rail mismatch, not a "use this other tool" suggestion.
      return runTool(async () => {
        const state = await resolveResumeState(haven, args, 'x402') as X402ResumeState

        // Verify the payment is ready to retry before returning signing context.
        const status = await haven.getPaymentStatus(state.paymentId)
        if (status.nextAction !== 'retry_original_x402_request') {
          throw new HavenPaymentStateError(
            status.message ??
              `Payment ${state.paymentId} is not ready to resume (nextAction=${status.nextAction}).`,
            409,
            status,
          )
        }

        // Return the same signing context shape as haven_pay_x402_quote so the
        // signer can call haven_x402_sign_header (or re-derive the binding via
        // haven_sign if the binding was lost across a signer restart).
        return {
          payment_id: state.paymentId,
          status: status.status,
          tx_hash: status.txHash ?? null,
          payment_required: state.paymentRequired,
          x402: {
            accepted: state.accepted,
            resource_url: state.resourceUrl,
            amount: state.amount,
            amount_atomic: state.amountAtomic,
            token: state.token,
            asset: state.asset,
            network: state.network,
          },
        }
      })
    },

    // #1328: haven_quote_mpp / haven_pay_mpp_challenge / haven_resume_mpp_payment
    // (the mpp_demo challenge/quote/resume/authorize tools) are retired —
    // haven_pay_mpp_challenge in particular called POST /machine-payments/authorize
    // directly, which now refuses unconditionally on the backend. Use the x402
    // tools for agent-to-merchant payments.

    haven_get_payment_status: async (input) =>
      runTool(async () => {
        const args = parse('haven_get_payment_status', input)
        // #1310/#1311: shared with packages/mcp's haven_get_payment_status
        // handler — see HavenClient.getPaymentStatusWithPostPurchaseAllowance
        // in @haven_ai/sdk for the single home of this "settled x402 only"
        // attach logic (was duplicated verbatim in both packages).
        return haven.getPaymentStatusWithPostPurchaseAllowance(args.payment_id)
      }),

    haven_get_resume_state: async (input) =>
      runTool(async () => {
        const args = parse('haven_get_resume_state', input)
        return haven.getResumeState(args.payment_id)
      }),

    haven_list_receipts: async (input) =>
      runTool(async () => {
        const args = parse('haven_list_receipts', input)
        return haven.listReceipts({ limit: args.limit })
      }),

    haven_verify_receipt: async (input) =>
      runTool(async () => {
        const args = parse('haven_verify_receipt', input)
        return verifyPaymentReceipt(args.receipt as PaymentReceipt)
      }),
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// #1271: bounded same-origin merchant MCP endpoint discovery. The helper
// itself (`discoverMerchantMcpUrl`, `sameUrl`, and the fixed path/size
// constants) moved to `@haven_ai/sdk` in #1301 so the local/self-signed MCP
// package (`@haven_ai/mcp`) can share the EXACT same bounded implementation
// instead of re-deriving it — see `packages/sdk/src/merchant-discovery.ts`
// for the full contract. `isMerchantEndpointMiss` and `withDiscoveryGuidance`
// below stay here: they are surface-specific to this hosted tool's error
// shapes (the typed `X402UnexpectedStatusError` from `quoteX402`, and
// `HavenApiError` message rewriting).

/**
 * #1308: the structured next-step contract. next_action values come from the
 * EXISTING AgentPaymentNextAction taxonomy; warnings are advisory and never
 * replace a refusal. next_arguments carries only small literal values — the
 * bulky pass-throughs (payment_required, mcp_transport) are named in `reason`
 * and taken verbatim from the same response.
 */
const QUOTE_EXPIRES_SOON_MS = 120_000

function buildAgentGuidance(input: {
  nextAction: AgentNextStep['next_action']
  nextTool?: string
  nextArguments?: Record<string, unknown>
  safeToContinue: boolean
  reason: string
  summary: AgentPaymentSummary
  warnings?: AgentPaymentWarning[]
}) {
  return {
    next_action: input.nextAction,
    ...(input.nextTool ? { next_tool: input.nextTool } : {}),
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
function buildPurchaseSummary(input: {
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

/**
 * The legacy `cap_warning` string and the structured MissingMaxAmount warning
 * say the same thing; #1351 keeps them on one constant so the two spellings of
 * the cap stay described identically in both.
 */
const CAP_WARNING_TEXT =
  'No spending cap was set — the live quoted price was accepted as-is. Pass ' +
  'max_amount_human (whole tokens, e.g. "1" for 1 USDC) or max_amount (atomic units) ' +
  'on paid merchant calls so a changed quote cannot exceed what the user intended to spend.'

function quoteWarnings(args: {
  // #1351: whether this purchase carried a cap AT ALL, in either spelling —
  // not which field expressed it.
  capped: boolean
  expiresAt: string | undefined
  discoveredFrom?: string
}): AgentPaymentWarning[] {
  const warnings: AgentPaymentWarning[] = []
  if (!args.capped) {
    warnings.push({
      code: AgentPaymentWarningCode.MissingMaxAmount,
      // Same substance as the legacy cap_warning field, which stays for compat.
      message: CAP_WARNING_TEXT,
    })
  }
  if (args.expiresAt) {
    const msLeft = Date.parse(args.expiresAt) - Date.now()
    if (Number.isFinite(msLeft) && msLeft > 0 && msLeft < QUOTE_EXPIRES_SOON_MS) {
      warnings.push({
        code: AgentPaymentWarningCode.QuoteExpiresSoon,
        message: `The signing window closes in ${Math.round(msLeft / 1000)}s — sign promptly or re-quote with the same idempotency_key.`,
      })
    }
  }
  if (args.discoveredFrom) {
    warnings.push({
      code: AgentPaymentWarningCode.MerchantUrlDiscovered,
      message: `merchant_url was resolved via the merchant discovery document (from ${args.discoveredFrom}) — pass the RESOLVED merchant_url forward.`,
    })
  }
  return warnings
}

/** The probe failure shape that means "this URL is not the MCP endpoint". */
function isMerchantEndpointMiss(err: unknown): boolean {
  // #1300: the typed class is authoritative; the message check keeps the
  // predicate working against an older bundled SDK during version skew.
  if (err instanceof X402UnexpectedStatusError) return true
  return (
    err instanceof HavenApiError &&
    (err.message.includes('Expected an x402 quote response') ||
      (typeof err.body === 'object' &&
        err.body != null &&
        'mcpSessionNotEstablished' in err.body &&
        err.body.mcpSessionNotEstablished === true))
  )
}

/**
 * Keep the original probe error authoritative, but tell the agent what
 * discovery tried — the pre-#1271 failure mode was silent hand-probing.
 */
function withDiscoveryGuidance(err: unknown, merchantUrl: string, discovered: string | null): unknown {
  if (!(err instanceof HavenApiError)) return err
  const guidance = discovered
    ? `Same-origin discovery resolved the same URL (${discovered}), which still did not answer 402.`
    : `No same-origin discovery document was found at /.well-known/haven-demo-merchant or /. ` +
      `If ${merchantUrl} is a base merchant URL, pass the exact MCP endpoint instead (often <origin>/mcp).`
  return new HavenApiError(`${err.message} ${guidance}`, err.statusCode ?? 400)
}

/**
 * Build the compact, non-authorizing response shared by the generic and
 * catalog MCP quote tools. Deliberately omit payment_required, idempotency,
 * and every signing/funding field: callers must start a fresh paid flow after
 * the user chooses a cap, and that flow obtains its own live quote.
 */
function buildMcpToolQuoteResponse(input: {
  quote: X402Quote
  merchantUrl: string
  requestedMerchantUrl: string
  toolName: string
  toolArguments: Record<string, unknown>
  catalog?: HavenCatalogEntry
}) {
  const { quote, merchantUrl, requestedMerchantUrl, toolName, toolArguments, catalog } = input
  return {
    rail: quote.rail,
    merchant_url: merchantUrl,
    merchant_url_was_discovered: merchantUrl !== requestedMerchantUrl,
    tool_name: toolName,
    arguments: toolArguments,
    resource_url: quote.resourceUrl,
    description: quote.description,
    mime_type: quote.mimeType,
    amount_atomic: quote.amountAtomic,
    amount: quote.amount,
    token: quote.token,
    decimals: quote.decimals,
    asset: quote.asset,
    network: quote.network,
    chain_id: quote.chainId,
    merchant_address: quote.merchantAddress,
    max_timeout_seconds: quote.maxTimeoutSeconds,
    ...(quote.mcpTransport ? { mcp_transport: serializeMcpTransport(quote.mcpTransport) } : {}),
    ...(catalog
      ? {
          catalog_id: catalog.id,
          catalog_name: catalog.name,
          catalog_price_atomic: catalog.priceAtomic,
          catalog_price_display: catalog.priceDisplay,
          catalog_price_is_indicative: true,
          catalog_price_differs: catalog.priceAtomic !== null && catalog.priceAtomic !== quote.amountAtomic,
        }
      : {}),
    quote_is_informational: true,
  }
}

/**
 * The catalog wrappers must refuse rows that cannot produce a live MCP quote.
 * Keep the existing manual fallback and error shape identical across the quote
 * and paid-preflight paths rather than teaching agents two catalog semantics.
 */
async function getUsableCatalogMcpEntry(
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

/**
 * Build the MCP tools/call envelope, probe the merchant, and run the #1271
 * bounded same-origin discovery fallback on a non-402 miss (one retry, at
 * the discovered endpoint only). Shared by the generic/catalog quote and pay
 * tools — the callers differ only in whether they construct an intent after
 * this read and where merchantUrl/toolName/toolArguments came from.
 */
async function quoteMcpToolCall(
  haven: HavenClient,
  input: {
    merchantUrl: string
    toolName: string
    toolArguments: Record<string, unknown>
    idempotencyKey?: string
  },
): Promise<{ quote: X402Quote; merchantUrl: string }> {
  const envelope = {
    jsonrpc: '2.0',
    id: `haven-mcp-${Date.now()}`,
    method: 'tools/call',
    params: {
      name: input.toolName,
      arguments: input.toolArguments,
    },
  }
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  }
  let merchantUrl = input.merchantUrl
  // This is an MCP-tool purchase, so always negotiate the Streamable-HTTP
  // lifecycle before its unpaid tools/call — exact MCP endpoints can use any
  // same-origin path, not only `/mcp`. A base URL that cannot establish a
  // session is treated as a bounded #1271 discovery miss; it never receives a
  // bare tools/call probe.
  const probe = () => haven.quoteMcpX402(merchantUrl, init, { idempotencyKey: input.idempotencyKey })
  try {
    const quote = await probe()
    return { quote, merchantUrl }
  } catch (probeErr) {
    if (!isMerchantEndpointMiss(probeErr)) throw probeErr
    const discovered = await discoverMerchantMcpUrl(merchantUrl)
    // Trailing-slash/case echoes of the input are "same URL" — spend the one
    // retry only on a genuinely different endpoint.
    if (!discovered || sameUrl(discovered, merchantUrl)) {
      throw withDiscoveryGuidance(probeErr, merchantUrl, discovered)
    }
    const inputUrl = merchantUrl
    merchantUrl = discovered
    try {
      const quote = await probe()
      return { quote, merchantUrl }
    } catch (retryErr) {
      // Label which URL failed — the agent otherwise cannot tell the
      // discovered endpoint's miss from the original probe's.
      if (retryErr instanceof HavenApiError) {
        throw new HavenApiError(
          `${retryErr.message} (at the DISCOVERED endpoint ${discovered}, ` +
            `resolved from ${inputUrl} via the merchant discovery document)`,
          retryErr.statusCode ?? 400,
        )
      }
      throw retryErr
    }
  }
}

/** Shape returned by haven_pay_x402_quote and used by haven_resume_x402_payment. */
function buildX402SigningContext(
  intent: Awaited<ReturnType<HavenClient['createX402Intent']>>,
  // #1272: compact by default. On the x402 path the signer fetches the exact
  // signing payload from Haven by payment_id (#1263) and verifies the same
  // Haven-signed binding either way, so the multi-KB typed_data /
  // typed_data_b64 blobs here are redundant in the normal flow — and every
  // byte an agent relays by hand is a chance to recreate the #1255 corruption
  // failure. True restores today's full shape for diagnostics and pre-#1263
  // signers; the recovery loop is re-running the quote tool with the SAME
  // idempotency_key, which replays the ORIGINAL sign_data (#1207 semantics).
  // Direct payments (haven_pay/haven_send) are untouched: they have no
  // payment_id fetch path, so the bulk stays mandatory there.
  includeSigningPayload = false,
) {
  return {
    payment_id: intent.paymentId,
    status: intent.status,
    idempotency_key: intent.idempotencyKey,
    payload_hash: intent.signData.hash,
    expires_at: intent.expiresAt,
    // #1155: state the expected-context version this quote is about to emit, so
    // the agent can compare it against the local signer's advertised set BEFORE
    // signing — the #1143 guard only speaks after a quote already exists. Read
    // from the binding Haven signed rather than re-derived here: the version is
    // an attribute of that binding, and a second derivation could disagree with
    // it. Advisory, not a gate: this surface adds no refusal, and a mismatch is
    // still enforced (fail-closed) by the signer at signing time.
    signer_compatibility: signerCompatibilityNotice(intent.expectedAuth.version),
    // #1138: on the delegation rail the account validates typed data, not
    // payload_hash. When the full payload is requested, pass both through
    // verbatim — the local signer picks the path from the Haven-signed
    // expected context below and refuses the wrong one, so this surface never
    // has to be the thing that gets it right. The scheme marker itself is
    // always kept: it is one small string and tells the agent which rail the
    // intent is on.
    ...(includeSigningPayload
      ? delegationSignFields(intent.signData)
      : intent.signData.signature_scheme
        ? { signature_scheme: intent.signData.signature_scheme }
        : {}),
    // The edge signer needs these to build + sign the EIP-3009 merchant header
    // locally after the funding transfer is relayed via haven_submit.
    x402: {
      accepted: intent.accepted,
      resource_url: intent.resourceUrl,
      merchant_to: intent.merchantTo,
      funding_to: intent.fundingTo,
      expected: {
        payment_id: intent.paymentId,
        payload_hash: intent.signData.hash,
        // MUST be exactly what Haven signed: the backend builds this context
        // from `paymentRequired.resource.url` (the SDK's `intent.resourceUrl`),
        // never the accepted option's own `resource`. Preferring the latter
        // reconstructed a different message whenever a merchant set an
        // option-level `resource` — the signer then refused with
        // "authentication message is invalid", which reads as a credential
        // problem rather than a field mismatch (#1189). The signature is the
        // authority; this surface only relays it.
        resource_url: intent.resourceUrl,
        merchant_to: intent.merchantTo,
        amount: intent.amountAtomic,
        asset: intent.asset,
        network: intent.network,
        expires_at: intent.expiresAt,
        // #1138: without this the signer reconstructs a v1 message, which will
        // not match Haven's v2 signature — the delegation-rail intent then
        // fails closed rather than being signed under a weaker commitment.
        ...(intent.expectedTypedDataHash
          ? { typed_data_hash: intent.expectedTypedDataHash }
          : {}),
        auth: intent.expectedAuth,
      },
    },
  }
}

/**
 * The pre-payment half of #1155: what this quote will emit, plus the instruction
 * to compare it against the local signer.
 *
 * Carried in-band on the quote result rather than left to the tool description
 * alone. The description is read once when the tool list loads; this travels
 * with the number it is about to be compared to, so an agent that never reads
 * descriptions still has the warning in front of it at the moment it matters.
 *
 * The version is read from the binding Haven signed rather than re-derived, and
 * is required on that binding — there is deliberately no "unknown" fallback,
 * which would imply a state the type does not allow and give the agent a null
 * to compare against.
 *
 * **This shape is the stable machine-readable compatibility contract (#1309
 * acceptance: "hosted MCP quote/preflight responses surface compatibility
 * requirements in a stable field").** It was already sufficient going into
 * #1309 — `x402_expected_context_version` is the number to compare,
 * `signer_capability` names where the signer advertises its side, and `check`
 * carries the human-readable instruction. The one genuine gap was that the fix
 * lived ONLY inside that prose; `fallback` below closes it by carrying the same
 * recovery text as data, sourced from the same `SIGNER_UPDATE_FALLBACK`
 * constant the signer's own structured refusal uses (`core.ts`,
 * `assertSupportedBindingVersion`, #1309), so an agent that reads either
 * surface gets byte-identical guidance. Do not rename or remove existing
 * fields without treating it as a breaking change to this contract.
 *
 * This notice stays ADVISORY (owner decision, 2026-08-07, unchanged by
 * #1309): hosted MCP never sees the local signer's `initialize` handshake, so
 * it cannot know whether `emittedVersion` is actually unsupported — only the
 * agent, which sees both sides, can compare them. The `fallback` field
 * therefore names the fix for the case this notice CAN detect (an
 * out-of-date signer), not a refusal of the quote itself. The signer's own
 * signing-time refusal (structured since #1309, see `assertSupportedBindingVersion`
 * in `@haven_ai/signer`) remains the only place an unsupported version is
 * actually enforced.
 */
function signerCompatibilityNotice(emittedVersion: number) {
  return {
    x402_expected_context_version: emittedVersion,
    signer_capability: SIGNER_CAPABILITY_KEY,
    check:
      'Before calling the local signer, compare x402_expected_context_version against ' +
      'x402_expected_context_versions in the haven-signer MCP server\'s initialize result ' +
      `(${SIGNER_CAPABILITY_SOURCE}, also stated in its instructions). ` +
      'If this version is not in that set, the local signer is out of date: STOP before signing ' +
      'and tell the user to update @haven_ai/signer by rerunning `npx @haven_ai/connect@alpha`, ' +
      'which reinstalls the pinned MCP runtime. Do not edit the version to a supported value — ' +
      'it is part of the Haven-signed binding message, so changing it invalidates the signature. ' +
      'Nothing has been spent at this point; no funds move until haven_submit relays a signature.',
    // #1309: the SAME recovery guidance as `check` above, as structured data
    // instead of prose to parse — and the SAME string
    // `assertSupportedBindingVersion` in `@haven_ai/signer` puts on its
    // structured refusal's `fallback` field when this version turns out to be
    // unsupported. Single source: `SIGNER_UPDATE_FALLBACK` in `@haven_ai/sdk`.
    fallback: SIGNER_UPDATE_FALLBACK,
  }
}

function serializeMcpTransport(input: X402McpTransport | undefined):
  | { handshake_required: boolean; source: X402McpTransport['source'] }
  | undefined {
  if (!input) return undefined
  return {
    handshake_required: input.handshakeRequired,
    source: input.source,
  }
}

function parseMcpTransport(input: unknown): X402McpTransport | undefined {
  if (!input || typeof input !== 'object') return undefined
  const transport = input as { handshake_required?: unknown; source?: unknown }
  if (transport.handshake_required !== true) return undefined
  if (transport.source !== 'path' && transport.source !== 'bazaar') return undefined
  return {
    handshakeRequired: true,
    source: transport.source,
  }
}

// #1328: the 'mpp' rail branch (and its haven_resume_mpp_payment caller) is
// retired — this now only ever resolves x402 resume state. Still validates
// an explicitly-passed resume_state's rail rather than trusting it blindly:
// a caller holding a pre-retirement 'mpp' resume_state gets a clear mismatch
// error instead of silently proceeding against the wrong protocol context.
async function resolveResumeState(
  haven: HavenClient,
  args: { payment_id?: string; resume_state?: unknown },
  rail: 'x402',
): Promise<X402ResumeState> {
  if (args.resume_state && typeof args.resume_state === 'object') {
    const stateRail = (args.resume_state as { rail?: unknown }).rail
    if (stateRail !== undefined && stateRail !== rail) {
      throw new HavenApiError(`Resume state is not for the ${rail} rail.`, 409, args.resume_state)
    }
    return args.resume_state as X402ResumeState
  }
  if (args.payment_id) {
    return haven.getResumeState(args.payment_id) as Promise<X402ResumeState>
  }
  throw new HavenApiError(
    `haven_resume_${rail}_payment requires resume_state or payment_id.`,
    400,
  )
}

function isPendingApproval(status: string | undefined): boolean {
  return status === 'pending' || status === 'pending_approval'
}

function wrongTool(code: string, message: string, suggested_tool?: string): ToolFailure {
  return { success: false, code, message, suggested_tool }
}

/**
 * Pre-funding price guard. `authorizedAtomic` is the amount Haven would
 * authorize for the call — the ceiling the merchant can settle at
 * (`maxAmountRequired ?? amount`), i.e. the user's worst-case spend, which is
 * the right figure to cap. Throws a typed PRICE_EXCEEDS_MAX (preserved by
 * normalizeError) when it exceeds the agent's cap, so the call fails
 * BEFORE any funding transfer. The on-chain allowance is still the hard gate;
 * this is an extra agent affordance against surprise overcharges within budget.
 * Compared in atomic BigInt units.
 */
function assertWithinMaxAmount(
  authorizedAtomic: string,
  maxAmount: string | undefined,
  token: string | undefined,
  // #1351: how the CALLER expressed the cap, for the message only. The
  // comparison is always atomic-vs-atomic; echoing "1 USDC" back at an agent
  // that wrote `max_amount_human: "1"` beats echoing 1000000 it never typed.
  capLabel?: string,
): void {
  if (maxAmount === undefined) return
  let authorized: bigint
  let cap: bigint
  try {
    authorized = BigInt(authorizedAtomic)
    cap = BigInt(maxAmount)
  } catch {
    throw new HavenError(
      'max_amount and the authorized amount must be decimal atomic amounts.',
      'INVALID_MAX_AMOUNT',
      400,
    )
  }
  if (authorized > cap) {
    const unit = token ? `${token}, atomic units` : 'atomic units'
    const capText = capLabel ? `${capLabel} (= ${maxAmount} atomic)` : `max_amount ${maxAmount}`
    throw new HavenError(
      `Authorized amount ${authorizedAtomic} exceeds ${capText} (${unit}); ` +
        `this is the ceiling the merchant can settle at. No funds were moved. ` +
        `Confirm the higher amount with the user before retrying with a larger cap.`,
      AgentPaymentFailureCode.PriceExceedsMax,
      400,
    )
  }
}

/**
 * #1351: how the caller expressed this purchase's pre-funding cap.
 *
 * `max_amount` is atomic units of the merchant's asset; `max_amount_human` is
 * the same cap written the way a user says it ("1" = 1 USDC). They differ by
 * 10^decimals, so an agent that means "no more than 1 USDC" and writes
 * `max_amount: "1"` has asked for a cap of 0.000001 USDC — the schema accepted
 * it, and #1275's guard compared it faithfully. Nothing overspends from that
 * mistake (it fails closed, too tight), but the agent cannot buy anything and
 * has no signal why. The fix is a field whose NAME carries the unit.
 */
type MaxAmountCap =
  | { kind: 'none' }
  | { kind: 'atomic'; value: string }
  | { kind: 'human'; value: string }

/**
 * Phase 1 of the cap contract: validate the SHAPE of the caller's cap fields
 * with no network access at all, so a contradictory request is refused before
 * the merchant probe — let alone before a funding intent, a signature, or any
 * money movement. Phase 2 (`resolveCapAtomic`) needs the live quote and runs
 * after it.
 */
function readMaxAmountCap(
  args: Record<string, unknown>,
  opts: { required: boolean },
): MaxAmountCap {
  const atomic = args.max_amount as string | undefined
  const human = args.max_amount_human as string | undefined

  if (atomic !== undefined && human !== undefined) {
    throw new HostedToolError({
      code: AgentPaymentFailureCode.AmbiguousMaxAmount,
      message:
        `Both max_amount ("${atomic}", atomic units) and max_amount_human ("${human}", ` +
        `whole tokens) were supplied for one purchase. These are different caps — they ` +
        `differ by a factor of 10^decimals — and Haven will not guess which one the user ` +
        `meant. No merchant was contacted and no funds were moved. Send exactly ONE: ` +
        `max_amount_human for a cap the user stated in tokens ("no more than 1 USDC" → ` +
        `max_amount_human: "1"), or max_amount when you already hold an exact atomic figure.`,
      statusCode: 400,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
    })
  }
  if (atomic !== undefined) return { kind: 'atomic', value: atomic }
  if (human !== undefined) return { kind: 'human', value: human }
  if (opts.required) {
    // Same INVALID_INPUT code the schema itself would have produced when
    // max_amount was unconditionally required on this tool — the guided path
    // still refuses to run uncapped, it now accepts either spelling.
    throw new HostedToolError({
      code: 'INVALID_INPUT',
      message:
        'A spending cap is REQUIRED before a paid merchant call. Pass max_amount_human ' +
        '(whole tokens, e.g. "1" for 1 USDC — recommended) or max_amount (atomic units). ' +
        'No merchant was contacted and no funds were moved.',
      statusCode: 400,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
    })
  }
  return { kind: 'none' }
}

/**
 * Exact decimal-string → atomic conversion. No floats anywhere: `Number("0.1")`
 * cannot represent a tenth, and this figure is a spending limit. Returns null
 * when the value carries more fraction digits than the asset can hold, because
 * the only alternatives there are rounding the user's cap up (unsafe) or down
 * (silently different) — the caller turns null into a refusal.
 */
function humanToAtomic(human: string, decimals: number): bigint | null {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(human)
  if (!match) return null
  const whole = match[1]
  const fraction = match[2] ?? ''
  if (fraction.length > decimals) return null
  return BigInt(whole + fraction.padEnd(decimals, '0'))
}

/**
 * Phase 2 of the cap contract: bind the cap to THIS quote. The quote's asset,
 * decimals and network stay authoritative — a human cap is only ever
 * interpreted through the decimals the live quote resolved for the asset the
 * merchant actually asked to be paid in, never through a caller-supplied token
 * name or an assumed 6. Returns the atomic cap to compare, plus the label to
 * quote back at the agent if it is exceeded.
 *
 * This NARROWS spend and can never widen it: the result feeds
 * `assertWithinMaxAmount`, which only ever throws. The on-chain allowance (or
 * delegation budget) remains the hard gate regardless of what is passed here.
 */
function resolveCapAtomic(
  cap: MaxAmountCap,
  quote: { decimals: number | null; token: string; asset: string; network: string },
): { atomic: string | undefined; label?: string } {
  if (cap.kind === 'none') return { atomic: undefined }
  if (cap.kind === 'atomic') return { atomic: cap.value }

  if (quote.decimals === null) {
    throw new HostedToolError({
      code: AgentPaymentFailureCode.MaxAmountUnconvertible,
      message:
        `max_amount_human ("${cap.value}") cannot be applied to this quote: Haven does not ` +
        `recognise the merchant's asset ${quote.asset} on ${quote.network}, so the number of ` +
        `atomic units in one token is unknown and any conversion would be a guess. No funding ` +
        `intent was created and no funds were moved. Re-send the cap as max_amount in atomic ` +
        `units of that asset, or ask the user to confirm this merchant is expected.`,
      statusCode: 400,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
    })
  }

  const atomic = humanToAtomic(cap.value, quote.decimals)
  if (atomic === null) {
    throw new HostedToolError({
      code: AgentPaymentFailureCode.MaxAmountUnconvertible,
      message:
        `max_amount_human ("${cap.value}") carries more decimal places than ${quote.token} ` +
        `supports (${quote.decimals}). Truncating it would silently change the user's cap, so ` +
        `Haven refuses instead. No funding intent was created and no funds were moved. Round ` +
        `the cap to ${quote.decimals} decimal places, or send an exact max_amount in atomic units.`,
      statusCode: 400,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
    })
  }
  return { atomic: atomic.toString(), label: `max_amount_human ${cap.value} ${quote.token}` }
}

function parse<TName extends HostedToolName>(name: TName, input: unknown): Record<string, any> {
  return z.object(toolSchemas[name]).parse(input ?? {})
}

class HostedToolError extends Error {
  readonly code: string
  readonly statusCode?: number
  readonly paymentId?: string
  readonly status?: string
  readonly phase?: string
  readonly nextAction?: string
  readonly rail?: string
  readonly idempotencyKey?: string | null
  readonly retryWithNewQuote?: boolean
  readonly suggestedTool?: string

  constructor(input: {
    code: string
    message: string
    statusCode?: number
    paymentId?: string
    status?: string
    phase?: string
    nextAction?: string
    rail?: string
    idempotencyKey?: string | null
    retryWithNewQuote?: boolean
    suggestedTool?: string
  }) {
    super(input.message)
    this.name = 'HostedToolError'
    this.code = input.code
    this.statusCode = input.statusCode
    this.paymentId = input.paymentId
    this.status = input.status
    this.phase = input.phase
    this.nextAction = input.nextAction
    this.rail = input.rail
    this.idempotencyKey = input.idempotencyKey
    this.retryWithNewQuote = input.retryWithNewQuote
    this.suggestedTool = input.suggestedTool
  }
}

/**
 * #1307: resolve merchant_url/tool_name/arguments/mcp_transport for
 * haven_complete_mcp_tool / haven_settle_mcp_tool. Explicit args are the
 * version-skew fallback and win OUTRIGHT when BOTH merchant_url and
 * tool_name are present — never merged with a rehydrated value, so a partial
 * caller-supplied context can't silently combine with stored state for the
 * same call. Omitting either one rehydrates the FULL stored context by
 * payment_id (the #1263 sign-context precedent, applied to the settle leg).
 */
async function resolveMerchantCallContext(
  haven: HavenClient,
  args: Record<string, any>,
): Promise<{ merchantUrl: string; toolName: string; toolArguments: Record<string, unknown>; mcpTransportRaw: unknown }> {
  const hasUrl = typeof args.merchant_url === 'string'
  const hasTool = typeof args.tool_name === 'string'
  if (hasUrl && hasTool) {
    return {
      merchantUrl: args.merchant_url,
      toolName: args.tool_name,
      toolArguments: (args.arguments as Record<string, unknown> | undefined) ?? {},
      mcpTransportRaw: args.mcp_transport,
    }
  }
  // #1307 review: exactly ONE of the pair present is refused, not silently
  // overridden — an agent that supplied merchant_url expects it to be used,
  // and half-explicit input must never be combined with stored state.
  if (hasUrl !== hasTool) {
    throw new HostedToolError({
      code: 'INVALID_INPUT',
      message:
        'merchant_url and tool_name must be supplied TOGETHER (explicit context) or both ' +
        'omitted (rehydrated from payment_id). Passing only one is refused rather than ' +
        'silently overridden by stored state.',
      statusCode: 400,
      paymentId: args.payment_id,
      status: 'invalid_input',
      phase: 'not_started',
      nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
      rail: 'x402',
    })
  }
  try {
    const ctx = await haven.getX402MerchantCallContext(args.payment_id)
    return {
      merchantUrl: ctx.merchantUrl,
      toolName: ctx.toolName,
      toolArguments: ctx.arguments,
      mcpTransportRaw: ctx.mcpTransport ? serializeMcpTransport(ctx.mcpTransport) : undefined,
    }
  } catch (err) {
    if (err instanceof HavenApiError) {
      if (err.statusCode === 410) {
        throw paymentWindowExpiredError({
          paymentId: args.payment_id,
          status: 'expired',
          phase: 'expired',
          nextAction: AgentPaymentNextAction.PaymentWindowExpired,
          rail: 'x402',
        })
      }
      // 404 (unknown/foreign payment_id) and 409 (no stored context, or not
      // an x402 intent) both land here: the fix is the same either way —
      // re-send the fields explicitly.
      throw new HostedToolError({
        code: AgentPaymentFailureCode.MerchantCallContextUnavailable,
        message:
          `merchant_url/tool_name were omitted and Haven could not rehydrate a stored merchant ` +
          `call context for payment ${args.payment_id} (${err.message}). Re-send merchant_url, ` +
          'tool_name, arguments, and mcp_transport explicitly.',
        statusCode: err.statusCode,
        nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
        paymentId: args.payment_id,
        rail: 'x402',
      })
    }
    throw err
  }
}

/**
 * Deliver the signed X-PAYMENT header to the merchant and shape the result.
 * Shared by haven_complete_mcp_tool (decomposed flow) and haven_settle_mcp_tool
 * (fast flow). Funding has already confirmed before this runs, so a non-2xx
 * merchant response means the delegate holds stranded funds — surface a typed
 * MERCHANT_REJECTED_AFTER_FUNDING (not a soft ok:false) so the agent reconciles
 * via haven_sweep_delegate. The X-PAYMENT header is a signed authorization the
 * edge signer produced — Haven relays it but never holds the key.
 */
async function deliverMerchantPayment(
  haven: HavenClient,
  // Parsed haven_complete_mcp_tool / haven_settle_mcp_tool args (Zod-validated).
  args: Record<string, any>,
  // Funding tx hash from haven_submit when known (settle path); the wait falls
  // back to the payment status when omitted (complete path).
  fundingTxHash?: string,
  // #1508: a scheme with NO funding leg (erc7710) must skip the funding wait
  // ENTIRELY. Omitting fundingTxHash above does NOT achieve that — see below.
  options?: { noFundingLeg?: boolean },
): Promise<{ status: number; ok: boolean; result: unknown; settlement_tx_hash: string | null }> {
  // #1307: resolve merchant_url/tool_name/arguments/mcp_transport BEFORE
  // waiting on funding confirmation — a version-skew refusal (no stored
  // context) should surface immediately, not after a pointless wait.
  const context = await resolveMerchantCallContext(haven, args)

  // Wait for ≥1 on-chain confirmation of the funding tx BEFORE the merchant
  // verifies the X-PAYMENT header — otherwise its balanceOf(delegate) check
  // races the not-yet-mined funding tx and returns "Payment verification
  // failed". No-op if BASE_RPC_URL isn't configured (chainRpcs unset).
  //
  // #1508: on a no-funding-leg scheme this must not run AT ALL, and passing
  // `undefined` for fundingTxHash is not the same thing — the bug this fixes.
  // `ensureFundingConfirmed` reads GET /payments/:id UNCONDITIONALLY before it
  // ever looks at the hash, and by this point an erc7710 settle has already
  // flipped the intent to 'submitted', which the backend maps to HTTP 409
  // (`agentPaymentStatusHttpCode`). The SDK turns that into a throw, so a
  // payment whose settlement SUCCEEDED was reported to the agent as a failure —
  // deterministically, on every hosted erc7710 call, with the merchant never
  // contacted.
  if (!options?.noFundingLeg) {
    await haven.ensureFundingConfirmed(args.payment_id, fundingTxHash)
  }

  const envelope = {
    jsonrpc: '2.0',
    id: `haven-mcp-${randomUUID()}`,
    method: 'tools/call',
    params: { name: context.toolName, arguments: context.toolArguments },
  }
  let result: Awaited<ReturnType<HavenClient['completeX402MerchantCall']>>
  try {
    result = await haven.completeX402MerchantCall({
      url: context.merchantUrl,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      },
      paymentId: args.payment_id,
      paymentHeader: args.payment_header,
      mcpTransport: parseMcpTransport(context.mcpTransportRaw),
    })
  } catch (err) {
    // #1300 review finding: at this point funding is CONFIRMED on-chain, so a
    // merchant that never answers leaves the same money-at-risk state as one
    // that rejects — but a timeout is NOT proof of rejection: the merchant
    // holds a valid EIP-3009 authorization and may settle late. Route it to
    // its own guidance (verify-then-sweep), never the bare 504 and never a
    // blind sweep that could race a late settlement.
    if (err instanceof MerchantTimeoutError) {
      throw new HostedToolError({
        code: AgentPaymentFailureCode.MerchantUnresponsiveAfterFunding,
        message:
          `The funding leg is confirmed on-chain, but the merchant did not answer the paid ` +
          `retry before the timeout. The merchant may still settle late. Check ` +
          `haven_get_payment_status and retry haven_complete_mcp_tool ONCE before considering ` +
          `a sweep — sweep only if no settlement appears. ${err.message}`,
        statusCode: 504,
        paymentId: args.payment_id,
        status: 'merchant_unresponsive_after_funding',
        phase: 'funded_but_unsettled',
        nextAction: AgentPaymentNextAction.SweepStrandedFunds,
        rail: 'x402',
        suggestedTool: 'haven_get_payment_status',
      })
    }
    throw err
  }
  if (!result.ok) {
    let status: Awaited<ReturnType<HavenClient['getPaymentStatus']>> | null = null
    try {
      status = await haven.getPaymentStatus(args.payment_id)
    } catch {
      // Preserve the merchant rejection even if status lookup is unavailable.
    }
    throw new HostedToolError({
      code: AgentPaymentFailureCode.MerchantRejectedAfterFunding,
      message:
        `Merchant rejected the payment after funding (HTTP ${result.status}). ` +
        `The delegate wallet may hold stranded funds — reconcile with haven_sweep_delegate. ` +
        `Merchant response: ${JSON.stringify(result.body).slice(0, 500)}`,
      statusCode: result.status,
      paymentId: args.payment_id,
      status: status?.status ?? 'merchant_rejected_after_funding',
      phase: status?.phase ?? 'funded_but_unsettled',
      nextAction: status?.nextAction ?? AgentPaymentNextAction.SweepStrandedFunds,
      rail: status?.rail ?? 'x402',
      idempotencyKey: status?.idempotencyKey,
      suggestedTool: 'haven_sweep_delegate',
    })
  }
  return {
    status: result.status,
    ok: result.ok,
    result: result.body,
    settlement_tx_hash: result.settlementTxHash ?? null,
  }
}

async function submitSignatureWithExpiryMapping(
  haven: HavenClient,
  paymentId: string,
  signature: string,
): ReturnType<HavenClient['submitSignature']> {
  try {
    return await haven.submitSignature(paymentId, signature)
  } catch (err) {
    const mapped = await paymentWindowExpiredErrorFor(haven, paymentId, err)
    if (mapped) throw mapped
    throw err
  }
}

/**
 * Hosted fast-path preflight (#1398). The status read is agent-scoped and
 * exposes the intent's captured delegate, unlike getAgent() which may have
 * changed after the intent was created. Never include an untrusted header in a
 * thrown error: MCP error payloads and observability consumers serialize it.
 */
async function preflightMcpPaymentHeader(haven: HavenClient, args: Record<string, any>): Promise<void> {
  const status = await haven.getPaymentStatus(args.payment_id)
  try {
    if (
      status.rail !== 'x402' ||
      !status.merchantAddress ||
      !status.amountAtomic ||
      !status.asset ||
      !status.network ||
      !status.resourceUrl ||
      !status.payerAddress
    ) {
      throw new X402PaymentHeaderValidationError()
    }
    await validateStandardX402PaymentHeader(args.payment_header, {
      merchantTo: status.merchantAddress,
      amountAtomic: status.amountAtomic,
      asset: status.asset,
      network: status.network,
      resourceUrl: status.resourceUrl,
      payer: status.payerAddress,
      chainId: status.chainId,
    })
  } catch (err) {
    if (!(err instanceof X402PaymentHeaderValidationError)) throw err
    throw new HostedToolError({
      code: 'INVALID_PAYMENT_HEADER',
      message:
        'The X-PAYMENT header did not match the funded x402 intent. No funding was relayed. ' +
        'Recreate the header with the local signer from this payment_id, then retry.',
      statusCode: 400,
      paymentId: args.payment_id,
      status: 'invalid_payment_header',
      phase: 'not_started',
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      rail: 'x402',
      suggestedTool: 'mcp__haven-signer__haven_sign_x402',
    })
  }
}

async function paymentWindowExpiredErrorFor(
  haven: HavenClient,
  paymentId: string,
  err: unknown,
): Promise<HostedToolError | null> {
  if (err instanceof HavenPaymentStateError && isX402PaymentWindowExpired(err.state)) {
    return paymentWindowExpiredError(err.state)
  }
  if (!(err instanceof HavenApiError) || err.statusCode !== 410) return null
  try {
    const status = await haven.getPaymentStatus(paymentId)
    if (isX402PaymentWindowExpired(status)) return paymentWindowExpiredError(status)
  } catch {
    // Preserve the original API error if the status lookup cannot confirm this
    // was an x402 funding-window expiry.
  }
  return null
}

function isX402PaymentWindowExpired(state: {
  rail?: string
  status?: string
  phase?: string
  nextAction?: string
}): boolean {
  return state.rail === 'x402' && (state.status === 'expired' || state.phase === 'expired')
}

function paymentWindowExpiredError(state: {
  paymentId: string
  status: string
  phase: string
  nextAction: string
  rail: string
  idempotencyKey?: string | null
}): HostedToolError {
  const idempotencyGuidance = state.idempotencyKey
    ? ` Re-quote with haven_pay_mcp_tool using the same idempotency_key (${state.idempotencyKey}).`
    : ' Re-quote with haven_pay_mcp_tool using the same idempotency_key from the original call.'
  return new HostedToolError({
    code: AgentPaymentFailureCode.PaymentWindowExpired,
    message: `The x402 payment window expired before completion.${idempotencyGuidance}`,
    statusCode: 410,
    paymentId: state.paymentId,
    status: state.status,
    phase: state.phase,
    nextAction: AgentPaymentNextAction.PaymentWindowExpired,
    rail: state.rail,
    idempotencyKey: state.idempotencyKey,
    retryWithNewQuote: true,
    suggestedTool: 'haven_pay_mcp_tool',
  })
}

/**
 * If a caller's transport serialised an object-typed field to a JSON string,
 * parse it back before schema validation (the object-typed schema would
 * otherwise reject the string). Mirrors the same guard in the edge signer.
 */
function coerceJsonField(input: unknown, field: string): unknown {
  if (!input || typeof input !== 'object') return input
  const record = input as Record<string, unknown>
  if (typeof record[field] !== 'string') return input
  try {
    return { ...record, [field]: JSON.parse(record[field] as string) }
  } catch {
    return input
  }
}

async function runTool<T>(fn: () => Promise<T>): Promise<ToolPayload<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (err) {
    return normalizeError(err)
  }
}

function normalizeError(err: unknown): ToolFailure {
  if (err instanceof HostedToolError) {
    return {
      success: false,
      code: err.code,
      message: err.message,
      suggested_tool: err.suggestedTool,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      status: err.status,
      phase: err.phase,
      next_action: err.nextAction,
      rail: err.rail,
      idempotency_key: err.idempotencyKey,
      retry_with_new_quote: err.retryWithNewQuote,
    }
  }
  if (err instanceof z.ZodError) {
    return {
      success: false,
      code: 'INVALID_INPUT',
      message: err.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; '),
      statusCode: 400,
    }
  }
  if (err instanceof HavenPaymentStateError) {
    if (isX402PaymentWindowExpired(err.state)) {
      return normalizeError(paymentWindowExpiredError(err.state))
    }
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      status: err.status,
      phase: err.phase,
      next_action: err.nextAction,
      rail: err.state.rail,
      idempotency_key: err.state.idempotencyKey,
    }
  }
  if (err instanceof HavenApiError) {
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
    }
  }
  if (err instanceof HavenError) {
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
    }
  }
  return {
    success: false,
    code: 'UNKNOWN_ERROR',
    message: err instanceof Error ? err.message : String(err),
  }
}
