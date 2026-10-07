import { connectorUpgradeCommand } from '@haven_ai/sdk/edge'
import {
  SUPPORTED_SWEEP_BINDING_VERSIONS,
  SUPPORTED_X402_EXPECTED_VERSIONS,
} from './core.js'
import {
  SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS,
  SUPPORTED_SUB_BUDGET_SIGN_CONTEXT_VERSIONS,
  SUPPORTED_TASK_SIGN_CONTEXT_VERSIONS,
} from './sign-context.js'

/**
 * Pre-payment skew detection (#1155).
 *
 * #1143 made a stale signer say so — but only at the signing step, after the
 * agent had already quoted and was one call away from funding. This module
 * moves the same information to the `initialize` handshake, so the set of
 * expected-context versions this signer understands is observable *before* a
 * payment is attempted.
 *
 * **The check is necessarily agent-mediated.** The signer and the hosted Haven
 * MCP are two separate servers connected to the same client; neither can
 * introspect the other. The signer's Haven reads (#1263's read-only
 * `GET /x402/:payment_id/sign-context` and #3271's direct-payment
 * `GET /payments/:payment_id/sign-context`, both in `sign-context.ts`) do not help
 * here: each fetches one payment's signing bytes, not the hosted server's
 * handshake, and it happens at signing time — after the quote this module
 * exists to get ahead of. So only the agent sees both handshakes, and what
 * ships here is the *information* plus the prompt to compare it — never a
 * server-side gate. A mismatch is advisory: the enforcement point remains the
 * #1143 signing-time guard, which is unchanged.
 *
 * Everything below is DERIVED from the two constants in `core.ts` that the
 * signing path actually enforces. A second hand-maintained literal is the one
 * way this feature could become a lie, so there isn't one — including inside
 * the human-readable `instructions` string, which renders the same arrays.
 */

/**
 * Vendor-prefixed key under MCP's `capabilities.experimental`.
 *
 * `experimental` rather than the newer `extensions` field deliberately: both are
 * `Record<string, object>` in `@modelcontextprotocol/sdk@1.29`, but a client on
 * an older SDK parses the `initialize` result with a `ServerCapabilities` schema
 * that has no `extensions` key, and Zod's default object behaviour would strip
 * it. `experimental` has been in the schema since the beginning, so it survives
 * an old client — which is precisely the population this feature exists for.
 */
export const SIGNER_CAPABILITY_KEY = 'haven/signer-compatibility'

export interface SignerCompatibility {
  /** Expected-context versions this signer will verify (`SUPPORTED_X402_EXPECTED_VERSIONS`). */
  x402_expected_context_versions: number[]
  /** Sweep-binding versions this signer will verify (`SUPPORTED_SWEEP_BINDING_VERSIONS`). */
  sweep_binding_versions: number[]
  /**
   * #3271: `direct_sign_context_version`s this signer will fetch and verify
   * from `GET /payments/:id/sign-context` — derived from the SDK's
   * `DIRECT_SIGN_CONTEXT_VERSION` via `SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS`,
   * never a second literal.
   */
  direct_sign_context_versions: number[]
  /**
   * #3329: `task_sign_context_version`s this signer will fetch and verify
   * from `GET /task-budgets/:id/sign-context` — derived from
   * `SUPPORTED_TASK_SIGN_CONTEXT_VERSIONS`, never a second literal, same
   * discipline as `direct_sign_context_versions`.
   */
  task_sign_context_versions: number[]
  /**
   * #3506: `sub_budget_sign_context_version`s this signer will fetch and
   * verify from `GET /sub-budgets/:id/sign-context` — derived from
   * `SUPPORTED_SUB_BUDGET_SIGN_CONTEXT_VERSIONS`, never a second literal.
   * Additive: 0.7.0 already signed sub-budgets but did not say so here.
   */
  sub_budget_sign_context_versions: number[]
}

/** The supported sets this signer enforces, as a plain serialisable object. */
export function signerCompatibility(): SignerCompatibility {
  return {
    x402_expected_context_versions: [...SUPPORTED_X402_EXPECTED_VERSIONS],
    sweep_binding_versions: [...SUPPORTED_SWEEP_BINDING_VERSIONS],
    direct_sign_context_versions: [...SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS],
    task_sign_context_versions: [...SUPPORTED_TASK_SIGN_CONTEXT_VERSIONS],
    sub_budget_sign_context_versions: [...SUPPORTED_SUB_BUDGET_SIGN_CONTEXT_VERSIONS],
  }
}

/**
 * The machine-readable half: `capabilities.experimental['haven/signer-compatibility']`,
 * returned verbatim in the `initialize` result.
 *
 * `ServerCapabilities.experimental` is typed `z.record(z.string(), <any object>)`
 * and the SDK's `mergeCapabilities` deep-merges per top-level key, so declaring
 * this at construction survives the `tools` capability `McpServer` registers
 * when the first tool is added.
 */
export function signerCapabilityAdvertisement(): {
  experimental: Record<string, SignerCompatibility>
} {
  return { experimental: { [SIGNER_CAPABILITY_KEY]: signerCompatibility() } }
}

