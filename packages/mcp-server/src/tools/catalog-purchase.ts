/**
 * #2810 — the CATALOG / QUOTE / PREPARE capability of the hosted MCP surface,
 * carved out of `tools.ts` (which stays the compatibility facade `index.ts`,
 * `server.ts`, tests and embedders import).
 *
 * Six tools, one owner:
 *
 *   catalog    haven_discover_tools, haven_submit_catalog_entry
 *   quote      haven_quote_mcp_tool, haven_quote_catalog_purchase
 *   pay        haven_pay_mcp_tool
 *   prepare    haven_prepare_catalog_purchase
 *
 * The handler bodies moved VERBATIM: names, schemas (`tools/contracts.ts`),
 * success/failure shapes, request-context behaviour and agent guidance are
 * unchanged, and so is the distinction this slice exists to hold — an
 * INFORMATIONAL quote (`haven_quote_*`) reserves no price and creates no
 * intent, while a CAPPED preparation (`haven_prepare_catalog_purchase`,
 * `haven_pay_mcp_tool`) re-quotes live and checks the required cap against the
 * option it actually selected. Scheme preference and selected-option pricing
 * are not a way around the cap: `priceSelectedOption` prices the SELECTED
 * entry, and `readMaxAmountCap` refuses when it is absent.
 *
 * DEPENDENCY RULE (epic #2806): this module imports the #2807 contract and
 * parsing seams and the #2808 shared support, and NEVER another capability
 * module. Helpers it shares with a sibling slice — `runTool`, `parseStrict`,
 * `buildAgentGuidance`, `isPendingApproval`, `buildX402SigningContext`,
 * `serializeMcpTransport` — are imported from that shared ownership, never
 * copied here.
 *
 * Two helpers it calls are NOT shared, and stay in support anyway:
 * `quoteMcpToolCall` and `getUsableCatalogMcpEntry` have this capability as
 * their only consumer, which by the epic's own rule would make them ours. The
 * argument for leaving them is recorded per-export in
 * `tools/support/shared-helper-ownership.test.ts`, not hand-waved here — in
 * short, `quoteMcpToolCall` is the wrapper around the #1271/#1301 bounded
 * same-origin discovery perimeter and moving it forks a pattern
 * `packages/mcp` also implements, and `getUsableCatalogMcpEntry`'s refusal
 * shape is pinned by #2811's resume tests, which could not import it from
 * here without breaking the dependency rule above.
 */
import {
  AgentPaymentNextAction,
  AgentPaymentWarningCode,
  HavenClient,
  HavenPaymentStateError,
  selectStandardPaymentOption,
  selectX402SettlementScheme,
  type AgentPaymentWarning,
  type X402PaymentRequired,
} from '@haven_ai/sdk'
import type { HostedToolHandlers, HostedToolName } from './contracts.js'
import { parseStrict } from './parsing.js'
import {
  priceSelectedOption,
  quoteWarnings,
  readMaxAmountCap,
  requireSettleableSelection,
} from './support/cap-price.js'
import { getUsableCatalogMcpEntry } from './support/catalog-entry.js'
import { HostedToolError, runTool } from './support/errors.js'
import { buildAgentGuidance } from './support/guidance.js'
import {
  buildX402SigningContext,
  quoteMcpToolCall,
  serializeMcpTransport,
} from './support/mcp-context.js'
import { buildMcpToolQuoteResponse, isPendingApproval } from './support/quote-response.js'

/**
 * The tools this capability owns, as a tuple so the set is data rather than a
 * comment. `satisfies` pins every entry to a real `HostedToolName`, and
 * `createToolHandlers`' `HostedToolHandlers` annotation refuses a surface
 * where a tool ends up with NO owner (TS2741 names the missing one).
 *
 * It does NOT refuse a tool owned TWICE — a key re-declared in the facade
 * literal after the spread shadows this module silently, and `tsc` exits 0 on
 * it (#2809 measured that). The disjointness of this tuple against the
 * facade's own literal is asserted in
 * `tools/support/shared-helper-ownership.test.ts`.
 */
export const CATALOG_PURCHASE_TOOLS = [
  'haven_discover_tools',
  'haven_submit_catalog_entry',
  'haven_quote_mcp_tool',
  'haven_pay_mcp_tool',
  'haven_quote_catalog_purchase',
  'haven_prepare_catalog_purchase',
] as const satisfies readonly HostedToolName[]

export type CatalogPurchaseToolName = (typeof CATALOG_PURCHASE_TOOLS)[number]

/**
 * This capability's handler contribution to `createToolHandlers`.
 *
 * The return type is keyed on the tuple above, so adding a name there without
 * a handler (or a handler without a name) is a compile error here rather than
 * a runtime registry issue discovered at server boot.
 */
export function createCatalogPurchaseHandlers(
  haven: HavenClient,
): HostedToolHandlers<CatalogPurchaseToolName> {
  return {
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
