/**
 * Byte-free signing handoff (#1263): fetch a delegation-rail x402 intent's
 * EXACT signing payload from Haven by `payment_id`, instead of asking a
 * language model to re-emit multi-KB EIP-712 bytes between tool calls (the
 * #1255 failure mode — runtimes that elide long tool results structurally
 * cannot copy them).
 *
 * Layering: this module lives in the local MCP SERVER layer, not the signer
 * core. The core (`core.ts`) remains pure and network-free; what it signs
 * still goes through the SAME digest re-derivation and Haven-binding
 * verification (#1138) whether the bytes arrived by tool argument or by this
 * fetch. The fetch is a strictly better byte source than model relay — TLS to
 * Haven versus a model's context window — and it uses the agent credential
 * (`identity.json`) the connector already stores next to the signer
 * credential. The delegate key is never sent anywhere.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AgentPaymentNextAction, HavenSigningError } from '@haven_ai/sdk'

export interface HavenIdentity {
  apiUrl: string
  apiKey: string
}

/**
 * Signer-local refusal codes for `fetchX402SignContext` (#3001). Distinct from
 * `AgentPaymentFailureCode` on purpose — these describe a signing-context FETCH
 * failure (network/timeout/backend-refusal/shape), never a payment-domain
 * outcome, and they never reach the backend's REST/OpenAPI surface, only this
 * package's MCP tool responses. Same reasoning `SignerRefusalCode` documents
 * for the version-mismatch pair.
 */
export type SignContextErrorCode =
  | 'SIGN_CONTEXT_TIMEOUT'
  | 'SIGN_CONTEXT_UNREACHABLE'
  | 'SIGN_CONTEXT_REFUSED'
  | 'SIGN_CONTEXT_MALFORMED'

/**
 * Structured refusal for every throw site in `fetchX402SignContext` (#3001,
 * follow-up from the #2985/#2986 review). Before this, every one of these —
 * timeout, unreachable host, a non-ok backend response (404/410/…), a
 * malformed body — reached the wire as prose inside the generic
 * `{ code: 'SIGNING_ERROR' }` `HavenSigningError` produces, so an agent had to
 * parse a sentence to learn "pass typed_data_b64 instead". The version-mismatch
 * refusal (`HavenUnsupportedSignerVersionError`) already carries `code`,
 * `fallback`, `next_action` as DATA; this mirrors that shape for the
 * sign-context fetch.
 *
 * Extends `HavenSigningError` so every existing `instanceof HavenSigningError`
 * catch site keeps matching unchanged. `code` is inherited as `readonly` from
 * `HavenError` and hard-coded to `'SIGNING_ERROR'` by `HavenSigningError`'s own
 * constructor — TypeScript only lets the class that DECLARES a readonly
 * property assign it, so the override below goes through a narrow cast rather
 * than widening `HavenSigningError`'s constructor (these codes are
 * signer-local, not part of the shared `@haven_ai/sdk` error taxonomy, so that
 * type does not belong there).
 */
export class HavenSignContextError extends HavenSigningError {
  declare readonly code: SignContextErrorCode
  /** #3001: the one recovery path every sign-context refusal names. */
  readonly fallback = 'typed_data_b64' as const
  /**
   * #3001: reuses the same `AgentPaymentNextAction` value the version-mismatch
   * refusal emits (`tools.ts` `normalizeError`) rather than inventing a
   * parallel vocabulary — a sign-context fetch failure is the same shape of
   * problem: stop, don't retry the exact same call, tell the user the
   * fallback.
   */
  readonly next_action: string = AgentPaymentNextAction.StopAndTellUser
  /** Present only for `SIGN_CONTEXT_REFUSED` (the backend's HTTP status). */
  readonly http_status?: number

  constructor(message: string, code: SignContextErrorCode, httpStatus?: number) {
    super(message)
    ;(this as { code: string }).code = code
    this.http_status = httpStatus
    this.name = 'HavenSignContextError'
  }
}

/**
 * Resolve the agent identity from `identity.json` in the same directory as
 * the signer credential file. Returns null (never throws) when unavailable —
 * the caller decides how to phrase the fallback.
 */
export async function loadHavenIdentity(
  credentialsPath: string | undefined,
): Promise<HavenIdentity | null> {
  if (!credentialsPath) return null
  try {
    const raw = JSON.parse(
      await readFile(join(dirname(credentialsPath), 'identity.json'), 'utf8'),
    ) as Record<string, unknown>
    const apiKey = typeof raw.api_key === 'string' ? raw.api_key : undefined
    const apiUrl = typeof raw.api_url === 'string' ? raw.api_url : undefined
    if (!apiKey || !apiUrl) return null
    return { apiKey, apiUrl: apiUrl.replace(/\/+$/, '') }
  } catch {
    return null
  }
}

