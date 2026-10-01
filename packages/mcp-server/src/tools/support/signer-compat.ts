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
import {
  DIRECT_SIGN_CONTEXT_VERSION,
  TASK_SIGN_CONTEXT_VERSION,
  signerUpdateFallback,
} from '@haven_ai/sdk'
import { HOSTED_CONNECTOR_CHANNEL, hostedConnectorUpgradeCommand } from '../../connector-channel.js'

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
 * #3419: the first `@haven_ai/signer` release whose `haven_sign` accepts the
 * `task_budget_id` argument form (`0.6.0-alpha.0`, #3329). ONE exported
 * constant — the hosted handoff, its cross-package pin
 * (`hosted-signer-integration.test.ts`) and the release-note tie test all
 * import this, never a literal, so the next form's floor has one place to
 * land.
 *
 * Not a floor the hosted side ENFORCES (it cannot see the signer): it is the
 * version a working `haven_sign { task_budget_id }` requires, reported as
 * data in `signer_compatibility.min_signer_version`.
 */
export const TASK_BUDGET_MIN_SIGNER_VERSION = '0.6.0-alpha.0'

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
      'The signer enforces this version itself: on its version-mismatch refusal ' +
      '(code/supported_versions/fallback), STOP before signing again and update @haven_ai/signer ' +
      `by running \`${hostedConnectorUpgradeCommand()}\`, then the repair line it prints. Never edit the version — it is Haven-signed, ` +
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
 * for the one failure a signer can produce on that call: it answers
 * `haven_sign({ payment_id })` with the structured refusal
 * `SIGN_CONTEXT_REFUSED` + `backend_error_code: 'sign_context_unavailable'`
 * (its x402-context fetch hit the backend's 409, `sign-context.ts` /
 * `x402/sign-context.ts`) having signed NOTHING. The codes named in the text
 * are pinned to the signer's real emission by `hosted-signer-integration.test.ts`
 * (cross-package).
 *
 * Owner decision on #3495 (2026-09-30, superseding #3277 AC2 "the relay
 * fields stay"): `haven_send` / `haven_pay` results are compact by default,
 * so this notice can no longer say "sign through the relay fields THIS
 * result already carries" — there are none. The route is now a same-
 * `idempotency_key` re-run of the SAME tool with `include_signing_payload:
 * true` (the #1272 opt-in, mirrored here): the backend replays the stored
 * payment on that key, never creating a second intent, PROVIDED the re-run
 * repeats the original token/amount/recipient/task_budget_id/sub_budget_id
 * or it answers 409. That re-run's own result then carries the relay pair to
 * sign. Never `{ payload_hash }` alone — a signer predating #3169's
 * bare-hash refusal signs it raw and the account rejects it on-chain (AA24).
 *
 * Review correction (round 1, 2026-09-30): the TRIGGER is two DISTINCT
 * shapes, not one conflated refusal. A currently-published `@haven_ai/signer`
 * (0.5.0-alpha.1 through the current release, `sign-context.ts`) sets
 * `fallback: 'typed_data_b64'` ONLY on `SIGN_CONTEXT_TIMEOUT`,
 * `SIGN_CONTEXT_UNREACHABLE`, `SIGN_CONTEXT_MALFORMED`, or
 * `SIGN_CONTEXT_REFUSED` with `http_status: 404` (an older BACKEND with no
 * direct route) — it NEVER sets `fallback` on `SIGN_CONTEXT_REFUSED` +
 * `backend_error_code: 'sign_context_unavailable'`; that combination, with NO
 * `fallback` field, is what a signer PREDATING #3271 produces instead (it has
 * no direct-fetch fallback of its own to try, so its x402-only fetch's 409
 * is the terminal state). Both cases signed nothing and both recover through
 * the same opt-in re-run, so the check/fallback text below routes on either,
 * named separately rather than merged into one (wrong) trigger.
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
      "by payment_id. If haven_sign refuses that call — carrying fallback: 'typed_data_b64' (any " +
      'code: a transport failure, a malformed body, or a 404 on an older backend), or code ' +
      "SIGN_CONTEXT_REFUSED with backend_error_code 'sign_context_unavailable' from a signer " +
      'older than 0.5.0-alpha.1 — nothing was signed either way: re-run the SAME haven_send / haven_pay ' +
      'call with the SAME idempotency_key (echoed on its result) plus include_signing_payload: ' +
      'true — repeating the same token/amount/recipient/task_budget_id/sub_budget_id, or it ' +
      'answers 409 — then sign through the relay: call haven_sign with { payload_hash, ' +
      `typed_data_b64 } from THAT re-run result, passed through unchanged, then update the connector by running \`${hostedConnectorUpgradeCommand()}\` and the repair line it prints.`,
    // The same recovery sentence as structured data, mirroring the #1309
    // pattern on the x402 notice above: prose to read, data to route on.
    fallback:
      "haven_sign refused this call — fallback: 'typed_data_b64' (any code), or " +
      "SIGN_CONTEXT_REFUSED / sign_context_unavailable from a signer older than 0.5.0-alpha.1 — and signed " +
      'nothing either way: re-run the SAME haven_send / haven_pay call with the SAME ' +
      'idempotency_key plus include_signing_payload: true, then call haven_sign again with ' +
      '{ payload_hash, typed_data_b64 } from that re-run result, unchanged, ' +
      `then update the connector by running \`${hostedConnectorUpgradeCommand()}\` and the repair line it prints.`,
  }
}

