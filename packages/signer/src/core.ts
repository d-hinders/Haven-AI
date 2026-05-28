import { randomUUID } from 'node:crypto'
import { hashMessage } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { exact } from 'x402/schemes'
import {
  addressFromKey,
  buildX402ExpectedMessage,
  signHash,
  verifySignature,
  selectStandardPaymentOption,
  toStandardPaymentRequirements,
  x402AuthorizationAmount,
  HavenSigningError,
  HavenApiError,
  type X402ExpectedAuth,
  type X402PaymentRequired,
  type X402PaymentOption,
} from '@haven_ai/sdk'

/**
 * The edge signer core.
 *
 * Holds the delegate key in this process and exposes the two signing
 * operations a hosted-MCP flow needs. It performs no network I/O and never
 * returns the key — only signatures and the standard x402 header. See
 * docs/architecture/07-edge-signer.md.
 */
export interface EdgeSigner {
  /** Address derived from the delegate key. */
  readonly delegateAddress: string
  /** Sign an AllowanceModule funding/transfer hash (raw ECDSA, 65 bytes). */
  signPaymentHash(hash: string): string
  /** Sign an x402 funding hash and remember the funded merchant-header context. */
  signX402FundingHash(hash: string, expected: X402ExpectedPayment): X402FundingSignatureResult
  /** Build + sign the EIP-3009 X-PAYMENT header for the merchant leg of x402. */
  buildX402PaymentHeader(
    paymentRequired: X402PaymentRequired,
    x402Binding: string,
  ): Promise<X402HeaderResult>
}

export interface X402ExpectedPayment {
  /** Haven payment id for the funding transfer. */
  paymentId: string
  /** Funding hash this expected context authenticates. */
  payloadHash: string
  /** Resource URL that was funded by hosted haven_x402_authorize. */
  resourceUrl: string
  /** Merchant recipient that was funded by hosted haven_x402_authorize. */
  merchantTo: string
  /** Atomic amount funded for the merchant header. */
  amount: string
  /** Token contract funded for the merchant header. */
  asset: string
  /** x402 network funded for the merchant header. */
  network: string
  /** Haven signature over the expected funding context. */
  auth: X402ExpectedAuth
}

export interface X402HeaderResult {
  /** The merchant-verifiable X-PAYMENT header value. */
  paymentHeader: string
  /** The x402 option this header pays. */
  accepted: X402PaymentOption
}

export interface X402FundingSignatureResult {
  /** Raw ECDSA signature over the Haven funding hash. */
  signature: string
  /** Opaque process-local binding for the later merchant header signing step. */
  x402Binding: string
}

export interface EdgeSignerOptions {
  /** Address allowed to authenticate x402 expected-context messages from Haven. */
  x402BindingSigner?: string
}

