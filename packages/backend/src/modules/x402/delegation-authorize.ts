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
import { DelegationRailChainUnavailableError, railUnavailableRefusalBody } from '../../rails/delegation-rail.js'
import { selectDelegation, selectDelegationByHash, prepareDelegationPayment } from '../../rails/delegation-authorization.js'
import { computeHybridAccountAddress, ensureHybridDeployed } from '../../rails/hybrid-provisioning.js'
import { RelayerBudgetExceededError } from '../../infra/relayer-spend-guard.js'
import {
  buildSettlementDelegation,
  selectStoredAccepted,
  StoredAcceptedMismatchError,
  requireTypedDataDigest,
} from './x402-delegation.js'
import { serializeUserOp } from '../../rails/execution-rail.js'
import { insertMachineIntent as createPaymentIntent } from '../../infra/repositories/payment-intents.js'
import { readRemainingBudget } from '../../infra/chain/delegation-budget-reader.js'
import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  AgentPaymentRail,
} from '../../domain/agent-payment-taxonomy.js'
import { x402Description } from '../../domain/x402-description.js'
import { formatTokenValue } from '../../domain/tokens.js'
import { type ResolvePaymentTokenResult } from '../../domain/payment-token.js'
import { agentHourlyX402CapExceeded, normaliseAddress, ZERO_ADDRESS } from './helpers.js'
import { classifyRevertForLedger, isTransferCapRevert } from '../payments/refusal-ledger.js'
import { refuse } from '../payments/refuse.js'
import { boundedErrorDetails, prepareFailureBody } from '../payments/prepare-failure.js'
import { redactVendorSecrets } from '../../domain/redact-vendor-secrets.js'
import { deriveFundingShape, validateDelegationSchemeShape } from './scheme-selection.js'
import { delegationReplay } from './replay.js'
import type { X402HandlerResult, X402McpCallContextInput } from './types.js'
import { findForAgent as findTaskBudgetForAgent } from '../../infra/repositories/task-budgets.js'
import {
  findForAgent as findSubBudgetForAgent,
  findOpenParentChildByHash,
} from '../../infra/repositories/sub-budgets.js'
import {
  checkTaskBudgetCap,
  resolveTaskBudgetChildForPayment,
  taskBudgetExceededBody,
  type TaskBudgetPaymentRefusal,
} from '../task-budgets/index.js'
import {
  resolveSubBudgetForPayment,
  type SubBudgetPaymentRefusal,
} from '../sub-budgets/index.js'
import type { Delegation } from '@metamask/smart-accounts-kit'

type ResolvedToken = Extract<ResolvePaymentTokenResult, { ok: true }>

/** #3329 §3: the refusal table's HTTP status per code, x402's own copy (matches routes/payments.ts). */
const TASK_BUDGET_REFUSAL_STATUS: Record<TaskBudgetPaymentRefusal, number> = {
  task_budget_not_found: 404,
  task_budget_not_open: 409,
  task_budget_token_mismatch: 409,
  task_budget_recipient_mismatch: 409,
  task_budget_parent_mismatch: 409,
}
const TASK_BUDGET_REFUSAL_MESSAGE: Record<TaskBudgetPaymentRefusal, string> = {
  task_budget_not_found: 'Task budget not found',
  task_budget_not_open: 'Task budget is not open (closed, closing, pending, or expired)',
  task_budget_token_mismatch: "This payment's token does not match the task budget's token",
  task_budget_recipient_mismatch: "This payment's recipient does not match the task budget's pinned recipient",
  task_budget_parent_mismatch: 'The task budget was not carved from the budget delegation selected for this payment',
}

/** #3330 §3: the sub-budget refusal table, x402's own copy (matches routes/payments.ts). */
const SUB_BUDGET_REFUSAL_STATUS: Record<SubBudgetPaymentRefusal, number> = {
  sub_budget_not_found: 404,
  sub_budget_not_open: 409,
  sub_budget_token_mismatch: 409,
  sub_budget_recipient_mismatch: 409,
  sub_budget_parent_mismatch: 409,
}
const SUB_BUDGET_REFUSAL_MESSAGE: Record<SubBudgetPaymentRefusal, string> = {
  sub_budget_not_found: 'Sub-budget not found',
  sub_budget_not_open: 'Sub-budget is not open (closed, closing, pending, or expired)',
  sub_budget_token_mismatch: "This payment's token does not match the sub-budget's token",
  sub_budget_recipient_mismatch: "This payment's recipient does not match the sub-budget's pinned recipient",
  sub_budget_parent_mismatch:
    "The sub-budget's chain is broken — its parent-child link is closed or it was not carved from the budget delegation selected for this payment",
}

