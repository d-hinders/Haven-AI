import {
  SUPPORTED_SWEEP_BINDING_VERSIONS,
  SUPPORTED_X402_EXPECTED_VERSIONS,
} from './core.js'

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
 * introspect the other. The signer's single Haven call (#1263, the read-only
 * `GET /x402/:payment_id/sign-context` in `sign-context.ts`) does not help
 * here: it fetches one payment's signing bytes, not the hosted server's
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
}

/** The supported sets this signer enforces, as a plain serialisable object. */
export function signerCompatibility(): SignerCompatibility {
  return {
    x402_expected_context_versions: [...SUPPORTED_X402_EXPECTED_VERSIONS],
    sweep_binding_versions: [...SUPPORTED_SWEEP_BINDING_VERSIONS],
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

/**
 * The agent-readable half: MCP `instructions`, which clients surface to the
 * model. The machine-readable capability above is the precise statement, but
 * most agent runtimes never expose `capabilities.experimental` to the model —
 * this string is what actually reaches the reader who has to make the call.
 *
 * It names the same fix as #1143 so an agent that hits either surface — the
 * handshake here or the signing-time error there — tells the user the same
 * thing.
 */
export function signerInstructions(): string {
  const compatibility = signerCompatibility()
  return [
    'Haven edge signer: sign-only tools bound to the local delegate key. It never emits the',
    'key. Its one network capability is an authenticated READ of a signing context from',
    'Haven by payment_id — pass payment_id to haven_sign / haven_sign_x402 (preferred for',
    'delegation-rail x402) instead of relaying bulky typed-data payloads yourself.',
    '',
    'Version compatibility (check this BEFORE signing, not after):',
    `- x402 expected-context versions supported: ${compatibility.x402_expected_context_versions.join(', ')}`,
    `- sweep authorization binding versions supported: ${compatibility.sweep_binding_versions.join(', ')}`,
    '',
    'Haven quote and prepare results report the expected-context version they will emit',
    '(signer_compatibility.x402_expected_context_version). If that version is not in the list',
    'above, this signer is out of date: STOP before signing, and tell the user to update',
    '@haven_ai/signer by rerunning `npx @haven_ai/connect@alpha`, which reinstalls the pinned',
    'MCP runtime. Do not edit the version field to a supported value — it is part of the',
    'Haven-signed binding message, so changing it invalidates the signature.',
    '',
    'A version-mismatch refusal from haven_sign / haven_sign_x402 / haven_sign_sweep_delegate is',
    'machine-readable, not just prose: it carries code, supported_versions, received_version, and',
    'fallback fields alongside the message, so you can branch on it directly.',
  ].join('\n')
}