export function createEdgeSigner(
  delegateKey: string,
  options: EdgeSignerOptions = {},
): EdgeSigner {
  let delegateAddress: string
  try {
    delegateAddress = addressFromKey(delegateKey)
  } catch (err) {
    throw new HavenSigningError(
      `Invalid delegate key: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const x402Bindings = new Map<string, X402ExpectedPayment>()

  function signAndVerify(hash: string): string {
    const signature = signHash(delegateKey, hash)
    // Verify locally before handing the signature back, mirroring the SDK.
    if (!verifySignature(hash, signature, delegateAddress)) {
      throw new HavenSigningError(
        'Local signature verification failed — recovered address does not match the delegate key.',
      )
    }
    return signature
  }

  return {
    delegateAddress,

    signPaymentHash(hash: string): string {
      return signAndVerify(hash)
    },

    signX402FundingHash(hash: string, expected: X402ExpectedPayment): X402FundingSignatureResult {
      assertExpectedBinding(hash, expected, options.x402BindingSigner)
      const signature = signAndVerify(hash)
      const x402Binding = randomUUID()
      x402Bindings.set(x402Binding, { ...expected })
      return { signature, x402Binding }
    },

    async buildX402PaymentHeader(
      paymentRequired: X402PaymentRequired,
      x402Binding: string,
    ): Promise<X402HeaderResult> {
      const expected = x402Bindings.get(x402Binding)
      if (!expected) {
        throw new HavenSigningError(
          'x402 funding binding is required before signing a merchant header. Sign the hosted funding hash with x402_expected first.',
        )
      }
      const option = selectStandardPaymentOption(paymentRequired.accepts)
      if (!option) {
        throw new HavenApiError(
          'No compatible payment option found in x402 requirements. ' +
            'Haven supports standard x402 exact payments on Base USDC.',
          400,
        )
      }
      assertX402MatchesExpected(paymentRequired, option, expected)

      const account = privateKeyToAccount(delegateKey as `0x${string}`)
      const requirements = toStandardPaymentRequirements(paymentRequired, option)
      const header = await exact.evm.createPaymentHeader(
        account,
        paymentRequired.x402Version,
        requirements,
      )

      if (paymentRequired.x402Version < 2) {
        x402Bindings.delete(x402Binding)
        return { paymentHeader: header, accepted: option }
      }

      // Always delete the binding — even if encode/decode throws — to prevent the
      // in-process Map from accumulating stale X402ExpectedPayment entries (memory
      // leak + data-retention violation for user payment context).
      try {
        const payment = decodeBase64Json<{ payload: unknown }>(header)
        const wrapped = encodeBase64Json({
          x402Version: paymentRequired.x402Version,
          accepted: option,
          payload: payment.payload,
        })
        return { paymentHeader: wrapped, accepted: option }
      } finally {
        x402Bindings.delete(x402Binding)
      }
    },
  }
}

export function assertX402MatchesExpected(
  paymentRequired: X402PaymentRequired,
  option: X402PaymentOption,
  expected: X402ExpectedPayment,
): void {
  assertExpectedShape(expected)
  const headerResource = option.resource ?? paymentRequired.resource.url
  if (headerResource !== expected.resourceUrl) {
    throw new HavenSigningError('x402 payment_required resource does not match the funded intent.')
  }
  if (!sameAddress(option.payTo, expected.merchantTo)) {
    throw new HavenSigningError('x402 merchant recipient does not match the funded intent.')
  }
  if (x402AuthorizationAmount(option) !== expected.amount) {
    throw new HavenSigningError('x402 amount does not match the funded intent.')
  }
  if (!sameAddress(option.asset, expected.asset)) {
    throw new HavenSigningError('x402 asset does not match the funded intent.')
  }
  if (option.network !== expected.network) {
    throw new HavenSigningError('x402 network does not match the funded intent.')
  }
}

function assertExpectedShape(expected: X402ExpectedPayment): void {
  if (!expected || typeof expected !== 'object') {
    throw new HavenSigningError('x402 expected funding context is required before signing a merchant header.')
  }
}

function assertExpectedBinding(
  payloadHash: string,
  expected: X402ExpectedPayment,
  trustedSigner: string | undefined,
): void {
  assertExpectedShape(expected)
  if (!trustedSigner) {
    throw new HavenSigningError(
      'x402 expected-context verifier is not configured. Set HAVEN_X402_BINDING_SIGNER before signing x402 funding hashes.',
    )
  }
  if (expected.payloadHash.toLowerCase() !== payloadHash.toLowerCase()) {
    throw new HavenSigningError('x402 expected context does not match the funding hash being signed.')
  }
  const message = buildX402ExpectedMessage({
    paymentId: expected.paymentId,
    payloadHash: expected.payloadHash,
    resourceUrl: expected.resourceUrl,
    merchantTo: expected.merchantTo,
    amount: expected.amount,
    asset: expected.asset,
    network: expected.network,
  })
  if (expected.auth?.version !== 1 || expected.auth.message !== message) {
    throw new HavenSigningError('x402 expected context authentication message is invalid.')
  }
  if (!sameAddress(expected.auth.signer, trustedSigner)) {
    throw new HavenSigningError('x402 expected context was not signed by the configured Haven signer.')
  }
  if (!verifySignature(hashMessage(message), expected.auth.signature, trustedSigner)) {
    throw new HavenSigningError('x402 expected context signature could not be verified.')
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function decodeBase64Json<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T
}

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}
