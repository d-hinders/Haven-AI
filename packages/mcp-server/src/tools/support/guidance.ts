/**
 * Shared hosted-MCP support — agent guidance and purchase summaries.
 *
 * Extracted VERBATIM from `tools.ts` by #2808 (behavior-preserving move).
 * `buildAgentGuidance` is the structured next-step contract (#1308) every
 * payment tool emits; `buildPurchaseSummary` is the #1349 merchant-display
 * normalizer the settle paths share. Both are emitted from handler bodies in
 * more than one planned capability slice (#2809–#2812), so they live in
 * shared support — never copied.
 *
 * One-direction dependencies: imports only the SDK. Never imports a
 * capability module.
 */
import {
  AgentPaymentNextAction,
  HavenClient,
  HavenPaymentStateError,
  createNextStepBuilder,
  type AgentNextStep,
  type AgentPaymentSummary,
  type AgentPaymentWarning,
  type AgentPurchaseSummary,
  type NextStep,
  type NextStepHandoff,
  type NextStepInput,
  type NextStepTarget,
  X402Erc7710AlreadySettledError,
} from '@haven_ai/sdk'
import { z } from 'zod'
import { toolSchemas } from '../contracts.js'

/**
 * The argument shapes the hosted server hands to the SIGNER's tools. Declared
 * here rather than imported from `@haven_ai/signer`: the hosted server is
 * keyless by design and its deploy image carries only `sdk` + `mcp-server`
 * (Dockerfile), so a runtime import of the edge signer both breaks the build
 * and pulls key-handling code into the hosted bundle. The hosted server hands
 * the signer either a `payment_id` (a payment) or a `task_budget_id` (#3329,
 * a task-budget open/close) — never both, never neither — so the shape is
 * exactly that pair of alternatives, a subset of the signer's own schema,
 * pinned to it by `next-step-signer-parity.test.ts` (test-time import, which
 * the workspace has).
 */
const SIGNER_HANDOFF_SHAPES = {
  haven_sign_x402: { payment_id: z.string().min(1) },
} as const satisfies Record<string, z.ZodRawShape>

const HAVEN_SIGN_PAYMENT_SHAPE = { payment_id: z.string().min(1) } as const satisfies z.ZodRawShape
const HAVEN_SIGN_TASK_BUDGET_SHAPE = { task_budget_id: z.string().min(1) } as const satisfies z.ZodRawShape
// #3506: the signer's `haven_sign` also takes `sub_budget_id` (a sub-budget
// open/close, signed by the delegating agent) — the third alternative.
const HAVEN_SIGN_SUB_BUDGET_SHAPE = { sub_budget_id: z.string().min(1) } as const satisfies z.ZodRawShape

/**
 * #3329 (round-2 review N1): `haven_sign` takes EXACTLY ONE of `payment_id` /
 * `task_budget_id` / (#3506) `sub_budget_id`, never two, never none — a plain shape with both
 * fields `.optional()` let `{}` and the conflicting pair both build with no
 * compile or runtime error, which defeats the whole point of a typed target
 * (the signer itself refuses that pair; a caller should not be able to build
 * it in the first place). `z.union` of `.strict()` objects rejects both
 * at runtime, and the resulting `TArgs` union (`{payment_id} | {task_budget_id} | {sub_budget_id}`)
 * means an excess- or missing-property object literal at a call site is a
 * compile error, exactly as every other target already gets from `target()`.
 */
function exactlyOneTarget<A extends z.ZodRawShape, B extends z.ZodRawShape, C extends z.ZodRawShape>(
  role: 'hosted' | 'signer',
  a: A,
  b: B,
  c: C,
): NextStepTarget<
  | (z.input<z.ZodObject<A>> & { [K in keyof B]?: never } & { [K in keyof C]?: never })
  | (z.input<z.ZodObject<B>> & { [K in keyof A]?: never } & { [K in keyof C]?: never })
  | (z.input<z.ZodObject<C>> & { [K in keyof A]?: never } & { [K in keyof B]?: never })
