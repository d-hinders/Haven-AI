/**
 * Hosted identity gate: every hosted tool dispatch resolves the agent API key
 * to an agent before the tool's handler runs, so no tool issues any request
 * — to Haven or a third party — for a key Haven does not accept.
 *
 * Only a 401 is mapped to {@link AGENT_IDENTITY_UNVERIFIED}. Any other
 * failure is rethrown unchanged, so `normalizeError` relays the backend's own
 * answer as it did before the gate: a 403 for a valid key on a paused or
 * pending-approval agent keeps its reason, and a 5xx keeps its retry step.
 * Either way the handler does not run. Per dispatch, not memoized: a revoked
 * key stops at its next call.
 */
import { AgentPaymentNextAction, HavenApiError, type HavenClient } from '@haven_ai/sdk'
import { HostedToolError } from './support/errors.js'
import { refusalNextStep } from './support/guidance.js'
import type { HostedToolName } from './contracts.js'

export const AGENT_IDENTITY_UNVERIFIED = 'AGENT_IDENTITY_UNVERIFIED'

/**
 * Tools that make no request except, at most, to Haven's own
 * agent-authenticated API — so the gate protects nothing on them — and that
 * must keep working where the agent read itself is refused.
 *
 * - `haven_verify_receipt` makes no request at all.
 * - `haven_sweep_delegate` calls only `/sweep/prepare` and `/sweep/submit`,
 *   the routes the backend keeps open to revoked, paused and archived keys so
 *   stranded funds stay recoverable; the agent read refuses those keys.
 *
 * Every other tool, including any added later, is gated.
 */
export const IDENTITY_GATE_EXEMPT: ReadonlySet<HostedToolName> = new Set<HostedToolName>([
  'haven_verify_receipt',
  'haven_sweep_delegate',
])

export async function requireAgentIdentity(haven: HavenClient): Promise<void> {
  try {
    await haven.getAgent()
  } catch (err) {
    if (!(err instanceof HavenApiError) || err.statusCode !== 401) throw err
    throw new HostedToolError({
      code: AGENT_IDENTITY_UNVERIFIED,
      message:
        'Haven did not accept this agent API key. Check the Authorization: Bearer key in your MCP client ' +
        'configuration, or reconnect the agent in Haven.',
      statusCode: 401,
      nextStep: refusalNextStep({
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        nextTool: null,
        nextToolOmittedReason:
          'the agent API key was not accepted; the user must fix the key or reconnect the agent before any tool can run',
      }),
    })
  }
}
