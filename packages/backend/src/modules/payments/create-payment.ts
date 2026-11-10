/**
 * The `POST /payments` create flow (#4760, slice 1 of epic #4759).
 *
 * Extracted verbatim from `routes/payments.ts`'s `POST /` handler: the
 * retired-rail gate, token and amount resolution, the idempotent replay, the
 * budget-scope resolution and its two fail-open pre-checks, the
 * delegation-rail prepare, the intent insert and the 201 body. The route
 * keeps three jobs — read the request, call `createPayment`, send the decided
 * response it returns.
 *
 * ## The contract
 *
 * `createPayment` takes plain inputs (the authenticated agent, the request
 * body fields, a logger) and returns a decided `{ code, body }` response —
 * the `DecidedResponse` form of `refuse()`. It never receives a Fastify
 * object and never sends anything: the route owns the wire. That is what lets
 * a test call the flow directly, without `app.inject`.
 *
 * ## Behaviour is unchanged
 *
 * Same status, same body, same database writes, same order of refusals, for
 * every request. The characterization suite (`routes/__tests__/
 * payments*.test.ts`) is untouched by this move and is the proof.
 *
 * ## Why `resolveToken` lives here
 *
 * It is called by this flow (step 3) and by the route's `GET /:id` and
 * `POST /:id/sign` handlers. A module may not import the route layer (#994),
 * and the retired-rail gate must stay ABOVE token resolution (#2274), so the
 * resolver cannot be handed in from the route: it moves here and the route
 * imports it back through `modules/payments/index.js`.
 */
import { formatTokenAmount, parseTokenAmount } from '@haven_ai/core'
import type { AgentContext } from '../../middleware/agentAuth.js'
import { getChain } from '../../domain/chains.js'
import {
  expirePendingIntent,
  findSendIntentByIdempotencyKey,
  hasConfirmedPaymentToRecipient,
  insertDelegationIntent,
  type SendIntentReplayRow,
} from '../../infra/repositories/payment-intents.js'
import { readRemainingBudget } from '../../infra/chain/delegation-budget-reader.js'
import {
  allowanceModuleRailRetired,
  loadExecutionRailState,
  redactVendorSecrets,
  resolveExecutionRail,
  serializeUserOp,
  sessionRailRetired,
} from '../../rails/execution-rail.js'
import {
  DelegationRailChainUnavailableError,
  railUnavailableRefusalBody,
} from '../../rails/delegation-rail.js'
import { prepareDelegationPayment } from '../../rails/delegation-authorization.js'
import { checkTaskBudgetCap, taskBudgetExceededBody } from '../task-budgets/index.js'
import {
  buildPeriodExceededBody,
  evaluatePeriodPrecheck,
  periodExceededLedgerDetail,
  refuseBothScopeIds,
  resolveBudgetScope,
  taskCapExceededLedgerDetail,
  type TaskCapInput,
} from '../budget-scope/index.js'
import { agentPaymentStatusHttpCode, getAgentPaymentStatus } from './agent-payment-status.js'
import { buildDirectSignData } from './direct-sign-context.js'
import { prepareFailureBody } from './prepare-failure.js'
import { classifyRevertForLedger, isPeriodBudgetRevert, isTransferCapRevert } from './refusal-ledger.js'
import { refuse, type DecidedResponse } from './refuse.js'

// ── Constants ─────────────────────────────────────────────────────

const PG_UNIQUE_VIOLATION = '23505'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// ── Types ─────────────────────────────────────────────────────────

export interface CreatePaymentBody {
  token: string    // e.g. "USDC", "ETH"
  amount: string   // human-readable, e.g. "25.50"
  to: string       // recipient address
  idempotency_key?: string
  /** #3329: an OPEN task budget to authorize this payment through, instead of the budget delegation directly. */
  task_budget_id?: string
  /** #3330: an OPEN sub-budget (this agent is the sub-agent B) to authorize this payment through. Mutually exclusive with task_budget_id. */
  sub_budget_id?: string
}