> {
  // A plain `z.input<A> | z.input<B> | z.input<C>` union would NOT reject a
  // literal carrying two shapes' keys: TS's excess-property check for a fresh
  // object literal against a union only flags a key unknown to EVERY
  // member, and `payment_id`/`task_budget_id`/`sub_budget_id` are each known
  // to one member — exactly the gap round-2 N1 found (`{}` and a conflicting
  // pair both built with no error). The `{ [K in keyof <other>]?: never }`
  // intersections on each arm turn "another shape's key, if present, must be
  // `never`" into a real type mismatch on every arm for a literal carrying
  // two shapes' keys, so the union is rejected — the standard TS "exactly one
  // of" idiom.
  const schema = z.union([z.object(a).strict(), z.object(b).strict(), z.object(c).strict()])
  return {
    role,
    validate: (input) => {
      const r = schema.safeParse(input ?? {})
      return r.success ? null : r.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ')
    },
  }
}

/**
 * #3101 (epic #3105, slice 2/5): the hosted next-step TARGET MAP — every tool a
 * hosted response may hand the agent to, keyed on its BARE name with the
 * server role that reaches it (decision 1). The argument type of each target
 * is derived from the tool's own zod shape (the hosted `toolSchemas` keeps its
 * keys since this slice; the signer handoffs are the declared subset above),
 * and the validate closure is the runtime twin
 * of that type. The SDK's builder renders `mcp__<server>__<tool>` and the
 * runtime-neutral server/name/role fields from this map in one place; the
 * 17 emission sites name a bare tool and arguments that tool declares (or say
 * why none follows), and a
 * wrong key, a missing required key, an unregistered tool name or an omitted
 * `nextTool` is a compile error at the site (`next-step-types.test.ts`).
 */
function target<S extends z.ZodRawShape>(role: 'hosted' | 'signer', shape: S): NextStepTarget<z.input<z.ZodObject<S>>> {
  // Strict: a key the tool does not declare is a wrong handoff even where the
  // tool itself would strip it — the runtime twin must see what the type sees.
  const schema = z.object(shape).strict()
  return {
    role,
    validate: (input) => {
      const r = schema.safeParse(input ?? {})
      return r.success ? null : r.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ')
    },
  }
}

function hostedTargets<M extends Record<string, z.ZodRawShape>>(role: 'hosted' | 'signer', map: M) {
  return Object.fromEntries(Object.entries(map).map(([name, shape]) => [name, target(role, shape)])) as {
    [K in keyof M]: NextStepTarget<z.input<z.ZodObject<M[K]>>>
  }
}

const HOSTED_NEXT_STEP_TARGETS = {
  ...hostedTargets('hosted', toolSchemas),
  ...hostedTargets('signer', SIGNER_HANDOFF_SHAPES),
  haven_sign: exactlyOneTarget('signer', HAVEN_SIGN_PAYMENT_SHAPE, HAVEN_SIGN_TASK_BUDGET_SHAPE, HAVEN_SIGN_SUB_BUDGET_SHAPE),
}
export type HostedNextStepTargets = typeof HOSTED_NEXT_STEP_TARGETS

/** The handoff half of a hosted next step: a bare tool name + its declared arguments, or `null` + the reason. */
export type HostedHandoff = NextStepHandoff<HostedNextStepTargets>

/**
 * #3102 (epic #3105, decision 7): the next step a REFUSAL hands the agent.
 * Same builder, same target map, same compile-time twins as the success path;
 * `safe_to_continue` is false by definition and the refusal's own `message`
 * is its reason, so neither is taken here. `HostedToolError` takes this
 * instead of a bare `nextAction`, so a refusal that names an action must
 * name a tool with arguments that tool declares, or say why none follows.
 */
export function refusalNextStep(input: { nextAction: AgentNextStep['next_action'] } & HostedHandoff): NextStep {
  return nextStep({ ...input, safeToContinue: false, reason: '' } as NextStepInput<HostedNextStepTargets>)
}

/**
 * #3329: the SUCCESS-side counterpart of {@link refusalNextStep} for a next
 * step that has no payment to summarize — a task budget (and, since #3506, a
 * sub-budget) is not a payment, so forcing it through
 * {@link buildAgentGuidance}'s `AgentPaymentSummary` (which requires
 * `payment_id`) would mislabel a `task_budget_id` / `sub_budget_id` under
 * that key.
 * Same builder, same target map, same compile-time twins as every other
 * next-step site; `safeToContinue` defaults true since this is the success
 * path, overridable for a not-yet-safe hand-off.
 */
