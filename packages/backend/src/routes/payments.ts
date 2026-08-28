import { RelayerBudgetExceededError } from '../infra/relayer-spend-guard.js'
import { FastifyInstance } from 'fastify'
import {
  claimIntentForSubmission,
  confirmSubmittedIntent,
  expireOverdueIntent,
  expireOverdueIntentsForAgent,
  expirePendingIntent,
  expirePendingIntentReturningStatus,
  failSubmittedIntent,
  findIntentForAgent,
  getIntentStatus,
  findSendIntentByIdempotencyKey,
  insertDelegationIntent,
  listIntentsForAgent,
  releaseSubmittedClaim,
  type SendIntentReplayRow,
} from '../infra/repositories/payment-intents.js'
import { userOpTypedData } from '../rails/delegation-rail.js'
import { computeHybridAccountAddress } from '../rails/hybrid-provisioning.js'
import {
  agentPaymentStatusHttpCode,
  getAgentPaymentStatus,
} from '../modules/payments/index.js'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { AgentPaymentNextAction, AgentPaymentPhase } from '../domain/agent-payment-taxonomy.js'
import { getChain, getExplorerUrl } from '../domain/chains.js'
import { getFiatValuesForTokenAmount } from '../infra/fiat-values.js'
import { formatTokenAmount, isAddress as isValidAddress, parseTokenAmount } from '@haven_ai/core'
// Evidence recording moved into the mpp module (#997); routes/payments.ts
// needs it after a delegation-rail send confirms, so it imports the module's
// public entry point (same pattern as routes/x402.ts -> modules/x402/).
import { tryRecordMachinePaymentEvidenceBaseById, mppDemoRetired } from '../modules/mpp/index.js'
import {
  deserializeUserOp,
  isSettlementChainState,
  loadExecutionRailState,
  redactVendorSecrets,
  resolveExecutionRail,
  serializeUserOp,
  sessionRailRetired,
  isRetiredRailIntent,
  allowanceModuleRailRetired,
  isRetiredAllowanceIntent,
} from '../rails/execution-rail.js'
import {
  prepareDelegationPayment,
  submitDelegationPayment,
} from '../rails/delegation-authorization.js'
import { getAgentPaymentResumeState } from '../modules/payments/index.js'
import { getPaymentReceipt, verifyPaymentReceipt } from '../modules/payments/index.js'
import { quoteFee } from '../modules/fee/index.js'
import { emitFunnelEvent } from '../infra/repositories/onboarding-funnel.js'

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

// ── Constants ─────────────────────────────────────────────────────

const PG_UNIQUE_VIOLATION = '23505'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
// ── Types ─────────────────────────────────────────────────────────

interface CreatePaymentBody {
  token: string    // e.g. "USDC.e", "xDAI", "EURe"
  amount: string   // human-readable, e.g. "25.50"
  to: string       // recipient address
  idempotency_key?: string
}

interface SignPaymentBody {
  signature: string // 0x-prefixed ECDSA signature (65 bytes)
}

interface PaymentIntentRow {
  id: string
  agent_id: string
  user_id: string
  safe_address: string
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
  /** Smart Sessions permissionId pinned at authorize time. */
  session_permission_id?: string | null
  /** Serialized prepared UserOperation for session-rail intents. */
  session_user_op?: unknown
  /** Which delegation authorized a delegation-rail intent (#829). */
  delegation_hash?: string | null
  /** Serialized prepared redemption UserOperation for delegation intents. */
  prepared_user_op?: unknown
}

// ── Helpers ───────────────────────────────────────────────────────

/** Resolve a token symbol to its config for a specific chain. */
function resolveToken(chainId: number, symbol: string) {
  const chain = getChain(chainId)
  const tokens = chain.tokens
  const upper = symbol.toUpperCase().replace('.', '')
  if (tokens[upper]) return tokens[upper]
  for (const cfg of Object.values(tokens)) {
    if (cfg.symbol.toLowerCase() === symbol.toLowerCase()) return cfg
  }
  return null
}

// ── Routes ────────────────────────────────────────────────────────

