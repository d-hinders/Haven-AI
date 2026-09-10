/**
 * #2807 — the typed hosted-MCP tool CONTRACTS, extracted verbatim from
 * `tools.ts` (now the compatibility facade).
 *
 * This module owns the data of the hosted tool surface: the `HostedToolName`
 * union, every tool's advertised JSON schema (`toolSchemas`), the
 * strict/permissive input-policy decisions (`STRICT_INPUT_TOOLS` /
 * `PERMISSIVE_INPUT_TOOLS`, with their compile-time exhaustiveness sentinels),
 * the agent-facing descriptions (`toolDescriptions`), and the response payload
 * types (`ToolSuccess` / `ToolFailure` / `ToolPayload`).
 *
 * NOTHING here executes a tool. Handlers live in the capability modules under
 * `tools/` and are composed by `tools.ts`, which stays the facade every
 * embedder imports; the registration seam lives in `tools/registry.ts`;
 * argument parsing lives in `tools/parsing.ts`. #2809 moved the first ten —
 * the state, direct-payment and recovery handlers, to
 * `tools/state-direct-recovery.ts` — and #2810–#2812 take the rest against
 * this same seam. (This sentence said "handlers stay in `tools.ts`" until
 * #2809 made it false; it is the load-bearing kind of module comment no gate
 * names, so it is corrected in the slice that invalidated it rather than
 * left for a later sweep.) `HostedToolError` moved to
 * `tools/support/errors.ts` in #2808 — deliberately NOT here: locating the
 * class in the contract seam would fork the class `normalizeError`
 * instanceof-checks. Shared support (errors, guidance, cap/price, transport/
 * context, quote responses) also landed under `tools/support/` in #2808.
 */
import { z } from 'zod/v3'
import { composeDescription, toolDescriptions as sharedDescriptions } from '@haven_ai/sdk'

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
  | 'haven_report_x402_outcome'
  | 'haven_get_payment_status'
  | 'haven_get_resume_state'
  | 'haven_list_receipts'
  | 'haven_verify_receipt'
  | 'haven_sweep_delegate'
  | 'haven_discover_tools'
  | 'haven_submit_catalog_entry'

/**
 * #2282: the hosted MCP tool boundary spells arguments in **snake_case**
 * (`payment_id`, `merchant_url`, `tool_name`), and `mcp_transport` is no
 * exception. The SDK / HTTP API spells the same value in camelCase
 * (`X402McpTransport.handshakeRequired`, `POST /x402/authorize`'s
 * `mcpCallContext.mcpTransport`) — both spellings are authoritative, each at
 * its own boundary, and `serializeMcpTransport` / `parseMcpTransport` bridge
 * them.
 *
 * The failure #2282 reports is a caller reaching this boundary with the SDK's
 * camelCase shape. Two things make that refusal worth spelling out here rather
 * than leaving to zod's default:
 *
 *   1. `.strict()` — the JSON Schema this shape advertises to agents already
 *      says `additionalProperties: false`, but a bare `z.object` STRIPS unknown
 *      keys instead of refusing them. Advertising strict and behaving
 *      permissive is precisely the "the caller cannot tell their argument was
 *      dropped" shape; strict makes the behaviour match the advertisement.
 *   2. `required_error` — the default message is `handshake_required: Required`,
 *      which is true but does not tell a caller holding `handshakeRequired`
 *      what is wrong with it. A rejection a caller can act on is worth more
 *      than a permissive parse, so the message names the mismatch.
 */
export const MCP_TRANSPORT_CASE_HINT =
  'mcp_transport uses snake_case at the hosted tool boundary: ' +
  '{ handshake_required: boolean, source: "path" | "bazaar" }. The SDK and the HTTP API ' +
  'spell the same value camelCase ({ handshakeRequired, source }) — that shape is REFUSED ' +
  'here rather than ignored, so rename the key. Echo the mcp_transport a Haven quote tool ' +
  'returned and it is already correct.'