/**
 * The subset of a Fastify-style logger this flow uses. Structural on purpose:
 * importing `fastify` here would put the route layer's types back inside the
 * module (#994).
 */
export interface CreatePaymentLog {
  warn: (obj: unknown, msg: string) => void
}

export interface CreatePaymentInput {
  agent: AgentContext
  body: CreatePaymentBody
  log: CreatePaymentLog
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * #3531: advisory `recipient.class` on `POST /payments` — `previously_paid`
 * when THIS agent has ANY prior CONFIRMED payment to this exact recipient
 * address on this chain, on ANY rail (direct, x402 or MPP — including an
 * EIP-3009 funding leg whose `to_address` is the agent's own delegate EOA,
 * which is harmless: it is still this agent's own history), `new_address`
 * otherwise. History-only by owner decision (2026-10-01): no
 * `own_account`/`contact`/`catalog_merchant` lookup, so an agent can never
 * probe for the owner's accounts or contacts by guessing addresses — only
 * its own settled payment history, which it already knows. Never affects
 * policy or signing; it is informational for the caller.
 *
 * #3531 review S3: the advisory read must never fail the prepare — a throw
 * here (a transient DB blip) is swallowed and the field is simply OMITTED,
 * never a 500 on an otherwise-successful payment.
 */
type RecipientClass = 'previously_paid' | 'new_address'

async function classifyRecipient(
  agent: Pick<AgentContext, 'id' | 'chain_id'>,
  toAddressLower: string,
): Promise<{ class: RecipientClass } | undefined> {
  try {
    const previouslyPaid = await hasConfirmedPaymentToRecipient(agent.id, agent.chain_id, toAddressLower)
    return { class: previouslyPaid ? 'previously_paid' : 'new_address' }
  } catch {
    return undefined
  }
}

/** Resolve a token symbol to its config for a specific chain. */
export function resolveToken(chainId: number, symbol: string) {
  const chain = getChain(chainId)
  const tokens = chain.tokens
  const upper = symbol.toUpperCase().replace('.', '')
  if (tokens[upper]) return tokens[upper]
  for (const cfg of Object.values(tokens)) {
    if (cfg.symbol.toLowerCase() === symbol.toLowerCase()) return cfg
  }
  return null
}

/**
 * Idempotent-replay lookup for POST /payments (#1207).
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
  requested: {
    tokenAddress: string
    toAddress: string
    amountRaw: string
    taskBudgetId: string | null
    subBudgetId: string | null
  },
): Promise<DecidedResponse | null> {
  const statusReplay = async (paymentId: string): Promise<DecidedResponse> => {
    const status = await getAgentPaymentStatus(agent, paymentId)
    if (status) {
      return { code: agentPaymentStatusHttpCode(status), body: { ...status, idempotent_replay: true } }
    }
    return {
      code: 409,
      body: { payment_id: paymentId, error: 'Payment already exists but could not be loaded', idempotent_replay: true },
    }
  }
  const mismatch = (row: {
    token_address: string
    to_address: string
    amount_raw: string
    task_budget_id: string | null
    sub_budget_id?: string | null
  }): string | null => {
    if (row.token_address.toLowerCase() !== requested.tokenAddress) return 'token'
    if (row.to_address.toLowerCase() !== requested.toAddress) return 'recipient'
    if (row.amount_raw !== requested.amountRaw) return 'amount'
    // #3392: the task budget the payment was charged to is part of the pin,
    // exactly like token/recipient/amount. Lower-case both ids and treat
    // "absent" as a value, so A→B, A→none and none→A all refuse. This runs
    // before any task-budget lookup: a replay naming an id the stored row
    // does not carry gets this 409 even when the id is malformed.
    if ((row.task_budget_id ?? null) !== (requested.taskBudgetId ? requested.taskBudgetId.toLowerCase() : null)) {
      return 'task_budget'
    }
    // #3330: the same pin for the sub-budget id.
    if (
      (row.sub_budget_id ?? null) !==
      (requested.subBudgetId ? requested.subBudgetId.toLowerCase() : null)
    ) {
      return 'sub_budget'
    }
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
    // nonce/gas), and the intent pinned this one. #3271: shared with
    // `GET /payments/:id/sign-context` (`modules/payments/
    // direct-sign-context.ts`) so both surfaces serve identical bytes for the
    // same row by construction.
    const { hash, signature_scheme, typed_data, accountAddress } = await buildDirectSignData(
      pi,
      agent,
    )
    // #3531: recomputed on every replay (never carried on the row) — it
    // reads the agent's CURRENT confirmed history, which can only grow
    // between the original request and a retry, so this is at worst a
    // same-request-window-consistent read, never a stale one. `undefined`
    // (read throws, S3) omits the field entirely rather than sending an
    // empty/null one — same contract as the fresh-201 site below. Lives at
    // the top level, never inside `sign_data` below, which
    // `buildDirectSignData` alone builds and which never carries it.
    const recipientClass = await classifyRecipient(agent, pi.to_address)
    return {
      payment_id: pi.id,
      status: pi.status,
      expires_at: pi.expires_at,
      idempotent_replay: true,
      ...(recipientClass ? { recipient: recipientClass } : {}),
      sign_data: {
        hash,
        signature_scheme,
        typed_data,
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
  // The legacy/retired-rail replay shape (`execution_rail` unset or not
  // `delegation`) — unreachable for any new row since the retirement gate
  // 410s before this lookup runs, kept only for a pre-existing row. #3531
  // deliberately does NOT add `recipient` here: it is optional on the wire,
  // and this branch is the retired rail's own shape, never extended.
  return {
    payment_id: pi.id,
    status: pi.status,
    expires_at: pi.expires_at,
    idempotent_replay: true,
    sign_data: {
      hash: pi.sign_hash,
      components: {
        // #2914: `payer_account` replaced the deprecated `safe` key. The
        // clean case — this shape carries no `account` key at all, unlike the
        // delegation-authorize funding shape where `account` already means
        // the delegate account address.
        payer_account: agent.account_address,
        token: pi.token_address,
        to: pi.to_address,
        amount: pi.amount_raw,
        payment_token: ZERO_ADDRESS,
        payment: '0',
        // Always 0 today — every live writer passes a literal 0 (#2263). Kept
        // for wire compatibility with the `executeAllowanceTransfer` argument
        // shape this block mirrors; reshaping it is its own change.
        nonce: pi.allowance_nonce,
      },
      instructions:
        'Sign the hash with your delegate private key using raw ECDSA (not eth_sign). ' +
        'The signature must be 65 bytes: r (32) + s (32) + v (1), where v is 27 or 28.',
    },
  }
}

// ── The create flow ───────────────────────────────────────────────

/**
 * Decide one `POST /payments` create request. Returns the response the route
 * sends — never sends it, never touches a Fastify object.
 */
export async function createPayment(input: CreatePaymentInput): Promise<DecidedResponse> {
  const { agent, body, log } = input
  const { token, amount, to, idempotency_key, task_budget_id, sub_budget_id } = body
  // #3330: exactly one authorizing child per payment — a body naming both
  // is ambiguous about which chain to redeem, and ambiguity on a money
  // path refuses rather than guesses.
  if (task_budget_id && sub_budget_id) {
    // The guard itself now comes from the #3616 module (`refuseBothScopeIds`,
    // surface 'payments') — the same 400 body this site hand-built.
    const bothIds = refuseBothScopeIds('payments')
    return { code: bothIds.status, body: bothIds.body }
  }

  // 1. Validate inputs
  //
  // #3031: the SHAPES — required `token`/`amount`/`to`, the recipient
  // address pattern, and the 1–128 `idempotency_key` — are the request
  // schema's job now (`CreatePaymentRequest`, enforced since this file
  // joined `enforcedModules`). What stays here is what the schema cannot
  // say: `Number(amount)` must PARSE and be POSITIVE — `parseTokenAmount`
  // is the converter and the zero/negative refusal below is its own rung;
  // the token-SYMBOL resolution against the chain's token list is semantic
  // (the supported set is chain data, not a wire enum), and so is the rail
  // gate behind it.
  if (isNaN(Number(amount)) || Number(amount) <= 0) {
    return { code: 400, body: { error: 'Amount must be a positive number' } }
  }
  // #3329: task_budget_id's shape (a non-empty string) is the spec's job
  // (`CreatePaymentRequest`) — this handler only reads the value.

  // 2. Resolve the execution rail — ABOVE token resolution (#2274).
  //
  // The gate used to sit below token/amount resolution, so a retired-rail
  // account naming an unsupported token was handed a 400 carrying
  // `supported: [...]` — the assets it can pay with — before anything told
  // it the rail is gone and it can pay with none of them. Rail-INDEPENDENT
  // residue (it asserts nothing false about any rail, which is why #2245
  // left it and filed #2274), but it is still an answer to a question a
  // doomed request should not get answered.
  //
  // What stays ABOVE this gate is the structural validation in step 1: a
  // malformed request is not a request about a rail, and answering 410 to
  // one would make the tombstone the route's error handler. That bound is
  // the same one `agentAuthMiddleware`'s 401 already holds, and both are
  // pinned in `routes/__tests__/allowance-rail-retired.test.ts`.
  //
  // ── Retired-session gate (#993) — the marking alone decides; see
  // rails/execution-rail.ts for the seam and the retirement record.
  const railState = await loadExecutionRailState(agent)

  // ── Retired-session gate (#993), BEFORE the replay lookup: a replayed key
  // must not resurrect actionable sign_data for an account the rail
  // retirement fail-closes (review finding on #1207 — /:id/sign re-checks
  // independently, but the create surface should never hand it out either).
  //
  // ── Retired-ALLOWANCE gate (#1986, epic #1440 slice 3) — same seam, same
  // fail-closed contract, same position: BEFORE the replay lookup and
  // before any chain read, so nothing is written and no allowance is read
  // for an account that can no longer spend.
  const earlyDecision = resolveExecutionRail({ ...railState, chainId: agent.chain_id })
  if (earlyDecision.rail === 'retired_session') {
    const retired = sessionRailRetired('account')
    return { code: retired.statusCode, body: retired.body }
  }
  if (earlyDecision.rail === 'retired_allowance') {
    const retired = allowanceModuleRailRetired('account')
    return { code: retired.statusCode, body: retired.body }
  }

  // 3. Resolve token for agent's chain
  const chain = getChain(agent.chain_id)
  const tokenConfig = resolveToken(agent.chain_id, token)
  if (!tokenConfig) {
    return {
      code: 400,
      body: {
        error: `Unsupported token: ${token}`,
        supported: Object.values(chain.tokens).map((t) => t.symbol),
      },
    }
  }

  // Token address for AllowanceModule (native = zero address)
  const tokenAddress = tokenConfig.address ?? ZERO_ADDRESS

  // 4. Convert human amount to raw units
  let amountRaw: bigint
  try {
    amountRaw = parseTokenAmount(amount, tokenConfig.decimals)
  } catch {
    return { code: 400, body: { error: `Invalid amount for ${tokenConfig.symbol}` } }
  }

  if (amountRaw <= 0n) {
    return { code: 400, body: { error: 'Amount must be greater than zero' } }
  }

  // 4a. Idempotent replay (#1207): a retried request must return the FIRST
  // request's result, never mint a second transfer or a second approval —
  // the same key column migration 020 introduced, so agents get one
  // mechanism, not a per-route dialect. Before any chain read: a replay
  // costs two indexed lookups.
  if (idempotency_key) {
    const replay = await findPaymentReplay(agent, idempotency_key, {
      tokenAddress: tokenAddress.toLowerCase(),
      toAddress: to.toLowerCase(),
      amountRaw: amountRaw.toString(),
      taskBudgetId: (task_budget_id as string | undefined) ?? null,
      subBudgetId: (sub_budget_id as string | undefined) ?? null,
    })
    if (replay) return replay
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
  // This used to be `if (railState.executionRail === 'delegation')` with
  // the legacy AllowanceModule flow below it. `resolveExecutionRail` returns
  // exactly `delegation | retired_session | retired_allowance` and the early
  // gate above returns for both retired answers, so reaching here IS the
  // delegation rail. Keeping the `if` would have needed an unreachable
  // terminal underneath it — the dead-line shape #1986 measured at zero
  // mutation reds and removed rather than kept.
  if (tokenAddress === ZERO_ADDRESS) {
    return {
      code: 400,
      body: {
        error: 'Native-token transfers are not supported on the delegation rail',
      },
    }
  }

  // ── Budget scope (#3618): one resolution through the #3616 resolver ──
  // A task budget (#3329) authorizes the payment INSTEAD OF the budget
  // delegation directly (redemption chain [taskChild, budget]); a
  // sub-budget (#3330) through the three-link chain [B grant, A
  // parent-child, A budget]; otherwise the payment's own (token, to)
  // selection. The resolver keeps the #3329 review finding E rule in both
  // places it applies: parents are read BY THE ROW'S OWN
  // `parent_delegation_hash`, never re-derived by (token, to). Refusals
  // carry the same codes/statuses/messages this file hand-built (the
  // shared tables' one home is now the module).
  const scopeResolution = await resolveBudgetScope({
    agentId: agent.id,
    tokenAddress,
    recipient: to,
    taskBudgetId: task_budget_id,
    subBudgetId: sub_budget_id,
  })
  if (!scopeResolution.ok) {
    return {
      code: scopeResolution.refusal.status,
      body: {
        error: scopeResolution.refusal.message,
        error_code: scopeResolution.refusal.code,
      },
    }
  }
  const scope = scopeResolution.scope
  const taskBudgetScope = scope.kind === 'taskBudget' ? scope.taskBudget : undefined
  const subBudgetScope = scope.kind === 'subBudget' ? scope.subBudget : undefined
  // #3500: the task budget's cap inputs, kept for the pre-check below and
  // for attributing an on-chain transfer-cap revert to THIS task budget.
  const taskBudgetCap: TaskCapInput | null = taskBudgetScope ? taskBudgetScope.taskCap : null

  // #3500: refuse a payment the task budget's cap cannot cover BEFORE the
  // UserOp is built, from the enforcer's own spent figure — a typed,
  // non-retryable 403 instead of the simulation revert's untyped 502. An
  // unreadable chain skips the check; the enforcer remains the gate and the
  // revert fallback in the catch below answers the same refusal.
  const taskBudgetRefusal = async (): Promise<Record<string, unknown> | null> => {
    if (!taskBudgetCap) return null
    const check = await checkTaskBudgetCap({
      chainId: agent.chain_id,
      delegationHash: taskBudgetCap.delegationHash,
      maxAtomic: taskBudgetCap.maxAtomic,
      amountAtomic: amountRaw,
    })
    if (check.outcome !== 'exceeded') return null
    return taskBudgetExceededBody({
      taskBudgetId: taskBudgetCap.taskBudgetId,
      tokenSymbol: tokenConfig.symbol,
      amountHuman: amount,
      amountAtomic: amountRaw.toString(),
      remainingAtomic: check.remainingAtomic.toString(),
      remainingHuman: formatTokenAmount(check.remainingAtomic, tokenConfig.decimals),
      maxAtomic: check.maxAtomic.toString(),
    })
  }
  const taskBudgetLedger = (refusalBody: Record<string, unknown>) => ({
    userId: agent.user_id,
    agentId: agent.id,
    chainId: agent.chain_id,
    tokenSymbol: tokenConfig.symbol,
    amountAtomic: amountRaw.toString(),
    accountAddress: agent.account_address,
    merchantTo: to.toLowerCase(),
    reason: 'delegation_budget_exceeded' as const,
    source: 'payment' as const,
    // The 086 detail allowlist keeps error_code and remaining_atomic only.
    detail: taskCapExceededLedgerDetail(refusalBody.remaining_atomic as string),
  })
  const preRefusal = await taskBudgetRefusal()
  if (preRefusal) {
    return refuse({ code: 403, body: preRefusal }, taskBudgetLedger(preRefusal))
  }

  // #3503 (adopted onto the #3616 resolver, #3618): the PERIOD budget
  // pre-check the x402 legs have had since #2082/#2706. Without it the
  // direct route's only over-budget answer was the simulation revert — an
  // untyped 502 whose hosted step said "transient, retry once". Reads the
  // SAME delegations `prepareDelegationPayment` redeems — the scope
  // resolved ONCE above is handed to `prepareDelegationPayment` below, so
  // the row read is the row redeemed. A sub-budget redeems three links and
  // each carries its own period caveat (`sub-budget-delegation.ts`), so all
  // three are read and the SMALLEST remaining decides — B's own slice is
  // usually the tighter. FAIL OPEN per link on an unreadable read or a link
  // without a readable period caveat (`fromChain: false`), exactly like the
  // x402 legs: the enforcer stays the gate.
  const budgetOptions = subBudgetScope
    ? {
        subBudget: {
          grantDelegation: subBudgetScope.grantDelegation,
          parentChildDelegation: subBudgetScope.parentChildDelegation,
          parentDelegation: subBudgetScope.parentDelegation,
        },
      }
    : taskBudgetScope
      ? {
          taskBudget: {
            childDelegation: taskBudgetScope.childDelegation,
            parentDelegation: taskBudgetScope.parentDelegation,
          },
        }
      : { delegation: scope.delegation }
  const periodBudgetLinks: string[] = budgetOptions.subBudget
    ? [
        JSON.stringify(budgetOptions.subBudget.grantDelegation),
        JSON.stringify(budgetOptions.subBudget.parentChildDelegation),
        budgetOptions.subBudget.parentDelegation.delegation_json,
      ]
    : budgetOptions.taskBudget
      ? [budgetOptions.taskBudget.parentDelegation.delegation_json]
      : budgetOptions.delegation
        ? [budgetOptions.delegation.delegation_json]
        : []
  const periodBudgetRefusal = async (): Promise<Record<string, unknown> | null> => {
    const precheck = await evaluatePeriodPrecheck({
      chainId: agent.chain_id,
      amountAtomic: amountRaw,
      delegationJsons: periodBudgetLinks,
      read: async (chainId, delegationJson, amountAtomic) =>
        readRemainingBudget(chainId, delegationJson, amountAtomic),
    })
    // `<`, never `<=`: spending the exact remainder is what the chain
    // allows. No usable measurement on any link → no refusal (fail open).
    if (!precheck.refused || precheck.remainingAtomic === null) return null
    const remainingAtomic = precheck.remainingAtomic
    // The same body the x402 legs answer (delegation-authorize.ts), with
    // this route's rail and recipient in place of the x402 fields.
    return buildPeriodExceededBody({
      flavor: 'direct',
      chainId: agent.chain_id,
      tokenSymbol: tokenConfig.symbol,
      tokenAddress,
      decimals: tokenConfig.decimals,
      amountAtomic: amountRaw.toString(),
      remainingAtomic: remainingAtomic.toString(),
      amount,
      recipient: to.toLowerCase(),
    })
  }
  const periodBudgetLedger = (refusalBody: Record<string, unknown>) => ({
    userId: agent.user_id,
    agentId: agent.id,
    chainId: agent.chain_id,
    tokenSymbol: tokenConfig.symbol,
    amountAtomic: amountRaw.toString(),
    accountAddress: agent.account_address,
    merchantTo: to.toLowerCase(),
    reason: 'delegation_budget_exceeded' as const,
    source: 'payment' as const,
    detail: periodExceededLedgerDetail(refusalBody.remaining_atomic as string),
  })
  const prePeriodRefusal = await periodBudgetRefusal()
  if (prePeriodRefusal) {
    return refuse({ code: 403, body: prePeriodRefusal }, periodBudgetLedger(prePeriodRefusal))
  }

  let authorization
  try {
    authorization = await prepareDelegationPayment(
      { id: agent.id, chain_id: agent.chain_id, delegate_address: agent.delegate_address },
      tokenAddress,
      to.toLowerCase(),
      amountRaw,
      budgetOptions,
    )
  } catch (err) {
    // Caveat rejection (budget/recipient/expiry) or bundler failure —
    // both land here, both leave the database untouched.
    // #2945: a caveat REVERT is a policy refusal — record it
    // fire-and-forget with the classified reason. A bundler/transport
    // failure is NOT a refusal (the guardrails refused nothing); the
    // classifier returns null for it and nothing is written. Since #3609
    // the same classification also picks the 502's typed body
    // (`prepare_reverted` / `prepare_failed`, below).
    // #3416: no bundler credential for this chain on this deployment — a
    // typed, non-retryable 503, and nothing booked (nothing was refused).
    if (err instanceof DelegationRailChainUnavailableError) {
      return refuse({ code: 503, body: railUnavailableRefusalBody(err) }, null)
    }
    // #3500: a transfer-cap revert on a task-budget payment is that task
    // budget's cap — but only once its own spent figure confirms it (the
    // same enforcer also carries a budget's lifetime cap). Then it is the
    // same typed 403 the pre-check answers, never a "transient" 502.
    if (taskBudgetCap && isTransferCapRevert(err)) {
      const revertRefusal = await taskBudgetRefusal()
      if (revertRefusal) {
        return refuse({ code: 403, body: revertRefusal }, taskBudgetLedger(revertRefusal))
      }
    }
    // #3503: the period budget's own revert (a payment that raced past the
    // pre-check, or a read that failed open) is the same typed 403 once a
    // fresh read confirms it — never the "transient" 502.
    if (isPeriodBudgetRevert(err)) {
      const revertRefusal = await periodBudgetRefusal()
      if (revertRefusal) {
        return refuse({ code: 403, body: revertRefusal }, periodBudgetLedger(revertRefusal))
      }
    }
    const refusalReason = classifyRevertForLedger(err)
    // #3609: typed and bounded. An EXECUTION revert is `prepare_reverted`
    // (deterministic — the hosted step is stop, never "retry once");
    // everything else is `prepare_failed` and keeps the retry step. The
    // ledger is decided by the classifier alone, as before: every classified
    // revert is booked — an AA validation failure too, though it answers
    // `prepare_failed` — and an unclassified failure is not. Both carry `details` bounded after redaction — the raw
    // viem error (~6 KB live: callData, signatures, paymaster data) never
    // rides the response. #3053: both through the shared choke point.
    const failureBody = prepareFailureBody(
      err,
      refusalReason,
      'Delegation-rail authorization failed (bundler or RPC)',
    )
    // The response carries only a bounded cause; the operator gets the whole
    // error here — redacted, never with a vendor key (#3609 review S2).
    log.warn(
      { error_code: failureBody.error_code, refusal_reason: refusalReason },
      `POST /payments prepare failed: ${redactVendorSecrets(err instanceof Error ? err.message : String(err))}`,
    )
    if (!refusalReason) {
      return refuse({ code: 502, body: failureBody }, null)
    }
    return refuse(
      { code: 502, body: failureBody },
      {
        userId: agent.user_id,
        agentId: agent.id,
        chainId: agent.chain_id,
        tokenSymbol: tokenConfig.symbol,
        amountAtomic: amountRaw.toString(),
        accountAddress: agent.account_address,
        merchantTo: to.toLowerCase(),
        reason: refusalReason,
        source: 'payment',
        detail: { error_code: refusalReason },
      },
    )
  }
  if (!authorization) {
    // #2945: no active budget delegation for this token/recipient — how a
    // recipient pin refuses on this rail. Record fire-and-forget, then the
    // response the caller has always received, unchanged.
    // #3053: through the shared choke point.
    return refuse(
      {
        code: 403,
        body: {
          error: `Agent has no active budget delegation for ${tokenConfig.symbol} to this recipient`,
        },
      },
      {
        userId: agent.user_id,
        agentId: agent.id,
        chainId: agent.chain_id,
        tokenSymbol: tokenConfig.symbol,
        amountAtomic: amountRaw.toString(),
        accountAddress: agent.account_address,
        merchantTo: to.toLowerCase(),
        reason: 'no_delegation_for_target',
        source: 'payment',
        detail: { error_code: 'no_delegation_for_target' },
      },
    )
  }

  // #3531 review S3: computed BEFORE the insert, so a throw here is caught
  // by `classifyRecipient` itself (never thrown here) and can never turn an
  // otherwise-successful payment into a 500 — advisory-only, must not be
  // allowed to fail the prepare.
  const recipientClass = await classifyRecipient(agent, to.toLowerCase())

  let delegationIntent
  try {
    delegationIntent = await insertDelegationIntent({
      agentId: agent.id,
      userId: agent.user_id,
      accountAddress: agent.account_address,
      chainId: agent.chain_id,
      tokenSymbol: tokenConfig.symbol,
      tokenAddress,
      toAddress: to.toLowerCase(),
      amountRaw: amountRaw.toString(),
      amountHuman: amount,
      delegateAddress: agent.delegate_address,
      // AllowanceModule-only concept; unused on this rail. #2263 decided to
      // KEEP the column rather than drop it with the rest of the inert Safe
      // schema: it is still published as `sign_data.components.nonce` below,
      // so removing it is a money-path wire change, separable from migration
      // 075's purely inert drops.
      allowanceNonce: 0,
      signHash: authorization.prepared.userOpHash,
      executionRail: 'delegation',
      delegationHash: authorization.delegationHash,
      // #1059: direct transfers redeem the budget itself — same value,
      // written to both so consumers read ONE column across schemes.
      budgetDelegationHash: authorization.delegationHash,
      preparedUserOp: serializeUserOp(authorization.prepared.userOperation),
      sendIdempotencyKey: idempotency_key ?? null,
      taskBudgetId: taskBudgetScope ? task_budget_id : null,
      subBudgetId: subBudgetScope ? sub_budget_id : null,
    })
  } catch (err) {
    // Lost the idempotency-key race with a concurrent request (migration
    // 020's partial unique index) — replay the winner (#1207).
    if (idempotency_key && (err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      const replay = await findPaymentReplay(agent, idempotency_key, {
        tokenAddress: tokenAddress.toLowerCase(),
        toAddress: to.toLowerCase(),
        amountRaw: amountRaw.toString(),
        taskBudgetId: (task_budget_id as string | undefined) ?? null,
        subBudgetId: (sub_budget_id as string | undefined) ?? null,
      })
      if (replay) return replay
    }
    throw err
  }

  return {
    code: 201,
    body: {
      payment_id: delegationIntent.id,
      status: delegationIntent.status,
      expires_at: delegationIntent.expires_at,
      // #3531: advisory only, computed from this agent's own confirmed
      // history above, BEFORE the insert — never consulted by the sign_data
      // below or by any authorization check above, and omitted entirely
      // (not sent as null) when the read threw.
      ...(recipientClass ? { recipient: recipientClass } : {}),
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
    },
  }
}
