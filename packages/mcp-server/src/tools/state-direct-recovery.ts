/**
 * #2809 — the STATE / DIRECT-PAYMENT / RECOVERY capability of the hosted MCP
 * surface, carved out of `tools.ts` (which stays the compatibility facade
 * `index.ts`, `server.ts`, tests and embedders import).
 *
 * Ten authority reads plus the #3126 sufficiency check — one owner:
 *
 *   state      haven_get_agent, haven_get_allowances,
 *              haven_check_funds (#3126),
 *              haven_get_payment_status, haven_get_resume_state
 *   direct     haven_send, haven_pay, haven_submit
 *   recovery   haven_sweep_delegate
 *   receipts   haven_list_receipts, haven_verify_receipt
 *
 * The handler bodies moved VERBATIM: names, schemas (`tools/contracts.ts`),
 * success/failure shapes, request-context behaviour and agent guidance are
 * unchanged, and so are the four behaviours this slice carries —
 * direct-payment idempotency (#1207), the keyless signing handoff
 * (`delegationSignFields`, #1254), `haven_submit`'s scheme validation and
 * expiry mapping (#2041), and `haven_sweep_delegate`'s two-phase
 * prepare/relay authorization with its below-floor refusal (#700).
 *
 * DEPENDENCY RULE (epic #2806): this module imports the #2807 contract and
 * parsing seams and the #2808 shared support, and NEVER another capability
 * module. Every helper it calls that a sibling slice also calls —
 * `runTool`, `buildAgentGuidance`, `isPendingApproval`, `parseStrict`,
 * `submitSignatureWithExpiryMapping`, `delegationSignFields` — is imported
 * from that shared ownership, never copied here; the derived mapping and its
 * enforcement live in `tools/support/shared-helper-ownership.test.ts`.
 */
import {
  AgentPaymentNextAction,
  HavenApiError,
  HavenClient,
  HavenPaymentStateError,
  resolveTokenFromAddress,
  verifyPaymentReceipt,
  type PaymentReceipt,
  type SweepAuthorization,
} from '@haven_ai/sdk'
import type { HostedToolHandlers, HostedToolName } from './contracts.js'
import { parseStrict } from './parsing.js'
import { runTool, HostedToolError } from './support/errors.js'
import { buildAgentGuidance, refusalNextStep } from './support/guidance.js'
import { atomicToDisplay, humanToAtomic, readMaxAmountCap } from './support/cap-price.js'
import {
  delegationSignFields,
  submitErc7710WithExpiryMapping,
  submitSignatureWithExpiryMapping,
} from './support/mcp-context.js'
import { isPendingApproval } from './support/quote-response.js'

/**
 * The tools this capability owns, as a tuple so the set is data rather than a
 * comment. `satisfies` pins every entry to a real `HostedToolName`, and
 * `createToolHandlers`' `HostedToolHandlers` annotation refuses a surface
 * where a tool ends up with NO owner (TS2741 names the missing one).
 *
 * It does NOT refuse a tool owned TWICE, and the difference matters to the
 * slices after this one. A key written into the residual literal in `tools.ts`
 * after `...createStateDirectRecoveryHandlers(haven)` silently shadows the
 * spread: TS1117 does not reach across a spread, and no key is excess because
 * both are `HostedToolName`. Measured (haven-reviewer, #2809) — a duplicate
 * `haven_pay` in the facade compiled clean, and only the behavioural tests
 * caught it, because that mutation's body diverged. A stale duplicate with an
 * IDENTICAL body would pass every check in the tree. So the disjointness of
 * each capability's tuple against the facade's own literal is asserted
 * directly, in `tools/support/shared-helper-ownership.test.ts`.
 */
export const STATE_DIRECT_RECOVERY_TOOLS = [
  'haven_get_agent',
  'haven_get_allowances',
  'haven_check_funds',
  'haven_sweep_delegate',
  'haven_send',
  'haven_pay',
  'haven_submit',
  'haven_get_payment_status',
  'haven_get_resume_state',
  'haven_list_receipts',
  'haven_verify_receipt',
] as const satisfies readonly HostedToolName[]