/**
 * Idempotent-replay lookup for POST /payments (#1207) — the same contract
 * /machine-payments/send carries on the same key column (migration 020).
 *
 * A key that matches an existing row returns the FIRST request's result:
 * a still-signable intent replays its original sign_data (delegation-rail
 * rows rebuild the EIP-712 payload from the stored UserOperation, the #961
 * discipline — never a fresh estimation), and anything that has progressed
 * reports its real status instead of a stale instruction.
 *
 * #2105: this used to add "a pending approval replays as 202 (a retry must not
 * open a second approval)". There is no such branch any more — #2055 deleted
 * the `approval_requests` fallback (see the note at its old site below), so no
 * replay can produce a 202 and the OpenAPI spec no longer documents one.
 *
 * A null return from a 23505 catch site means the conflicting row was ALREADY
 * terminal (or was lazily expired here) — the caller rethrows rather than
 * retrying, accepted deliberately: the window is a freshly-inserted row dying
 * within the same request, and a bounded auto-retry would mask real
 * constraint bugs. The client's own retry lands on the freed key. A key reused for a
 * DIFFERENT transfer is a 409; a stale pending row is lazily expired so the
 * key frees up (the #961 M2 lesson). Returns null when the caller should
 * create a fresh intent.
 */
async function findPaymentReplay(
  agent: AgentContext,
  idempotencyKey: string,
  requested: { tokenAddress: string; toAddress: string; amountRaw: string },
): Promise<{ code: number; body: Record<string, unknown> } | null> {
  const statusReplay = async (paymentId: string) => {
    const status = await getAgentPaymentStatus(agent, paymentId)
    if (status) {
      return { code: agentPaymentStatusHttpCode(status), body: { ...status, idempotent_replay: true } }
    }
    return {
      code: 409,
      body: { payment_id: paymentId, error: 'Payment already exists but could not be loaded', idempotent_replay: true },
    }
  }
  const mismatch = (row: { token_address: string; to_address: string; amount_raw: string }): string | null => {
    if (row.token_address.toLowerCase() !== requested.tokenAddress) return 'token'
    if (row.to_address.toLowerCase() !== requested.toAddress) return 'recipient'
    if (row.amount_raw !== requested.amountRaw) return 'amount'
    return null
  }

  const pi = await findSendIntentByIdempotencyKey(agent.id, idempotencyKey)
  if (pi) {
    const field = mismatch(pi)
    if (field) {
      return {
        code: 409,
        body: {
          payment_id: pi.id,
          status: pi.status,
          error: `idempotency_key already belongs to a payment with a different ${field}`,
        },
      }
    }
    if (pi.status !== 'pending_signature') return statusReplay(pi.id)
    if (new Date(pi.expires_at) < new Date()) {
      // Lazy-expire: the partial unique index holds the key until the status
      // flips, so a stale pending row would 23505 every fresh retry forever.
      await expirePendingIntent(pi.id, agent.id)
      return null
    }
    return { code: 201, body: await replayIntentBody(agent, pi) }
  }

  // #2055: the approval_requests idempotency-replay fallback that stood here
  // is gone with the table — a legacy queued approval can no longer be
  // replayed; only payment_intents carry the key now.
  return null
}

