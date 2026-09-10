/**
 * #2809 — the STATE / DIRECT-PAYMENT / RECOVERY capability of the hosted MCP
 * surface, carved out of `tools.ts` (which stays the compatibility facade
 * `index.ts`, `server.ts`, tests and embedders import).
 *
 * Ten tools, one owner:
 *
 *   state      haven_get_agent, haven_get_allowances,
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
  verifyPaymentReceipt,
  type PaymentReceipt,
  type SweepAuthorization,
} from '@haven_ai/sdk'
import type { HostedToolHandlers, HostedToolName } from './contracts.js'
import { parseStrict } from './parsing.js'
import { runTool } from './support/errors.js'
import { buildAgentGuidance } from './support/guidance.js'
import {
  delegationSignFields,
  submitErc7710WithExpiryMapping,
  submitSignatureWithExpiryMapping,
} from './support/mcp-context.js'
import { isPendingApproval } from './support/quote-response.js'

/**
 * The tools this capability owns, as a tuple so the set is data rather than a
 * comment. `satisfies` pins every entry to a real `HostedToolName`; the
 * registry's completeness twin (`assertHostedToolRegistry`) and
 * `createToolHandlers`' `Record<HostedToolName, …>` annotation between them
 * still refuse a surface where a tool ends up with no owner or two.
 */
export const STATE_DIRECT_RECOVERY_TOOLS = [
  'haven_get_agent',
  'haven_get_allowances',
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
export function createStateDirectRecoveryHandlers(
  haven: HavenClient,
): HostedToolHandlers<StateDirectRecoveryToolName> {
  return {
    haven_get_agent: async () => runTool(async () => haven.getAgentSummary()),

    haven_get_allowances: async () => runTool(async () => haven.getAllowances()),

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
        return haven.listReceipts({ limit: args.limit })
      }),

    haven_verify_receipt: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_verify_receipt', input)
        return verifyPaymentReceipt(args.receipt as PaymentReceipt)
      }),  }
}
