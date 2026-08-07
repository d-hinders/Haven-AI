/**
 * Delegation-rail (#830, epic #821) x402 authorize orchestration — DIRECT
 * settlement. Extracted verbatim from `routes/x402.ts`'s authorize handler:
 * scheme routing (#946), the #961 hardening (hourly cap, one-shot refusal,
 * idempotent replay), the EIP-3009 funding-leg fallback, and erc7710
 * settlement-child construction. Behavior and ordering are unchanged from the
 * pre-#996 route.
 */
import { signX402ExpectedContext } from '../../infra/chain/x402-binding-signer.js'
import { findX402IntentByIdempotencyKey } from '../../infra/repositories/x402-authorizations.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import { redactVendorSecrets } from '../../lib/execution-rail.js'
import { selectDelegation, prepareDelegationPayment } from '../../lib/delegation-authorization.js'
import { computeHybridAccountAddress } from '../../lib/hybrid-provisioning.js'
import {
  buildSettlementDelegation,
  typedDataDigest,
} from '../../lib/x402-delegation.js'
import { serializeUserOp } from '../../lib/execution-rail.js'
import { createPaymentIntent, type ResolvePaymentTokenResult } from '../../lib/machine-payments.js'
import { agentHourlyX402CapExceeded, normaliseAddress, ZERO_ADDRESS } from './helpers.js'
import { deriveFundingShape, validateDelegationSchemeShape } from './scheme-selection.js'
import { delegationReplay } from './replay.js'
import type { X402HandlerResult } from './types.js'

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
}

export async function runDelegationAuthorize(input: DelegationAuthorizeInput): Promise<X402HandlerResult> {
  const {
    agent, url, payTo, merchantPayTo, amountRaw, amountHuman, category, idempotencyKey,
    maxTimeoutSeconds, signature, settlementScheme, facilitatorAddresses, network, tokenConfig, tokenAddress,
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
      allowanceNonce: 0,
      signHash: fundingAuth.prepared.userOpHash,
      resourceUrl: url,
      category: category ?? null,
      merchantAddress: merchantPayTo.toLowerCase(),
      challengeId: null,
      idempotencyKey: idempotencyKey ?? null,
      metadata: { network, settlement_scheme: 'eip3009' },
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
  let built
  let delegateAccountAddress
  try {
    delegateAccountAddress = await computeHybridAccountAddress(agent.chain_id, {
      ownerAddress: agent.delegate_address as `0x${string}`,
    })
    built = buildSettlementDelegation({
      chainId: agent.chain_id,
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

  const intent = await createPaymentIntent({
    agent,
    rail: 'x402',
    payTo,
    tokenSymbol: tokenConfig.symbol,
    tokenAddress,
    amountRaw,
    amountHuman,
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
    metadata: { network, settlement_scheme: 'erc7710' },
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

  return {
    code: 201,
    body: {
      payment_id: intent.id,
      status: intent.status,
      expires_at: intent.expires_at,
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