export interface FetchedSignContext {
  paymentId: string
  payloadHash: string
  typedData: Record<string, unknown>
  /** The COMPLETE snake_case expected context, verbatim from Haven. */
  x402Expected: Record<string, unknown>
  /**
   * #1355: the 402 PaymentRequired persisted at authorize time, when the
   * backend carries it — lets haven_sign_x402 build the merchant header from
   * `{ payment_id }` alone. Null on pre-#1355 backends/rows; the caller then
   * requires the agent-supplied copy. Untrusted like every other fetched
   * field: header building verifies it against the Haven-signed expected
   * context either way.
   */
  paymentRequired: Record<string, unknown> | null
}

/**
 * GET /x402/:id/sign-context. Read-only; refusals from the backend
 * (expired/executed/legacy/unknown) surface as clear signing errors that name
 * the next step. The returned payload is UNTRUSTED input exactly like a tool
 * argument would be — the signing path's binding verification and digest
 * equality are what make it safe to use, not its provenance.
 */
/**
 * #2985: the signer's ONLY network call is bounded. Without a signal a hung
 * `/sign-context` (half-open connection, stalled backend) hung the signer
 * tool call — and so the agent — indefinitely while the funding window ran
 * out, and the `typed_data_b64` fallback the error names was unreachable
 * because the call never returned. 15 s is generous for a single
 * authenticated read and sits well under the 60 s floor of the x402
 * settlement window (`clamp(maxTimeoutSeconds, 60, 600)` backend-side).
 */
export const SIGN_CONTEXT_TIMEOUT_MS = 15_000

export async function fetchX402SignContext(
  identity: HavenIdentity,
  paymentId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = SIGN_CONTEXT_TIMEOUT_MS,
): Promise<FetchedSignContext> {
  let response: Response
  try {
    response = await fetchImpl(
      `${identity.apiUrl}/x402/${encodeURIComponent(paymentId)}/sign-context`,
      {
        headers: { Authorization: `Bearer ${identity.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
    )
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new HavenSignContextError(
      timedOut
        ? `Haven did not answer the signing-context fetch for ${paymentId} within ${timeoutMs} ms. ` +
          'Retry, or pass typed_data_b64 from the quote result instead.'
        : `Could not reach Haven to fetch the signing context for ${paymentId}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'Retry, or pass typed_data_b64 from the quote result instead.',
      timedOut ? 'SIGN_CONTEXT_TIMEOUT' : 'SIGN_CONTEXT_UNREACHABLE',
    )
  }
  // #2985 review: the same signal bounds the BODY read. A stalled body used
  // to be swallowed by the `.catch(() => ({}))` and misdiagnosed as a
  // malformed/older backend response — name the timeout instead.
  let body: Record<string, unknown>
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new HavenSignContextError(
        `Haven did not finish sending the signing context for ${paymentId} within ${timeoutMs} ms. ` +
          'Retry, or pass typed_data_b64 from the quote result instead.',
        'SIGN_CONTEXT_TIMEOUT',
      )
    }
    body = {}
  }
  if (!response.ok) {
    const detail =
      typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
    throw new HavenSignContextError(
      `Haven refused the signing-context fetch for ${paymentId}: ${detail}` +
        (response.status === 404
          ? ' — check the payment_id came from this agent’s own quote.'
          : response.status === 410
            ? ' Re-run the quote with the same idempotency key, then sign the fresh payment_id.'
            : ''),
      'SIGN_CONTEXT_REFUSED',
      response.status,
    )
  }
  const signData = body.sign_data as Record<string, unknown> | undefined
  const x402Expected = body.x402_expected as Record<string, unknown> | undefined
  if (
    !signData ||
    typeof signData.hash !== 'string' ||
    !signData.typed_data ||
    typeof signData.typed_data !== 'object' ||
    !x402Expected
  ) {
    throw new HavenSignContextError(
      'The Haven sign-context response is missing sign_data.typed_data or x402_expected — ' +
        'the backend may predate #1263. Pass typed_data_b64 from the quote result instead.',
      'SIGN_CONTEXT_MALFORMED',
    )
  }
  const paymentRequired = body.payment_required
  return {
    paymentId: String(body.payment_id ?? paymentId),
    payloadHash: signData.hash,
    typedData: signData.typed_data as Record<string, unknown>,
    x402Expected,
    paymentRequired:
      paymentRequired && typeof paymentRequired === 'object' && !Array.isArray(paymentRequired)
        ? (paymentRequired as Record<string, unknown>)
        : null,
  }
}