export interface SignerIdentity {
  /** The credential file's `agent_id`, or `HAVEN_AGENT_ID`; absent when neither is set. */
  agentId?: string
  /** The delegate key's address — always known, since the signer holds the key. */
  delegateAddress?: string
}

/**
 * #3738: the identity line. Once one harness carries several Haven pairs, the
 * model must keep hosted and signer calls inside one pair, and a server NAME
 * is not proof of that — `haven-research` and `haven-signer-research-2` are
 * easy to cross. Identity is: the hosted `haven_get_agent` returns `id` and
 * `delegateAddress`, and this line states what THIS signer is bound to, so
 * the model can compare the two before it signs. Neither value is a secret
 * (the consent block prints both). Advisory, like the rest of this string —
 * the signing path's own checks are unchanged.
 */
function signerIdentityLines(identity: SignerIdentity | undefined): string[] {
  if (!identity?.agentId && !identity?.delegateAddress) return []
  const agent = identity.agentId
    ? `agent id ${identity.agentId}`
    : 'no recorded agent id'
  const delegate = identity.delegateAddress ? ` and delegate address ${identity.delegateAddress}` : ''
  return [`This signer is bound to ${agent}${delegate}.`]
}

/**
 * The agent-readable half: MCP `instructions`, which clients surface to the
 * model. The machine-readable capability above is the precise statement, but
 * most agent runtimes never expose `capabilities.experimental` to the model —
 * this string is what actually reaches the reader who has to make the call.
 *
 * It names the same fix as #1143 so an agent that hits either surface — the
 * handshake here or the signing-time error there — tells the user the same
 * thing.
 *
 * Since #3738 it also states the agent id and delegate address this signer is
 * bound to, when `identity` is given.
 */
export function signerInstructions(identity?: SignerIdentity): string {
  const compatibility = signerCompatibility()
  return [
    'Haven edge signer: sign-only tools bound to the local delegate key. It never emits the',
    'key. Its one network capability is an authenticated READ of a signing context from',
    'Haven by payment_id — pass payment_id to haven_sign (preferred for both a direct payment,',
    '#3271, and delegation-rail x402) or haven_sign_x402 (x402 only) instead of relaying bulky',
    'typed-data payloads yourself.',
    '',
    ...signerIdentityLines(identity),
    'When more than one Haven pair is configured, you act as ONE agent per task: if the',
    'user has not said which (in the request, or a project-level choice they stated), ask',
    'before any payment tool. Sign only through the signer of the hosted server you called:',
    'haven-<slug> with haven-signer-<slug>, bare haven with haven-signer, Codex haven with',
    'haven_signer. Before signing, compare the identity this signer states with',
    'haven_get_agent (its id and delegateAddress) from that hosted server — the delegate',
    'address alone when this signer has no recorded agent id. If they differ, stop and sign',
    'nothing — switch to the signer whose identity matches.',
    '',
    'Version compatibility (check this BEFORE signing, not after):',
    `- x402 expected-context versions supported: ${compatibility.x402_expected_context_versions.join(', ')}`,
    `- sweep authorization binding versions supported: ${compatibility.sweep_binding_versions.join(', ')}`,
    `- direct-payment (haven_send / haven_pay) sign-context versions supported: ${compatibility.direct_sign_context_versions.join(', ')} — pass payment_id alone to haven_sign; this signer fetches the exact bytes`,
    `- task-budget sign-context versions supported: ${compatibility.task_sign_context_versions.join(', ')} — pass task_budget_id alone to haven_sign; this signer fetches the exact bytes`,
    `- sub-budget sign-context versions supported: ${compatibility.sub_budget_sign_context_versions.join(', ')} — pass sub_budget_id alone to haven_sign; this signer fetches the exact bytes (a sub-budget your owner issued narrows your own budget for another agent of your account)`,
    '',
    'Haven quote and prepare results report the expected-context version they will emit',
    '(signer_compatibility.x402_expected_context_version). If that version is not in the list',
    'above, this signer is out of date: STOP before signing, and tell the user to update',
    `@haven_ai/signer: run \`${connectorUpgradeCommand()}\`, then the repair line it prints,`,
    'which reinstalls the pinned MCP runtime. Do not edit the version field to a supported value — it is part of the',
    'Haven-signed binding message, so changing it invalidates the signature.',
    '',
    'A version-mismatch refusal from haven_sign / haven_sign_x402 / haven_sign_sweep_delegate is',
    'machine-readable, not just prose: it carries code, supported_versions, received_version, and',
    'fallback fields alongside the message, so you can branch on it directly. Every signer',
    'refusal also carries the next-step family: next_tool_name + next_tool_server_role when a',
    'hosted tool follows (resolve the role against your own server names — with several',
    'Haven pairs, the hosted server of THIS signer\'s pair), else',
    'next_tool_omitted_reason saying why not.',
    '',
    'An undeclared top-level argument is refused, not stripped: haven_sign answers',
    'UNSUPPORTED_ARGUMENT with unknown_arguments, signer_version and fallback (the update',
    'command) instead of dropping the key and answering the generic signing error — if you see',
    'that refusal, this signer predates the argument form you sent. Update the signer; nothing',
    'was signed, fetched or audited.',
  ].join('\n')
}
