import {
  buildSignedTaxDeclaration,
  encodeTaxDeclarationHeader,
  X_TAX_DECLARATION_HEADER,
} from './tax-declaration.js'
import { isErc7710Option } from './x402.js'
import { HavenApiError } from './types.js'
import type { X402PaymentOption } from './types.js'

/**
 * The client-side tax-declaration resolution for the paid x402 retry
 * (#3427, wg-tax #5 §2.2). Sibling of `client-identity.ts`: a small module
 * `HavenClient` composes, kept out of `client.ts` so the 2,000-line facade
 * does not grow.
 *
 * Everything cryptographic lives in `tax-declaration.ts` (the edge builder);
 * this module is the WIRE orchestration around it:
 *
 * 1. read the agent's own identity (`/machine-payments/agent`) for the
 *    agent id;
 * 2. read `#3426`'s unsigned content endpoint
 *    (`GET /agents/:id/tax-declaration`, agent-key auth);
 * 3. map the endpoint's "not available" answers to NO header;
 * 4. otherwise sign through the edge builder and return the base64url
 *    header value.
 *
 * `undefined` is the design's normal answer, never an error: an older
 * backend has no endpoint (404), the deployment may have the feature off,
 * the owner may not have opted the agent in, and VIES may not be valid
 * right now. In every one of those cases the payment proceeds WITHOUT the
 * header — the declaration is an opt-in assertion, not a gate.
 */

/**
 * Why `#3426`'s endpoint says no declaration is available. The wire shape is
 * `{ available: false, reason }` — the same closed vocabulary the backend's
 * module defines (`resolveTaxDeclaration`); duplicated here as the SDK's
 * published surface rather than imported across packages.
 */
export type TaxDeclarationUnavailableReason =
  | 'feature_disabled'
  | 'disabled'
  | 'no_company_details'
  | 'vies_not_valid'

/** The unresolved content read: `declaration` or the structured reason. */
export type TaxDeclarationContentResult =
  | { available: true; declaration: TaxDeclarationWireContent }
  | { available: false; reason: TaxDeclarationUnavailableReason }

/** The §2.1 unsigned declaration fields exactly as the endpoint emits them. */
export interface TaxDeclarationWireContent {
  version: string
  jurisdiction: string
  taxableStatus: string
  taxId: string
  /** Integer milliseconds. */
  validUntil: number
}

/**
 * Read the agent's own unsigned §2.1 declaration content from `#3426`'s
 * endpoint. Exported for direct tests and for callers that want the
 * availability answer without signing anything.
 *
 * A `HavenApiError` propagates untouched EXCEPT nothing special-cases 404
 * here: callers that cannot afford an exception use
 * {@link resolveTaxDeclarationHeader}, which turns the endpoint's every
 * failure into "no header".
 */
export async function fetchUnsignedTaxDeclaration(client: {
  getAgent: () => Promise<{ id: string }>
  get: <T>(path: string) => Promise<T>
}): Promise<TaxDeclarationContentResult> {
  const agent = await client.getAgent()
  const body = await client.get<{ available?: boolean; reason?: string; declaration?: unknown }>(
    `/agents/${agent.id}/tax-declaration`,
  )
  if (body && body.available === true && body.declaration && typeof body.declaration === 'object') {
    return { available: true, declaration: body.declaration as TaxDeclarationWireContent }
  }
  const reason = body && typeof body.reason === 'string' ? body.reason : undefined
  if (reason === 'feature_disabled' || reason === 'disabled' || reason === 'no_company_details' || reason === 'vies_not_valid') {
    return { available: false, reason }
  }
  // An off-contract body is neither an available declaration nor a named
  // reason — refused rather than guessed at. `resolveTaxDeclarationHeader`
  // turns this into "no header" like every other endpoint failure.
  throw new HavenApiError(
    'The tax-declaration endpoint answered a body that is neither the §2.1 content nor a named unavailability reason.',
    502,
  )
}

