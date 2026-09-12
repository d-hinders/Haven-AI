/**
 * Shared hosted-MCP support — MCP transport serialization, merchant-call
 * context validation, merchant delivery, and the expiry-aware signing context.
 *
 * Extracted VERBATIM from `tools.ts` by #2808 (behavior-preserving move; doc
 * comments moved with the code they explain). These helpers are called from
 * handler bodies in more than one planned capability slice (#2809–#2812):
 * the transport/context validation is the #2282/#2283 fail-closed seam, the
 * delivery helper is the #1300/#1508 merchant leg, and the signing context is
 * the #1138/#1155 local-signer handoff — so they live in shared support,
 * never copied.
 *
 * One-direction dependencies: imports the SDK, the #2807 contract seam, the
 * connector channel, and sibling support modules only. Never imports a
 * capability module.
 */
import {
  AgentPaymentNextAction,
  HavenApiError,
  X402UnexpectedStatusError,
  HavenClient,
  discoverMerchantMcpUrl,
  sameUrl,
  type X402McpTransport,
  type X402Quote,
} from '@haven_ai/sdk'
import { MCP_TRANSPORT_CASE_HINT } from '../contracts.js'
import { signerCompatibilityNotice } from './signer-compat.js'
import { HostedToolError, paymentWindowExpiredErrorFor } from './errors.js'

/**
 * #1254: the delegation-rail signing fields, forwarded VERBATIM whenever the
 * backend sent them. The x402 quote path always did this; the direct
 * haven_pay/haven_send path dropped them — so the local signer raw-signed the
 * userOp hash and the Hybrid account rejected it at validation (AA24). One
 * helper now, so a future surface cannot re-make the mistake by omission.
 */
export function delegationSignFields(signData: {
  signature_scheme?: string
  typed_data?: Record<string, unknown>
}): Record<string, unknown> {
  return signData.signature_scheme
    ? {
        signature_scheme: signData.signature_scheme,
        typed_data: signData.typed_data,
        // #1255: the same payload as ONE opaque base64 string. A redemption
        // UserOp's callData makes typed_data a multi-KB nested object, and an
        // agent re-emitting it between tool calls can truncate or reshape it —
        // the signer's digest check then refuses (correctly) and the payment
        // dies with no defect anywhere in the chain. The b64 form is copied
        // as a single string; the signer decodes it into the SAME digest
        // verification, so transport gets safer while the trust model is
        // unchanged.
        ...(signData.typed_data
          ? {
              typed_data_b64: Buffer.from(JSON.stringify(signData.typed_data)).toString('base64'),
            }
          : {}),
      }
    : {}
}

/** The probe failure shape that means "this URL is not the MCP endpoint". */
export function isMerchantEndpointMiss(err: unknown): boolean {
  // #1300: the typed class is authoritative; the message check keeps the
  // predicate working against an older bundled SDK during version skew.
  if (err instanceof X402UnexpectedStatusError) return true
  return (
    err instanceof HavenApiError &&
    (err.message.includes('Expected an x402 quote response') ||
      (typeof err.body === 'object' &&
        err.body != null &&
        'mcpSessionNotEstablished' in err.body &&
        err.body.mcpSessionNotEstablished === true))
  )
}

/**
 * Keep the original probe error authoritative, but tell the agent what
 * discovery tried — the pre-#1271 failure mode was silent hand-probing.
 */
export function withDiscoveryGuidance(err: unknown, merchantUrl: string, discovered: string | null): unknown {
  if (!(err instanceof HavenApiError)) return err
  const guidance = discovered
    ? `Same-origin discovery resolved the same URL (${discovered}), which still did not answer 402.`
    : `No same-origin discovery document was found at /.well-known/haven-demo-merchant or /. ` +
      `If ${merchantUrl} is a base merchant URL, pass the exact MCP endpoint instead (often <origin>/mcp).`
  return new HavenApiError(`${err.message} ${guidance}`, err.statusCode ?? 400)
}

/**
 * Build the MCP tools/call envelope, probe the merchant, and run the #1271
 * bounded same-origin discovery fallback on a non-402 miss (one retry, at
 * the discovered endpoint only). Shared by the generic/catalog quote and pay
 * tools — the callers differ only in whether they construct an intent after
 * this read and where merchantUrl/toolName/toolArguments came from.
 */