export function taskBudgetNextStep(
  input: { nextAction: AgentNextStep['next_action']; reason: string; safeToContinue?: boolean } & HostedHandoff,
): NextStep {
  return nextStep({ ...input, safeToContinue: input.safeToContinue ?? true } as NextStepInput<HostedNextStepTargets>)
}

const nextStep = createNextStepBuilder(HOSTED_NEXT_STEP_TARGETS)

/**
 * Decision 9's per-action default table lives in the SDK
 * (`DEFAULT_NEXT_TOOL_BY_ACTION`); every hosted site today names its tool
 * explicitly, so no hosted wrapper over it is exported (a helper with no
 * caller is exactly what the #2808 ownership map refuses).
 */
/**
 * The status handoff for a refusal that may or may not know its payment id
 * (decision 3): `haven_get_payment_status { payment_id }` when it does, and
 * no tool with the reason when it does not — `payment_id` is a required
 * string on that tool, so `{ payment_id: null }` was a handoff its target
 * refused (the three sites #3101 was filed on).
 */
export function paymentStatusHandoff(paymentId: string | undefined | null): HostedHandoff {
  return paymentId
    ? { nextTool: 'haven_get_payment_status', nextArguments: { payment_id: paymentId } }
    : {
        nextTool: null,
        nextToolOmittedReason:
          'no payment_id is known for this refusal, so haven_get_payment_status cannot be named; ' +
          'nothing was funded or signed',
      }
}

/**
 * The guidance envelope `buildAgentGuidance` emits: the next-step contract
 * plus the two envelope fields that ride with it (#2557).
 *
 * Declared so the return below is BOUND to a type rather than inferred. The
 * type had fallen behind the emission twice — `next_tool_server` /
 * `next_tool_name` (#1588) and `next_tool_server_role` (#2550) were both
 * emitted for a while before `AgentNextStep` mentioned them — because nothing
 * connected the two. Since #3101 the next-step half is built by the SDK's
 * typed builder, so the fields cannot drift from the input at all.
 */
type AgentGuidanceEnvelope = AgentNextStep & {
  agent_summary: AgentPaymentSummary
  warnings: AgentPaymentWarning[]
}

export type AgentGuidanceInput = NextStepInput<HostedNextStepTargets> & {
  summary: AgentPaymentSummary
  warnings?: AgentPaymentWarning[]
}

export function buildAgentGuidance(input: AgentGuidanceInput): AgentGuidanceEnvelope {
  // #1588 / #2550: `next_tool` stays byte-identical (`mcp__<server>__<tool>`
  // with the DEFAULT server names — a literal is all this process has) and
  // `next_tool_server` / `next_tool_name` / `next_tool_server_role` are the
  // runtime-neutral resolution a named install (`--name <slug>`, Codex config
  // keys) reads instead. All four are rendered by the SDK builder from the
  // bare name + role, so one emission point cannot drift and no site carries
  // a namespaced literal any more (#3101).
  const { summary, warnings, ...step } = input
  return {
    ...nextStep(step as NextStepInput<HostedNextStepTargets>),
    agent_summary: summary,
    warnings: warnings ?? [],
  }
}

/**
 * #3417: the answer to a prepare whose idempotency_key already belongs to a
 * SETTLED erc7710 payment to this merchant for this resource. The backend
 * replays the confirmed intent (no child to sign), and the SDK surfaces it as
 * `X402Erc7710AlreadySettledError` only after checking payee and resource; this
 * is the answer an agent recovering from a crash should read — the original
 * payment and its settlement hash, a done state that names no tool — instead
 * of the "transient, retry" 500 it used to relay. Shared by the catalog and
 * plain-HTTP prepare sites, which both reach `prepareX402Erc7710`.
 *
 * Unlike the settled arm of `haven_settle_mcp_tool` it carries no `delivered`:
 * Haven cannot know whether the merchant's result reached the agent before a
 * crash, and it cannot re-deliver it. `status` is the backend's own
 * `confirmed`, echoed rather than renamed.
 */
