import { RelayerBudgetExceededError } from '../infra/relayer-spend-guard.js'
import { FastifyInstance } from 'fastify'
import {
  bookSubmittedOutcomePending,
  claimIntentForSubmission,
  confirmSubmittedIntent,
  expireOverdueIntent,
  expireOverdueIntentsForAgent,
  expirePendingIntent,
  expirePendingIntentReturningStatus,
  failSubmittedIntent,
  findIntentForAgent,
  getIntentStatus,
  listIntentsForAgent,
  releaseSubmittedClaim,
} from '../infra/repositories/payment-intents.js'
import { getDirectSignContext } from '../modules/payments/index.js'
// #4760 (epic #4759 slice 1): the `POST /` create flow lives in the payments
// module now. The route reads the request, calls `createPayment`, and sends
// the decided response it returns — nothing else. `resolveToken` moved with
// it (the module cannot import the route layer, #994) and comes back through
// the same barrel for `GET /:id` and `POST /:id/sign`.
import {
  createPayment,
  resolveToken,
  type CreatePaymentBody,
} from '../modules/payments/index.js'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { AgentPaymentNextAction, AgentPaymentPhase, AgentPaymentRail } from '../domain/agent-payment-taxonomy.js'
import { getExplorerUrl } from '../domain/chains.js'
import { getFiatValuesForTokenAmount } from '../infra/fiat-values.js'
import {
  isSignatureRejectedRevert,
  isAccountValidationFailedRevert,
  isPeriodBudgetRevert,
  isTransferCapRevert,
  boundFailureMessage,
  refuse,
} from '../modules/payments/index.js'
import { formatTokenAmount } from '@haven_ai/core'
// Evidence recording moved into the mpp module (#997); routes/payments.ts
// needs it after a delegation-rail send confirms, so it imports the module's
// public entry point (same pattern as routes/x402.ts -> modules/x402/).
import { tryRecordMachinePaymentEvidenceBaseById, mppDemoRetired } from '../modules/mpp/index.js'
// #4533: a direct payment never gets a `machine_payment_evidence` row (the
// rail gate refuses it), so the evidence hook above cannot feed it. The
// settlement path fires the accounting feed itself — fire-and-forget, exactly
// like the evidence hook: it can never block, delay or fail the transfer.
import { feedSettledPaymentBestEffort } from '../modules/accounting/index.js'
import {
  deserializeUserOp,
  isSettlementChainState,
  redactVendorSecrets,
  sessionRailRetired,
  isRetiredRailIntent,
  allowanceModuleRailRetired,
  isRetiredAllowanceIntent,
} from '../rails/execution-rail.js'
import { SubmittedUserOpFailedError } from '../rails/delegation-rail.js'
import { submitDelegationPayment } from '../rails/delegation-authorization.js'
import { readRemainingBudget } from '../infra/chain/delegation-budget-reader.js'
import { recordSponsoredUserOpGas, sponsoredLegOf } from '../modules/payments/index.js'
import { getAgentPaymentResumeState } from '../modules/payments/index.js'
import { getPaymentReceipt, verifyPaymentReceipt } from '../modules/payments/index.js'
import { quoteFee } from '../modules/fee/index.js'
import { toCanonicalAddress } from '../modules/transactions/index.js'
import { emitFirstPaymentSettled } from '../infra/repositories/onboarding-funnel.js'
// #3618: these two stay as DIRECT imports — the revert classification below
// (the sign route's catch) re-reads live state itself and deliberately does
// NOT read the #3616 resolver: the task-budget revert confirms against
// `findTaskBudgetForAgent`, the period revert against
// `selectActiveDelegationByHash` (single-hash read).
import { findForAgent as findTaskBudgetForAgent } from '../infra/repositories/task-budgets.js'
import { selectActiveDelegationByHash } from '../infra/repositories/delegation-budgets.js'
import { checkTaskBudgetCap, taskBudgetExceededBody } from '../modules/task-budgets/index.js'

/**
 * Surface the platform fee on a payment result so it's never silently collected
 * (#386 acceptance). Dark while the fee module is disabled — `amount` is "0" and
 * `applied` is false — but the field is always present so agents see it the
 * moment fees go live.
 */
