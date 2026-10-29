import { AgentPaymentNextAction, createNextStepBuilder, type NextStep, type NextStepHandoff, type NextStepTarget } from '@haven_ai/sdk/edge'
import { z } from 'zod'

/**
 * #3103 (epic #3105, slice 4/5): the signer's typed next step.
 *
 * The signer decides a `next_action` on its refusals and, until this module,
 * never said which tool to call. It cannot know the client's server names
 * (#2550), so the handoff is expressed through the role fields the SDK
 * builder renders — `next_tool_server_role: hosted`, `next_tool_name` — from
 * a bare tool name. The signer must not import the hosted server (it is an
 * npm package installed on user machines; the hosted server is a Docker
 * deployment), so the hosted tools it hands off to are DECLARED here as the
 * argument shape the signer actually emits, and `next-step-signer-parity`
 * in the hosted server's own suite pins them to the hosted schemas at test
 * time — the mirror of how the hosted server declares the signer's shapes.
 */
export const SIGNER_HOSTED_HANDOFF_SHAPES = {
  haven_get_payment_status: { payment_id: z.string().min(1) },
  // #3506: `haven_sign` hands a signed budget row to the hosted `haven_submit`
  // (`signTaskBudget` / `signSubBudget` in tools.ts emit exactly these
  // `next_arguments`). One hosted tool, two argument shapes, so each shape is
  // its own entry keyed `<hosted tool>#<variant>`; the parity test reads the
  // part before `#` as the hosted tool it checks the entry against.
  'haven_submit#task_budget': { task_budget_id: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) },
  'haven_submit#sub_budget': { sub_budget_id: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) },
  // #4449: the third `haven_submit` shape — a DIRECT payment's signed UserOp,
  // relayed by `payment_id` (the hosted schema's `payment_id` arm).
  'haven_submit#payment': { payment_id: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) },
  // #4449: `haven_sign_sweep_delegate` hands its signature back to the hosted
  // `haven_sweep_delegate` phase 2, which takes the authorization it prepared
  // plus that signature. The authorization shape is the hosted tool's own
  // (`packages/mcp-server/src/tools/contracts.ts`), restated here because the
  // signer must not import the hosted server.
  'haven_sweep_delegate#sweep': {
    authorization: z.object({
      from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      value: z.string().regex(/^[0-9]+$/),
      validAfter: z.string().regex(/^[0-9]+$/),
      validBefore: z.string().regex(/^[0-9]+$/),
      nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      chainId: z.number().int().positive(),
    }),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  },
} as const satisfies Record<string, z.ZodRawShape>

function target<S extends z.ZodRawShape>(shape: S, name?: string): NextStepTarget<z.input<z.ZodObject<S>>> {
  const schema = z.object(shape).strict()
  return {
    role: 'hosted',
    ...(name ? { name } : {}),
    validate: (input) => {
      const r = schema.safeParse(input ?? {})
      return r.success ? null : r.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ')
    },
  }
}

const SIGNER_NEXT_STEP_TARGETS = {
  haven_get_payment_status: target(SIGNER_HOSTED_HANDOFF_SHAPES.haven_get_payment_status),
  // #4449: variant keys select the argument shape; `name` renders the bare
  // hosted tool, so `next_tool_name` is `haven_submit`, never
  // `haven_submit#payment`.
  'haven_submit#payment': target(SIGNER_HOSTED_HANDOFF_SHAPES['haven_submit#payment'], 'haven_submit'),
  'haven_sweep_delegate#sweep': target(SIGNER_HOSTED_HANDOFF_SHAPES['haven_sweep_delegate#sweep'], 'haven_sweep_delegate'),
}
export type SignerNextStepTargets = typeof SIGNER_NEXT_STEP_TARGETS
export type SignerHandoff = NextStepHandoff<SignerNextStepTargets>

const nextStep = createNextStepBuilder(SIGNER_NEXT_STEP_TARGETS)

/** A signer refusal's next step: a hosted tool with arguments it declares, or `null` + the reason. */
export function signerRefusalStep(input: { nextAction: NextStep['next_action'] } & SignerHandoff): NextStep {
  return nextStep({ ...input, safeToContinue: false, reason: '' } as Parameters<typeof nextStep>[0])
}

/**
 * #4449: a signer SUCCESS result's next step, as the `next_tool` family only.
 *
 * Success results carry no `next_action` / `safe_to_continue` — those stay on
 * refusals, and the budget successes (`signTaskBudget` / `signSubBudget`) have
 * never carried them either. The builder still needs an action to render, so
 * one is passed and then dropped by {@link nextStepWireFields}: nothing here
 * can put a decision on a success wire.
 */
export function signerSuccessWireFields(handoff: SignerHandoff): ReturnType<typeof nextStepWireFields> {
  return nextStepWireFields(
    nextStep({
      ...handoff,
      nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
      safeToContinue: true,
      reason: '',
    } as Parameters<typeof nextStep>[0]),
  )
}

/** The `next_tool` family of a step, for the failure envelope (additive; `next_tool` never null). */
export function nextStepWireFields(step: NextStep): {
  next_tool?: string
  next_tool_server?: string
  next_tool_name?: string
  next_tool_server_role?: 'hosted' | 'signer'
  next_arguments?: Record<string, unknown>
  next_tool_omitted_reason?: string
} {
  return {
    ...(step.next_tool ? { next_tool: step.next_tool } : {}),
    ...(step.next_tool_server ? { next_tool_server: step.next_tool_server } : {}),
    ...(step.next_tool_name ? { next_tool_name: step.next_tool_name } : {}),
    ...(step.next_tool_server_role ? { next_tool_server_role: step.next_tool_server_role } : {}),
    ...(step.next_arguments ? { next_arguments: step.next_arguments } : {}),
    ...(step.next_tool_omitted_reason ? { next_tool_omitted_reason: step.next_tool_omitted_reason } : {}),
  }
}