export interface DelegationAuthorizeInput {
  agent: AgentContext
  url: string
  payTo: string
  merchantPayTo?: string
  amountRaw: bigint
  amountHuman: string
  /** #3610: the merchant's resource description, persisted as `machine_metadata.description`. */
  description?: string
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
  /** #3329: an OPEN task budget to authorize this settlement through, instead of the budget delegation directly. */
  taskBudgetId?: string
  /** #3330: an OPEN sub-budget (this agent is the sub-agent B) to authorize this settlement through. Mutually exclusive with taskBudgetId. */
  subBudgetId?: string
}

/**
 * #3329: resolve `taskBudgetId` (when supplied). `toAddress` is whatever the
 * eventual redemption's `to` will be — the merchant on the erc7710 leg, the
 * agent's own funding EOA on the 3009 leg (same "recipient-pinned budgets
 * are erc7710-only" reasoning a task budget's own recipient pin inherits
 * automatically, since it is checked against this exact address).
 *
 * #3329 review finding E: the parent is selected by the task budget's OWN
 * `parent_delegation_hash` (`selectDelegationByHash`) — NEVER re-derived by
 * (token, to), which can name a DIFFERENT active grant than the one the
 * task child's `authority` names (an agent holding both an open and a
 * pinned grant for this token, whose pinned recipient happens to equal
 * `toAddress`, would otherwise get a spurious task_budget_parent_mismatch).
 */
async function resolveTaskBudgetOrRefusal(
  agentId: string,
  taskBudgetId: string,
  tokenAddress: string,
  toAddress: string,
) {
  const row = await findTaskBudgetForAgent(taskBudgetId, agentId)
  if (!row) {
    return {
      ok: false as const,
      result: { code: 404, body: { error: TASK_BUDGET_REFUSAL_MESSAGE.task_budget_not_found, error_code: 'task_budget_not_found' } } as X402HandlerResult,
    }
  }
  const parentDelegation = await selectDelegationByHash(agentId, row.parent_delegation_hash)
  if (!parentDelegation) {
    return {
      ok: false as const,
      result: {
        code: 409,
        body: { error: TASK_BUDGET_REFUSAL_MESSAGE.task_budget_parent_mismatch, error_code: 'task_budget_parent_mismatch' },
      } as X402HandlerResult,
    }
  }
  const resolved = resolveTaskBudgetChildForPayment(
    row,
    tokenAddress,
    toAddress,
    parentDelegation,
    Math.floor(Date.now() / 1000),
  )
  if (!resolved.ok) {
    const code = resolved.refusal as TaskBudgetPaymentRefusal
    return {
      ok: false as const,
      result: {
        code: TASK_BUDGET_REFUSAL_STATUS[code],
        body: { error: TASK_BUDGET_REFUSAL_MESSAGE[code], error_code: code },
      } as X402HandlerResult,
    }
  }
  return { ok: true as const, childDelegation: resolved.childDelegation, parentDelegation, row }
}

/**
 * #3500: the typed refusal for a payment an open task budget's cap cannot
 * cover, read from the enforcer's own spent figure (`checkTaskBudgetCap`).
 * `null` when the cap covers it or the chain could not be read — the
 * enforcer then remains the gate. Shared by both legs' pre-checks and the
 * funding leg's revert fallback, so every path answers one refusal.
 */
async function taskBudgetCapRefusal(input: {
  agent: { id: string; user_id: string; chain_id: number; account_address: string }
  row: { id: string; delegation_hash: string; max_atomic: string }
  amountRaw: bigint
  amountHuman: string
  tokenSymbol: string
  tokenDecimals: number
  merchantTo: string
  resourceUrl: string
}): Promise<X402HandlerResult | null> {
  const check = await checkTaskBudgetCap({
    chainId: input.agent.chain_id,
    delegationHash: input.row.delegation_hash,
    maxAtomic: input.row.max_atomic,
    amountAtomic: input.amountRaw,
  })
  if (check.outcome !== 'exceeded') return null
  const body = taskBudgetExceededBody({
    taskBudgetId: input.row.id,
    tokenSymbol: input.tokenSymbol,
    amountHuman: input.amountHuman,
    amountAtomic: input.amountRaw.toString(),
    remainingAtomic: check.remainingAtomic.toString(),
    remainingHuman: formatTokenValue(check.remainingAtomic.toString(), input.tokenDecimals),
    maxAtomic: check.maxAtomic.toString(),
  })
  return refuse(
    { code: 403, body },
    {
      userId: input.agent.user_id,
      agentId: input.agent.id,
      chainId: input.agent.chain_id,
      tokenSymbol: input.tokenSymbol,
      amountAtomic: input.amountRaw.toString(),
      accountAddress: input.agent.account_address,
      merchantTo: input.merchantTo,
      resourceUrl: input.resourceUrl,
      reason: 'delegation_budget_exceeded',
      source: 'x402_authorize',
      detail: {
        error_code: 'task_budget_exceeded',
        remaining_atomic: check.remainingAtomic.toString(),
      },
    },
  )
}