/**
 * Resolve the `X-Tax-Declaration` header value for the paid EIP-3009
 * merchant retry, or `undefined` when the payment must proceed without it.
 *
 * Decision order is deliberate:
 * - an erc7710 accepted option returns `undefined` WITHOUT any fetch: the
 *   declaration ride is EIP-3009 only (the §2.2 signer-is-payer argument
 *   holds for the delegate EOA, not for erc7710's delegation chain, whose
 *   payer question is open on wg-tax PR #5 §6.6.5);
 * - the content endpoint's "not available" reasons and its 404 (older
 *   backend) return `undefined`;
 * - a well-formed declaration is signed with the SAME delegate key that
 *   signs the EIP-3009 authorization, through `@haven_ai/sdk/edge`'s
 *   builder (the only signing surface for this shape), and the `taxId`
 *   being signed is logged to stderr for the audit trail (threat-model
 *   residual: Haven supplies the VAT number, so the audit trail shows what
 *   was attested).
 */
export async function resolveTaxDeclarationHeader(client: {
  getAgent: () => Promise<{ id: string }>
  get: <T>(path: string) => Promise<T>
}, input: {
  /** The ACCEPTED payment option — its `network` scopes the principal. */
  accepted: X402PaymentOption
  /** The agent's delegate key (same signer as the EIP-3009 authorization). */
  delegateKey: string
}): Promise<{ header: string } | { header: undefined }> {
  if (isErc7710Option(input.accepted)) {
    return { header: undefined }
  }
  let content: TaxDeclarationContentResult
  try {
    content = await fetchUnsignedTaxDeclaration(client)
  } catch {
    // 404 (older backend with no endpoint), a network hiccup, or any other
    // endpoint failure: the payment proceeds WITHOUT the header. The
    // declaration is additive; its absence must never block a paid retry.
    return { header: undefined }
  }
  if (!content.available) {
    return { header: undefined }
  }
  // The edge builder is the ONLY signing surface for this shape — the same
  // statically-known import the edge entry re-exports, used directly so the
  // signing guard in `tax-declaration.ts` cannot be routed around.
  const signed = buildSignedTaxDeclaration({
    content: content.declaration,
    network: input.accepted.network,
    delegateKey: input.delegateKey,
  })
  process.stderr.write(
    `[haven-sdk] signing x402 tax declaration taxId=${JSON.stringify(content.declaration.taxId)} ` +
      `jurisdiction=${JSON.stringify(content.declaration.jurisdiction)} ` +
      `principalId=${signed.declaration.principalId}\n`,
  )
  return { header: encodeTaxDeclarationHeader(signed) }
}

/** The header name, re-exported for the attach site and its census tests. */
export { X_TAX_DECLARATION_HEADER }

/**
 * What `MerchantCompletion` calls on the paid EIP-3009 retry to resolve the
 * header value, or `undefined` to proceed without it. `HavenClient` binds
 * {@link resolveTaxDeclarationHeader}; tests bind stubs.
 */
export type TaxDeclarationHeaderResolver = (input: {
  accepted: X402PaymentOption
  delegateKey: string
}) => Promise<{ header: string } | { header: undefined }>

/**
 * The ONE attach site for the tax-declaration header (#3427): set on the
 * caller's `init` when a header was resolved, untouched otherwise. A
 * previously-attached stale value is DELETED rather than left in place, the
 * same way `deliverPayment` removes the payment-header name it is not
 * sending — a superseded declaration must never ride a retry it was not
 * minted for.
 */
export function withTaxDeclarationHeader(init: RequestInit | undefined, header: string | undefined): RequestInit {
  if (!header) {
    if (init?.headers && new Headers(init.headers).has(X_TAX_DECLARATION_HEADER)) {
      const headers = new Headers(init.headers)
      headers.delete(X_TAX_DECLARATION_HEADER)
      return { ...init, headers }
    }
    return init ?? {}
  }
  const headers = new Headers(init?.headers)
  headers.set(X_TAX_DECLARATION_HEADER, header)
  return { ...init, headers }
}