const mcpTransportArg = z
  .object({
    handshake_required: z.boolean({ required_error: MCP_TRANSPORT_CASE_HINT }),
    source: z.enum(['path', 'bazaar'], { required_error: MCP_TRANSPORT_CASE_HINT }),
  })
  .strict(MCP_TRANSPORT_CASE_HINT)

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
    verified: z.enum(['any', 'verified', 'operator']).optional(),
  },
  haven_submit_catalog_entry: {
    resource_url: z.string().min(1),
    website: z.string().optional(),
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
    // #2041: which scheme this signature belongs to, stated EXPLICITLY rather
    // than inferred — the same #1360 property the authorize leg has. On
    // erc7710 there is no funding leg: the signature IS the settlement child,
    // so it goes to POST /x402/:id/settle and Haven returns the assembled
    // merchant header. Omitted (or 'eip3009') relays the funding signature
    // exactly as before, so every existing caller is untouched.
    settlement_scheme: z.enum(['erc7710', 'eip3009']).optional(),
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
    mcp_transport: mcpTransportArg.optional(),
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
    mcp_transport: mcpTransportArg.optional(),
    // The X-PAYMENT header built by the local signer (haven_sign_x402).
    // #1456: OPTIONAL — its absence selects erc7710, where Haven assembles the
    // header at settle instead of the signer building it locally.
    payment_header: z.string().min(1).optional(),
  },
  haven_quote_x402: {
    url: z.string().url(),
    method: z.string().optional(),
    headers: z.record(z.string()).optional(),
    /**
     * #2366. The one divergence #2348's refusal REMOVED a capability to close:
     * the hosted quote had no field to route a payload to, so a body-bearing
     * POST paywall was probed with an EMPTY body and the quote described a
     * request the caller never made (measured over the real transport:
     * `POST /paid :: `). Refusing was strictly better than lying; this makes
     * it answerable. Same shape and same name as the local surface's, so this
     * argument is now spelled once across both.
     */
    body: z.string().optional(),
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
  haven_report_x402_outcome: {
    // #2292: the plain-HTTP twin of haven_complete_mcp_tool's bookkeeping —
    // see REPORT_X402_OUTCOME_DESCRIPTION for why it is a separate tool.
    //
    // Note what is NOT here: no merchant_url, no tx_hash, no resource_url, no
    // amount. Everything Haven writes down is read from the payment's own
    // record, so the report says what the merchant ANSWERED and cannot say
    // what it was answering about.
    payment_id: z.string().min(1),
    outcome: z.enum(['accepted', 'rejected'], {
      required_error:
        'outcome is required: "accepted" if the merchant served the resource (2xx), ' +
        '"rejected" if it refused (non-2xx).',
    }),
    merchant_status: z
      .number()
      .int()
      .min(100)
      .max(599)
      .describe('The HTTP status the merchant returned to your retry.'),
    // Truncated server-side; kept short because it is a diagnostic snippet,
    // not a receipt.
    merchant_body: z.string().max(4096).optional(),
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

// ── Strict input (#2312) ─────────────────────────────────────────────────────

/**
 * #2312: which hosted tools REFUSE an undeclared argument, and why each one is
 * on this list rather than the list being "all of them".
 *
 * ## What was actually broken, measured
 *
 * #2292 added `parseStrict` below and pointed it at `haven_report_x402_outcome`.
 * That guard **could not fire over the wire.** The MCP SDK validates a tool call
 * against the registered input schema and hands the handler `parseResult.data`
 * — the STRIPPED object — before our handler runs
 * (`@modelcontextprotocol/sdk`'s `McpServer.validateToolInput`). So an undeclared
 * `tx_hash` was gone by the time `parseStrict` looked for it: measured on
 * 2026-09-01 by driving a real `InMemoryTransport` client against
 * `buildHostedMcpServer`, where that exact call returned `success: true` and
 * WROTE its reconciliation event. `parseStrict`'s own test calls the handler
 * directly, which is the only place the property held.
 *
 * That is the same defect the guard was written to prevent, one layer up: a
 * check that returns cleanly while being about a different question than its
 * author thinks. So strictness has to be declared where the SDK enforces it —
 * at registration (`toolInputSchema` below, consumed by `server.ts`) — and
 * `parseStrict` stays as the second line for an embedder that imports
 * `createToolHandlers` directly, which `index.ts` exports.
 *
 * ## Why this does NOT re-prompt operators
 *
 * Measured, not assumed. Two independent reasons, either one sufficient:
 *
 *   1. The advertised JSON Schema does not move. `zod-to-json-schema` already
 *      emits `additionalProperties: false` for a strip-mode `z.object`, so the
 *      loose and strict advertisements are BYTE-IDENTICAL for all 22 hosted
 *      schemas (surface hash `cf41c32a83b10c54` both ways, against a control
 *      mutation at `3c8ea4a1f4bc564b`). The advertisement was already strict;
 *      only the behaviour was permissive.
 *   2. `computeConsentHash` (`packages/mcp/src/consent.ts`) hashes identity +
 *      tool NAMES + the allowance summary. It takes no schema argument at all,
 *      and the hosted server has no consent gate in the first place — the gate
 *      lives in `packages/mcp` and `packages/signer`.
 *
 * ## Which tools, and which deliberately not
 *
 * On the list, batch 1 (#2312): the money-path tools that read something from
 * the payment's own RECORD rather than from arguments. Those have #2292's exact
 * failure mode — a stripped key lets a caller believe it pinned a value it did
 * not — and they are where a silent strip costs money.
 *
 * On the list, batch 2 (#2348): the four tools the LOCAL MCP
 * (`packages/mcp/src/tools.ts`) reaches under the same name with a DIFFERENT
 * argument spelling. Measured over the transport on 2026-09-01 against
 * `origin/dev` `c259d9ca`, not inferred from the schemas:
 *
 *   - `haven_send` — `idempotencyKey` stripped, and `POST /payments` then goes
 *     out as `{token, amount, to}` with NO `idempotency_key` field at all
 *     (`client.ts` spreads it conditionally). Total loss: the backend's replay
 *     contract never engages, so a retry is a second spend. The strongest case
 *     here.
 *   - `haven_pay_mcp_tool` — `idempotencyKey` stripped, and the SDK then falls
 *     back to `buildX402IdempotencyKey(paymentRequired, option)`: a hash of the
 *     merchant quote over a 300_000 ms bucket. Not a total loss — a REPLACED
 *     replay scope, which is the worse shape to reason about, because it
 *     de-dupes two genuinely distinct purchases of the same item inside one
 *     bucket and fails to de-dupe a retry that crosses a bucket boundary.
 *   - `haven_quote_x402` — the local-only `body` is stripped and the hosted
 *     probe fires with an EMPTY body (measured: `POST /paid :: `), so the quote
 *     describes a request the caller never made. `idempotencyKey` is stripped
 *     too, but a quote creates no payment, so that half costs nothing directly.
 *   - `haven_pay_x402_quote` — the headline crossover, `quote` for
 *     `payment_required`, ALREADY failed loudly and always has: `payment_required`
 *     is a required field, so the SDK's own validation refuses with
 *     `-32602 … "payment_required" Required` and makes zero Haven calls. Only
 *     `idempotencyKey` was silent here. Stated because the divergence table in
 *     #2348 reads as though both keys were equally silent, and they were not.
 *
 * On the list, batch 3 (#2349): the remaining twelve, which closes the list.
 * Each is either record-reading in #2312's sense (`haven_prepare_catalog_purchase`,
 * `haven_quote_catalog_purchase`, `haven_resume_x402_payment`,
 * `haven_sweep_delegate`, the two by-id status reads), a filter or a list where
 * a stripped key returns the UNFILTERED answer looking filtered
 * (`haven_discover_tools`, `haven_list_receipts`), or an argument-driven call
 * where the dropped key is the replay key or a cap that nothing then enforces
 * (`haven_pay`, `haven_quote_mcp_tool`, `haven_submit_catalog_entry`,
 * `haven_verify_receipt`). The principle that decides it is the one #2312
 * started from: every one of these advertises `additionalProperties: false`,
 * so permissive behaviour was a contract mismatch on each of them, and the
 * only reason to leave one permissive is a LIVE caller that would break. The
 * enumeration (SDK, `packages/mcp`, `packages/connect`, the shipped skill text
 * and its byte-pinned twin, the QA legs, e2e fixtures, docs, `.agents`) found
 * none for these twelve; the one undeclared caller it found was test-side
 * (`tools.test.ts` sending `max_amount` to `haven_quote_mcp_tool`, which has
 * never taken a cap — the #2312 `tools.test.ts:2399` shape again), fixed in the
 * same change. Measured over the transport on 2026-09-02 against `origin/dev`
 * `d09a6cf5`: `haven_pay` with `idempotencyKey` reached `POST /payments` with
 * NO `idempotency_key` field at all — the identical total loss #2348 measured
 * on `haven_send`.
 *
 * Two things the issue asked to be checked, and what was found:
 *
 *   - The `max_amount` / `max_amount_human` cap pair is NOT on `haven_pay`
 *     (its schema is `token`, `amount`, `to`, `idempotency_key`); it is on
 *     `haven_prepare_catalog_purchase` in this batch. Strictness does not
 *     change which refusal a caller meets: both cap fields are DECLARED, so a
 *     strict parse passes them through untouched and `readMaxAmountCap` still
 *     raises its `AmbiguousMaxAmount` / cap-required refusals, before any
 *     network call. Only a call carrying an UNDECLARED key alongside meets the
 *     strict refusal first — and that call has to be repaired anyway. Pinned
 *     over the transport in `strict-tool-input.test.ts`.
 *   - `haven_resume_x402_payment` parsed OUTSIDE its `runTool`, the #2348
 *     embedder-path defect on a third tool: a validation error escaped
 *     `createToolHandlers` as a raw throw instead of a `ToolFailure`. Moved
 *     inside, same as the other two.
 *
 * ## Refuse loudly, or CONVERGE on one spelling? (#2348)
 *
 * Convergence is the destination and a hard refusal is the on-ramp, not a
 * substitute: refusing loudly and diverging forever is a worse end state than
 * refusing loudly on the way to one spelling. Convergence is deliberately NOT
 * taken here, for a reason that is about release mechanics rather than taste —
 * `@haven_ai/mcp` is PUBLISHED, so renaming `idempotencyKey` → `idempotency_key`
 * on the local surface is a breaking change to an installed package's argument
 * contract, and that is a release-train decision with a deprecation window,
 * not a parse decision. Filed as #2366. Two things this refusal does in the
 * meantime that a silent strip did not: it tells a caller which spelling to
 * use, and it makes the divergence countable instead of invisible.
 *
 * `haven_quote_x402`'s `body` is the one case where refusing REMOVES a
 * capability the silent strip was faking: the hosted surface has no field to
 * route a request payload to, so a body-bearing paywall is now honestly
 * unquotable here rather than dishonestly quotable. That is the right way
 * round — a wrong quote is worse than no quote — but it is a gap, and #2366
 * carries it.
 *
 * Deliberately NOT on the list, with the reason kept here rather than in a
 * commit message:
 *
 *   - `haven_complete_mcp_tool` — it was IN this batch until the final base
 *     re-check found a live caller for it, which is the whole reason that
 *     re-check exists. Haven's own agent-facing skill text — downloaded as
 *     `SKILL.md` from the connect success screen and auto-installed by
 *     `@haven_ai/connect` — SAID of this tool: "Pass `payment_required`,
 *     `arguments`, and `mcp_transport` verbatim from the quote/prepare
 *     result." This tool has never declared `payment_required`; the 402 is
 *     read from the stored record. So an agent following Haven's own
 *     instructions passed it, had it silently dropped, and succeeded — this
 *     issue's exact defect, live, in our own guidance.
 *
 *     **That guidance is FIXED, and the blocker has MOVED (#2363).** #2353's
 *     PR #2359 rewrote the paragraph in both byte-pinned copies
 *     (`packages/sdk/src/skill-content.ts` and its frontend twin
 *     `packages/frontend/src/lib/agent-skill-bundle.ts`): the skill now says
 *     to call this tool with `payment_id` and the signer's `payment_header`
 *     ONLY, and names `payment_required` as a field it does not take. #2359
 *     shipped the copies and deliberately did NOT ship this tool's switch, so
 *     do not read the paragraph above as "the guidance is still wrong, so we
 *     still cannot" — that premise is spent.
 *
 *     What gated the switch was ROLLOUT, and #2353's switch PR (2026-09-03)
 *     resolved it: the corrected skill shipped to npm in
 *     `@haven_ai/sdk@0.1.34-alpha.0` (2026-09-01T19:21Z, the `alpha` dist-tag
 *     that `npx @haven_ai/connect` resolves by default), which carries #2359's
 *     corrected auto-installed copy. The tool now REFUSES `payment_required`
 *     — see STRICT_INPUT_TOOLS below for the reasoning that moved it, and
 *     note the refusal covers the direct `createToolHandlers` path too,
 *     because `parseStrict` reads the same list. The residual risk — agents
 *     still carrying a pre-0.1.34 installed copy on disk — is recorded in the
 *     STRICT_INPUT_TOOLS entry and the #2353 PR. The tests that used to pin
 *     the two halves apart have been flipped to pin the switch itself:
 *     `strict-tool-input.test.ts`'s former `#2353` strip block now asserts
 *     the refusal over the same transport, and #2363's block pins the
 *     corrected skill literals the refusal presumes. Related: #2366 (converge
 *     the local and hosted argument spellings) and #2349 (batch 3).
 *
 *     Both halves of that premise are pinned, not merely written down.
 *     `packages/sdk/src/skill-content.test.ts` asserts the deleted imperative
 *     stays deleted and the correction stays present; the `#2363` block in
 *     `strict-tool-input.test.ts` re-asserts the same two literals HERE, so a
 *     revert of the skill text goes red in the suite of the file that carries
 *     this tool's input decision rather than only in the SDK's.
 *
 *     This bullet no longer argues for an exclusion — the switch landed in
 *     the same PR that resolved the rollout question, recorded below in
 *     STRICT_INPUT_TOOLS. It is kept under this heading rather than deleted
 *     so a reader reaching it from the #2312 story finds the reversal where
 *     they would look for the exclusion.
 *
 *   - `haven_get_agent`, `haven_get_allowances` — schema `{}`, decided in
 *     #2349 rather than deferred by it. Their entries in
 *     `PERMISSIVE_INPUT_TOOLS` below carry the reasoning; the short form is
 *     that a `.strict()` on `{}` changes exactly ONE observable case (a
 *     decorated no-argument call), protects nothing (the handlers take no
 *     input at all), and a supported runtime is documented decorating exactly
 *     that call.
 *
 * Every hosted tool is now on one list or the other — `STRICT_INPUT_TOOLS` or
 * `PERMISSIVE_INPUT_TOOLS` — and a tool on neither fails to compile
 * (`_everyHostedToolCarriesAnInputDecision` below) and fails
 * `strict-tool-input.test.ts`. Being permissive is a legitimate answer; not
 * having decided is not (#2349, the same rule as the `packages/**` Markdown
 * manifest, #2088).
 *
 * `haven_x402_authorize` / `haven_list_transactions` — the "one release
 * cycle" legacy aliases — are GONE rather than decided. They were defined in
 * #314 (`d0ed60a0`) and never registered: `server.ts` has iterated
 * `toolSchemas` only since that commit, `index.ts` never exported them, and
 * nothing in the repository imported them. A caller using either name has
 * received "tool not found" since #314; deleting the dead export changes no
 * observable behaviour and stops the guard below having to reason about a
 * surface that does not exist.
 *
 * The value is the `.strict()` message: a refusal a caller can act on beats a
 * bare "unrecognized key". It is also what `parseStrict` reuses, so the two
 * layers cannot drift into saying different things about the same tool.
 */
export const STRICT_INPUT_TOOLS = {
  // #2292's originating tool. Every field a reporter reaches for and this tool
  // does not declare — tx_hash, resource_url, amount, merchant_url — is one
  // Haven reads from the payment's own record. Stripping it lets a caller
  // believe it pinned the anchor when it did not.
  haven_report_x402_outcome:
    'The funding transaction, resource URL and amount are read from the payment record, ' +
    'so a report cannot be pointed at a different payment.',
  // The relay leg. Everything except which payment and which signature — the
  // amount, the recipient, the rail, the typed data that was signed — comes
  // from the stored intent. A stripped key here means relaying a signature for
  // a different question than the caller asked.
  haven_submit:
    'Amount, recipient and rail come from the stored payment intent; this tool takes only ' +
    'which payment, which signature, and (optionally) which settlement scheme that signature is for.',
  // #1307: merchant_url / tool_name / arguments / mcp_transport are OPTIONAL
  // because Haven rehydrates the stored MCP call context from payment_id, and
  // it relays the funding signature: this one moves money before it delivers.
  // A stripped key is invisible twice over — the call still succeeds, against
  // the recorded context rather than the one the caller passed.
  haven_settle_mcp_tool:
    'The MCP call context is rehydrated from payment_id when you omit it, and this tool funds before ' +
    'it delivers — an unrecognised key must not be dropped on the way to a transfer.',
  // #2353's switch (2026-09-03). The clearest rehydration case on the hosted
  // surface: payment_id, merchant_url, tool_name, arguments, mcp_transport,
  // payment_header — and since #1307 the 402 itself is rehydrated from the
  // payment record. The shipped SKILL.md USED to tell agents to pass
  // `payment_required` here (fixed by #2359, shipped to npm in
  // @haven_ai/sdk@0.1.34-alpha.0 on 2026-09-01), which is why this tool was
  // the last money-path tool left permissive: a refusal would have been a
  // hard 400 on Haven's own documented flow for every agent still carrying
  // the old auto-installed copy. That rollout window has closed; what remains
  // is agents on pre-0.1.34 copies, who now get a refusal that NAMES the key
  // and says where the value actually comes from, instead of a silent strip
  // that let them believe they had pinned the 402 they quoted.
  haven_complete_mcp_tool:
    'The merchant call context AND the 402 are rehydrated from the payment record by payment_id; ' +
    'this tool does not take payment_required — an unrecognised key must not be dropped on the way ' +
    'to a merchant call that spends against a 402 the caller never saw.',
  // ── #2348, the camelCase crossover ──────────────────────────────────────
  // Each message NAMES the local spelling, the way MCP_TRANSPORT_CASE_HINT
  // does for mcp_transport (#2282): the value of refusing here is telling a
  // caller holding `idempotencyKey` what is wrong with it, not that a key was
  // unrecognised.
  haven_send:
    'This is the HOSTED surface, which spells the key idempotency_key (snake_case). ' +
    'The local MCP (@haven_ai/mcp) spells it idempotencyKey — carrying that spelling here ' +
    'used to be dropped in silence, and the payment then reached POST /payments with no ' +
    'idempotency_key at all, so the replay contract never engaged and a retry spent twice.',
  haven_pay_mcp_tool:
    'This is the HOSTED surface, which spells the key idempotency_key (snake_case). ' +
    'The local MCP (@haven_ai/mcp) spells it idempotencyKey — carrying that spelling here ' +
    'used to be dropped in silence, and the SDK then fell back to a key DERIVED from the ' +
    "merchant quote inside a 5-minute bucket, so the caller's own replay scope was " +
    'silently replaced by a different one rather than merely lost.',
  haven_quote_x402:
    'This is the HOSTED surface. It takes url, method, headers and body. The local MCP ' +
    '(@haven_ai/mcp) additionally takes idempotencyKey — carrying it here used ' +
    'to be dropped in silence, and a body-bearing POST was then probed with an EMPTY body, ' +
    'so the quote described a different request than the one the caller meant to pay for. ' +
    'The hosted surface has no body field to route it to; quote a GET resource, or use ' +
    'haven_pay_mcp_tool for a merchant that needs a request payload.',
  haven_pay_x402_quote:
    'This is the HOSTED surface, which takes payment_required and idempotency_key ' +
    '(snake_case). The local MCP (@haven_ai/mcp) takes quote and idempotencyKey. Passing ' +
    'quote already failed loudly here, because payment_required is required — it is ' +
    'idempotencyKey that was dropped in silence, replacing the caller\'s replay scope with ' +
    'a key derived from the quote. Pass payment_required (the paymentRequired field of a ' +
    'haven_quote_x402 result) and idempotency_key.',
  // ── #2349, batch 3 — the remainder ──────────────────────────────────────
  // Same discipline as above: each message says what the tool DOES read the
  // value from, so a caller holding the refused key learns where it belongs.
  haven_sweep_delegate:
    'A sweep moves the whole stranded delegate balance back to the account it came from; ' +
    'destination and amount are re-derived by Haven from the prepared authorization, never ' +
    'read from arguments. Phase 1 takes nothing; phase 2 takes { authorization, signature } ' +
    'only — expected_auth belongs to the signer call (haven_sign_sweep_delegate), not here.',
  haven_pay:
    'This is the HOSTED surface, which takes token, amount, to and idempotency_key ' +
    '(snake_case). The SDK spells the replay key idempotencyKey — carrying that spelling here ' +
    'used to be dropped in silence, and the payment then reached POST /payments with no ' +
    'idempotency_key at all, so the replay contract never engaged and a retry spent twice. ' +
    'haven_send (asset / recipient) is a different tool, not another spelling of this one.',
  haven_quote_mcp_tool:
    'A quote is informational only and takes no cap: max_amount and max_amount_human are ' +
    'enforced by haven_pay_mcp_tool and haven_prepare_catalog_purchase against the live ' +
    'price. A cap sent here used to be dropped in silence, so the quote came back looking ' +
    'capped when nothing had checked it.',
  haven_prepare_catalog_purchase:
    'The merchant URL, tool name and tool arguments come from the catalog row that ' +
    'catalog_id names, never from arguments — a merchant_url, tool_name or arguments sent ' +
    'here used to be dropped in silence while the purchase proceeded against the catalog ' +
    'row. The cap is max_amount_human or max_amount (exactly one), and the replay key is ' +
    'idempotency_key (snake_case), not idempotencyKey.',
  haven_quote_catalog_purchase:
    'Everything about the merchant call comes from the catalog row that catalog_id names, ' +
    'and a quote takes no cap — a max_amount, tool_name or arguments sent here used to be ' +
    'dropped in silence while the quote was taken against the row.',
  haven_resume_x402_payment:
    'A resume rebuilds the merchant retry from the STORED payment (by payment_id) or from ' +
    'the resume_state you hand back verbatim — resource, amount, payee and the signed ' +
    'header are read from there, never from arguments. A payment_header, payment_required ' +
    'or merchant_url sent alongside used to be dropped in silence while the retry proceeded ' +
    'against the stored one.',
  haven_get_payment_status:
    'The status is read by payment_id alone; nothing else selects or filters it. A tx_hash, ' +
    'idempotency_key or merchant_url sent alongside used to be dropped in silence, so a ' +
    'caller could not tell the lookup had ignored it.',
  haven_get_resume_state:
    'The resume state is rehydrated by payment_id alone; nothing else selects it. Any other ' +
    'key used to be dropped in silence.',
  haven_list_receipts:
    'This list takes limit only. An offset, cursor, page, status or token filter sent here ' +
    'used to be dropped in silence and the first page came back looking filtered.',
  haven_verify_receipt:
    'Verification is offline and reads only the receipt object itself: the signer is ' +
    'recovered from receipt.authorization and compared with the delegate the receipt names. ' +
    'An expected signer, delegate or payment_id sent alongside used to be dropped in silence ' +
    '— a caller cannot pin what the receipt must say, only ask what it does say.',
  haven_discover_tools:
    'The catalog filters are category, search, rail and verified. A query, name, merchant, ' +
    'chain or limit sent here used to be dropped in silence and the FULL catalog came back ' +
    'looking filtered.',
  haven_submit_catalog_entry:
    'A submission takes resource_url (and the website honeypot, which must stay unset). A ' +
    'name, description, price, tool_name or contact sent here used to be dropped in silence ' +
    '— the directory learns everything else from the live merchant probe and the ownership ' +
    'proof, never from this call.',
} as const satisfies Partial<Record<HostedToolName, string>>

export type StrictInputToolName = keyof typeof STRICT_INPUT_TOOLS

/**
 * #2349: the hosted tools that deliberately STRIP an undeclared argument, each
 * with the reason it is here rather than above. This is the other half of the
 * decision, not an escape hatch: a tool is on exactly one of the two lists, and
 * `_everyHostedToolCarriesAnInputDecision` below refuses to compile when a new
 * `HostedToolName` is on neither. The values are documentation, not refusal
 * text — nothing on this list refuses.
 */
export const PERMISSIVE_INPUT_TOOLS = {
  // What strictness would MEAN on a `{}` schema, measured over the real
  // transport on 2026-09-02 (SDK 1.29.0, `validateToolInput`): absent
  // `arguments` is refused TODAY under both the raw shape and `.strict()`
  // (`expected object, received undefined`); `arguments: {}` passes under
  // both; only a DECORATED call — `{ random_string: "dummy" }` — differs, and
  // there strict refuses where raw strips. So `.strict()` on `{}` changes one
  // observable case, and that case cannot be a mis-pinned value: these
  // handlers are `async () =>` and read no input at all, so a stripped key
  // changes neither what is read nor what the caller can believe it pinned.
  // Meanwhile Cursor — a runtime `packages/connect` supports by name, and one
  // whose connect verification step (`runtimeVerificationInstruction`) sends
  // the user to exactly these two tools — is documented decorating
  // parameterless tools with a `random_string: "Dummy parameter for
  // no-parameter tools"` (forum.cursor.com/t/…/109840, Cursor 1.1.6, June
  // 2025; no fix recorded). A refusal here would land on the read that could
  // not have been wrong, on the first call a new user is told to make.
  haven_get_agent:
    'Schema {}: the handler reads no input, so strictness can protect nothing, and a ' +
    'supported runtime (Cursor) decorates no-argument calls with a dummy key.',
  haven_get_allowances:
    'Schema {}: the handler reads no input, so strictness can protect nothing, and a ' +
    'supported runtime (Cursor) decorates no-argument calls with a dummy key.',
} as const satisfies Partial<Record<HostedToolName, string>>

export type PermissiveInputToolName = keyof typeof PERMISSIVE_INPUT_TOOLS

/**
 * #2349: every hosted tool carries an input decision, enforced at compile time.
 *
 * Add a tool to `HostedToolName` without adding it to `STRICT_INPUT_TOOLS` or
 * `PERMISSIVE_INPUT_TOOLS` and this binding stops type-checking — its type
 * becomes `{ undecided: 'haven_new_tool' }`, which `true` is not assignable
 * to, and the error names the tool. Put it on both lists and
 * `_noHostedToolIsDecidedTwice` fails the same way. The runtime twin lives in
 * `strict-tool-input.test.ts`, because `vitest` does not type-check and a
 * guard that only one of the two instruments can see is half a guard.
 */
type UndecidedInputTool = Exclude<HostedToolName, StrictInputToolName | PermissiveInputToolName>
type DoublyDecidedInputTool = StrictInputToolName & PermissiveInputToolName
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _everyHostedToolCarriesAnInputDecision: [UndecidedInputTool] extends [never]
  ? true
  : { undecided: UndecidedInputTool } = true
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _noHostedToolIsDecidedTwice: [DoublyDecidedInputTool] extends [never]
  ? true
  : { decidedTwice: DoublyDecidedInputTool } = true

// #1547: the prose that pointed agents at the signer's initialize result
// (`capabilities.experimental[SIGNER_CAPABILITY_KEY]`) is gone — most agent
// harnesses cannot read an MCP initialize handshake, so the documented check
// is now "sign; branch on the signer's machine-readable version-mismatch
// refusal". The capability key itself stays advertised by the signer and
// echoed in signer_compatibility.signer_capability for harnesses that CAN
// read it.

// #1591: descriptions are SLIM on purpose — purpose, siblings, inputs, output
// shape, exceptional states. The shared flow guidance (structured-fields-
// first, the payment_id-only signing litany, erc7710-vs-3009 settle shapes,
// cap conventions, expiry/idempotency re-runs, signer-enforced version
// compatibility, the runtime tool-naming note from #1588, stranded-funds
// recovery) lives ONCE in the server-level instructions (server.ts) — the
// 2026-08-18 external tester measured the old repetition as "a very large
// amount of repeated text" on every tools/list. Issue archaeology stays in
// comments here, never in agent-visible strings (both properties are
// test-enforced in description-size.test.ts).

// History for maintainers: #1254/#1255 (delegation-rail typed_data_b64 pass-
// through, opaque, never re-typed), #1263/#1355 (payment_id-only signing),
// #1272/#1549 (compact responses; include_signing_payload replay), #1275/
// #1351/#1548 (cap conventions), #1307 (settle rehydrates by payment_id),
// #1308 (structured guidance fields), #1547 (signer-enforced version compat).
const PAY_DESCRIPTION = [
  'Construct a direct wallet payment inside the agent budget and return the unsigned payload for the local signer.',
  'For read-only allowance/budget questions use haven_get_allowances instead.',
  'Returns { payment_id, payload_hash, expires_at }. Sign with haven_sign — delegation-rail responses',
  'include typed_data_b64: pass it to the signer UNCHANGED as one opaque string, never re-typed —',
  'then relay with haven_submit. A payment outside the on-chain budget, recipient or expiry is declined',
  'at prepare — nothing to sign, nothing queued: ask the user to raise the budget in Haven.',
  'Haven never receives the signing key.',
].join(' ')

const SUBMIT_DESCRIPTION = [
  'Relay a delegate signature from the local signer to execute a constructed payment.',
  'Pass payment_id (from haven_pay, haven_pay_x402_quote, or a resume tool) and the signature over its',
  'payload_hash. Returns { status, tx_hash }. In decomposed x402 flows, follow with',
  'haven_x402_sign_header on the signer once funding confirms.',
  'When the quote reported settlement_scheme "erc7710", pass settlement_scheme: "erc7710" here:',
  'the signature is the settlement child, not a funding authorization, and the response returns',
  'payment_header for you to retry the merchant with — no funding tx, no header to build locally.',
].join(' ')

const PAY_MCP_TOOL_DESCRIPTION = composeDescription({
  ...sharedDescriptions.payMcpTool,
  summary:
    'Step 1 of the x402 MCP purchase flow: call a named tool on an MCP merchant that requires payment, probe the live price, and create the funding intent for the local signer to sign.',
  behavior:
    'Inputs: merchant_url (exact MCP endpoint or base URL — a non-402 miss gets one bounded same-origin discovery pass; the response echoes the resolved endpoint to reuse downstream), tool_name, arguments, and exactly ONE cap: max_amount_human (whole tokens, preferred — "no more than 1 USDC" is "1") or max_amount (atomic units). Both or neither is refused before the merchant is contacted; with no user-stated cap, quote first (haven_quote_mcp_tool) and cap at the quoted amount. ' +
    'Returns the compact quote { payment_id, payload_hash, expires_at, x402, signer_compatibility, merchant_url, tool_name, arguments, mcp_transport }; the returned amount is the authorized CEILING the merchant settles at or below — present it as the maximum. ' +
    'Sign per the response guidance (payment_id-only), then settle with haven_settle_mcp_tool. ' +
    'Exceptional states: on expiry re-run with the SAME idempotency_key; include_signing_payload=true on a re-run returns the inline signing payload for an older signer — and a merchant that repriced in between makes the signer refuse the stale copy: re-quote fresh.',
  nextActionGuidance: 'Next: the signer tool named by the response guidance, then haven_settle_mcp_tool.',
})

const QUOTE_MCP_TOOL_DESCRIPTION = composeDescription({
  summary:
    'Read the live x402 price for a named MCP merchant tool without creating any payment, approval, signature, or funding.',
  behavior:
    'Informational only — reserves nothing. Use it to tell the user the current price before choosing a cap. ' +
    'merchant_url may be exact or a base URL (one bounded same-origin discovery attempt; the response echoes the resolved endpoint).',
  nextActionGuidance:
    'Next: choose a cap (or cap at this quote) and call haven_pay_mcp_tool. Not a price reservation.',
})

// #1299 (chain-scoped catalog 404s), #1306 (guided path), #1450/#1547
// (erc7710 preference + scheme-aware response) — see git history.
const PREPARE_CATALOG_PURCHASE_DESCRIPTION = composeDescription({
  summary:
    'Step 1 of the guided catalog purchase: load one Haven catalog entry by catalog_id, run the LIVE merchant quote, verify chain/cap/rail-aware allowance, and return a ready-to-sign x402 payment.',
  selectionGuidance:
    'Prefer this over haven_pay_mcp_tool when you hold a catalog_id from haven_discover_tools. A degraded catalog row refuses and names haven_pay_mcp_tool as the manual fallback. Read-only budget questions: haven_get_allowances.',
  behavior:
    'Exactly ONE cap is REQUIRED — max_amount_human (whole tokens, preferred) or max_amount (atomic); both or neither refuses before any network call, and with no user-stated cap, quote first (haven_quote_catalog_purchase) and cap at the quoted amount. The cap is enforced against the LIVE quote before any funding intent exists. ' +
    'Returns the same compact quote shape as haven_pay_mcp_tool plus catalog fields and an allowance block { rail, sufficient, remaining_atomic, source }: an over-budget quote REFUSES here, before any payment exists and with no approval queue to fall back on. sufficient can be null with a warning when the read itself failed — the on-chain policy remains the real gate. ' +
    'The response guidance says which settlement shape you are on (erc7710 direct settlement has no funding leg and no payment_header). Catalog prices are indicative; the live quote in this response is authoritative (CATALOG_PRICE_DIFFERS warns on mismatch). An unknown catalog_id, or one curated for a different chain, refuses with 404.',
  nextActionGuidance:
    'Next: the signer tool named by the response guidance, then haven_settle_mcp_tool. On a refusal, tell the user the budget was exceeded and ask them to raise it in Haven — never re-quote, re-pay, or poll: nothing is queued.',
})

const QUOTE_CATALOG_PURCHASE_DESCRIPTION = composeDescription({
  summary:
    'Read the live x402 price for one curated catalog entry without creating any payment, approval, signature, or funding.',
  behavior:
    'Informational only. Use before haven_prepare_catalog_purchase to choose a cap — and always when the user stated no cap (cap at this quoted amount, never an invented number). Catalog prices are indicative; amount/amount_atomic here are the live merchant quote. A degraded row without MCP metadata: use haven_pay_mcp_tool manually instead.',
  nextActionGuidance:
    'Next: haven_prepare_catalog_purchase with catalog_id and exactly one cap. Not a price reservation.',
})

const COMPLETE_MCP_TOOL_DESCRIPTION = composeDescription({
  summary:
    'Final step of the decomposed x402 MCP purchase: deliver the signed merchant payment header (both x402 wire names) and return the tool result.',
  behavior:
    'Pass payment_id and payment_header (from haven_x402_sign_header); merchant_url/tool_name/arguments/mcp_transport are optional — Haven rehydrates them by payment_id. Call only after haven_submit confirmed funding. The header is a signed, single-use, amount/merchant/nonce-bound authorization — not a key. ' +
    'Exceptional states: PAYMENT_WINDOW_EXPIRED (retry_with_new_quote=true) when funding expired first; MERCHANT_REJECTED_AFTER_FUNDING means the delegate holds stranded funds — recover with haven_sweep_delegate.',
  nextActionGuidance: 'On success no further Haven tool is needed — return the merchant result to the user.',
})

const SETTLE_MCP_TOOL_DESCRIPTION = composeDescription({
  summary:
    'Fast-path final step of the x402 MCP purchase: fund and settle in one call — relay the funding signature, then deliver the merchant payment header and return the merchant tool result.',
  behavior:
    'Pass payment_id, signature, and (EIP-3009 shape only) payment_header; merchant/tool fields are optional — rehydrated by payment_id. If funding does not confirm it returns { payment_id, settled: false, funding_status } without contacting the merchant. Echoes payment_id on every outcome for reconciliation via haven_list_receipts / haven_get_payment_status. ' +
    'Exceptional states: PAYMENT_WINDOW_EXPIRED (retry_with_new_quote=true); MERCHANT_REJECTED_AFTER_FUNDING — stranded funds, recover with haven_sweep_delegate.',
  nextActionGuidance: 'On success no further Haven tool is needed — return the merchant result to the user.',
})

const QUOTE_X402_DESCRIPTION = composeDescription({
  ...sharedDescriptions.quoteX402,
  behavior:
    'Probes the merchant directly from the hosted server and parses the 402. Haven is not contacted. Returns the full quote including payment_required for haven_pay_x402_quote.',
})

const PAY_X402_QUOTE_DESCRIPTION = [
  'Step 1 of a direct x402 purchase (plain HTTP merchant, non-MCP): construct the funding step and',
  'return the unsigned hash for the local signer. Pass the payment_required from haven_quote_x402',
  'or straight from the merchant 402. Read-only budget questions: haven_get_allowances.',
  'Cap rule here: max_amount_human (preferred) or max_amount, never both; omitting BOTH accepts the',
  'quoted price as-is and the response carries cap_warning.',
  'Returns { payment_id, payload_hash, expires_at, x402, signer_compatibility } — compact by default;',
  'include_signing_payload=true on a same-idempotency_key re-run returns the inline payload for an',
  'older signer. Over-budget is declined at prepare; nothing is ever held for later approval.',
  'The signer tool named in the response guidance (haven_sign_x402) returns payment_header INLINE',
  'alongside the signature — it is a one-shot that spends its own binding building that',
  'header, so do NOT call haven_x402_sign_header afterwards; it can only refuse. Relay the',
  'signature via haven_submit, then retry the merchant YOURSELF with that payment_header,',
  'setting PAYMENT-SIGNATURE (v2); X-PAYMENT (v1) unless erc7710.',
  'Haven never talks to this merchant and never holds the key. The header is built before funding',
  'confirms, so its validity window starts at signing: retry promptly, and on',
  'PAYMENT_WINDOW_EXPIRED re-run this tool with the same idempotency_key.',
  'When the merchant advertises extra.assetTransferMethod "erc7710" and the account is on the',
  'delegation rail, this returns settlement_scheme "erc7710" instead: sign, then haven_submit with',
  'settlement_scheme "erc7710" returns the payment_header directly. No funding leg on that path.',
  // #2292, placed AFTER the erc7710 sentence and scoped explicitly (haven-reviewer NIT): sitting
  // between the 3009 retry and the erc7710 branch it read as though it applied to both. It does
  // not — an erc7710 intent has no Haven funding transaction, so the report is refused there —
  // and prose that has to be disambiguated by a downstream refusal is prose worth fixing.
  // Re-attached to #2291's corrected chain: the retry moved from haven_x402_sign_header to
  // haven_sign_x402's inline header, but it is still the AGENT's retry, which is exactly why its
  // outcome has nowhere to go without this call.
  'On the funding-leg (EIP-3009) shape ONLY, report what the merchant answered to your retry with',
  'haven_report_x402_outcome. Nothing to report on erc7710: there confirmed already means the',
  'merchant settled.',
].join(' ')

// #2145: the backend now emits nextAction=retry_original_x402_request from
// GET /payments/:id when the funding leg confirmed but no merchant response
// was ever recorded (crash recovery, 15-minute grace window;
// agent-payment-status.ts). The gate in the handler below requires that exact
// nextAction, so this tool is reachable again on purpose — the description
// tells an agent to gate on the structured field, not call this speculatively.
// #2290: the last two lines used to end at haven_x402_sign_header, with
// haven_sign as an optional aside "to re-derive a binding lost across a signer
// restart". A binding is not optional — haven_x402_sign_header requires one —
// and for a funded payment the fetch behind haven_sign was refused outright
// (409 already_executed), so the sequence this tool pointed at could not be
// completed at all. #2290 opened that gate.
// #2291: but #2290's replacement wording named the OTHER impossible order —
// haven_sign_x402, then its binding into haven_x402_sign_header. The one-shot
// spends its own binding building the header inline, so that second call can
// only refuse. Corrected here to the one-shot contract: use the inline
// payment_header. Recorded rather than silently reflowed because the same
// contradiction has now been written into this file twice.
const RESUME_X402_DESCRIPTION = [
  'Resume an authorized x402 payment: retrieve the signing context so the signer can rebuild the',
  'merchant payment header and the agent can retry the merchant.',
  'Only call this after haven_get_payment_status reports nextAction=retry_original_x402_request —',
  'that means Haven funding confirmed but no merchant response was ever recorded, typically because',
  'the process crashed between funding and the merchant retry. Any other nextAction reports a',
  'conflict instead of returning context; do not call this speculatively and do not pay again.',
  'Returns { payment_id, payment_required, x402 } in the haven_pay_x402_quote shape. Then call',
  'haven_sign_x402 with this payment_id — the funding leg is already spent, so this signs nothing',
  'new on-chain and its signature must not be re-submitted. Take payment_header from ITS result',
  'and retry the original resource_url with it. Do NOT pass its x402_binding to',
  'haven_x402_sign_header: that binding is already spent, and the call can only refuse.',
  // #2292: same obligation as the first-attempt path — a resumed retry Haven did not make is
  // just as unobservable as the original one.
  'Then report the outcome with haven_report_x402_outcome.',
  'Carries no signer_compatibility of its own; an incompatible signer refuses at signing time.',
].join(' ')

// #2292: a NEW tool rather than a mode on haven_complete_mcp_tool.
//
// The two look adjacent — both end an x402 purchase and both write the same
// two records — but they differ in the one place that matters: WHO called the
// merchant. haven_complete_mcp_tool makes the call itself, so what it writes
// is observed; this tool writes what the caller ASSERTS about a call Haven
// deliberately did not make, because on the plain-HTTP path Haven never talks
// to the merchant and never holds the key. Folding them together would put an
// observed fact and an asserted one behind one name, with a flag deciding
// which — and their arguments barely intersect (merchant_url / tool_name /
// payment_header versus outcome / merchant_status). That is the mode flag
// whose branches a caller has to learn, wearing the hat of deduplication.
// Kept terse on purpose: the "why a separate tool" reasoning above is for
// maintainers and does not belong in the served payload (#1591's per-tool
// budget, which this description sits comfortably under). What an agent needs
// is what it does, what to pass, what changes, and what it cannot do.
const REPORT_X402_OUTCOME_DESCRIPTION = [
  'Report what a plain-HTTP x402 merchant answered to a retry YOU made; Haven never contacts it, so',
  'nothing else can. Pass payment_id, outcome ("accepted" for a 2xx, else "rejected"),',
  'merchant_status, optional merchant_body. A rejection surfaces stranded funds on your next',
  'haven_get_payment_status instead of a 15-minute wait. Evidence only, your own payments only: it',
  'moves no money. Not for merchants Haven called for you — haven_complete_mcp_tool and',
  'haven_settle_mcp_tool already record what they observed.',
].join(' ')

const SWEEP_DELEGATE_DESCRIPTION = [
  'Recover stranded USDC from the delegate wallet back to the Haven wallet, gaslessly. Use when a',
  'payment failed or expired after funding, or on nextAction=sweep_stranded_funds. Two keyless phases:',
  '(1) call with no arguments — returns { status: "signature_required", authorization, expected_auth }',
  'or { status: "nothing_stranded" }; (2) sign via the signer tool haven_sign_sweep_delegate, then call',
  'again with { authorization, signature }. Returns { status: "swept", tx_hash, amount }.',
  'USDC only — stranded native ETH is not recoverable through this path.',
].join(' ')

const DISCOVER_TOOLS_DESCRIPTION = composeDescription({
  ...sharedDescriptions.discoverTools,
  nextActionGuidance:
    sharedDescriptions.discoverTools.nextActionGuidance +
    ' For an MCP entry with a spending cap in mind, prefer haven_prepare_catalog_purchase with its catalog_id.',
})

export const toolDescriptions: Record<HostedToolName, string> = {
  haven_get_agent: composeDescription(sharedDescriptions.getAgent),
  haven_get_allowances: composeDescription(sharedDescriptions.getAllowances),
  haven_sweep_delegate: SWEEP_DELEGATE_DESCRIPTION,
  haven_discover_tools: DISCOVER_TOOLS_DESCRIPTION,
  haven_submit_catalog_entry: composeDescription(sharedDescriptions.submitCatalogEntry),
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
  haven_report_x402_outcome: REPORT_X402_OUTCOME_DESCRIPTION,
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

/**
 * A registered hosted-MCP handler: one tool's `(input) => ToolPayload`.
 *
 * Named here rather than inline in `tools.ts` because the capability modules
 * of epic #2806 each contribute a slice of the same map and must all describe
 * it in the same words. The `unknown` input is deliberate: every handler
 * parses its own arguments through `tools/parsing.ts` INSIDE its failure
 * envelope, so a validation error leaves as a `ToolFailure` rather than as a
 * raw throw (#2349).
 */
export type HostedToolHandler = (input: unknown) => Promise<ToolPayload>

/**
 * A handler map over some subset of the hosted tool surface.
 *
 * `HostedToolHandlers` (no argument) is the whole surface — what
 * `createToolHandlers` returns. `HostedToolHandlers<'haven_pay' | …>` is one
 * capability module's contribution, which is what makes a slice's ownership
 * checkable at compile time instead of only at registry-assert time.
 */
export type HostedToolHandlers<N extends HostedToolName = HostedToolName> = Record<
  N,
  HostedToolHandler
>
