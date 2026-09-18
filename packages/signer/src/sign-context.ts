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
import type { NextStep } from '@haven_ai/sdk'
import { nextStepWireFields, signerRefusalStep } from './next-step.js'

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
  /**
   * #3001 / #3010 review: the recovery path, when signing OTHER bytes is
   * actually a remedy — a transport failure (timeout, unreachable) or a
   * body this signer could not read. `typed_data_b64` is NOT in the default
   * quote result since #1272: obtain it by re-running the SAME quote tool
   * with the SAME idempotency_key plus `include_signing_payload: true`.
   * Absent on a backend REFUSAL: an expired, executed or unsignable intent
   * cannot be rescued by re-signing its bytes.
   */
  readonly fallback?: 'typed_data_b64'
  /**
   * #3001: `AgentPaymentNextAction` values the signer already emits — the
   * version-mismatch refusal's `stop_and_tell_user` for the classes where
   * retrying the same call cannot help, and `payment_window_expired` (with
   * `retry_with_new_quote`) for the backend's 410 `expired`, exactly as the
   * plain `HavenError` branch already does for that code.
   */
  readonly next_action: string
  /**
   * #3103 (epic #3105, decisions 1 and 3): the typed next step beside the
   * action. A refusal Haven made (`SIGN_CONTEXT_REFUSED`, not expired) names
   * the hosted status read with the payment id; a transport failure or a
   * malformed body names no tool — the remedy is re-running the SAME quote
   * tool with `include_signing_payload: true` — and an expired window names
   * none either (which quote tool depends on the flow). Never null: a step
   * with no tool carries `next_tool_omitted_reason`. Additive on a published
   * error shape.
   */
  readonly next_tool?: string
  readonly next_tool_server?: string
  readonly next_tool_name?: string
  readonly next_tool_server_role?: 'hosted' | 'signer'
  readonly next_arguments?: Record<string, unknown>
  readonly next_tool_omitted_reason?: string
  readonly retry_with_new_quote?: true
  /** Present only for `SIGN_CONTEXT_REFUSED` (the backend's HTTP status). */
  readonly http_status?: number
  /** Present only for `SIGN_CONTEXT_REFUSED`: the backend's own `error_code`. */
  readonly backend_error_code?: string

  constructor(
    message: string,
    code: SignContextErrorCode,
    refusal?: { httpStatus: number; errorCode?: string },
    /** #3103: the payment the context was fetched for, so a refusal can name the status read. */
    paymentId?: string,
  ) {
    super(message)
    ;(this as { code: string }).code = code
    this.name = 'HavenSignContextError'
    let step: NextStep
    if (code === 'SIGN_CONTEXT_REFUSED') {
      this.http_status = refusal?.httpStatus
      this.backend_error_code = refusal?.errorCode
      if (refusal?.httpStatus === 410 || refusal?.errorCode === 'expired') {
        this.next_action = AgentPaymentNextAction.PaymentWindowExpired
        this.retry_with_new_quote = true
        step = signerRefusalStep({
          nextAction: AgentPaymentNextAction.PaymentWindowExpired,
          nextTool: null,
          nextToolOmittedReason:
            're-run the hosted quote tool you called with the same idempotency_key; which one depends on the flow',
        })
      } else {
        this.next_action = AgentPaymentNextAction.StopAndTellUser
        step = paymentId
          ? signerRefusalStep({
              nextAction: AgentPaymentNextAction.StopAndTellUser,
              nextTool: 'haven_get_payment_status',
              nextArguments: { payment_id: paymentId },
            })
          : signerRefusalStep({
              nextAction: AgentPaymentNextAction.StopAndTellUser,
              nextTool: null,
              nextToolOmittedReason: 'Haven refused the signing context and no payment_id is known here; tell the user what it said',
            })
      }
    } else {
      this.fallback = 'typed_data_b64'
      this.next_action = AgentPaymentNextAction.StopAndTellUser
      step = signerRefusalStep({
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        nextTool: null,
        nextToolOmittedReason:
          're-run the SAME hosted quote tool with the same idempotency_key and include_signing_payload: true, then pass its typed_data_b64 to this signer',
      })
    }
    Object.assign(this, nextStepWireFields(step))
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
      undefined,
      paymentId,
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
      undefined,
      paymentId,
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
      { httpStatus: response.status, errorCode: typeof body.error_code === 'string' ? body.error_code : undefined },
      paymentId,
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
      undefined,
      paymentId,
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