/** #3423: the settle-side twin says what is true of a repeated settle (no key involved). */
const SETTLED_TEXT = {
  prepare: {
    omitted: 'this idempotency_key already settled; there is nothing left to sign, settle or pay',
    reason:
      'Idempotent replay: this idempotency_key already paid this merchant for this resource, and ' +
      'the payment settled on-chain. Nothing was signed and nothing new was charged. Haven cannot ' +
      "re-deliver the merchant's result: if you received it earlier, report that purchase from " +
      "payment_id and settlement_tx_hash; if you did not, tell the user it was paid but the result " +
      'was not received. Amount and tool are not compared: if you reused this key for a different ' +
      'tool or price at the same merchant, this is that earlier payment, not the new purchase. To ' +
      'buy again, use a new idempotency_key.',
  },
  settle: {
    omitted: 'this payment already settled; there is nothing left to sign, settle or pay',
    reason:
      'This payment already settled on-chain, so this was a repeated settle: nothing was signed and ' +
      "nothing new was charged. Haven cannot re-deliver the merchant's result: if you received it " +
      'earlier, report that purchase from payment_id and settlement_tx_hash; if you did not, tell the ' +
      'user it was paid but the result was not received. Do not call the merchant again with a new payment.',
  },
} as const

function settledReplayResponse(err: X402Erc7710AlreadySettledError, origin: 'prepare' | 'settle') {
  const text = SETTLED_TEXT[origin]
  const body = (err.body ?? {}) as Record<string, unknown>
  const str = (key: string) => (typeof body[key] === 'string' ? { [key]: body[key] as string } : {})
  return {
    payment_id: err.paymentId,
    status: 'confirmed',
    settlement_scheme: 'erc7710' as const,
    settled: true,
    idempotent_replay: true,
    settlement_tx_hash: err.txHash,
    ...str('amount'),
    ...str('token'),
    ...str('merchant_to'),
    ...str('resource_url'),
    ...str('explorer_url'),
    ...(typeof body.chain_id === 'number' ? { chain_id: body.chain_id } : {}),
    ...buildAgentGuidance({
      nextAction: AgentPaymentNextAction.None,
      nextTool: null,
      nextToolOmittedReason: text.omitted,
      safeToContinue: true,
      reason: text.reason,
      summary: {
        payment_id: err.paymentId,
        status: 'confirmed',
        ...str('amount'),
        ...str('token'),
      },
    }),
  }
}

/**
 * #3417: the `.catch` for an erc7710 `prepareX402Erc7710` call. A settled
 * replay becomes `{ settledReplay }` for the site to return as-is; any other
 * failure is rethrown unchanged, so every existing refusal keeps its path.
 */
export function catchSettledReplay(err: unknown): { settledReplay: ReturnType<typeof settledReplayResponse> } {
  if (err instanceof X402Erc7710AlreadySettledError) return { settledReplay: settledReplayResponse(err, 'prepare') }
  throw err
}

/**
 * #3423: the same done state for a repeated settle of an erc7710 payment that
 * already settled — `haven_settle_mcp_tool` and `haven_submit` with
 * `settlement_scheme: 'erc7710'` (the SDK's `submitX402Erc7710` throws
 * `X402Erc7710AlreadySettledError` on the backend's typed 409). Any other
 * failure is rethrown unchanged.
 */
export function catchSettledResettle(err: unknown): { settledReplay: ReturnType<typeof settledReplayResponse> } {
  if (err instanceof X402Erc7710AlreadySettledError) return { settledReplay: settledReplayResponse(err, 'settle') }
  throw err
}

