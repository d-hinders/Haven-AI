/**
 * Delegation-rail (#830, epic #821) x402 authorize orchestration — DIRECT
 * settlement. Extracted verbatim from `routes/x402.ts`'s authorize handler:
 * scheme routing (#946), the #961 hardening (hourly cap, one-shot refusal,
 * idempotent replay), the EIP-3009 funding-leg fallback, and erc7710
 * settlement-child construction. Behavior and ordering were unchanged from the
 * pre-#996 route until #2082 added the erc7710 remaining-budget pre-check —
 * the one deliberate behavioural difference, and a refusal that arrives
 * earlier rather than a refusal that did not exist (see its comment below).
 */
import { randomUUID } from 'node:crypto'
import { signX402ExpectedContext, x402PayerContextFields, x402PayerWireFields } from '../../infra/chain/x402-binding-signer.js'
import { findX402IntentByIdempotencyKey } from '../../infra/repositories/x402-authorizations.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import { redactVendorSecrets } from '../../rails/execution-rail.js'
import { selectDelegation, prepareDelegationPayment } from '../../rails/delegation-authorization.js'
import { computeHybridAccountAddress, ensureHybridDeployed } from '../../rails/hybrid-provisioning.js'
import { RelayerBudgetExceededError } from '../../infra/relayer-spend-guard.js'
import {
  buildSettlementDelegation,
  typedDataDigest,
} from './x402-delegation.js'
import { serializeUserOp } from '../../rails/execution-rail.js'
import { insertMachineIntent as createPaymentIntent } from '../../infra/repositories/payment-intents.js'
import { readRemainingBudget } from '../../infra/chain/delegation-budget-reader.js'
import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  AgentPaymentRail,
} from '../../domain/agent-payment-taxonomy.js'
import { formatTokenValue } from '../../domain/tokens.js'
import { type ResolvePaymentTokenResult } from '../../domain/payment-token.js'
import { agentHourlyX402CapExceeded, normaliseAddress, ZERO_ADDRESS } from './helpers.js'
import { deriveFundingShape, validateDelegationSchemeShape } from './scheme-selection.js'
import { delegationReplay } from './replay.js'
import type { X402HandlerResult, X402McpCallContextInput } from './types.js'

type ResolvedToken = Extract<ResolvePaymentTokenResult, { ok: true }>

export interface DelegationAuthorizeInput {
  agent: AgentContext
  url: string
  payTo: string
  merchantPayTo?: string
  amountRaw: bigint
  amountHuman: string
  category?: string
  idempotencyKey?: string
  maxTimeoutSeconds?: number
  signature?: string
  settlementScheme?: string
  facilitatorAddresses?: string[]
  network: string
  tokenConfig: ResolvedToken['tokenConfig']
  tokenAddress: string
  /** #1307: optional MCP merchant-call context, persisted for settle-leg rehydration. */
  mcpCallContext?: X402McpCallContextInput
  /** #1355: optional full 402 PaymentRequired, persisted for sign-leg rehydration. */
  paymentRequired?: Record<string, unknown>
}