/**
 * #3419: the task-budget (`haven_open_task_budget` / `haven_close_task_budget`)
 * twin of the two notices above. A task-budget handoff names
 * `haven_sign { task_budget_id }`, and every signer older than
 * `TASK_BUDGET_MIN_SIGNER_VERSION` predates that argument form: the MCP SDK
 * validates the call against the tool's registered schema and hands the
 * handler the STRIPPED object (#2312's mechanism, on the signer this time),
 * so the key vanishes silently and the handler answers the generic
 * `SIGNING_ERROR` "Pass payment_id … or payload_hash." — a refusal that says
 * nothing about the version and follows a fetch that never happened. Unlike
 * the direct-payment case there is NO relay fallback: a task-budget context
 * is an `eip712_delegation` signing payload the 0.5.x unbound allowlist
 * refuses and a 0.4.x signer must not be steered into, so the only recovery
 * is to update — after releasing the pending budget this result reserved.
 *
 * This notice stays ADVISORY for the same reason as the x402 one: the hosted
 * server cannot see the signer, so it reports what the backend emits and the
 * recovery route, and the signer enforces its own versions.
 *
 * `task_sign_context_version` is `TASK_SIGN_CONTEXT_VERSION` from
 * `@haven_ai/sdk` (`userop-binding.ts`) — the same constant the backend's
 * `GET /task-budgets/:id/sign-context` route is versioned against and the
 * signer's `SUPPORTED_TASK_SIGN_CONTEXT_VERSIONS` derives from — never
 * re-derived here.
 */
export function taskSignerCompatibilityNotice() {
  return {
    task_sign_context_version: TASK_SIGN_CONTEXT_VERSION,
    min_signer_version: TASK_BUDGET_MIN_SIGNER_VERSION,
    signer_capability: SIGNER_CAPABILITY_KEY,
    check:
      'Call next_tool with next_arguments EXACTLY as given — the signer fetches the exact bytes ' +
      'by task_budget_id. If haven_sign answers SIGNING_ERROR with a message starting "Pass ' +
      "payment_id (preferred for delegation-rail x402\", the signer predates task budgets and signed " +
      'nothing: first close this budget with haven_close_task_budget { task_budget_id } to release ' +
      `it, then update the connector by running \`${hostedConnectorUpgradeCommand()}\` and the repair ` +
      'line it prints, then open the budget again.',
    // The same recovery sentence as structured data, mirroring the #1309
    // pattern on the notices above: prose to read, data to route on. No relay
    // fallback exists for this shape (see above), so the data says so too.
    fallback:
      'haven_sign answered SIGNING_ERROR with a message starting "Pass payment_id (preferred for ' +
      'delegation-rail x402" — the signer predates task budgets and signed nothing: call ' +
      'haven_close_task_budget { task_budget_id } to release the pending budget, then update the ' +
      `connector by running \`${hostedConnectorUpgradeCommand()}\` and the repair line it prints, ` +
      'then open the budget again. There is no relay fallback for this signing context.',
  }
}