export type StateDirectRecoveryToolName = (typeof STATE_DIRECT_RECOVERY_TOOLS)[number]

/**
 * This capability's handler contribution to `createToolHandlers`.
 *
 * The return type is keyed on the tuple above, so adding a name there without
 * a handler (or a handler without a name) is a compile error here rather than
 * a runtime registry issue discovered at server boot.
 */
const TOKEN_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

/**
 * #3213: resolve a token SYMBOL to the contract address of this agent's own
 * allowance for it. `haven_get_agent` and `haven_get_allowances` hand the
 * agent `tokenSymbol` beside `tokenAddress`, so the symbol is what a cold
 * agent has in hand; the backend's coverage read wants the address. Exactly
 * one allowance carrying the symbol (case-insensitive) resolves; none, or
 * more than one (the same symbol on two chains), refuses with the address as
 * the remedy and `haven_get_allowances` as the tool that lists them.
 */
async function resolveTokenAddressFromAllowances(haven: HavenClient, symbol: string): Promise<string> {
  const { allowances } = await haven.getAllowances()
  const wanted = symbol.toLowerCase()
  const matches = allowances.filter((allowance) => allowance.tokenSymbol.toLowerCase() === wanted)
  if (matches.length === 1) return matches[0].tokenAddress
  const known = allowances.map((allowance) => `${allowance.tokenSymbol} (${allowance.tokenAddress})`)
  throw new HostedToolError({
    code: 'INVALID_INPUT',
    message:
      matches.length === 0
        ? `token "${symbol}" is not the symbol of any allowance this agent holds` +
          (known.length > 0 ? ` (it holds: ${known.join(', ')})` : ' (it holds none)') +
          '. Nothing was read from any chain. Re-send token as the 0x contract address — ' +
          'haven_get_allowances lists each allowance with its address.'
        : `token "${symbol}" names ${matches.length} allowances of this agent (${matches
            .map((allowance) => allowance.tokenAddress)
            .join(', ')}), so the symbol alone does not say which one to check. Nothing was read ` +
          'from any chain. Re-send token as the 0x contract address of the one you mean.',
    statusCode: 400,
    nextStep: refusalNextStep({
      nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
      nextTool: 'haven_get_allowances',
      nextArguments: {},
    }),
  })
}

