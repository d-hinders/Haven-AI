/**
 * Shared hosted-MCP support — signer compatibility notice (#1155/#1309).
 *
 * Extracted VERBATIM from `tools.ts` by #2808 (behavior-preserving move).
 * The notice rides every quote/prepare result (`buildX402SigningContext`),
 * which spans more than one planned capability slice (#2809–#2812), so the
 * constant and the builder live in shared support — never copied.
 *
 * One-direction dependencies: imports only the SDK and the connector channel.
 * Never imports a capability module.
 */
import { DIRECT_SIGN_CONTEXT_VERSION, signerUpdateFallback } from '@haven_ai/sdk'
import { HOSTED_CONNECTOR_CHANNEL, hostedConnectorRerunCommand } from '../../connector-channel.js'

/**
 * The `capabilities.experimental` key the local signer advertises its supported
 * expected-context versions under (#1155).
 *
 * Spelled out rather than imported: `@haven_ai/signer` is a devDependency here,
 * and the hosted server is keyless — it must not take a runtime dependency on
 * the signing package. One constant, referenced by every agent-facing surface
 * that names it, so a rename on the signer side has a single place to land;
 * `hosted-signer-integration.test.ts` imports both packages and pins this to
 * the signer's exported `SIGNER_CAPABILITY_KEY`.
 */
export const SIGNER_CAPABILITY_KEY = 'haven/signer-compatibility'

/**
 * The pre-payment half of #1155: what this quote will emit, plus the instruction
 * to compare it against the local signer.
 *
 * Carried in-band on the quote result rather than left to the tool description
 * alone. The description is read once when the tool list loads; this travels
 * with the number it is about to be compared to, so an agent that never reads
 * descriptions still has the warning in front of it at the moment it matters.
 *
 * The version is read from the binding Haven signed rather than re-derived, and
 * is required on that binding — there is deliberately no "unknown" fallback,
 * which would imply a state the type does not allow and give the agent a null
 * to compare against.
 *
 * **This shape is the stable machine-readable compatibility contract (#1309
 * acceptance: "hosted MCP quote/preflight responses surface compatibility
 * requirements in a stable field").** It was already sufficient going into
 * #1309 — `x402_expected_context_version` is the number to compare,
 * `signer_capability` names where the signer advertises its side, and `check`
 * carries the human-readable instruction. The one genuine gap was that the fix
 * lived ONLY inside that prose; `fallback` below closes it by carrying the same
 * recovery text as data, sourced from the same `SIGNER_UPDATE_FALLBACK`
 * constant the signer's own structured refusal uses (`core.ts`,
 * `assertSupportedBindingVersion`, #1309), so an agent that reads either
 * surface gets byte-identical guidance. Do not rename or remove existing
 * fields without treating it as a breaking change to this contract.
 *
 * This notice stays ADVISORY (owner decision, 2026-08-07, unchanged by
 * #1309): hosted MCP never sees the local signer's `initialize` handshake, so
 * it cannot know whether `emittedVersion` is actually unsupported — only the
 * agent, which sees both sides, can compare them. The `fallback` field
 * therefore names the fix for the case this notice CAN detect (an
 * out-of-date signer), not a refusal of the quote itself. The signer's own
 * signing-time refusal (structured since #1309, see `assertSupportedBindingVersion`
 * in `@haven_ai/signer`) remains the only place an unsupported version is
 * actually enforced.
 */
// Exported for `connector-channel.test.ts` (#2423), which asserts the
// deployment's channel reaches this notice. The existing coverage runs through
// `haven_pay_x402_quote`; that path cannot be re-entered under a different
// environment without reloading this whole module, so the guard calls the
// builder directly. mcp-server is deployed, not published, so this widens no
// npm surface.
export function signerCompatibilityNotice(emittedVersion: number) {
  return {
    x402_expected_context_version: emittedVersion,
    signer_capability: SIGNER_CAPABILITY_KEY,
    // #1549: one compact statement instead of the former essay — this notice
    // rides EVERY quote/prepare result, so its prose is per-purchase token
    // cost. The machine fields above/below are the contract (#1309); the
    // enforcement story lives in the tool descriptions and the signer's own
    // structured refusal.
    check:
      'The signer enforces this version itself (#1547): on its version-mismatch refusal ' +
      '(code/supported_versions/fallback), STOP before signing again and update @haven_ai/signer ' +
      `by rerunning \`${hostedConnectorRerunCommand()}\`. Never edit the version — it is Haven-signed, ` +
      'so changing it invalidates the signature. Nothing has been spent at this point.',
    // #1309: the SAME recovery guidance as `check` above, as structured data
    // instead of prose to parse — and the SAME string
    // `assertSupportedBindingVersion` in `@haven_ai/signer` puts on its
    // structured refusal's `fallback` field when this version turns out to be
    // unsupported. Single source: `signerUpdateFallback` in `@haven_ai/sdk` —
    // the same sentence, rendered for THIS deployment's connector channel
    // (#2423) rather than the SDK build's, because a hosted server is deployed
    // per environment while the signer is published per release.
    fallback: signerUpdateFallback(HOSTED_CONNECTOR_CHANNEL),
  }
}

/**
 * #3277: the direct-payment (`haven_send` / `haven_pay`) twin of
 * `signerCompatibilityNotice` above. The hosted server cannot see the local
 * signer's `initialize` handshake, so it cannot gate the handoff on advertised
 * support — and per the #1547 lesson it must not ask the agent to compare a
 * version against `initialize` instructions either (most agent harnesses
 * cannot read an `initialize` result). Instead the result always names the
 * byte-free `payment_id` handoff, and this notice carries the RECOVERY route
 * for the one failure a pre-#3271 signer can produce: it answers
 * `haven_sign({ payment_id })` with the structured refusal
 * `SIGN_CONTEXT_REFUSED` + `backend_error_code: 'sign_context_unavailable'`
 * (its x402-context fetch hit the backend's 409, `sign-context.ts` /
 * `x402/sign-context.ts`) having signed NOTHING — so re-signing through the
 * relay fields this result already carries is safe. The codes named in the
 * text are pinned to the signer's real emission by
 * `hosted-signer-integration.test.ts` (cross-package).
 *
 * `direct_sign_context_version` is `DIRECT_SIGN_CONTEXT_VERSION` from
 * `@haven_ai/sdk` (`userop-binding.ts`) — the same constant the backend's
 * `GET /payments/:id/sign-context` route is versioned against — never
 * re-derived here.
 */
export function directSignerCompatibilityNotice() {
  return {
    direct_sign_context_version: DIRECT_SIGN_CONTEXT_VERSION,
    signer_capability: SIGNER_CAPABILITY_KEY,
    check:
      'Call next_tool with next_arguments EXACTLY as given — the signer fetches the exact bytes ' +
      'by payment_id. If haven_sign refuses with code SIGN_CONTEXT_REFUSED and backend_error_code ' +
      "'sign_context_unavailable' (a pre-#3271 signer: it signed nothing), sign through the relay " +
      'instead: call haven_sign with { payload_hash, typed_data_b64 } from THIS result, passed ' +
      `through unchanged, then update the connector by rerunning \`${hostedConnectorRerunCommand()}\`.`,
    // The same recovery sentence as structured data, mirroring the #1309
    // pattern on the x402 notice above: prose to read, data to route on.
    fallback:
      'haven_sign refused SIGN_CONTEXT_REFUSED / sign_context_unavailable and signed nothing: call ' +
      'haven_sign again with { payload_hash, typed_data_b64 } from the payment result, unchanged, ' +
      `then update the connector by rerunning \`${hostedConnectorRerunCommand()}\`.`,
  }
}
