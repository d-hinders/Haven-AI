import { privateKeyToAccount } from 'viem/accounts'
import { exact } from 'x402/schemes'
import {
  addressFromKey,
  signHash,
  verifySignature,
  selectStandardPaymentOption,
  toStandardPaymentRequirements,
  HavenSigningError,
  HavenApiError,
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
  /** Build + sign the EIP-3009 X-PAYMENT header for the merchant leg of x402. */
  buildX402PaymentHeader(paymentRequired: X402PaymentRequired): Promise<X402HeaderResult>
}

export interface X402HeaderResult {
  /** The merchant-verifiable X-PAYMENT header value. */
  paymentHeader: string
  /** The x402 option this header pays. */
  accepted: X402PaymentOption
}

export function createEdgeSigner(delegateKey: string): EdgeSigner {
  let delegateAddress: string
  try {
    delegateAddress = addressFromKey(delegateKey)
  } catch (err) {
    throw new HavenSigningError(
      `Invalid delegate key: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return {
    delegateAddress,

    signPaymentHash(hash: string): string {
      const signature = signHash(delegateKey, hash)
      // Verify locally before handing the signature back, mirroring the SDK.
      if (!verifySignature(hash, signature, delegateAddress)) {
        throw new HavenSigningError(
          'Local signature verification failed — recovered address does not match the delegate key.',
        )
      }
      return signature
    },

    async buildX402PaymentHeader(paymentRequired: X402PaymentRequired): Promise<X402HeaderResult> {
      const option = selectStandardPaymentOption(paymentRequired.accepts)
      if (!option) {
        throw new HavenApiError(
          'No compatible payment option found in x402 requirements. ' +
            'Haven supports standard x402 exact payments on Base USDC.',
          400,
        )
      }

      const account = privateKeyToAccount(delegateKey as `0x${string}`)
      const requirements = toStandardPaymentRequirements(paymentRequired, option)
      const header = await exact.evm.createPaymentHeader(
        account,
        paymentRequired.x402Version,
        requirements,
      )

      if (paymentRequired.x402Version < 2) {
        return { paymentHeader: header, accepted: option }
      }

      const payment = decodeBase64Json<{ payload: unknown }>(header)
      const wrapped = encodeBase64Json({
        x402Version: paymentRequired.x402Version,
        accepted: option,
        payload: payment.payload,
      })
      return { paymentHeader: wrapped, accepted: option }
    },
  }
}

function decodeBase64Json<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T
}

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}