export function createStateDirectRecoveryHandlers(
  haven: HavenClient,
): HostedToolHandlers<StateDirectRecoveryToolName> {
  return {
    haven_get_agent: async () => runTool(async () => haven.getAgentSummary()),

    haven_get_allowances: async () => runTool(async () => haven.getAllowances()),

    // #3126 — the sufficiency check. The hosted handler asks the BACKEND's
    // rail-aware coverage read (haven.checkFunds → GET
    // /machine-payments/balance-coverage); it never reads a chain itself —
    // the hosted server has no RPC configuration and the chain ask lives
    // behind the agent-authenticated route. The amount arrives in the cap
    // spelling (#1351) and reuses that contract's validators verbatim; the
    // token symbol comes from Haven's own registry so the human display
    // matches the rest of the surface.
    haven_check_funds: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_check_funds', input)
        const cap = readMaxAmountCap(args, {
          required: true,
          // #3213: this tool spends nothing, so its no-cap refusal names the
          // check, not a merchant call.
          uncappedRefusal: 'An amount is REQUIRED for the sufficiency check.',
        })
        // #3213: `token` is the contract address every other read reports
        // beside the symbol — or the SYMBOL itself, resolved against this
        // agent's own allowances (the tokens it may spend). A symbol that
        // resolves to no allowance, or to more than one, refuses with the
        // ADDRESS as the remedy; the atomic-units remedy below is for an
        // address the registry cannot convert, never for a symbol.
        const tokenAddress = TOKEN_ADDRESS_PATTERN.test(args.token)
          ? args.token
          : await resolveTokenAddressFromAllowances(haven, args.token)
        const token = resolveTokenFromAddress(tokenAddress)
        // Same conversion contract as the pay tools' caps (#1351): a human
        // amount is interpreted through the decimals of the token the
        // ADDRESS resolves to, never a guess; an unresolvable token or an
        // over-precise human amount refuses here, before the coverage read.
        let maxAmountAtomic: string
        if (cap.kind === 'none') {
          // Unreachable while required:true (readMaxAmountCap refuses
          // both-or-neither before returning 'none'); kept exhaustive so the
          // type never silently grows a fourth variant.
          throw new HostedToolError({
            code: 'INVALID_INPUT',
            message: 'An amount is required: pass max_amount_human (whole tokens) or max_amount (atomic).',
            statusCode: 400,
            nextStep: refusalNextStep({
              nextAction: AgentPaymentNextAction.StopAndTellUser,
              nextTool: null,
              nextToolOmittedReason: 'the user has to decide before anything is called again',
            }),
          })
        } else if (cap.kind === 'human') {
          if (!token) {
            throw new HostedToolError({
              code: 'MAX_AMOUNT_UNCONVERTIBLE',
              message:
                `max_amount_human ("${cap.value}") cannot be applied: Haven does not recognise ` +
                `token ${tokenAddress}, so the number of atomic units in one token is unknown and ` +
                'any conversion would be a guess. Nothing was read from any chain. Re-send the ' +
                'amount as max_amount in atomic units.',
              statusCode: 400,
              nextStep: refusalNextStep({
                nextAction: AgentPaymentNextAction.StopAndTellUser,
                nextTool: null,
                nextToolOmittedReason: 'the user has to decide before anything is called again',
              }),
            })
          }
          const atomic = humanToAtomic(cap.value, token.decimals)
          if (atomic === null) {
            throw new HostedToolError({
              code: 'MAX_AMOUNT_UNCONVERTIBLE',
              message:
                `max_amount_human ("${cap.value}") carries more decimal places than ` +
                `${token.symbol} supports (${token.decimals}). Haven refuses rather than silently ` +
                'change the amount. Nothing was read from any chain. Round the amount to ' +
                `${token.decimals} decimal places, or send an exact max_amount in atomic units.`,
              statusCode: 400,
              nextStep: refusalNextStep({
                nextAction: AgentPaymentNextAction.StopAndTellUser,
                nextTool: null,
                nextToolOmittedReason: 'the user has to decide before anything is called again',
              }),
            })
          }
          maxAmountAtomic = atomic.toString()
        } else {
          maxAmountAtomic = cap.value
        }
        const coverage = await haven.checkFunds({
          token: tokenAddress,
          amountAtomic: maxAmountAtomic,
        })
        const amountDisplay = token
          ? cap.kind === 'human'
            ? cap.value
            : atomicToDisplay(maxAmountAtomic, token.decimals)
          : `${maxAmountAtomic} (atomic; unknown decimals)`
        return {
          covered: coverage.covered,
          ...(coverage.coverageError ? { coverage_error: coverage.coverageError } : {}),
          chain_id: coverage.chainId,
          token: token?.symbol ?? coverage.tokenSymbol,
          token_address: coverage.tokenAddress,
          checked_amount: amountDisplay,
          checked_amount_atomic: coverage.checkedAmountAtomic,
          budget_remaining_atomic: coverage.budgetRemainingAtomic,
          ...(coverage.budgetRemainingIsFromChain !== undefined
            ? { budget_remaining_is_from_chain: coverage.budgetRemainingIsFromChain }
            : {}),
          next_step:
            coverage.covered === false
              ? 'The budget is backed by an empty account — stop and tell the user the funds are missing rather than attempting the payment.'
              : coverage.covered === null
                ? 'The chain read failed: treat this as unverifiable, not as absence. Retry shortly or proceed knowing the payment may fail on-chain.'
                : 'The checked amount is held. Spend AUTHORITY is a separate question — budget_remaining_atomic above is the permitted figure; ask haven_get_allowances for the full per-token breakdown.',
        }
      }),

    haven_sweep_delegate: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_sweep_delegate', input)

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

    haven_send: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_send', input)
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
        const args = parseStrict('haven_pay', input)
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
        const args = parseStrict('haven_submit', input)
        // #2041: the erc7710 branch, for the GENERIC plain-HTTP flow. The MCP
        // flow's equivalent lives in haven_settle_mcp_tool, which also CALLS
        // the merchant; a plain-HTTP merchant is retried by the agent itself,
        // so this surface stops at handing back the header.
        //
        // The sequence is inverted relative to 3009, which is why it branches
        // here rather than inside submitSignatureWithExpiryMapping: there the
        // signature funds the delegate EOA and a funding transaction has to
        // confirm; here it is the settlement child and there is no funding
        // transaction to relay, wait for, or later sweep.
        if (args.settlement_scheme === 'erc7710') {
          // #2041 (haven-reviewer, SHOULD-FIX): route this through the SAME
          // expiry mapping the 3009 relay uses. The settlement child's own
          // expiry is the binding window on this scheme and it is the SHORTEST
          // one in the system, so an expired settle is MORE likely here, not
          // less — leaving it as a raw error was the wrong asymmetry. The
          // mapping is scheme-agnostic (it keys on rail 'x402' + an expired
          // status behind a 410), so it applies unchanged.
          const paymentHeader = await submitErc7710WithExpiryMapping(
            haven,
            args.payment_id,
            args.signature,
          )
          return {
            payment_id: args.payment_id,
            settlement_scheme: 'erc7710',
            // 'submitted' is the EXPECTED end state on this scheme, not a
            // transient one (#1508): the merchant redeems the [child, budget]
            // chain afterwards, so Haven never broadcasts a transaction of its
            // own and there is no tx_hash to report.
            status: 'submitted',
            tx_hash: null,
            funding_tx_hash: null,
            payment_header: paymentHeader,
            ...buildAgentGuidance({
              // The shared vocabulary's value for "retry the merchant" (#1308).
              // Its own doc comment mentions resuming, so the reason below says
              // explicitly that no resume call is involved here:
              // haven_resume_x402_payment recovers a funded-but-undelivered
              // eip3009 payment (#2145), a state erc7710 cannot enter — it has
              // no funding leg — and nextTool is deliberately omitted because
              // the next step is the agent's own HTTP retry, not a Haven tool.
              nextAction: AgentPaymentNextAction.RetryOriginalX402Request,
              // #3101 (decision 3): the omission is stated, never silent.
              nextTool: null,
              nextToolOmittedReason:
                'the next step is your own HTTP retry of the merchant with the payment_header above, not a Haven tool',
              safeToContinue: true,
              reason:
                'Retry the ORIGINAL merchant request yourself, setting PAYMENT-SIGNATURE ' +
                '(x402 v2) to this payment_header, and ONLY that header name on this scheme. ' +
                'Do NOT call ' +
                'haven_x402_sign_header: on this scheme Haven ' +
                'assembled the header, there is nothing to build locally, and there is no funding ' +
                'transaction to wait for or sweep — the merchant pulls from the treasury directly. ' +
                'Do NOT call haven_resume_x402_payment either: nothing is pending, and that tool ' +
                'resumes user-approved FUNDING payments, which this scheme does not have.',
              summary: { payment_id: args.payment_id, status: 'submitted' },
            }),
          }
        }
        const result = await submitSignatureWithExpiryMapping(
          haven,
          args.payment_id,
          args.signature,
        )
        return { status: result.status, tx_hash: result.txHash ?? null }
      }),

    haven_get_payment_status: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_get_payment_status', input)
        // #1310/#1311: shared with packages/mcp's haven_get_payment_status
        // handler — see HavenClient.getPaymentStatusWithPostPurchaseAllowance
        // in @haven_ai/sdk for the single home of this "settled x402 only"
        // attach logic (was duplicated verbatim in both packages).
        return haven.getPaymentStatusWithPostPurchaseAllowance(args.payment_id)
      }),

    haven_get_resume_state: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_get_resume_state', input)
        return haven.getResumeState(args.payment_id)
      }),

    haven_list_receipts: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_list_receipts', input)
        // #3128: the page object, not a bare array — total / hasMore /
        // nextCursor are what let the agent tell "none" from "cut here".
        return haven.listReceiptsPage({ limit: args.limit, cursor: args.cursor })
      }),

    haven_verify_receipt: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_verify_receipt', input)
        return verifyPaymentReceipt(args.receipt as PaymentReceipt)
      }),
  }
}