/**
 * #3527: the EIP-3009 twin of {@link settledReplayResponse} /
 * {@link catchSettledReplay} for `createX402Intent`'s confirmed-replay answer
 * (`haven_prepare_catalog_purchase` step 9 and `haven_pay_mcp_tool`'s 3009
 * branch). It is NOT a reuse of the erc7710 helper: that one hardcodes
 * `settlement_scheme: 'erc7710'` and reports its replayed `tx_hash` AS the
 * settlement hash, which is correct there (no funding leg — the confirmed
 * intent IS the settlement) and WRONG here, where `confirmed` + `tx_hash`
 * means only the FUNDING leg confirmed (treasury → delegate); the merchant
 * leg is a separate fact this helper must check before saying anything about
 * it (spec review, #3527).
 *
 * The backend's pre-check now answers a settled eip3009 key as sufficient
 * (#3527's other half, `isSettledX402Replay`), so `createX402Intent` reaches
 * its OWN confirmed-replay branch (`delegationReplay`'s scheme-agnostic
 * confirmed+tx_hash answer) and the SDK surfaces that as
 * `HavenPaymentStateError` with `state.status === 'confirmed'` — previously
 * rethrown as-is, which `normalizeError` turned into a bare `API_ERROR` (the
 * spec review's finding). Both hosted call sites catch it in their existing
 * `catch (err)` block (alongside the pre-existing pending-approval branch) and
 * `return` this helper's result instead of rethrowing.
 *
 * `haven.getPaymentStatus` is RE-READ (one extra round trip) because the
 * state error's own `state` carries only the funding leg's facts — the
 * merchant-leg evidence this split needs (`merchantSettlementRecorded`,
 * `delivered`) lives on the status projection (#3475 follow-up,
 * `agent-payment-status.ts`), not on the authorize response the error wraps.
 * A failed re-read (older backend, transport error) is NOT a done state —
 * see the `else` branch below, the safe default either way.
 *
 * - A verified merchant settlement (`merchantSettlementRecorded`) OR a
 *   reported merchant leg (`delivered`, #3420's vocabulary for
 *   `merchant_leg_reported`) → a DONE state. `funding_tx_hash` is the row's
 *   own (funding) hash; `settlement_tx_hash` is deliberately `null` — the
 *   status projection carries only a VERIFIED BOOLEAN today, never the
 *   merchant's own settlement hash, so this never backfills one from the
 *   funding hash (the exact mislabeling the spec review flagged in the
 *   erc7710 helper's reuse for this scheme).
 * - Neither → the #2290 funded-awaiting-merchant remedy, NEVER a fresh
 *   funding sign: the re-read status's own `next_action`/`message` are
 *   forwarded verbatim (`isFundedX402AwaitingMerchantLeg`'s producer already
 *   computed the right answer — `retry_original_x402_request` once the grace
 *   window has passed, `sweep_stranded_funds` if the merchant rejected the
 *   retry, or the plain confirmed answer inside the grace window), pointed
 *   at `haven_get_payment_status` so the agent reads the SAME authoritative
 *   projection rather than this helper re-deriving it a second way.
 */
const EIP3009_REPLAY_TEXT = {
  settledOmitted:
    'this idempotency_key already funded this payment and the merchant leg is recorded; there is nothing left to sign or pay',
  settledReason:
    'Idempotent replay: this idempotency_key already funded this x402 payment via the EIP-3009 bridge, ' +
    "and the merchant leg is recorded (settled or reported). Nothing new was signed and nothing new was " +
    "charged. Haven cannot re-deliver the merchant's result: if you received it earlier, report that " +
    'purchase from payment_id and funding_tx_hash/settlement_tx_hash; if you did not, tell the user it was ' +
    'paid but the result was not received. To buy again, use a new idempotency_key.',
  unverifiedFallback:
    "Haven's funding leg confirmed but no merchant-leg evidence is recorded for this payment yet. Check " +
    'haven_get_payment_status for the current remedy; do not sign or pay again for the same purchase.',
} as const

