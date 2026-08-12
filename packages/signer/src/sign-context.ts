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
import { HavenSigningError } from '@haven_ai/sdk'

export interface HavenIdentity {
  apiUrl: string
  apiKey: string
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
export async function fetchX402SignContext(
  identity: HavenIdentity,
  paymentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedSignContext> {
  let response: Response
  try {
    response = await fetchImpl(
      `${identity.apiUrl}/x402/${encodeURIComponent(paymentId)}/sign-context`,
      { headers: { Authorization: `Bearer ${identity.apiKey}` } },
    )
  } catch (err) {
    throw new HavenSigningError(
      `Could not reach Haven to fetch the signing context for ${paymentId}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'Retry, or pass typed_data_b64 from the quote result instead.',
    )
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const detail =
      typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
    throw new HavenSigningError(
      `Haven refused the signing-context fetch for ${paymentId}: ${detail}` +
        (response.status === 404
          ? ' — check the payment_id came from this agent’s own quote.'
          : response.status === 410
            ? ' Re-run the quote with the same idempotency key, then sign the fresh payment_id.'
            : ''),
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
    throw new HavenSigningError(
      'The Haven sign-context response is missing sign_data.typed_data or x402_expected — ' +
        'the backend may predate #1263. Pass typed_data_b64 from the quote result instead.',
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
