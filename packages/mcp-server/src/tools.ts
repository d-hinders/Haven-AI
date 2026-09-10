/**
 * Hosted MCP tool HANDLERS — the #2807 compatibility facade, post-#2808.
 *
 * The tool contracts (names, schemas, input-policy decisions, descriptions,
 * payload types) live in `tools/contracts.ts`; the registration seam in
 * `tools/registry.ts`; argument parsing in `tools/parsing.ts`. The cross-tool
 * SAFETY SUPPORT (error normalization + `HostedToolError`, agent guidance and
 * purchase summaries, cap/price selection, MCP transport serialization and
 * merchant-context validation, the expiry-aware signing context, quote
 * responses and status predicates) moved to `tools/support/*` in #2808 — the
 * derived helper-to-capability mapping that justifies each placement lives in
 * `tools/support/shared-helper-ownership.test.ts`. This module keeps the
 * handler behaviour (`createToolHandlers`) and re-exports the contract
 * surface unchanged — `index.ts`, `server.ts`, tests and embedders import it
 * exactly as before, and later capability slices (#2809–#2812) move the
 * handlers OUT while this facade stays stable.
 *
 * #2809 is the first such slice: the state / direct-payment / recovery
 * handlers now live in `tools/state-direct-recovery.ts` and are composed into
 * `createToolHandlers` as a typed contribution. What is left here is the
 * catalog/quote/prepare, plain-HTTP x402 and paid-MCP completion handlers
 * that #2810–#2812 take next, plus the re-export surface.
 */
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  AgentPaymentWarningCode,
  HavenClient,
  HavenPaymentStateError,
  selectErc7710PaymentOption,
  selectStandardPaymentOption,
  type AgentPaymentWarning,
  type X402PaymentRequired,
  selectX402SettlementScheme,
  normalizePaymentRequired,
  type X402Quote,
  type X402ResumeState,
} from '@haven_ai/sdk'
import {
  type HostedToolHandlers,
} from './tools/contracts.js'
import { parseStrict, setStrictRefusalThrower } from './tools/parsing.js'
import { createStateDirectRecoveryHandlers } from './tools/state-direct-recovery.js'
import {
  CAP_WARNING_TEXT,
  priceSelectedOption,
  quoteWarnings,
  readMaxAmountCap,
  requireSettleableSelection,
} from './tools/support/cap-price.js'
import { getUsableCatalogMcpEntry } from './tools/support/catalog-entry.js'
import {
  HostedToolError,
  normalizeError,
  runTool,
} from './tools/support/errors.js'
import { buildAgentGuidance, buildPurchaseSummary } from './tools/support/guidance.js'
import {
  buildX402SigningContext,
  coerceJsonField,
  deliverMerchantPayment,
  preflightMcpPaymentHeader,
  quoteMcpToolCall,
  resolveMerchantCallContext,
  serializeMcpTransport,
  submitSignatureWithExpiryMapping,
} from './tools/support/mcp-context.js'
import {
  buildMcpToolQuoteResponse,
  isPendingApproval,
  resolveResumeState,
  wrongTool,
} from './tools/support/quote-response.js'

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
export { HostedToolError, ResolvedMerchantCallContext, signerCompatibilityNotice } from './tools/support/index.js'
export {
  createStateDirectRecoveryHandlers,
  STATE_DIRECT_RECOVERY_TOOLS,
  type StateDirectRecoveryToolName,
} from './tools/state-direct-recovery.js'

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
    // tools/support/shared-helper-ownership.test.ts is what catches it.
    ...createStateDirectRecoveryHandlers(haven),

    haven_discover_tools: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_discover_tools', input)
        const entries = await haven.discoverTools({
          category: args.category,
          search: args.search,
          rail: args.rail,
          verified: args.verified,
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
          source: entry.source,
          domain_verified: entry.domainVerified,
          verified_payable: entry.verifiedPayable,
          // Hosted surface is keyless: x402 entries start with the quote half
          // of the split flow; MCP entries take the GUIDED preflight —
          // haven_prepare_catalog_purchase runs the live quote, cap, and
          // rail-aware allowance check from just the catalog_id (#1306), and
          // the description prose already said to prefer it. #1547: this
          // structured field said haven_pay_mcp_tool while the prose said
          // prepare — and structured fields win over prose by this server's
          // own instructions, so the field steered agents off the guided path.
          // #1328: the 'mpp' rail's only-ever catalog row (the Haven MPP demo
          // resource) is delisted with the mpp_demo retirement, so this
          // fallback is unreachable today; it stays x402 rather than naming a
          // deleted tool in case a future non-demo 'mpp' rail entry appears.
          suggested_tool:
            entry.protocol === 'mcp' ? 'haven_prepare_catalog_purchase'
            : 'haven_quote_x402',
        }))
      }),

    haven_pay_mcp_tool: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_pay_mcp_tool', input)
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
          const prefetchedAgent = await agentPrefetch
          const prefetchedDelegate = prefetchedAgent?.delegateAddress

          // Both halves of the #1450 rule: the merchant must advertise erc7710
          // AND the account must be on the delegation rail. #1453's selector is
          // the single place that rule lives. A prefetch FAILURE deliberately
          // yields the 3009 path — guessing 'delegation' would build a request
          // the backend then refuses, and this tool's pre-#1456 behaviour was
          // 3009 anyway. (#2054: at an erc7710-ONLY merchant there is no 3009
          // path to yield to, so a failed prefetch — or a legacy rail — gets
          // the actionable refusal from `requireSettleableSelection` instead
          // of a "no compatible payment option" that names the wrong cause.)
          const paySelection = requireSettleableSelection(
            selectX402SettlementScheme(
              (quote.paymentRequired as X402PaymentRequired).accepts,
              { delegationRail: prefetchedAgent?.executionRail === 'delegation' },
            ),
            (quote.paymentRequired as X402PaymentRequired).accepts,
            { known: prefetchedAgent !== undefined, value: prefetchedAgent?.executionRail },
          )

          // Enforce the required price cap against the LIVE merchant price,
          // before creating any intent — funding or settlement child.
          // The catalog price is only a hint. #1351: a human cap binds to the
          // LIVE asset/decimals.
          //
          // #2051: this now runs AFTER scheme selection and prices the option
          // that will ACTUALLY be authorized, not whichever entry
          // `selectStandardPaymentOption` happened to return. See
          // `priceSelectedOption`. #2054 removed the `?? quote.accepted`
          // fallback: `requireSettleableSelection` above guarantees a non-null
          // selection, so quote, cap, and authorize all read ONE option — a
          // fallback that could name a different entry than the one authorized
          // is exactly the #2051 defect class.
          //
          // Moving it below the agent prefetch changes no error ordering: the
          // prefetch is `.then(a => a, () => undefined)`, so it cannot throw.
          const priced = priceSelectedOption(cap, paySelection.option)

          if (paySelection.scheme === 'erc7710') {
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
              // #2051: the amount ACTUALLY authorized, from the option this
              // branch selected — not the unselected standard entry's price.
              // Reporting the standard entry's number is what let a steered
              // cap bypass look like a 1 USDC purchase in the agent's own
              // logs.
              amount_atomic: prepared.settlement.amountAtomic,
              amount: priced.amount,
              token: priced.token,
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
                  // #2051: same correction as the top-level fields — the
                  // summary is what an agent surfaces to the user.
                  amount: priced.amount,
                  amount_atomic: prepared.settlement.amountAtomic,
                  token: priced.token,
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
            // #1549: the raw merchant 402 PaymentRequired is COMPACT-trimmed.
            // The fast path never reads it from here — #1355 persists it at
            // authorize and the signer fetches it by payment_id — so on every
            // purchase it was pure token cost (the largest block, repeating
            // the accepts[] the x402 block already summarises). It returns
            // under include_signing_payload=true (same #1272 escape as
            // typed_data: re-run with the SAME idempotency_key), which is what
            // an older signer/backend or the step-by-step
            // haven_x402_sign_header path uses.
            ...(args.include_signing_payload === true
              ? { payment_required: quote.paymentRequired }
              : {}),
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
                'none, re-run this tool with the SAME idempotency_key plus ' +
                'include_signing_payload=true and re-call the signer with its payment_required ' +
                'added VERBATIM, #1549), then ' +
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
              // #2101: this is a DECLINE, not a queue. next_action is the field the
              // agent contract says to follow FIRST, so it must say stop — prose
              // saying "do not wait" beside a next_action of wait_for_user_approval
              // is a payload that contradicts itself, and the field wins.
              ...buildAgentGuidance({
                nextAction: AgentPaymentNextAction.StopAndTellUser,
                nextTool: 'mcp__haven__haven_get_payment_status',
                nextArguments: { payment_id: err.paymentId ?? null },
                safeToContinue: false,
                reason:
                  'The amount exceeds the remaining budget, so the payment was declined. ' +
                  'Nothing is queued and no approval will arrive: tell the user, and ask the ' +
                  'wallet owner to raise the budget in Haven. Do NOT re-quote, re-pay, or poll.',
                summary: { payment_id: err.paymentId ?? 'unknown', status: 'pending_approval' },
              }),
            }
          }
          throw err
        }
      }),

    haven_quote_mcp_tool: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_quote_mcp_tool', input)
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
        const args = parseStrict('haven_prepare_catalog_purchase', input)
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

          // 3. Resolve the account's RAIL. A hard pre-intent refusal (#1319):
          // every check below branches on it, so a failed read cannot be
          // degraded here the way the allowance read at step 5 can.
          const agent = await agentPromise
          const rail = agent.executionRail
          const source = rail === 'delegation' ? 'active_delegations' : 'allowance_module'

          // 4. Both halves of the #1450 rule: the merchant must advertise
          // erc7710 AND the account must be on the delegation rail. #1453's
          // selector is the single place that rule lives; #1547 wired it into
          // this guided path, which was hard-wired to the 3009 funding leg —
          // the recommended catalog route forced the fallback scheme while
          // haven_pay_mcp_tool got the preferred one. Unlike that tool's
          // prefetch, the agent read here is a hard pre-intent refusal
          // (#1319), so the rail is always known by this point.
          //
          // #2051 moved this ABOVE the cap and budget checks so both can be
          // asked about the option that will actually be authorized. Nothing
          // between here and the branch talks to the merchant or creates an
          // intent, so "refused before any funds move" is unchanged; the
          // reordering only means a failing agent read now surfaces ahead of a
          // cap violation, and that read was already a hard refusal one line
          // above.
          const catalogSelection = requireSettleableSelection(
            selectX402SettlementScheme(
              (quote.paymentRequired as X402PaymentRequired).accepts,
              { delegationRail: rail === 'delegation' },
            ),
            (quote.paymentRequired as X402PaymentRequired).accepts,
            // Unlike the pay tool's prefetch, the agent read here is a hard
            // pre-intent refusal (#1319) — the rail is always known.
            { known: true, value: rail },
          )

          // 5. A cap is REQUIRED on this guided path (readMaxAmountCap above,
          // before any network call) — no cap_warning softness. Enforced
          // BEFORE any intent is created, funding or settlement child
          // (mutation-tested: reordering this after createX402Intent below
          // must fail a test). #1351: a human cap resolves against the LIVE
          // asset/decimals, never the catalog's indicative price. #2051: and
          // against the SELECTED option's asset/decimals, never the
          // unselected standard entry's — see `priceSelectedOption`.
          // #2054: no `?? quote.accepted` fallback — `requireSettleableSelection`
          // above guarantees the selection, so the cap, the budget pre-check,
          // and the authorize all read ONE option.
          const priced = priceSelectedOption(cap, catalogSelection.option)
          const authorizedAsset = catalogSelection.option.asset

          // 5b. Rail-aware allowance/budget report. A failed read NEVER fails
          // this preflight — sufficient degrades to null with a warning, and
          // the on-chain policy remains the actual gate either way.
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
            // #2051: match and compare against the SELECTED option's asset
            // and amount. This pre-check is the other client-side guard on
            // this path, and it was steerable the same way the cap was — a
            // cheap standard entry sailed past a small remaining budget while
            // an expensive erc7710 entry was what got authorized.
            const match = allowances.allowances.find(
              (a) => a.tokenAddress.toLowerCase() === authorizedAsset.toLowerCase(),
            )
            const remainingAtomic = match ? match.onchain.remaining : '0'
            allowanceBlock = {
              rail,
              sufficient: BigInt(remainingAtomic) >= BigInt(priced.amountAtomic),
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
            // `undefined` is not "optimistic", it is "not applicable", so
            // this only warns when the flag is explicitly false.
            if (rail === 'delegation' && match?.onchain.remainingIsFromChain === false) {
              warnings.push({
                code: AgentPaymentWarningCode.AllowanceReadOptimistic,
                message:
                  'The reported remaining delegation budget could not be read live from chain, so ' +
                  `${remainingAtomic} ${priced.token} atomic is the configured full budget, not a confirmed ` +
                  'live figure. The on-chain policy (the budget caveat enforcer) remains the actual ' +
                  'spend gate at redemption regardless of this report.',
              })
            }
          } catch (err) {
            allowanceBlock = { rail, sufficient: null, source }
            warnings.push({
              code: AgentPaymentWarningCode.AllowanceCheckUnavailable,
              message:
                'Could not read the active delegation budget ' +
                `for this agent (${err instanceof Error ? err.message : String(err)}). Proceeding without a pre-check — ` +
                'the on-chain policy remains the actual spend gate; this only affects the guidance shown here.',
            })
          }

          // 6. Over-budget REVERTS at prepare and no approval queue exists
          // anywhere (#1090; the last one died with #2055) — refuse BEFORE any
          // funding intent (mutation-tested: reading agent_allowances here
          // instead of the derived budgets must fail a test).
          if (rail === 'delegation' && allowanceBlock.sufficient === false) {
            throw new HostedToolError({
              code: 'DELEGATION_BUDGET_EXCEEDED',
              message:
                `The amount this purchase would authorize (${priced.amountAtomic} ${priced.token} atomic) ` +
                `exceeds the agent's remaining active delegation budget ` +
                `(${allowanceBlock.remaining_atomic} ${priced.token} atomic). ` +
                'There is no approval queue — an over-budget redemption would revert ' +
                'on-chain. Ask the wallet owner to grant or raise the budget in Haven before retrying.',
              statusCode: 403,
              nextAction: AgentPaymentNextAction.FundSafeOrRaiseAllowance,
              suggestedTool: 'haven_get_allowances',
            })
          }

          // 7. Catalog price is indicative; the live quote above is
          // authoritative — warn (never refuse) when they disagree. Computed
          // BEFORE the scheme branch: both settlement shapes carry it.
          // #2051: compared against the amount that will ACTUALLY be
          // authorized — on erc7710 that is a different accepts[] entry than
          // the quote's, so comparing the quote's would describe a price the
          // user is not being asked to pay.
          if (entry.priceAtomic && entry.priceAtomic !== priced.amountAtomic) {
            warnings.push({
              code: AgentPaymentWarningCode.CatalogPriceDiffers,
              message:
                `The catalog's indicative price (${entry.priceAtomic} atomic) differs from the live ` +
                `merchant quote (${priced.amountAtomic} ${priced.token} atomic). The live quote is authoritative.`,
            })
          }

          // 8. The scheme was selected at step 4 (#2051), so the cap and the
          // budget pre-check could both be asked about the option that will
          // actually be authorized rather than a different accepts[] entry.
          const catalogCallContext = {
            merchantUrl,
            toolName: entry.toolName,
            arguments: entry.toolArguments ?? {},
            ...(quote.mcpTransport ? { mcpTransport: quote.mcpTransport } : {}),
          }

          if (catalogSelection.scheme === 'erc7710') {
            const prepared = await haven.prepareX402Erc7710(
              quote.paymentRequired as X402PaymentRequired,
              {
                resourceUrl: merchantUrl,
                delegationRail: true,
                // #1307/#1547: persisted so settle rehydrates the merchant
                // call by payment_id — the guided path's no-state-threading
                // contract (#1305) holds on this scheme too.
                mcpCallContext: catalogCallContext,
              },
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
              // #2051: the amount ACTUALLY authorized, from the option this
              // branch selected — not the unselected standard entry's price.
              amount_atomic: prepared.settlement.amountAtomic,
              amount: priced.amount,
              token: priced.token,
              merchant_url: merchantUrl,
              tool_name: entry.toolName,
              arguments: entry.toolArguments ?? {},
              ...(quote.mcpTransport
                ? { mcp_transport: serializeMcpTransport(quote.mcpTransport) }
                : {}),
              catalog_id: entry.id,
              catalog_name: entry.name,
              catalog_price_atomic: entry.priceAtomic,
              catalog_price_display: entry.priceDisplay,
              catalog_price_is_indicative: true,
              allowance: allowanceBlock,
              ...buildAgentGuidance({
                nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
                nextTool: 'mcp__haven-signer__haven_sign',
                nextArguments: { payment_id: prepared.paymentId },
                safeToContinue: true,
                reason:
                  'Sign locally: call next_tool with next_arguments EXACTLY as given — the signer ' +
                  "fetches the settlement child itself and verifies its caveats against Haven's " +
                  'signed context (#1455) before signing. Then call haven_settle_mcp_tool with ' +
                  'payment_id and the returned signature — merchant_url/tool_name/arguments are ' +
                  'OPTIONAL there (#1307): Haven rehydrates them by payment_id. Do NOT pass ' +
                  'payment_header: on this scheme Haven assembles it at settle, so there is ' +
                  'nothing to build locally and no funding transaction to wait for.',
                summary: {
                  payment_id: prepared.paymentId,
                  status: 'pending_signature',
                  // #2051: same correction as the top-level fields.
                  amount: priced.amount,
                  amount_atomic: prepared.settlement.amountAtomic,
                  token: priced.token,
                  network: prepared.settlement.network,
                  // The child's own short expiry is the binding window here,
                  // not the intent's — no quote-expiry warning applies.
                  expires_at: undefined,
                  product: entry.name,
                },
                warnings: [
                  ...warnings,
                  ...quoteWarnings({
                    capped: cap.kind !== 'none',
                    expiresAt: undefined,
                  }),
                ],
              }),
            }
          }

          // 9. EIP-3009 bridge (the merchant does not advertise erc7710, or
          // the account is not on the delegation rail): create the funding
          // intent — IDENTICAL machinery to haven_pay_mcp_tool
          // (mcpCallContext persisted per #1307), so the signer flow from
          // here is IDENTICAL to today's: haven_sign_x402 with payment_id +
          // payment_required, then haven_settle_mcp_tool.
          const intent = await haven.createX402Intent(quote.paymentRequired as X402PaymentRequired, {
            idempotencyKey: args.idempotency_key ?? quote.idempotencyKey,
            mcpCallContext: catalogCallContext,
            // #1348: the agent was already fetched at step 4 — skip the
            // intent call's internal duplicate fetch.
            delegateAddress: agent.delegateAddress,
          })

          return {
            ...buildX402SigningContext(intent, args.include_signing_payload === true),
            // #1318 review: both sourced from the INTENT (one source of truth —
            // the quote's copies could drift on multi-option 402s), and no
            // top-level rail key: allowance.rail is the policy rail, the
            // protocol is implicit like every other success shape.
            network: intent.network,
            asset: intent.asset,
            // #1549: payment_required is compact-trimmed here exactly as on
            // haven_pay_mcp_tool above — one contract, see that comment.
            ...(args.include_signing_payload === true
              ? { payment_required: quote.paymentRequired }
              : {}),
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
                'none, re-run this tool with the SAME idempotency_key plus ' +
                'include_signing_payload=true and re-call the signer with its payment_required ' +
                'added VERBATIM, #1549), then ' +
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
              // #2101: this is a DECLINE, not a queue. next_action is the field the
              // agent contract says to follow FIRST, so it must say stop — prose
              // saying "do not wait" beside a next_action of wait_for_user_approval
              // is a payload that contradicts itself, and the field wins.
              // Legacy rail only reaches here — the delegation rail refused
              // earlier, before any intent existed.
              ...buildAgentGuidance({
                nextAction: AgentPaymentNextAction.StopAndTellUser,
                nextTool: 'mcp__haven__haven_get_payment_status',
                nextArguments: { payment_id: err.paymentId ?? null },
                safeToContinue: false,
                reason:
                  'The amount exceeds the remaining budget, so the payment was declined. ' +
                  'Nothing is queued and no approval will arrive: tell the user, and ask the ' +
                  'wallet owner to raise the budget in Haven. Do NOT re-quote, re-pay, or poll.',
                summary: { payment_id: err.paymentId ?? 'unknown', status: 'pending_approval' },
              }),
            }
          }
          throw err
        }
      }),

    haven_complete_mcp_tool: async (input) =>
      runTool(async () => {
        // #2353's switch: parseStrict, like every other strict tool's handler —
        // the transport-level registration refuses an undeclared key for MCP
        // callers, and this is the second line for an embedder that imports
        // `createToolHandlers` directly, where no MCP SDK validation runs.
        // Both layers read their refusal text from STRICT_INPUT_TOOLS.
        const args = parseStrict('haven_complete_mcp_tool', input)
        return deliverMerchantPayment(haven, args)
      }),

    haven_settle_mcp_tool: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_settle_mcp_tool', input)
        // ── #2282: the merchant-call context is resolved BEFORE anything is
        // submitted, on BOTH schemes. ──
        //
        // This tool's whole purpose is "fund AND deliver in one call", so it
        // relays the funding signature itself. The context needed for the
        // delivery half used to be resolved inside `deliverMerchantPayment`,
        // i.e. after that relay: an intent created by `haven_pay_x402_quote`
        // has no stored context (that tool receives only the raw 402 — a
        // PaymentRequired carries a resource URL but no MCP tool name and no
        // arguments, so there is nothing to store), and the caller learned so
        // only once the funding was confirmed on-chain. The check was correct
        // and it ran after the thing it would have prevented, leaving a
        // `funded_but_unsettled` intent that this tool can no longer finish —
        // a settle retry with explicit context relays funding again and gets
        // `expected pending_signature`, which reads like "your context was
        // fine". Recovery meant switching to `haven_complete_mcp_tool`.
        //
        // Resolved here, the same refusal lands while the intent is still
        // `pending_signature` and nothing has been spent, so the caller retries
        // THIS tool with explicit merchant_url/tool_name/arguments and it
        // simply works. The failure stops stranding value instead of being
        // reported sooner. Same reasoning as the erc7710 branch below: there
        // the submit burns the settlement child, which is not recoverable by
        // re-signing either.
        const merchantContext = await resolveMerchantCallContext(haven, args)
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
            { noFundingLeg: true, context: merchantContext },
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
          // Funding did not confirm. Do not deliver the merchant header —
          // return the funding status so the agent can act. Echo payment_id so
          // the agent can cross-reference the payment
          // (haven_get_payment_status / haven_list_receipts) without re-deriving it.
          const fundingPending = isPendingApproval(funding.status)
          return {
            payment_id: args.payment_id,
            funding_status: funding.status,
            funding_tx_hash: funding.txHash ?? null,
            settled: false,
            // #1308 review: the two non-confirmed states have DIFFERENT next
            // actions. `fundingPending` is the retained fail-closed branch for
            // a status no live rail emits any more (see `isPendingApproval`) —
            // it stops the agent; a transient funding state is a poll.
            ...buildAgentGuidance({
              nextAction: fundingPending
                ? AgentPaymentNextAction.StopAndTellUser
                : AgentPaymentNextAction.CheckStatusLater,
              nextTool: 'mcp__haven__haven_get_payment_status',
              nextArguments: { payment_id: args.payment_id },
              safeToContinue: !fundingPending,
              reason: fundingPending
                ? 'Funding did not complete and is not payable. Tell the user; do not re-sign or re-settle, and do not wait for an approval — none is queued.'
                : 'Funding is not confirmed yet. Poll next_tool, then finish settlement with haven_complete_mcp_tool once confirmed.',
              summary: { payment_id: args.payment_id, status: funding.status },
            }),
          }
        }
        const merchant = await deliverMerchantPayment(haven, args, funding.txHash, {
          context: merchantContext,
        })
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
        const args = parseStrict('haven_quote_catalog_purchase', input)
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
      // #2348: parsed INSIDE a failure envelope. Unlike batch 1's three, this
      // handler and haven_pay_x402_quote below parse before their `runTool`,
      // so a validation error escaped the direct-embedder path as a raw throw
      // rather than a ToolFailure. That was already true of the permissive
      // `parse` (a missing `url` threw a ZodError), but strictness makes the
      // path reachable often enough that leaving it would be a real defect.
      let args: Record<string, any>
      try {
        args = parseStrict('haven_quote_x402', input)
      } catch (err) {
        return normalizeError(err)
      }
      const init: RequestInit = {}
      if (args.method) init.method = args.method
      if (args.headers) init.headers = args.headers
      // `!== undefined`, not truthiness, matching the local surface's
      // `requestInit`: an empty-string body is a body, and a paywall that
      // varies on `POST` with no payload is a different request from one with
      // no body at all. Conflating them is the same class of error this tool
      // was refusing rather than committing. No Content-Type is inferred —
      // the caller sends `headers` for that, exactly as locally.
      if (args.body !== undefined) init.body = args.body
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
            // #2054: see buildMcpToolQuoteResponse — same field, same meaning.
            accepted_scheme: quote.acceptedScheme,
            ...(quote.acceptedScheme === 'erc7710' ? { erc7710_only: true } : {}),
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
      // #2348: see haven_quote_x402 above — same pre-`runTool` parse, same
      // normalisation, same reason.
      let args: Record<string, any>
      try {
        args = parseStrict('haven_pay_x402_quote', coerceJsonField(input, 'payment_required'))
      } catch (err) {
        return normalizeError(err)
      }
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
          // ── #2041: ONE cap assertion, against the option actually selected ──
          // This tool used to assert the cap HERE, pre-network, against
          // `selectStandardPaymentOption`. #1453 made that selector and
          // `selectErc7710PaymentOption` mutually exclusive, so a cap checked
          // before selection is a cap checked against an option that may not be
          // the one authorized — and that is wrong in BOTH directions:
          //
          //   cheap standard + expensive erc7710 -> the cap UNDER-binds, and a
          //     merchant-controlled payment_required walks straight through a
          //     stated spending limit (measured at 900 USDC against a 1 USDC
          //     cap on the sibling tools, #2051);
          //   expensive standard + cheap erc7710 -> the cap OVER-binds and
          //     refuses a purchase that was never going to cost that much,
          //     citing an amount nothing would have authorized.
          //
          // Two cap checks guarding two selectors is how that happened twice —
          // once in each direction. So the scheme is selected FIRST and the cap
          // is asserted exactly ONCE, after selection, against
          // `selection.option`. The reordering costs one read-only agent GET
          // ahead of a refusal that used to be pure; no authorize is created on
          // either path, which is the property that actually protects money.
          //
          // What still runs pre-network is the honest precondition: a cap
          // cannot be enforced against a payment_required that carries no
          // payable option of EITHER kind, because then there is no
          // merchant-authoritative amount to compare it against. That test is
          // rail-independent, so it does not need the agent.
          if (
            cap.kind !== 'none' &&
            !selectStandardPaymentOption(payReq.accepts) &&
            !selectErc7710PaymentOption(payReq.accepts)
          ) {
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
          // ── #2041: the #1450 preference rule reaches the GENERIC path ──
          // #1456 plumbed scheme selection through haven_pay_mcp_tool and
          // haven_prepare_catalog_purchase and said so in its own scope. This
          // third entry point — plain-HTTP merchants, where the catalog's real
          // merchants actually are — was never covered and hard-routed to the
          // EIP-3009 bridge. That made the merchant TRANSPORT decide the
          // settlement SCHEME, which are independent concerns, and it did so
          // invisibly to the agent.
          //
          // Both halves of the rule come from #1453's SINGLE selector — the
          // preference lives in one place and is not re-derived here: the
          // merchant must advertise extra.assetTransferMethod: 'erc7710' AND
          // the account must be on the delegation rail.
          //
          // A prefetch FAILURE deliberately yields the 3009 path. Guessing
          // 'delegation' would build a request the backend refuses, and 3009
          // is this tool's pre-#2041 behaviour anyway. The prefetch doubles as
          // createX402Intent's delegateAddress hint (#1348), so the 3009 branch
          // still makes exactly ONE agent round-trip rather than two.
          const prefetchedAgent = await haven.getAgent().then(
            (a) => a,
            () => undefined,
          )
          const selection = selectX402SettlementScheme(payReq.accepts, {
            delegationRail: prefetchedAgent?.executionRail === 'delegation',
          })

          // THE cap assertion — one, here, against whichever option the
          // selector actually chose, using that option's OWN asset/decimals
          // (#1351: a human cap converts with the decimals of the asset being
          // paid, never a different entry's). `selection` is null only when
          // nothing payable was selected at all, in which case
          // createX402Intent below raises the pre-existing
          // no-compatible-option refusal and there is nothing to cap.
          //
          // #2051 extracted the body of this check into `priceSelectedOption`
          if (selection) {
            priceSelectedOption(cap, selection.option)
          }

          if (selection?.scheme === 'erc7710') {
            const prepared = await haven.prepareX402Erc7710(payReq, {
              delegationRail: true,
              // #2041 (haven-reviewer, BLOCKING): the 3009 fallback below has
              // always passed this. Without it a retried call minted a SECOND
              // independently-signable settlement child instead of replaying
              // the first — and on this scheme the signed artifact IS spend
              // authority, not a funding step. The backend's dedup existed all
              // along (`findX402IntentByIdempotencyKey` runs before the
              // funding-shape branch; the erc7710 insert carries
              // `conflictTarget: 'x402_idempotency_key'`); it was simply never
              // invoked from here.
              ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
            })
            return {
              payment_id: prepared.paymentId,
              status: 'pending_signature',
              // Same vocabulary haven_pay_mcp_tool already returns (#1456), not
              // a parallel one — an agent reads one shape across both entry
              // points.
              settlement_scheme: 'erc7710',
              settlement: {
                scheme: 'erc7710',
                funding_leg: false,
                merchant_pay_to: prepared.settlement.merchantPayTo,
                facilitator_addresses: prepared.settlement.facilitatorAddresses,
              },
              amount_atomic: prepared.settlement.amountAtomic,
              asset: prepared.settlement.asset,
              network: prepared.settlement.network,
              resource_url: payReq.resource?.url,
              // #1275/#1351: the optional-cap nudge applies on both schemes.
              ...(cap.kind === 'none' ? { cap_warning: CAP_WARNING_TEXT } : {}),
              ...buildAgentGuidance({
                nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
                nextTool: 'mcp__haven-signer__haven_sign',
                nextArguments: { payment_id: prepared.paymentId },
                safeToContinue: true,
                reason:
                  'Sign locally: call next_tool with next_arguments EXACTLY as given — the signer ' +
                  "fetches the settlement child itself and verifies its caveats against Haven's " +
                  'signed context (#1455) before signing. Then call haven_submit with ' +
                  "settlement_scheme: 'erc7710' to receive the merchant payment_header, and retry " +
                  'the original merchant request yourself, setting PAYMENT-SIGNATURE ' +
                  '(x402 v2) to it and ONLY that name on this scheme. Do NOT call ' +
                  'haven_x402_sign_header: on this scheme Haven assembles the header and there is ' +
                  'no funding transaction to wait for.',
                summary: {
                  payment_id: prepared.paymentId,
                  status: 'pending_signature',
                  amount_atomic: prepared.settlement.amountAtomic,
                  network: prepared.settlement.network,
                  // The child's own short expiry is the binding window on this
                  // scheme, not the intent's — no quote-expiry warning applies.
                  expires_at: undefined,
                },
                warnings: quoteWarnings({
                  capped: cap.kind !== 'none',
                  expiresAt: undefined,
                }),
              }),
            }
          }

          const intent = await haven.createX402Intent(payReq, {
            idempotencyKey: args.idempotency_key,
            ...(prefetchedAgent?.delegateAddress
              ? { delegateAddress: prefetchedAgent.delegateAddress }
              : {}),
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
              // #2291: this said "relay via haven_submit and finish with
              // haven_x402_sign_header", which next_tool made impossible —
              // haven_sign_x402 is a one-shot that spends its own binding
              // building the header, so the named successor could only refuse.
              // One contract now, and it is the one the tool already implements.
              reason:
                'Sign locally: call next_tool with next_arguments EXACTLY as given (#1355: the ' +
                'signer fetches payment_required itself; only if it reports the context carried ' +
                'none, re-call with the payment_required you passed to this tool added VERBATIM). ' +
                'It returns BOTH signature and payment_header. Relay signature via haven_submit, ' +
                'then retry the original merchant URL yourself with payment_header. Do NOT call ' +
                'haven_x402_sign_header: haven_sign_x402 already spent its binding building that ' +
                'header, so that call can only refuse. The header is signed before funding ' +
                'confirms, so retry promptly.',
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
              // #2101: this is a DECLINE, not a queue. next_action is the field the
              // agent contract says to follow FIRST, so it must say stop — prose
              // saying "do not wait" beside a next_action of wait_for_user_approval
              // is a payload that contradicts itself, and the field wins.
              ...buildAgentGuidance({
                nextAction: AgentPaymentNextAction.StopAndTellUser,
                nextTool: 'mcp__haven__haven_get_payment_status',
                nextArguments: { payment_id: err.paymentId ?? null },
                safeToContinue: false,
                reason:
                  'The amount exceeds the remaining budget, so the payment was declined. ' +
                  'Nothing is queued and no approval will arrive: tell the user, and ask the ' +
                  'wallet owner to raise the budget in Haven. Do NOT re-quote, re-pay, or poll.',
                summary: { payment_id: err.paymentId ?? 'unknown', status: 'pending_approval' },
              }),
            }
          }
          throw err
        }
      })
    },

    haven_resume_x402_payment: async (input) => {
      // #2145 AMENDS #2131/#2041: the gate below requires
      // nextAction === 'retry_original_x402_request', and it now has exactly
      // one producer — the backend's status projection
      // (agent-payment-status.ts, `intentStateFor`), which emits it for a
      // confirmed eip3009 intent whose merchant leg was never reported
      // (funded-but-undelivered, the crash shape). The SDK's dead `executed`
      // → retry fallback is resolved fail-closed, so the value cannot be
      // minted client-side; this gate reads the backend's verdict verbatim.
      //
      // The #2041 reasoning below is retained because it is still true and is
      // the narrower case — it explains why erc7710 could not reach the gate
      // even while the legacy producer existed:
      //
      // #2041: its gate required a state the backend then emitted for exactly
      // one status — 'executed', meaning "the funding payment completed"
      // (agent-payment-status.ts, before #2055). erc7710 has no
      // funding payment, a successful settle leaves the intent at 'submitted'
      // (#1508), and an over-budget erc7710 authorize now refuses HTTP 403
      // delegation_budget_exceeded before an intent row is even created
      // (#2098/#2082, tightening #2023's finding — it used to return
      // pending_signature and enter no approval lifecycle) — so a fortiori no
      // erc7710 intent reaches 'executed'. Note also that the
      // resume state's `accepted` is SYNTHESIZED as a plain exact option with
      // no extra.assetTransferMethod, so a resumed quote would select 3009 by
      // construction. Left unchanged deliberately: the 3009 path through here
      // is byte-identical, and inventing an erc7710 resume would be inventing
      // a flow no state machine produces.
      // #1328: the mpp-rail redirect (haven_resume_mpp_payment) is retired —
      // a non-x402 resume_state now falls through to resolveResumeState's own
      // rail mismatch, not a "use this other tool" suggestion.
      return runTool(async () => {
        // #2349: parsed INSIDE the failure envelope. This handler parsed before
        // its `runTool`, the same embedder-path defect #2348 fixed on
        // haven_quote_x402 and haven_pay_x402_quote: a validation error
        // escaped `createToolHandlers` as a raw throw instead of a ToolFailure.
        const args = parseStrict('haven_resume_x402_payment', input)
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
        // signer can rebuild the merchant header from payment_id alone.
        // #2291: this comment used to name haven_x402_sign_header here, which
        // is the fourth place the pre-#2291 contract was written down. On this
        // path the header comes from haven_sign_x402's own result — that
        // one-shot spends its binding building it — and the description
        // constant above (RESUME_X402_DESCRIPTION) is the agent-facing
        // statement of the same thing.
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

    haven_report_x402_outcome: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_report_x402_outcome', input)
        const report = await haven.reportX402MerchantOutcome({
          paymentId: args.payment_id,
          outcome: args.outcome,
          merchantStatus: args.merchant_status,
          ...(args.merchant_body ? { merchantBody: args.merchant_body } : {}),
        })
        // Re-read rather than predict. The status this returns is the one the
        // agent would get from haven_get_payment_status on its next call, so
        // "reflected on the NEXT call" is demonstrated in the report's own
        // response instead of being asserted by the description. A status read
        // that fails must not turn a RECORDED report into a reported failure —
        // the write already happened and is not undone by a failed read.
        let status: Awaited<ReturnType<HavenClient['getPaymentStatus']>> | null = null
        try {
          status = await haven.getPaymentStatus(report.paymentId)
        } catch {
          status = null
        }
        return {
          payment_id: report.paymentId,
          outcome: report.outcome,
          recorded: report.recorded,
          // Echoed so a reconciling human can see WHICH transaction the report
          // was anchored to — and see that the agent did not choose it.
          tx_hash: report.txHash,
          resource_url: report.resourceUrl,
          ...buildAgentGuidance({
            nextAction:
              status?.nextAction ??
              (report.outcome === 'rejected'
                ? AgentPaymentNextAction.SweepStrandedFunds
                : AgentPaymentNextAction.None),
            ...(report.outcome === 'rejected'
              ? { nextTool: 'mcp__haven__haven_sweep_delegate' as const, nextArguments: {} }
              : {}),
            safeToContinue: true,
            reason:
              report.outcome === 'rejected'
                ? 'Recorded. The merchant refused the paid retry, so the funding may be stranded on ' +
                  'the delegate wallet — recover it with haven_sweep_delegate. Do NOT pay again for ' +
                  'the same purchase.'
                : 'Recorded. The purchase is complete and no longer reads as undelivered; no further ' +
                  'Haven tool is needed.',
            summary: {
              payment_id: report.paymentId,
              status: status?.status ?? 'confirmed',
            },
          }),
          phase: status?.phase ?? null,
        }
      }),

    haven_submit_catalog_entry: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_submit_catalog_entry', input)
        const submission = await haven.submitCatalogEntry(args.resource_url, {
          ...(args.website ? { website: args.website } : {}),
        })
        return {
          id: submission.id,
          verify_token: submission.verifyToken,
          status: submission.status,
        }
      }),
  }
}