export async function eip3009ConfirmedReplayResponse(
  haven: HavenClient,
  err: HavenPaymentStateError,
): Promise<Record<string, unknown>> {
  const status = await haven.getPaymentStatus(err.state.paymentId).catch(() => null)
  const fundingTxHash = err.state.txHash ?? status?.txHash ?? null
  const merchantVerified = status?.merchantSettlementRecorded === true
  const delivered = status?.delivered === true

  if (merchantVerified || delivered) {
    return {
      payment_id: err.state.paymentId,
      status: 'confirmed',
      settlement_scheme: 'eip3009' as const,
      settled: true,
      idempotent_replay: true,
      funding_tx_hash: fundingTxHash,
      // #3527: getPaymentStatus carries only the VERIFIED flag today, never
      // the merchant's own settlement transaction hash — this is never
      // fabricated from the funding hash above.
      settlement_tx_hash: null,
      ...buildAgentGuidance({
        nextAction: AgentPaymentNextAction.None,
        nextTool: null,
        nextToolOmittedReason: EIP3009_REPLAY_TEXT.settledOmitted,
        safeToContinue: true,
        reason: EIP3009_REPLAY_TEXT.settledReason,
        summary: {
          payment_id: err.state.paymentId,
          status: 'confirmed',
          ...(status?.amount !== undefined ? { amount: status.amount } : {}),
          ...(status?.token !== undefined ? { token: status.token } : {}),
        },
      }),
    }
  }

  // Neither verified nor reported — never claim the merchant was paid.
  // Forward the re-read status's OWN remedy verbatim; never re-derive it
  // here, and never re-sign a fresh funding intent.
  return {
    payment_id: err.state.paymentId,
    status: status?.status ?? 'confirmed',
    settlement_scheme: 'eip3009' as const,
    idempotent_replay: true,
    funding_tx_hash: fundingTxHash,
    settlement_tx_hash: null,
    ...buildAgentGuidance({
      nextAction: status?.nextAction ?? AgentPaymentNextAction.CheckStatusLater,
      nextTool: 'haven_get_payment_status',
      nextArguments: { payment_id: err.state.paymentId },
      safeToContinue: true,
      reason: status?.message ?? EIP3009_REPLAY_TEXT.unverifiedFallback,
      summary: {
        payment_id: err.state.paymentId,
        status: status?.status ?? 'confirmed',
      },
    }),
  }
}

/**
 * #1349: normalize only the small merchant display fields agents need to
 * report a purchase. Merchant content is deliberately never allowed to set
 * status, money, network, merchant identity, or transaction hashes.
 */
export function buildPurchaseSummary(input: {
  payment: Awaited<ReturnType<HavenClient['getPaymentStatus']>> | null
  merchantResult: unknown
  fundingTxHash: string | null
  settlementTxHash: string | null
  allowance: AgentPurchaseSummary['allowance']
  /**
   * #3423 item 4: erc7710 has NO funding leg — the signature IS the
   * settlement child, and `payment.txHash` (when present) is the SETTLEMENT
   * transaction, not a funding one. Without this flag, the `?? input.payment
   * ?.txHash` fallback below would back-fill that settlement hash into
   * `funding_tx_hash`, mislabeling it. Defaults to `true` (the EIP-3009
   * shape every existing caller has) so this is additive, not a silent
   * behavior change for the bridge.
   */
  hasFundingLeg?: boolean
}): AgentPurchaseSummary {
  const merchantSummary = merchantPurchaseMetadata(input.merchantResult)
  const hasFundingLeg = input.hasFundingLeg ?? true
  return {
    status: 'settled',
    product: merchantSummary.product,
    amount: input.payment?.amount ?? null,
    amount_atomic: input.payment?.amountAtomic ?? null,
    asset: input.payment?.asset ?? null,
    network: input.payment?.network ?? (input.payment ? `eip155:${input.payment.chainId}` : null),
    merchant: {
      address: input.payment?.merchantAddress ?? null,
      resource_url: input.payment?.resourceUrl ?? null,
    },
    invoice_id: merchantSummary.invoiceId,
    funding_tx_hash: hasFundingLeg ? (input.fundingTxHash ?? input.payment?.txHash ?? null) : null,
    // The merchant's optional PAYMENT-RESPONSE receipt can name its own tx.
    // Preserve it as evidence, never as the source of the settled status.
    settlement_tx_hash: input.settlementTxHash,
    allowance: input.allowance,
  }
}

function merchantPurchaseMetadata(result: unknown): { product: string | null; invoiceId: string | null } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { product: null, invoiceId: null }
  const structuredContent = (result as { structuredContent?: unknown }).structuredContent
  if (!structuredContent || typeof structuredContent !== 'object' || Array.isArray(structuredContent)) {
    return { product: null, invoiceId: null }
  }
  const summary = (structuredContent as { summary?: unknown }).summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return { product: null, invoiceId: null }
  const value = summary as { product_name?: unknown; product?: unknown; invoice_id?: unknown }
  return {
    product: typeof value.product_name === 'string' ? value.product_name : typeof value.product === 'string' ? value.product : null,
    invoiceId: typeof value.invoice_id === 'string' ? value.invoice_id : null,
  }
}