/** The original 201 body for a still-signable intent, rebuilt from the row. */
async function replayIntentBody(
  agent: AgentContext,
  pi: SendIntentReplayRow,
): Promise<Record<string, unknown>> {
  if (pi.execution_rail === 'delegation' && pi.prepared_user_op != null) {
    // #961: reconstruct the EXACT signing payload from the stored
    // UserOperation — a fresh estimation would be a different payload (new
    // nonce/gas), and the intent pinned this one.
    const state = deserializeUserOp(pi.prepared_user_op) as Record<string, unknown>
    const accountAddress = await computeHybridAccountAddress(pi.chain_id, {
      ownerAddress: agent.delegate_address as `0x${string}`,
    })
    return {
      payment_id: pi.id,
      status: pi.status,
      expires_at: pi.expires_at,
      idempotent_replay: true,
      sign_data: {
        hash: pi.sign_hash,
        signature_scheme: 'eip712_userop',
        typed_data: userOpTypedData(state, accountAddress as `0x${string}`, pi.chain_id),
        components: {
          account: accountAddress,
          token: pi.token_address,
          to: pi.to_address,
          amount: pi.amount_raw,
        },
        instructions:
          'Sign sign_data.typed_data with your delegate (agent) key using EIP-712 ' +
          '(signTypedData; @haven_ai/sdk does this automatically). Then POST ' +
          `/payments/${pi.id}/sign with { signature } — Haven relays it; ` +
          'your budget delegation authorizes it on-chain.',
      },
    }
  }
  return {
    payment_id: pi.id,
    status: pi.status,
    expires_at: pi.expires_at,
    idempotent_replay: true,
    sign_data: {
      hash: pi.sign_hash,
      components: {
        safe: agent.safe_address,
        token: pi.token_address,
        to: pi.to_address,
        amount: pi.amount_raw,
        payment_token: ZERO_ADDRESS,
        payment: '0',
        nonce: pi.allowance_nonce,
      },
      instructions:
        'Sign the hash with your delegate private key using raw ECDSA (not eth_sign). ' +
        'The signature must be 65 bytes: r (32) + s (32) + v (1), where v is 27 or 28.',
    },
  }
}

