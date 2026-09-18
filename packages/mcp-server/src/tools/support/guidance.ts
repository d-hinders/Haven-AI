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
  HavenClient,
  createNextStepBuilder,
  type AgentNextStep,
  type AgentPaymentSummary,
  type AgentPaymentWarning,
  type AgentPurchaseSummary,
  type NextStepHandoff,
  type NextStepInput,
  type NextStepTarget,
} from '@haven_ai/sdk'
import { z } from 'zod'
import { toolSchemas } from '../contracts.js'

/**
 * The argument shapes the hosted server hands to the SIGNER's tools. Declared
 * here rather than imported from `@haven_ai/signer`: the hosted server is
 * keyless by design and its deploy image carries only `sdk` + `mcp-server`
 * (Dockerfile), so a runtime import of the edge signer both breaks the build
 * and pulls key-handling code into the hosted bundle. The hosted server only
 * ever hands the signer a `payment_id` (the signer fetches the signing
 * context itself, #1263), so the shape is exactly that — a subset of the
 * signer's own schema, pinned to it by `next-step-signer-parity.test.ts`
 * (test-time import, which the workspace has).
 */
const SIGNER_HANDOFF_SHAPES = {
  haven_sign: { payment_id: z.string().min(1) },
  haven_sign_x402: { payment_id: z.string().min(1) },
} as const satisfies Record<string, z.ZodRawShape>

/**
 * #3101 (epic #3105, slice 2/5): the hosted next-step TARGET MAP — every tool a
 * hosted response may hand the agent to, keyed on its BARE name with the
 * server role that reaches it (decision 1). The argument type of each target
 * is derived from the tool's own zod shape (the hosted `toolSchemas` keeps its
 * keys since this slice; the signer handoffs are the declared subset above),
 * and the validate closure is the runtime twin
 * of that type. The SDK's builder renders `mcp__<server>__<tool>` and the
 * runtime-neutral server/name/role fields from this map in one place; the
 * 13 emission sites name a bare tool and arguments that tool declares, and a
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
}
export type HostedNextStepTargets = typeof HOSTED_NEXT_STEP_TARGETS

/** The handoff half of a hosted next step: a bare tool name + its declared arguments, or `null` + the reason. */
export type HostedHandoff = NextStepHandoff<HostedNextStepTargets>

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
}): AgentPurchaseSummary {
  const merchantSummary = merchantPurchaseMetadata(input.merchantResult)
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
    funding_tx_hash: input.fundingTxHash ?? input.payment?.txHash ?? null,
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