/**
 * #3330: resolve `subBudgetId` (when supplied) — the same shape as
 * `resolveTaskBudgetOrRefusal` one level deeper. The grant's
 * `parent_delegation_hash` names A's parent-child ROW (must still be open);
 * that row's `parent_delegation_hash` names A's budget delegation (must
 * still be an active grant, selected by hash — #3329 review finding E's
 * rule twice over).
 */
async function resolveSubBudgetOrRefusal(
  agentId: string,
  subBudgetId: string,
  tokenAddress: string,
  toAddress: string,
) {
  const grantRow = await findSubBudgetForAgent(subBudgetId, agentId)
  if (!grantRow) {
    return {
      ok: false as const,
      result: { code: 404, body: { error: SUB_BUDGET_REFUSAL_MESSAGE.sub_budget_not_found, error_code: 'sub_budget_not_found' } } as X402HandlerResult,
    }
  }
  const parentChildRow = await findOpenParentChildByHash(grantRow.parent_delegation_hash, Math.floor(Date.now() / 1000))
  if (!parentChildRow) {
    return {
      ok: false as const,
      result: {
        code: 409,
        body: { error: SUB_BUDGET_REFUSAL_MESSAGE.sub_budget_parent_mismatch, error_code: 'sub_budget_parent_mismatch' },
      } as X402HandlerResult,
    }
  }
  const parentDelegation = await selectDelegationByHash(parentChildRow.agent_id, parentChildRow.parent_delegation_hash)
  if (!parentDelegation) {
    return {
      ok: false as const,
      result: {
        code: 409,
        body: { error: SUB_BUDGET_REFUSAL_MESSAGE.sub_budget_parent_mismatch, error_code: 'sub_budget_parent_mismatch' },
      } as X402HandlerResult,
    }
  }
  const resolved = resolveSubBudgetForPayment(
    grantRow,
    parentChildRow,
    tokenAddress,
    toAddress,
    parentDelegation,
    Math.floor(Date.now() / 1000),
  )
  if (!resolved.ok) {
    const code = resolved.refusal as SubBudgetPaymentRefusal
    return {
      ok: false as const,
      result: {
        code: SUB_BUDGET_REFUSAL_STATUS[code],
        body: { error: SUB_BUDGET_REFUSAL_MESSAGE[code], error_code: code },
      } as X402HandlerResult,
    }
  }
  return {
    ok: true as const,
    grantDelegation: resolved.childDelegation!,
    parentChildDelegation: JSON.parse(parentChildRow.delegation_json) as Delegation,
    parentDelegation,
  }
}