export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  // ── POST / — Create payment intent ──────────────────────

  app.post<{ Body: CreatePaymentBody }>('/', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    const { token, amount, to, idempotency_key } = request.body

    // 1. Validate inputs
    if (!token || typeof token !== 'string') {
      return reply.code(400).send({ error: 'Token symbol is required' })
    }
    if (!amount || typeof amount !== 'string' || isNaN(Number(amount)) || Number(amount) <= 0) {
      return reply.code(400).send({ error: 'Amount must be a positive number' })
    }
    if (!to || !isValidAddress(to)) {
      return reply.code(400).send({ error: 'Valid recipient address is required' })
    }
    if (
      idempotency_key !== undefined &&
      (typeof idempotency_key !== 'string' || idempotency_key.length === 0 || idempotency_key.length > 128)
    ) {
      return reply.code(400).send({ error: 'idempotency_key must be a non-empty string of at most 128 characters' })
    }

    // 2. Resolve token for agent's chain
    const chain = getChain(agent.chain_id)
    const tokenConfig = resolveToken(agent.chain_id, token)
    if (!tokenConfig) {
      return reply.code(400).send({
        error: `Unsupported token: ${token}`,
        supported: Object.values(chain.tokens).map((t) => t.symbol),
      })
    }

    // Token address for AllowanceModule (native = zero address)
    const tokenAddress = tokenConfig.address ?? ZERO_ADDRESS

    // 3. Convert human amount to raw units
    let amountRaw: bigint
    try {
      amountRaw = parseTokenAmount(amount, tokenConfig.decimals)
    } catch {
      return reply.code(400).send({ error: `Invalid amount for ${tokenConfig.symbol}` })
    }

    if (amountRaw <= 0n) {
      return reply.code(400).send({ error: 'Amount must be greater than zero' })
    }

    // 4. Resolve the execution rail first — the token-configuration gate is
    // rail-specific.
    //
    // ── Retired-session gate (#993) — the marking alone decides; see
    // lib/execution-rail.ts for the seam and the retirement record.
    const railState = await loadExecutionRailState(agent)

    // ── Retired-session gate (#993), BEFORE the replay lookup: a replayed key
    // must not resurrect actionable sign_data for an account the rail
    // retirement fail-closes (review finding on #1207 — /:id/sign re-checks
    // independently, but the create surface should never hand it out either).
    //
    // ── Retired-ALLOWANCE gate (#1986, epic #1440 slice 3) — same seam, same
    // fail-closed contract, same position: BEFORE the replay lookup and
    // before any chain read, so nothing is written and no allowance is read
    // for an account that can no longer spend. The legacy execution body
    // below is left VERBATIM for the deletion slices (#1987/#1988) to
    // remove; this is a runtime refusal, not a deletion.
    const earlyDecision = resolveExecutionRail({ ...railState, chainId: agent.chain_id })
    if (earlyDecision.rail === 'retired_session') {
      const retired = sessionRailRetired('account')
      return reply.code(retired.statusCode).send(retired.body)
    }
    if (earlyDecision.rail === 'retired_allowance') {
      const retired = allowanceModuleRailRetired('account')
      return reply.code(retired.statusCode).send(retired.body)
    }

    // 4a. Idempotent replay (#1207): a retried request must return the FIRST
    // request's result, never mint a second transfer or a second approval —
    // the same contract /machine-payments/send has carried since migration
    // 020, on the same key column, so agents get one mechanism, not a
    // per-route dialect. Before any chain read: a replay costs two indexed
    // lookups.
    if (idempotency_key) {
      const replay = await findPaymentReplay(agent, idempotency_key, {
        tokenAddress: tokenAddress.toLowerCase(),
        toAddress: to.toLowerCase(),
        amountRaw: amountRaw.toString(),
      })
      if (replay) return reply.code(replay.code).send(replay.body)
    }

    // #1987: the `agent_allowances` per-token policy check that stood here was
    // the LEGACY rail's gate — the delegation rail keeps no allowance row (its
    // authority is the signed budget delegation, checked below, which returns
    // its own 403 when no delegation authorizes this token/recipient). It was
    // already scoped out of the delegation rail, so with the legacy rail gone
    // it guarded nothing. Deleted rather than left as decorative defence.

    // ── Delegation rail (#829, epic #821) ────────────────────────────────
    // The agent's signed delegation IS the policy: budget (with native
    // refill), recipient and expiry are enforced ON-CHAIN by audited caveat
    // enforcers during gas estimation. An out-of-policy payment therefore
    // fails during prepare — before any state is written and before the
    // agent is asked for a signature. No coverage arithmetic, no approval
    // queue, no schedule machinery: the chain rules.
    // ── Delegation rail — the ONLY live rail (#1987) ─────────────────────
    // This used to be `if (railState.safeExecutionRail === 'delegation')` with
    // the legacy AllowanceModule flow below it. `resolveExecutionRail` returns
    // exactly `delegation | retired_session | retired_allowance` and the early
    // gate above returns for both retired answers, so reaching here IS the
    // delegation rail. Keeping the `if` would have needed an unreachable
    // terminal underneath it — the dead-line shape #1986 measured at zero
    // mutation reds and removed rather than kept.
    if (tokenAddress === ZERO_ADDRESS) {
      return reply.code(400).send({
        error: 'Native-token transfers are not supported on the delegation rail',
      })
    }
    let authorization
    try {
      authorization = await prepareDelegationPayment(
        { id: agent.id, chain_id: agent.chain_id, delegate_address: agent.delegate_address },
        tokenAddress,
        to.toLowerCase(),
        amountRaw,
      )
    } catch (err) {
      // Caveat rejection (budget/recipient/expiry) or bundler failure —
      // both land here, both leave the database untouched.
      return reply.code(502).send({
        error: 'Delegation-rail authorization failed (on-chain policy or bundler)',
        details: redactVendorSecrets(err instanceof Error ? err.message : String(err)),
      })
    }
    if (!authorization) {
      return reply.code(403).send({
        error: `Agent has no active budget delegation for ${tokenConfig.symbol} to this recipient`,
      })
    }

    let delegationIntent
    try {
      delegationIntent = await insertDelegationIntent({
        agentId: agent.id,
        userId: agent.user_id,
        safeAddress: agent.safe_address,
        chainId: agent.chain_id,
        tokenSymbol: tokenConfig.symbol,
        tokenAddress,
        toAddress: to.toLowerCase(),
        amountRaw: amountRaw.toString(),
        amountHuman: amount,
        delegateAddress: agent.delegate_address,
        allowanceNonce: 0, // AllowanceModule-only concept; unused on this rail
        signHash: authorization.prepared.userOpHash,
        executionRail: 'delegation',
        delegationHash: authorization.delegationHash,
        // #1059: direct transfers redeem the budget itself — same value,
        // written to both so consumers read ONE column across schemes.
        budgetDelegationHash: authorization.delegationHash,
        preparedUserOp: serializeUserOp(authorization.prepared.userOperation),
        sendIdempotencyKey: idempotency_key ?? null,
      })
    } catch (err) {
      // Lost the idempotency-key race with a concurrent request (migration
      // 020's partial unique index) — replay the winner (#1207).
      if (idempotency_key && (err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        const replay = await findPaymentReplay(agent, idempotency_key, {
          tokenAddress: tokenAddress.toLowerCase(),
          toAddress: to.toLowerCase(),
          amountRaw: amountRaw.toString(),
        })
        if (replay) return reply.code(replay.code).send(replay.body)
      }
      throw err
    }

    return reply.code(201).send({
      payment_id: delegationIntent.id,
      status: delegationIntent.status,
      expires_at: delegationIntent.expires_at,
      sign_data: {
        hash: authorization.prepared.userOpHash,
        signature_scheme: 'eip712_userop',
        // The account validates THIS typed data (not the bare 4337 hash).
        typed_data: authorization.prepared.signingTypedData,
        components: {
          account: authorization.prepared.delegateAccountAddress,
          token: tokenAddress,
          to: to.toLowerCase(),
          amount: amountRaw.toString(),
        },
        instructions:
          'Sign sign_data.typed_data with your delegate (agent) key using EIP-712 ' +
          '(signTypedData; @haven_ai/sdk does this automatically). Then POST ' +
          `/payments/${delegationIntent.id}/sign with { signature } — Haven relays it; ` +
          'your budget delegation authorizes it on-chain.',
      },
    })

  })

  // ── POST /:id/sign — Sign and execute ───────────────────

  app.post<{ Params: { id: string }; Body: SignPaymentBody }>(
    '/:id/sign',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const { id } = request.params
      const { signature } = request.body

      if (!signature || typeof signature !== 'string' || !signature.startsWith('0x')) {
        return reply.code(400).send({ error: 'Valid 0x-prefixed signature is required' })
      }

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
      // the bundler at submit; nothing moves. We therefore only shape-check
      // here (a local EIP-712 reconstruction would add a second, weaker
      // source of truth that could false-reject valid signatures).
      if (!/^0x[0-9a-fA-F]{100,}$/.test(signature)) {
        return reply.code(400).send({ error: 'Invalid signature format' })
      }

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
        const { txHash } = await submitDelegationPayment(
          { chain_id: intent.chain_id, delegate_address: intent.delegate_address },
          deserializeUserOp(intent.prepared_user_op),
          signature as `0x${string}`,
        )

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
        })

        if (!confirmed) {
          return reply.code(409).send({
            payment_id: id,
            status: 'submitted',
            error: 'Payment intent changed after on-chain execution',
          })
        }

        await tryRecordMachinePaymentEvidenceBaseById(id, agent.id, request.log)
        emitFunnelEvent(agent.user_id, 'first_payment_settled', { payment_id: id, rail: 'manual' })

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
          await releaseSubmittedClaim(intent.id)
          return reply.code(429).send({ payment_id: intent.id, status: 'pending_signature', error: err.message })
        }
        // 6. Failure. Session-rail (bundler) errors echo the request URL,
        // which embeds the API key — scrub before persisting or responding.
        const errorMsg = redactVendorSecrets(err instanceof Error ? err.message : String(err))
        await failSubmittedIntent(errorMsg, id, agent.id)

        return reply.code(502).send({
          payment_id: id,
          status: 'failed',
          error: 'On-chain execution failed',
          details: errorMsg,
        })
      }
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
      to: intent.to_address,
      tx_hash: intent.tx_hash,
      explorer_url: intent.tx_hash ? getExplorerUrl(intent.chain_id, 'tx', intent.tx_hash) : null,
      fee: buildResponseFee(intent),
      error_message: intent.error_message,
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
        to: intent.to_address,
        tx_hash: intent.tx_hash,
        created_at: intent.created_at,
        confirmed_at: intent.confirmed_at,
      })),
    }
  })
}
