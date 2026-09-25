import { createNextStepBuilder, type NextStep, type NextStepHandoff, type NextStepTarget } from '@haven_ai/sdk/edge'
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
} as const satisfies Record<string, z.ZodRawShape>

function target<S extends z.ZodRawShape>(shape: S): NextStepTarget<z.input<z.ZodObject<S>>> {
  const schema = z.object(shape).strict()
  return {
    role: 'hosted',
    validate: (input) => {
      const r = schema.safeParse(input ?? {})
      return r.success ? null : r.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ')
    },
  }
}

const SIGNER_NEXT_STEP_TARGETS = {
  haven_get_payment_status: target(SIGNER_HOSTED_HANDOFF_SHAPES.haven_get_payment_status),
}
export type SignerNextStepTargets = typeof SIGNER_NEXT_STEP_TARGETS
export type SignerHandoff = NextStepHandoff<SignerNextStepTargets>

const nextStep = createNextStepBuilder(SIGNER_NEXT_STEP_TARGETS)

/** A signer refusal's next step: a hosted tool with arguments it declares, or `null` + the reason. */
export function signerRefusalStep(input: { nextAction: NextStep['next_action'] } & SignerHandoff): NextStep {
  return nextStep({ ...input, safeToContinue: false, reason: '' } as Parameters<typeof nextStep>[0])
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