export async function runDelegationAuthorize(input: DelegationAuthorizeInput): Promise<X402HandlerResult> {
  const {
    agent, url, payTo, merchantPayTo, amountRaw, amountHuman, description, category, idempotencyKey,
    maxTimeoutSeconds, signature, settlementScheme, facilitatorAddresses, network, tokenConfig, tokenAddress,
    mcpCallContext, paymentRequired, taskBudgetId, subBudgetId,
  } = input
  // #3610: what was bought, in the merchant's words — the body's description,
  // else the stored 402's `resource.description`. Untrusted, bounded display
  // text, persisted so status and receipts can say what the payment was for.
  const intentDescription = x402Description(description, paymentRequired)

  if (tokenAddress === ZERO_ADDRESS) {
    return { code: 400, body: { error: 'Native-token x402 is not supported on the delegation rail' } }
  }
  // #3330: exactly one authorizing child per settlement.
  if (taskBudgetId && subBudgetId) {
    return {
      code: 400,
      body: { error: 'Pass exactly one of taskBudgetId or subBudgetId — never both' },
    }
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
    // #3392: part of the replay pin — delegationReplay compares it against
    // the stored row on pending_signature (unexpired) and confirmed rows.
    taskBudgetId,
    // #3330: same pin for a sub-budget-authorized intent.
    subBudgetId,
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

    // ── #2706: fail-fast remaining-budget pre-check on the funding leg ───────
    //
    // The SAME instrument and posture as #2082's erc7710 pre-check below — and
    // now the SAME refusal for the same condition. Before this, the two schemes
    // answered "this payment exceeds the agent's remaining budget" with
    // opposite shapes: erc7710 a typed 403 `delegation_budget_exceeded` before
    // any prepare, this leg an untyped 502 wrapping the raw viem/bundler
    // simulation dump — a deliberate policy refusal reported as an upstream
    // failure, inviting the one retry that can never succeed. #2041: generic
    // plain-HTTP x402 always takes THIS leg, so the ugly refusal was the common
    // path, not the edge case. The body is #2082's, field for field — same
    // spellings, never a new one; `merchant_address` carries merchantPayTo
    // here because on this leg payTo is the funding target, not the merchant.
    //
    // What it is NOT: a security boundary. The ERC20PeriodTransferEnforcer in
    // the funding delegation's caveat stack remains the gate and still reverts
    // an over-budget redemption inside prepareRedemption's gas estimation; the
    // 502 below stays for genuine bundler/infrastructure failures only. The
    // selection here is the same `selectDelegation(agent, token, payTo)` the
    // prepare runs again — one extra indexed read ahead of a bundler call that
    // costs orders of magnitude more.
    //
    // FAIL OPEN, exactly as #2082: a degraded read (`fromChain: false`), a
    // thrown one, or an unparseable one all mean "no usable measurement" and
    // proceed to prepare, where the enforcer rules. A null selection skips the
    // pre-check entirely so the existing null-handling below can answer its
    // own more specific 403 — this block must never preempt it.
    const fundingDelegation = await selectDelegation(agent.id, tokenAddress, payTo.toLowerCase())

    // ── Task budget (#3329, optional), funding leg ────────────────────────
    // #3329 review finding E: resolved by the task budget's OWN parent hash
    // (`resolveTaskBudgetOrRefusal`), never by `fundingDelegation` above —
    // that (token, to) selection can name a DIFFERENT active grant. The
    // remaining-budget PRE-CHECK below still reads `fundingDelegation`
    // (a convenience only, never the real control); the actual redemption
    // further down uses the task budget's own resolved parent.
    let fundingTaskBudgetChild: Awaited<ReturnType<typeof resolveTaskBudgetChildForPayment>>['childDelegation']
    let fundingTaskBudgetParent: Awaited<ReturnType<typeof selectDelegationByHash>> = null
    // #3500: kept for the cap pre-check and the revert fallback below.
    let fundingTaskBudgetCapInput: Parameters<typeof taskBudgetCapRefusal>[0] | null = null
    if (taskBudgetId) {
      const resolved = await resolveTaskBudgetOrRefusal(agent.id, taskBudgetId, tokenAddress, payTo.toLowerCase())
      if (!resolved.ok) return resolved.result
      fundingTaskBudgetChild = resolved.childDelegation
      fundingTaskBudgetParent = resolved.parentDelegation
      fundingTaskBudgetCapInput = {
        agent,
        row: resolved.row,
        amountRaw,
        amountHuman,
        tokenSymbol: tokenConfig.symbol,
        tokenDecimals: tokenConfig.decimals,
        // NOT `payTo`: on this leg that is the agent's own funding EOA.
        merchantTo: merchantPayTo.toLowerCase(),
        resourceUrl: url,
      }
      const capRefusal = await taskBudgetCapRefusal(fundingTaskBudgetCapInput)
      if (capRefusal) return capRefusal
    }

    // ── Sub-budget (#3330, optional), funding leg ─────────────────────────
    let fundingSubBudgetGrant: Awaited<ReturnType<typeof resolveSubBudgetOrRefusal>>['grantDelegation']
    let fundingSubBudgetParentChild: Awaited<ReturnType<typeof resolveSubBudgetOrRefusal>>['parentChildDelegation']
    let fundingSubBudgetParent: Awaited<ReturnType<typeof selectDelegationByHash>> = null
    if (subBudgetId) {
      const resolved = await resolveSubBudgetOrRefusal(agent.id, subBudgetId, tokenAddress, payTo.toLowerCase())
      if (!resolved.ok) return resolved.result
      fundingSubBudgetGrant = resolved.grantDelegation
      fundingSubBudgetParentChild = resolved.parentChildDelegation
      fundingSubBudgetParent = resolved.parentDelegation
    }

    if (fundingDelegation) {
      let fundingRemainingAtomic: bigint | null = null
      try {
        const fundingRead = await readRemainingBudget(
          agent.chain_id,
          fundingDelegation.delegation_json,
          amountRaw.toString(),
        )
        fundingRemainingAtomic = fundingRead.fromChain ? BigInt(fundingRead.remainingAtomic) : null
      } catch {
        fundingRemainingAtomic = null
      }
      // `<`, never `<=`: spending the exact remainder is what the chain allows.
      if (fundingRemainingAtomic !== null && fundingRemainingAtomic < amountRaw) {
        const fundingShortfallAtomic = amountRaw - fundingRemainingAtomic
        const fundingRemainingHuman = formatTokenValue(fundingRemainingAtomic.toString(), tokenConfig.decimals)
        const fundingShortfallHuman = formatTokenValue(fundingShortfallAtomic.toString(), tokenConfig.decimals)
        // #3053: through the shared choke point — the decided response is
        // returned verbatim while the ledger row is recorded fire-and-forget
        // (the write can never change this response; see refusal-ledger.ts).
        return refuse(
          {
            code: 403,
            body: {
              error:
                `This x402 payment of ${amountHuman} ${tokenConfig.symbol} exceeds the agent's remaining ` +
                `budget for this period (${fundingRemainingHuman} ${tokenConfig.symbol}, short by ${fundingShortfallHuman}). ` +
                'There is no approval queue on the delegation rail — an over-budget redemption reverts ' +
                'on-chain. Ask the wallet owner to grant or raise the budget in Haven, then retry.',
              error_code: 'delegation_budget_exceeded',
              phase: AgentPaymentPhase.InsufficientFunds,
              next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
              rail: AgentPaymentRail.X402,
              chain_id: agent.chain_id,
              token: tokenConfig.symbol,
              asset: tokenAddress,
              network,
              amount: amountHuman,
              amount_atomic: amountRaw.toString(),
              remaining: fundingRemainingHuman,
              remaining_atomic: fundingRemainingAtomic.toString(),
              shortfall: fundingShortfallHuman,
              shortfall_atomic: fundingShortfallAtomic.toString(),
              resource_url: url,
              merchant_address: merchantPayTo.toLowerCase(),
            },
          },
          {
            userId: agent.user_id,
            agentId: agent.id,
            chainId: agent.chain_id,
            tokenSymbol: tokenConfig.symbol,
            amountAtomic: amountRaw.toString(),
            accountAddress: agent.account_address,
            merchantTo: merchantPayTo.toLowerCase(),
            resourceUrl: url,
            reason: 'delegation_budget_exceeded',
            source: 'x402_authorize',
            detail: {
              error_code: 'delegation_budget_exceeded',
              phase: AgentPaymentPhase.InsufficientFunds,
              next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
              remaining_atomic: fundingRemainingAtomic.toString(),
            },
          },
        )
      }
    }

    let fundingAuth
    try {
      fundingAuth = await prepareDelegationPayment(
        { id: agent.id, chain_id: agent.chain_id, delegate_address: agent.delegate_address },
        tokenAddress,
        payTo.toLowerCase(),
        amountRaw,
        fundingSubBudgetGrant && fundingSubBudgetParent && fundingSubBudgetParentChild
          ? {
              subBudget: {
                grantDelegation: fundingSubBudgetGrant,
                parentChildDelegation: fundingSubBudgetParentChild,
                parentDelegation: fundingSubBudgetParent,
              },
            }
          : fundingTaskBudgetChild && fundingTaskBudgetParent
            ? { taskBudget: { childDelegation: fundingTaskBudgetChild, parentDelegation: fundingTaskBudgetParent } }
            : undefined,
      )
    } catch (err) {
      // Caveat rejection (budget/expiry) or bundler failure — database untouched.
      // #3052: the ledger write that the
      // sibling for the identical condition already had and this one did not.
      // The same callee on POST /payments classifies this error and books a
      // refusal (`routes/payments.ts`, whose `prepareDelegationPayment` catch
      // runs `classifyRevertForLedger` with no wrapping); on this leg nothing
      // was recorded, so an expired or over-budget funding redemption on the
      // x402 authorize path stayed invisible to the audit trail while the
      // byte-identical direct payment was booked. The classifier is
      // deliberately four-way: a caveat revert names a refusal, while anything
      // that is not a revert (a transport failure, an RPC auth/config error)
      // returns null and writes NOTHING, because an outage is not a refusal
      // and the ledger must not fill up with infrastructure failures. The
      // response below cannot be changed by the write: the recorder returns
      // synchronously and swallows its own failures (see refusal-ledger.ts).
      // #3053 (slice 2 of epic #3056) migrates this call site behind the
      // shared choke point that slice introduces.
      // #3416: no bundler credential for this chain on this deployment is a
      // configuration state, not a failed authorization — a typed,
      // non-retryable 503. Not a policy refusal either (nothing was
      // refused), so nothing is booked, exactly like the outage case below.
      if (err instanceof DelegationRailChainUnavailableError) {
        return refuse({ code: 503, body: railUnavailableRefusalBody(err) }, null)
      }
      // #3500: a transfer-cap revert through a task budget is that task
      // budget's cap once its own spent figure confirms it — the same typed
      // 403 the pre-check answers, never a "transient" 502.
      if (fundingTaskBudgetCapInput && isTransferCapRevert(err)) {
        const capRefusal = await taskBudgetCapRefusal(fundingTaskBudgetCapInput)
        if (capRefusal) return capRefusal
      }
      const fundingRefusalReason = classifyRevertForLedger(err)
      // #3053: through the shared choke point. The ledger input is null when
      // the classification says NOT a refusal (an outage is not a refusal):
      // the write is skipped. Since #3609 the classification also picks the
      // 502's typed body (`prepare_reverted` / `prepare_failed`, below).
      // NOT `payTo` in merchantTo — on this leg payTo is the agent's own
      // funding EOA; the real merchant is the separate field, exactly as the
      // #2706 pre-check writer above books it.
      // #3609: typed and bounded, exactly as POST /payments answers it
      // (`prepare-failure.ts`): `prepare_reverted` for an execution revert
      // (hosted step stop), `prepare_failed` for anything else (hosted step
      // retry once). Booking follows the classifier alone: every classified
      // revert is booked, whichever answer it gets.
      const fundingFailureBody = prepareFailureBody(
        err,
        fundingRefusalReason,
        'Delegation-rail funding authorization failed (bundler or RPC)',
      )
      // The response carries only a bounded cause; the operator gets the whole
      // error here — redacted, never with a vendor key (#3609 review S2).
      console.warn(
        `x402 funding prepare failed (${fundingFailureBody.error_code}): ` +
          redactVendorSecrets(err instanceof Error ? err.message : String(err)),
      )
      if (!fundingRefusalReason) {
        return refuse({ code: 502, body: fundingFailureBody }, null)
      }
      return refuse(
        { code: 502, body: fundingFailureBody },
        {
          userId: agent.user_id,
          agentId: agent.id,
          chainId: agent.chain_id,
          tokenSymbol: tokenConfig.symbol,
          amountAtomic: amountRaw.toString(),
          accountAddress: agent.account_address,
          merchantTo: merchantPayTo.toLowerCase(),
          resourceUrl: url,
          reason: fundingRefusalReason,
          source: 'x402_authorize',
          detail: { error_code: fundingRefusalReason },
        },
      )
    }
    if (!fundingAuth) {
      // #3052: the sibling writers for this condition — the erc7710
      // no-delegation 403 below and the funding-leg 403 on POST /payments —
      // already recorded it; this leg answered the same refusal with nothing
      // in the audit trail. Same reason, same source, same address fields as
      // the pre-check writer above: `merchantTo` is the MERCHANT, never
      // `payTo`, which here is the agent's own funding EOA (a refusal that
      // booked the funding target as the merchant would be the account
      // confusion the migration 086 allowlist exists to make impossible).
      // Fire-and-forget: the write cannot change the 403 below, whether it
      // succeeds or fails (see refusal-ledger.ts).
      // #3053 (slice 2 of epic #3056) migrates this call site behind the
      // shared choke point that slice introduces.
      // #3053: through the shared choke point — the decided response is
      // returned verbatim while the ledger row is recorded fire-and-forget
      // (the write cannot change the 403 below, whether it succeeds or fails).
      return refuse(
        {
          code: 403,
          body: {
            error:
              `Agent has no delegation able to fund EIP-3009 settlement for ${tokenConfig.symbol}. ` +
              '3009-mode needs an open (unpinned) budget delegation — merchant-pinned budgets settle via erc7710 only.',
          },
        },
        {
          userId: agent.user_id,
          agentId: agent.id,
          chainId: agent.chain_id,
          tokenSymbol: tokenConfig.symbol,
          amountAtomic: amountRaw.toString(),
          accountAddress: agent.account_address,
          merchantTo: merchantPayTo.toLowerCase(),
          resourceUrl: url,
          reason: 'no_delegation_for_target',
          source: 'x402_authorize',
          detail: { error_code: 'no_delegation_for_target' },
        },
      )
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
      // #2960: `delegate_account_address` is written at authorize on both
      // delegation-rail legs so receipts/status can carry `parties.delegate_account`
      // without a per-row RPC read. On this leg it is the account the funding
      // leg mints the UserOp for, computed above as `fundingAuth.prepared.delegateAccountAddress`.
      metadata: {
        network,
        description: intentDescription,
        settlement_scheme: 'eip3009',
        mcp_call_context: mcpCallContext ?? null,
        payment_required: paymentRequired ?? null,
        delegate_account_address: fundingAuth.prepared.delegateAccountAddress,
      },
      executionRail: 'delegation',
      delegationHash: fundingAuth.delegationHash,
      // #1059: on the funding leg the budget IS the signed instrument.
      budgetDelegationHash: fundingAuth.delegationHash,
      preparedUserOp: serializeUserOp(fundingAuth.prepared.userOperation),
      taskBudgetId: fundingTaskBudgetChild ? taskBudgetId : null,
      subBudgetId: fundingSubBudgetGrant ? subBudgetId : null,
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
      typedDataHash: requireTypedDataDigest(fundingAuth.prepared.signingTypedData, 'EIP-3009 funding-leg'),
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
        account_address: agent.account_address,
        payer: agent.account_address,
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
            // #2914: `payer_account` is the account this payment is drawn
            // from. It replaced the deprecated `safe` key and is deliberately
            // NOT `account` below, which means the DELEGATE account address
            // here — a different address (owner review on #2906 rejected
            // merging the two, since the SDK's receipt-payer read would then
            // resolve to the wrong address).
            payer_account: agent.account_address,
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

  let budget = await selectDelegation(agent.id, tokenAddress, payTo.toLowerCase())
  if (!budget) {
    // #2945: this 403 is how a recipient pin refuses on this rail — named
    // for what it is, not distinguishable from no-delegation. Fire-and-forget.
    // #3053: through the shared choke point.
    return refuse(
      { code: 403, body: { error: `Agent has no active budget delegation for ${tokenConfig.symbol} to this merchant` } },
      {
        userId: agent.user_id,
        agentId: agent.id,
        chainId: agent.chain_id,
        tokenSymbol: tokenConfig.symbol,
        amountAtomic: amountRaw.toString(),
        accountAddress: agent.account_address,
        merchantTo: payTo.toLowerCase(),
        resourceUrl: url,
        reason: 'no_delegation_for_target',
        source: 'x402_authorize',
        detail: { error_code: 'no_delegation_for_target' },
      },
    )
  }

  // ── Task budget (#3329, optional), erc7710 leg ──────────────────────────
  // `payTo` IS the merchant on this leg (unlike the funding leg, where it is
  // the agent's own EOA). #3329 review finding E: resolved by the task
  // budget's OWN parent hash, never by the (token, payTo) `budget` above —
  // that selection can name a DIFFERENT active grant. On success, `budget`
  // is REASSIGNED to the task budget's real parent so every downstream use
  // (the remaining-budget pre-check, `buildSettlementDelegation`, the
  // stored settle-time state) redeems the SAME grant the task child's
  // `authority` names, not whichever one (token, payTo) happened to pick.
  let erc7710TaskBudgetChild: Awaited<ReturnType<typeof resolveTaskBudgetChildForPayment>>['childDelegation']
  if (taskBudgetId) {
    const resolved = await resolveTaskBudgetOrRefusal(agent.id, taskBudgetId, tokenAddress, payTo.toLowerCase())
    if (!resolved.ok) return resolved.result
    erc7710TaskBudgetChild = resolved.childDelegation
    budget = resolved.parentDelegation
    // #3500: this leg builds no UserOp, so without this an over-cap payment
    // would only fail when the MERCHANT tried to redeem the settlement child.
    // It sees REDEEMED spend only: a settlement child still in flight is not
    // counted, so it narrows the redemption-time failure, it cannot close it.
    const capRefusal = await taskBudgetCapRefusal({
      agent,
      row: resolved.row,
      amountRaw,
      amountHuman,
      tokenSymbol: tokenConfig.symbol,
      tokenDecimals: tokenConfig.decimals,
      merchantTo: payTo.toLowerCase(),
      resourceUrl: url,
    })
    if (capRefusal) return capRefusal
  }

  // ── Sub-budget (#3330, optional), erc7710 leg ───────────────────────────
  // The grant's parent-child row and A's budget delegation are both read by
  // hash (resolveSubBudgetOrRefusal) and `budget` is reassigned to A's REAL
  // parent grant — every downstream use (the remaining-budget pre-check,
  // buildSettlementDelegation, the stored settle-time state) then redeems
  // the SAME grant the B child's `authority` chain names.
  let erc7710SubBudgetGrant: Awaited<ReturnType<typeof resolveSubBudgetOrRefusal>>['grantDelegation']
  let erc7710SubBudgetParentChild: Awaited<ReturnType<typeof resolveSubBudgetOrRefusal>>['parentChildDelegation']
  if (subBudgetId) {
    const resolved = await resolveSubBudgetOrRefusal(agent.id, subBudgetId, tokenAddress, payTo.toLowerCase())
    if (!resolved.ok) return resolved.result
    erc7710SubBudgetGrant = resolved.grantDelegation
    erc7710SubBudgetParentChild = resolved.parentChildDelegation
    budget = resolved.parentDelegation
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
    // #3053: through the shared choke point — the decided response is
    // returned verbatim while the ledger row is recorded fire-and-forget
    // (the write can never change this response; see refusal-ledger.ts).
    return refuse(
      {
        code: 403,
        body: {
          error:
            `This x402 payment of ${amountHuman} ${tokenConfig.symbol} exceeds the agent's remaining ` +
            `budget for this period (${remainingHuman} ${tokenConfig.symbol}, short by ${shortfallHuman}). ` +
            'There is no approval queue on the delegation rail — an over-budget redemption reverts ' +
            'on-chain. Ask the wallet owner to grant or raise the budget in Haven, then retry.',
          error_code: 'delegation_budget_exceeded',
          phase: AgentPaymentPhase.InsufficientFunds,
          next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
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
      },
      {
        userId: agent.user_id,
        agentId: agent.id,
        chainId: agent.chain_id,
        tokenSymbol: tokenConfig.symbol,
        amountAtomic: amountRaw.toString(),
        accountAddress: agent.account_address,
        merchantTo: payTo.toLowerCase(),
        resourceUrl: url,
        reason: 'delegation_budget_exceeded',
        source: 'x402_authorize',
        detail: {
          error_code: 'delegation_budget_exceeded',
          phase: AgentPaymentPhase.InsufficientFunds,
          next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
          remaining_atomic: remainingAtomic.toString(),
        },
      },
    )
  }

  // #3117: the settle leg echoes the stored challenge's own matching offer,
  // so a caller whose `maxTimeoutSeconds` / `facilitatorAddresses` disagree
  // with the challenge it also sent has nothing to echo. Refuse HERE, where
  // it is a cheap 400 and no child has been signed — deferring it to settle
  // turns a caller mistake into a dead intent the agent has already signed.
  // The SDK derives all three from the same option, so it cannot trip this.
  // The settle-time check stays as the backstop.
  if (paymentRequired && typeof paymentRequired === 'object' && !Array.isArray(paymentRequired)) {
    try {
      selectStoredAccepted(paymentRequired as Record<string, unknown>, network, {
        amount: amountRaw.toString(),
        payTo: payTo as `0x${string}`,
        asset: tokenAddress as `0x${string}`,
        maxTimeoutSeconds: maxTimeoutSeconds ?? 300,
        facilitatorAddresses,
      })
    } catch (err) {
      if (err instanceof StoredAcceptedMismatchError) {
        // #3053: through the shared choke point with a null ledger. This is a
        // MALFORMED REQUEST — two fields of the caller's own body disagreeing
        // — not a guardrail refusal, so it records nothing; the census
        // allowlist owns that distinction, do not "fix" it here.
        return refuse(
          {
            code: 400,
            body: {
              error:
                'The 402 challenge you sent does not advertise one erc7710 option matching this request — ' +
                'amount, payTo, asset, maxTimeoutSeconds and facilitatorAddresses must come from the option you are paying.',
            },
          },
          null,
        )
      }
      throw err
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
      // #3329: when a task budget authorizes this settlement, its signed
      // child is the settlement child's immediate parent.
      taskBudgetChild: erc7710TaskBudgetChild,
      // #3330: when a sub-budget authorizes it, the grant is the immediate
      // parent and A's parent-child rides as the next link.
      subBudget:
        erc7710SubBudgetGrant && erc7710SubBudgetParentChild
          ? { grantDelegation: erc7710SubBudgetGrant, parentChildDelegation: erc7710SubBudgetParentChild }
          : undefined,
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
    // #3053: through the shared choke point. This 502 sits on the enumerated
    // policy-status list WITHOUT a ledger row on purpose: it is build
    // infrastructure loss, not a policy refusal — the census guard's
    // allowlist owns that distinction, do not "fix" it here.
    return refuse(
      {
        code: 502,
        body: {
          error: 'Could not build the settlement delegation',
          // #3609: bounded after redaction — never the raw viem error.
          details: boundedErrorDetails(err),
        },
      },
      null,
    )
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
      // #3053: choke point; allowlisted without a ledger row — the relayer
      // sponsorship budget is exhausted (capacity, not spend policy).
      return refuse({ code: 429, body: { error: err.message } }, null)
    }
    // #3053: choke point; allowlisted without a ledger row — delegate-account
    // deploy infrastructure, not policy (named in the census guard's header).
    return refuse(
      {
        code: 502,
        body: {
          error: 'Could not deploy the delegate account for erc7710 settlement — retry the authorize',
          // #3609: bounded after redaction — never the raw viem error.
          details: boundedErrorDetails(err),
        },
      },
      null,
    )
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
    // #2960: `delegate_account_address` is this leg's own delegator — the
    // one the merchant's PAYMENT-RESPONSE.payer names on this scheme.
    metadata: {
      network,
      description: intentDescription,
      settlement_scheme: 'erc7710',
      mcp_call_context: mcpCallContext ?? null,
      payment_required: paymentRequired ?? null,
      delegate_account_address: delegateAccountAddress,
    },
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
      // #3329: settle.ts needs this to encode [settlement, taskChild, budget]
      // rather than [settlement, budget] — the settlement child's `authority`
      // names the task child, so redeeming without it reverts.
      taskBudgetChild: erc7710TaskBudgetChild,
      // #3330: settle.ts needs grant + parent-child to encode
      // [settlement, grant, parentChild, budget] for a sub-budget settlement.
      subBudget:
        erc7710SubBudgetGrant && erc7710SubBudgetParentChild
          ? { grantDelegation: erc7710SubBudgetGrant, parentChildDelegation: erc7710SubBudgetParentChild }
          : undefined,
    }),
    taskBudgetId: erc7710TaskBudgetChild ? taskBudgetId : null,
    subBudgetId: erc7710SubBudgetGrant ? subBudgetId : null,
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
    typedDataHash: requireTypedDataDigest(built.signingPayload, 'erc7710 settlement'),
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