export async function quoteMcpToolCall(
  haven: HavenClient,
  input: {
    merchantUrl: string
    toolName: string
    toolArguments: Record<string, unknown>
    idempotencyKey?: string
  },
): Promise<{ quote: X402Quote; merchantUrl: string }> {
  const envelope = {
    jsonrpc: '2.0',
    id: `haven-mcp-${Date.now()}`,
    method: 'tools/call',
    params: {
      name: input.toolName,
      arguments: input.toolArguments,
    },
  }
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  }
  let merchantUrl = input.merchantUrl
  // This is an MCP-tool purchase, so always negotiate the Streamable-HTTP
  // lifecycle before its unpaid tools/call — exact MCP endpoints can use any
  // same-origin path, not only `/mcp`. A base URL that cannot establish a
  // session is treated as a bounded #1271 discovery miss; it never receives a
  // bare tools/call probe.
  const probe = () => haven.quoteMcpX402(merchantUrl, init, { idempotencyKey: input.idempotencyKey })
  try {
    const quote = await probe()
    return { quote, merchantUrl }
  } catch (probeErr) {
    if (!isMerchantEndpointMiss(probeErr)) throw probeErr
    const discovered = await discoverMerchantMcpUrl(merchantUrl)
    // Trailing-slash/case echoes of the input are "same URL" — spend the one
    // retry only on a genuinely different endpoint.
    if (!discovered || sameUrl(discovered, merchantUrl)) {
      throw withDiscoveryGuidance(probeErr, merchantUrl, discovered)
    }
    const inputUrl = merchantUrl
    merchantUrl = discovered
    try {
      const quote = await probe()
      return { quote, merchantUrl }
    } catch (retryErr) {
      // Label which URL failed — the agent otherwise cannot tell the
      // discovered endpoint's miss from the original probe's.
      if (retryErr instanceof HavenApiError) {
        throw new HavenApiError(
          `${retryErr.message} (at the DISCOVERED endpoint ${discovered}, ` +
            `resolved from ${inputUrl} via the merchant discovery document)`,
          retryErr.statusCode ?? 400,
        )
      }
      throw retryErr
    }
  }
}

export function serializeMcpTransport(input: X402McpTransport | undefined):
  | { handshake_required: boolean; source: X402McpTransport['source'] }
  | undefined {
  if (!input) return undefined
  return {
    handshake_required: input.handshakeRequired,
    source: input.source,
  }
}

/**
 * #2282: defence in depth behind `mcpTransportArg`. This used to answer
 * `undefined` — "no transport" — for ANY object it did not recognise, which is
 * the same value a caller who passed nothing gets. So a transport that was
 * present but wrong-shaped was indistinguishable from one that was absent, at
 * the last point where anyone could still tell the difference.
 *
 * `undefined`/absent still means absent, and `handshake_required: false` still
 * means the same thing it means to the SDK (`mcpTransport?.handshakeRequired
 * === true` is the only read) — those are legitimate "no handshake" answers. A
 * transport that is PRESENT and unrecognised is refused loudly instead, naming
 * the snake_case/camelCase mismatch that is the common cause.
 *
 * The tool schema refuses that shape first on every hosted call, so this is not
 * the only guard — it is the one that holds if the outer boundary is ever
 * looser than it is today (an older MCP SDK, or `createToolHandlers` driven
 * directly by an embedder). A silent drop here strands a payment; a refusal
 * does not.
 */
export function parseMcpTransport(input: unknown): X402McpTransport | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw mcpTransportShapeError(input)
  }
  const transport = input as { handshake_required?: unknown; source?: unknown }
  if (transport.handshake_required === undefined) throw mcpTransportShapeError(input)
  if (typeof transport.handshake_required !== 'boolean') throw mcpTransportShapeError(input)
  if (transport.handshake_required !== true) return undefined
  if (transport.source !== 'path' && transport.source !== 'bazaar') {
    throw mcpTransportShapeError(input)
  }
  return {
    handshakeRequired: true,
    source: transport.source,
  }
}

function mcpTransportShapeError(input: unknown): HostedToolError {
  const camelCase =
    typeof input === 'object' &&
    input !== null &&
    'handshakeRequired' in (input as Record<string, unknown>)
  return new HostedToolError({
    code: 'INVALID_INPUT',
    message:
      (camelCase
        ? 'mcp_transport was supplied in the SDK camelCase shape. '
        : 'mcp_transport was supplied in a shape Haven does not recognise. ') +
      MCP_TRANSPORT_CASE_HINT +
      ' Nothing was relayed and no funds moved.',
    statusCode: 400,
    status: 'invalid_input',
    phase: 'not_started',
    nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
    rail: 'x402',
  })
}