export async function runDelegationAuthorize(input: DelegationAuthorizeInput): Promise<X402HandlerResult> {
  const {
    agent, url, payTo, merchantPayTo, amountRaw, amountHuman, category, idempotencyKey,
    maxTimeoutSeconds, signature, settlementScheme, facilitatorAddresses, network, tokenConfig, tokenAddress,
    mcpCallContext, paymentRequired,
  } = input

  if (tokenAddress === ZERO_ADDRESS) {
    return { code: 400, body: { error: 'Native-token x402 is not supported on the delegation rail' } }
  }

  // ── Scheme routing (#946) ────────────────────────────────────────────
  // erc7710 direct settlement is the default and the destination; the
  // EIP-3009 two-leg below is a deliberate, temporary interop bridge for
  // facilitators that cannot redeem a delegation chain (RFC #791 §18).
  // The payTo shape selects the scheme: the standard-x402 SDK contract
  // sends payTo = the agent's own delegate EOA (the funding target) with
  // merchantPayTo = the merchant, while erc7710 callers send the merchant
  // as payTo. An explicit settlementScheme, when present, must agree.
  const fundingShape = deriveFundingShape(payTo, agent.delegate_address)
  const shapeError = validateDelegationSchemeShape(fundingShape, settlementScheme, facilitatorAddresses)
  if (shapeError) return shapeError

  // ── #961 hardening: cap, one-shot, replay — BEFORE any sponsored prepare ──
  // One-shot authorize+execute is a legacy-rail convenience; on this rail
  // the signature is typed data over prepared state that does not exist
  // yet, so a provided signature can never be valid. Refuse loudly instead
  // of silently minting a fresh intent per call.
  if (signature !== undefined) {
    return {
      code: 400,
      body: {
        error:
          'One-shot authorize+execute is not supported on the delegation rail — authorize first, ' +
          'then sign the returned sign_data and submit it (POST /payments/:id/sign for EIP-3009 ' +
          'funding, POST /x402/:id/settle for erc7710).',
      },
    }
  }

  const replayContext = {
    url, payTo, merchantPayTo, amountRaw, tokenAddress, tokenSymbol: tokenConfig.symbol, network, facilitatorAddresses,
  }
  const findExistingByKey = async (): Promise<Record<string, unknown> | null> => {
    if (!idempotencyKey) return null
    const existing = await findX402IntentByIdempotencyKey(agent.id, idempotencyKey)
    return existing ? (existing as unknown as Record<string, unknown>) : null
  }
  const preExisting = await findExistingByKey()
  if (preExisting) {
    const replayed = await delegationReplay(preExisting, agent, replayContext)
    if (replayed) return replayed
  }

  // Per-agent hourly cap — AFTER the replay lookup (a replay creates
  // nothing and runs no estimation, so it must never be rate-limited;
  // legacy-rail parity) but BEFORE any sponsored prepare, so the cap is
  // sponsorship-cost protection too (#717 surface).
  const delegationCap = await agentHourlyX402CapExceeded(agent.id)
  if (delegationCap !== null) {
    return {
      code: 429,
      body: { error: `Rate limit exceeded: max ${delegationCap} x402 payments per hour`, retry_after_seconds: 60 },
    }
  }

  if (fundingShape) {
    // ── EIP-3009 fallback: delegation-metered funding leg (#946) ──────
    // treasury ──(budget delegation)──▶ agent EOA, then the EOA signs the
    // standard EIP-3009 header client-side and the facilitator settles
    // EOA→merchant. The budget is metered at the funding hop (accepted
    // bridge downside — see the issue); recipient-PINNED budgets cannot
    // fund the EOA, so 3009-mode structurally requires an open budget
    // (owner decision 2026-07-15: pinned agents are erc7710-only).
    if (!merchantPayTo) {
      return {
        code: 400,
        body: { error: 'merchantPayTo is required for EIP-3009 x402 on the delegation rail — the ledger must record the real merchant, not the funding target' },
      }
    }
    let fundingAuth
    try {
      fundingAuth = await prepareDelegationPayment(
        { id: agent.id, chain_id: agent.chain_id, delegate_address: agent.delegate_address },
        tokenAddress,
        payTo.toLowerCase(),
        amountRaw,
      )
    } catch (err) {
      // Caveat rejection (budget/expiry) or bundler failure — database untouched.
      return {
        code: 502,
        body: {
          error: 'Delegation-rail funding authorization failed (on-chain policy or bundler)',
          details: redactVendorSecrets(err instanceof Error ? err.message : String(err)),
        },
      }
    }
    if (!fundingAuth) {
      return {
        code: 403,
        body: {
          error:
            `Agent has no delegation able to fund EIP-3009 settlement for ${tokenConfig.symbol}. ` +
            '3009-mode needs an open (unpinned) budget delegation — merchant-pinned budgets settle via erc7710 only.',
        },
      }
    }

    const intent = await createPaymentIntent({
      agent,
      rail: 'x402',
      payTo,
      tokenSymbol: tokenConfig.symbol,
      tokenAddress,
      amountRaw,
      amountHuman,
      // #2263: kept deliberately. `allowance_nonce` is NOT NULL and carries no
      // information on this rail — every writer passes 0 — but it is still
      // published as `sign_data.components.nonce`, so dropping the column is a
      // money-path wire change rather than a schema cleanup. See migration 075.
      allowanceNonce: 0,
      signHash: fundingAuth.prepared.userOpHash,
      resourceUrl: url,
      category: category ?? null,
      merchantAddress: merchantPayTo.toLowerCase(),
      challengeId: null,
      idempotencyKey: idempotencyKey ?? null,
      // #1307: persist the MCP merchant-call context (when the quote came
      // through haven_pay_mcp_tool) so the settle leg can rehydrate it by
      // payment_id instead of the agent re-threading it.
      // #1355: same persistence for the full 402 PaymentRequired, so
      // sign-context can re-serve it and the signer needs only payment_id.
      metadata: { network, settlement_scheme: 'eip3009', mcp_call_context: mcpCallContext ?? null, payment_required: paymentRequired ?? null },
      executionRail: 'delegation',
      delegationHash: fundingAuth.delegationHash,
      // #1059: on the funding leg the budget IS the signed instrument.
      budgetDelegationHash: fundingAuth.delegationHash,
      preparedUserOp: serializeUserOp(fundingAuth.prepared.userOperation),
      conflictTarget: 'x402_idempotency_key',
    })
    if (!intent) {
      // #961: a concurrent claim won the insert — resume THAT intent
      // instead of dead-ending the client on a bare 409.
      const winner = await findExistingByKey()
      if (winner) {
        const replayed = await delegationReplay(winner, agent, replayContext)
        if (replayed) return replayed
      }
      return { code: 409, body: { error: 'Idempotent replay in progress — retry the original request' } }
    }

    // Mirror the legacy-rail 201 shape (chain/payer/merchant/expected-auth)
    // so the standard-x402 SDK machinery — receipt mapping and the edge
    // signer's expected-context binding check — works unchanged; only the
    // signing scheme differs (the account's UserOp typed data).
    const fundingExpectedAuth = await signX402ExpectedContext({
      paymentId: intent.id,
      payloadHash: fundingAuth.prepared.userOpHash,
      resourceUrl: url,
      merchantTo: merchantPayTo.toLowerCase(),
      amount: amountRaw.toString(),
      asset: tokenAddress,
      network,
      expiresAt: intent.expires_at,
      // #1138: commit to the typed data, not just the 4337 hash — the
      // signer signs the former and can only verify what is bound.
      typedDataHash: typedDataDigest(fundingAuth.prepared.signingTypedData),
      // #1690: gated payer identity — {} until X402_EMIT_PAYER_CONTEXT=1.
      ...x402PayerContextFields(agent),
    })
    return {
      code: 201,
      body: {
        payment_id: intent.id,
        status: intent.status,
        expires_at: intent.expires_at,
        chain_id: agent.chain_id,
        safe_address: agent.safe_address,
        payer: agent.safe_address,
        token: tokenConfig.symbol,
        amount: amountHuman,
        to: payTo.toLowerCase(),
        merchant_to: merchantPayTo.toLowerCase(),
        resource_url: url,
        x402_expected_auth: fundingExpectedAuth,
        // #1690: gated payer identity on the wire, paired with the context above.
        ...x402PayerWireFields(agent),
        sign_data: {
          hash: fundingAuth.prepared.userOpHash,
          signature_scheme: 'eip712_userop',
          // The account validates THIS typed data (not the bare 4337 hash).
          typed_data: fundingAuth.prepared.signingTypedData,
          components: {
            safe: agent.safe_address,
            account: fundingAuth.prepared.delegateAccountAddress,
            token: tokenAddress,
            to: payTo.toLowerCase(),
            amount: amountRaw.toString(),
          },
          instructions:
            'Sign sign_data.typed_data with your delegate (agent) key (EIP-712; ' +
            '@haven_ai/sdk does this automatically). Then POST ' +
            `/payments/${intent.id}/sign with { signature } — the funding redemption ` +
            'moves the exact amount to your delegate EOA, after which you retry the ' +
            'merchant with your EIP-3009 X-PAYMENT header. Sweep any residual.',
        },
      },
    }
  }

  const budget = await selectDelegation(agent.id, tokenAddress, payTo.toLowerCase())
  if (!budget) {
    return { code: 403, body: { error: `Agent has no active budget delegation for ${tokenConfig.symbol} to this merchant` } }
  }

  // ── #2082: fail-fast remaining-budget pre-check ──────────────────────────
  //
  // What this is NOT: a security boundary. The `ERC20PeriodTransferEnforcer`
  // in the budget delegation's caveat stack remains the gate, and it reverts
  // an over-budget redemption whether or not this read happened. Nothing below
  // widens what the chain will allow — it can only refuse earlier.
  //
  // What it IS: the missing half of an invariant the other two entry points
  // already keep. `POST /payments` and the EIP-3009 funding shape both prepare
  // a redemption at authorize, so the enforcer refuses during gas estimation
  // and the caller gets a 502 with nothing written. This branch prepares
  // nothing — it re-delegates a narrowed child and hands it back — so an
  // over-budget request used to come back 201 `pending_signature` WITH
  // `sign_data`, and the refusal only arrived four round trips later, after
  // the agent had signed, settled, and retried the merchant (#1993, measured
  // live against dev 2026-08-25). #1450 made erc7710 the PREFERRED scheme, so
  // the one path most payments take was the one that refused latest.
  //
  // FAIL OPEN, deliberately. `readRemainingBudget` reports `fromChain: false`
  // when the enforcer read failed or the delegation carries no period caveat
  // this reader can speak for; in both cases the number is a fallback, and
  // refusing a possibly-fundable payment on a degraded RPC read would turn a
  // transient outage into a stopped agent — the same posture as #1145's
  // fallback and #1319's `remaining_is_from_chain` honesty flag. Belt and
  // braces, THREE ways: the fallback we pass is the requested amount, so even
  // a caller that dropped the `fromChain` guard could only ever compare
  // `amount < amount` and proceed; and the call is wrapped, so a reader that
  // rejects instead of catching (it catches today — this guards the SEAM, not
  // the current implementation) degrades to the same fallback rather than
  // becoming a new way for authorize to 500 on a fundable payment.
  //
  // The PARSE is inside the guard with the read, not after it. `BigInt()`
  // throws on a malformed string, so a reader that ever returned one would
  // turn a fundable payment into a 500 — the one outcome this whole block is
  // supposed to be incapable of. `null` means "no usable number", which reads
  // the same as a degraded read everywhere below.
  let remainingAtomic: bigint | null = null
  try {
    const read = await readRemainingBudget(
      agent.chain_id,
      budget.delegation_json,
      amountRaw.toString(),
    )
    remainingAtomic = read.fromChain ? BigInt(read.remainingAtomic) : null
  } catch {
    remainingAtomic = null
  }
  // `<`, never `<=`: spending the exact remainder is what the chain allows, and
  // refusing it would strand the last payment of every period behind a refusal
  // the enforcer would not have made.
  if (remainingAtomic !== null && remainingAtomic < amountRaw) {
    const shortfallAtomic = amountRaw - remainingAtomic
    const remainingHuman = formatTokenValue(remainingAtomic.toString(), tokenConfig.decimals)
    const shortfallHuman = formatTokenValue(shortfallAtomic.toString(), tokenConfig.decimals)
    // 403 and not 502: the sibling refusal directly above ("no active budget
    // delegation") is the same family — spend authority the agent does not
    // have — and the hosted MCP's guided pre-check already answers 403
    // `DELEGATION_BUDGET_EXCEEDED` for this exact condition (#1306). A 502
    // would say "upstream failed", which is what the 3009 branch genuinely
    // means and this branch genuinely does not. The taxonomy fields are what
    // make it actionable: MCP's `normalizeError` reads `phase`/`next_action`
    // straight off the body, so an agent is told to ask its owner to raise
    // the budget rather than to retry.
    return {
      code: 403,
      body: {
        error:
          `This x402 payment of ${amountHuman} ${tokenConfig.symbol} exceeds the agent's remaining ` +
          `budget for this period (${remainingHuman} ${tokenConfig.symbol}, short by ${shortfallHuman}). ` +
          'There is no approval queue on the delegation rail — an over-budget redemption reverts ' +
          'on-chain. Ask the wallet owner to grant or raise the budget in Haven, then retry.',
        error_code: 'delegation_budget_exceeded',
        phase: AgentPaymentPhase.InsufficientFunds,
        next_action: AgentPaymentNextAction.FundSafeOrRaiseAllowance,
        rail: AgentPaymentRail.X402,
        chain_id: agent.chain_id,
        token: tokenConfig.symbol,
        asset: tokenAddress,
        network,
        amount: amountHuman,
        amount_atomic: amountRaw.toString(),
        remaining: remainingHuman,
        remaining_atomic: remainingAtomic.toString(),
        shortfall: shortfallHuman,
        shortfall_atomic: shortfallAtomic.toString(),
        resource_url: url,
        merchant_address: payTo.toLowerCase(),
      },
    }
  }

  // #2094: the intent id is generated HERE, before the child is built, and
  // handed to the insert below as an explicit primary key.
  //
  // The ordering is the whole point. The settlement child is salted from the
  // intent id (`settlementSalt`), so the id has to exist before the child
  // does — letting Postgres' `gen_random_uuid()` default supply it would leave
  // the child unable to name the row that stores it. A v4 UUID from
  // `node:crypto` is the same value space the column default produces, so
  // nothing downstream can tell the two sources apart.
  //
  // When the insert below loses the idempotency race it returns null and this
  // id is simply discarded along with the child built from it — the winner's
  // own child is replayed out of `prepared_user_op` (`delegationReplay`), so a
  // discarded id can never be the one a settlement is attributed to.
  const intentId = randomUUID()

  let built
  let delegateAccountAddress
  try {
    delegateAccountAddress = await computeHybridAccountAddress(agent.chain_id, {
      ownerAddress: agent.delegate_address as `0x${string}`,
    })
    built = buildSettlementDelegation({
      chainId: agent.chain_id,
      // #2094: salts the child, making its hash unique to THIS intent.
      intentId,
      delegateAccountAddress: delegateAccountAddress as `0x${string}`,
      budgetDelegation: JSON.parse(budget.delegation_json),
      asset: tokenAddress as `0x${string}`,
      amountAtomic: amountRaw,
      payTo: payTo.toLowerCase() as `0x${string}`,
      // #1058: pin the child to the merchant's advertised facilitators —
      // normalized for the caveat; the VERBATIM strings are stored below
      // for the header echo (the v2 matcher deep-equals them).
      redeemers: facilitatorAddresses?.map((a) => normaliseAddress(a) as `0x${string}`),
      // Reviewed (#1053 minor): validated numeric at the route top — a
      // string here would NaN through the clamp into a 502.
      maxTimeoutSeconds: maxTimeoutSeconds ?? 300,
    })
  } catch (err) {
    return {
      code: 502,
      body: {
        error: 'Could not build the settlement delegation',
        details: redactVendorSecrets(err instanceof Error ? err.message : String(err)),
      },
    }
  }

  // ── #1667: deploy the child's delegator if still counterfactual ──────────
  // The settlement child's delegator is the delegate HYBRID ACCOUNT, and
  // nothing else on this path deploys it: the DelegationManager verifies the
  // child's signature via EIP-1271 when the delegator has code and ecrecover
  // when it does not, so against a counterfactual account the delegate EOA's
  // signature recovers to the EOA ≠ delegator and redemption reverts
  // InvalidEOASignature. The 3009 funding leg deploys the account as a side
  // effect of its first UserOp (initCode) — a fresh agent whose FIRST payment
  // is erc7710 never ran one, and a recipient-pinned agent never can (they
  // are erc7710-only). The factory deploy is permissionless and relayer-paid
  // (#860's treasury pattern at grant activation); once deployed,
  // ensureHybridDeployed short-circuits on a single getBytecode. Fail-closed
  // BEFORE the intent row exists, so a failed deploy leaves nothing half
  // created and authorize can simply be retried.
  try {
    await ensureHybridDeployed(
      agent.chain_id,
      { ownerAddress: agent.delegate_address as `0x${string}` },
      delegateAccountAddress as `0x${string}`,
      { agentId: agent.id, userId: agent.user_id },
    )
  } catch (err) {
    if (err instanceof RelayerBudgetExceededError) {
      return { code: 429, body: { error: err.message } }
    }
    return {
      code: 502,
      body: {
        error: 'Could not deploy the delegate account for erc7710 settlement — retry the authorize',
        details: redactVendorSecrets(err instanceof Error ? err.message : String(err)),
      },
    }
  }

  const intent = await createPaymentIntent({
    // #2094: the pre-generated id, so the stored row IS the one the child's
    // salt names. Anything else silently un-attributes the settlement.
    id: intentId,
    agent,
    rail: 'x402',
    payTo,
    tokenSymbol: tokenConfig.symbol,
    tokenAddress,
    amountRaw,
    amountHuman,
    // #2263: kept deliberately. `allowance_nonce` is NOT NULL and carries no
    // information on this rail — every writer passes 0 — but it is still
    // published as `sign_data.components.nonce`, so dropping the column is a
    // money-path wire change rather than a schema cleanup. See migration 075.
    allowanceNonce: 0,
    signHash: built.childHash,
    resourceUrl: url,
    category: category ?? null,
    merchantAddress: (merchantPayTo ?? payTo).toLowerCase(),
    challengeId: null,
    idempotencyKey: idempotencyKey ?? null,
    // #1053 review, finding 5 (the quick half): record the scheme like the
    // 3009 path does, so the accounting feed can tell schemes apart without
    // parsing prepared_user_op. The hash-semantics column is the follow-up.
    // #1307: same merchant-call-context persistence as the 3009 branch above.
    // #1355: same payment_required persistence as the 3009 branch above.
    metadata: { network, settlement_scheme: 'erc7710', mcp_call_context: mcpCallContext ?? null, payment_required: paymentRequired ?? null },
    executionRail: 'delegation',
    delegationHash: built.childHash,
    // #1059: the CHILD is signed, but the parent budget does the metering —
    // recorded uniformly so the accounting feed never parses prepared_user_op.
    budgetDelegationHash: budget.delegation_hash,
    preparedUserOp: serializeUserOp({
      child: built.child,
      budget: JSON.parse(budget.delegation_json),
      delegateAccountAddress,
      network,
      // Echoed back to the merchant in the v2 X-PAYMENT header — must be
      // the QUOTED value, and the child's expiry was derived from it.
      maxTimeoutSeconds: maxTimeoutSeconds ?? 300,
      // #1058: echoed verbatim; the child's redeemer caveat was built
      // from these (normalized), so state and caveat stay one thing.
      facilitatorAddresses,
    }),
    conflictTarget: 'x402_idempotency_key',
  })
  if (!intent) {
    // #961: a concurrent claim won the insert — resume THAT intent
    // instead of dead-ending the client on a bare 409.
    const winner = await findExistingByKey()
    if (winner) {
      const replayed = await delegationReplay(winner, agent, replayContext)
      if (replayed) return replayed
    }
    return { code: 409, body: { error: 'Idempotent replay in progress — retry the original request' } }
  }

  // #1474: PARITY between the two branches, not a missing boundary.
  //
  // The 3009 branch above emits a Haven-signed expected context; this one did
  // not. That was survivable because the local signer's `{ payment_id }` path
  // fetches GET /x402/:id/sign-context, where `rebuildDelegationSignContext`
  // builds one for this scheme too — so the binding discipline was already
  // applied there. What it was NOT survivable for is a client that signs
  // straight from the authorize response, as HavenClient.settleX402Erc7710()
  // (#1454) does: it had no declaration available without a second round-trip.
  //
  // Emitting it here makes the response self-sufficient and the two branches
  // symmetric. Note what it does and does not cover: the context binds the
  // DIGEST of the child plus the declared fields; it does not prove the
  // child's caveats implement them. That check is #1455's job.
  //
  // `payloadHash` is the child hash and `typedDataHash` the digest of the
  // payload actually signed — the pair is what lets the signer bind the
  // declaration to the bytes rather than to a hash travelling beside them.
  // merchantTo is `payTo` here BECAUSE this is the direct-settlement shape:
  // payTo IS the merchant, which is what selected this branch.
  const settlementExpectedAuth = await signX402ExpectedContext({
    paymentId: intent.id,
    payloadHash: built.childHash,
    resourceUrl: url,
    merchantTo: payTo.toLowerCase(),
    amount: amountRaw.toString(),
    asset: tokenAddress,
    network,
    expiresAt: intent.expires_at,
    typedDataHash: typedDataDigest(built.signingPayload),
    // #1690: gated payer identity — {} until X402_EMIT_PAYER_CONTEXT=1.
    ...x402PayerContextFields(agent),
  })

  return {
    code: 201,
    body: {
      payment_id: intent.id,
      status: intent.status,
      expires_at: intent.expires_at,
      x402_expected_auth: settlementExpectedAuth,
      // #1690: gated payer identity on the wire, paired with the context above.
      ...x402PayerWireFields(agent),
      sign_data: {
        hash: built.childHash,
        signature_scheme: 'eip712_delegation',
        typed_data: built.signingPayload,
        components: {
          account: delegateAccountAddress,
          token: tokenAddress,
          to: payTo.toLowerCase(),
          amount: amountRaw.toString(),
        },
        instructions:
          'Sign sign_data.typed_data with your delegate (agent) key (EIP-712; ' +
          '@haven_ai/sdk signUserOpTypedDataForDelegation-style). Then POST ' +
          `/x402/${intent.id}/settle with { signature } to receive the X-PAYMENT ` +
          'header, and retry the merchant with it. The merchant settles directly.',
      },
    },
  }
}