function buildResponseFee(intent: PaymentIntentRow) {
  let gross = 0n
  try { gross = BigInt(intent.amount_raw) } catch { gross = 0n }
  const quote = quoteFee({
    paymentId: intent.id,
    rail: 'direct',
    grossAtomic: gross,
    token: intent.token_symbol,
    userId: intent.user_id,
  })
  const tokenConfig = resolveToken(intent.chain_id, intent.token_symbol)
  return {
    amount: quote.feeAtomic === 0n ? '0' : formatTokenAmount(quote.feeAtomic, tokenConfig?.decimals ?? 18),
    token: quote.feeToken,
    basis_points: quote.basisPoints,
    applied: !quote.isZero,
  }
}

// ── Types ─────────────────────────────────────────────────────────

interface SignPaymentBody {
  signature: string // 0x-prefixed ECDSA signature (65 bytes)
}

interface PaymentIntentRow {
  id: string
  agent_id: string
  user_id: string
  account_address: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_raw: string
  amount_human: string
  delegate_address: string
  allowance_nonce: number
  sign_hash: string
  signature: string | null
  tx_hash: string | null
  status: string
  error_message: string | null
  created_at: string
  signed_at: string | null
  submitted_at: string | null
  confirmed_at: string | null
  expires_at: string
  /** Execution rail pinned at authorize time; null = legacy AllowanceModule (#745). */
  execution_rail?: string | null
  /** Which delegation authorized a delegation-rail intent (#829). */
  delegation_hash?: string | null
  /** Serialized prepared redemption UserOperation for delegation intents. */
  prepared_user_op?: unknown
}