/** Shape returned by haven_pay_x402_quote and used by haven_resume_x402_payment. */
export function buildX402SigningContext(
  intent: Awaited<ReturnType<HavenClient['createX402Intent']>>,
  // #1272: compact by default. On the x402 path the signer fetches the exact
  // signing payload from Haven by payment_id (#1263) and verifies the same
  // Haven-signed binding either way, so the multi-KB typed_data /
  // typed_data_b64 blobs here are redundant in the normal flow — and every
  // byte an agent relays by hand is a chance to recreate the #1255 corruption
  // failure. True restores today's full shape for diagnostics and pre-#1263
  // signers; the recovery loop is re-running the quote tool with the SAME
  // idempotency_key, which replays the ORIGINAL sign_data (#1207 semantics).
  // Direct payments (haven_pay/haven_send) are untouched: they have no
  // payment_id fetch path, so the bulk stays mandatory there.
  includeSigningPayload = false,
) {
  return {
    payment_id: intent.paymentId,
    status: intent.status,
    idempotency_key: intent.idempotencyKey,
    payload_hash: intent.signData.hash,
    expires_at: intent.expiresAt,
    // #1155: state the expected-context version this quote is about to emit, so
    // the agent can compare it against the local signer's advertised set BEFORE
    // signing — the #1143 guard only speaks after a quote already exists. Read
    // from the binding Haven signed rather than re-derived here: the version is
    // an attribute of that binding, and a second derivation could disagree with
    // it. Advisory, not a gate: this surface adds no refusal, and a mismatch is
    // still enforced (fail-closed) by the signer at signing time.
    signer_compatibility: signerCompatibilityNotice(intent.expectedAuth.version),
    // #1138: on the delegation rail the account validates typed data, not
    // payload_hash. When the full payload is requested, pass both through
    // verbatim — the local signer picks the path from the Haven-signed
    // expected context below and refuses the wrong one, so this surface never
    // has to be the thing that gets it right. The scheme marker itself is
    // always kept: it is one small string and tells the agent which rail the
    // intent is on.
    ...(includeSigningPayload
      ? delegationSignFields(intent.signData)
      : intent.signData.signature_scheme
        ? { signature_scheme: intent.signData.signature_scheme }
        : {}),
    // The edge signer needs these to build + sign the EIP-3009 merchant header
    // locally after the funding transfer is relayed via haven_submit.
    x402: {
      accepted: intent.accepted,
      resource_url: intent.resourceUrl,
      merchant_to: intent.merchantTo,
      funding_to: intent.fundingTo,
      expected: {
        payment_id: intent.paymentId,
        payload_hash: intent.signData.hash,
        // MUST be exactly what Haven signed: the backend builds this context
        // from `paymentRequired.resource.url` (the SDK's `intent.resourceUrl`),
        // never the accepted option's own `resource`. Preferring the latter
        // reconstructed a different message whenever a merchant set an
        // option-level `resource` — the signer then refused with
        // "authentication message is invalid", which reads as a credential
        // problem rather than a field mismatch (#1189). The signature is the
        // authority; this surface only relays it.
        resource_url: intent.resourceUrl,
        merchant_to: intent.merchantTo,
        amount: intent.amountAtomic,
        asset: intent.asset,
        network: intent.network,
        expires_at: intent.expiresAt,
        // #1138: without this the signer reconstructs a v1 message, which will
        // not match Haven's v2 signature — the delegation-rail intent then
        // fails closed rather than being signed under a weaker commitment.
        ...(intent.expectedTypedDataHash
          ? { typed_data_hash: intent.expectedTypedDataHash }
          : {}),
        // #1690: relay the payer identity VERBATIM when Haven bound one (v3).
        // Same rule as the #1189 lesson above — the signature is the
        // authority, this surface only relays; omitting a bound field would
        // make every signer rebuild a message that no longer matches.
        ...(intent.payerDelegate ? { payer_delegate: intent.payerDelegate } : {}),
        ...(intent.payerAgentId ? { payer_agent_id: intent.payerAgentId } : {}),
        auth: intent.expectedAuth,
      },
    },
  }
}

/**
 * If a caller's transport serialised an object-typed field to a JSON string,
 * parse it back before schema validation (the object-typed schema would
 * otherwise reject the string). Mirrors the same guard in the edge signer.
 */
export function coerceJsonField(input: unknown, field: string): unknown {
  if (!input || typeof input !== 'object') return input
  const record = input as Record<string, unknown>
  if (typeof record[field] !== 'string') return input
  try {
    return { ...record, [field]: JSON.parse(record[field] as string) }
  } catch {
    return input
  }
}

export async function submitSignatureWithExpiryMapping(
  haven: HavenClient,
  paymentId: string,
  signature: string,
): ReturnType<HavenClient['submitSignature']> {
  try {
    return await haven.submitSignature(paymentId, signature)
  } catch (err) {
    const mapped = await paymentWindowExpiredErrorFor(haven, paymentId, err)
    if (mapped) throw mapped
    throw err
  }
}

/**
 * #2041: the erc7710 twin of `submitSignatureWithExpiryMapping`.
 *
 * Same mapping, different call: on this scheme the signature is the settlement
 * CHILD, so it goes to `POST /x402/:id/settle` rather than the funding relay.
 * `paymentWindowExpiredErrorFor` keys on rail + expired status behind a 410 and
 * is scheme-agnostic, so an expired child yields the structured
 * `payment_window_expired` refusal instead of a raw API error — which matters
 * more here than on the bridge, because the child's window is the shortest in
 * the system.
 */
export async function submitErc7710WithExpiryMapping(
  haven: HavenClient,
  paymentId: string,
  signature: string,
): Promise<string> {
  try {
    return await haven.submitX402Erc7710(paymentId, signature)
  } catch (err) {
    const mapped = await paymentWindowExpiredErrorFor(haven, paymentId, err)
    if (mapped) throw mapped
    throw err
  }
}
