import { randomUUID } from 'node:crypto'
import { hashMessage, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { exact } from 'x402/schemes'
import {
  addressFromKey,
  buildX402ExpectedMessage,
  buildSweepAuthorizationMessage,
  buildSweepTypedData,
  signHash,
  verifySignature,
  selectStandardPaymentOption,
  toStandardPaymentRequirements,
  x402AuthorizationAmount,
  decodeBase64Json,
  encodeBase64Json,
  AgentPaymentFailureCode,
  HavenError,
  HavenSigningError,
  HavenApiError,
  type SweepAuthorization,
  type SweepExpectedAuth,
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
  /**
   * Sign a Haven-prepared EIP-3009 sweep authorization (gasless USDC recovery
   * delegate → Safe). Verifies the authorization came from Haven and pays out to
   * the delegate's own Safe before signing; the relayer broadcasts it and pays
   * gas. Never broadcasts — pure signing.
   */
  signSweepAuthorization(input: SweepSignatureInput): Promise<SweepSignatureResult>
}

export interface SweepSignatureInput {
  /** The authorization fields prepared by the backend. */
  authorization: SweepAuthorization
  /** Haven's signature over the authorization context (binding). */
  expectedAuth: SweepExpectedAuth
  /** Optional Safe address from the local credential, cross-checked against `to`. */
  expectedSafe?: string
}

export interface SweepSignatureResult {
  /** EIP-712 signature over the TransferWithAuthorization, by the delegate key. */
  signature: string
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
  /** ISO expiry for the funding/quote window. When present, the signer refuses stale merchant headers. */
  expiresAt?: string
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
      try {
        assertX402PaymentWindowOpen(expected)
      } catch (err) {
        x402Bindings.delete(x402Binding)
        throw err
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

    async signSweepAuthorization({
      authorization,
      expectedAuth,
      expectedSafe,
    }: SweepSignatureInput): Promise<SweepSignatureResult> {
      // 1. The authorization must have come from Haven (binding), so a malicious
      //    hosted server can't get the delegate to sign a transfer to an attacker.
      assertSweepBinding(authorization, expectedAuth, options.x402BindingSigner)

      // 2. Funds can only leave the delegate's own key, and only to its own Safe.
      if (!sameAddress(authorization.from, delegateAddress)) {
        throw new HavenSigningError(
          'Sweep authorization `from` does not match this delegate address.',
        )
      }
      if (expectedSafe && !sameAddress(authorization.to, expectedSafe)) {
        throw new HavenSigningError(
          'Sweep authorization `to` does not match the Safe in the local credential.',
        )
      }

      // 3. Build the EIP-712 typed data (asserts token/chain are canonical USDC),
      //    sign it locally, and verify the recovered signer is the delegate.
      const typedData = buildSweepTypedData(authorization)
      // The SDK keeps addresses framework-neutral (`string`); viem wants its
      // `0x`-branded template type. Narrow at the call boundary only.
      const viemTypedData = {
        domain: {
          ...typedData.domain,
          verifyingContract: typedData.domain.verifyingContract as `0x${string}`,
        },
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: {
          ...typedData.message,
          from: typedData.message.from as `0x${string}`,
          to: typedData.message.to as `0x${string}`,
          nonce: typedData.message.nonce as `0x${string}`,
        },
      } as const
      const account = privateKeyToAccount(delegateKey as `0x${string}`)
      const signature = await account.signTypedData(viemTypedData)
      const recovered = await recoverTypedDataAddress({ ...viemTypedData, signature })
      if (!sameAddress(recovered, delegateAddress)) {
        throw new HavenSigningError(
          'Local sweep signature verification failed — recovered address does not match the delegate key.',
        )
      }
      return { signature }
    },
  }
}

/**
 * Verify Haven signed the sweep authorization context. Mirrors
 * `assertExpectedBinding` for x402: re-derive the canonical message from the
 * authorization fields, require it match the binding, require the binding signer
 * be the trusted Haven address, and verify the signature. Reuses the x402
 * binding signer — the message namespace differs so the two can't cross-replay.
 */
function assertSweepBinding(
  authorization: SweepAuthorization,
  expectedAuth: SweepExpectedAuth,
  trustedSigner: string | undefined,
): void {
  if (!expectedAuth || typeof expectedAuth !== 'object') {
    throw new HavenSigningError('Sweep authorization binding is required before signing.')
  }
  if (!trustedSigner) {
    throw new HavenSigningError(
      'Sweep binding verifier is not configured. Set HAVEN_X402_BINDING_SIGNER before signing sweep authorizations.',
    )
  }
  const message = buildSweepAuthorizationMessage(authorization)
  if (expectedAuth.version !== 1 || expectedAuth.message !== message) {
    throw new HavenSigningError('Sweep authorization binding does not match the authorization being signed.')
  }
  if (!sameAddress(expectedAuth.signer, trustedSigner)) {
    throw new HavenSigningError('Sweep authorization binding was not signed by the configured Haven signer.')
  }
  if (!verifySignature(hashMessage(message), expectedAuth.signature, trustedSigner)) {
    throw new HavenSigningError('Sweep authorization binding signature could not be verified.')
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
    expiresAt: expected.expiresAt,
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

function assertX402PaymentWindowOpen(expected: X402ExpectedPayment): void {
  if (!expected.expiresAt) return
  const expiresAtMs = Date.parse(expected.expiresAt)
  if (Number.isNaN(expiresAtMs)) {
    throw new HavenSigningError('x402 expected context expiresAt is not a valid ISO timestamp.')
  }
  if (expiresAtMs <= Date.now()) {
    throw new HavenError(
      'The x402 payment window expired before the merchant header could be signed. Re-quote with haven_pay_mcp_tool using the same idempotency_key before trying again.',
      AgentPaymentFailureCode.PaymentWindowExpired,
      410,
      expected.paymentId,
    )
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