// ── Routes ────────────────────────────────────────────────────────
export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  // ── POST / — Create payment intent ──────────────────────

  app.post<{ Body: CreatePaymentBody }>('/', { config: moneyPathRateLimit }, async (request, reply) => {
    // #4760 (epic #4759 slice 1): the create flow lives in
    // `modules/payments/create-payment.ts`. The route reads the request, calls
    // the module, and sends the decided response it returns — the module never
    // sees a Fastify object, so a test can call it without `app.inject`.
    const decided = await createPayment({
      agent: request.agent as AgentContext,
      body: request.body,
      log: request.log,
    })
    return reply.code(decided.code).send(decided.body)
  })

  // ── POST /:id/sign — Sign and execute ───────────────────

  app.post<{ Params: { id: string }; Body: SignPaymentBody }>(
    '/:id/sign',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const { id } = request.params
      const { signature } = request.body

      // #3031: the `0x`-prefix + hex + minimum-length shape check moved to
      // the request schema (`^0x[0-9a-fA-F]{100,}$` — the rung's exact
      // floor, corrected from the spec's stricter `{130}` so 100–129-hex
      // shapes the route always accepted stay accepted). The signature's
      // VALIDITY is deliberately not checked here at all: the account's own
      // EIP-1271/4337 validation at submit is the real validator (note
      // below), so there is nothing between the schema and that.

      // 1. Load intent
      const intent = await findIntentForAgent(id, agent.id)

      if (!intent) {
        return reply.code(404).send({ error: 'Payment intent not found' })
      }

      // Check status
      if (intent.status !== 'pending_signature') {
        return reply.code(409).send({
          error: `Payment intent is ${intent.status}, expected pending_signature`,
          status: intent.status,
        })
      }

      // #993: the retired check comes BEFORE the expiry flip — an expired
      // session intent previously got a status write on a path whose contract
      // is 410-with-nothing-written (review finding on #1120).
      if (isRetiredRailIntent(intent.execution_rail)) {
        const retired = sessionRailRetired('intent')
        return reply.code(retired.statusCode).send(retired.body)
      }

      // #1328 (review finding on #1339): a PRE-EXISTING mpp_demo intent must
      // not remain executable through this generic sign path after the
      // retirement — historical rows stay readable, never actionable. Same
      // 410-with-nothing-written contract as the session-rail gate above,
      // and BEFORE the expiry flip for the same #1120 reason.
      if (intent.payment_rail === 'mpp_demo' || intent.source === 'mpp_demo') {
        const retired = mppDemoRetired()
        return reply.code(retired.statusCode).send(retired.body)
      }

      // #1986: the same contract for the AllowanceModule rail — a pending
      // intent authorized before that slice landed must not still execute
      // after it. Before the expiry flip, for the #1120 reason above.
      //
      // #1987 UPDATE — read this before assuming the gate is now decorative.
      // When #1986 wrote this, the comment tracked three call sites of
      // `executeAllowanceTransfer`. There are now ZERO: this slice deleted
      // the function, the legacy branch below it, `modules/x402/
      // legacy-authorize.ts`, and the legacy bodies in `modules/mpp/
      // {authorize,send}.ts`. The gate is NOT redundant as a result — it is
      // what makes the deletion safe. Every intent below this line is treated
      // as delegation-rail (its `sign_hash`/raw-ECDSA sibling is gone), so
      // removing this refusal would not resurrect a legacy transfer, it would
      // feed a legacy row to the delegation submit path. Fail-closed here
      // stays the honest answer, and the mutation for it is in
      // `routes/__tests__/allowance-rail-retired.test.ts`.
      //
      // Placed AFTER the mpp_demo gate deliberately: an mpp_demo intent is
      // also `execution_rail = null`, so this predicate would swallow it and
      // answer with the wider Safe-rail message. Both refuse; the narrower,
      // more informative rule should be the one that speaks.
      if (isRetiredAllowanceIntent(intent.execution_rail)) {
        const retired = allowanceModuleRailRetired('intent')
        return reply.code(retired.statusCode).send(retired.body)
      }

      // Check expiry
      if (new Date(intent.expires_at) < new Date()) {
        await expirePendingIntent(id, agent.id)
        return reply.code(410).send({ error: 'Payment intent has expired' })
      }

      // 2. Verify the signature.
      //
      // #1987: the legacy branch is gone. Every non-delegation intent was
      // already refused above — `isRetiredRailIntent` takes `session_key`,
      // `isRetiredAllowanceIntent` takes everything that is neither
      // `delegation` nor `session_key` (including the `null` that legacy
      // inserts left, which is most of that population), so an intent that
      // reaches this line is pinned to the delegation rail. The `sign_hash` +
      // raw-ECDSA `recoverSigner` scheme died with the AllowanceModule.

      // Delegation-rail intents sign the prepared UserOperation with the
      // ACCOUNT's EIP-712 scheme, which the delegate smart account itself
      // validates in `validateUserOp`. That on-chain check IS the signature
      // verification — strictly stronger than a local recover, and it cannot
      // drift from the account's own rules. A bad signature is rejected by
      // the bundler at submit; nothing moves. The shape check the first
      // sentence refers to is the request schema's since #3031 (the rung
      // that stood here answered `Invalid signature format`); a local
      // EIP-712 reconstruction would add a second, weaker source of truth
      // that could false-reject valid signatures.

      // #1482: refuse a MISDIRECTED erc7710 intent before anything is claimed.
      //
      // `prepared_user_op` is a SHARED column meaning different things per
      // settlement scheme — a UserOp on the 3009 bridge, a `{ child, budget }`
      // delegation chain on erc7710 (#946/#1454) — and both also set
      // `delegation_hash`, so the presence checks below cannot tell them apart.
      //
      // ORDER IS THE POINT, and the first draft of this guard got it wrong:
      // placed after `claimIntentForSubmission`, the throw landed in the catch
      // that calls `failSubmittedIntent`, so a misdirected call BURNED the
      // intent. `POST /x402/:id/settle` requires `pending_signature`, so a
      // burned intent could never be retried on the endpoint that would have
      // worked — a refusal that destroys the thing it refuses. The sibling #946
      // guard in `modules/x402/settle.ts` gets this right for the mirror case:
      // check before mutating, answer 409, let the client retry correctly.
      if (
        intent.execution_rail === 'delegation' &&
        intent.prepared_user_op != null &&
        isSettlementChainState(deserializeUserOp(intent.prepared_user_op))
      ) {
        return reply.code(409).send({
          error:
            'This intent settles via erc7710 direct settlement, not a UserOperation. Its signed ' +
            `child belongs to POST /x402/${id}/settle, which assembles the merchant header. ` +
            'Nothing was claimed — the intent is still signable there.',
        })
      }

      // 3. Atomically claim the pending intent before any on-chain execution.
      const claimed = await claimIntentForSubmission(signature, id, agent.id)

      if (!claimed) {
        const expiredNow = await expireOverdueIntent(id, agent.id)

        if (expiredNow) {
          return reply.code(410).send({ error: 'Payment intent has expired' })
        }

        const status = await getIntentStatus(id, agent.id)
        return reply.code(409).send({
          error: `Payment intent is ${status}, expected pending_signature`,
          status,
        })
      }

      // 4. Execute on-chain — on the rail the intent was authorized for.
      try {
        // Replay the exact prepared redemption whose hash the agent signed;
        // only the signature is stamped in. The caveat enforcers authorize it
        // on-chain — no owner, relayer, or Haven key signs anything.
        if (intent.prepared_user_op == null || !intent.delegation_hash) {
          throw new Error('delegation-rail intent is missing its prepared UserOperation state')
        }
        // #3837: record the sponsored UserOp's gas cost — best-effort,
        // awaited-and-swallowed (a recording failure never fails a
        // payment), and OUTSIDE the confirmSubmittedIntent booking flow
        // (this sits on the submit seam, before any booking runs).
        const submission = await submitDelegationPayment(
          { chain_id: intent.chain_id, delegate_address: intent.delegate_address },
          deserializeUserOp(intent.prepared_user_op),
          signature as `0x${string}`,
        )
        await recordSponsoredUserOpGas({
          paymentIntentId: id,
          agentId: agent.id,
          userId: intent.user_id ?? agent.user_id,
          chainId: intent.chain_id,
          leg: sponsoredLegOf(intent.payment_rail),
          outcome: 'confirmed',
          userOpHash: submission.userOpHash,
          txHash: submission.txHash,
          actualGasUsed: submission.actualGasUsed,
          actualGasCost: submission.actualGasCost,
        })
        const { txHash } = submission

        const fiatValues = await getFiatValuesForTokenAmount(
          intent.token_symbol,
          intent.amount_human,
        )

        // 5. Success
        const confirmed = await confirmSubmittedIntent({
          txHash,
          intentId: id,
          usdValue: fiatValues.usd,
          eurValue: fiatValues.eur,
          agentId: agent.id,
          sekValue: fiatValues.sek,
        })

        if (!confirmed) {
          return reply.code(409).send({
            payment_id: id,
            status: 'submitted',
            error: 'Payment intent changed after on-chain execution',
          })
        }

        await tryRecordMachinePaymentEvidenceBaseById(id, agent.id, request.log)
        // #4533: the evidence hook above is a no-op for a direct payment (the
        // rail gate refuses it), so the underlag is fed from here instead. The
        // entry is built from `payment_intents` itself; the outside-address
        // filter lives in that SQL, so an internal transfer is simply not fed.
        // Fire-and-forget: settlement never waits on an accounting push.
        feedSettledPaymentBestEffort(agent.user_id, id)
        emitFirstPaymentSettled(id)

        return reply.send({
          payment_id: id,
          status: 'confirmed',
          tx_hash: txHash,
          chain_id: intent.chain_id,
          explorer_url: getExplorerUrl(intent.chain_id, 'tx', txHash),
          token: intent.token_symbol,
          amount: intent.amount_human,
          to: intent.to_address,
        })
      } catch (err) {
        // #717: over-budget = refused before ANY broadcast. This route claims
        // the intent to 'submitted' before executing (step 3), so release the
        // claim or the row is stuck unretryable forever — the one place a 429
        // would otherwise be WORSE than the old burn-to-failed (#1119 review B1).
        if (err instanceof RelayerBudgetExceededError) {
          // #2945: the sponsorship budget refused before broadcast — recorded
          // fire-and-forget; `releaseSubmittedClaim` and the 429 are unchanged.
          // #3053: through the shared choke point. The claim release stays
          // BEFORE the return — refuse() records, it does not release claims.
          const refused = refuse(
            reply.code(429).send({ payment_id: intent.id, status: 'pending_signature', error: err.message }),
            {
              userId: agent.user_id,
              agentId: agent.id,
              chainId: intent.chain_id,
              tokenSymbol: intent.token_symbol,
              amountAtomic: intent.amount_raw,
              accountAddress: intent.account_address,
              merchantTo: intent.to_address,
              resourceUrl: intent.x402_resource_url ?? intent.payment_resource_url ?? null,
              reason: 'relayer_budget',
              source: 'redeem',
              detail: { error_code: 'relayer_budget_exceeded' },
            },
          )
          await releaseSubmittedClaim(intent.id)
          return refused
        }
        // #3837: a POST-SEND failure still burned sponsored gas — record it
        // before the booking split, covering BOTH variants:
        // `included_reverted` carries the receipt's `actualGasCost` on the
        // widened error; `receipt_unconfirmed` has no known cost (recorded
        // cost-NULL). Pre-send bundler rejections are NOT recorded — the op
        // never entered the mempool, so nothing was sponsored. Same
        // awaited-and-swallowed rule as the success path.
        if (err instanceof SubmittedUserOpFailedError) {
          await recordSponsoredUserOpGas({
            paymentIntentId: id,
            agentId: agent.id,
            userId: intent.user_id ?? agent.user_id,
            chainId: intent.chain_id,
            leg: sponsoredLegOf(intent.payment_rail),
            outcome: err.outcome,
            userOpHash: err.userOpHash,
            txHash: null,
            actualGasUsed: null,
            actualGasCost: err.actualGasCost,
          })
        }
        // 6. Failure — CLASSIFIED first (#3564). Session-rail (bundler) errors
        // echo the request URL, which embeds the API key — scrub before
        // persisting or responding.
        const errorMsg = redactVendorSecrets(err instanceof Error ? err.message : String(err))
        // Bound ONCE, above every arm (#3564 review round 2): redaction is
        // not a length bound — a viem/bundler message can still carry full
        // callData/ABI after scrubbing — and every body that answers
        // `details` (the outcome-pending one included) must carry the
        // bounded text, never the raw redacted error.
        const boundedMessage = boundFailureMessage(errorMsg)
        // #3564: the receipt-unconfirmed variant of SubmittedUserOpFailedError
        // means the UserOp was SENT and MAY have landed (the funds may have
        // moved). Booking that `failed` would record a funds-moved payment as
        // failed forever, so the row is left `submitted` — status reads
        // "outcome pending" (phase payment_submitted, next_action
        // check_status_later) — and the userOpHash is stored for the
        // submission reconciler (modules/payments/submission-reconciler.ts),
        // which resolves the row from the bundler's receipt: landed+succeeded
        // → confirmed with its tx_hash; landed+reverted or never seen within
        // the bounded window → failed with the cause. The booking is a CAS on
        // the open submit; if the row is no longer one (a concurrent settle
        // won, the claim was already resolved), no booking happens and the
        // generic failure body below still answers THIS call — the row's
        // truth is whatever won the race.
        if (err instanceof SubmittedUserOpFailedError && err.outcome === 'receipt_unconfirmed') {
          await bookSubmittedOutcomePending({ userOpHash: err.userOpHash, intentId: id, agentId: agent.id })
          return refuse(
            reply.code(502).send({
              payment_id: id,
              status: 'submitted',
              error: 'On-chain submission outcome unknown',
              error_code: 'submission_outcome_unknown',
              message:
                `The payment was submitted (UserOperation ${err.userOpHash}) but its on-chain outcome ` +
                'is not known yet — it may have moved the funds. Do not create a new payment for this ' +
                'payment_id: poll haven_get_payment_status for it — Haven reconciles this payment from ' +
                'the chain, and this status becomes the real outcome.',
              user_op_hash: err.userOpHash,
              details: boundedMessage,
            }),
            null,
          )
        }
        // Every KNOWN failure — the `included but reverted` variant of
        // SubmittedUserOpFailedError (the op landed and reverted, so no funds
        // moved) and every pre-send bundler rejection — is terminal: book
        // `failed` BEFORE classifying (the classification below describes a
        // row that is already terminal; nothing here is retryable).
        await failSubmittedIntent(errorMsg, id, agent.id)
        // #3494: a typed `error_code` + cause class on the 502, instead of
        // one untyped "On-chain execution failed" for everything a bundler
        // can throw after this route already claimed the intent to
        // 'submitted'. Unlike the create-time pre-checks (#3500/#3503), the
        // branches below run against an intent ALREADY FAILED (booked above)
        // — there is nothing left to retry on this payment_id whatever the
        // cause, so every branch here answers 502 (the row read nothing
        // retryable), never the create route's non-retryable 403; `message`
        // is what differs per cause. No ledger row either way — the comment
        // this replaced already established that this is the
        // on-chain/bundler FAILURE answer, booked on the intent row, not a
        // policy refusal the ledger owns.
        // #3564 composed over this: the outcome-UNKNOWN variant never reaches
        // here (the booking split above returned first — it books the row
        // outcome-pending and the submission reconciler, not this route,
        // resolves it), so `haven_get_payment_status` IS truthful on this
        // seam now. What remains below classifies the KNOWN failures, and is
        // still reachable for the pre-send bundler simulation rejections
        // (AA2x codes) that arrive as generic errors. (`boundedMessage` is
        // computed above the booking split, so the outcome-pending arm can
        // bound its `details` too.)

        // #3494 review round 1 (S1): AA24 is the one AA2x code this backend
        // can attribute to the signer. There is no live budget or chain
        // state to re-read — the fix is a new signer, on a NEW payment,
        // never a resubmit of this payment_id (the signature is already
        // spent: the intent is 'failed', and `/:id/sign` only ever accepts
        // 'pending_signature').
        if (isSignatureRejectedRevert(err)) {
          return refuse(
            reply.code(502).send({
              payment_id: id,
              status: 'failed',
              error: 'The account rejected this signature during on-chain validation',
              error_code: 'signature_rejected',
              message:
                'The delegate account rejected this signature during validation (AA24 signature error). ' +
                'Update the signer and sign a NEW payment — this payment_id is already failed and cannot ' +
                'be retried with the same or a corrected signature.',
              details: boundedMessage,
            }),
            null,
          )
        }

        // #3494 review round 1 (S1): every OTHER AA2x validation failure —
        // a real `validateUserOp` rejection, but not evidence the SIGNATURE
        // is wrong (AA20 account not deployed, AA21 didn't pay prefund,
        // AA22 expired or not due, AA23 validateUserOp reverted for an
        // unrelated reason, AA25 invalid account nonce, AA26 over
        // verificationGasLimit). Deliberately does not name the signer —
        // `message` carries the AA code in its bounded `details` so a
        // human can diagnose it, but the agent-facing instruction is only
        // "create a new payment", never "update the signer".
        if (isAccountValidationFailedRevert(err)) {
          return refuse(
            reply.code(502).send({
              payment_id: id,
              status: 'failed',
              error: 'The account rejected this payment during on-chain validation',
              error_code: 'account_validation_failed',
              message:
                'The delegate account rejected this payment during validation. This payment_id is already ' +
                'failed and cannot be retried — create a new payment. See details for the on-chain reason.',
              details: boundedMessage,
            }),
            null,
          )
        }

        // #3494 review round 1 (S2): classification below reads the DB
        // (`findTaskBudgetForAgent`/`selectActiveDelegationByHash`) and the
        // chain (`checkTaskBudgetCap`/`readRemainingBudget`) to confirm a
        // revert against LIVE state, never the revert text alone. Any of
        // those reads failing must fall through to the generic answer below
        // — never a 500, and never losing the original on-chain cause.
        try {
          // A transfer-cap revert on a task-budget payment is that task
          // budget's cap, confirmed the same way the create-route catch
          // confirms it (#3500) — re-read the enforcer's own spent figure
          // before answering, never on the revert text alone (the same
          // enforcer also carries a budget delegation's lifetime cap).
          // Deliberately `sub_budget_id` is NOT checked here: a sub-budget's
          // own transfer-cap revert has no re-read path on this route (its
          // cap sits on the grant, not a row this catch can look up by the
          // intent alone) — it falls through to the generic body below,
          // unclassified, rather than guessing.
          if (intent.task_budget_id && isTransferCapRevert(err)) {
            const taskBudgetRow = await findTaskBudgetForAgent(intent.task_budget_id, agent.id)
            if (taskBudgetRow) {
              const check = await checkTaskBudgetCap({
                chainId: intent.chain_id,
                delegationHash: taskBudgetRow.delegation_hash,
                maxAtomic: taskBudgetRow.max_atomic,
                amountAtomic: BigInt(intent.amount_raw ?? '0'),
              })
              const tokenConfig = resolveToken(intent.chain_id, intent.token_symbol)
              // `=== 'exceeded'` deliberately, never `!== 'fits'`: `fits`
              // (the payment is covered after all — a race the chain
              // resolved in the agent's favour) and `unreadable` (the chain
              // read failed; the enforcer's revert stands unconfirmed) must
              // BOTH fall through to the generic body, not be folded into
              // "exceeded" by a looser check.
              if (check.outcome === 'exceeded' && tokenConfig) {
                return refuse(
                  reply.code(502).send({
                    payment_id: id,
                    status: 'failed',
                    ...taskBudgetExceededBody({
                      taskBudgetId: taskBudgetRow.id,
                      tokenSymbol: intent.token_symbol,
                      amountHuman: intent.amount_human,
                      amountAtomic: intent.amount_raw ?? '0',
                      remainingAtomic: check.remainingAtomic.toString(),
                      remainingHuman: formatTokenAmount(check.remainingAtomic, tokenConfig.decimals),
                      maxAtomic: check.maxAtomic.toString(),
                    }),
                  }),
                  null,
                )
              }
            }
          }

          // The period budget's own revert (#3503) — a payment that raced
          // past the create-time pre-check, or the pre-check read failed
          // open — confirmed the same way: a fresh read of the SAME
          // delegation this intent redeemed (`budget_delegation_hash`),
          // never the revert text alone.
          if (isPeriodBudgetRevert(err) && intent.budget_delegation_hash) {
            const delegationRow = await selectActiveDelegationByHash(agent.id, intent.budget_delegation_hash)
            if (delegationRow) {
              const read = await readRemainingBudget(
                intent.chain_id,
                delegationRow.delegation_json,
                intent.amount_raw ?? '0',
              )
              if (read.fromChain) {
                const remainingAtomic = BigInt(read.remainingAtomic)
                const amountRaw = BigInt(intent.amount_raw ?? '0')
                const tokenConfig = resolveToken(intent.chain_id, intent.token_symbol)
                if (remainingAtomic < amountRaw && tokenConfig) {
                  const shortfallAtomic = amountRaw - remainingAtomic
                  return refuse(
                    reply.code(502).send({
                      payment_id: id,
                      status: 'failed',
                      error:
                        `This payment of ${intent.amount_human} ${intent.token_symbol} exceeded the agent's ` +
                        "remaining budget for this period by the time it was signed. There is no approval " +
                        'queue on the delegation rail — ask the wallet owner to grant or raise the budget in ' +
                        'Haven, or wait for the period to reset, then sign a NEW payment.',
                      error_code: 'delegation_budget_exceeded',
                      phase: AgentPaymentPhase.InsufficientFunds,
                      next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
                      // This route also relays the EIP-3009 funding leg
                      // (`POST /x402/authorize` names it in its sign_data
                      // instructions), so the rail is whichever one this
                      // intent actually is — never a hardcoded 'direct'.
                      rail: intent.payment_rail ?? intent.source ?? AgentPaymentRail.Direct,
                      chain_id: intent.chain_id,
                      token: intent.token_symbol,
                      // #3494 review round 1 (S2): matches the create-time
                      // body (`periodBudgetRefusal` above), which also
                      // carries `asset`.
                      asset: intent.token_address,
                      amount: intent.amount_human,
                      amount_atomic: intent.amount_raw,
                      remaining: formatTokenAmount(remainingAtomic, tokenConfig.decimals),
                      remaining_atomic: remainingAtomic.toString(),
                      shortfall: formatTokenAmount(shortfallAtomic, tokenConfig.decimals),
                      shortfall_atomic: shortfallAtomic.toString(),
                      recipient: intent.to_address,
                    }),
                    null,
                  )
                }
              }
            }
          }
        } catch (classificationErr) {
          // A DB or chain failure WHILE classifying is not the original
          // cause — log it and fall through to the generic answer below,
          // never a 500, and never masking `err` (the real on-chain
          // failure) with this secondary one.
          request.log.warn(
            { err: classificationErr },
            'sign-failure classification raised; falling back to the generic answer',
          )
        }

        // Everything else: a bundler/transport failure this route cannot
        // name more precisely. The bounded message replaces the old
        // unbounded `details` — a viem/bundler error can carry its full
        // callData or ABI in `.message`, which must never ride a response
        // wholesale (`redactVendorSecrets` only strips vendor credentials,
        // not length).
        return refuse(
          reply.code(502).send({
            payment_id: id,
            status: 'failed',
            error: 'On-chain execution failed',
            error_code: 'onchain_execution_failed',
            message: boundedMessage ?? 'On-chain execution failed',
            details: boundedMessage,
          }),
          null,
        )
      }
    },
  )

  // ── GET /:id/sign-context — byte-free signing handoff for a DIRECT
  // delegation-rail intent (#3271, the direct sibling of #1263's x402 route)
  // ──────────────────────────────────────────────────────────────────────
  // Read-only: re-serves the stored delegation-rail signing payload so the
  // LOCAL SIGNER can fetch exact bytes by payment_id instead of the agent
  // re-emitting a multi-KB EIP-712 payload by hand. `GET /x402/:id/
  // sign-context` keeps answering its 409 for a direct payment_id with the
  // same error_code and the same typed_data_b64 instruction (it only gains a
  // pointer to this route), and this route 409s an x402/MPP intent the same
  // way — old signers still get the refusal they key on. All checks and the rebuild live in the module
  // (`getDirectSignContext`).
  app.get<{ Params: { id: string } }>(
    '/:id/sign-context',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const result = await getDirectSignContext(agent, request.params.id)
      return reply.code(result.code).send(result.body)
    },
  )

  // ── GET /:id/resume_state — Rehydrate protocol resume state ─────────

  /**
   * GET /payments/:id/resume_state
   *
   * Reconstructs the serializable x402/MPP resume-state bundle for a payment
   * intent or approval request owned by this agent. This returns stored payment
   * context only; it never signs, executes, relays, or expands authority.
   */
  app.get<{ Params: { id: string } }>('/:id/resume_state', async (request, reply) => {
    const agent = request.agent as AgentContext
    const { id } = request.params
    const result = await getAgentPaymentResumeState(agent, id)

    if (!result.status) {
      return reply.code(404).send({ error: 'Payment or approval request not found' })
    }

    if (result.status.status === 'expired') {
      return reply.code(410).send({
        error: result.error ?? 'Payment approval expired and cannot be resumed',
        error_code: result.errorCode,
        payment_id: result.status.payment_id,
        rail: result.status.rail,
        status: result.status.status,
      })
    }

    if (!result.resumeState) {
      // 422 instead of 409 specifically for "this rail is documented as a
      // valid AgentPaymentRail value but the resume-state surface doesn't
      // currently rehydrate it." Generic 409 stays for other "cannot resume
      // right now" cases (incomplete context, wrong status).
      const code = result.errorCode === 'rail_not_resumable' ? 422 : 409
      return reply.code(code).send({
        error: result.error ?? 'Payment cannot be resumed',
        error_code: result.errorCode,
        payment_id: result.status.payment_id,
        rail: result.status.rail,
        status: result.status.status,
      })
    }

    return reply.send(result.resumeState)
  })

  // ── GET /:id — Payment status ───────────────────────────

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const agent = request.agent as AgentContext
    const { id } = request.params

    const intent = await findIntentForAgent(id, agent.id)

    if (!intent) {
      return reply.code(404).send({ error: 'Payment intent not found' })
    }

    let status = intent.status

    if (status === 'pending_signature' && new Date(intent.expires_at) < new Date()) {
      const expiredStatus = await expirePendingIntentReturningStatus(id, agent.id)
      status = expiredStatus ?? status
    }

    return {
      payment_id: intent.id,
      status,
      chain_id: intent.chain_id,
      token: intent.token_symbol,
      amount: intent.amount_human,
      // #3307: Haven-owned addresses are EIP-55 checksummed at the read
      // boundary, the same rule as the receipt, payment status and the
      // transactions feed (#3129). Storage stays lowercase.
      to: toCanonicalAddress(intent.to_address),
      tx_hash: intent.tx_hash,
      explorer_url: intent.tx_hash ? getExplorerUrl(intent.chain_id, 'tx', intent.tx_hash) : null,
      fee: buildResponseFee(intent),
      // #3494: bounded at this read — the stored value is already scrubbed of
      // vendor secrets (`redactVendorSecrets`, written at `failSubmittedIntent`
      // time) but not length-capped, and a viem/bundler failure can carry its
      // full callData or ABI in `.message`.
      error_message: boundFailureMessage(intent.error_message),
      created_at: intent.created_at,
      signed_at: intent.signed_at,
      submitted_at: intent.submitted_at,
      confirmed_at: intent.confirmed_at,
      expires_at: intent.expires_at,
    }
  })

  // ── GET /:id/receipt — verifiable proof bundle for a settled payment ──

  app.get<{ Params: { id: string } }>('/:id/receipt', async (request, reply) => {
    const agent = request.agent as AgentContext
    const receipt = await getPaymentReceipt(request.params.id, agent.id)
    if (!receipt) {
      return reply.code(404).send({ error: 'No settled payment found for this id' })
    }
    // Self-verify so the response states the proof status; the bundle is also
    // verifiable independently of Haven (recover the signer from authorization).
    const verification = verifyPaymentReceipt(receipt)
    return { receipt, verification }
  })

  // ── GET / — List payment intents for this agent ─────────

  app.get('/', async (request) => {
    const agent = request.agent as AgentContext

    await expireOverdueIntentsForAgent(agent.id)

    const intents = await listIntentsForAgent(agent.id)

    return {
      payments: intents.map((intent) => ({
        payment_id: intent.id,
        status: intent.status,
        token: intent.token_symbol,
        amount: intent.amount_human,
        to: toCanonicalAddress(intent.to_address), // #3307
        tx_hash: intent.tx_hash,
        created_at: intent.created_at,
        confirmed_at: intent.confirmed_at,
      })),
    }
  })
}
